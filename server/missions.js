/*
 * Missões do dia e metas da diretoria (funções puras sobre club.extra.missions e league.extra.goals).
 *
 * Missões: todo dia (virada à meia-noite de Brasília) cada clube recebe 3 missões, sorteadas de forma fixa pelo clube e pelo
 * dia: duas de partida oficial e uma que dá para cumprir sem jogar. Cumpriu, o prêmio cai na hora no saldo.
 * Metas da diretoria: quando uma liga ou copa começa, cada clube recebe uma meta conforme o valor do elenco entre os
 * participantes (o mais caro tem de ser campeão...). Cumprida no fim, bônus de GOAL_PRIZE.
 */
const MATCH = {
  win: { text: 'Vença uma partida oficial', target: 1, prize: 3e6 },
  win2: { text: 'Vença uma partida oficial por 2 gols ou mais', target: 1, prize: 4e6 },
  clean: { text: 'Termine uma partida oficial sem sofrer gols', target: 1, prize: 3e6 },
  goals3: { text: 'Marque 3 gols em partidas oficiais', target: 3, prize: 3e6 },
  header: { text: 'Marque um gol de cabeça numa partida oficial', target: 1, prize: 3e6 },
  setpiece: { text: 'Marque um gol de pênalti ou de falta numa partida oficial', target: 1, prize: 4e6 },
  play2: { text: 'Jogue 2 partidas oficiais', target: 2, prize: 3e6 },
  poss: { text: 'Tenha 55% ou mais de posse de bola numa partida oficial', target: 1, prize: 3e6 }
};
const OFF = {
  train: { text: 'Faça 6 sessões de treino', target: 6, prize: 2e6 },
  locker: { text: 'Responda 2 mensagens do vestiário', target: 2, prize: 2e6 },
  talk: { text: 'Faça a preleção antes de uma partida oficial', target: 1, prize: 2e6 },
  bet: { text: 'Dê um palpite no bolão de uma liga', target: 1, prize: 1e6 },
  dm: { text: 'Mande uma mensagem para outro técnico', target: 1, prize: 1e6 }
};
const ALL = Object.assign({}, MATCH, OFF);
const GOAL_PRIZE = 15e6;

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

/** Missões do dia (cria se o dia virou). */
function today(club, day) {
  if (!club.extra) club.extra = {};
  const cur = club.extra.missions;
  if (cur && cur.day === day) return cur;
  let h = hash(club.id + '|' + day);
  const take = (pool, n) => {
    const keys = Object.keys(pool), out = [];
    while (out.length < n) { const k = keys[h % keys.length]; h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; if (!out.includes(k)) out.push(k); }
    return out;
  };
  const list = take(MATCH, 2).concat(take(OFF, 1)).map(key => ({ key, n: 0, done: false }));
  return (club.extra.missions = { day, list });
}

/** Soma progresso numa missão de hoje. Devolve as missões cumpridas agora ([{ key, text, prize }]) — o prêmio já entra no saldo. */
function progress(club, day, key, n = 1) {
  const cur = today(club, day), done = [];
  for (const m of cur.list) {
    if (m.key !== key || m.done) continue;
    const d = ALL[key];
    m.n = Math.min(d.target, m.n + n);
    if (m.n >= d.target) { m.done = true; club.budget += d.prize; done.push({ key, text: d.text, prize: d.prize }); }
  }
  return done;
}

/** Progresso das missões de partida depois de um jogo oficial. g = { gf, ga, won, poss (%), kinds: ['head','pen','fk'...] } */
function afterMatch(club, day, g) {
  const done = [];
  const add = (k, n) => { if (n > 0) done.push(...progress(club, day, k, n)); };
  add('play2', 1);
  if (g.won) add('win', 1);
  if (g.won && g.gf - g.ga >= 2) add('win2', 1);
  if (g.ga === 0) add('clean', 1);
  add('goals3', g.gf);
  add('header', g.kinds.filter(k => k === 'head').length);
  add('setpiece', g.kinds.filter(k => k === 'pen' || k === 'fk').length);
  if (g.poss >= 55) add('poss', 1);
  return done;
}

/** Para a tela: missões de hoje com texto, meta e prêmio. */
const view = (club, day) => today(club, day).list.map(m => Object.assign({ key: m.key, n: m.n, done: m.done }, ALL[m.key]));

/* ---------- metas da diretoria ---------- */
/** Define a meta de cada clube (ranking pelo valor do elenco). values: Map(clubeId -> valor do elenco). */
function boardGoals(league, values) {
  const ids = league.members.slice().sort((a, b) => (values.get(b) || 0) - (values.get(a) || 0));
  const n = ids.length, goals = {}, topK = n >= 6 ? 3 : 2;
  const win1 = { code: 'win1', text: 'Vencer pelo menos um jogo' };
  ids.forEach((id, i) => {
    let g;
    if (league.format === 'cup') g = i === 0 ? { code: 'final', text: 'Chegar à final' } : Object.assign({}, win1);
    else if (i === 0) g = { code: 'champion', text: 'Ser campeão' };
    else if (n <= 2) g = Object.assign({}, win1);
    else if (i < topK) g = { code: 'top', pos: topK, text: 'Terminar entre os ' + topK + ' primeiros' };
    else if (i < n - 1 && n >= 6) g = { code: 'top', pos: Math.ceil(n / 2), text: 'Terminar na metade de cima da tabela' };
    else g = { code: 'notlast', text: 'Não terminar em último' };
    goals[id] = Object.assign(g, { rank: i + 1 });
  });
  if (!league.extra) league.extra = {};
  league.extra.goals = goals;
  return goals;
}

/** No fim da competição: quem cumpriu a meta. table = classificação final (liga) com clubId; devolve Map(clubeId -> cumpriu?). */
function evalGoals(league, table) {
  const out = new Map(), goals = (league.extra && league.extra.goals) || {};
  for (const [id, g] of Object.entries(goals)) {
    let ok = false;
    if (g.code === 'final') ok = league.champion === id || league.runnerUp === id;
    else if (g.code === 'win1') ok = league.fixtures.some(f => f.score && f.winner === id && !(f.extra && f.extra.wo));
    else {
      const pos = table.findIndex(r => r.clubId === id) + 1;
      ok = g.code === 'champion' ? pos === 1 : g.code === 'top' ? pos > 0 && pos <= g.pos : pos > 0 && pos < table.length;
    }
    out.set(id, ok);
  }
  return out;
}

module.exports = { MATCH, OFF, ALL, GOAL_PRIZE, today, progress, afterMatch, view, boardGoals, evalGoals };
