'use strict';
const $ = id => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const nameEl = $('companionName');
const avatarEl = $('avatar');
const statusEl = $('statusText');
const toneChipEl = $('toneChip');
const stageEl = $('stage');
const charEl = $('char');
const charImg = $('charImg');

const petEl = $('pet');
const petImg = $('petImg');
const petEmoji = $('petEmoji');
const petName = $('petName');
const petBubble = $('petBubble');

let history = [];
let streaming = false;
let currentAssistantBubble = null;   // 当前流式回复的气泡，报错时清掉空气泡
let userCfg = null;     // 我的角色 + 我的模型（存 /api/me）
let globalCfg = null;   // 主人全局摘要（/api/global）
const localPortrait = { girlfriend: null, boyfriend: null }; // 已上传的本地图片引用（local:...），避免保存时被空 URL 覆盖
const localUserPortrait = { value: null }; // 用户自己的头像本地引用（local:...）
let isAdmin = false;
let ttsMuted = localStorage.getItem('companion_tts_muted') === '1';
let audioEl = null;
let ttsWarnReason = '';  // 本次发送里在线 TTS 失败的原因（用于发送结束后提示，避免静默无声）
let draftBlocks = []; // 待发送消息的有序块（text / image / video），支持一条消息里多图 + 多段文字交错（仿 WorkBuddy）
let unread = 0;          // 收起小窗时 TA 主动发来的未读消息数

// ---- 嘴巴张合动画（真实照片上定位嘴巴，随语音音量同步张合） ----
const mouthEl = $('mouth');
const mouthShape = $('mouthShape');
const VOICE_OPTIONS = ['zh-CN-XiaomoNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaohanNeural'];
const DEFAULT_MOUTH = { x: 50, y: 60, w: 14, h: 7 };
let currentMouth = Object.assign({}, DEFAULT_MOUTH);
let _analyser = null, _analyserActive = false, _mouthRAF = null, _mouthOpen = 0;
function getAnalyser() {
  const ctx = getAudioCtx(); if (!ctx) return null;
  if (!_analyser) { try { _analyser = ctx.createAnalyser(); _analyser.fftSize = 1024; _analyser.smoothingTimeConstant = 0.6; _analyser.connect(ctx.destination); } catch { return null; } }
  return _analyser;
}
// 把嘴巴定位应用到立绘覆盖层（定位深色口腔形状到嘴部位置，随音量真实张合）
function applyMouth(m) {
  if (!m) m = DEFAULT_MOUTH;
  currentMouth = { x: m.x, y: m.y, w: m.w, h: m.h };
  const cx = currentMouth.x, cy = currentMouth.y, hw = currentMouth.w / 2, hh = currentMouth.h / 2;
  if (mouthShape) {
    mouthShape.style.left = (cx - hw).toFixed(2) + '%';
    mouthShape.style.top = (cy - hh).toFixed(2) + '%';
    mouthShape.style.width = currentMouth.w.toFixed(2) + '%';
    mouthShape.style.height = currentMouth.h.toFixed(2) + '%';
    mouthShape.style.transform = 'scaleY(0.08)';
  }
  _mouthOpen = 0;
}
// 随语音音量驱动嘴巴真实开合：用深色口腔形状 scaleY 从"几乎闭合"到"张大"，像真的在说话
function startMouthLoop() {
  if (_mouthRAF) return;
  if (!isDesktop()) return;   // 嘴巴动画仅电脑端：移动端聊天界面不展示立绘/嘴型
  const loop = () => {
    if (!stageEl.classList.contains('speaking')) {
      if (mouthShape) mouthShape.style.transform = 'scaleY(0.08)';
      _mouthOpen = 0; _mouthRAF = null; return;
    }
    let open = 0;
    if (_analyserActive && _analyser) {
      const buf = new Uint8Array(_analyser.fftSize);
      try { _analyser.getByteTimeDomainData(buf); } catch {}
      let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
      const rms = Math.sqrt(s / buf.length);
      open = Math.min(1, rms * 3.4);
    } else {
      open = 0.4 + 0.45 * Math.sin(Date.now() / 60);
    }
    const sm = _mouthOpen * 0.55 + open * 0.45;
    _mouthOpen = sm;
    if (mouthShape) mouthShape.style.transform = 'scaleY(' + (0.08 + sm * 0.92).toFixed(3) + ')';
    _mouthRAF = requestAnimationFrame(loop);
  };
  _mouthRAF = requestAnimationFrame(loop);
}

// 把"图片归一化坐标"(0~1,GLM-4V 返回) 换算成立绘容器百分比坐标，
// 需还原 object-fit:cover + object-position 的裁剪，保证嘴巴覆盖层对齐真嘴巴
function imgFracToContainer(m) {
  const iw = charImg.naturalWidth, ih = charImg.naturalHeight;
  const cw = charImg.clientWidth, ch = charImg.clientHeight;
  if (!iw || !ih || !cw || !ch) return null;
  const s = Math.max(cw / iw, ch / ih);
  const dw = iw * s, dh = ih * s;
  const op = (getComputedStyle(charImg).objectPosition || '50% 50%').trim().split(/\s+/).map(parseFloat);
  const ox = op[0] || 50, oy = op[1] || 50;
  const offX = (cw - dw) * (ox / 100);
  const offY = (ch - dh) * (oy / 100);
  const cx = m.fx * iw, cy = m.fy * ih, mw = m.fw * iw, mh = m.fh * ih;
  return {
    x: ((offX + cx * s) / cw) * 100,
    y: ((offY + cy * s) / ch) * 100,
    w: ((mw * s) / cw) * 100,
    h: ((mh * s) / ch) * 100
  };
}

// 免费视觉 AI 自动定位嘴巴：换图时让 GLM-4V 看图返回嘴巴坐标，无需手动点
let _autoMouthBusy = false, _lastMouthBase = '';
async function autoLocateMouth() {
  if (_autoMouthBusy) return;
  if (!charImg.complete || !charImg.naturalWidth) return;
  const base = (charImg.src || '').split('&t=')[0];
  if (base && base === _lastMouthBase) return;   // 同一张图只识别一次，保留手动微调
  const persona = (userCfg && userCfg.persona) || 'girlfriend';
  _autoMouthBusy = true; _lastMouthBase = base;
  try {
    const r = await apiGet(q('/api/detect-mouth?persona=' + persona));
    if (r && r.ok && r.mouth) {
      const m = imgFracToContainer(r.mouth);
      if (m) {
        applyMouth(m);
        userCfg = Object.assign(userCfg || {}, { mouth: { x: m.x, y: m.y, w: m.w, h: m.h } });
        saveUserCfg();
        toast('🤖 AI 已自动定位嘴巴，说话时 TA 的嘴会动啦', 'success');
        return;
      }
    }
    toast('🤖 AI 这次没找准嘴巴，可点「👄 定位嘴巴」手动微调', 'info');
  } catch (e) { /* 出错不影响聊天 */ }
  finally { _autoMouthBusy = false; }
}
charImg.addEventListener('load', () => { autoLocateMouth(); });

// ---- 配音：回复后自动朗读（本地离线 sherpa-onnx TTS，由后端 /api/tts 返回音频） ----
// 用 Web Audio API 播放，绕开浏览器"无用户手势禁止自动播放"限制（共享 AudioContext，首次交互即激活）
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { _audioCtx = new AC(); } catch {} }
  }
  return _audioCtx;
}
// 任意点击/按键即激活并恢复音频上下文（必须在用户手势内调用才有效）
['click', 'keydown'].forEach(ev => document.addEventListener(ev, () => {
  const c = getAudioCtx();
  if (c && c.state === 'suspended') { try { c.resume(); } catch {} }
}, { passive: true }));

// ---- 提示音：复用 _audioCtx，无需音频文件，零网络 ----
function tone(ctx, freq, when, dur, vol, type) {
  try {
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type || 'sine'; osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(vol, when + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when); osc.stop(when + dur + 0.03);
  } catch {}
}
// kind: 'them' = 收到 TA 消息（双音叮咚）；'sent' = 我已发送成功（短促"嗖"）
function playChime(kind) {
  try {
    const ctx = getAudioCtx(); if (!ctx || ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    if (kind === 'them') {
      // 清亮叮咚（C5 → E5，约 0.18 + 0.32 s）
      tone(ctx, 880,  now,      0.16, 0.18);
      tone(ctx, 1318, now+0.14, 0.30, 0.16);
    } else if (kind === 'sent') {
      // 短促上行"嗖"（A4 → C5，~0.12s，提示"已发出"）
      tone(ctx, 740,  now,      0.10, 0.20);
      tone(ctx, 1175, now+0.04, 0.08, 0.18);
    }
  } catch {}
}

// ---- 顶部提示（toast）----
let _toastTimer = null;
function toast(msg, type) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast ' + (type || '') + ' show';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2600);
}

// ---- 同步预热音频：在真实用户手势（点击"发送"）里确保 AudioContext 已 resume 并解码一段静音，彻底解锁自动播放链路 ----
function primeAudio() {
  const c = getAudioCtx();
  if (!c) return;
  if (c.state === 'suspended') { try { c.resume(); } catch {} }
}

// 终极兜底 / 也可作为独立配音方式：浏览器内置语音合成（Web Speech API）。零网络、零 Key、国内可用。
// 加固：Chromium 首次 getVoices 为空需等 voiceschanged；显式挑选中文音色，避免被念成英文/静默。
// （已移除浏览器/系统语音兜底：TA 的所有配音统一走 ChatTTS 引擎，音色一致、自然真人感）

// 返回 Promise：播放（或失败）结束后 resolve，便于逐句排队、与文字同步推进
// 统一 TTS 文本清洗（前端做主清洗，后端再做一遍防御）。
// 为什么放前端：旧后端进程可能没重启，但前端刷新会从磁盘重新加载本文件，
// 所以前端清洗能在「旧后端不重启」情况下也生效，打破「改了不生效」死循环。
// —— LLM 回复常带 markdown、括号动作描写、符号，ChatTTS 会把 * 念成"星号"、
// （）念成"括号"、把旁白也念出来，这就是"读得乱、读不正确"的根因。气泡里仍显示原始文字。
function cleanTTS(s) {
  if (!s) return '';
  let t = String(s);
  // 0) 去 emoji（气泡里照常显示，但不送去朗读，避免念成"红心/笑脸"）
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu, '');
  // 1) 链接 [文字](url)->文字；裸 [文字]->文字
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]/g, '$1');
  // 2) 去 markdown 标记（保留文字）：代码/加粗/斜体/标题/引用/删除线
  t = t.replace(/`{1,3}/g, '').replace(/\*{1,3}/g, '').replace(/_{1,3}/g, '')
        .replace(/~{2,}/g, '').replace(/^\s{0,3}#{1,6}\s?/gm, '').replace(/^\s*>\s?/gm, '');
  // 3) 去英文废话（根治 chinese lever 等）+ 语言元数据词
  t = t.replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, ' ').replace(/(中文|英文|普通话|粤语|语言)/g, ' ');
  // 4) 旁白/动作/系统标签：括号（）与【】里的内容整段删（这些本就不该念出来）
  t = t.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/【[^】]*】/g, '');
  // 5) 引号「」『』与残留括号只去符号、保留文字
  t = t.replace(/[「」『』（）]/g, '');
  // 6) 去掉 ChatTTS 不会念、念出来是噪音的符号
  t = t.replace(/[<>@#&%+=/\\|~`*_\u00a9\u00ae\u2122]/g, ' ');
  // 7) 折叠重复标点（！！->！、？？->？、。。->。、，，->，），多个.归一...
  t = t.replace(/[！]{2,}/g, '！').replace(/[？]{2,}/g, '？').replace(/[。]{2,}/g, '。')
        .replace(/[，、]{2,}/g, '，').replace(/\.{4,}/g, '...').replace(/\.{2,3}/g, '...');
  // 8) 零宽/控制字符 + 折叠空白
  t = t.replace(/[\u200b\u200e\u200f\ufeff\u00ad]/g, '').replace(/\s{2,}/g, ' ').trim();
  // 9) 去首尾残留标点/空白
  t = t.replace(/^[，。、！？\s]+/, '').replace(/[，。、！？\s]+$/, '');
  // 9.5) 最终白名单：只留「中文/数字/中文标点/空白」，其余字符一律删（根治任何漏网符号被念出来）
  t = t.replace(/[^一-鿿0-9。！？，、；：\s]/g, '');
  // 10) 兜底：清洗后若完全不含中文，说明只剩英文/噪音，丢弃（绝不朗读垃圾词）
  if (!/[一-鿿]/.test(t)) return '';
  return t;
}
console.log('[build] frontend=TTS-SANITIZE-2026-08-15  (若看不到这行，说明前端没刷新到新代码)');
async function playTTS(text, force) {
  if (!text || ttsMuted) return;
  if (!force && userCfg && userCfg.ttsEnabled === false) return;
  const _rawTTS = text;
  text = cleanTTS(text); // 统一清洗：去表情/英文/markdown/括号动作/符号，气泡里仍显示原始文字
  // 【诊断日志】重启后若仍读到垃圾词，按 F12 把这一行发我，即可定位真凶
  console.log('[TTS-RAW] 原始=', JSON.stringify(_rawTTS), '| 清洗后=', JSON.stringify(text));
  if (!text) return;
  try {
    const r = await fetch('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: UID, text, voice: liveVoiceFromSelect(), sex: (userCfg && userCfg.persona) === 'boyfriend' ? 'boy' : 'girl', rate: (userCfg && userCfg.ttsRate) ? parseFloat(userCfg.ttsRate) : 1 })
    });
    const ct = r.headers.get('Content-Type') || '';
    if (!r.ok || ct.indexOf('audio') === -1) {
      // 仅用 ChatTTS 引擎：失败时记录真实原因并提示用户，绝不静默改用系统/浏览器嗓音冒名顶替 TA。
      let j = null;
      try { j = await r.json(); } catch {}
      if (j && j.message) { ttsWarnReason = j.message; console.warn('[配音] 在线TTS失败:', j.message); }
      else if (!r.ok) { ttsWarnReason = '在线配音服务返回 HTTP ' + r.status; }
      else { ttsWarnReason = '在线配音服务未返回音频'; }
      return;
    }
    const blob = await r.blob();
    const ctx = getAudioCtx();
    if (ctx) {
      try {
        const ab = await blob.arrayBuffer();
        await ctx.resume();
        const buf = await ctx.decodeAudioData(ab);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const an = getAnalyser();
        if (an) { try { src.connect(an); _analyserActive = true; } catch { src.connect(ctx.destination); } }
        else src.connect(ctx.destination);
        await new Promise((resolve) => {
          src.onended = () => resolve();
          src.start(0);
          setTimeout(resolve, 20000); // 兜底，避免异常路径卡死队列
        });
        return;
      } catch (e) { console.warn('WebAudio 失败，回退 HTMLAudio：', e); _analyserActive = false; }
    }
    // 兜底：HTMLAudio
    const url = URL.createObjectURL(blob);
    if (audioEl) { try { audioEl.pause(); } catch {} }
    audioEl = new Audio(url);
    await new Promise((resolve) => {
      audioEl.onended = () => { try { URL.revokeObjectURL(url); } catch {} resolve(); };
      audioEl.play().catch(() => resolve());
      setTimeout(resolve, 20000);
    });
  } catch (e) { console.warn('配音播放失败', e); }
}

// ---- 逐句配音队列：文字"随声音逐句出现"，实现正出字正说话 ----
// 做法：每句话先显示到气泡里，再播放这句的音频；下一句等这句播完，才显示+播。
// 这样看到的文字与听到的声音严格逐句对齐，而不是整段先显示完才出声、或声画脱节。
let _revealBuf = '';        // 已随声音显示出来的文字
let _speakQueue = [];       // 待播句子队列（含目标气泡）
let _speakPlaying = false;
function enqueueTTS(text, bubble) {
  if (!text) return;
  if (ttsMuted || (userCfg && userCfg.ttsEnabled === false)) {
    // 静音/关闭朗读：直接把文字显示出来（不等音频）
    if (bubble) { _revealBuf += text; bubble.innerHTML = esc(_revealBuf) || '…'; followScroll(); }
    return;
  }
  _speakQueue.push({ text, bubble });
  pumpTTS();
}
async function pumpTTS() {
  if (_speakPlaying) return;
  const item = _speakQueue.shift();
  if (!item) return;
  _speakPlaying = true;
  const { text, bubble } = item;
  if (bubble) { _revealBuf += text; bubble.innerHTML = esc(_revealBuf) || '…'; followScroll(); }
  await playTTS(text);
  _speakPlaying = false;
  pumpTTS();
}
async function waitTTSIdle() {
  while (_speakQueue.length || _speakPlaying) {
    await new Promise(r => setTimeout(r, 80));
  }
}

// ---- 微信式状态栏：对方正在输入中 / 对方正在录制语音 ----
function setStatus(state) {
  if (!statusEl) return;
  statusEl.className = 'status' + (state === 'typing' ? ' typing' : state === 'recording' ? ' recording' : '');
  if (state === 'typing') statusEl.innerHTML = '<i class="sdot"></i><i class="sdot"></i><i class="sdot"></i><span>对方正在输入中…</span>';
  else if (state === 'recording') statusEl.innerHTML = '<i class="srec"></i><span>对方正在录制语音…</span>';
  else if (state === 'online') statusEl.textContent = '在线 · 等你说话';
  else if (state === 'error') statusEl.textContent = '出错了';
  else statusEl.textContent = state;
}

// ---- 语音回复：边出边合成，逐句成独立语音气泡，让 TA 尽早开口（不必等整段出完） ----
let _voiceQueue = [];
let _voicePlaying = false;
let _voicePending = 0;
let _voiceProduced = false;
let _chimeDone = false;
function playAudioDataUrl(src, duration) {
  return new Promise((resolve) => {
    try {
      const a = new Audio(src);
      a.onended = () => resolve();
      a.play().catch(() => resolve());
      setTimeout(resolve, (duration ? duration * 1000 : 12000) + 2500);
    } catch { resolve(); }
  });
}
async function playVoiceQueue() {
  if (_voicePlaying) return;
  _voicePlaying = true;
  while (_voiceQueue.length) {
    const it = _voiceQueue.shift();
    await playAudioDataUrl(it.src, it.duration);
  }
  _voicePlaying = false;
}
async function waitVoiceIdle() {
  let g = 0;
  while ((_voicePending > 0 || _voiceQueue.length || _voicePlaying) && g < 1200) { await new Promise(r => setTimeout(r, 80)); g++; }
}
async function enqueueVoice(text, ts, typingBubble) {
  text = (text || '').trim(); if (!text) return;
  _voicePending++; setStatus('recording');
  if (typingBubble && typingBubble.parentNode) typingBubble.remove(); // 收起打字气泡，转为语音气泡
  try {
    const audio = await synthesizeToDataUrl(text);
    _voicePending--;
    if (!audio) {                 // 单句合成失败：降级为文字气泡，内容不丢
      if (!_chimeDone) { _chimeDone = true; playChime('them'); }
      _voiceProduced = true;
      const b = renderMessageBlocks('assistant', [], ts, { role: 'assistant', ts, content: text });
      b.innerHTML = esc(text);
      history.push({ role: 'assistant', content: text, ts, replyTo: (typingBubble && typingBubble._msg && typingBubble._msg.replyTo) || null });
      saveHistory();
      return;
    }
    _voiceProduced = true;
    if (!_chimeDone) { _chimeDone = true; playChime('them'); }
    const bubble = renderAssistantVoice(text, audio.dataUrl, audio.duration, ts);
    history.push({ role: 'assistant', ts, blocks: [{ type: 'audio', text, src: audio.dataUrl, url: null, duration: audio.duration || 0 }], content: text, replyTo: (typingBubble && typingBubble._msg && typingBubble._msg.replyTo) || null });
    lastAssistantIndex = history.length - 1; saveHistory();
    _voiceQueue.push({ src: audio.dataUrl, duration: audio.duration || 0 });
    playVoiceQueue();
  } catch (e) { _voicePending--; console.warn('[语音合成]失败', e); }
}

// 把累积文本切成可朗读的小段：在自然停顿处就断句，让第一声几乎跟着文字一起出现（更早说话），
// 同时每段"显示+播放"绑定，做到字声同步。
// 规则：句末标点（。！？!?）始终断句；逗号/顿号/分号/冒号等软停顿只在已凑够 10 字以上才断（避免切成极短碎片听着磕巴）；
// 一直没遇到标点的长串，每 26 字硬切一次（ChatTTS 对过长单句容易复读/错音，硬切更稳）。
function extractSentences(buf) {
  const out = [];
  let cur = '';
  const hard = '。！？!?';
  const soft = '，、；：,;:';
  for (const ch of buf) {
    cur += ch;
    if (hard.includes(ch)) { out.push(cur); cur = ''; }
    else if (soft.includes(ch) && cur.length >= 10) { out.push(cur); cur = ''; }
  }
  if (cur.length > 26) { out.push(cur.slice(0, 26)); cur = cur.slice(26); }
  return { sentences: out, rest: cur };
}

// ---- 真实照片立绘：说话时由 CSS 做嘴部口型动画（.stage.speaking / .pet.speaking 触发） ----
function startTalking() {
  stageEl.classList.add('speaking');
  if (petEl) petEl.classList.add('speaking');
  startMouthLoop();
}
function stopTalking() {
  stageEl.classList.remove('speaking');
  if (petEl) petEl.classList.remove('speaking');
}

// 本机唯一身份：自动生成并持久，用于后端隔离各用户的数据
function getUserId() {
  let id = localStorage.getItem('companion_uid');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now() + Math.random().toString(16).slice(2));
    localStorage.setItem('companion_uid', id);
  }
  return id;
}
const UID = getUserId();
unread = parseInt(localStorage.getItem('companion_unread_' + UID) || '0', 10) || 0;
updateUnreadBadge();

const PERSONA_META = {
  girlfriend: { avatar: '💖', label: '女友', emoji: '💖' },
  boyfriend: { avatar: '🤍', label: '男友', emoji: '🤍' }
};

// ---- ChatTTS 可选音色目录（与后端 tts-local.js CHATTTS_VOICES 对应）----
// 仅保留讲中文自然的 6 个中文音色（ChatTTS 说话人种子），按性别分组展示（女生选女声、男生选男声）。
const VOICE_CATALOG = {
  female_zh: { label: '女声（中文·自然）', items: [['zf_xiaoxiao', '晓晓 · 温柔甜美'], ['zf_xiaoni', '小妮 · 清脆俏皮']] },
  male_zh:   { label: '男声（中文·自然）', items: [['zm_yunyang', '云扬 · 沉稳磁性'], ['zm_yunjian', '云坚 · 阳光青年'], ['zm_yunxi', '云曦 · 清爽少年'], ['zm_yunxia', '云夏 · 温柔暖男']] },
};
const ALL_VOICES = {};
Object.values(VOICE_CATALOG).forEach(g => g.items.forEach(([id]) => { ALL_VOICES[id] = true; }));
function isValidVoiceId(v) { return !!(v && ALL_VOICES[v]); }
// 当前应使用的音色：用户手动选过且性别与当前角色一致才用；否则按角色性别取默认
function currentVoice() {
  const persona = (userCfg && userCfg.persona) || 'girlfriend';
  const wantGender = persona === 'boyfriend' ? 'male' : 'female';
  // 性别铁律：只有"已存音色"性别与当前角色一致时才用它，否则按角色性别取默认，
  // 杜绝"女友界面用男声"等串性别问题（后端 chattts_synth.py 也有同样兜底）。
  if (userCfg && isValidVoiceId(userCfg.ttsVoice) && voiceGender(userCfg.ttsVoice) === wantGender) {
    return userCfg.ttsVoice;
  }
  return wantGender === 'male' ? 'zm_yunyang' : 'zf_xiaoxiao';
}
// 给定性别返回该性别可用的音色（女/男）
function voicesForGender(g) {
  // zm_* = 男，zf_* = 女（与后端 tts-local.js CHATTTS_VOICES 的 ChatTTS 种子一致）
  return g === 'male' ? (VOICE_CATALOG.male_zh ? VOICE_CATALOG.male_zh.items : []) : (VOICE_CATALOG.female_zh ? VOICE_CATALOG.female_zh.items : []);
}
function voiceGender(v) {
  if (!v) return null;
  if (v[1] === 'm') return 'male';
  if (v[1] === 'f') return 'female';
  return null;
}
// 当前是否在「电脑端」（非窄屏）：嘴巴动画、立绘仅电脑端展示
function isDesktop() {
  try { return !window.matchMedia('(max-width: 768px)').matches; } catch { return true; }
}
// 填充音色下拉：按 persona 性别只显示对应音色（女友只显示女声、男友只显示男声），避免错选/误以为是 bug
// personaOrGender: 'girlfriend'|'boyfriend'|'female'|'male' — 传 persona 时自动转成对应性别
function populateVoiceSelect(personaOrGender) {
  const sel = $('ttsVoice'); if (!sel) return;
  let want = personaOrGender;
  if (want === 'girlfriend') want = 'female';
  else if (want === 'boyfriend') want = 'male';
  if (want !== 'male' && want !== 'female') want = (userCfg && userCfg.persona === 'boyfriend') ? 'male' : 'female';
  sel.innerHTML = '';
  const items = voicesForGender(want);
  if (!items.length) return;
  const og = document.createElement('optgroup');
  og.label = want === 'male' ? '男声（中文·自然）' : '女声（中文·自然）';
  items.forEach(([id, label]) => {
    const o = document.createElement('option');
    o.value = id; o.textContent = label;
    og.appendChild(o);
  });
  sel.appendChild(og);
}

function esc(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function nearBottom() { return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90; }
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }       // 强制跳到底（发自己消息时用）
function followScroll() { if (nearBottom()) { messagesEl.scrollTop = messagesEl.scrollHeight; clearUnreadPill(); } } // 只在用户本就在底部时才跟随，翻历史时不打断
// ---- 未读 / 回到最新：翻看历史时，TA 新发的消息用底部「↓ N 条新消息」提示，点一下回到底 ----
let unreadCount = 0;
function updateJumpPill() { const p = $('jumpLatest'); if (!p) return; const c = $('jumpCount'); if (unreadCount > 0) { if (c) c.textContent = unreadCount; p.hidden = false; } else { p.hidden = true; } }
function clearUnreadPill() { unreadCount = 0; updateJumpPill(); }
function markUnreadNewMessage() { if (isAppHidden()) return; if (nearBottom()) { scrollBottom(); return; } unreadCount++; updateJumpPill(); }
messagesEl.addEventListener('scroll', () => { if (nearBottom()) clearUnreadPill(); });
const _jumpEl = $('jumpLatest'); if (_jumpEl) _jumpEl.addEventListener('click', () => { scrollBottom(); clearUnreadPill(); });
function q(suffix) { const sep = suffix.indexOf('?') === -1 ? '?' : '&'; return suffix + sep + 'userId=' + encodeURIComponent(UID); }

// ---- 时间显示（仿微信/QQ：日期分隔条 + 每条显示「谁 + 时间」） ----
let lastDateLabel = null;
function formatDateLabel(d) {
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  if (sameDay) return '今天';
  const y = new Date(today.getTime() - 86400000);
  const sameYest = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
  if (sameYest) return '昨天';
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd}`;
}
function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); const m = Math.floor(s / 60); const ss = String(s % 60).padStart(2, '0'); return m + ':' + ss; }
// 把消息（无论新 blocks 还是旧 content/image/isVideo）统一转成 blocks 数组
function toBlocks(m) {
  if (Array.isArray(m.blocks) && m.blocks.length) return m.blocks;
  const bs = [];
  if (m.content != null && String(m.content).trim()) bs.push({ type: 'text', text: String(m.content) });
  if (m.image) {
    const url = (typeof m.image === 'string' && (m.image.indexOf('/api/img') === 0 || m.image.indexOf('http') === 0)) ? m.image : null;
    if (m.isVideo) bs.push({ type: 'video', src: null, url, frames: null });
    else bs.push({ type: 'image', src: null, url, raw: m.image });
  } else if (m.isVideo) {
    bs.push({ type: 'video', src: null, url: null, frames: null });
  }
  return bs.length ? bs : [{ type: 'text', text: '' }];
}
// 把 blocks 压成发给模型的纯文字（图片/视频用占位符，具体图通过 currentImages 单独传）
function blocksToText(blocks) {
  return (blocks || []).map(b => {
    if (b.type === 'text') return b.text || '';
    if (b.type === 'video') return '（视频）';
    if (b.type === 'audio') return b.text ? b.text : '（语音）';
    return '（图片）';
  }).join('\n');
}
// 核心渲染：按 blocks 顺序在气泡里图文混排；text→段落，image/video→可点放大缩略
function renderMessageBlocks(role, blocks, ts, m) {
  const date = ts ? (ts instanceof Date ? ts : new Date(ts)) : new Date();
  const dateLabel = formatDateLabel(date);
  if (dateLabel !== lastDateLabel) {
    const sep = document.createElement('div'); sep.className = 'msg-date'; sep.textContent = dateLabel; messagesEl.appendChild(sep); lastDateLabel = dateLabel;
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'me' : 'them');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  (blocks || []).forEach(b => {
    if (b.type === 'text') {
      const t = b.text || '';
      if (!t.trim()) return;
      const p = document.createElement('div'); p.className = 'bubble-text'; p.innerHTML = esc(t); bubble.appendChild(p);
    } else if (b.type === 'image' || b.type === 'video') {
      const src = b.url || b.src || (b.raw && (b.raw.indexOf('/api/img') === 0 || b.raw.indexOf('http') === 0) ? b.raw : '');
      const iwrap = document.createElement('span');
      iwrap.className = 'msg-img-wrap' + (b.type === 'video' ? ' msg-img-video' : '');
      const im = document.createElement('img');
      im.className = 'msg-img'; im.src = src; im.alt = b.type === 'video' ? '视频' : '图片';
      iwrap.appendChild(im);
      if (b.type === 'video') { const badge = document.createElement('div'); badge.className = 'msg-video-badge'; badge.textContent = '▶'; iwrap.appendChild(badge); }
      bubble.appendChild(iwrap);
    } else if (b.type === 'audio') {
      // 语音消息：播放按钮 + 可拖拽进度条 + 时长；自动显示识别出来的文字（用户看不见识别过程，但能看见文字）
      const src = b.url || b.src || '';
      const arow = document.createElement('div'); arow.className = 'msg-audio';
      const play = document.createElement('button'); play.type = 'button'; play.className = 'audio-play'; play.textContent = '▶';
      const prog = document.createElement('div'); prog.className = 'audio-prog';
      const fill = document.createElement('div'); fill.className = 'audio-prog-fill'; prog.appendChild(fill);
      const dur = document.createElement('span'); dur.className = 'audio-dur'; dur.textContent = (b.duration ? fmtDur(b.duration) : '语音');
      const trBtn = document.createElement('button'); trBtn.type = 'button'; trBtn.className = 'audio-transcribe'; trBtn.textContent = '转文字';
      trBtn.addEventListener('click', (e) => { e.stopPropagation(); transcribeMsg(wrap); });
      arow.appendChild(play); arow.appendChild(prog); arow.appendChild(dur); arow.appendChild(trBtn);
      bubble.appendChild(arow);
      // 识别文字：作为气泡下的灰色小字自动呈现（无需手动点转文字按钮）
      if (b.text && b.text.trim()) {
        const cap = document.createElement('div'); cap.className = 'transcript'; cap.textContent = '🎤 ' + b.text.trim();
        bubble.appendChild(cap);
        trBtn.style.display = 'none'; // 已有字幕就隐藏手动转写按钮
      }
      if (src) {
        let aobj = null, raf = null;
        const setFill = () => { if (!aobj || !aobj.duration) return; fill.style.width = Math.min(100, (aobj.currentTime / aobj.duration) * 100) + '%'; dur.textContent = fmtDur(aobj.currentTime) + ' / ' + fmtDur(aobj.duration); };
        const stopRaf = () => { if (raf) { cancelAnimationFrame(raf); raf = null; } };
        play.addEventListener('click', () => {
          try {
            if (!aobj) { aobj = new Audio(src); aobj.addEventListener('ended', () => { play.textContent = '▶'; stopRaf(); setFill(); }); }
            if (aobj.paused) { aobj.play().catch(() => {}); play.textContent = '⏸'; const tick = () => { setFill(); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); }
            else { aobj.pause(); play.textContent = '▶'; stopRaf(); }
          } catch {}
        });
        const seek = (clientX) => { if (!aobj || !aobj.duration) return; const r = prog.getBoundingClientRect(); const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width)); aobj.currentTime = ratio * aobj.duration; setFill(); };
        prog.addEventListener('pointerdown', (e) => {
          e.preventDefault(); seek(e.clientX);
          const mv = (ev) => seek(ev.clientX);
          const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
        });
      } else { play.disabled = true; play.style.opacity = '0.4'; play.title = '语音文件缺失'; }
    }
  });
  // 微信式引用：被回复的消息作为独立条块放在气泡上方（不随气泡打字动画被清空）
  if (m && m.replyTo && m.replyTo.text) {
    const q = document.createElement('div'); q.className = 'quote';
    const qwho = document.createElement('div'); qwho.className = 'quote-who';
    qwho.textContent = (m.replyTo.name || (m.replyTo.role === 'user' ? '我' : 'TA')) + '：';
    const qtext = document.createElement('div'); qtext.className = 'quote-text'; qtext.textContent = m.replyTo.text || '';
    q.appendChild(qwho); q.appendChild(qtext);
    wrap.appendChild(q);
  }
  if (!bubble.childNodes.length) bubble.innerHTML = '…';
  const meta = document.createElement('div'); meta.className = 'meta';
  const who = (role === 'user') ? '我' : (userCfg && userCfg.companionName) || 'TA';
  meta.innerHTML = `<span class="who">${esc(who)}</span><span class="time">${formatTime(date)}</span>`;
  wrap.appendChild(bubble); wrap.appendChild(meta);
  if (m) wrap._msg = m;
  messagesEl.appendChild(wrap); followScroll();
  return wrap;
}

// ---------- 长按/右键消息菜单：复制 / 撤回(仅自己) / 删除 ----------
let _msgMenuEl = null;
let _suppressMenuClose = false;
// 判断这条消息右点菜单里要不要显示「朗读」项。
// 数据来源用 wrap._msg.blocks 而不是 innerText，避免把"▶ 语音 转文字"这种 UI 按钮文字当朗读内容。
function msgReadableTextOf(wrap) {
  const m = wrap && wrap._msg;
  if (m && Array.isArray(m.blocks)) {
    let longest = '';
    for (const b of m.blocks) {
      if (b.type === 'text') {
        const t = String(b.text || '').trim();
        if (t.length > longest.length && /[一-鿿]/.test(t)) longest = t;
      } else if (b.type === 'audio' && b.text && /[一-鿿]/.test(String(b.text))) {
        const t = String(b.text).trim();
        if (t.length > longest.length) longest = t;
      }
    }
    if (longest) return longest.slice(0, 600);
    // 全部是图/视频/无字幕语音 → 没有可朗读文字
    if (m.blocks.some(b => b.type === 'image' || b.type === 'video' || b.type === 'audio')) return '';
  }
  // 兜底走气泡 innerText（兼容服务端在流式还没填 blocks 的瞬时状态）
  const b = wrap.querySelector ? wrap.querySelector('.bubble') : null;
  let t = b ? (b.innerText || b.textContent || '') : '';
  t = String(t).replace(/\s+/g, ' ').trim();
  if (!/[一-鿿]/.test(t)) return '';
  if (t.length > 600) t = t.slice(0, 600);
  return t;
}
// 原始版本：取气泡全部 innerText 用于\"复制\"和\"回复某条\"显示原文（哪怕里头是数字/emoji 也照常展示）
function msgTextOf(wrap) { const b = wrap.querySelector('.bubble'); return b ? (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
function closeMsgMenu() { if (_msgMenuEl) { _msgMenuEl.remove(); _msgMenuEl = null; } }
function recallMsg(wrap) {
  const m = wrap._msg;
  const i = m ? history.indexOf(m) : -1;
  if (i >= 0) history.splice(i, 1);
  const sep = document.createElement('div'); sep.className = 'msg sys recalled';
  sep.innerHTML = '<div class="bubble">你撤回了一条消息</div>';
  wrap.replaceWith(sep); sep._msg = null;
  saveHistory(); toast('已撤回');
}
function deleteMsg(wrap) {
  const m = wrap._msg;
  const i = m ? history.indexOf(m) : -1;
  if (i >= 0) history.splice(i, 1);
  wrap.remove(); saveHistory(); toast('已删除');
}
function readMsgAloud(wrap) {
  const t = msgReadableTextOf(wrap);
  if (!t) { toast('这条没有可朗读的文字'); return; }
  playTTS(t, true);   // force：显式朗读无视"关闭自动朗读"
  toast('🔊 朗读中…');
}
// ---- 微信式「回复某条消息」 ----
let replyTarget = null;   // { role, name, text, ts } 或 null
function msgSnippetOf(wrap) {
  const t = msgTextOf(wrap);
  if (t) return t.slice(0, 60);
  if (wrap._msg && Array.isArray(wrap._msg.blocks)) {
    if (wrap._msg.blocks.some(b => b.type === 'image' || b.type === 'video')) return '（图片/视频）';
    if (wrap._msg.blocks.some(b => b.type === 'audio')) return '（语音）';
  }
  return '（消息）';
}
function replyMsg(wrap) {
  const m = wrap._msg;
  if (!m) { toast('这条消息无法回复'); return; }
  const role = m.role === 'user' ? 'user' : 'assistant';
  const name = role === 'user' ? '我' : ((userCfg && userCfg.companionName) || 'TA');
  replyTarget = { role, name, text: (msgTextOf(wrap) || msgSnippetOf(wrap)), ts: m.ts };
  renderReplyPreview();
  if (inputEl) inputEl.focus();
  toast('已引用，发消息即回复这条');
}
function cancelReply() { replyTarget = null; renderReplyPreview(); }
function renderReplyPreview() {
  const bar = $('replyPreview'); if (!bar) return;
  if (!replyTarget) { bar.hidden = true; return; }
  const who = bar.querySelector('.reply-preview-who');
  const sn = bar.querySelector('.reply-preview-snippet');
  if (who) who.textContent = '回复 ' + replyTarget.name + '：';
  if (sn) sn.textContent = replyTarget.text || '';
  bar.hidden = false;
}
function showMsgMenu(x, y, wrap) {
  closeMsgMenu();
  const menu = document.createElement('div'); menu.className = 'msg-menu';
  // 先判断本条消息是否含可朗读中文——纯图/语音/数字等没文字就不显示「朗读」项，
  // 避免点开菜单才发现\"这条没有可朗读的文字\"。同时「回复」项在该条无任何内容时也隐藏。
  const readable = msgReadableTextOf(wrap);
  const anyRealContent = !!(wrap._msg && Array.isArray(wrap._msg.blocks) && wrap._msg.blocks.length);
  const items = [['复制', () => { const t = msgTextOf(wrap); if (t && navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {}); toast('已复制'); }]];
  if (readable) items.push(['朗读', () => readMsgAloud(wrap)]);
  if (anyRealContent) items.push(['回复', () => replyMsg(wrap)]);
  if (wrap.classList.contains('me') && wrap._msg) items.push(['撤回', () => recallMsg(wrap)]);
  const _hasAudio = wrap._msg && Array.isArray(wrap._msg.blocks) && wrap._msg.blocks.some(b => b.type === 'audio');
  if (_hasAudio) items.push(['转文字', () => transcribeMsg(wrap)]);
  items.push(['删除', () => deleteMsg(wrap)]);
  items.forEach(([label, fn]) => { const it = document.createElement('div'); it.className = 'msg-menu-item'; it.textContent = label; it.addEventListener('click', () => { closeMsgMenu(); fn(); }); menu.appendChild(it); });
  const W = window.innerWidth || 360, H = window.innerHeight || 640;
  // 点击点在右半屏时菜单向左展开，避免出屏
  menu.style.left = (x > W / 2 ? Math.max(8, x - 130) : Math.min(x, W - 130)) + 'px';
  menu.style.top = Math.min(y, H - 110) + 'px';
  document.body.appendChild(menu); _msgMenuEl = menu;
  // 屏蔽同一次右键事件冒泡到 document 时导致的"刚弹出就被误关"
  _suppressMenuClose = true; setTimeout(() => { _suppressMenuClose = false; }, 0);
}
if (messagesEl) {
  messagesEl.addEventListener('contextmenu', (e) => {
    const wrap = e.target.closest('.msg');
    if (!wrap) return;
    e.preventDefault();
    showMsgMenu(e.clientX, e.clientY, wrap);
  });
  let _touchT = null;
  messagesEl.addEventListener('touchstart', (e) => {
    const wrap = e.target.closest('.msg'); if (!wrap) return;
    _touchT = setTimeout(() => { const t = e.touches[0]; showMsgMenu(t.clientX, t.clientY, wrap); }, 500);
  }, { passive: true });
  messagesEl.addEventListener('touchend', () => { if (_touchT) { clearTimeout(_touchT); _touchT = null; } });
  messagesEl.addEventListener('touchmove', () => { if (_touchT) { clearTimeout(_touchT); _touchT = null; } }, { passive: true });
}
document.addEventListener('click', (e) => { if (_msgMenuEl && !_msgMenuEl.contains(e.target)) closeMsgMenu(); });
document.addEventListener('contextmenu', (e) => { if (_msgMenuEl && !_msgMenuEl.contains(e.target) && !_suppressMenuClose) closeMsgMenu(); });
if ($('replyCancel')) $('replyCancel').addEventListener('click', cancelReply);

// 兼容旧调用：renderMessage(role, content, ts, image, isVideo)
function renderMessage(role, content, ts, image, isVideo) {
  return renderMessageBlocks(role, toBlocks({ content, image, isVideo }), ts);
}
function addSystemHint(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg sys';
  wrap.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  messagesEl.appendChild(wrap);
  followScroll();
}

async function apiGet(url) { const r = await fetch(url); return r.json(); }
async function apiPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
function saveHistory(personaOverride, replace) {
  // 持久化：消息以 blocks 存储；图片/视频只保留服务器 URL 引用（/api/img?... 或外链 http），
  // 不存 base64，避免历史文件膨胀；base64 仅本会话用于发给视觉模型，不落盘。重启后通过 URL 重现原图。
  // personaOverride：切换角色时用来指定"存到哪个角色的桶"（默认用当前 userCfg.persona）。
  // replace=true：整体覆盖（清空对话用）；否则后端按 ts 合并，不会把服务器上已落盘的聊天冲掉。
  const persona = personaOverride || (userCfg && userCfg.persona) || 'girlfriend';
  const clean = history.map(m => {
    const c = { role: m.role, ts: m.ts };
    if (m.replyTo && m.replyTo.text) c.replyTo = m.replyTo;   // 微信式引用：持久化，重启后仍显示引用头
    const bs = Array.isArray(m.blocks) ? m.blocks : toBlocks(m);
    c.blocks = bs.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'video') return { type: 'video', url: b.url || null };
      if (b.type === 'audio') return { type: 'audio', url: b.url || null, src: (b.src && b.src.indexOf('data:') === 0 && b.src.length < 5 * 1024 * 1024) ? b.src : null, text: b.text || '', duration: b.duration || 0 };
      return { type: 'image', url: (b.url || (b.raw && (b.raw.indexOf('/api/img') === 0 || b.raw.indexOf('http') === 0) ? b.raw : null)) || null };
    });
    return c;
  });
  return apiPost(q('/api/history'), { persona, history: clean, replace: !!replace });
}

// 按角色分桶渲染聊天历史到视图（清空当前、重画）
function renderHistoryIntoView(hist) {
  history = Array.isArray(hist) ? hist : [];
  messagesEl.innerHTML = '';
  lastDateLabel = null;
  if (!history.length) {
    addSystemHint(`你好，我是${userCfg && userCfg.companionName}～${(userCfg && userCfg.persona) === 'boyfriend' ? '以后罩着你🤍' : '很高兴认识你💕'}`);
  } else {
    history.forEach(m => {
      try { renderMessageBlocks(m.role, toBlocks(m), m.ts, m); }
      catch (e) { console.error('[history] 单条渲染失败，已跳过该条', m, e); }
    });
    scrollBottom();   // 打开时直接停在最下方（最新消息）
    backfillSttForHistory();
    // 图片/语音异步加载完会改变高度，二次滚动确保真正停在最新消息处
    setTimeout(scrollBottom, 300);
    setTimeout(scrollBottom, 900);
  }
}

// 从后端加载指定角色的聊天记录并渲染（女友/男友各自独立）
async function loadHistoryForPersona(persona) {
  let hist = null;
  // 后端是本地常驻服务（同进程 Electron），启动时偶尔第一拍还没就绪；
  // 失败重试一次，避免“打开一片空白”被误判成“消息丢了”。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 注意：q() 已自动拼上 ?userId=...，这里必须用 & 接 persona，不能用 ?，
      // 否则会出现 "...?userId=xxx?persona=girlfriend" 双问号，导致 userId 含非法字符被 safeId 拒掉、返回 400、历史空白。
      const r = await apiGet(q('/api/history') + '&persona=' + encodeURIComponent(persona));
      if (Array.isArray(r)) { hist = r; break; }
    } catch (e) { console.warn('[history] 加载失败 第' + (attempt + 1) + '次', e); }
    await new Promise(res => setTimeout(res, 500));
  }
  if (!Array.isArray(hist)) {
    // 接口异常时按空处理，但明确打日志：数据仍在磁盘，绝不会因此丢失
    console.error('[history] 接口未返回历史数组，已按空处理（磁盘数据未动）', hist);
    hist = [];
  }
  renderHistoryIntoView(hist);
}

// 切换角色：先把当前角色的聊天存盘，再加载目标角色聊天并重渲染
async function switchPersona(newPersona) {
  if (!userCfg) return;
  const old = userCfg.persona || 'girlfriend';
  if (old === newPersona) { applyPersona(userCfg); return; }
  await saveHistory(old);                       // 存当前(旧角色)的聊天到旧桶
  userCfg.persona = newPersona;
  await saveUserCfg();
  applyPersona(userCfg);
  await loadHistoryForPersona(newPersona);      // 加载新角色的聊天
}
function saveUserCfg() { apiPost('/api/me', Object.assign({ userId: UID }, userCfg)); }
function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px'; }

function updateToneChip() {
  if (userCfg && userCfg.tone && userCfg.tone.trim()) {
    toneChipEl.textContent = '🎀 ' + userCfg.tone.trim();
    toneChipEl.style.display = 'inline-block';
  } else { toneChipEl.textContent = ''; toneChipEl.style.display = 'none'; }
}
// 按角色取 TA 的名字（女友/男友各自独立），与后端 nameFor 对应
function nameForPersona(persona, cfg) {
  if (!cfg) return '小念';
  if (persona === 'boyfriend') return cfg.companionNameBoyfriend || cfg.companionName || '阿澈';
  return cfg.companionNameGirlfriend || cfg.companionName || '小念';
}
function applyPersona(cfg) {
  userCfg = cfg;
  const persona = cfg.persona || 'girlfriend';
  const meta = PERSONA_META[persona] || PERSONA_META.girlfriend;
  const nm = nameForPersona(persona, cfg);
  nameEl.textContent = nm;
  avatarEl.textContent = meta.avatar;
  petEmoji.textContent = meta.emoji;
  charEl.className = 'char ' + persona;
  const personaChip = $('personaChip');
  if (personaChip) personaChip.textContent = persona === 'boyfriend' ? '男友' : '女友';
  updateToneChip();
  updateModeChip(); updateThinkChip();
  petName.textContent = nm;
  userCfg.companionName = nm; // 同步旧字段，兼容其它引用与持久化

  const customUrl = persona === 'boyfriend' ? (cfg.portraitBoyfriend || '') : (cfg.portraitGirlfriend || '');

  // 立绘统一走后端 /api/portrait（自定义真实照片直链或精选真实人像，自动识别）
  const src = q('/api/portrait?persona=' + persona) + '&t=' + Date.now();
  charImg.src = src; petImg.src = src;
  // 气泡头像：对方头像 = 真实照片（与桌面立绘同一张）；桌面 / 移动端都显示
  document.documentElement.style.setProperty('--companion-avatar', 'url("' + src + '")');
  charImg.style.display = ''; petImg.style.display = '';
  charImg.onerror = () => { charImg.style.display = 'none'; };
  petImg.onerror = () => { petImg.style.display = 'none'; };
  // 按当前角色已保存的嘴巴定位裁剪
  applyMouth((cfg && cfg.mouth) || null);
  // 让免费视觉 AI 自动识别新立绘的嘴巴位置（换图即重定位，手动微调会被保留）
  setTimeout(autoLocateMouth, 700);
  // 同步心情与立绘光晕
  applyMood((cfg && cfg.mood) || 'calm');
}

// 应用「我」的头像：有自定义图则切背景图，否则保持默认绿色「我」
function applyUserPortrait() {
  const up = (userCfg && userCfg.userPortrait) || '';
  if (up && !up.startsWith('local:')) {
    // 远程直链
    document.documentElement.style.setProperty('--user-avatar', 'url("' + up + '")');
    document.documentElement.classList.add('has-user-avatar');
  } else if (up.startsWith('local:')) {
    const src = q('/api/portrait?who=user') + '&t=' + Date.now();
    document.documentElement.style.setProperty('--user-avatar', 'url("' + src + '")');
    document.documentElement.classList.add('has-user-avatar');
  } else {
    document.documentElement.classList.remove('has-user-avatar');
    document.documentElement.style.removeProperty('--user-avatar');
  }
}

// 语气指令解析：命令本身不发给模型，只改配置
function parseTone(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const slash = t.match(/^\/(tone|语气)\s*(.*)$/i);
  if (slash) {
    const body = slash[2].trim();
    if (/^(reset|重置|恢复|清语气)$/i.test(body)) return { action: 'reset' };
    if (body) return { action: 'set', tone: body };
    return null;
  }
  if (/^\/(reset|reset-tone|清语气)\b/i.test(t)) return { action: 'reset' };
  if (t.length > 40) return null;
  if (!/语气|语调|口吻|说话风格|对我说话|回复我|和我聊|跟我聊|态度/.test(t)) return null;
  let m;
  if ((m = t.match(/用(.+?)的语气/))) return { action: 'set', tone: m[1].trim() };
  if ((m = t.match(/语气[要变调成]?(.+?)(?:一点|些|点)?$/))) return { action: 'set', tone: m[1].trim() };
  if ((m = t.match(/(以后|之后)(.+?)说话/))) return { action: 'set', tone: m[2].trim() };
  if ((m = t.match(/(.+?)(?:地|地)?(?:对我说话|回复我|和我聊|跟我聊)/))) return { action: 'set', tone: m[1].trim() };
  return null;
}

// ---- 对话框内命令系统（以 / 开头，不发给模型，直接改配置/执行动作） ----
let lastAssistantIndex = -1;
function updateModeChip() {
  const c = $('modeChip'); if (!c) return;
  const m = (userCfg && userCfg.mode) || 'immersive';
  const label = { daily: '日常', immersive: '沉浸', deep: '深度' }[m] || '沉浸';
  c.textContent = '🗂 ' + label;
}
function updateThinkChip() {
  const c = $('thinkChip'); if (!c) return;
  const on = !userCfg || userCfg.deepThink !== false;
  c.textContent = on ? '🤔 思考' : '💭 直答';
  c.classList.toggle('off', !on);
}
function parseCommand(line) {
  const m = line.match(/^\/([a-zA-Z一-龥]+)(?:\s+(.*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}
function showHelp() {
  const list = [
    '/help — 查看所有命令',
    '/tone 语气 — 设置说话风格，如「/tone 撒娇」；「/tone reset」恢复',
    '/mode 日常|沉浸|深度 — 切换相处模式（沉浸=陪在身边，深度=陪你想透）',
    '/think 开|关 — 开关「认真思考」：先想再答，更走心、更少套话',
    '/persona 女友|男友 — 切换 TA 的身份',
    '/name 新名字 — 改 TA 的名字',
    '/mute — 开关配音朗读',
    '/remember 要记住的事 — 让 TA 记住关于你的事（跨会话）',
    '/remind 明天9点 吃药 — 让 TA 到点提醒你（平时说"提醒我…"也会自动记）',
    '/reminders — 看看还有哪些待提醒',
    '/forget 关键词 或 /forget all — 删除记忆',
    '/mood 开心|温柔|沉思… — 查看或切换 TA 当下的心情基调',
    '/topic — 来一个值得深聊的话题',
    '/clear — 清空对话',
    '/export — 导出聊天记录为文本',
  ].join('\n');
  addSystemHint('💡 可用命令（直接发在对话框里）：\n' + list);
}
async function runCommand(cmd) {
  if (!cmd) return false;
  const { name, args: t } = cmd;
  if (name === 'help' || name === '帮助' || name === '命令') { showHelp(); return true; }
  if (name === 'tone' || name === '语气') {
    if (!t || /^(reset|重置|清语气)$/i.test(t)) { if (userCfg) userCfg.tone = ''; addSystemHint('语气已恢复正常～'); }
    else { if (userCfg) userCfg.tone = t; addSystemHint('记住啦，以后用「' + t + '」的语气跟你说话 🎀'); }
    if (userCfg) { await saveUserCfg(); updateToneChip(); }
    return true;
  }
  if (name === 'mode' || name === '模式') {
    const map = { '日常': 'daily', 'daily': 'daily', '闲聊': 'daily', '沉浸': 'immersive', 'immersive': 'immersive', '深度': 'deep', 'deep': 'deep', '认真': 'deep' };
    if (!t) { addSystemHint('当前模式：' + ({ daily: '日常', immersive: '沉浸', deep: '深度' }[(userCfg && userCfg.mode) || 'immersive']) + '。可用：/mode 日常|沉浸|深度'); }
    else {
      const mv = map[t];
      if (!mv) { addSystemHint('模式只支持：日常 / 沉浸 / 深度（或 daily/immersive/deep）'); return true; }
      if (userCfg) { userCfg.mode = mv; await saveUserCfg(); updateModeChip(); }
      const zh = { daily: '日常', immersive: '沉浸', deep: '深度' }[mv];
      const desc = { daily: '日常闲聊，轻松随意', immersive: '沉浸式相处，陪在身边', deep: '深度对话，陪你想透' }[mv];
      addSystemHint('已切到「' + zh + '」模式：' + desc);
    }
    return true;
  }
  if (name === 'think' || name === '思考') {
    let on;
    if (!t || /^(toggle|切换)$/i.test(t)) on = !(userCfg && userCfg.deepThink !== false);
    else on = !/^(关|off|false|0|否)$/i.test(t);
    if (userCfg) { userCfg.deepThink = on; await saveUserCfg(); updateThinkChip(); }
    addSystemHint(on ? '🤔 已开启「认真思考」：TA 会先想再答，更走心、更少套话' : '💭 已关闭「认真思考」：TA 会直接回答');
    return true;
  }
  if (name === 'persona' || name === '角色') {
    const map = { '女友': 'girlfriend', 'girlfriend': 'girlfriend', '女': 'girlfriend', '男友': 'boyfriend', 'boyfriend': 'boyfriend', '男': 'boyfriend' };
    const pv = map[t];
    if (!pv) { addSystemHint('身份只支持：女友 / 男友'); return true; }
    await switchPersona(pv);
    addSystemHint('已切换为' + (pv === 'girlfriend' ? '女友' : '男友') + ' 💕');
    return true;
  }
  if (name === 'name' || name === '名字' || name === '叫') {
    if (!t) { addSystemHint('用法：/name 新名字'); return true; }
    if (userCfg) {
      const pv = userCfg.persona || 'girlfriend';
      if (pv === 'boyfriend') userCfg.companionNameBoyfriend = t; else userCfg.companionNameGirlfriend = t;
      userCfg.companionName = t; // 同步旧字段
      await saveUserCfg(); applyPersona(userCfg);
    }
    addSystemHint('以后就叫你「' + t + '」啦～');
    return true;
  }
  if (name === 'mute' || name === '静音' || name === '闭嘴') {
    ttsMuted = !ttsMuted;
    localStorage.setItem('companion_tts_muted', ttsMuted ? '1' : '0');
    const btn = $('ttsToggle'); if (btn) btn.textContent = ttsMuted ? '🔇 静音' : '🔊 配音';
    addSystemHint(ttsMuted ? '🔇 已静音，不再自动朗读' : '🔊 已开启自动朗读');
    return true;
  }
  if (name === 'clear' || name === '清空' || name === '清屏') {
    history = []; saveHistory(undefined, true); messagesEl.innerHTML = ''; lastDateLabel = null;
    if (userCfg) addSystemHint('对话已清空。我是' + userCfg.companionName + '，' + (userCfg.persona === 'girlfriend' ? '以后请多关照呀💕' : '以后罩着你🤍'));
    return true;
  }
  if (name === 'remember' || name === '记住' || name === '记忆') {
    if (!t) { addSystemHint('用法：/remember 要记住的事（例如 /remember 我不吃香菜）'); return true; }
    if (!userCfg) userCfg = {};
    if (!Array.isArray(userCfg.memories)) userCfg.memories = [];
    userCfg.memories.push(t); if (userCfg.memories.length > 50) userCfg.memories = userCfg.memories.slice(-50);
    await saveUserCfg();
    addSystemHint('🧠 我记住了：「' + t + '」以后会放在心上');
    return true;
  }
  if (name === 'forget' || name === '忘记' || name === '忘掉') {
    if (!userCfg || !Array.isArray(userCfg.memories) || !userCfg.memories.length) { addSystemHint('我暂时还没记住什么～'); return true; }
    if (!t || /^(all|全部|清空)$/i.test(t)) { userCfg.memories = []; addSystemHint('🧹 我已忘记所有记住的事'); }
    else {
      const before = userCfg.memories.length;
      userCfg.memories = userCfg.memories.filter(m => m.toLowerCase().indexOf(t.toLowerCase()) === -1);
      addSystemHint(userCfg.memories.length < before ? '🧹 已忘掉和「' + t + '」相关的记忆' : '没找到和「' + t + '」相关的记忆');
    }
    await saveUserCfg();
    return true;
  }
  if (name === 'export' || name === '导出' || name === '备份') {
    try {
      const lines = ['AI 伴侣聊天记录', '导出时间：' + new Date().toLocaleString(), ''];
      for (const m of history) {
        const who = m.role === 'user' ? '我' : ((userCfg && userCfg.companionName) || 'TA');
        const txt = blocksToText(m.blocks || toBlocks(m));
        lines.push('[' + new Date(m.ts || Date.now()).toLocaleString() + '] ' + who + '：' + txt);
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'AI伴侣聊天记录_' + Date.now() + '.txt';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      addSystemHint('📄 聊天记录已导出为 txt 文件');
    } catch (e) { addSystemHint('导出失败：' + (e && e.message || e)); }
    return true;
  }
  if (name === 'mood' || name === '心情') {
    if (!t) { addSystemHint('此刻我的心情：' + (MOODS[currentMood] ? MOODS[currentMood].emoji + ' ' + MOODS[currentMood].label : '—') + '。也可以「/mood 温柔」让我切换当下的心情基调'); }
    else {
      const mk = Object.keys(MOODS).find(k => k === t || MOODS[k].label === t);
      if (mk) { applyMood(mk); addSystemHint('（我把此刻的心情调成了「' + MOODS[mk].label + '」）'); }
      else addSystemHint('心情只支持：' + Object.values(MOODS).map(m => m.label).join(' / '));
    }
    return true;
  }
  if (name === 'topic' || name === '话题' || name === '深度') {
    addSystemHint('💭 一个值得聊下去的问题：\n' + randomTopic());
    return true;
  }
  if (name === 'remind' || name === '提醒' || name === '闹钟') {
    if (!t) { addSystemHint('用法：/remind 明天 9:00 吃药（平时说"提醒我…"也会自动记）'); return true; }
    try {
      const r = await apiPost('/api/reminder', { userId: UID, text: t });
      if (r && r.has) {
        const d = new Date(r.reminder.at);
        addSystemHint('⏰ 记下了，我会在 ' + d.toLocaleString('zh-CN', { hour12: false }) + ' 提醒你：' + r.reminder.text);
      } else {
        addSystemHint('⏰ 我没能从这句话里听出具体时间，换个说法试试？比如"明早9点提醒我吃药"');
      }
    } catch (e) { addSystemHint('设置提醒失败：' + (e && e.message || e)); }
    return true;
  }
  if (name === 'reminders' || name === '待办' || name === '提醒列表') {
    try {
      const me = await apiGet(q('/api/me'));
      const list = (me.reminders || []).filter(r => !r.done).sort((a, b) => a.at - b.at);
      if (!list.length) addSystemHint('📭 暂时没有待提醒的事');
      else addSystemHint('📋 待提醒：\n' + list.map(r => '• ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }) + ' — ' + r.text).join('\n'));
    } catch (e) { addSystemHint('读取提醒失败'); }
    return true;
  }
  addSystemHint('未知命令：/' + name + '。输入 /help 查看全部命令');
  return true;
}

// ================= 情绪 / 亲密度 / 氛围 / 手势 / 日记 / 深度话题 =================
// TA 是有情绪的：每句回复会推断此刻心情，立绘光晕随之变色，连声音的音高语速都带上情绪。
const MOODS = {
  happy:      { label: '开心', emoji: '😊', color: '#FF6FA5', soft: 'rgba(255,111,165,0.45)', pitch: 1.12, rate: 1.18 },
  excited:    { label: '雀跃', emoji: '✨', color: '#FF8A3D', soft: 'rgba(255,138,61,0.45)',  pitch: 1.2,  rate: 1.22 },
  calm:       { label: '平静', emoji: '🌿', color: '#7FB0FF', soft: 'rgba(127,176,255,0.40)', pitch: 1.0,  rate: 1.08 },
  thoughtful: { label: '沉思', emoji: '🌙', color: '#9B8CFF', soft: 'rgba(155,140,255,0.42)', pitch: 0.94, rate: 1.04 },
  tender:     { label: '温柔', emoji: '🤍', color: '#FF9EC7', soft: 'rgba(255,158,199,0.46)', pitch: 1.06, rate: 1.08 },
  sad:        { label: '低落', emoji: '🌧️', color: '#6E8BBF', soft: 'rgba(110,139,191,0.40)', pitch: 0.9,  rate: 1.0 },
  playful:    { label: '俏皮', emoji: '😜', color: '#FFC24B', soft: 'rgba(255,194,75,0.45)',  pitch: 1.15, rate: 1.2 },
  annoyed:    { label: '小恼', emoji: '😤', color: '#FF5C5C', soft: 'rgba(255,92,92,0.40)',   pitch: 1.0,  rate: 1.15 }
};
let currentMood = (userCfg && userCfg.mood) || 'calm';
function detectMood(text) {
  const t = (text || '');
  const has = (...kw) => kw.some(k => t.indexOf(k) !== -1);
  if (/[😊😄😁😂🥰😍🤗💖💕❤️]/u.test(t)) return 'happy';
  if (/[😭🥺😢💔☹️🫤]/u.test(t)) return 'sad';
  if (/[😤😠😒🙄]/u.test(t)) return 'annoyed';
  if (/[✨🎉🔥💥⚡🤩]/u.test(t)) return 'excited';
  if (/[🌙🌿😌🍃]/u.test(t)) return 'calm';
  if (has('想你', '喜欢', '爱你', '开心', '高兴', '幸福', '好喜欢', '甜', '抱', '亲', '温柔', '在乎', '心疼')) return 'tender';
  if (has('哈哈', '太好笑', '笑死', '逗', '调皮', '恶作剧', '顽皮')) return 'playful';
  if (has('难过', '伤心', '委屈', '失落', '想哭', '孤独', '烦', '累', '压力', '焦虑')) return 'sad';
  if (has('生气', '烦死了', '无语', '受不了', '讨厌', '恼', '火大')) return 'annoyed';
  if (has('认真', '想了想', '其实', '沉思', '想清楚', '纠结', '思考', '道理', '意义')) return 'thoughtful';
  if (has('好啊', '太棒', '激动', '哇', '厉害', '好开心', '耶', '期待')) return 'excited';
  if (has('嗯', '还好', '挺好', '安静', '陪', '慢慢', '舒服')) return 'calm';
  return 'happy';
}
function applyMood(moodKey) {
  const m = MOODS[moodKey] || MOODS.calm;
  currentMood = moodKey;
  if (stageEl) {
    stageEl.style.setProperty('--mood-glow', m.color);
    stageEl.style.setProperty('--mood-glow-soft', m.soft);
  }
  // 情绪不再改变音色（音高/语速）：保持真人般稳定的声音，情绪只由文字表达。
  // __moodVoice 保留为中性，浏览器语音兜底也不再用情绪调音。
  window.__moodVoice = { pitch: 1, rate: 1 };
  if (userCfg) { userCfg.mood = moodKey; saveUserCfg(); }
}
// 氛围随时间变化：整个场景在不同时段有不同光感（清晨暖、午后亮、傍晚柔、深夜静）
function applyAmbiance() {
  const h = new Date().getHours();
  const phase = h < 6 ? 'night' : h < 11 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const phases = ['amb-morning', 'amb-afternoon', 'amb-evening', 'amb-night'];
  document.body.classList.remove(...phases); document.body.classList.add('amb-' + phase);
  const app = $('app'); if (app) { app.classList.remove(...phases); app.classList.add('amb-' + phase); }
  const labels = { morning: '清晨', afternoon: '午后', evening: '傍晚', night: '深夜' };
}
// 深度话题：给一个值得聊下去的开放式问题
const DEEP_TOPICS = [
  '如果有一天时间停住了，你最想和谁、在哪、做什么？',
  '你最近有没有一个瞬间，觉得自己真的长大了？',
  '说一个你从小到大一直没敢告诉别人的小秘密吧。',
  '你理想中的「家」是什么样的？不一定是人，是一种感觉。',
  '有没有哪首歌，一响起就会把你拉回某个具体的人或时刻？',
  '如果可以问未来的自己一个问题，你会问什么？',
  '你害怕失去的东西里，哪个是你自己都没意识到的？',
  '最近一次让你觉得「活着真好」的瞬间，是什么？',
  '你觉得，一个人该怎么才算真正懂另一个人？',
  '如果今晚是世界的最后一晚，你最想和我说一句什么？'
];
function randomTopic() { return DEEP_TOPICS[Math.floor(Math.random() * DEEP_TOPICS.length)]; }

async function send() {
  if (streaming) return;
  // 把当前输入框文字作为最后一个 text block；与已挂的图/视频块拼成完整草稿
  commitTextBlock();
  const blocks = draftBlocks.slice();
  draftBlocks = [];
  const real = blocks.filter(b => b.type !== 'text' || b.text.trim());
  if (!real.length) { renderDraft(); return; }  // 空消息不发送

  // 命令：以 / 开头的整行文本指令，单独处理（不发给模型）
  const allText = real.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const hasNonText = real.some(b => b.type !== 'text');
  if (!hasNonText && allText.trim().startsWith('/')) {
    const handled = await runCommand(parseCommand(allText.trim()));
    if (handled) { inputEl.value = ''; autoGrow(); clearDraft(); return; }
  }
  // 自然语言语气指令（"用XX的语气"等），命中则不发送，仅调整语气
  const tc = parseTone(allText);
  if (tc) {
    if (tc.action === 'reset') userCfg.tone = '';
    else userCfg.tone = tc.tone;
    await saveUserCfg(); updateToneChip();
    addSystemHint(tc.action === 'reset' ? '语气已恢复正常～' : `记住啦，以后用「${tc.tone}」的语气跟你说话 🎀`);
    inputEl.value = ''; autoGrow(); clearDraft();
    return;
  }

  inputEl.value = ''; autoGrow();
  clearDraft();
  const userTs = Date.now();
  const rep = replyTarget || null;   // 微信式回复：捕获被回复的消息
  const userMsg = { role: 'user', ts: userTs, blocks: real.map(b => {
    const out = { type: b.type, text: b.text };
    if (b.type === 'audio') { out.url = b.url || null; out.src = (b.src && b.src.indexOf('data:') === 0 && b.src.length < 5 * 1024 * 1024) ? b.src : null; out.duration = b.duration || 0; }
    else if (b.type === 'image' || b.type === 'video') out.url = b.url || null;
    return out;
  }) };
  if (rep) userMsg.replyTo = rep;
  const uwrap = renderMessageBlocks('user', real, userTs, userMsg);
  if (uwrap) uwrap._msg = userMsg;
  scrollBottom();       // 自己发的消息：强制跳到底，确保看到

  // 上传图片/视频首帧/语音到服务器磁盘，拿到可长期访问的 URL（重启后仍能重现原图/原声，微信式）
  for (const b of real) {
    if ((b.type === 'image' || b.type === 'video' || b.type === 'audio') && !b.url && b.src) {
      const ep = b.type === 'audio' ? '/api/audio/upload' : '/api/img/upload';
      try {
        const up = await apiPost(ep, { userId: UID, dataUrl: b.src });
        if (up && up.ok) b.url = up.url;
        else { console.warn('[upload] 返回非 ok', ep, up); toast('⚠️ ' + (b.type === 'audio' ? '语音' : '图片') + '上传失败（将仅作本地识别）'); }
      } catch (e) { console.error('[upload] 失败', ep, e); toast('⚠️ 上传出错：' + (e && e.message ? e.message : '网络异常') + '（仍会本地识别）'); }
    }
  }
  // 历史存 blocks（图片/语音用 URL，不存 base64，避免请求体随对话变长而暴涨）
  history.push(userMsg);
  saveHistory();
  playChime('sent'); // 提示音：消息已落本地历史

  // 自然提醒：消息里若出现提醒意图关键词，后台悄悄记一个提醒（不影响正常聊天）
  if (/提醒|闹钟|到点|别忘|定时/.test(allText)) {
    try { apiPost('/api/reminder', { userId: UID, text: allText }); } catch (e) {}
  }

  await streamReply(real, rep);
  cancelReply();   // 发送后清除引用状态与预览条
}
// 自动记忆：每隔几轮触发一次后台抽取
let _turnCount = 0;
// 流式请求助手回复；history 此时应以 user 消息结尾。real 为当轮草稿块（含图片 base64），首次生成时传入。
async function streamReply(real, rep) {
  streaming = true;
  const thinking = !userCfg || userCfg.deepThink !== false;
  setStatus('typing');
  startTalking();
  const assistantTs = Date.now();
  const assistantMsg = { role: 'assistant', ts: assistantTs, replyTo: rep || null };  // 引用头：TA 的回复也指向被回复的那条
  const bubble = renderMessageBlocks('assistant', [], assistantTs, assistantMsg);
  markUnreadNewMessage();
  bubble.classList.add('typing');
  bubble.innerHTML = '<i></i><i></i><i></i>';   // TA 正在输入三点动画
  currentAssistantBubble = bubble;
  let typingShown = true;
  let acc = '';
  let unspokenBuf = '';
  // TA 回复形式：随机/总是语音/总是文字（设置项 voiceReplyMode）。语音回复时不边收边朗读，留到以语音气泡呈现。
  const vmode = (userCfg && userCfg.voiceReplyMode) || 'random';
  const wantVoice = vmode === 'voice' || (vmode === 'random' && Math.random() < 0.5);
  _revealBuf = ''; _speakQueue.length = 0; _speakPlaying = false; ttsWarnReason = '';
  _voiceProduced = false; _chimeDone = false; _voiceQueue.length = 0; _voicePending = 0;
  try {
    // 历史转纯文字（图只当轮视觉用，不累积进请求体，根治"对话越长越容易卡/超限"）
    const chatBody = { userId: UID, messages: history.map(m => ({ role: m.role, content: blocksToText(m.blocks || toBlocks(m)) })), replyTo: rep || undefined };
    // 当轮所有图 + 视频多帧，一并喂给视觉模型（glm-4v-flash 支持多图）
    const imgs = (real || []).filter(b => b.type === 'image' && b.src);
    const vids = (real || []).filter(b => b.type === 'video' && b.frames);
    const hasImg = imgs.length || vids.length;
    if (hasImg) {
      chatBody.currentImages = imgs.map(b => b.src).concat(vids.flatMap(b => b.frames || []));
      chatBody.isVideo = vids.length > 0;
    }
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatBody)
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', mode = 'data';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const tt = line.trim();
        if (tt.startsWith('event:')) { mode = tt.slice(6).trim(); continue; }
        if (!tt.startsWith('data:')) continue;
        const data = tt.slice(5).trim();
        if (mode === 'error') { try { throw new Error(JSON.parse(data).message); } catch (e) { showError(e.message); } mode = 'data'; continue; }
        if (mode === 'done') { mode = 'data'; continue; }
        try {
          const obj = JSON.parse(data);
          if (obj.delta) {
            if (typingShown) { bubble.classList.remove('typing'); typingShown = false; setStatus('typing'); } // 首个字到了，状态保持"正在输入中"
            acc += obj.delta;
            // 文字回复：边收边逐句朗读（正出字正说话）
            // 语音回复：边收边逐句合成成语音气泡，TA 不必等整段出完就开口（更快）
            unspokenBuf += obj.delta;
            const { sentences, rest } = extractSentences(unspokenBuf);
            unspokenBuf = rest;
            if (wantVoice) {
              for (const s of sentences) { await enqueueVoice(s, assistantTs, bubble); }
            } else {
              for (const s of sentences) enqueueTTS(s, bubble);
            }
          }
        } catch {}
      }
    }
    if (unspokenBuf.trim()) {
      if (wantVoice) await enqueueVoice(unspokenBuf.trim(), assistantTs, bubble);
      else enqueueTTS(unspokenBuf.trim(), bubble);
    }
  } catch (e) {
    showError(e.message || '出错了');
  }
  streaming = false;
  if (wantVoice) await waitVoiceIdle();
  else await Promise.race([waitTTSIdle(), new Promise(r => setTimeout(r, 60000))]);
  setStatus('online');
  // 若在线 TTS 整段失败，给一条清晰、可执行的提示（不再静默无声）
  if (ttsWarnReason && !ttsMuted && !(userCfg && userCfg.ttsEnabled === false)) {
    addSystemHint('⚠️ 配音没出声：' + ttsWarnReason + '。已用浏览器自带语音朗读；若仍无声，可能是系统未安装中文语音包（可在系统设置里添加）。');
  }
  stopTalking();
  bubble.classList.remove('typing');
  // 合成/存储前再清洗一次：彻底剥离所有英文（根治 chinese lever/level 等漏网），字幕与朗读都干净
  if (acc) acc = cleanTTS(acc);
  if (acc) {
    if (wantVoice && !_voiceProduced) {
      // 逐句合成全失败才走到这里：降级为整段一次性合成（沿用原逻辑）
      const audio = await synthesizeToDataUrl(acc);
      if (audio) {
        let url = null;
        try { const up = await apiPost('/api/audio/upload', { userId: UID, dataUrl: audio.dataUrl }); if (up && up.ok) url = up.url; } catch {}
        if (bubble && bubble.parentNode) bubble.remove();
        renderAssistantVoice(acc, audio.dataUrl, audio.duration, assistantTs);
        history.push({ role: 'assistant', ts: assistantTs, blocks: [{ type: 'audio', text: acc, url: url || null, src: audio.dataUrl, duration: audio.duration || 0 }], content: acc, replyTo: rep || null });
        lastAssistantIndex = history.length - 1; saveHistory();
        playChime('them');
      } else {
        if (bubble && bubble.parentNode) bubble.innerHTML = esc(acc);
        else renderMessageBlocks('assistant', [], assistantTs, { role: 'assistant', ts: assistantTs, content: acc, replyTo: rep || null });
        history.push({ role: 'assistant', content: acc, ts: assistantTs, replyTo: rep || null });
        lastAssistantIndex = history.length - 1; saveHistory();
        await playTTS(acc);
        playChime('them');
      }
    } else if (!wantVoice) {
      // ---- 文字回复（原有逻辑）----
      history.push({ role: 'assistant', content: acc, ts: assistantTs, replyTo: rep || null });
      lastAssistantIndex = history.length - 1; saveHistory();
      if (bubble && bubble.parentNode) bubble.innerHTML = esc(acc);
      playChime('them');   // 收到 TA 消息：叮咚提示
    }
    // 公共收尾：两种模式都执行一次（情绪光晕 / 记忆抽取）
    if (++_turnCount % 4 === 0) { try { apiPost('/api/extract-memory', { userId: UID }); } catch (e) {} }
    applyMood(detectMood(acc));
  }
  else { if (bubble && bubble.parentNode) bubble.remove(); }   // 空回复：清掉残留空气泡
  currentAssistantBubble = null;
}

function showError(msg) {
  streaming = false; setStatus('error');
  if (currentAssistantBubble) { currentAssistantBubble.remove(); currentAssistantBubble = null; }
  renderMessage('them', '⚠️ ' + msg);
}

// ---- 主动消息（SSE，按 userId） ----
function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {}
}
function isAppHidden() { return $('app').style.display === 'none'; }
function updateUnreadBadge() {
  const b = $('petBadge');
  if (!b) return;
  if (unread > 0) { b.hidden = false; b.textContent = unread > 99 ? '99+' : String(unread); }
  else { b.hidden = true; }
}
function bumpUnread() { unread++; try { localStorage.setItem('companion_unread_' + UID, String(unread)); } catch {} updateUnreadBadge(); }
function clearUnread() { unread = 0; try { localStorage.setItem('companion_unread_' + UID, '0'); } catch {} updateUnreadBadge(); }

const es = new EventSource(q('/api/events'));
es.onmessage = (ev) => {
  try {
    const obj = JSON.parse(ev.data);
    if (obj.type === 'proactive' && obj.text) {
      const text = obj.text;
      const pts = obj.ts || Date.now();
      // 去重：离线补发的消息可能既在历史里又被推送，避免重复渲染
      if (history.some(m => (m.ts || 0) === pts && m.content === text)) return;
      history.push({ role: 'assistant', content: text, ts: pts });
      saveHistory();
      renderMessage('assistant', text, pts).classList.add('proactive');
      applyMood(detectMood(text));
      markUnreadNewMessage();
      petBubble.textContent = text.slice(0, 40);
      if (obj.offline) scrollBottom(); // 离线补发的：打开时直接定位到最后（最新）
      // 主动/离线消息：按你的要求默认不朗读，只以文字或红点呈现
      if (isAppHidden()) bumpUnread();
      else if (!obj.offline) { playChime('them'); notify(userCfg?.companionName || 'TA', text); } // App 打开时响一声"叮咚"；离线补发的静默入聊，不弹通知也不响
    } else if (obj.type === 'reminder' && obj.text) {
      const text = '⏰ 提醒你：' + obj.text;
      const pts = obj.at || Date.now();
      history.push({ role: 'assistant', content: text, ts: pts, reminder: true });
      saveHistory();
      const el = renderMessage('assistant', text, pts); if (el) el.classList.add('reminder');
      markUnreadNewMessage();
      if (isAppHidden()) bumpUnread();
      else { playChime('them'); if ('Notification' in window && Notification.permission === 'granted') notify(userCfg?.companionName || 'TA', obj.text); }
    }
  } catch {}
};

// ---- 浮动小窗：收起 / 展开 / 拖拽 ----
$('minimizeBtn').addEventListener('click', () => {
  $('app').style.display = 'none';
  petEl.hidden = false;
  petBubble.textContent = '在呢～点我打开聊天';
});
// 移动端顶栏「‹」返回：同「收起」逻辑（收起为小窗）
if ($('mobileBack')) $('mobileBack').addEventListener('click', () => {
  $('app').style.display = 'none';
  petEl.hidden = false;
  petBubble.textContent = '在呢～点我打开聊天';
});
$('petOpen').addEventListener('click', () => {
  petEl.hidden = true;
  $('app').style.display = 'flex';
  clearUnread();
});
$('petClose').addEventListener('click', () => { petEl.hidden = true; });

let drag = null;
$('petHead').addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, l: petEl.offsetLeft, t: petEl.offsetTop };
  petEl.setPointerCapture(e.pointerId);
});
$('petHead').addEventListener('pointermove', (e) => {
  if (!drag) return;
  petEl.style.left = (drag.l + e.clientX - drag.x) + 'px';
  petEl.style.top = (drag.t + e.clientY - drag.y) + 'px';
  petEl.style.right = 'auto'; petEl.style.bottom = 'auto';
});
$('petHead').addEventListener('pointerup', () => { drag = null; });

// ---- 通知授权 ----
$('notifBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('当前浏览器不支持通知'); return; }
  const p = await Notification.requestPermission();
  $('notifBtn').textContent = p === 'granted' ? '🔔 已开' : '🔔 通知';
});

// ---- 配音静音开关 ----
$('ttsToggle').addEventListener('click', () => {
  ttsMuted = !ttsMuted;
  localStorage.setItem('companion_tts_muted', ttsMuted ? '1' : '0');
  $('ttsToggle').textContent = ttsMuted ? '🔇 静音' : '🔊 配音';
});
function syncTtsToggle() { $('ttsToggle').textContent = ttsMuted ? '🔇 静音' : '🔊 配音'; }
syncTtsToggle();

// ---- 发送 ----
sendBtn.addEventListener('click', () => { primeAudio(); send(); });
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); primeAudio(); send(); } });
inputEl.addEventListener('input', () => { autoGrow(); updateCmdHint(); });
function updateCmdHint() {
  const h = $('cmdHint'); if (!h) return;
  const v = inputEl.value.trim();
  if (v.startsWith('/')) {
    const cmds = ['/help 帮助', '/tone 语气', '/mode 模式', '/think 思考', '/persona 身份', '/name 改名', '/mute 静音', '/remember 记住', '/forget 忘记', '/clear 清空', '/export 导出'];
    const kw = v.slice(1).toLowerCase();
    const match = cmds.filter(c => c.toLowerCase().indexOf(kw) !== -1);
    h.innerHTML = '命令：' + (match.length ? match.join(' · ') : cmds.join(' · '));
    h.hidden = false;
  } else { h.hidden = true; }
}

// ===== 语音输入（微信桌面端形态：左侧 🎤 按钮切换「打字 / 按住说话」） =====
// 设计：点 🎤 进入语音模式 → 输入框变成「按住说话」长条；按住录音，松手用本地 Whisper 把语音转成文字填进输入框（语音转文字）。
// 再点 ⌨️ 切回打字。识别不联网、不需 Key，模型已打包进软件。
let micStream = null, mediaRecorder = null, audioChunks = [], recStart = 0;
// 录音状态机：解决 getUserMedia 异步导致的“松手早于麦克风打开”时序 bug
let _pressStart = 0, _pressStartY = 0, recState = 'idle', _pendingEnd = false, _pendingCancel = false, _slideCancel = false;
const micBtn = $('micBtn');
const voiceHold = $('voiceHold');
const inputWrap = $('inputWrap');
let voiceMode = false;
function blobToDataURL(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); }); }
function pickMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of c) { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t; }
  return '';
}
async function startRecording() {
  if (mediaRecorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('⚠️ 此环境不支持麦克风录音'); return; }
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('⚠️ 无法访问麦克风：' + (e && e.message || e) + '（请在系统/应用设置里允许麦克风）'); return; }
  audioChunks = [];
  const mime = pickMime();
  try { mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream); }
  catch (e) { toast('⚠️ 录音初始化失败'); stopStream(); return; }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) audioChunks.push(e.data); };
  mediaRecorder.start();
  recStart = _pressStart || Date.now();
  document.body.classList.add('recording');
  if (micBtn) micBtn.classList.add('recording');
  if (voiceHold) { voiceHold.classList.add('recording'); voiceHold.textContent = '🎙️ 松手转文字 · 上滑取消'; }
  toast('🎤 正在录音');
}
function stopStream() { if (micStream) { micStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); micStream = null; } }
async function stopRecording(cancel) {
  if (!mediaRecorder) return { cancelled: true };
  const mr = mediaRecorder; mediaRecorder = null;
  document.body.classList.remove('recording');
  if (micBtn) micBtn.classList.remove('recording', 'cancel');
  if (voiceHold) { voiceHold.classList.remove('recording', 'cancel'); voiceHold.textContent = '🎤 按住 说话'; }
  const stopped = new Promise(res => { mr.onstop = res; });
  try { mr.stop(); } catch { stopStream(); }
  await stopped; stopStream();
  const duration = (Date.now() - recStart) / 1000;
  // 上滑取消 或 误触极短录音：丢弃
  if (cancel || duration < 0.6) {
    audioChunks = [];
    if (cancel) toast('已取消');
    else toast('⚠️ 太短了，没录到');
    return { cancelled: true };
  }
  const blob = new Blob(audioChunks, { type: mr.mimeType || 'audio/webm' });
  audioChunks = [];
  let dataUrl = '';
  try { dataUrl = await blobToDataURL(blob); } catch {}
  return { cancelled: false, transcript: '', url: dataUrl, duration, blob };
}
// 语音模式：隐藏输入框/发送键，显示「按住说话」长条；再点 🎤（变 ⌨️）切回打字
function enterVoiceMode() {
  if (voiceMode) return;
  voiceMode = true;
  inputEl.style.display = 'none';
  if (voiceHold) voiceHold.hidden = false;
  if (sendBtn) sendBtn.style.display = 'none';
  if (micBtn) { micBtn.textContent = '⌨️'; micBtn.title = '返回打字'; }
  if (inputWrap) inputWrap.classList.add('voice-mode');
}
function exitVoiceMode() {
  if (!voiceMode) return;
  voiceMode = false;
  if (voiceHold) voiceHold.hidden = true;
  inputEl.style.display = '';
  if (sendBtn) sendBtn.style.display = '';
  if (micBtn) { micBtn.textContent = '🎤'; micBtn.title = '语音输入（按住说话，松手转文字）'; }
  if (inputWrap) inputWrap.classList.remove('voice-mode');
}
if (micBtn) micBtn.addEventListener('click', () => { voiceMode ? exitVoiceMode() : enterVoiceMode(); });
function beginVoice() {
  if (recState !== 'idle') return;
  recState = 'starting';
  _pressStart = Date.now();
  _slideCancel = false;
  // 录音由本进程负责；识别上传后端 Node 进程跑 whisper（UI 不卡崩）
  startRecording().then(() => {
    recState = 'recording';
    if (_pendingEnd) { _pendingEnd = false; endVoice(_pendingCancel); }
  }).catch((err) => { recState = 'idle'; console.error('录音启动失败', err); });
}
async function endVoice(cancel) {
  if (recState === 'starting') { _pendingEnd = true; _pendingCancel = (cancel === true); return; }
  if (recState !== 'recording') return;
  recState = 'idle';
  const finalCancel = (cancel === true) || _slideCancel;
  const r = await stopRecording(finalCancel);
  if (r.cancelled) return;
  exitVoiceMode();
  // 录音上传后端离线识别（whisper，在 Node 进程推理，UI 不卡崩）
  let transcript = '';
  if (window.STT && window.STT.transcribeAudio) {
    try {
      toast('🔍 识别中…（首次约十几秒）');
      transcript = await window.STT.transcribeAudio(r.blob, (p) => { if (p && p.status) toast('🔍 ' + p.status); });
      if (transcript) { transcript = transcript.trim(); toast('✅ 已识别：' + transcript.substring(0, 30) + (transcript.length > 30 ? '…' : '')); }
      else { toast('⚠️ 未识别出文字（将只发语音）'); }
    } catch (e) {
      console.warn('[STT] 识别失败：', e);
      toast('⚠️ 识别失败：' + (e && e.message ? e.message : '未知错误'));
      transcript = '';
    }
  }
  if (!r.blob) { toast('⚠️ 语音数据丢失'); return; }
  // 把识别文字一起塞进 audio block 发出去，AI 那边就能看到具体内容
  draftBlocks = [{ type: 'audio', src: r.url, url: null, duration: r.duration, text: transcript || '' }];
  renderDraft();
  await send();
}
// 「按住说话」长条：按住录音，松手转文字
if (voiceHold) {
  voiceHold.addEventListener('pointerdown', (e) => { e.preventDefault(); _pressStartY = e.clientY; beginVoice(); });
  voiceHold.addEventListener('pointerup', () => { if (recState !== 'idle') endVoice(); });
  voiceHold.addEventListener('pointercancel', () => { if (recState !== 'idle') { _slideCancel = true; endVoice(true); } });
}
// 录音中上滑取消（跟手反馈）
window.addEventListener('pointermove', (e) => {
  if (recState !== 'recording') return;
  if (typeof _pressStartY === 'number' && (_pressStartY - e.clientY) > 80) {
    _slideCancel = true;
    if (micBtn) micBtn.classList.add('cancel');
    if (voiceHold) voiceHold.classList.add('cancel');
  } else {
    _slideCancel = false;
    if (micBtn) micBtn.classList.remove('cancel');
    if (voiceHold) voiceHold.classList.remove('cancel');
  }
});
window.addEventListener('pointerup', () => { if (recState === 'recording') endVoice(); });
window.addEventListener('pointercancel', () => { if (recState === 'recording') { _slideCancel = true; endVoice(true); } });
// 注：本地 Whisper 模型不再页面打开时后台预热（那会吃满渲染进程 CPU/内存导致整窗卡死）。
// 改为首次按住说话时才按需加载（见 endVoice 内的懒加载逻辑），加载期间有进度提示。
// 亲密手势按钮：点一下给 TA 一个动作，TA 会自然回应

// ===== 语音转文字（微信式）：发送前预览 + 已发语音转文字 + AI 随机语音回复 =====
function clearAudioDraft() { draftBlocks = draftBlocks.filter(b => b.type !== 'audio'); }

// 录音松手后的预览面板：可选「转文字发送」或「发送语音」（微信式）
let _voicePreviewEl = null;
function closeVoicePreview() { if (_voicePreviewEl) { _voicePreviewEl.remove(); _voicePreviewEl = null; } }
async function showVoicePreview(r) {
  closeVoicePreview();
  const hasText = !!(r.transcript && r.transcript.trim());
  const modal = document.createElement('div');
  modal.className = 'voice-preview';
  modal.innerHTML = `
    <div class="vp-sheet">
      <div class="vp-title">🎤 这条语音怎么发？</div>
      <div class="vp-trans" id="vpTrans">${hasText ? esc(r.transcript) : '<span class="vp-muted">暂未识别到文字（可直接发语音，或重录）</span>'}</div>
      <div class="vp-btns">
        <button class="vp-btn primary" id="vpText" ${hasText ? '' : 'disabled'}>📝 转文字发送</button>
        <button class="vp-btn" id="vpVoice">🎤 发送语音</button>
        <button class="vp-btn" id="vpRedo">↺ 重录</button>
        <button class="vp-btn ghost" id="vpCancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(modal); _voicePreviewEl = modal;
  const finish = (action) => {
    closeVoicePreview();
    if (action === 'text') { clearAudioDraft(); inputEl.value = r.transcript; autoGrow(); renderDraft(); send(); }
    else if (action === 'voice') {
      if (r.blob) { draftBlocks.push({ type: 'audio', src: r.url, url: null, duration: r.duration, text: '' }); renderDraft(); send(); }
      else toast('⚠️ 语音数据丢失');
    }
    else if (action === 'redo') { clearAudioDraft(); renderDraft(); enterVoiceMode(); beginVoice(); }
    else { clearAudioDraft(); renderDraft(); }
  };
  modal.querySelector('#vpText').addEventListener('click', () => finish('text'));
  modal.querySelector('#vpVoice').addEventListener('click', () => finish('voice'));
  modal.querySelector('#vpRedo').addEventListener('click', () => finish('redo'));
  modal.querySelector('#vpCancel').addEventListener('click', () => finish('cancel'));
  modal.addEventListener('click', (e) => { if (e.target === modal) finish('cancel'); });
}

// 把音频 blob 取时长（用于语音气泡显示秒数）
function audioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(); a.preload = 'metadata';
    a.onloadedmetadata = () => { const d = a.duration || 0; try { URL.revokeObjectURL(url); } catch {} resolve(d); };
    a.onerror = () => { try { URL.revokeObjectURL(url); } catch {} resolve(0); };
    a.src = url;
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} resolve(0); }, 8000);
  });
}
// 调用后端 /api/tts 把文本合成语音，返回 {dataUrl, duration}（失败返回 null）
async function synthesizeToDataUrl(text) {
  text = (text || '').trim(); if (!text) return null;
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: UID, text, voice: liveVoiceFromSelect(), sex: (userCfg && userCfg.persona) === 'boyfriend' ? 'boy' : 'girl' }) });
    const ct = r.headers.get('Content-Type') || '';
    if (!r.ok || ct.indexOf('audio') === -1) return null;
    const blob = await r.blob();
    const dataUrl = await blobToDataURL(blob);
    const dur = await audioDuration(blob);
    return { dataUrl, duration: dur };
  } catch { return null; }
}
// AI 以「语音气泡」形式回复（文字作为字幕，可点转文字/直接看）
function renderAssistantVoice(text, src, duration, ts) {
  const blocks = [{ type: 'audio', text: text || '', src: src || null, url: null, duration: duration || 0 }];
  const m = { ts, blocks, content: text || '' };
  return renderMessageBlocks('assistant', blocks, ts, m);
}
// 在气泡里显示/刷新转出来的文字
function showCaption(bubble, text) {
  let cap = bubble.querySelector('.transcript');
  if (!cap) { cap = document.createElement('div'); cap.className = 'bubble-text transcript'; bubble.appendChild(cap); }
  cap.innerHTML = esc(text);
}
// 已发语音「转文字」：有文字直接显示，无文字则本地识别后显示并持久化
async function transcribeMsg(wrap) {
  const m = wrap._msg;
  if (!m || !Array.isArray(m.blocks)) { toast('这条消息暂不支持转文字'); return; }
  const blk = m.blocks.find(b => b.type === 'audio');
  if (!blk) { toast('这条不是语音消息'); return; }
  const bubble = wrap.querySelector('.bubble'); if (!bubble) return;
  if (blk.text && blk.text.trim()) {
    const cap = bubble.querySelector('.transcript');
    if (cap) { cap.remove(); toast('已收起文字'); }
    else { showCaption(bubble, blk.text); toast('已显示文字'); }
    return;
  }
  toast('🔍 正在转文字…（首次需加载本地模型，可能几秒到几十秒）');
  try {
    let blob = null;
    if (blk.url) { const rr = await fetch(blk.url); if (rr.ok) blob = await rr.blob(); }
    if (!blob && blk.src && blk.src.indexOf('data:') === 0) { const rr = await fetch(blk.src); blob = await rr.blob(); }
    if (!blob) { toast('⚠️ 语音文件缺失，无法转文字'); return; }
    const text = await window.STT.transcribeAudio(blob, (p) => { if (p && p.status) toast('⏳ ' + p.status); });
    if (!text) { toast('⚠️ 没识别出文字（语音太短或太安静）'); return; }
    blk.text = text; showCaption(bubble, text); saveHistory();
    toast('✅ 已转成文字', 'success');
  } catch (e) { console.error('[转文字]失败', e); toast('⚠️ 转文字失败：' + (e && e.message ? e.message : (typeof e === 'string' ? e : '未知错误'))); }
}

// 启动时/每次渲染后：把历史里"已发但还没识别文字"的语音自动后台补转写（顺序串行，避免模型一次性被多任务压垮）
async function backfillSttForHistory() {
  if (!window.STT || !window.STT.transcribeAudio) return;
  // 找出历史里所有未转写的 user 语音气泡（DOM + 引用）
  const wraps = Array.from(messagesEl.querySelectorAll('.msg.user'));
  const pending = [];
  wraps.forEach((wrap) => {
    const m = wrap._msg;
    if (!m || !Array.isArray(m.blocks)) return;
    const blk = m.blocks.find(b => b.type === 'audio');
    if (!blk || blk.text) return;
    // 优先 url；没有 url 但有 dataURL src 也能转写
    if (!blk.url && (!blk.src || blk.src.indexOf('data:') !== 0)) return;
    pending.push({ wrap, m, blk });
  });
  if (!pending.length) return;
  // 确保本地模型已加载好再开始批量转写
  try { await window.STT.ensurePipeline(); } catch (e) { console.warn('[STT backfill] 模型预热失败，跳过：', e); return; }
  let done = 0;
  for (const item of pending) {
    try {
      let blob = null;
      if (item.blk.url) { try { const rr = await fetch(item.blk.url); if (rr.ok) blob = await rr.blob(); } catch {} }
      if (!blob && item.blk.src && item.blk.src.indexOf('data:') === 0) { const rr = await fetch(item.blk.src); blob = await rr.blob(); }
      if (!blob) { console.warn('[STT backfill] 无可读源，跳过 ts=' + item.m.ts); continue; }
      const text = await window.STT.transcribeAudio(blob);
      if (text && text.trim()) {
        item.blk.text = text.trim();
        // 在气泡下方插入字幕（避免重复）
        const bubble = item.wrap.querySelector('.bubble');
        if (bubble && !bubble.querySelector('.transcript')) {
          const cap = document.createElement('div'); cap.className = 'transcript'; cap.textContent = '🎤 ' + text.trim();
          bubble.appendChild(cap);
        }
        const trBtn = item.wrap.querySelector('.audio-transcribe');
        if (trBtn) trBtn.style.display = 'none';
        done++;
        saveHistory(); // 持久化
      }
    } catch (e) {
      console.warn('[STT backfill] 一条转写失败：', e);
    }
  }
  if (done > 0) console.info('[STT backfill] 已为 ' + done + ' 条历史语音补上文字');
}

// ---- 图片压缩（发图前用 canvas 缩放，避免巨图 base64 拖崩渲染/被请求体上限掐断）----
function compressImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) { resolve(null); return; }
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      try { canvas.getContext('2d').drawImage(img, 0, 0, cw, ch); } catch { resolve(null); return; }
      try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch { resolve(null); }
    };
    // 注意：失败时返回 null（绝不回退原始巨图，否则会把数 MB 的图顶进渲染进程导致 OOM 卡崩）
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
// ---- 视频抽帧（纯前端，无需 ffmpeg）：取若干时间点帧，压缩后返回 base64 数组 ----
async function extractVideoFrames(file, maxFrames = 4, maxEdge = 640) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url; video.muted = true; video.preload = 'auto';
  await new Promise((res, rej) => { video.onloadedmetadata = () => res(); video.onerror = () => rej(new Error('视频加载失败')); });
  const dur = video.duration || 1;
  const frames = [];
  for (let i = 0; i < maxFrames; i++) {
    const t = dur * (i + 0.5) / maxFrames;
    await new Promise((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); res(); };
      const timer = setTimeout(finish, 3000); // 单帧 seek 卡住则跳过，避免 UI 假死
      video.onseeked = () => {
        const scale = Math.min(1, maxEdge / Math.max(video.videoWidth || 1, video.videoHeight || 1));
        const cw = Math.max(1, Math.round((video.videoWidth || 1) * scale));
        const ch = Math.max(1, Math.round((video.videoHeight || 1) * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        try { canvas.getContext('2d').drawImage(video, 0, 0, cw, ch); frames.push(canvas.toDataURL('image/jpeg', 0.7)); } catch {}
        finish();
      };
      try { video.currentTime = Math.min(t, Math.max(0, dur - 0.02)); } catch { finish(); }
    });
  }
  URL.revokeObjectURL(url);
  return frames;
}
// 接收一张图片：把当前输入框文字作为一个 text block 先提交，再把图作为 image block 追加，
// 实现"文字[图]文字[图]"交错（仿 WorkBuddy/微信）。图已压缩，体积安全。
async function acceptImage(dataUrl) {
  const comp = await compressImage(dataUrl);
  if (!comp) { showError('图片解析失败，请重新截图后重试'); return; }
  commitTextBlock();
  draftBlocks.push({ type: 'image', src: comp, url: null });
  inputEl.value = ''; autoGrow();
  renderDraft();
  inputEl.focus();
  if (inputEl.dataset.prevPh === undefined) inputEl.dataset.prevPh = inputEl.placeholder;
  inputEl.placeholder = '已附图，可继续打字，回车发送 📎';
}

// ---- 发送图片/视频（📎 选图或视频 + Ctrl+V 粘贴截图直接发送） ----
// ---- 微信式「➕」附件折叠菜单：点开选 图片/视频（收起常驻的 📎，输入栏更干净） ----
const plusBtn = $('plusBtn');
const attachPop = $('attachPop');
if (plusBtn && attachPop) {
  plusBtn.addEventListener('click', (e) => { e.stopPropagation(); attachPop.hidden = !attachPop.hidden; });
  attachPop.querySelectorAll('.pop-item').forEach(b => {
    b.addEventListener('click', () => {
      const acc = b.dataset.accept === 'video' ? 'video/*' : 'image/*';
      $('imgInput').setAttribute('accept', acc);
      $('imgInput').click();
      attachPop.hidden = true;
    });
  });
  // 点菜单/按钮之外的地方自动收起
  document.addEventListener('click', (e) => {
    if (attachPop.hidden) return;
    if (!attachPop.contains(e.target) && e.target !== plusBtn) attachPop.hidden = true;
  });
}
$('imgInput').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.type && f.type.indexOf('video') === 0) {
    statusEl.textContent = '正在解析视频…';
    try {
      const frames = await extractVideoFrames(f, 4, 640);
      if (frames.length) {
        commitTextBlock();
        draftBlocks.push({ type: 'video', src: frames[0], frames, url: null }); // 首帧预览/历史缩略，frames 仅当轮视觉用
        inputEl.value = ''; autoGrow(); renderDraft(); inputEl.focus();
        statusEl.textContent = '在线 · 等你说话';
      }
    } catch (err) { showError('视频解析失败：' + err.message); }
  } else {
    const reader = new FileReader();
    reader.onload = () => { acceptImage(reader.result); };
    reader.readAsDataURL(f);
  }
});
// ---- 草稿（待发送消息的 blocks）：文字 + 图片 + 视频有序排列，支持一条消息多图多文字交错 ----
// 发送前在输入框上方实时预览已挂的图文块；每张图/段文字都可单独删除。
function clearDraft() {
  draftBlocks = [];
  renderDraft();
  // 复原占位符并清除标记（用 delete 而非置空，避免空串残留导致下次无法重新保存原始占位符）
  if (inputEl && inputEl.dataset.prevPh) { inputEl.placeholder = inputEl.dataset.prevPh; }
  if (inputEl) delete inputEl.dataset.prevPh;
}
function renderDraft() {
  const p = $('imgPreview');
  if (!p) return;
  p.innerHTML = '';
  if (!draftBlocks.length) { p.hidden = true; return; }
  p.hidden = false;
  draftBlocks.forEach((b, idx) => {
    const item = document.createElement('div');
    item.className = 'draft-block draft-' + b.type;
    if (b.type === 'image' || b.type === 'video') {
      const im = document.createElement('img');
      im.className = 'draft-thumb';
      im.src = b.src; im.alt = b.type === 'video' ? '视频' : '图片';
      item.appendChild(im);
      if (b.type === 'video') { const bd = document.createElement('div'); bd.className = 'draft-badge'; bd.textContent = '▶'; item.appendChild(bd); }
    } else if (b.type === 'audio') {
      const ic = document.createElement('span'); ic.className = 'draft-audio'; ic.textContent = '🎤 ' + (b.duration ? fmtDur(b.duration) : '语音'); item.appendChild(ic);
    } else {
      const tx = document.createElement('span');
      tx.className = 'draft-text'; tx.textContent = b.text;
      item.appendChild(tx);
    }
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'draft-del'; del.textContent = '✕';
    del.addEventListener('click', () => { draftBlocks.splice(idx, 1); renderDraft(); });
    item.appendChild(del);
    p.appendChild(item);
  });
}
// 把当前输入框里已输入的文字，作为一个 text block 提交进草稿（在插入图片/视频之前），
// 这样"先打字 → 插图 → 再打字 → 再插图"就能自然形成"文字[图]文字[图]"交错。
function commitTextBlock() {
  const t = inputEl.value.trim();
  if (t) draftBlocks.push({ type: 'text', text: t });
}
// 粘贴截图：只把图“挂”到输入框（显示预览），不自动发送。
// 与微信/QQ/WorkBuddy 一致——粘贴=附上图，用户可继续打字，回车或点发送才真正发出去。
// 这样也避免“一贴就触发上传+视觉识别+渲染”整条重链路导致卡顿/卡崩。
async function handleImagePaste(e) {
  try {
    // 焦点在设置/嘴巴弹窗内时，不拦截（避免粘贴文字时误触发）
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest('.modal')) return;
    const cd = e.clipboardData || window.clipboardData;

    // 1) DOM 路径：标准 PNG 截图（Win+Shift+S 等），优先从 items 或 files 取
    let file = null;
    if (cd && cd.items) {
      for (const it of cd.items) {
        if (it.type && it.type.indexOf('image') === 0) { file = it.getAsFile(); if (file) break; }
      }
    }
    if (!file && cd && cd.files && cd.files.length) {
      for (const f of cd.files) {
        if (f.type && f.type.indexOf('image') === 0) { file = f; break; }
      }
    }
    if (file) {
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => { acceptImage(reader.result); inputEl.focus(); };
      reader.readAsDataURL(file);
      return;
    }

    // 2) 兜底：微信/QQ 截图常以 DIB/位图入剪贴板，DOM 读不到，改走 Electron 原生剪贴板。
    //    只要原生剪贴板里有图就“附上”（不自动发）；无图（纯文字）时返回 null，文字照常粘贴。
    if (window.electronAPI && window.electronAPI.getClipboardImage) {
      let dataUrl = null;
      try { dataUrl = await window.electronAPI.getClipboardImage(); } catch (err) { /* 忽略 */ }
      if (dataUrl) {
        e.preventDefault();
        acceptImage(dataUrl);   // 仅附图，不发送
        inputEl.focus();        // 焦点回到输入框，方便直接打字
      }
    } else if (!window.electronAPI) {
      // preload 未注入：多半是没彻底退出重开（点 X 只是藏到托盘）。打开 DevTools 可看到此告警。
      console.warn('[粘贴] electronAPI 未注入，剪贴板原生读图不可用；请右键托盘图标→退出，再重开应用。');
    }
  } catch (err) {
    // 任何异常都不让“粘贴”把应用搞崩：静默忽略，文字仍可正常粘贴
    console.error('[粘贴处理异常]', err);
  }
}
document.addEventListener('paste', handleImagePaste);

// ---- 图片点击放大查看（微信式：点开看原图，点图片切换 1:1，点背景/×/ESC 关闭）----
const imgLightbox = $('imgLightbox');
const imgLightboxImg = $('imgLightboxImg');
const imgLightboxClose = $('imgLightboxClose');
function openLightbox(src) {
  imgLightboxImg.src = src;
  imgLightboxImg.classList.remove('zoomed');
  imgLightbox.classList.add('show');
}
function closeLightbox() {
  imgLightbox.classList.remove('show');
  imgLightboxImg.src = '';
  imgLightboxImg.classList.remove('zoomed');
}
messagesEl.addEventListener('click', (e) => {
  const t = e.target;
  if (t && t.classList && t.classList.contains('msg-img')) openLightbox(t.src);
});
// 点背景收起；点图片本身切换"适应屏幕 / 真实像素 1:1"
imgLightbox.addEventListener('click', (e) => {
  if (e.target === imgLightboxImg) imgLightboxImg.classList.toggle('zoomed');
  else closeLightbox();
});
if (imgLightboxClose) imgLightboxClose.addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && imgLightbox.classList.contains('show')) closeLightbox(); });

// ---- 测试声音（独立 TTS 自检，不依赖聊天） ----
// 走后端 /api/tts-test：启动后已后台预缓存全部音色，点一下即从磁盘读 wav 立即播放（秒播）。
async function playTestVoice(voice) {
  primeAudio();
  try {
    // 把当前界面 persona 带给后端，让"测试声音"按界面性别出声（女友=女声、男友=男声），
    // 与聊天配音共用同一套性别契约；后端 tts-test 路由据此定 sex，杜绝串性别。
    const persona = (userCfg && userCfg.persona) || 'girlfriend';
    const r = await fetch('/api/tts-test?voice=' + encodeURIComponent(voice || currentVoice()) + '&persona=' + encodeURIComponent(persona));
    const ct = r.headers.get('Content-Type') || '';
    if (!r.ok || ct.indexOf('audio') === -1) {
      let j = null; try { j = await r.json(); } catch {}
      toast('❌ ' + ((j && j.message) || ('HTTP ' + r.status)), 'error');
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    if (audioEl) { try { audioEl.pause(); } catch {} }
    audioEl = new Audio(url);
    audioEl.onended = () => { try { URL.revokeObjectURL(url); } catch {}; toast('✅ 测试声音播放完毕', 'success'); };
    audioEl.play().then(() => toast('🔊 正在播放测试声音…', 'success')).catch((e) => toast('❌ 播放被拒绝：' + (e && e.message || e), 'error'));
  } catch (e) {
    toast('❌ ' + (e && e.message || e), 'error');
  }
}
// 取「设置里当前下拉选中的音色」；设置未打开/下拉无值时回退到已保存配置
function liveVoiceFromSelect() {
  const sel = $('ttsVoice');
  const persona = (userCfg && userCfg.persona) || 'girlfriend';
  const wantGender = persona === 'boyfriend' ? 'male' : 'female';
  // 性别铁律：下拉当前值只有性别与当前角色一致才用，否则回退 currentVoice()（已按角色性别兜底）
  if (sel && sel.value && isValidVoiceId(sel.value) && voiceGender(sel.value) === wantGender) {
    return sel.value;
  }
  return currentVoice();
}
async function testTTS() {
  await playTestVoice(liveVoiceFromSelect());
}
$('testTts').addEventListener('click', testTTS);
// （浏览器自带语音试听已移除——全部统一用 sherpa-onnx 离线）

// ----（以下为已移除的死引擎试听/音色设计：微软 Edge / 百度 / MiniMax / Fish / 讯飞，均无法在当前网络/Key 下使用，已从设置面板删除）----

// ---- 设置 ----
const modal = $('settingsModal');
$('openSettings').addEventListener('click', async () => {
  const me = await apiGet(q('/api/me'));
  userCfg = me;
  $('persona').value = me.persona || 'girlfriend';
  $('companionNameInput').value = nameForPersona(me.persona, me);
  $('userNameInput').value = me.userName || '';
  $('toneInput').value = me.tone || '';
  // 大模型账号（API Key / 接口 / 模型）：优先用全局配置，其次用户级
  $('apiKeyInput').value = (me.apiKey || (globalCfg && globalCfg.apiKey) || '');
  $('apiBaseInput').value = (me.apiBase || (globalCfg && globalCfg.apiBase) || '');
  $('apiModelInput').value = (me.model || (globalCfg && globalCfg.model) || '');
  $('portraitGirlfriend').value = me.portraitGirlfriend || '';
  $('portraitBoyfriend').value = me.portraitBoyfriend || '';
  // 我的头像
  const up = me.userPortrait || '';
  $('userPortrait').value = up.startsWith('local:') ? '' : up;
  localUserPortrait.value = up.startsWith('local:') ? up : null;
  $('userPortraitLocal').textContent = up.startsWith('local:') ? '✅ 已使用本地图片（可重新选择替换）' : '';
  $('proactiveEnabled').checked = me.proactiveEnabled !== false;
  $('ttsEnabled').checked = me.ttsEnabled !== false;
  const vrm = $('voiceReplyMode'); if (vrm) vrm.value = (userCfg && userCfg.voiceReplyMode) || 'random';
  // TTS：用户已禁用一切引擎切换，UI 只剩语速。后端已锁定 sherpa-onnx，ttsProvider 字段不再需要保存。
  globalCfg = await apiGet('/api/global');
  const rateInput = $('ttsRate'); if (rateInput) rateInput.value = (userCfg && userCfg.ttsRate) ? parseFloat(userCfg.ttsRate) : 1.2;
  populateVoiceSelect(me.persona || 'girlfriend');
  const vsel = $('ttsVoice'); if (vsel) {
    // 用户原本存的 voice 若仍合法，按性别筛后可能不在新列表里（女/男分别只列一组）；不在就回退到性别默认
    const wantGender = (me.persona === 'boyfriend') ? 'male' : 'female';
    const allowed = voicesForGender(wantGender).map(([id]) => id);
    const stored = me.ttsVoice && isValidVoiceId(me.ttsVoice) ? me.ttsVoice : null;
    if (stored && allowed.includes(stored)) vsel.value = stored;
    else vsel.value = wantGender === 'male' ? 'zm_yunyang' : 'zf_xiaoxiao';
    // 在音色下拉上方放一行提示：当前 voice 与性别不符（极少数情况下例如之前手动改过）
    const warn = $('ttsVoiceWarn');
    if (warn) {
      const g = voiceGender(vsel.value);
      if (g && g !== wantGender) {
        warn.hidden = false;
        warn.innerHTML = `⚠️ 当前音色是<b>${g === 'male' ? '男声' : '女声'}</b>，但你选的角色是<b>${me.persona === 'boyfriend' ? '男友' : '女友'}</b>，听起来会别扭。`;
      } else { warn.hidden = true; }
    }
  }
  { const sel = $('autoIntervalMin'); const defV = (globalCfg && globalCfg.autoIntervalMin) ? String(globalCfg.autoIntervalMin) : '90'; const v = (me.autoIntervalMin != null && me.autoIntervalMin !== '' && !isNaN(me.autoIntervalMin)) ? String(me.autoIntervalMin) : defV; sel.value = [...sel.options].some(o => o.value === v) ? v : defV; }
  const pg = me.portraitGirlfriend || '';
  $('portraitGirlfriend').value = pg.startsWith('local:') ? '' : pg;
  localPortrait.girlfriend = pg.startsWith('local:') ? pg : null;
  $('portraitGirlfriendLocal').textContent = pg.startsWith('local:') ? '✅ 已使用本地图片（可重新选择替换）' : '';
  const pb = me.portraitBoyfriend || '';
  $('portraitBoyfriend').value = pb.startsWith('local:') ? '' : pb;
  localPortrait.boyfriend = pb.startsWith('local:') ? pb : null;
  $('portraitBoyfriendLocal').textContent = pb.startsWith('local:') ? '✅ 已使用本地图片（可重新选择替换）' : '';
  try { $('portraitGirlfriendFile').value = ''; $('portraitBoyfriendFile').value = ''; } catch {}
  modal.classList.add('open');
});
// 「试听一下声音」：用当前下拉选中的音色（未点保存也立即按新音色发声），走 /api/tts-test 即时播放
let _voiceTesting = false;
async function testCurrentVoice() {
  if (_voiceTesting) return;            // 防止连点 / 连改堆叠多次合成
  _voiceTesting = true;
  const btn = $('ttsTestCurrent');
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '🔊 生成中…'; }
  try {
    await playTestVoice(liveVoiceFromSelect());
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
    _voiceTesting = false;
  }
}
if ($('ttsTestCurrent')) $('ttsTestCurrent').addEventListener('click', testCurrentVoice);
// 改完音色（即使还没点保存）立即用新音色试听——所见即所听
if ($('ttsVoice')) $('ttsVoice').addEventListener('change', testCurrentVoice);
$('closeSettings').addEventListener('click', () => modal.classList.remove('open'));
// 「退出程序」：真正退出整个应用（窗口关 X 只是收进托盘保活）
if ($('quitApp')) $('quitApp').addEventListener('click', () => {
  if (window.electronAPI && window.electronAPI.quitApp) window.electronAPI.quitApp();
  else if (confirm('确认退出 AI 伴侣？')) { try { require('electron').app.quit(); } catch {} }
});
modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });

$('saveSettings').addEventListener('click', async () => {
  const prevPersona = userCfg && userCfg.persona;
  const selPersona = $('persona').value;
  const nameVal = $('companionNameInput').value.trim() || (selPersona === 'boyfriend' ? '阿澈' : '小念');
  userCfg = Object.assign(userCfg || {}, {
    persona: selPersona,
    companionName: nameVal,
    // 按角色各存各的名字：只改当前角色那个，另一个角色的名字保留不动
    companionNameGirlfriend: selPersona === 'boyfriend' ? (userCfg && userCfg.companionNameGirlfriend) : nameVal,
    companionNameBoyfriend: selPersona === 'boyfriend' ? nameVal : (userCfg && userCfg.companionNameBoyfriend),
    userName: $('userNameInput').value.trim() || '',
    apiBase: $('apiBaseInput').value.trim() || (userCfg && userCfg.apiBase) || (globalCfg && globalCfg.apiBase) || '',
    apiKey: $('apiKeyInput').value.trim() || (userCfg && userCfg.apiKey) || (globalCfg && globalCfg.apiKey) || '',
    model: $('apiModelInput').value.trim() || (userCfg && userCfg.model) || (globalCfg && globalCfg.model) || '',
    temperature: (userCfg && userCfg.temperature) != null ? userCfg.temperature : 0.9,
    tone: $('toneInput').value.trim(),
    portraitGirlfriend: ($('portraitGirlfriend').value.trim()) || localPortrait.girlfriend || '',
    portraitBoyfriend: ($('portraitBoyfriend').value.trim()) || localPortrait.boyfriend || '',
    userPortrait: ($('userPortrait').value.trim()) || localUserPortrait.value || '',
    customSystemPrompt: (userCfg && userCfg.customSystemPrompt) || '',
    proactiveEnabled: $('proactiveEnabled').checked,
    autoIntervalMin: $('autoIntervalMin').value.trim(),
    ttsEnabled: $('ttsEnabled').checked,
    voiceReplyMode: ($('voiceReplyMode') ? $('voiceReplyMode').value : 'random') || 'random',
    ttsRate: ($('ttsRate') ? parseFloat($('ttsRate').value) : 1.2) || 1.2,
    ttsVoice: ($('ttsVoice') ? $('ttsVoice').value : '') || ''
  });
  await saveUserCfg();
  // 切换了角色：先把当前(旧角色)聊天存盘，再加载新角色的聊天；否则只刷新头像/名字
  if (prevPersona && prevPersona !== userCfg.persona) {
    await saveHistory(prevPersona);
    await loadHistoryForPersona(userCfg.persona);
  }
  applyPersona(userCfg);
  // 间隔变化即时生效：让后端重新排期
  apiPost(q('/api/proactive/arm'), {});
  modal.classList.remove('open');
});

// 角色切换时，若当前音色性别不符，自动匹配该性别的默认音色（女生用女声、男生用男声）；
// 同时刷新音色下拉，让其只显示新角色对应性别的那一组
function autoMatchVoiceToPersona() {
  const persona = $('persona') ? $('persona').value : 'girlfriend';
  // 切角色时，名字输入框也跟着切换成该角色已存的名字
  const nmInput = $('companionNameInput');
  if (nmInput) nmInput.value = nameForPersona(persona, userCfg);
  populateVoiceSelect(persona);
  const wantGender = persona === 'boyfriend' ? 'male' : 'female';
  const sel = $('ttsVoice'); if (!sel) return;
  const cur = sel.value || '';
  const curGender = voiceGender(cur);
  if (curGender && curGender !== wantGender) {
    sel.value = wantGender === 'male' ? 'zm_yunyang' : 'zf_xiaoxiao';
  } else if (!cur) {
    sel.value = wantGender === 'male' ? 'zm_yunyang' : 'zf_xiaoxiao';
  }
  // 同步刷新"音色与性别不符"提示
  const warn = $('ttsVoiceWarn');
  if (warn) {
    const g = voiceGender(sel.value);
    if (g && g !== wantGender) {
      warn.hidden = false;
      warn.innerHTML = `⚠️ 当前音色是<b>${g === 'male' ? '男声' : '女声'}</b>，但你选的角色是<b>${persona === 'boyfriend' ? '男友' : '女友'}</b>，听起来会别扭。`;
    } else { warn.hidden = true; }
  }
}
if ($('persona')) $('persona').addEventListener('change', autoMatchVoiceToPersona);

// ---- 本地图片上传：读为 base64 传给后端保存，并以 local: 引用 ----
function uploadPortrait(fileInputId, persona) {
  const input = $(fileInputId);
  const file = input.files && input.files[0];
  if (!file) { toast('请先选择一张图片', 'error'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('图片太大，请选 8MB 以内', 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const full = reader.result; // data:image/...;base64,xxxx
      const m = full.match(/^data:(.+?);base64,(.*)$/);
      if (!m) { toast('图片格式不支持', 'error'); return; }
      const ext = (m[1].split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
      toast('正在上传图片…');
      apiPost('/api/portrait/upload', { userId: UID, persona, ext, data: m[2] }).then(r => {
        if (r && r.ok) {
          toast('✅ 图片已设置，重新打开看效果', 'success');
          // 记录本地引用，避免保存设置时被空 URL 覆盖
          localPortrait[persona] = 'local:' + persona + '_upload.' + ext;
          const key = persona === 'boyfriend' ? 'portraitBoyfriend' : 'portraitGirlfriend';
          userCfg = Object.assign(userCfg || {}, { [key]: localPortrait[persona] });
          // 立即刷新立绘
          const src = q('/api/portrait?persona=' + persona) + '&t=' + Date.now();
          charImg.src = src; petImg.src = src;
          if (persona === 'boyfriend') $('portraitBoyfriendLocal').textContent = '✅ 已使用本地图片（可重新选择替换）';
          else $('portraitGirlfriendLocal').textContent = '✅ 已使用本地图片（可重新选择替换）';
        } else {
          toast('❌ ' + ((r && r.message) || '上传失败'), 'error');
        }
      });
    } catch (e) { toast('❌ 读取图片失败', 'error'); }
  };
  reader.readAsDataURL(file);
}
$('portraitGirlfriendFile').addEventListener('change', () => uploadPortrait('portraitGirlfriendFile', 'girlfriend'));
$('portraitBoyfriendFile').addEventListener('change', () => uploadPortrait('portraitBoyfriendFile', 'boyfriend'));
// 清除自定义图片：置空引用，回退到精选图集
function clearPortrait(persona, fieldId, localId) {
  const key = persona === 'boyfriend' ? 'portraitBoyfriend' : 'portraitGirlfriend';
  localPortrait[persona] = null;
  userCfg = Object.assign(userCfg || {}, { [key]: '' });
  saveUserCfg();
  $(fieldId).value = '';
  $(localId).textContent = '';
  const src = q('/api/portrait?persona=' + persona) + '&t=' + Date.now();
  charImg.src = src; petImg.src = src;
  toast('已清除自定义图片，恢复精选图', 'success');
}
$('clearGirlfriend').addEventListener('click', () => clearPortrait('girlfriend', 'portraitGirlfriend', 'portraitGirlfriendLocal'));
$('clearBoyfriend').addEventListener('click', () => clearPortrait('boyfriend', 'portraitBoyfriend', 'portraitBoyfriendLocal'));

// ---- 用户自己的头像：上传 / 清除 / 应用 ----
function uploadUserPortrait(fileInputId) {
  const input = $(fileInputId);
  const file = input.files && input.files[0];
  if (!file) { toast('请先选择一张图片', 'error'); return; }
  if (file.size > 8 * 1024 * 1024) { toast('图片太大，请选 8MB 以内', 'error'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const full = reader.result;
      const m = full.match(/^data:(.+?);base64,(.*)$/);
      if (!m) { toast('图片格式不支持', 'error'); return; }
      const ext = (m[1].split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
      toast('正在上传头像…');
      apiPost('/api/portrait/upload', { userId: UID, who: 'user', ext, data: m[2] }).then(r => {
        if (r && r.ok) {
          localUserPortrait.value = 'local:user_upload.' + ext;
          userCfg = Object.assign(userCfg || {}, { userPortrait: localUserPortrait.value });
          $('userPortraitLocal').textContent = '✅ 已使用本地图片（可重新选择替换）';
          $('userPortrait').value = '';
          applyUserPortrait();
          toast('✅ 头像已设置', 'success');
        } else {
          toast('❌ ' + ((r && r.message) || '上传失败'), 'error');
        }
      });
    } catch (e) { toast('❌ 读取图片失败', 'error'); }
  };
  reader.readAsDataURL(file);
}
function clearUserPortrait() {
  localUserPortrait.value = null;
  userCfg = Object.assign(userCfg || {}, { userPortrait: '' });
  saveUserCfg();
  $('userPortrait').value = '';
  $('userPortraitLocal').textContent = '';
  applyUserPortrait();
  toast('已清除我的头像，恢复默认「我」', 'success');
}
$('userPortraitFile').addEventListener('change', () => uploadUserPortrait('userPortraitFile'));
$('clearUserPortrait').addEventListener('click', clearUserPortrait);

// ---- 嘴巴定位：在照片上点一下嘴巴位置，说话时就在那张嘴张合 ----
const mouthModal = $('mouthModal');
let mouthDraft = Object.assign({}, DEFAULT_MOUTH);
function renderMouthMark() {
  const mk = $('mouthMark');
  mk.style.left = mouthDraft.x + '%';
  mk.style.top = mouthDraft.y + '%';
  mk.style.width = mouthDraft.w + '%';
  mk.style.height = mouthDraft.h + '%';
}
$('locateMouth').addEventListener('click', () => {
  $('mouthPickImg').src = charImg.src || '';
  const m = (userCfg && userCfg.mouth) || currentMouth || DEFAULT_MOUTH;
  mouthDraft = { x: m.x, y: m.y, w: m.w, h: m.h };
  $('mouthW').value = m.w; $('mouthH').value = m.h;
  renderMouthMark();
  mouthModal.classList.add('open');
});
$('mouthPick').addEventListener('click', (e) => {
  const rect = $('mouthPick').getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 100;
  const y = ((e.clientY - rect.top) / rect.height) * 100;
  mouthDraft.x = Math.max(2, Math.min(98, x));
  mouthDraft.y = Math.max(2, Math.min(98, y));
  renderMouthMark();
});
$('mouthW').addEventListener('input', () => { mouthDraft.w = +$('mouthW').value; renderMouthMark(); });
$('mouthH').addEventListener('input', () => { mouthDraft.h = +$('mouthH').value; renderMouthMark(); });
$('mouthSave').addEventListener('click', () => {
  userCfg = Object.assign(userCfg || {}, { mouth: { x: mouthDraft.x, y: mouthDraft.y, w: mouthDraft.w, h: mouthDraft.h } });
  saveUserCfg();
  applyMouth(mouthDraft);
  mouthModal.classList.remove('open');
  toast('✅ 嘴巴已定位，说话时 TA 的嘴会动啦', 'success');
});
$('mouthCancel').addEventListener('click', () => mouthModal.classList.remove('open'));
$('mouthClose').addEventListener('click', () => mouthModal.classList.remove('open'));
mouthModal.addEventListener('click', e => { if (e.target === mouthModal) mouthModal.classList.remove('open'); });

$('pingProactive').addEventListener('click', () => { apiPost(q('/api/proactive')); modal.classList.remove('open'); });
$('clearChat').addEventListener('click', () => {
  history = []; saveHistory(undefined, true); messagesEl.innerHTML = ''; lastDateLabel = null;
  const cfg = userCfg;
  addSystemHint(`对话已清空。我是${cfg.companionName}，${cfg.persona === 'girlfriend' ? '以后请多关照呀💕' : '以后罩着你🤍'}`);
});

// ---- 旧用户聊天导入：扫一遍 users/，若有非当前用户的非空历史，弹个一次性提示 ----
async function maybeOfferLegacyImport() {
  try {
    const r = await apiGet(q('/api/history/legacy-scan'));
    if (!r || !r.ok || !r.legacy || !r.legacy.length) return;
    const total = r.legacy.reduce((s, x) => s + x.girlfriend + x.boyfriend, 0);
    if (total <= 0) return;
    // 已经显示过就不再问（用 localStorage 标记当前 userId）
    const flag = 'companion_legacy_offered_' + UID;
    if (localStorage.getItem(flag)) return;
    localStorage.setItem(flag, '1');
    const ok = window.confirm(`检测到这台机器上其他用户桶里还有 ${total} 条聊天（女友 ${r.legacy.reduce((s,x)=>s+x.girlfriend,0)} / 男友 ${r.legacy.reduce((s,x)=>s+x.boyfriend,0)}）。\n\n要不要导入到当前用户下？\n（已存在的内容会按「时间戳 + 角色」去重，不会重复）`);
    if (!ok) return;
    const imp = await apiPost(q('/api/history/import-legacy'), {});
    if (imp && imp.ok) {
      const n = imp.imported || 0;
      toast(n > 0 ? `✅ 已合并 ${n} 条旧聊天记录` : '没有可导入的新内容', n > 0 ? 'success' : 'error');
      // 重新加载当前角色的聊天
      await loadHistoryForPersona((userCfg && userCfg.persona) || 'girlfriend');
    } else {
      toast('导入失败：' + ((imp && imp.message) || ''), 'error');
    }
  } catch (e) { console.warn('legacy import:', e && e.message); }
}

// ---- 注意：原先的 Service Worker 用 cache-first 策略，
// 会把 index.html / app.js / styles.css 缓存到磁盘，
// 导致改了前端代码后界面一直不更新。桌面应用本地服务常驻、无需离线缓存，
// 故已彻底移除 SW 注册，避免"改动不生效"的问题。 ----

// ---- 启动 ----
(async () => {
  globalCfg = await apiGet('/api/global');
  userCfg = await apiGet(q('/api/me'));
  applyPersona(userCfg);
  applyUserPortrait();
  // 按当前角色加载对应的聊天记录（女友/男友各自独立）
  await loadHistoryForPersona((userCfg && userCfg.persona) || 'girlfriend');
  // 启动后异步扫一下旧用户聊天，有就问是否导入
  setTimeout(maybeOfferLegacyImport, 800);
  // 首次打开引导：没有配置任何 Key 时，强制填写（各用户各填各的，互不影响）
  const hasKey = (globalCfg && globalCfg.hasKey) || (userCfg && userCfg.apiKey && userCfg.apiKey.trim());
  if (!hasKey) {
    try { $('onboardModal').classList.add('open'); } catch {}
  }
  if ('Notification' in window && Notification.permission === 'granted') $('notifBtn').textContent = '🔔 已开';
  // 氛围随时间变化（每小时刷新一次）
  applyAmbiance();
  setInterval(applyAmbiance, 3600 * 1000);
})();

// 首次引导「开始使用」：校验 Key 非空并保存（全局 + 用户级），关闭引导
(function setupOnboard() {
  const start = $('onboardStart');
  if (!start) return;
  start.addEventListener('click', async () => {
    const key = ($('onboardApiKey').value || '').trim();
    const err = $('onboardErr');
    if (!key) { err.textContent = '⚠️ 必须先填 API Key 才能和 TA 聊天哦'; err.style.display = 'block'; return; }
    err.style.display = 'none';
    const base = ($('onboardApiBase').value || '').trim();
    const model = ($('onboardApiModel').value || '').trim();
    const name = ($('onboardUserName').value || '').trim();
    try {
      await apiPost('/api/global', { apiKey: key, apiBase: base, model });
      userCfg = Object.assign(userCfg || {}, { apiKey: key, apiBase: base, model: model });
      if (name) userCfg.userName = name;
      await saveUserCfg();
      globalCfg = await apiGet('/api/global');
      $('onboardModal').classList.remove('open');
      toast('✅ 配置完成，开始和 TA 聊天吧～', 'success');
    } catch (e) {
      err.textContent = '❌ 保存失败：' + (e && e.message ? e.message : e);
      err.style.display = 'block';
    }
  });
})();

// ---- 全局兜底：任何未捕获异常 / 未处理 Promise 拒绝都显示在界面，绝不悄悄整窗崩掉 ----
// 之前"一发消息整窗消失"往往就是某个边角异常无兜底被直接带走；现在至少把原因摆在眼前。
window.addEventListener('error', (ev) => {
  console.error('[全局错误]', ev.error || ev.message);
  try { showError('程序出错：' + (ev.message || '未知错误')); } catch {}
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason; console.error('[未处理 Promise 拒绝]', r);
  try { showError('异步出错：' + (r && r.message ? r.message : String(r))); } catch {}
});

// ---- 可拖拽分隔条：调节「图片区（立绘）」与「对话区」的占比（桌面左右 / 窄窗上下） ----
// 拖动记忆比例到 localStorage，缩放窗口时按比例重算；比例仅在你手动拖过之后才生效，不影响默认布局。
(function setupSplitter() {
  const row = document.querySelector('.main-row');
  const split = $('splitter');
  const stage = $('stage');
  if (!row || !split || !stage) return;
  const SPLIT_KEY = 'companion_split_ratio';
  let ratio = parseFloat(localStorage.getItem(SPLIT_KEY));
  const isCol = () => getComputedStyle(row).flexDirection === 'column';
  function apply() {
    if (!(ratio > 0)) return;
    const size = (isCol() ? row.clientHeight : row.clientWidth) * ratio;
    stage.style.flex = '0 0 ' + size + 'px';
    stage.style.maxHeight = 'none';   // 允许你拉到比默认更大
  }
  function clampSize(s) {
    const total = isCol() ? row.clientHeight : row.clientWidth;
    const max = total - 100 - 7;       // 给对话区留至少 100px
    return Math.max(120, Math.min(s, max));
  }
  let dragging = false, startPos = 0, startSize = 0;
  split.addEventListener('mousedown', (e) => {
    dragging = true; startPos = isCol() ? e.clientY : e.clientX;
    startSize = isCol() ? stage.offsetHeight : stage.offsetWidth;
    split.classList.add('dragging');
    document.body.style.cursor = isCol() ? 'row-resize' : 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cur = isCol() ? e.clientY : e.clientX;
    const delta = cur - startPos;
    // 桌面：图片在右，左拖(delta<0)→图片变大；窄窗：图片在上，下拖(delta>0)→图片变大
    const ns = isCol() ? startSize + delta : startSize - delta;
    stage.style.flex = '0 0 ' + clampSize(ns) + 'px';
    stage.style.maxHeight = 'none';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; split.classList.remove('dragging'); document.body.style.cursor = '';
    const total = isCol() ? row.clientHeight : row.clientWidth;
    const curSize = isCol() ? stage.offsetHeight : stage.offsetWidth;
    ratio = (curSize / total) || ratio;
    try { localStorage.setItem(SPLIT_KEY, String(ratio)); } catch {}
  });
  window.addEventListener('resize', () => { if (ratio > 0) apply(); });
  apply();
})();

