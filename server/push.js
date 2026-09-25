/*
 * Notificações no celular (Web Push, padrão dos navegadores; no iPhone só com o app instalado na tela de início).
 * Chaves VAPID: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (variáveis de ambiente) ou, se faltarem, geradas uma vez e guardadas no
 * banco (tabela app_kv, só o servidor acessa). Inscrições por clube na tabela push_subs; inscrição que o navegador
 * descartou (404/410) é apagada.
 */
const webpush = require('web-push');

function createPush(store) {
  const subs = new Map(); // clubeId -> Map(endpoint -> inscrição)
  let keys = null;

  async function init() {
    keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : await store.getKv('vapid');
    if (!keys || !keys.publicKey) {
      keys = webpush.generateVAPIDKeys();
      await store.setKv('vapid', keys);
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'https://futebol-manager.onrender.com', keys.publicKey, keys.privateKey);
    for (const r of await store.loadPushSubs()) add(r.club_id, { endpoint: r.endpoint, keys: r.keys }, false);
  }

  function add(clubId, sub, persist = true) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return false;
    for (const m of subs.values()) m.delete(sub.endpoint); // o mesmo aparelho só recebe de um clube
    if (!subs.has(clubId)) subs.set(clubId, new Map());
    subs.get(clubId).set(sub.endpoint, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    if (persist) store.savePushSub(clubId, sub.endpoint, { p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    return true;
  }
  function remove(endpoint) {
    for (const m of subs.values()) m.delete(endpoint);
    store.deletePushSub(endpoint);
  }
  const has = clubId => !!(subs.get(clubId) && subs.get(clubId).size);

  /** Envia para todos os aparelhos do clube. payload = { title, body, url?, tag? }. */
  function send(clubId, payload) {
    const m = subs.get(clubId);
    if (!m || !keys) return;
    const data = JSON.stringify(Object.assign({ url: '/' }, payload));
    for (const s of [...m.values()]) {
      webpush.sendNotification(s, data, { TTL: 6 * 3600, urgency: payload.urgent ? 'high' : 'normal' }).catch(e => {
        if (e.statusCode === 404 || e.statusCode === 410) remove(s.endpoint);
        else console.error('[push] falha:', e.statusCode || e.message);
      });
    }
  }

  return { init, add, remove, has, send, publicKey: () => (keys ? keys.publicKey : null) };
}

module.exports = { createPush };
