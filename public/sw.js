/* 缓一缓 · 手机 PWA 的壳缓存
 * 只缓存静态资源（HTML/CSS/JS/图标），绝不拦截 /api/*。
 * 数据必须每次都打到服务端；尤其 SSE 流式回答，被缓存或缓冲住就会变成「一次性吐字」。
 */
const CACHE = 'hyh-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 页面本身走网络优先：断网时才回退到缓存的首页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
        }
        return res;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // 静态资源：先给缓存保证秒开，同时后台悄悄更新，下次刷新就是新版
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await fresh) || caches.match('/');
    })
  );
});
