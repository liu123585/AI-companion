// AI 伴侣 Service Worker（已停用）
// 旧版本使用 cache-first 策略，会把前端文件缓存到磁盘，导致改了 app.js /
// index.html / styles.css 后界面不更新。桌面应用本地服务常驻，不需要离线缓存，
// 因此这里改为：安装即跳过等待，激活时清空全部缓存并注销自身，之后不再拦截任何请求。
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* 忽略 */ }
    try {
      if (self.registration && self.registration.unregister) {
        await self.registration.unregister();
      }
    } catch (e) { /* 忽略 */ }
  })());
});

// 不再拦截任何请求，全部直连后端（默认网络行为）
self.addEventListener('fetch', (event) => {
  /* no-op：交给浏览器默认网络请求 */
});
