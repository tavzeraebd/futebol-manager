/* Service worker: deixa o jogo instalável e abre a casca do app mais rápido. A API e o tempo real (SSE) nunca passam pelo cache. */
const CACHE = 'fm-shell-v2';
const SHELL = ['/', '/game.html', '/css/styles.css', '/css/game.css', '/css/fm-theme.css', '/css/mobile.css', '/js/engine.js', '/js/render.js', '/js/narrator.js', '/js/sound.js', '/js/game.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro (sempre a versão mais nova do jogo); o cache só entra se a rede falhar.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('/game.html') : Response.error()))));
});
