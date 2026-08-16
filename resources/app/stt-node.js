// stt-node.js — 后端离线语音识别（在 Node 主进程推理，不在 UI 线程，永不卡崩）
//
// 为什么放后端：之前在前端渲染进程加载 whisper（~80MB wasm）会长时间吃满 CPU/内存，
// 导致整个 Electron 窗口卡崩；且 whisper-base 小模型在噪声上常把声音误听成英文词
// （"chinese" / "chinese level" 等）。改成后端 Node 进程推理后：
//   ① UI 线程完全不卡（推理在独立进程）；
//   ② 强制中文解码 + 中文兜底清洗，根治 "chinese level" 泄漏（纯中文伴侣，不做英文识别）。
//
// 前端把 16k mono wav 二进制 POST 到 /api/stt，这里解码成 float32 喂给 transformers.js 的
// whisper pipeline，返回清洗后的中文文本。

const path = require('path');
const fs = require('fs');
const { pipeline } = require('@huggingface/transformers');

const MODEL_DIR = path.join(__dirname, 'models', 'whisper-small');

let _pipe = null;
let _loading = null;

async function getPipe() {
  if (_pipe) return _pipe;
  if (_loading) return _loading;
  _loading = (async () => {
    console.info('[STT] 加载 whisper-small 模型（模型较大，首次约 30-60 秒）…');
    const p = await pipeline('automatic-speech-recognition', MODEL_DIR, {
      quantized: true, // 用 onnx/model_quantized.onnx (q8)
      dtype: 'q8',
      device: 'cpu',
      local_files_only: true,
    });
    _pipe = p;
    console.info('[STT] whisper 模型已就绪');
    return p;
  })();
  try {
    return await _loading;
  } catch (e) {
    _loading = null;
    console.error('[STT] whisper 模型加载失败:', e && e.message);
    throw e;
  }
}

// 解析 16-bit PCM wav -> Float32Array(mono) + sampling_rate
function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12; // 跳过 "RIFF....WAVE"
  let sampleRate = 16000;
  let channels = 1;
  let bits = 16;
  let dataOffset = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      dv.getUint8(offset), dv.getUint8(offset + 1),
      dv.getUint8(offset + 2), dv.getUint8(offset + 3)
    );
    const size = dv.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(offset + 10, true);
      sampleRate = dv.getUint32(offset + 12, true);
      bits = dv.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error('WAV 缺少 data 段');
  const frameBytes = (bits / 8) * channels;
  const frames = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const pos = dataOffset + i * frameBytes + c * (bits / 8);
      if (bits === 16) sum += dv.getInt16(pos, true) / 32768;
      else if (bits === 8) sum += (dv.getUint8(pos) - 128) / 128;
    }
    out[i] = sum / channels;
  }
  return { audio: out, sampling_rate: sampleRate };
}

// 清洗：剥离语言标记/英文垃圾词；完全无中文字符则判定为噪音丢弃（不进对话）。
// 治本：所有英文字母串整段剥离——根治 whisper-base 把中文误听成的 "chinese lever" / "chinese level" 等漏网变体。
function cleanText(text) {
  if (!text) return '';
  let t = (text || '').trim();
  t = t.replace(/<\|[^|]*\|>/g, ''); // 特殊标记
  // 【治本】所有英文字母串整段剥离——根治 chinese lever / chinese level 等漏网变体
  t = t.replace(/[A-Za-z]+/g, ' ');
  // 语言元数据词（中文）
  t = t.replace(/(中文|英文|普通话|粤语|语言)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 兜底：若结果完全不含中文字符，判定为噪音/标记泄漏，丢弃（不进对话）
  if (!/[一-鿿]/.test(t)) return '';
  return t;
}

// 后台预热：只加载模型不推理（用于启动时"点开即用"，首次说话无需等待）
async function warmup() { return getPipe(); }

async function transcribe(wavBuffer) {
  const p = await getPipe();
  const { audio, sampling_rate } = decodeWav(wavBuffer);
  if (audio.length < 800) return ''; // 太短，几乎一定是静音
  // 能量阈值：静音 / 极轻噪声直接丢弃，避免 whisper 在无声段幻觉出无关中文
  // （如之前实测静音会输出"你不想要我"）。真人说话的能量远高于此阈值。
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  const rms = Math.sqrt(sumSq / audio.length);
  if (rms < 0.008) return '';
  // 电平归一化：说话声音太轻会被 whisper 当噪声漏掉或误识，统一拉到合适电平（温和，max gain 4x 防 clipping）。
  // 这是“识别不准/漏字”最直接的改善点——麦克风距离远、音量小、带口音时尤其有效。
  if (rms > 0.0001 && rms < 0.18) {
    const gain = Math.min(4.0, 0.18 / rms);
    for (let i = 0; i < audio.length; i++) { const v = audio[i] * gain; audio[i] = v < -1 ? -1 : (v > 1 ? 1 : v); }
  }
  const out = await p(audio, {
    sampling_rate, // 告诉 pipeline 采样率（前端已转 16k）
    language: 'chinese', // 强制中文解码：根治 whisper-base 把中文误听成英文（chinese level 等），伴侣纯中文场景不识别英文
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
    no_speech_threshold: 0.4, // 略降：避免把轻声/句首静音误判为无语音而整句丢弃
    temperature: 0.0,
    // 温度回退（HF/transformers.js 标准行为）：当首温度输出置信度低或压缩比异常（幻觉/重复）时
    // 自动升温重试，whisper-base 在噪声/口音下首温度常误识，回退能显著纠错。
    condition_on_previous_text: false,   // 关闭跨段条件，避免长录音把前一段错误累积放大
    logprob_threshold: -1.0,             // 低置信度触发回退
    compression_ratio_threshold: 2.4,    // 异常压缩比（重复/幻觉）触发回退
  });
  const raw = (out && out.text ? out.text : '').trim();
  if (process.env.STT_DEBUG) console.info('[STT] rms=' + rms.toFixed(4) + ' raw=' + JSON.stringify(raw));
  return cleanText(raw);
}

module.exports = { transcribe, warmup, MODEL_DIR };
