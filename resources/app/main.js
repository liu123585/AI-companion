'use strict';
// 桌面壳：把后端 HTTP 服务直接跑在 Electron 进程内，打包后是一个独立 .exe，
// 不再需要外部 node、不再需要 bat 脚本、不再有独立的 4000 端口服务进程。
const { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, ipcMain, dialog, session } = require('electron');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 强制干掉占用指定端口的进程（用来在双击重启时清掉“藏托盘”的旧实例）。
// 旧版 main.js 点 X 只是藏托盘、进程一直活着并占着 4000 端口，
// 导致新实例抢不到单实例锁、改的代码永远不生效。这里让双击能自我修复。
function killPortOwner(port) {
  try {
    const out = execSync(`netstat -ano 2>nul | findstr :${port}`).toString();
    for (const line of out.split('\n')) {
      const m = line.trim().match(new RegExp(`:${port}\\s+\\S+\\s+\\S+\\s+(\\d+)\\s+LISTENING`));
      if (m && m[1]) {
        try { execSync(`taskkill /F /PID ${m[1]}`); } catch (e) {}
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// 允许页面在无用户手势时也能自动播放本地配音（桌面应用无需联网自动播放限制）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 数据目录必须可写：打包后程序目录(__dirname)在 asar/只读区，不可写，
// 改放到用户数据目录（C:\Users\admin\AppData\Roaming\ai-companion\data）
const userData = app.getPath('userData');
process.env.DATA_DIR = path.join(userData, 'data');

// 单实例：避免重复双击打开多个窗口。
// 若抢不到锁（说明旧实例还活着），旧进程可能是“点 X 只藏托盘”的老代码、一直占着锁。
// 这里按【进程名】强制杀掉所有旧实例（比只杀 4000 端口拥有者更稳：旧实例后端若崩了、
// 窗口却还活着时，按端口杀不到，双击就只是把旧窗口唤出来，改的代码永远不生效）。
// 杀干净后再 relaunch 拉起新实例，加载最新磁盘代码（根治“改了 N 次双击却不生效”）。
if (!app.requestSingleInstanceLock()) {
  try { execSync('taskkill /F /IM AICompanion.exe'); } catch (e) {}
  try { app.relaunch(); } catch (e) {}
  app.quit();
  process.exit(0);
}

// 在 Electron 进程内启动后端（监听 4000），前端由本进程内的服务直接提供
// 开机先清掉任何占用 4000 端口的残留进程（含早前手动跑的 `node server.js`、没退干净的老实例），
// 避免 EADDRINUSE 导致后端起不来、改的代码永远不生效。killPortOwner 只杀「占 4000 的进程」，
// 不会误伤机器上其它 node 程序。
killPortOwner(4000);
require('./server');

// ===== 本地离线 TTS：ChatTTS（常驻 Python 子进程）=====
// 由 tts-local.js 调 chattts/chattts_synth.py 常驻子进程合成，模型权重见 chattts/models/。
// 语音识别(STT) 用 whisper-small，见 stt-node.js / models/whisper-small/。

// 渲染进程通过 preload 调用来读取系统剪贴板图片（微信/QQ 截图常是 DIB 位图，
// DOM 的 clipboardData 读不到；用主进程 clipboard.readImage() 可原生识别）
ipcMain.handle('get-clipboard-image', () => {
  try {
    // 1) 首选：readImage() 原生识别 PNG/DIB/BMP 等
    let img = null;
    try { img = clipboard.readImage(); } catch (e) { img = null; }
    // 2) 兜底：部分微信/QQ 截图只把图写成 CF_DIB，readImage() 取空时，
    //    读原始 DIB 字节，补 14 字节 BITMAPFILEHEADER 拼成合法 BMP 再识别。
    //    必须按 BITMAPINFOHEADER 正确计算像素偏移（V4/V5 位图含颜色表/位掩码），
    //    否则直接写偏移=14 会得到损坏图。
    if (!img || img.isEmpty()) {
      try {
        const fmts = clipboard.availableFormats ? clipboard.availableFormats() : [];
        const dibFmt = fmts.find(f => /DIB|BITMAP/i.test(f));
        if (dibFmt) {
          const dib = clipboard.read(dibFmt);
          if (dib && dib.length >= 14) {
            const biSize = dib.readUInt32LE(0);
            const bpp = dib.readUInt16LE(14);
            const compression = dib.readUInt32LE(16);
            let clrUsed = dib.readUInt32LE(32);
            let colorTable = 0;
            if (bpp <= 8) { if (clrUsed === 0) clrUsed = 1 << bpp; colorTable = clrUsed * 4; }
            else if (compression === 3) { colorTable = 12; } // BI_BITFIELDS：3 个 DWORD 位掩码
            const pixelOffset = 14 + biSize + colorTable;
            const fh = Buffer.alloc(14);
            fh.write('BM', 0);
            fh.writeUInt32LE(14 + dib.length, 2);
            fh.writeUInt32LE(0, 6);
            fh.writeUInt32LE(pixelOffset, 10);
            img = nativeImage.createFromBuffer(Buffer.concat([fh, dib]));
          }
        }
      } catch (e) { img = null; }
    }
    if (!img || img.isEmpty()) return null;
    // 关键修复：clipboard 读出的图常为无损 PNG（数 MB）。若直接 toDataURL 丢给渲染进程，
    // 前端 new Image() 加载 + 解码成位图会导致内存暴涨、渲染进程 OOM 卡崩。
    // 这里先在主进程把图缩到最长边 1600 再转 JPEG（体积通常 <300KB），从根上消除巨图。
    let out = img;
    try {
      const size = img.getSize();
      if (size.width > 1600 || size.height > 1600) {
        const scale = 1600 / Math.max(size.width, size.height);
        out = img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });
      }
    } catch (e) { out = img; }
    try {
      const jpg = out.toJPEG(85);
      return 'data:image/jpeg;base64,' + jpg.toString('base64');
    } catch (e) {
      try { return img.toDataURL(); } catch (e2) { return null; }
    }
  } catch (e) {
    return null;
  }
});

// 设置页「退出程序」按钮：真正退出整个进程（后端随之停止）。
ipcMain.on('quit-app', () => {
  try { app.isQuiting = true; app.quit(); } catch (e) { try { app.exit(0); } catch {} }
});

const APP_URL = process.env.APP_URL || 'http://localhost:4000';
const ICON = path.join(__dirname, 'app.ico');
let win;
let tray;

// 记住你拖好的窗口尺寸/位置/最大化状态，下次打开原样恢复（不再硬编码 560×900）
const fs = require('fs');
const winStatePath = path.join(process.env.DATA_DIR || '.', 'window.json');
function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(winStatePath, 'utf8'));
    if (s && s.width > 0 && s.height > 0) return s;
  } catch {}
  return null;
}
function saveWinState() {
  if (!win) return;
  try {
    if (!fs.existsSync(process.env.DATA_DIR)) fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(winStatePath, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }));
  } catch {}
}

// ===== TTS / STT 入口 =====
// ChatTTS 合成入口见 tts-local.js；whisper 语音识别入口见 stt-node.js。

function createWindow() {
  const saved = loadWinState();
  const opts = {
    minWidth: 460,
    minHeight: 720,
    title: 'AI 伴侣',
    backgroundColor: '#0a0712',
    icon: ICON,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  };
  // 仅当你之前拖过窗口，才用你拖的尺寸/位置；否则用默认 560×900（但默认仍会被 min 约束）
  if (saved) {
    opts.width = saved.width;
    opts.height = saved.height;
    if (typeof saved.x === 'number') opts.x = saved.x;
    if (typeof saved.y === 'number') opts.y = saved.y;
  } else {
    opts.width = 560;
    opts.height = 900;
  }
  win = new BrowserWindow(opts);
  global.__winVisible = true; // 供后端判断窗口是否可见（隐藏到托盘时=false，用于弹原生通知）
  if (saved && saved.maximized) { try { win.maximize(); } catch {} }
  let attempts = 0;
  const load = () => {
    attempts++;
    win.loadURL(APP_URL).catch(() => {});
  };
  load();
  // 后端(4000端口)稍慢时，加载失败就每秒重试，最多 30 次
  win.on('did-fail-load', () => {
    if (attempts < 30) setTimeout(load, 1000);
  });
  // 点窗口右上角 X：收进托盘（进程/后端保活），不再直接退出。
  // 这样"没打开窗口"时后端仍在跑，TA 能按设定频率在后台主动给你发消息 + 弹原生通知；
  // 真正退出请用托盘菜单「退出」或设置里的「退出程序」按钮（它们会先置 app.isQuiting=true）。
  win.on('close', (e) => {
    if (app.isQuiting) return;            // 真正退出：放行默认关闭
    e.preventDefault();                   // 拦下默认关闭
    if (win) { win.hide(); global.__winVisible = false; }
  });
  win.on('hide', () => { global.__winVisible = false; });
  win.on('show', () => { global.__winVisible = true; });
  win.on('closed', () => { win = null; });
  // 你拖窗口 / 移动窗口 / 关闭前，都把当前尺寸位置存盘，下次打开原样恢复
  win.on('resized', saveWinState);
  win.on('moved', saveWinState);
  win.on('close', saveWinState);
  // 渲染进程崩溃/无响应诊断：之前"窗口悄无声息消失"往往就是渲染进程被 Chromium 干掉（hung/OOM），
  // 主进程的 uncaughtException 兜底抓不到。这里写日志 + 弹窗，让下次崩能定位，而非神秘消失。
  const crashLog = path.join(process.env.DATA_DIR || '.', 'crash.log');
  win.webContents.on('crashed', (event, killed) => {
    try { require('fs').appendFileSync(crashLog, `[${new Date().toISOString()}] 渲染进程崩溃 crashed: killed=${killed}\n`); } catch {}
    try { dialog.showErrorBox('AI 伴侣界面崩溃', '界面进程异常退出。请重新打开应用，并把 data 目录下的 crash.log 内容发给我，便于定位原因。'); } catch {}
  });
  win.on('unresponsive', () => {
    try { require('fs').appendFileSync(crashLog, `[${new Date().toISOString()}] 渲染进程无响应(unresponsive)\n`); } catch {}
  });
}

// 右下角托盘图标：让你随时能从右下角找到并唤出窗口
function createTray() {
  let img;
  try { img = nativeImage.createFromPath(ICON); } catch (e) { img = undefined; }
  if (img && img.isEmpty()) img = undefined;
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip('AI 伴侣');
  const ctxMenu = Menu.buildFromTemplate([
    { label: '打开 / 显示窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(ctxMenu);
  // 单击托盘图标：窗口可见就隐藏，隐藏就显示（方便快速收起/唤出）
  tray.on('click', () => {
    if (win && win.isVisible()) win.hide();
    else showWindow();
  });
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  global.__winVisible = true;
}

app.whenReady().then(() => {
  // 麦克风权限：Electron 默认会拒绝 getUserMedia，必须显式允许，否则录音功能起不来
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media' || permission === 'microphone' || permission === 'audio') callback(true);
      else callback(false);
    });
  } catch (e) {}
  createWindow();
  createTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

// 双击已运行的应用 = 彻底重启整个进程并加载最新磁盘代码。
// 关键：后端 server.js 跑在主进程内，只 win.reload() 只刷前端、后端不重启，
// 会导致"改了 N 次代码双击却永远不生效"（旧后端一直跑）。这里用 relaunch 真正重启。
app.on('second-instance', () => {
  try { app.isQuiting = true; app.relaunch(); } catch (e) {}
  // 稍等旧进程释放 4000 端口，再强制退出；OS 随后拉起的新进程即加载最新代码
  setTimeout(() => { try { app.exit(0); } catch (e) {} }, 800);
});

app.on('window-all-closed', () => {
  // 窗口已改为「关闭即藏到托盘」，正常情况下不会到这里；保险起见不主动 quit
  if (process.platform !== 'darwin' && !app.isQuiting) {
    // 保持托盘存活，不退出
  } else if (app.isQuiting) {
    app.quit();
  }
});

// ChatTTS 为常驻子进程，退出无需额外清理。
