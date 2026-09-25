/* Service worker: deixa o jogo instalável, abre a casca do app mais rápido e mostra as notificações no celular (Web Push).
   A API e o tempo real (SSE) nunca passam pelo cache. */
const CACHE = 'fm-shell-v4';
const SHELL = ['/', '/game.html', '/css/styles.css', '/css/game.css', '/css/theme.css', '/css/mobile.css', '/js/engine.js', '/js/render.js', '/js/narrator.js', '/js/sound.js', '/js/game.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

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

// Notificação vinda do servidor (server/push.js): { title, body, url, tag }
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Football Manager Online', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/' },
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', lang: 'pt-BR'
  }));
});
// Toque na notificação: volta para o jogo aberto (se houver) ou abre um novo, já no atalho (relatório, conversa...).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (new URL(c.url).origin === location.origin && 'focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
