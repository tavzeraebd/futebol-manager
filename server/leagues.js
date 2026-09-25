/*
 * Lógica de ligas (pontos corridos) e copas (mata-mata). Funções puras sobre o objeto `league`,
 * sem acesso a rede/banco, para ficar fácil de testar.
 *
 * league = { id, code, name, format:'league'|'cup', rounds:1|2, owner, members:[clubId], status:'lobby'|'running'|'finished',
 *            fixtures:[fixture], advancing:[clubId] (copa), champion, runnerUp }
 * fixture = { id, round, stage, home, away, matchId, score:[h,a]|null, pens:[h,a]|null, winner:clubId|null, goals:[{player,clubId,og}] }
 */
const crypto = require('crypto');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para não confundir ao digitar
const LIMITS = { league: { min: 2, max: 12 }, cup: { min: 2, max: 16 } };
const LEAGUE_PRIZE = { champion: 30e6, runnerUp: 10e6 };

function newCode(exists) {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!exists(c)) return c;
  }
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// at: horário marcado (ms, ligas com agenda); extra: { bets: {clubeId: [casa, fora]} (bolão), wo: 'home'|'away'|'both' (quem não
// compareceu), pre/remind: avisos do auxiliar e do "começa em 15 min" já enviados }
const fixture = (round, stage, home, away) => ({ id: crypto.randomUUID(), round, stage, home, away, matchId: null, score: null, pens: null, winner: null, goals: [], at: null, extra: {} });

/** Todos contra todos (método do círculo). `double` = ida e volta. */
function roundRobin(ids, double) {
  const list = ids.slice();
  if (list.length % 2) list.push(null); // folga
  const n = list.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const games = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i], b = list[n - 1 - i];
      if (a && b) games.push(r % 2 ? [b, a] : [a, b]); // alterna mandos
    }
    rounds.push(games);
    list.splice(1, 0, list.pop());
  }
  const out = [];
  rounds.forEach((games, r) => games.forEach(([h, a]) => out.push(fixture(r + 1, 'Rodada ' + (r + 1), h, a))));
  if (double) {
    const base = rounds.length;
    rounds.forEach((games, r) => games.forEach(([h, a]) => out.push(fixture(base + r + 1, 'Rodada ' + (base + r + 1), a, h))));
  }
  return out;
}

const cupStage = size => ({ 2: 'Final', 4: 'Semifinal', 8: 'Quartas de final', 16: 'Oitavas de final' }[size] || 'Fase de ' + size);
const pow2 = n => { let p = 1; while (p < n) p *= 2; return p; };

/** Valida e inicia; devolve mensagem de erro ou null. */
function start(league, rnd = Math.random) {
  const lim = LIMITS[league.format];
  if (league.status !== 'lobby') return 'A competição já começou.';
  if (league.members.length < lim.min) return 'Precisa de ao menos ' + lim.min + ' clubes.';
  if (league.members.length > lim.max) return 'No máximo ' + lim.max + ' clubes.';
  if (league.format === 'league') {
    league.fixtures = roundRobin(shuffle(league.members, rnd), league.rounds === 2);
  } else {
    const order = shuffle(league.members, rnd);
    const size = pow2(order.length), byes = size - order.length;
    league.advancing = order.slice(0, byes);           // quem folga na 1ª fase já está na próxima
    const playing = order.slice(byes);
    league.fixtures = [];
    for (let i = 0; i < playing.length; i += 2) league.fixtures.push(fixture(1, cupStage(size), playing[i], playing[i + 1]));
  }
  league.status = 'running';
  return null;
}

const played = f => f.score !== null;

/** Calcula o vencedor de um jogo (placar; se empatado, pênaltis). */
function winnerOf(f) {
  if (f.score[0] !== f.score[1]) return f.score[0] > f.score[1] ? f.home : f.away;
  if (f.pens) return f.pens[0] > f.pens[1] ? f.home : f.away;
  return null;
}

/**
 * Registra o resultado. res = { matchId, score:[h,a], pens:[h,a]|null, goals:[{player, side:'home'|'away', og}] }.
 * Devolve { finished, champion, runnerUp } quando a competição termina.
 */
function recordResult(league, fixtureId, res) {
  const f = league.fixtures.find(x => x.id === fixtureId);
  if (!f || played(f)) return null;
  f.matchId = res.matchId;
  f.score = res.score;
  f.pens = res.pens || null;
  f.goals = (res.goals || []).map(g => ({ player: g.player, clubId: g.side === 'home' ? f.home : f.away, og: !!g.og, assist: g.assist || null }));
  if (res.wo) f.extra = Object.assign({}, f.extra, { wo: res.wo }); // W.O.: 3 x 0 para quem compareceu (ou derrota dos dois)
  f.winner = winnerOf(f);
  if (league.format === 'cup' && !f.winner) f.winner = f.home; // segurança: mata-mata sempre tem vencedor
  return advance(league);
}

/** Avança a competição quando a fase termina; define campeão. */
function advance(league) {
  const fx = league.fixtures;
  if (league.format === 'league') {
    if (!fx.every(played)) return null;
    const t = standings(league);
    league.status = 'finished';
    league.champion = t[0].clubId;
    league.runnerUp = t[1] ? t[1].clubId : null;
    return { finished: true, champion: league.champion, runnerUp: league.runnerUp };
  }
  const round = Math.max(...fx.map(f => f.round));
  const cur = fx.filter(f => f.round === round);
  if (!cur.every(played)) return null;
  const winners = league.advancing.concat(cur.map(f => f.winner));
  if (winners.length === 1) {
    const final = cur[0];
    league.status = 'finished';
    league.champion = winners[0];
    league.runnerUp = cur.length === 1 ? (final.home === final.winner ? final.away : final.home) : null;
    league.advancing = [];
    return { finished: true, champion: league.champion, runnerUp: league.runnerUp };
  }
  league.advancing = [];
  for (let i = 0; i < winners.length; i += 2) fx.push(fixture(round + 1, cupStage(winners.length), winners[i], winners[i + 1]));
  return { finished: false, newRound: round + 1 };
}

/** Tabela de pontos corridos. */
function standings(league) {
  const rows = new Map(league.members.map(id => [id, { clubId: id, pts: 0, j: 0, v: 0, e: 0, d: 0, gp: 0, gc: 0, sg: 0 }]));
  for (const f of league.fixtures) {
    if (!played(f)) continue;
    const h = rows.get(f.home), a = rows.get(f.away);
    if (!h || !a) continue;
    if (f.extra && f.extra.wo === 'both') { h.j++; a.j++; h.d++; a.d++; continue; } // nenhum dos dois compareceu: derrota para os dois
    const [gh, ga] = f.score;
    h.j++; a.j++; h.gp += gh; h.gc += ga; a.gp += ga; a.gc += gh;
    if (gh > ga) { h.v++; h.pts += 3; a.d++; } else if (gh < ga) { a.v++; a.pts += 3; h.d++; } else { h.e++; a.e++; h.pts++; a.pts++; }
  }
  const list = [...rows.values()];
  for (const r of list) r.sg = r.gp - r.gc;
  return list.sort((x, y) => y.pts - x.pts || y.sg - x.sg || y.gp - x.gp || String(x.clubId).localeCompare(String(y.clubId)));
}

/** Artilharia (gols contra não contam). */
function scorers(league) {
  const map = new Map();
  for (const f of league.fixtures) for (const g of f.goals) {
    if (g.og) continue;
    const k = g.clubId + '|' + g.player;
    map.set(k, { player: g.player, clubId: g.clubId, goals: (map.get(k) ? map.get(k).goals : 0) + 1 });
  }
  return [...map.values()].sort((a, b) => b.goals - a.goals || a.player.localeCompare(b.player)).slice(0, 15);
}

/** Assistências da liga: quem mais deu assistências (gol contra não tem assistência). */
function assisters(league) {
  const map = new Map();
  for (const f of league.fixtures) for (const g of f.goals) {
    if (g.og || !g.assist) continue;
    const k = g.clubId + '|' + g.assist;
    map.set(k, { player: g.assist, clubId: g.clubId, assists: (map.get(k) ? map.get(k).assists : 0) + 1 });
  }
  return [...map.values()].sort((a, b) => b.assists - a.assists || a.player.localeCompare(b.player)).slice(0, 15);
}

module.exports = { CODE_CHARS, LIMITS, LEAGUE_PRIZE, newCode, roundRobin, start, recordResult, standings, scorers, assisters, winnerOf, cupStage };
