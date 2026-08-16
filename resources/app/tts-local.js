'use strict';
// 配音引擎：仅 ChatTTS（GitHub 2noise/ChatTTS，PyTorch，专为 LLM 对话助手训练，
// 自然度/口语感远超 Kokoro 与 MeloTTS，无方言，原生支持 [laugh] 笑声 / [uv_break] 停顿，标准普通话）。
// 以「常驻子进程」方式调用 chattts/chattts_synth.py —— 模型随后端启动加载一次常驻内存，之后每句合成，
// 配合 skip_refine_text 与动态 max_new_token，单句 ~2-4s。绝不回退任何别的引擎（无 kokoro/sherpa/系统语音）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

// 可选音色（设置面板「TA 的声音」按性别分组展示）。音色 id -> ChatTTS 说话人种子在 chattts_synth.py 的 VOICE_SEEDS。
const CHATTTS_VOICES = {
  'zf_xiaoxiao': { gender: 'female', label: '晓晓 · 温柔甜美' },
  'zf_xiaoni':   { gender: 'female', label: '小妮 · 清脆俏皮' },
  'zm_yunyang':  { gender: 'male',   label: '云扬 · 沉稳磁性' },
  'zm_yunjian':  { gender: 'male',   label: '云坚 · 阳光青年' },
  'zm_yunxi':    { gender: 'male',   label: '云曦 · 清爽少年' },
  'zm_yunxia':   { gender: 'male',   label: '云夏 · 温柔暖男' },
};
const DEFAULT_VOICE_BY_SEX = { girl: 'zf_xiaoxiao', boy: 'zm_yunyang' };
const TEST_PHRASE = '你好呀，我是你的 AI 伴侣，今天想和你聊点什么呢？';

function defaultVoiceFor(sex) {
  return sex === 'boy' ? DEFAULT_VOICE_BY_SEX.boy : DEFAULT_VOICE_BY_SEX.girl;
}
function isValidVoice(v) {
  return !!(v && CHATTTS_VOICES[v]);
}

// ================= ChatTTS 引擎（唯一引擎，自然对话，PyTorch 常驻子进程） =================
// 专为「LLM 对话助手」训练的离线开源 TTS：自然度/口语感远超 Kokoro 与 MeloTTS，无方言，
// 原生支持 [laugh] 笑声 / [uv_break] 停顿。模型约 1.5GB，冷加载数秒，故做成常驻子进程
// （后端启动拉起，模型常驻内存），之后每句亚秒级~数秒合成。
const CHATTTS_DIR = path.join(__dirname, 'chattts');
const CHATTTS_SCRIPT = path.join(CHATTTS_DIR, 'chattts_synth.py');
let chatttsProc = null;
let chatttsPending = new Map();
let chatttsSeq = 0;
let chatttsStarting = false;

function chatttsPython() {
  const rt = path.join(__dirname, 'chattts_runtime', 'python', 'python.exe');
  if (fs.existsSync(rt)) return rt;
  return 'python';
}
function chatttsAvailable() {
  const rt = path.join(__dirname, 'chattts_runtime', 'python', 'python.exe');
  return fs.existsSync(CHATTTS_SCRIPT) && fs.existsSync(rt);
}
function chatttsStart() {
  // 若常驻子进程已崩溃（exitCode 已置位 / 被杀），先清掉，让下次调用能重生，避免静默掉线
  if (chatttsProc && (chatttsProc.exitCode !== null || chatttsProc.killed)) {
    try { chatttsProc.kill(); } catch (e) {}
    chatttsProc = null;
  }
  if (chatttsProc || chatttsStarting) return chatttsProc;
  if (!chatttsAvailable()) return null;
  chatttsStarting = true;
  try {
    const py = chatttsPython();
    const p = spawn(py, [CHATTTS_SCRIPT], { cwd: CHATTTS_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const s = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!s) continue;
        try {
          const msg = JSON.parse(s);
          const cb = chatttsPending.get(msg.id);
          if (cb) { chatttsPending.delete(msg.id); cb(msg); }
        } catch (e) {}
      }
    });
    p.stderr.on('data', d => { const s = d.toString().trim(); if (s) console.error('[chattts] ' + s.slice(0, 200)); });
    p.on('exit', () => {
      chatttsProc = null; chatttsStarting = false;
      for (const [, cb] of chatttsPending) cb({ error: 'process exited' });
      chatttsPending.clear();
    });
    p.on('error', e => { chatttsProc = null; chatttsStarting = false; console.error('[chattts] spawn error:', e && e.message); });
    chatttsProc = p;
    chatttsStarting = false;
    return p;
  } catch (e) {
    chatttsStarting = false;
    console.error('[chattts] 启动失败:', e && e.message);
    return null;
  }
}
function chatttsSynthesize(text, voice, sex, mood, rate) {
  return new Promise((resolve) => {
    const p = chatttsStart();
    if (!p) return resolve(null);
    const id = 'r' + (++chatttsSeq);
    const timer = setTimeout(() => { chatttsPending.delete(id); resolve(null); }, 120000);
    chatttsPending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error || !msg.path || !fs.existsSync(msg.path) || fs.statSync(msg.path).size < 44) {
        console.error('[chattts] 合成失败:', msg.error || '空输出');
        return resolve(null);
      }
      try {
        const buf = fs.readFileSync(msg.path);
        try { fs.unlinkSync(msg.path); } catch (e) {}
        resolve({ buf, mime: 'audio/wav' });
      } catch (e) { resolve(null); }
    });
    try {
      if (!p.stdin || p.stdin.destroyed || p.killed || p.exitCode !== null) throw new Error('chattts proc dead');
      p.stdin.write(JSON.stringify({ id, text, voice: voice || '', sex: sex || 'girl', mood: mood || 'calm', rate: rate || '' }) + '\n');
    } catch (e) {
      // 进程断了：清掉死进程，重生一次再试（一次机会）
      clearTimeout(timer); chatttsPending.delete(id);
      try { if (chatttsProc) chatttsProc.kill(); } catch (_) {}
      chatttsProc = null;
      const p2 = chatttsStart();
      if (!p2) return resolve(null);
      const id2 = 'r' + (++chatttsSeq);
      const t2 = setTimeout(() => { chatttsPending.delete(id2); resolve(null); }, 120000);
      chatttsPending.set(id2, (msg) => {
        clearTimeout(t2);
        if (msg.error || !msg.path || !fs.existsSync(msg.path) || fs.statSync(msg.path).size < 44) return resolve(null);
        try { const buf = fs.readFileSync(msg.path); try { fs.unlinkSync(msg.path); } catch (_) {} resolve({ buf, mime: 'audio/wav' }); } catch (_) { resolve(null); }
      });
      try { p2.stdin.write(JSON.stringify({ id: id2, text, voice: voice || '', sex: sex || 'girl', mood: mood || 'calm', rate: rate || '' }) + '\n'); }
      catch (e2) { clearTimeout(t2); chatttsPending.delete(id2); resolve(null); }
    }
  });
}
function warmupChattts() {
  if (chatttsAvailable()) { try { chatttsStart(); } catch (e) { console.error('[chattts] 预热失败:', e && e.message); } }
}

// ================= 合成主入口 =================
// 结构清洗（后端兜底）：去 markdown / 括号动作描写 / 符号 / 重复标点 / emoji。
// 前端 playTTS 已洗过一遍，这里防止「后台离线消息、直接 synthesize 的调用」把脏文本送进 ChatTTS
// 导致念"星号/括号"或复读。只动结构，不删中文，安全可重复调用。
function cleanForTTS(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]/g, '$1');
  t = t.replace(/`{1,3}/g, '').replace(/\*{1,3}/g, '').replace(/_{1,3}/g, '')
        .replace(/~{2,}/g, '').replace(/^\s{0,3}#{1,6}\s?/gm, '').replace(/^\s*>\s?/gm, '');
  t = t.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/【[^】]*】/g, '');
  t = t.replace(/[「」『』（）]/g, '');
  t = t.replace(/[<>@#&%+=/\\|~`*_\u00a9\u00ae\u2122]/g, ' ');
  t = t.replace(/[！]{2,}/g, '！').replace(/[？]{2,}/g, '？').replace(/[。]{2,}/g, '。')
        .replace(/[，、]{2,}/g, '，').replace(/\.{4,}/g, '...').replace(/\.{2,3}/g, '...');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u200b\u200e\u200f\ufeff\u00ad]/gu, '');
  t = t.replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[，。、！？\s]+/, '').replace(/[，。、！？\s]+$/, '');
  t = t.replace(/[^一-鿿0-9。！？，、；：\s]/g, ''); // 最终白名单：只留中文/数字/中文标点/空白
  return t;
}

async function synthesize(text, vcn, sex, mood, rate) {
  // 【最深防线】先跑一遍结构清洗（去 markdown/括号动作/符号/重复标点），再剥英文+语言元数据词；
  // 前端已洗过一遍，这里兜底（如后台离线消息未走前端）。
  let t = cleanForTTS(text || '');
  t = t.replace(/<\|[^|]*\|>/g, '')
        .replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, ' ')
        .replace(/(中文|英文|普通话|粤语|语言)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
  t = t.slice(0, 1000);
  if (!t || !/[一-鿿]/.test(t)) throw new Error('文本为空或不含中文');
  if (!chatttsAvailable()) throw new Error('ChatTTS 引擎未就绪（runtime 或脚本缺失）');
  const r = await chatttsSynthesize(t, vcn, sex, mood, rate);
  if (r && r.buf && r.buf.length > 44) return r;
  throw new Error('ChatTTS 合成失败（返回空音频）');
}

// 「测声音」按音色缓存：首次该音色现合成（ChatTTS 约 2-4s，仅一次），之后即时从缓存返回，
// 解决设置里切换对比音色时每次都等很久的问题。缓存随后端进程存活（窗口/托盘保活期间有效）。
const _testAudioCache = new Map(); // key: voice -> { buf, mime }
async function synthesizeTest(voice, sex) {
  // 缓存 key 必须带 sex：同一 voice id 在不同界面（persona）下 sex 不同会得到不同性别音频，
  // 不带 sex 会让"女友界面试过的女声缓存"被男友界面误用，导致串性别。
  const key = (voice || 'default') + ':' + (sex || 'girl');
  if (_testAudioCache.has(key)) return _testAudioCache.get(key);
  const r = await synthesize(TEST_PHRASE, voice, sex, 'calm');
  if (r && r.buf && r.buf.length > 44) _testAudioCache.set(key, r);
  return r;
}

module.exports = {
  synthesize, CHATTTS_VOICES, DEFAULT_VOICE_BY_SEX, TEST_PHRASE,
  defaultVoiceFor, isValidVoice, warmupChattts,
  chatttsAvailable, chatttsSynthesize, synthesizeTest,
};
