'use strict';
// 预加载脚本：在隔离的渲染进程与 Electron 主进程之间架一座安全桥。
// 这里只暴露「读取剪贴板图片」这一项能力，渲染进程无法直接 require('electron')。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 读取系统剪贴板中的图片，返回 PNG dataURL；无图时返回 null。
  // 关键：主进程用 clipboard.readImage()，原生支持 DIB/位图/CF_DIBV5 等
  // 微信、QQ 截图常见的剪贴板格式（DOM 的 clipboardData 读不到这些格式）。
  getClipboardImage: () => ipcRenderer.invoke('get-clipboard-image'),
  // 设置页「退出程序」：让主进程真正退出（窗口关 X 只是收进托盘保活）
  quitApp: () => ipcRenderer.send('quit-app')
});
