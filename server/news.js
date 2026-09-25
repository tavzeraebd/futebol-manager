/*
 * Jornal da liga (funções puras sobre as partidas gravadas): manchetes automáticas das partidas oficiais recentes, seleção da
 * rodada (melhores notas por posição) e retrospecto entre dois clubes (clássico = CLASSIC_GAMES ou mais jogos entre eles).
 */
const CLASSIC_GAMES = 3;
const WINDOW = 7 * 24 * 3600e3; // manchetes e seleção: últimos 7 dias

const official = m => !m.cpu && m.home.id && m.away.id;
const sideName = (m, s) => (s === 'home' ? m.home.name : m.away.name);
const avgOvr = def => { const l = (def && def.players) || []; return l.length ? l.reduce((t, p) => t + (p.ovr || 75), 0) / l.length : 75; };
const pairKey = (a, b) => [a, b].sort().join('|');

/** Vencedor da partida ('home' | 'away' | null), contando pênaltis. */
function winnerOf(m) {
  if (m.score[0] !== m.score[1]) return m.score[0] > m.score[1] ? 'home' : 'away';
  if (m.pens) return m.pens[0] > m.pens[1] ? 'home' : 'away';
  return null;
}

/** Retrospecto de a contra b (ids de clube): { games, a: vitórias de a, b: vitórias de b, draws, gfA, gfB, last: [...], classic }. */
function h2h(matches, a, b) {
  const list = matches.filter(m => official(m) && pairKey(m.home.id, m.away.id) === pairKey(a, b));
  const r = { games: list.length, a: 0, b: 0, draws: 0, gfA: 0, gfB: 0, last: [], classic: list.length >= CLASSIC_GAMES };
  for (const m of list) {
    const aHome = m.home.id === a, w = winnerOf(m);
    r.gfA += m.score[aHome ? 0 : 1]; r.gfB += m.score[aHome ? 1 : 0];
    if (!w) r.draws++; else if ((w === 'home') === aHome) r.a++; else r.b++;
  }
  r.last = list.slice(-5).reverse().map(m => ({ id: m.id, at: m.at, home: m.home.name, away: m.away.name, score: m.score, pens: m.pens || null }));
  return r;
}
const isClassic = (matches, a, b) => matches.filter(m => official(m) && pairKey(m.home.id, m.away.id) === pairKey(a, b)).length >= CLASSIC_GAMES;

/** Sequência atual de um clube: { kind: 'w'|'unbeaten'|'l', n } (só partidas oficiais, da mais nova para trás). */
function streak(matches, clubId) {
  const res = matches.filter(m => official(m) && (m.home.id === clubId || m.away.id === clubId)).reverse().map(m => {
    const w = winnerOf(m), home = m.home.id === clubId;
    return !w ? 'd' : (w === 'home') === home ? 'w' : 'l';
  });
  const count = pred => { let n = 0; for (const x of res) { if (!pred(x)) break; n++; } return n; };
  return { w: count(x => x === 'w'), unbeaten: count(x => x !== 'l'), l: count(x => x === 'l'), all: res };
}

/**
 * Manchetes das partidas oficiais recentes (mais novas primeiro). Cada partida rende no máximo uma manchete (a mais forte).
 * Devolve [{ at, matchId, icon, title, text, tag }].
 */
function headlines(matches, now, limit = 12) {
  const recent = matches.filter(m => official(m) && now - m.at <= WINDOW);
  const out = [];
  for (const m of recent.slice().reverse()) {
    const w = winnerOf(m), [h, a] = m.score, W = w && sideName(m, w), L = w && sideName(m, w === 'home' ? 'away' : 'home');
    const score = h + ' x ' + a + (m.pens ? ' (pên. ' + m.pens[0] + '-' + m.pens[1] + ')' : '');
    const line = m.home.name + ' ' + score + ' ' + m.away.name;
    const comp = m.league ? m.league.name + (m.league.stage ? ' · ' + m.league.stage : '') : 'Amistoso';
    const cand = [];
    const byPlayer = new Map();
    for (const g of m.goals || []) if (!g.og) { const k = g.side + '|' + g.player; byPlayer.set(k, (byPlayer.get(k) || 0) + 1); }
    for (const [k, n] of byPlayer) if (n >= 3) { const [s, name] = k.split('|'); cand.push([9, '🎩', 'Hat-trick de ' + name + '!', name + ' marca ' + n + ' vezes e comanda o ' + sideName(m, s) + ': ' + line + '.']); }
    // virada: o vencedor esteve atrás no placar
    if (w) {
      let hs = 0, as = 0, behind = false;
      for (const g of m.goals || []) { if (g.side === 'home') hs++; else as++; if ((w === 'home' ? hs - as : as - hs) < 0) behind = true; }
      if (behind && m.score[0] !== m.score[1]) cand.push([8, '🔄', 'Virada! ' + W + ' busca o resultado', W + ' saiu atrás, mas virou para cima do ' + L + ': ' + line + '.']);
    }
    if (w && Math.abs(h - a) >= 3) cand.push([7, '💥', W + ' atropela o ' + L, 'Goleada de ' + score.replace(' x ', ' a ') + ' (' + comp + ').']);
    if (w) {
      const wo = avgOvr(w === 'home' ? m.homeDef : m.awayDef), lo = avgOvr(w === 'home' ? m.awayDef : m.homeDef);
      if (lo - wo >= 3) cand.push([7.5, '😱', 'Zebra! ' + W + ' derruba o favorito ' + L, 'Com time de nota média ' + wo.toFixed(0) + ' contra ' + lo.toFixed(0) + ', o ' + W + ' venceu: ' + line + '.']);
    }
    if (m.pens && w) cand.push([6.5, '🎯', W + ' vence nos pênaltis', 'Depois do ' + h + ' x ' + a + ', o ' + W + ' levou a melhor na marca da cal (' + comp + ').']);
    if (h + a >= 6) cand.push([6, '🔥', 'Jogo de ' + (h + a) + ' gols!', line + ' — ninguém piscou (' + comp + ').']);
    if (!h && !a) cand.push([2, '🧱', 'Defesas em alta', m.home.name + ' e ' + m.away.name + ' ficam no 0 x 0 (' + comp + ').']);
    if (!cand.length) cand.push([1, w ? '⚽' : '🤝', w ? W + ' vence o ' + L : 'Empate entre ' + m.home.name + ' e ' + m.away.name, line + ' (' + comp + ').']);
    const best = cand.sort((x, y) => y[0] - x[0])[0];
    out.push({ at: m.at, matchId: m.id, icon: best[1], title: best[2], text: best[3], tag: comp });
  }
  // sequências (uma por clube, na partida mais recente dele)
  const seen = new Set();
  for (const m of recent.slice().reverse()) {
    for (const s of ['home', 'away']) {
      const id = m[s].id;
      if (seen.has(id)) continue;
      seen.add(id);
      const st = streak(matches, id);
      if (st.w >= 3) out.push({ at: m.at + 1, matchId: m.id, icon: '📈', title: m[s].name + ' chega a ' + st.w + ' vitórias seguidas', text: 'Fase iluminada: quem segura o ' + m[s].name + '?', tag: 'Sequência' });
      else if (st.l >= 3) out.push({ at: m.at + 1, matchId: m.id, icon: '📉', title: m[s].name + ' perde a ' + st.l + 'ª seguida', text: 'Pressão no técnico: o vestiário precisa reagir.', tag: 'Crise' });
      else if (st.unbeaten >= 5) out.push({ at: m.at + 1, matchId: m.id, icon: '🛡️', title: m[s].name + ' invicto há ' + st.unbeaten + ' jogos', text: 'Time difícil de ser batido.', tag: 'Sequência' });
    }
  }
  return out.sort((x, y) => y.at - x.at).slice(0, limit);
}

/**
 * Seleção da rodada: melhores notas dos últimos 7 dias num 4-3-3 (1 goleiro, 4 defensores, 3 meias, 3 atacantes).
 * Usa m.stats.ratings = [{ id, name, side, role, rating }]. Devolve [{ id, name, role, rating, club }].
 */
function teamOfWeek(matches, now) {
  const best = new Map(); // id -> melhor atuação
  for (const m of matches) {
    if (!official(m) || now - m.at > WINDOW || !m.stats || !m.stats.ratings) continue;
    for (const r of m.stats.ratings) {
      const cur = best.get(r.id);
      if (!cur || r.rating > cur.rating) best.set(r.id, Object.assign({}, r, { club: sideName(m, r.side), clubId: m[r.side].id }));
    }
  }
  const all = [...best.values()].sort((a, b) => b.rating - a.rating);
  const pick = (role, n) => all.filter(x => x.role === role).slice(0, n);
  return [].concat(pick('GK', 1), pick('DEF', 4), pick('MID', 3), pick('FWD', 3));
}

module.exports = { CLASSIC_GAMES, h2h, isClassic, streak, headlines, teamOfWeek, winnerOf };
