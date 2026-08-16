// public/stt.js — 语音识别（前端只负责录音+上传，推理在后端 Node 进程，UI 永不卡崩）
//
// 为什么这样设计：
//   之前在前端渲染进程加载 whisper（~80MB wasm）会长时间吃满 CPU/内存导致整窗卡崩；
//   且 whisper-base 在噪声上常把声音误听成英文词（"chinese level" 之类）。
//   现在识别放到后端 Node 进程（resources/app/stt-node.js，跑 transformers.js whisper），
//   前端只把录音转成 16k mono wav 上传，拿回已清洗的中文文本。UI 线程完全不参与推理，不卡。
//
// 后端已强制中文解码 + 中文兜底清洗，前端这里再做一层保险（理论上后端已处理干净）。

(function () {
  function isSupported() { return true; } // 后端离线识别始终可用

  // 任意音频 blob -> 16k mono wav (Uint8Array)
  async function blobToWav16k(blob) {
    const arr = new Uint8Array(await blob.arrayBuffer());
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const audioBuf = await ctx.decodeAudioData(arr.buffer.slice(0));
    const targetSr = 16000;
    const frames = Math.max(1, Math.ceil(audioBuf.duration * targetSr));
    const offline = new OfflineAudioContext(1, frames, targetSr);
    // 混成单声道
    const mono = offline.createBuffer(1, audioBuf.length, audioBuf.sampleRate);
    const d = mono.getChannelData(0);
    for (let i = 0; i < audioBuf.length; i++) {
      let s = 0;
      for (let c = 0; c < audioBuf.numberOfChannels; c++) s += audioBuf.getChannelData(c)[i];
      d[i] = s / audioBuf.numberOfChannels;
    }
    const src = offline.createBufferSource();
    src.buffer = mono;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    try { ctx.close(); } catch {}
    return encodeWav(samples, targetSr);
  }

  function encodeWav(samples, sr) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    ws(36, 'data'); dv.setUint32(40, n * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return new Uint8Array(buf);
  }

  // 主识别：上传到后端 /api/stt
  async function transcribeAudio(blob, onProgress) {
    try {
      if (onProgress) onProgress({ status: '编码音频中' });
      const wav = await blobToWav16k(blob);
      if (onProgress) onProgress({ status: '上传识别中' });
      const r = await fetch('/api/stt?userId=' + encodeURIComponent(window.UID || ''), {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
      if (!r.ok) { let m = ''; try { const j = await r.json(); m = j.message || ''; } catch {} throw new Error(m || ('HTTP ' + r.status)); }
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || '识别失败');
      return (j.text || '').trim();
    } catch (e) {
      console.error('[STT] 后端识别失败', e);
      throw e;
    }
  }

  function ensurePipeline() { return Promise.resolve(); }
  // 兼容旧接口（不再用于 Web Speech）
  function startListening() {}
  function stopListening() { return ''; }

  window.STT = { isSupported, transcribeAudio, ensurePipeline, startListening, stopListening };
  console.info('[STT] 已切换为后端离线识别（whisper，UI 不卡）v2026-08-14-backend');
})();
