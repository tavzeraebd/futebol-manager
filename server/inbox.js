/*
 * Caixa de entrada de cada clube (tabela messages): relatórios de partida, mensagens do vestiário e do auxiliar, avisos da
 * diretoria (missões, metas, prêmios) e conversas entre técnicos. Fica em memória (as últimas MAX por clube) e cada mudança
 * é gravada em segundo plano. Quem está com o jogo aberto recebe na hora (evento "inbox" do tempo real).
 *
 * Mensagem: { id, kind: 'report'|'locker'|'aux'|'board'|'dm', at, read, data }
 * Mensagem com `at` no futuro só aparece a partir desse instante (o pós-jogo de uma partida transmitida ao vivo sai quando o
 * jogo termina na tela, para não entregar o resultado antes).
 */
const crypto = require('crypto');

const MAX = 150;                     // por clube
const KEEP = 45 * 24 * 3600e3;       // mensagens mais velhas saem ao iniciar o servidor
const KINDS = ['report', 'locker', 'aux', 'board', 'dm'];

function createInbox(store, push) {
  const box = new Map(); // clubeId -> [mensagens], da mais velha para a mais nova

  async function load() {
    const since = Date.now() - KEEP;
    store.pruneMessages(since);
    for (const r of await store.loadMessages(since)) {
      if (!box.has(r.club_id)) box.set(r.club_id, []);
      box.get(r.club_id).push({ id: r.id, kind: r.kind, at: new Date(r.created_at).getTime(), read: !!r.read_at, data: r.data || {} });
    }
    for (const l of box.values()) l.sort((a, b) => a.at - b.at);
  }

  const all = id => { if (!box.has(id)) box.set(id, []); return box.get(id); };
  const listOf = id => { const now = Date.now(); return all(id).filter(m => m.at <= now); }; // só as que já apareceram

  /** Nova mensagem. opts: { read, silent (não avisa a tela), at (aparece só a partir deste instante) }. */
  function add(clubId, kind, data, opts = {}) {
    const now = Date.now(), m = { id: crypto.randomUUID(), kind, at: Math.max(now, opts.at || now), read: !!opts.read, data };
    const l = all(clubId);
    l.push(m);
    l.sort((a, b) => a.at - b.at);
    if (l.length > MAX) store.deleteMessages(l.splice(0, l.length - MAX).map(x => x.id));
    store.saveMessage(clubId, m);
    const tell = () => push(clubId, 'inbox', { msg: m, unread: unread(clubId) });
    if (!opts.silent) { if (m.at > now) { const t = setTimeout(tell, m.at - now); if (t.unref) t.unref(); } else tell(); }
    return m;
  }
  const get = (clubId, id) => listOf(clubId).find(m => m.id === id) || null;
  /** Grava de novo uma mensagem alterada (resposta dada, lida...). */
  const update = (clubId, m) => store.saveMessage(clubId, m);

  /** Não lidas por tipo: { total, report, locker, ... }. */
  function unread(clubId) {
    const out = { total: 0 };
    for (const k of KINDS) out[k] = 0;
    for (const m of listOf(clubId)) if (!m.read) { out[m.kind] = (out[m.kind] || 0) + 1; out.total++; }
    return out;
  }

  /** Lista (mais novas primeiro). kind opcional; conversas (dm) vêm agrupadas pela tela. */
  function list(clubId, kind, limit = 80) {
    const l = listOf(clubId).filter(m => !kind || m.kind === kind);
    return l.slice(-limit).reverse();
  }

  /** Marca como lidas: ids (lista) ou todas de um tipo (kind) ou, com dm, as da conversa com `withId`. */
  function markRead(clubId, { ids, kind, withId }) {
    const want = ids ? new Set(ids) : null;
    let n = 0;
    for (const m of listOf(clubId)) {
      if (m.read) continue;
      if (want ? want.has(m.id) : (kind ? m.kind === kind : true) && (!withId || (m.kind === 'dm' && m.data.with === withId))) {
        m.read = true; n++; store.saveMessage(clubId, m);
      }
    }
    if (n) push(clubId, 'inbox', { unread: unread(clubId) });
    return n;
  }

  /** Apaga a caixa de um clube (reinício de temporada). */
  function clear(clubId) { const l = all(clubId); store.deleteMessages(l.map(m => m.id)); box.set(clubId, []); }

  return { load, add, get, update, unread, list, markRead, clear, KINDS };
}

module.exports = { createInbox };
