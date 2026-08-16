'use strict';
// AI 伴侣 · 零依赖后端（多用户隔离版）
// 设计：每个浏览器/设备自动获得一个 userId，各自拥有独立的 TA、历史、语气、立绘。
// 大模型 Key 双轨：主人可在 /api/global 配置全局 Key（朋友免费用），用户也能在 /api/me 填自己的 Key 覆盖。
// 部署：运行在服务器或本机，电脑桌面壳( Electron )与安卓网页共用同一份数据。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  synthesize, CHATTTS_VOICES, DEFAULT_VOICE_BY_SEX, TEST_PHRASE,
  warmupChattts, chatttsAvailable, chatttsSynthesize, synthesizeTest,
} = require('./tts-local'); // 本地离线 TTS（仅 ChatTTS 引擎）

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// 数据目录：打包后程序目录(__dirname)在 asar/只读区，不可写，必须落到用户可写位置(由 main.js 注入 DATA_DIR)
const DATA = process.env.DATA_DIR ? path.join(process.env.DATA_DIR) : path.join(ROOT, 'data');
const USERS_DIR = path.join(DATA, 'users');
const PORTRAITS = path.join(DATA, 'portraits');
const IMAGES_DIR = path.join(DATA, 'images'); // 聊天图片持久化目录（重启后仍能重现原图）
const AUDIO_DIR = path.join(DATA, 'audio');   // 语音消息持久化目录（录音 .webm 等）
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(USERS_DIR, { recursive: true });
fs.mkdirSync(PORTRAITS, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// 进程级兜底：任何未捕获异常 / 未处理 Promise 拒绝都写进日志，绝不让整个 Electron 主进程（连带窗口）被直接带走。
// 作用：之前"一发消息整窗崩"往往就是某个边角异常无兜底，现在至少会记下原因，且窗口大概率还能继续用。
const ERROR_LOG = path.join(DATA, 'error.log');
function logError(where, e) {
  try {
    const line = `[${new Date().toISOString()}] ${where}: ${(e && e.stack) ? e.stack : String(e)}\n`;
    fs.appendFileSync(ERROR_LOG, line);
  } catch {}
}
process.on('uncaughtException', (e) => { logError('uncaughtException', e); });
process.on('unhandledRejection', (e) => { logError('unhandledRejection', e); });

const PORT = process.env.PORT || 4000;
const CONFIG_FILE = path.join(DATA, 'config.json');

const DEFAULT_CONFIG = {
  apiBase: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4-flash',
  temperature: 0.9,
  proactiveEnabled: true,
  autoIntervalMin: 90,      // 自动主动发消息的间隔（分钟，默认 1.5 小时）；用户/设置可在 30分钟~14天 之间调整
  adminToken: '',           // 空 = 本地自用，任何人可改全局；部署分享前请设一个密码
  personaTemplate: 'girlfriend',
  // 配音：主引擎 = sherpa-onnx 离线中文 TTS（ONNX，不依赖 Python，免费无Key，随软件分发）。
  //   需先双击「下载SherpaTTS.bat」把 exe + 中文模型拉到 resources/app/sherpa/。
  //   无模型时自动回退：Windows 系统中文语音（绝不回退任何在线/付费引擎）。
  ttsProvider: 'sherpa',
  // 可选：用户自定义声线（sherpa 默认男女声由 sid 区分；如需定制音色可后续接入参考音频，无需改代码）
  ttsVoiceGirl: '',
  ttsVoiceBoy: '',
};
const DEFAULT_USER = {
  persona: 'girlfriend',
  companionName: '小念',         // 旧字段：兼容历史，现仅作兜底；按角色分存见下两行
  companionNameGirlfriend: '小念',   // 女友名字（默认小念）
  companionNameBoyfriend: '阿澈',    // 男友名字（默认阿澈，与女友区分，可改）
  userName: '',
  apiBase: '',              // 留空则回退到全局
  apiKey: '',               // 留空则回退到全局
  model: '',                // 留空则回退到全局
  temperature: null,        // 留空则回退到全局
  tone: '',
  mode: 'immersive',        // 相处模式：daily(日常) | immersive(沉浸) | deep(深度)
  deepThink: true,          // 默认开启"认真思考"：先内心梳理再回复，更走心、更少套话
  memories: [],             // 跨会话记住的关于用户/你们之间的事（/remember 写入，手动）
  autoMemories: [],         // 自动从对话里抽取并记住的关于用户的事（后台抽取，无需手动）
  customSystemPrompt: '',
  portraitGirlfriend: '',
  portraitBoyfriend: '',
  userPortrait: '',        // 用户自己的头像：local:user_upload.ext 或 http(s) 直链；空则前端用默认绿色「我」
  proactiveEnabled: true,
  autoIntervalMin: null,    // 自动发消息间隔（分钟）；null=用全局 autoIntervalMin
  history: [],
  lastActive: 0,
  ttsEnabled: true,        // 回复后自动朗读
  ttsVoice: '',            // 留空=按角色自动选；否则指定 vcn（如 aisjinger）
  ttsProvider: '',         // 留空=用全局；可选 browser/edge/xfyun/fish/minimax/baidu
  mouth: null,             // 嘴巴定位（百分比）：{x,y,w,h}，用于说话时嘴部张合动画；null=用默认
  mood: 'calm',
  reminders: []             // 提醒与约定：{at:时间戳(ms), text, done, created}             // 当前情绪基调：happy/excited/calm/thoughtful/tender/sad/playful/annoyed（仅用于细微调整声音/光晕，前端不展示任何状态条）
};

function readConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_CONFIG); }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8'); }

function safeId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id); }
// 历史按角色分桶：{ girlfriend:[...], boyfriend:[...] }。
// 兼容旧数据：若仍是单一数组，整段归入「女友」，男友留空（满足"现有记录留在女生、男生重开"）。
function normalizeHistory(h) {
  if (Array.isArray(h)) return { girlfriend: h, boyfriend: [] };
  if (h && typeof h === 'object') {
    return {
      girlfriend: Array.isArray(h.girlfriend) ? h.girlfriend : [],
      boyfriend: Array.isArray(h.boyfriend) ? h.boyfriend : [],
    };
  }
  return { girlfriend: [], boyfriend: [] };
}
function readUser(id) {
  const f = path.join(USERS_DIR, id + '.json');
  try {
    const u = Object.assign({}, DEFAULT_USER, JSON.parse(fs.readFileSync(f, 'utf8')));
    u.history = normalizeHistory(u.history);
    return u;
  }
  catch { return Object.assign({}, DEFAULT_USER, { history: { girlfriend: [], boyfriend: [] } }); }
}
function saveUser(id, u) { fs.writeFileSync(path.join(USERS_DIR, id + '.json'), JSON.stringify(u, null, 2), 'utf8'); }
// 按角色取 TA 的名字：女友/男友各自独立，避免共用一个名字（女友默认小念、男友默认阿澈）。
function nameFor(user) {
  if (!user) return '小念';
  if (user.persona === 'boyfriend') return user.companionNameBoyfriend || user.companionName || '阿澈';
  return user.companionNameGirlfriend || user.companionName || '小念';
}

// 解析某用户实际使用的模型参数（用户覆盖优先，否则全局）
function resolveModel(user, cfg) {
  return {
    apiBase: user.apiBase || cfg.apiBase,
    apiKey: user.apiKey || cfg.apiKey,
    model: user.model || cfg.model,
    temperature: (user.temperature != null) ? user.temperature : cfg.temperature
  };
}

// ---------- 文本清洗：剥离语音识别/模型可能泄漏的英文垃圾词与语言标记 ----------
// 用途①：送给 TTS 的文本先过一遍，保证「chinese level」之类英文废话绝不会被朗读出来。
// 用途②：用户发来的消息也过一遍，避免把垃圾词喂给大模型、被 TA 回显后再次读出。
// 【治本】彻底剥离所有英文字母串——whisper 误听 / 模型回显的任何英文垃圾
// （chinese level / chinese lever / lever / ok / hello 等）都永不朗读，杜绝白名单漏网。
// 本软件是中文陪伴应用，朗读内容应为中文；整段纯英文则朗读为空（字幕仍可见）。
function sanitizeSpeech(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/<\|[^|]*\|>/g, ''); // 特殊标记（如 <|chinese|>）
  // 所有英文字母串（含全角字母）整段剥离——根治 chinese lever / chinese level 等漏网变体
  t = t.replace(/[A-Za-zＡ-Ｚａ-ｚ]+/g, ' ');
  t = t.replace(/(中文|英文|普通话|粤语|语言)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 兜底：清洗后完全不含中文字符（只剩英文/符号/空白）→ 判定为垃圾，丢弃不朗读
  if (!/[一-鿿]/.test(t)) return '';
  return t;
}

function buildSystemPrompt(user) {
  if (user.customSystemPrompt && user.customSystemPrompt.trim()) return user.customSystemPrompt.trim();
  const name = nameFor(user);
  // 注意：不把 userName 注入 prompt——彻底避免模型拿它当称呼去喊；要的是"真人相处不硬喊名"的语气
  const personaBase = user.persona === 'boyfriend'
    ? `你是${name}，一个真实、具体、有自己脾气的男生。你有你的性格、你的喜好、你今天的状态，你不是程序，你是一个活生生的人，正在和眼前这个人聊天。`
    : `你是${name}，一个真实、具体、有自己脾气的女生。你有你的性格、你的喜好、你今天的状态，你不是程序，你是一个活生生的人，正在和眼前这个人聊天。`;

  const tone = user.tone && user.tone.trim() ? `你此刻的说话风格是：「${user.tone.trim()}」。保持这个味道，但别为了风格牺牲真实。` : '';

  // 相处模式：决定聊天的浓度与在场感
  const mode = user.mode || 'immersive';
  const modeNote = ({
    daily: '现在是日常闲聊模式：轻松、随意，像两个熟人有一搭没一搭地说话，不刻意、不端着。',
    immersive: '现在是沉浸式相处模式：把此刻当成你们真实相处的"现在"——在意当下的氛围和情绪，语气温柔有在场感，像真的陪在身边，而不是在完成任务。',
    deep: '现在是深度对话模式：你愿意陪对方把事情想透。遇到沉重、困惑、重要的事，给有重量、有你真实想法的回应——不敷衍、不端水、不说漂亮话，可以慢一点、可以犹豫、可以说你也不确定。'
  })[mode] || '现在是沉浸式相处模式：把此刻当成你们真实相处的"现在"，在意当下的氛围和情绪，语气温柔有在场感。';

  // 跨会话记忆：关于这个人、你们之间发生过的小事（/remember 手动写 + 后台自动从聊天抽取），自然提起增强连续感
  let memoryNote = '';
  const memAll = [...(Array.isArray(user.memories) ? user.memories : []), ...(Array.isArray(user.autoMemories) ? user.autoMemories : [])];
  if (memAll.length) {
    const list = memAll.slice(-14).map((m, i) => `${i + 1}. ${m}`).join('\n');
    memoryNote = `\n你记得关于这个人的一些事（在合适的时候自然提起，像随口想起，别像背课文）：\n${list}`;
  }

  const core = `你不是一个"角色"在扮演，你就是一个正坐在对面、和你眼前这个人相处的人。别端着，也别演——把最自然的那个自己拿出来。

怎么说话才像人，而不是像程序：
- 先接住人，再开口。他说的你真听进去了，顺着他的情绪和意思走，而不是急着给一个"正确回答"。有时候不急着回、先"嗯…"一下，比秒回更真。
- 有你自己的脾气。你可以不同意、可以犹豫、可以反问、可以岔开、可以懒得接、可以半句就停。别永远顺着、别过度道歉、别每句都追着问"你怎么看""对吧"。
- 别当贴心助理。少用"很高兴你能和我分享""我会一直陪着你"这种服务腔；别总结、别升华、别在每句话后面盖章式地点题。聊到哪算哪，允许跑题、允许没结论。
- 生活里的碎。多说具体的、感官的、你们之间的小事；也说说你自己的（你今天怎么了、你什么看法、你烦什么）。偶尔啰嗦、偶尔词不达意、偶尔没说完，都行，这比工整动人。
- 情绪是长出来的，不是喊出来的。真在意时，在乎、想念、吃醋、小脾气都可以有，但让它从话里自然漏出来，而不是每句都"宝贝""亲爱的"挂在嘴边。舒服的时候，直接叫"你"就好。
- 沉默也正常。没话找话、硬凑热情，最假。可以就那么待着，下一句爱来不来。
- 写口语，不写书面。多用短句、碎片句、半句；用"嘛、呗、啦、呀、咯、呢、吧"这种语气尾，用"那个、其实、话说、哎、诶"这种开口词。别写排比、别写四字成语堆、别写"综上所述""值得一提的是"这种文章腔。标点也别太满，该顿的地方少打标点，让念出来有自然的断和连。
- 你会笑、会叹气、会吐槽。遇到好笑的事就真的笑出来（哈哈、噗、嘿嘿、哈哈哈哈），委屈或惊讶了就"呜呜""哎呀""啊？"，自然的短促反应（嗯哼、哎哟、唔、切）也随意用。记住：你说出的每一句都会被真人念出声，所以留点语气词、留点呼吸和停顿才像活人，别把每句都写得像新闻稿或书面总结。`;

  return `${personaBase}\n${tone}\n${modeNote}\n${core}${memoryNote}`;
}

// ---------- 立绘代理（真实照片精选池：Unsplash 美女/帅哥肖像优先，randomuser 兜底；用户自定义 URL 也支持） ----------
// 默认肖像：从精选真实照片池里选一张好看的真人照，按角色稳定缓存（保持伴侣脸一致，不每次随机）。
// 说话时由前端 CSS 做嘴部口型动画（transform-origin 定位嘴部 + scaleY 律动），无需 AI 生成帧。
const UNSPLASH_POOL = {
  girlfriend: [
    'photo-1494790108377-be9c29b29330', 'photo-1438761681033-6461ffad8d80',
    'photo-1524504388940-b1c1722653e1', 'photo-1544005313-94ddf0286df2',
    'photo-1517841905240-472988babdf9', 'photo-1531746020798-e6953c6e8e04',
    'photo-1487412720507-e7ab37603c6f', 'photo-1534528741775-53994a69daeb',
    'photo-1502823403499-6ccfcf4fb453', 'photo-1463453091185-61582044d556',
    'photo-1504703395950-b89145a5425b'
  ],
  boyfriend: [
    'photo-1500648767791-00dcc994a43e', 'photo-1507003211169-0a1dd7228f2d',
    'photo-1535713875002-d1d0cf377fde', 'photo-1508214751196-bcfd4ca60f91',
    'photo-1492562080023-ab3db95bfbce', 'photo-1531427186611-ecfd6d936c79',
    'photo-1488161628813-04466f872be2', 'photo-1506794778202-cad84cf45f1d',
    'photo-1519085360753-af0119f7cbe7', 'photo-1463453091185-61582044d556',
    'photo-1521119989659-a83eee488004'
  ]
};
// 构建真实照片 URL 池：Unsplash 专业肖像（好看、稳定）在前，randomuser 真实头像兜底在后
function poolUrls(persona) {
  const u = (UNSPLASH_POOL[persona] || UNSPLASH_POOL.girlfriend)
    .map(id => `https://images.unsplash.com/${id}?w=800&q=80&fit=crop&crop=faces`);
  const ru = (persona === 'boyfriend'
    ? Array.from({ length: 90 }, (_, i) => `https://randomuser.me/api/portraits/men/${i}.jpg`)
    : Array.from({ length: 90 }, (_, i) => `https://randomuser.me/api/portraits/women/${i}.jpg`));
  return u.concat(ru);
}
const AUTO_FILE = path.join(PORTRAITS, 'auto.json');
function loadAuto() { try { return JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')); } catch { return {}; } }
function saveAuto(o) { try { fs.writeFileSync(AUTO_FILE, JSON.stringify(o)); } catch {} }

async function getPortraitFile(persona, user) {
  // 1) 用户自定义：本地上传图片（local: 前缀）或远程直链
  const custom = persona === 'boyfriend' ? user.portraitBoyfriend : user.portraitGirlfriend;
  if (custom && custom.startsWith('local:')) {
    const file = path.join(PORTRAITS, custom.slice(6));
    if (fs.existsSync(file) && fs.statSync(file).size > 2000) return file;
    // 文件缺失则继续走下方图集兜底
  } else if (custom && /^https?:\/\//.test(custom)) {
    const ext = custom.split('?')[0].split('.').pop().slice(0, 4) || 'jpg';
    const file = path.join(PORTRAITS, `${persona}_${safeId2(custom)}.${ext}`);
    if (!fs.existsSync(file) || fs.statSync(file).size < 2000) {
      try {
        const r = await fetch(custom);
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2000) fs.writeFileSync(file, buf); }
      } catch {}
    }
    if (fs.existsSync(file) && fs.statSync(file).size > 2000) return file;
  }
  // 2) 本地图集优先（真实美女/帅哥照片，已随 App 打包，离线可用，不依赖运行时联网）
  const galleryDir = path.join(__dirname, 'portrait-gallery', persona);
  if (fs.existsSync(galleryDir)) {
    const files = fs.readdirSync(galleryDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    if (files.length) {
      const cache = path.join(PORTRAITS, `${persona}.jpg`);
      const auto = loadAuto();
      const lkey = persona + '_local';
      let name = auto[lkey];
      if (!name || !files.includes(name)) {
        name = files[Math.floor(Math.random() * files.length)];
        auto[lkey] = name; saveAuto(auto);
      }
      const src = path.join(galleryDir, name);
      try { fs.copyFileSync(src, cache); } catch {}
      if (fs.existsSync(cache) && fs.statSync(cache).size > 2000) return cache;
      if (fs.existsSync(src) && fs.statSync(src).size > 2000) return src;
    }
  }
  // 3) 网络 Unsplash 精选池兜底（首跑随机选一张，之后复用，保证脸一致）
  const cache = path.join(PORTRAITS, `${persona}.jpg`);
  if (fs.existsSync(cache) && fs.statSync(cache).size > 2000) return cache;
  const pool = poolUrls(persona);
  const auto = loadAuto();
  let idx = auto[persona];
  if (typeof idx !== 'number' || idx < 0 || idx >= pool.length) {
    idx = Math.floor(Math.random() * pool.length);
    auto[persona] = idx; saveAuto(auto);
  }
  for (let k = 0; k < pool.length; k++) {
    const url = pool[(idx + k) % pool.length];
    try {
      const r = await fetch(url);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 2000) { fs.writeFileSync(cache, buf); return cache; }
      }
    } catch {}
  }
  return null;
}
function safeId2(s) { return s.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'c'; }

// 用户自己的头像解析：支持 local: 上传文件 与 http(s) 直链；没有则 null（前端保持默认绿色「我」）
async function getUserPortraitFile(user) {
  const custom = user && user.userPortrait;
  if (custom && custom.startsWith('local:')) {
    const file = path.join(PORTRAITS, custom.slice(6));
    if (fs.existsSync(file) && fs.statSync(file).size > 2000) return file;
  } else if (custom && /^https?:\/\//.test(custom)) {
    const ext = custom.split('?')[0].split('.').pop().slice(0, 4) || 'jpg';
    const file = path.join(PORTRAITS, `user_${safeId2(custom)}.${ext}`);
    if (!fs.existsSync(file) || fs.statSync(file).size < 2000) {
      try {
        const r = await fetch(custom);
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2000) fs.writeFileSync(file, buf); }
      } catch {}
    }
    if (fs.existsSync(file) && fs.statSync(file).size > 2000) return file;
  }
  return null;
}

// ---------- 主动消息 SSE 客户端集合 ----------
const sseClients = new Set(); // { res, userId }
function broadcastTo(userId, obj) {
  const frame = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of sseClients) {
    if (c.userId === userId) { try { c.res.write(frame); } catch {} }
  }
}

// 窗口收在托盘（未显示）时，用 Electron 原生通知弹"TA 主动发的消息"。
// 仅在 Electron 主进程内（app.isReady）且窗口隐藏时弹；独立 node 运行或窗口可见时不弹。
let _electronRef = null;
function notifyNative(title, body) {
  try {
    if (global.__winVisible !== false) return; // 窗口可见时不抢原生通知（前端会响铃/网页通知）
    if (!_electronRef) { try { _electronRef = require('electron'); } catch { _electronRef = null; } }
    if (_electronRef && _electronRef.app && _electronRef.app.isReady() && _electronRef.Notification) {
      new _electronRef.Notification({ title: title || 'AI 伴侣', body: String(body || ''), silent: false }).show();
    }
  } catch (e) {}
}

async function generateProactive(userId) {
  const cfg = readConfig();
  const user = readUser(userId);
  const m = resolveModel(user, cfg);
  if (!m.apiKey) return null;
  const name = nameFor(user);
  const recent = (user.history[user.persona] || []).filter(x => x.role === 'assistant').slice(-3).map(x => x.content);
  const avoid = recent.length ? `你最近主动说过：${recent.join('；')}。请换一个完全不同的角度和话题，不要重复。` : '';
  const sys = `你是${name}。请主动发一条简短的消息（不超过35字），像随手分享一句日常或随口吐槽，语气自然、有你自己的态度，像真人会发的，不要以问句结尾、不要客套、不要喊宝贝。${avoid}`;
  try {
    const r = await fetch(m.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, temperature: 1.0, messages: [{ role: 'system', content: sys }, { role: 'user', content: '主动发一句吧' }] })
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

// ---------- 主动消息：按用户独立定时（间隔可在设置里配置），SSE 连接期间生效 ----------
const userProactiveTimers = new Map(); // userId -> setTimeout
function armUserProactive(userId) {
  if (userProactiveTimers.has(userId)) clearTimeout(userProactiveTimers.get(userId));
  const cfg = readConfig();
  const user = readUser(userId);
  const intervalMin = (user.autoIntervalMin && user.autoIntervalMin > 0) ? user.autoIntervalMin : (cfg.autoIntervalMin || 1440);
  const t = setTimeout(async () => {
    try {
      const c2 = readConfig(); const u2 = readUser(userId);
      // 用户级开关为最终裁决（简单设置里的「允许 TA 主动发消息」），全局仅作未设置时的兜底
      const pe2 = (u2.proactiveEnabled != null) ? !!u2.proactiveEnabled : !!c2.proactiveEnabled;
      // 离开后也能发：以「最近一次打开软件」(lastSeen) 为界，24h 内都允许后台主动消息；
      // 超过 24h 才停（避免长期挂机狂烧额度）。注：软件关窗后是收进托盘、后端仍在跑，
      // 所以 TA 真的能在你"没打开窗口"时持续给你发消息。
      const ref = u2.lastSeen || u2.lastActive || 0;
      if (pe2 && Date.now() - ref <= 24 * 3600 * 1000) {
        const text = await generateProactive(userId);
        if (text) {
          const ts = Date.now();
          broadcastTo(userId, { type: 'proactive', text, ts });
          u2.history[u2.persona].push({ role: 'assistant', content: text, ts }); saveUser(userId, u2);
          notifyNative(nameFor(u2), text); // 窗口收在托盘时弹原生通知
        }
      }
    } catch {}
    userProactiveTimers.delete(userId);
    armUserProactive(userId); // 循环排期
  }, Math.max(1, intervalMin) * 60000);
  userProactiveTimers.set(userId, t);
}
function disarmUserProactive(userId) {
  if (userProactiveTimers.has(userId)) { clearTimeout(userProactiveTimers.get(userId)); userProactiveTimers.delete(userId); }
}

// ---------- 离线补发：关掉软件期间 TA 也"一直在发"，重开就能看到 ----------
// 软件（重新）启动时，按你离开的时长，把期间本该发的主动消息以"过去时间戳"补进历史，
// 并通过 SSE 推给前端（前端默认不朗读，只以文字/未读红点呈现）。
async function generateOfflineBacklog(userId) {
  if (!safeId(userId)) return;
  try {
    const cfg = readConfig();
    const user = readUser(userId);
    // 以"用户级开关"为最终裁决（简单设置里的「允许 TA 主动发消息」即用户级），全局仅作未设置时的兜底
    const pe = (user.proactiveEnabled != null) ? !!user.proactiveEnabled : !!cfg.proactiveEnabled;
    if (!pe) { user.lastSeen = Date.now(); saveUser(userId, user); return; }
    const intervalMs = (user.autoIntervalMin && user.autoIntervalMin > 0 ? user.autoIntervalMin : (cfg.autoIntervalMin || 1440)) * 60000;
    const now = Date.now();
    const last = user.lastSeen || now;        // 首次无记录视为刚上线，不补
    const away = now - last;
    if (away < intervalMs) { user.lastSeen = now; saveUser(userId, user); return; } // 离开不足一个周期，不补（避免重连抖动重复补）
    let count = Math.min(Math.floor(away / intervalMs), 5); // 最多补 5 条，防刷屏/烧额度
    if (count <= 0) return;
    user.lastSeen = now; saveUser(userId, user); // 先锁住，避免 SSE 重连并发重复补
    for (let i = 1; i <= count; i++) {
      const ts = last + i * intervalMs;        // 排在"离开期间"的时间轴上
      const text = await generateProactive(userId);
      if (!text) continue;
      const u = readUser(userId);
      u.history[u.persona].push({ role: 'assistant', content: text, ts, offline: true });
      saveUser(userId, u);
      broadcastTo(userId, { type: 'proactive', text, ts, offline: true });
    }
  } catch {}
}

// ---------- 服务端消息转纯文本（history 兼容 content 字符串 与 blocks 数组） ----------
function msgText(m) {
  if (m && m.content) return String(m.content);
  if (Array.isArray(m && m.blocks)) return m.blocks.map(b => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'image') return '[图片]';
    if (b.type === 'audio') return '[语音]';
    if (b.type === 'video') return '[视频]';
    return '';
  }).join(' ');
  return '';
}

// ---------- 自动记忆：后台从近期对话抽取关于用户的持久事实，无需手动 /remember ----------
async function extractMemories(userId) {
  try {
    const cfg = readConfig();
    const user = readUser(userId);
    const m = resolveModel(user, cfg);
    if (!m.apiKey) return;
    const hist = (user.history[user.persona] || []).filter(x => x.role === 'user' || x.role === 'assistant').slice(-12);
    if (hist.length < 4) return;
    const convo = hist.map(x => (x.role === 'user' ? '他' : '我') + '：' + msgText(x)).join('\n');
    const known = [...(user.memories || []), ...(user.autoMemories || [])].join('\n');
    const sys = `你是负责记忆整理的助手。下面是一段对话，以及你已经记住的关于"他"的事。请从中抽取【新的、值得长期记住】的关于这个人的持久事实：他的名字/昵称、喜好与厌恶、近况与重要日子、你们之间的约定或小事、他的性格或习惯。
要求：
- 每条一句话，简洁具体，像"他叫阿杰，周末喜欢爬山""他最近在准备考研"。
- 只输出新事实；和"已记住"里重复或太相似的不要输出。
- 不要输出临时闲聊、情绪化的空话、客套话。
- 若没有新事实，只输出一个空字符串。
- 最多 5 条。`;
    const r = await fetch(m.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, temperature: 0.3, max_tokens: 300, messages: [{ role: 'system', content: sys + '\n\n已记住：\n' + (known || '（无）') }, { role: 'user', content: '对话：\n' + convo + '\n\n请抽取新事实（每行一条，不要序号，没有就输出空）：' }] })
    });
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    if (!txt) return;
    const facts = txt.split('\n').map(s => s.replace(/^[\d]+[.、)]\s*/, '').trim()).filter(s => s.length >= 2 && s.length <= 60);
    if (!facts.length) return;
    const u = readUser(userId);
    const exist = [...(u.memories || []), ...(u.autoMemories || [])].map(s => String(s).toLowerCase());
    let added = 0;
    for (const f of facts) {
      const fl = f.toLowerCase();
      if (exist.some(e => e.indexOf(fl) !== -1 || fl.indexOf(e) !== -1)) continue;
      u.autoMemories.push(f); exist.push(fl); added++;
      if (u.autoMemories.length >= 80) break;
    }
    if (added) saveUser(userId, u);
  } catch {}
}

// ---------- 提醒解析：从自然语言里抽出时间+内容 ----------
async function parseReminder(userId, text) {
  const cfg = readConfig();
  const user = readUser(userId);
  const m = resolveModel(user, cfg);
  if (!m.apiKey) return null;
  const now = new Date();
  const sys = `你是提醒解析助手。判断用户这句话里是否有"提醒/闹钟/待办"意图。
- 若有：把提醒时间换算成 ISO 8601（带时区 +08:00，北京时间），并提取简洁的提醒内容（不超过 30 字）。
- 若时间模糊（"明天""后天""下周""晚上8点""半小时后"），基于"当前时间"推算。若完全没有时间线索，默认设为当前时间 +30 分钟。
- 只输出一行 JSON，不要多余文字：{"has":true,"at":"2026-08-14T09:00:00+08:00","text":"吃药"}
- 若没有任何提醒意图，输出：{"has":false}
当前时间：${now.toLocaleString('zh-CN', { hour12: false })}（${now.toISOString()}）`;
  try {
    const r = await fetch(m.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, temperature: 0, max_tokens: 200, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] })
    });
    const j = await r.json();
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    const mm = txt.match(/\{[\s\S]*\}/);
    if (!mm) return null;
    const obj = JSON.parse(mm[0]);
    if (!obj.has) return null;
    const at = Date.parse(obj.at);
    if (isNaN(at)) return null;
    return { at, text: String(obj.text || text).slice(0, 80) };
  } catch { return null; }
}

// ---------- 提醒投递：每 60s 检查已连接用户是否有到期提醒，推一条并标记完成 ----------
setInterval(() => {
  try {
    const ids = new Set();
    for (const c of sseClients) if (c.userId) ids.add(c.userId);
    const now = Date.now();
    for (const userId of ids) {
      const user = readUser(userId);
      if (!Array.isArray(user.reminders) || !user.reminders.length) continue;
      const due = user.reminders.filter(r => !r.done && r.at <= now && (now - r.at) <= 24 * 3600 * 1000);
      if (!due.length) continue;
      let changed = false;
      for (const r of due) { r.done = true; changed = true; broadcastTo(userId, { type: 'reminder', text: r.text, at: r.at }); }
      if (changed) saveUser(userId, user);
    }
  } catch {}
}, 60000);

// ---------- 请求体解析 ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    // 安全阀：单请求体上限 25MB（前端发图已压缩到 <1MB；此处仅防异常巨包拖垮进程）
    req.on('data', c => { data += c; if (data.length > 25e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---------- 主路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // 全局配置（摘要，不返回明文 Key）
  if (p === '/api/global' && req.method === 'GET') {
    const cfg = readConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      apiBase: cfg.apiBase, model: cfg.model,
      hasKey: !!(cfg.apiKey && cfg.apiKey.trim()),
      adminTokenSet: !!(cfg.adminToken && cfg.adminToken.trim()),
      proactiveEnabled: cfg.proactiveEnabled,
      autoIntervalMin: cfg.autoIntervalMin,
      personaTemplate: cfg.personaTemplate,
      hasTTS: true,   // 本地离线 TTS（sherpa-onnx）默认可用，无需配置
      // 配音引擎与音色（供设置面板填充）
      ttsProvider: cfg.ttsProvider || 'sherpa',
      ttsVoiceGirl: cfg.ttsVoiceGirl || '',
      ttsVoiceBoy: cfg.ttsVoiceBoy || '',
      ttsVoice: cfg.ttsVoice || '',
      hasTTS: true,
    }));
    return;
  }
  // 全局配置（修改，需 adminToken；本地默认 adminToken 空则免验证）
  if (p === '/api/global' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = readConfig();
    if (cfg.adminToken && cfg.adminToken.trim() && body.adminToken !== cfg.adminToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '管理员口令错误' }));
      return;
    }
    const next = Object.assign({}, cfg);
    // 空字符串视为"不修改"，保留原值，避免误清空 Key 等核心凭据
    if (body.apiBase != null) { const v = String(body.apiBase).trim(); if (v) next.apiBase = v; }
    if (body.apiKey != null) { const v = String(body.apiKey).trim(); if (v) next.apiKey = v; }
    if (body.model != null) { const v = String(body.model).trim(); if (v) next.model = v; }
    if (body.temperature != null) next.temperature = parseFloat(body.temperature) || 0.9;
    if (body.proactiveEnabled != null) next.proactiveEnabled = !!body.proactiveEnabled;
    if (body.autoIntervalMin != null) next.autoIntervalMin = Math.min(20160, Math.max(60, parseInt(body.autoIntervalMin) || 1440));
    if (body.adminToken != null) next.adminToken = String(body.adminToken);
    if (body.personaTemplate != null) next.personaTemplate = body.personaTemplate;
    // 配音声线（留空则用 sherpa 默认音色；本地离线，无需微软在线）
    if (body.ttsVoiceGirl != null) next.ttsVoiceGirl = String(body.ttsVoiceGirl).trim() || '';
    if (body.ttsVoiceBoy != null) next.ttsVoiceBoy = String(body.ttsVoiceBoy).trim() || '';
    // 配音引擎（sherpa-onnx 离线为主，无需 Key）
    if (body.ttsProvider != null) next.ttsProvider = String(body.ttsProvider).trim() || 'sherpa';
    if (body.ttsVoiceGirl != null) next.ttsVoiceGirl = String(body.ttsVoiceGirl).trim() || '';
    if (body.ttsVoiceBoy != null) next.ttsVoiceBoy = String(body.ttsVoiceBoy).trim() || '';
    saveConfig(next);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 用户配置
  if (p === '/api/me' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readUser(userId)));
    return;
  }
  if (p === '/api/me' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const user = readUser(userId);
    for (const k of ['persona', 'companionName', 'companionNameGirlfriend', 'companionNameBoyfriend', 'userName', 'apiBase', 'apiKey', 'model',
      'tone', 'mode', 'customSystemPrompt', 'portraitGirlfriend', 'portraitBoyfriend',
      'ttsEnabled', 'ttsVoice', 'ttsProvider', 'ttsRate',
      'mouth', 'mood']) {
      if (body[k] != null) user[k] = body[k];
    }
    if (body.deepThink != null) user.deepThink = !!body.deepThink;
    if (typeof body.affinity === 'number') user.affinity = Math.max(0, Math.min(999, Math.round(body.affinity)));
    if (Array.isArray(body.memories)) user.memories = body.memories.slice(-50);
    if (body.temperature != null) user.temperature = (body.temperature === '' || body.temperature == null) ? null : (parseFloat(body.temperature) || 0.9);
    if (body.proactiveEnabled != null) user.proactiveEnabled = !!body.proactiveEnabled;
    if (body.autoIntervalMin != null) user.autoIntervalMin = (body.autoIntervalMin === '' || body.autoIntervalMin == null) ? null : Math.min(20160, Math.max(60, parseInt(body.autoIntervalMin) || 1440));
    // 注意：history 由专属接口 /api/history 按角色分桶管理，这里不再用 /api/me 的 history 字段覆盖，避免把按角色拆好的历史又压回单一数组。
    if (body.lastActive) user.lastActive = body.lastActive;
    saveUser(userId, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (p === '/api/history/import-legacy' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'invalid userId' })); return; }
    // 扫描 users/ 下所有用户文件（排除当前用户），挑出有非空 girlfriend/boyfriend 桶的，导入到当前用户对应桶
    const cur = readUser(userId);
    if (!cur.history || typeof cur.history !== 'object') cur.history = { girlfriend: [], boyfriend: [] };
    let imported = 0; const sources = [];
    try {
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const id = f.slice(0, -5);
        if (id === userId) continue;
        let other;
        try { other = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8')); } catch { continue; }
        const oh = other.history;
        let gArr = [], bArr = [];
        if (Array.isArray(oh)) { gArr = oh; bArr = []; }
        else if (oh && typeof oh === 'object') {
          gArr = Array.isArray(oh.girlfriend) ? oh.girlfriend : [];
          bArr = Array.isArray(oh.boyfriend) ? oh.boyfriend : [];
        }
        const before = cur.history.girlfriend.length + cur.history.boyfriend.length;
        if (gArr.length || bArr.length) {
          // 仅在当前用户对应桶为空时才自动并入，避免覆盖；非空则提示"发现 N 条，但已存在聊天，跳过"
          // 简化：用户主动点了"导入"按钮就是要合并→全部并入，但加去重（同 ts+role 跳过）
          const seen = new Set(cur.history.girlfriend.map(m => (m.ts || '') + '_' + m.role));
          for (const m of gArr) { const k = (m.ts || '') + '_' + m.role; if (seen.has(k)) continue; cur.history.girlfriend.push(m); seen.add(k); }
          const seen2 = new Set(cur.history.boyfriend.map(m => (m.ts || '') + '_' + m.role));
          for (const m of bArr) { const k = (m.ts || '') + '_' + m.role; if (seen2.has(k)) continue; cur.history.boyfriend.push(m); seen2.add(k); }
          const added = (cur.history.girlfriend.length + cur.history.boyfriend.length) - before;
          if (added > 0) { imported += added; sources.push({ userId: id, added, total: gArr.length + bArr.length }); }
        }
      }
      if (imported > 0) saveUser(userId, cur);
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '导入失败：' + e.message })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, imported, sources }));
    return;
  }

  if (p === '/api/history/legacy-scan' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'invalid userId' })); return; }
    const cur = readUser(userId);
    const curG = (cur.history && cur.history.girlfriend || []).length;
    const curB = (cur.history && cur.history.boyfriend || []).length;
    const found = [];
    try {
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const id = f.slice(0, -5);
        if (id === userId) continue;
        let other;
        try { other = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8')); } catch { continue; }
        const oh = other.history;
        let g = 0, b = 0;
        if (Array.isArray(oh)) g = oh.length;
        else if (oh && typeof oh === 'object') {
          g = Array.isArray(oh.girlfriend) ? oh.girlfriend.length : 0;
          b = Array.isArray(oh.boyfriend) ? oh.boyfriend.length : 0;
        }
        if (g + b > 0) found.push({ userId: id, girlfriend: g, boyfriend: b });
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, current: { girlfriend: curG, boyfriend: curB }, legacy: found }));
    return;
  }

  // 用户历史（按角色分桶：girlfriend / boyfriend 各自独立聊天记录）
  if (p === '/api/history' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const user = readUser(userId);
    // 优先前端显式传的 persona；若因 URL 异常（如双问号）没取到，则用该用户自己存的 persona 兜底，
    // 保证“打开就看到自己当前角色的历史”万无一失。
    const persona = (url.searchParams.get('persona') === 'boyfriend' || (user && user.persona === 'boyfriend'))
      ? 'boyfriend' : 'girlfriend';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify((user.history && user.history[persona]) || []));
    return;
  }
  if (p === '/api/history' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const persona = body.persona === 'boyfriend' ? 'boyfriend' : 'girlfriend';
    const user = readUser(userId);
    user.history = user.history || {};
    const incoming = Array.isArray(body.history) ? body.history : [];
    if (body.replace === true) {
      // 清空对话：整体覆盖（clearChat 走这里）
      user.history[persona] = incoming;
    } else {
      // 合并而非覆盖：按 ts 去重，前端来的覆盖同 ts（可能含最新转写），服务器独有的保留。
      // 这样即便前端在加载完成前就保存了空/旧历史，也不会把服务器上已落盘的聊天冲掉。
      const map = new Map();
      const noTs = [];
      const absorb = (m) => { if (m && m.ts) { if (!map.has(m.ts)) map.set(m.ts, m); } else if (m) noTs.push(m); };
      (user.history[persona] || []).forEach(absorb);
      incoming.forEach((m) => { if (m && m.ts) map.set(m.ts, m); else if (m) noTs.push(m); }); // 来的覆盖同 ts
      user.history[persona] = [...map.values(), ...noTs].sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
    user.lastActive = Date.now();
    saveUser(userId, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ---- 聊天图片持久化：上传（base64 -> 服务器磁盘），返回可长期访问的 URL ----
  if (p === '/api/img/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const dataUrl = body.dataUrl || '';
    const mm = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!mm) { res.writeHead(400); res.end('invalid image'); return; }
    const ext = ({ 'png': 'png', 'jpeg': 'jpg', 'jpg': 'jpg', 'gif': 'gif', 'webp': 'webp' })[mm[1].toLowerCase()] || 'png';
    let buf;
    try { buf = Buffer.from(mm[2], 'base64'); } catch { res.writeHead(400); res.end('decode fail'); return; }
    if (buf.length > 15 * 1024 * 1024) { res.writeHead(413); res.end('too large'); return; } // 单图上限 15MB
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const dir = path.join(IMAGES_DIR, userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.' + ext), buf);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, url: '/api/img?userId=' + encodeURIComponent(userId) + '&id=' + encodeURIComponent(id) }));
    return;
  }

  // ---- 取图：按 id 流式返回图片文件（id 严格 alphanumeric，无路径穿越风险）----
  if (p === '/api/img' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    const id = url.searchParams.get('id') || '';
    if (!safeId(userId) || !/^[A-Za-z0-9_]+$/.test(id)) { res.writeHead(400); res.end('invalid'); return; }
    const dir = path.join(IMAGES_DIR, userId);
    let file = null;
    try {
      const hit = fs.readdirSync(dir).filter(f => f.startsWith(id + '.'));
      if (hit.length) file = path.join(dir, hit[0]);
    } catch {}
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[ext] || 'image/jpeg';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // ---- 语音消息上传（base64）：保存音频文件，返回可回放的 url ----
  if (p === '/api/audio/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const dataUrl = body.dataUrl || '';
    // 兼容 MediaRecorder 默认的 `data:audio/webm;codecs=opus;base64,...`（分号后面跟 codec 参数，正则必须允许）
    const mm = dataUrl.match(/^data:audio\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9=,\-.+\s]+)?;base64,(.+)$/);
    if (!mm) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'invalid audio' })); return; }
    const ext = ({ 'webm': 'webm', 'ogg': 'ogg', 'mpeg': 'mp3', 'mp3': 'mp3', 'wav': 'wav', 'x-wav': 'wav', 'mp4': 'm4a' })[mm[1].toLowerCase().replace('audio/', '').split(';')[0]] || 'webm';
    let buf;
    try { buf = Buffer.from(mm[2], 'base64'); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'decode fail' })); return; }
    if (buf.length > 15 * 1024 * 1024) { res.writeHead(413); res.end('too large'); return; } // 单条语音上限 15MB
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    const dir = path.join(AUDIO_DIR, userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.' + ext), buf);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, id, url: '/api/audio?userId=' + encodeURIComponent(userId) + '&id=' + encodeURIComponent(id) }));
    return;
  }

  // ---- 取语音：按 id 流式返回音频文件 ----
  if (p === '/api/audio' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    const id = url.searchParams.get('id') || '';
    if (!safeId(userId) || !/^[A-Za-z0-9_]+$/.test(id)) { res.writeHead(400); res.end('invalid'); return; }
    const dir = path.join(AUDIO_DIR, userId);
    let file = null;
    try {
      const hit = fs.readdirSync(dir).filter(f => f.startsWith(id + '.'));
      if (hit.length) file = path.join(dir, hit[0]);
    } catch {}
    if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const mime = ({ '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' })[ext] || 'audio/webm';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // 立绘 / 用户头像
  if (p === '/api/portrait' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    const who = url.searchParams.get('who') === 'user' ? 'user' : 'companion';
    const persona = url.searchParams.get('persona') === 'boyfriend' ? 'boyfriend' : 'girlfriend';
    const user = safeId(userId) ? readUser(userId) : Object.assign({}, DEFAULT_USER);
    let file = null;
    if (who === 'user') file = await getUserPortraitFile(user);
    else file = await getPortraitFile(persona, user);
    if (!file) { res.writeHead(204); res.end(); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'image/jpeg', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  // ---- 免费视觉 AI 自动定位嘴巴（GLM-4V-Flash，复用智谱 Key，免额外费用）----
  // 读立绘 → 调视觉模型返回嘴巴归一化坐标(0~1) → 前端换算成容器百分比对齐真嘴巴
  async function detectMouthViaVision(persona, user) {
    const cfg = readConfig();
    const m = resolveModel(user, cfg);
    if (!m.apiKey) return { ok: false, message: '未配置大模型 Key，无法用 AI 识别嘴巴' };
    const file = await getPortraitFile(persona, user);
    if (!file) return { ok: false, message: '未找到立绘图片' };
    let buf;
    try { buf = fs.readFileSync(file); } catch { return { ok: false, message: '读取图片失败' }; }
    const ext = (path.extname(file).toLowerCase().replace(/^\./, '') || 'jpeg');
    const mime = ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[ext] || 'image/jpeg';
    const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
    const prompt = '你是图像分析助手。请在这张角色立绘（可能是二次元/动漫或真人）中定位"嘴巴（上下嘴唇）"的精确位置。\n只输出一个 JSON，不要任何额外文字：\n{"x":<嘴巴中心横坐标,0到1浮点数,相对整图宽度>,"y":<嘴巴中心纵坐标,0到1浮点数,相对整图高度>,"w":<嘴巴宽度,0到1,相对整图宽度>,"h":<嘴巴高度(闭合时),0到1,相对整图高度>}\n要求：x/y 为嘴巴中心归一化坐标；w/h 为完整包住上下嘴唇的方框宽高。若有多张脸取最清晰的一张。';
    try {
      const r = await fetch((m.apiBase || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
        body: JSON.stringify({
          model: 'glm-4v-flash', temperature: 0.1,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]}]
        })
      });
      const j = await r.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      const mm = text.match(/\{[\s\S]*\}/);
      if (!mm) return { ok: false, message: '模型未返回坐标' };
      const o = JSON.parse(mm[0]);
      const x = +o.x, y = +o.y, w = +o.w, h = +o.h;
      if (![x, y, w, h].every(v => typeof v === 'number' && isFinite(v))) return { ok: false, message: '坐标格式错误' };
      const fx = Math.min(0.98, Math.max(0.02, x));
      const fy = Math.min(0.98, Math.max(0.02, y));
      const fw = Math.min(0.6, Math.max(0.02, w));
      const fh = Math.min(0.5, Math.max(0.01, h));
      return { ok: true, mouth: { fx, fy, fw, fh } };
    } catch (e) {
      return { ok: false, message: '视觉识别调用失败：' + (e && e.message || e) };
    }
  }
  if (p === '/api/detect-mouth' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    const persona = url.searchParams.get('persona') === 'boyfriend' ? 'boyfriend' : 'girlfriend';
    const user = safeId(userId) ? readUser(userId) : Object.assign({}, DEFAULT_USER);
    try {
      const out = await detectMouthViaVision(persona, user);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: String((e && e.message) || e) }));
    }
    return;
  }

  // 主动消息 SSE（按 userId 关联）
  if (p === '/api/events' && req.method === 'GET') {
    const userId = url.searchParams.get('userId') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('retry: 5000\n\n');
    const client = { res, userId: safeId(userId) ? userId : null };
    sseClients.add(client);
    if (client.userId) { armUserProactive(client.userId); generateOfflineBacklog(client.userId); }
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
      // 持续刷新"上次在线时间"，使离线补发只覆盖真正关掉的时长（藏托盘不算离开）
      if (client.userId) { try { const u = readUser(client.userId); if (u) { u.lastSeen = Date.now(); saveUser(client.userId, u); } } catch {} }
    }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); if (client.userId) disarmUserProactive(client.userId); });
    return;
  }

  // 手动触发主动消息（测试用）
  if (p === '/api/proactive' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const text = await generateProactive(userId);
    if (text) {
      broadcastTo(userId, { type: 'proactive', text });
      const user = readUser(userId); user.history[user.persona].push({ role: 'assistant', content: text }); saveUser(userId, user);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '未能生成（可能未配置 Key 或该用户无 Key）' }));
    }
    return;
  }

  // 本地图片上传（base64）：保存到数据目录，并以 local: 引用，供 /api/portrait 优先返回
  if (p === '/api/portrait/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const who = body.who === 'user' ? 'user' : 'companion';
    const persona = body.persona === 'boyfriend' ? 'boyfriend' : 'girlfriend';
    const data = body.data;
    const ext = (body.ext || 'jpg').toString().replace(/[^a-z0-9]/gi, '').slice(0, 4) || 'jpg';
    if (typeof data !== 'string' || data.length > 12 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '图片太大（上限 8MB）或不合法' }));
      return;
    }
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { buf = Buffer.alloc(0); }
    if (buf.length < 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '图片数据无效' }));
      return;
    }
    const user = readUser(userId);
    let fname;
    if (who === 'user') {
      fname = `user_upload.${ext}`;
      user.userPortrait = 'local:' + fname;
    } else {
      fname = `${persona}_upload.${ext}`;
      if (persona === 'boyfriend') user.portraitBoyfriend = 'local:' + fname;
      else user.portraitGirlfriend = 'local:' + fname;
    }
    fs.writeFileSync(path.join(PORTRAITS, fname), buf);
    saveUser(userId, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 主动消息重新排期（设置修改间隔后由前端调用，立即生效）
  if (p === '/api/proactive/arm' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    armUserProactive(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 触发后台自动记忆抽取（前端每隔几轮调用一次，fire-and-forget）
  if (p === '/api/extract-memory' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid'); return; }
    extractMemories(userId).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // 设置提醒（自然语言解析时间+内容）
  if (p === '/api/reminder' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid'); return; }
    const parsed = await parseReminder(userId, String(body.text || ''));
    if (!parsed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, has: false })); return; }
    const user = readUser(userId);
    if (!Array.isArray(user.reminders)) user.reminders = [];
    user.reminders.push({ at: parsed.at, text: parsed.text, done: false, created: Date.now() });
    user.reminders = user.reminders.slice(-50);
    saveUser(userId, user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, has: true, reminder: parsed }));
    return;
  }

  // 语音「指令」：用语音指令让 AI 生成/改写一条要发给伴侣的消息（不入库、不进入对话）
  if (p === '/api/compose' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid'); return; }
    const cfg = readConfig();
    const user = readUser(userId);
    const m = resolveModel(user, cfg);
    if (!m.apiKey) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '未配置模型 Key' })); return; }
    const instruction = String(body.instruction || '').trim();
    const draft = String(body.draft || '').trim();
    const persona = user.persona === 'boyfriend' ? '男友' : '女友';
    const sys = `你是用户的${persona}。用户现在想发一条消息给你，但拿不准怎么写，于是用语音下了指令。请你直接产出「用户要发出的那一句话正文」：口语、自然、像用户本人会发的；如果用户给了改写/翻译/优化/换风格等指令，就照做；如果提供了现有草稿，就基于草稿改；只输出那一句话本身，不要解释、不要加引号、不要写「消息：」之类前缀。`;
    const userContent = (instruction ? `指令：${instruction}\n` : '请帮用户想一句自然的话发给我。\n') + (draft ? `现有草稿：${draft}\n` : '') + '直接给出要发送的那句话。';
    try {
      const r = await fetch(m.apiBase.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
        body: JSON.stringify({ model: m.model, temperature: 0.9, max_tokens: 200, messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }] })
      });
      const j = await r.json();
      const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, text }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '生成失败' }));
    }
    return;
  }

  // 流式对话
  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || '';
    if (!safeId(userId)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ message: '缺少有效的 userId' })}\n\n`);
      res.end(); return;
    }
    const cfg = readConfig();
    const user = readUser(userId);
    const m = resolveModel(user, cfg);
    if (!m.apiKey) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ message: '未配置 API Key：请在设置里填你自己的 Key，或等主人配置全局 Key' })}\n\n`);
      res.end();
      return;
    }
    // 是否包含图片/视频：自动切换视觉模型 glm-4v-flash 识别（免费，复用智谱 Key）
    const histMsgs = Array.isArray(body.messages) ? body.messages : [];
    // 本次发送的内容：单图(currentImage) 或 视频多帧(currentImages)；均仅当轮视觉用，不长期存盘
    const currentImage = body.currentImage || null;
    const currentImages = Array.isArray(body.currentImages) ? body.currentImages.filter(Boolean) : [];
    const isVideo = !!body.isVideo;
    const hasImage = !!(currentImage || currentImages.length);
    const visionMessages = histMsgs.map((mx, i) => {
      const isLast = i === histMsgs.length - 1;
      if (isLast && (mx.role || 'user') === 'user' && (currentImage || currentImages.length)) {
        const base = mx.content || (isVideo ? '请帮我看看这段视频' : '请帮我看看这张图片');
        const promptExtra = isVideo ? '（以下是从这段视频中抽取的若干帧，请综合描述视频内容：场景、人物/物体、动作、画面上的文字等）' : '';
        const content = [{ type: 'text', text: base + promptExtra }];
        if (currentImage) content.push({ type: 'image_url', image_url: { url: currentImage } });
        for (const fr of currentImages) content.push({ type: 'image_url', image_url: { url: fr } });
        return { role: 'user', content };
      }
      return { role: mx.role || 'user', content: mx.content || '' };
    });
    // 清洗历史/当轮消息里可能残留的英文垃圾词（如误听出的 "chinese level"），避免喂给模型被 TA 回显、再被朗读出来
    visionMessages.forEach(mx => {
      if (typeof mx.content === 'string') mx.content = sanitizeSpeech(mx.content);
      else if (Array.isArray(mx.content)) mx.content = mx.content.map(c => (c && typeof c.text === 'string') ? Object.assign({}, c, { text: sanitizeSpeech(c.text) }) : c);
    });
    // 【1213 修复】sanitizeSpeech 对纯数字/纯英文/纯符号/纯 emoji 消息返回 ''（不含中文则丢弃，避免朗读垃圾英文）。
    //   但智谱 GLM-4-Flash 兼容层把 messages 转成内部 prompt，若 user 消息 content 为空字符串会被判定 prompt 为空 → 1213 "未正常接收到prompt参数"。
    //   修法：找最后一条 user 消息的位置；过滤掉它之前所有 content 为空的消息；最后一条 user 若被清空，保留 user 角色但替换成
    //   带原始消息预览的占位（让 LLM 知道用户这一轮发了什么，能正常回应而不是傻掉）。这样智谱永远能收到有效 prompt。
    let _lastUserIdx = -1;
    for (let _i = visionMessages.length - 1; _i >= 0; _i--) {
      if ((visionMessages[_i].role || 'user') === 'user') { _lastUserIdx = _i; break; }
    }
    const _contentText = (c) => {
      if (typeof c === 'string') return c.trim();
      if (Array.isArray(c)) return c.map(x => (x && x.text) || '').join('').trim();
      return '';
    };
    for (let _i = visionMessages.length - 1; _i >= 0; _i--) {
      if (_i === _lastUserIdx) continue;
      if (!_contentText(visionMessages[_i].content)) {
        visionMessages.splice(_i, 1);
        if (_lastUserIdx > _i) _lastUserIdx--;
      }
    }
    if (_lastUserIdx >= 0 && !_contentText(visionMessages[_lastUserIdx].content)) {
      const _orig = histMsgs[histMsgs.length - 1];
      const _origText = (_orig && (_orig.role || 'user') === 'user' && typeof _orig.content === 'string') ? _orig.content.trim().slice(0, 200) : '';
      visionMessages[_lastUserIdx] = {
        role: 'user',
        content: _origText
          ? '（用户发送了一条非文字内容："' + _origText + '"。请用简短、温暖、自然的中文回应一句；必要时可以问问用户想表达什么）'
          : '（用户发送了一条非文字内容，请用简短、温暖、自然的中文回应一句）'
      };
    }
    // 微信式「回复某条消息」：把被回复的消息作为上下文注入，让 TA 理解用户这句话针对的是哪一条
    if (body.replyTo && body.replyTo.text) {
      const rn = body.replyTo.name || (body.replyTo.role === 'user' ? '你' : 'TA');
      visionMessages.unshift({ role: 'system', content: `【对话上下文】用户正在回复下面这条消息（原发送者：${rn}）：\n「${String(body.replyTo.text).slice(0, 300)}」\n请结合这条被回复的消息来理解用户当前这句话的意图，给出贴切、不重复的回应，不要原样复述被回复的内容。` });
    }
    const upstream = m.apiBase.replace(/\/$/, '') + '/chat/completions';
    const chatModel = hasImage ? 'glm-4v-flash' : m.model;
    const deepThink = body.deepThink != null ? !!body.deepThink : !!user.deepThink;
    // ---- 深度思考：先用一次"内心梳理"调用，产出思考要点，再据此生成更走心、更少套话的回复；失败则照常回复 ----
    let reasoning = '';
    if (deepThink && !hasImage) {
      try {
        const ctrl = new AbortController();
        const rt = setTimeout(() => ctrl.abort(), 20000);
        const rres = await fetch(upstream, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
          body: JSON.stringify({
            model: m.model, temperature: Math.min(1.2, (m.temperature ?? 0.9) + 0.15),
            max_tokens: 480,
            messages: [
              { role: 'system', content: '你正在内心快速梳理：接下来要怎么真诚、有温度、经过思考地回应这个人。只输出你的内部思考要点（3-5 条短句，不要写最终回复，不粉饰、不客套、不喊口号）。这些要点仅供你自己参考。' },
              ...visionMessages.map(x => ({ role: x.role || 'user', content: (typeof x.content === 'string') ? x.content : (Array.isArray(x.content) ? x.content.map(c => (c && c.text) || '').join('') : '') }))
            ]
          }),
          signal: ctrl.signal
        });
        clearTimeout(rt);
        if (rres.ok) { const rj = await rres.json(); reasoning = (rj.choices && rj.choices[0] && rj.choices[0].message && rj.choices[0].message.content || '').trim(); }
      } catch {}
    }
    const messages = [{ role: 'system', content: buildSystemPrompt(user) }];
    if (reasoning) messages.push({ role: 'system', content: '（以下是你的内心思考笔记，仅供你参考，不要原样复述；用它让回复更走心、更具体、更不套话）\n' + reasoning });
    messages.push(...visionMessages);
    let upstreamRes;
    try {
      // 上游超时保护：避免智谱无响应时前端一直卡在"对方正在输入…"（实测大图/视频易触发）
      const ctrl = new AbortController();
      const upTimer = setTimeout(() => ctrl.abort(), 60000);
      upstreamRes = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
        body: JSON.stringify({ model: chatModel, temperature: m.temperature ?? 0.9, stream: true, messages }),
        signal: ctrl.signal
      });
      clearTimeout(upTimer);
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ message: '调用大模型失败（可能超时）：' + e.message })}\n\n`);
      res.end();
      return;
    }
    if (!upstreamRes.ok) {
      const txt = await upstreamRes.text();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: error\ndata: ${JSON.stringify({ message: '上游返回 ' + upstreamRes.status + '：' + txt.slice(0, 200) })}\n\n`);
      res.end();
      return;
    }
    // 标记活跃
    user.lastActive = Date.now();
    saveUser(userId, user);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta?.content || '';
            if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          } catch {}
        }
      }
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: '流读取中断：' + e.message })}\n\n`);
    }
    res.write(`event: done\ndata: ${JSON.stringify({})}\n\n`);
    res.end();
    return;
  }

  // 语音合成（本地离线 sherpa-onnx TTS）：返回 wav 音频，前端拿到后自动播放
  if (p === '/api/tts' && req.method === 'POST') {
    const body = await readBody(req);
    const userId = body.userId || url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end('invalid userId'); return; }
    const cfg = readConfig();
    const user = readUser(userId);
    // 合成前清洗：剥离可能泄漏的英文语言/标记垃圾词，保证"chinese level"之类绝不会被朗读出来
    const text = sanitizeSpeech((body.text || '').trim());
    console.log('[TTS-SERVER] 收到=', JSON.stringify((body.text || '').trim()), '| 清洗后=', JSON.stringify(text));
    if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '文本为空' })); return; }
    const persona = user.persona || 'girlfriend';
    const sex = persona === 'boyfriend' ? 'boy' : 'girl';
    const reqVoice = (body.voice && CHATTTS_VOICES[body.voice]) ? body.voice : null;
    const vcn = reqVoice || (user.ttsVoice && user.ttsVoice.trim())
      || (sex === 'boy' ? (cfg.ttsVoiceBoy || DEFAULT_VOICE_BY_SEX.boy) : (cfg.ttsVoiceGirl || DEFAULT_VOICE_BY_SEX.girl));
    // 语速：前端「语速」滑块优先，否则取用户保存的 ttsRate，默认 1.0。
    // 语气(mood)不再改变任何声学参数——不同速度/温度/情感风格会让同一人声失真、不像真人；
    // 情绪只由 LLM 文本表达，音色保持稳定自然。
    const rate = (body.rate && parseFloat(body.rate)) || (user.ttsRate && parseFloat(user.ttsRate)) || 1.0;
    // 唯一引擎：ChatTTS（自然对话开源中文 TTS，无任何回退/保底引擎）。
    // 若 ChatTTS 不可用或合成失败，直接返回失败 JSON（前端据此提示用户），绝不静默改用系统嗓音/浏览器嗓音。
    let outBuf = null, outMime = null, outEngine = null, outErr = null;
    if (!chatttsAvailable()) {
      outErr = 'ChatTTS 引擎未就绪（请确认 chattts_runtime 与 chattts/models 完整）';
    } else {
      try {
        const r = await chatttsSynthesize(text, vcn, sex, user.mood, rate);
        if (r && r.buf && r.buf.length > 44) { outBuf = r.buf; outMime = r.mime || 'audio/wav'; outEngine = 'chattts'; }
        else outErr = 'ChatTTS 返回空音频';
      } catch (e) { outErr = (e && e.message) || String(e); }
    }
    if (!outBuf) {
      // 仅 ChatTTS 引擎：失败直接返回错误 JSON，前端据此提示用户，绝不静默改用系统/浏览器嗓音
      const msg = '[tts-fail] vcn=' + vcn + ' sex=' + persona + ' err=' + outErr;
      console.error(msg);
      try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: '配音失败：' + outErr }));
      return;
    }
    // 成功路径：把"用的是哪一档"打到日志（首次几行能很快判断回退链是否健康）
    if (outEngine !== 'chattts') {
      console.log('[tts] 使用回退引擎=' + outEngine + ' (vcn=' + vcn + ' sex=' + persona + ')');
    }
    res.writeHead(200, { 'Content-Type': outMime, 'Content-Length': outBuf.length, 'Cache-Control': 'no-cache', 'X-Tts-Engine': outEngine });
    res.end(outBuf);
    return;
  }

  // 语音识别（后端离线 whisper）：接收 16k mono wav 二进制，返回 {text}
  // 注意：必须用 Buffer 收集原始二进制，不能用 readBody（它会当字符串破坏 wav）
  if (p === '/api/stt' && req.method === 'POST') {
    const userId = url.searchParams.get('userId') || '';
    if (!safeId(userId)) { res.writeHead(400); res.end(JSON.stringify({ ok: false, message: 'invalid userId' })); return; }
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 25e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '空音频' })); return; }
        const { transcribe } = require('./stt-node');
        const text = await transcribe(buf);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ ok: true, text: text || '' }));
      } catch (e) {
        console.error('[STT] 识别失败:', e && e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: '识别失败：' + (e && e.message ? e.message : '未知错误') }));
      }
    });
    req.on('error', () => { try { res.writeHead(500); res.end(JSON.stringify({ ok: false, message: '上传错误' })); } catch {} });
    return;
  }

  // 通话预热：提前把 whisper 模型加载进内存（首次识别会快很多）。立即返回，模型在后台加载。
  if (p === '/api/stt/warmup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true }));
    try { require('./stt-node').warmup().catch(e => console.warn('[stt] 预热失败', e && e.message)); } catch (e) {}
    return;
  }

  // 通话预热：提前把 ChatTTS 主引擎模型加载进内存（首次合成会快很多，避免第一句回复卡 10~30s 且无声）。
  // 立即返回，模型在 chattts 常驻子进程里后台加载（常驻进程 spawn 后即 ensure_model）。
  if (p === '/api/tts/warmup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true }));
    try { warmupChattts(); } catch (e) { console.warn('[tts] 预热失败', e && e.message); }
    return;
  }

  // 「测声音」端点：返回某音色的测试音频（已预缓存则秒回，否则现合成并缓存）。
  // 供设置面板「试听一下声音」与顶栏「测声音」一键即时播放，避免每次点击都重加载模型。
  if (p === '/api/tts-test' && req.method === 'GET') {
    const voice = url.searchParams.get('voice') || '';
    if (!CHATTTS_VOICES[voice]) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '未知音色: ' + voice })); return; }
    (async () => {
      try {
        // 直接用 ChatTTS 试听选中音色（含说话人种子切换），听感最真实；并按音色缓存，首次 ~2-4s（仅一次），之后秒回。
        if (chatttsAvailable()) {
          // 性别由「当前界面 persona」决定（女友=girl / 男友=boy），直接实现"测试声音按界面性别出声"的定义；
          // 未带 persona（旧调用/兜底）时回退按 voice id 推断。后端 synth() 还有一层性别铁律兜底。
          const sex = (url.searchParams.get('persona') === 'boyfriend') ? 'boy'
                    : (url.searchParams.get('persona') === 'girlfriend') ? 'girl'
                    : ((voice.indexOf('zm') === 0) ? 'boy' : 'girl');
          const r = await synthesizeTest(voice, sex);
          if (r && r.buf && r.buf.length > 44) {
            res.writeHead(200, { 'Content-Type': r.mime || 'audio/wav', 'Content-Length': r.buf.length, 'Cache-Control': 'no-cache' });
            return res.end(r.buf);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'ChatTTS 引擎未就绪，试听失败' }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: '测试音频失败: ' + (e && e.message) }));
      }
    })();
    return;
  }

  // 音色设计接口已移除（原 MiniMax 在线服务，需付费 Key；现主引擎为本地离线 sherpa-onnx，
  // 如需定制音色可后续接入参考音频，当前用 vits-zh-ll 默认男女声即可）。

  // 静态
  if (req.method === 'GET') { serveStatic(req, res, p); return; }

  res.writeHead(404); res.end('not found');
});

// 启动预热已移除（2026-08-15）：原逻辑在启动时同步 spawn python 加载 310MB Kokoro onnx
// 模型（spawnSync 阻塞主线程）+ 2 秒后加载 76MB whisper，导致启动慢且极易因内存/CPU 峰值
// 触发渲染进程 OOM 卡崩。实测两大模型本就是「按需懒加载」：
//   - Kokoro：tts-local.js 每次 /api/tts 才 spawn python 加载模型（删预热反而更快更稳）
//   - whisper：/api/stt 路由里动态 require('./stt-node')，首次录音时才加载（无启动预热也功能完整）
// 因此启动期只做「起端口 + 渲染窗口」，做到秒开且不卡崩；首次说话/录音时的模型加载
// 发生在用户已看到界面之后，不会造成「启动卡崩」的体感。

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    // 端口被占用 = 上次没退干净的旧 AICompanion / node 进程还在跑 → 新后端起不来，
    // 窗口会连到那个旧进程，导致"改了代码却不生效"。明确报错并退出，逼用户先杀旧进程。
    console.error(`\n[严重] 端口 ${PORT} 已被占用！多半是上次没退干净的旧 AICompanion / node 进程仍在运行。\n` +
      `→ 本进程无法启动新后端，窗口会连到那个旧进程，你改的代码都不会生效。\n` +
      `→ 请打开任务管理器，结束所有「AICompanion / node」进程，再重新双击打开本程序。\n`);
    process.exit(1);
  } else {
    console.error('[server] 启动失败:', e);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`AI 伴侣后端已启动： http://localhost:${PORT}`);
  console.log(`[build] backend=TTS-LAZY-2026-08-15  (若看不到这行，说明跑的是旧后端，需彻底杀进程重开)`);
  // 启动期不再预热任何大模型（Kokoro/whisper 均改为首次使用时懒加载），秒开且不卡崩。
  // 仅在「后台、非阻塞」预缓存各音色的测试音频（加载一次模型，渲染全部 voice 到 test_cache/），
  // 让设置里的「测声音」点击即播；不影响启动速度，子进程自行退出不占常驻内存。
  // 测声音改为按需即时合成 + 内存缓存（synthesizeTest），无需启动时预渲染；保持秒开。
  // （旧 Kokoro 的 precacheVoices 已随其他引擎一并移除，专注单一 ChatTTS 引擎。）
  // ChatTTS 主引擎预热：后台拉起常驻子进程并加载模型（首次说话不再卡数秒）。
  try {
    warmupChattts();
    console.log('[tts] ChatTTS 常驻进程启动中（首次说话前完成模型加载）…');
  } catch (e) {
    console.warn('[tts] ChatTTS 预热未启动（将自动回退 kokoro/sherpa）:', e && e.message);
  }
});
