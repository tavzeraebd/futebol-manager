/* Regras do jogo: economia, formações e conversão de escalação em time do motor. */
const { ROLE } = require('./seed');

const START_BUDGET = 500e6;
const BUY_PREMIUM = 1.2;     // clubes vendedores cobram 20% acima do valor de mercado
const SELL_RATIO = 0.75;     // vende por 75% do valor de mercado
const SQUAD_MAX = 25;
const PRIZE = { win: 10e6, draw: 4e6, loss: 2e6 };
const buyPrice = item => Math.round(item.value * BUY_PREMIUM);

// fx: 0 = próprio gol, 1 = gol adversário; fy: 0 = topo. (equipe atacando para a direita)
const SLOT = (pos, fx, fy) => ({ pos, fx, fy, role: ROLE[pos] });
const FORMATIONS = {
  '4-2-3-1': [SLOT('GK', .04, .5), SLOT('RB', .24, .86), SLOT('CB', .21, .63), SLOT('CB', .21, .37), SLOT('LB', .24, .14),
    SLOT('DM', .40, .62), SLOT('DM', .40, .38), SLOT('RW', .58, .86), SLOT('AM', .58, .5), SLOT('LW', .58, .14), SLOT('ST', .77, .5)],
  '4-3-3': [SLOT('GK', .04, .5), SLOT('RB', .24, .86), SLOT('CB', .21, .63), SLOT('CB', .21, .37), SLOT('LB', .24, .14),
    SLOT('CM', .48, .72), SLOT('DM', .38, .5), SLOT('CM', .48, .28), SLOT('RW', .72, .86), SLOT('ST', .78, .5), SLOT('LW', .72, .14)],
  '4-4-2': [SLOT('GK', .04, .5), SLOT('RB', .24, .86), SLOT('CB', .21, .63), SLOT('CB', .21, .37), SLOT('LB', .24, .14),
    SLOT('RM', .50, .86), SLOT('CM', .46, .62), SLOT('CM', .46, .38), SLOT('LM', .50, .14), SLOT('ST', .76, .62), SLOT('ST', .76, .38)],
  '3-5-2': [SLOT('GK', .04, .5), SLOT('CB', .20, .75), SLOT('CB', .20, .5), SLOT('CB', .20, .25),
    SLOT('RWB', .42, .92), SLOT('CM', .44, .66), SLOT('DM', .38, .5), SLOT('CM', .44, .34), SLOT('LWB', .42, .08),
    SLOT('ST', .76, .62), SLOT('ST', .76, .38)]
};

const TACTICS = {
  balanced: 'Equilibrado', attack: 'Ofensivo', defend: 'Retranca', counter: 'Contra-ataque', press: 'Pressão alta'
};
const MAX_SUBS = 5, MAX_TACTIC_CHANGES = 3, MAX_MINUTE = 120;
/** Condições das instruções do plano (motor v8) e estilos da palestra do intervalo. */
const WHEN = { losing: 'perdendo', drawing: 'empatando', winning: 'ganhando', notwinning: 'sem estar ganhando' };
const TALKS = { push: 'Cobrar', calm: 'Tranquilizar', motivate: 'Incentivar' };
const TALK_MIN = 46; // a palestra acontece no intervalo

const TILT = {
  GK:  { pass: .9,  shot: .5,  def: 1,    dribble: .7 },
  DEF: { pass: .95, shot: .7,  def: 1.15, dribble: .9 },
  MID: { pass: 1.1, shot: .95, def: 1,    dribble: 1 },
  FWD: { pass: .95, shot: 1.1, def: .75,  dribble: 1.1 }
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Desvio fixo (-2 a +2) de um jogador, diferente para cada característica (i), para jogadores de mesma nota não ficarem iguais. */
function jitter(p) {
  let h = 0;
  for (const ch of String(p.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return k => ((h >>> (k * 3)) % 5) - 2;
}
const baseOvr = p => p.ovr - (p.trainOvr || 0); // nota sem o treino (o treino entra característica por característica)
/** Resistência (0-99) com o treino: vem da nota e da posição (o goleiro corre menos; o meio-campo, mais). */
const staminaOf = p => clamp(Math.round(baseOvr(p) + ({ GK: -8, DEF: 0, MID: 3, FWD: -2 }[p.role] || 0) + jitter(p)(5)), 25, 99) + ((p.train && p.train.stamina) || 0);
/** Resistência -> quanto o jogador cansa em campo (1 = normal; menos = cansa mais devagar). */
const staminaRate = st => +clamp(1 + (72 - st) / 80, 0.6, 1.4).toFixed(3);

/**
 * Craques se destacam mais (regras v7): cada habilidade fica SPREAD vezes mais longe da média (1.0) e a velocidade, SPEED_SPREAD
 * vezes. Medido em simulações: com a escala antiga um time 4 pontos de nota melhor vencia só 37% dos jogos; com esta, 50%.
 */
const SPREAD = 2.5, SPEED_SPREAD = 3;
const spread = v => clamp(1 + (v - 1) * SPREAD, 0.4, 2.2);

/**
 * Nota geral (ou atributos do Sofascore) -> multiplicadores usados pelo motor (nota 75 / atributo 60 = 1.0).
 * O treino soma em cada característica o mesmo que a nota somaria (1 ponto = 1/60, antes da ampliação SPREAD); velocidade e
 * resistência treinadas mudam a velocidade máxima e o ritmo em que o jogador cansa (sta).
 */
function skillsFor(player, slotRole, coach) {
  let ovr = baseOvr(player);
  const off = slotRole !== 'GK' && player.role !== slotRole; // fora de posição
  if (off) ovr *= 0.85;
  const cm = coach ? 1 + (coach.ovr - 75) / 400 : 1;
  const tr = player.train || {};
  const add = k => (tr[k] || 0) / 60 * (off ? 0.85 : 1);
  const skill = {};
  const a = player.attrs;
  if (a && player.role !== 'GK') {
    const f = v => 1 + ((typeof v === 'number' ? v : 60) - 60) / 70;
    const raw = { pass: f(a.creativity * 0.6 + a.technical * 0.4), shot: f(a.attacking), def: f(a.defending), dribble: f(a.technical) };
    for (const k of Object.keys(raw)) skill[k] = +spread(clamp((raw[k] * (off ? 0.85 : 1) + add(k)) * cm, 0.5, 1.6)).toFixed(3);
  } else {
    const base = 1 + (ovr - 75) / 60;
    const t = TILT[player.role];
    for (const k of Object.keys(t)) skill[k] = +spread(clamp((base * t[k] + add(k)) * cm, 0.5, 1.6)).toFixed(3);
  }
  return { skill, speed: +(1 + ((ovr - 75) / 400 + (tr.speed || 0) / 250) * SPEED_SPREAD).toFixed(3), sta: staminaRate(staminaOf(player)) };
}

/**
 * Características para exibir (0-99). Jogadores com atributos reais (Sofascore) mostram esses valores; os demais têm os números
 * derivados da nota geral, do papel em campo e de um pequeno desvio fixo por jogador (só para a tela: o motor usa skillsFor).
 * Cada linha traz `base` (sem treino) e `gain` (pontos treinados).
 */
function profileFor(p) {
  const tr = p.train || {};
  const row = (key, label, v) => {
    const g = tr[key] || 0;
    return { key, label, value: clamp(Math.round(v + g), 0, 99), base: clamp(Math.round(v), 0, 99), gain: +g.toFixed(1) };
  };
  const base = baseOvr(p), jit = jitter(p);
  const speed = clamp(Math.round(base + ({ GK: -12, DEF: -2, MID: 0, FWD: 3 }[p.role] || 0) + jit(4)), 25, 99);
  const stamina = staminaOf(p) - (tr.stamina || 0);
  if (p.attrs && p.role !== 'GK') {
    const L = { attacking: 'Ataque', technical: 'Técnica', tactical: 'Tática', defending: 'Defesa', creativity: 'Criatividade' };
    const G = { attacking: 'shot', technical: 'dribble', creativity: 'pass', defending: 'def' }; // treino que soma em cada atributo
    return { estimated: false, stats: Object.keys(L).map(k => Object.assign(row(G[k] || k, L[k], p.attrs[k] || 0), { key: k }))
      .concat([row('speed', 'Velocidade', speed), row('stamina', 'Resistência', stamina)]) };
  }
  const t = TILT[p.role] || TILT.MID;
  const at = (k, i) => clamp(Math.round(base + (t[k] - 0.95) * 40 + jit(i)), 25, 99);
  return {
    estimated: true,
    stats: [
      row('shot', 'Finalização', at('shot', 0)),
      row('pass', 'Passe', at('pass', 1)),
      row('dribble', 'Drible', at('dribble', 2)),
      row('def', p.role === 'GK' ? 'Defesa do gol' : 'Defesa', at('def', 3)),
      row('speed', 'Velocidade', speed),
      row('stamina', 'Resistência', stamina)
    ]
  };
}

function textColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}
function gkColor(shirt) {
  const n = parseInt(shirt.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255;
  return r > 180 && g > 150 ? '#22a06b' : '#f2c200';
}

/**
 * Constrói a definição de time que o motor (Match) espera. `cond(id)`: condição física (0-100) de cada jogador; o motor começa
 * a partida com a energia do jogador igual a ela (fit) e o faz cansar no ritmo `sta`.
 * opts.bench: ids dos reservas disponíveis (entram sozinhos no lugar de quem se machucar); opts.injuries: a partida tem lesões
 * (só as oficiais); opts.skip: ids que não podem entrar (lesionados/suspensos) nas trocas planejadas; opts.crowd: fração a mais nas
 * habilidades pela torcida (só o mandante em partida oficial; vem do nível do estádio).
 * opts.mult(id): multiplicador das habilidades de cada jogador (moral e preleção, ver locker.js; 1 = normal).
 * v: versão das regras (6 = cartão vermelho, lesões e troca automática do lesionado; 7 = pênalti, falta direta, bola aérea,
 * toque rápido, lançamento em profundidade, mira a partir da bola e torcida; 8 = instruções condicionais e palestra do
 * intervalo — ver engine.js).
 */
function buildTeamDef(club, lineup, formation, catalog, cond = () => 100, opts = {}) {
  const slots = FORMATIONS[formation];
  const coach = club.coach ? catalog.coachById.get(club.coach) : null;
  const shirt = club.color || '#d71920';
  const number = textColor(shirt);
  const mult = opts.mult || (() => 1);
  const bench = (opts.bench || []).map(id => catalog.playerById.get(id)).filter(Boolean).map((p, i) => {
    const { skill, speed, sta } = scaled(skillsFor(p, p.role, coach), mult(p.id));
    return { num: 12 + i, id: p.id, name: p.name, short: p.short, role: p.role, pos: p.pos, skill, speed, sta, fit: fitOf(cond, p.id), ovr: p.ovr };
  });
  return {
    v: 8, injuries: !!opts.injuries,
    ...(opts.crowd ? { crowd: opts.crowd } : {}),
    name: club.name,
    tactic: TACTICS[club.tactic] ? club.tactic : 'balanced',
    plan: buildPlan(club, lineup, formation, coach, catalog, cond, opts.skip, bench, mult),
    short: club.name.replace(/[^A-Za-zÀ-ú ]/g, '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase() || 'CLB',
    formation,
    coach: coach ? coach.name : null,
    colors: { shirt, number, trim: number === '#ffffff' ? '#ffffff' : '#111111', gk: gkColor(shirt), gkNumber: '#111111' },
    players: slots.map((s, i) => {
      const p = catalog.playerById.get(lineup[i]);
      const { skill, speed, sta } = scaled(skillsFor(p, s.role, coach), mult(p.id));
      return { num: i + 1, id: p.id, name: p.name, short: p.short, role: s.role, pos: s.pos, fx: s.fx, fy: s.fy, skill, speed, sta, fit: fitOf(cond, p.id), ovr: p.ovr };
    }),
    bench
  };
}

const fitOf = (cond, id) => +(clamp(cond(id), 0, 100) / 100).toFixed(2);
/** Habilidades multiplicadas por m (moral e preleção); m = 1 devolve o mesmo objeto. */
function scaled(sk, m) {
  if (!m || m === 1) return sk;
  const skill = {};
  for (const k of Object.keys(sk.skill)) skill[k] = +(sk.skill[k] * m).toFixed(3);
  return { skill, speed: sk.speed, sta: sk.sta };
}

/**
 * Plano de jogo: trocas e mudanças de tática nos minutos combinados (entradas inválidas são ignoradas), com a condição do placar
 * (when, motor v8), e a palestra do intervalo que o auxiliar faz conforme o placar.
 */
function buildPlan(club, lineup, formation, coach, catalog, cond, skip, bench, mult = () => 1) {
  const slots = FORMATIONS[formation], out = [];
  let n = 0;
  const cond_ = e => (WHEN[e.when] ? { when: e.when } : {});
  for (const e of club.plan || []) {
    if (e.type === 'talk') { if (TALKS[e.style]) out.push(Object.assign({ min: TALK_MIN, type: 'talk', style: e.style }, cond_(e))); continue; }
    if (e.type === 'tactic') { if (TACTICS[e.style]) out.push(Object.assign({ min: e.min, type: 'tactic', style: e.style }, cond_(e))); continue; }
    const slot = slots[e.out], p = catalog.playerById.get(e.in);
    if (!slot || e.out < 1 || !p || p.pos === 'GK' || !club.squad.includes(p.id) || lineup.includes(p.id) || (skip && skip.has(p.id))) continue;
    const { skill, speed, sta } = scaled(skillsFor(p, slot.role, coach), mult(p.id));
    const b = bench && bench.find(x => x.id === p.id); // mesmo número de camisa do banco
    out.push(Object.assign({ min: e.min, type: 'sub', out: e.out, in: { num: b ? b.num : 30 + n++, id: p.id, name: p.name, short: p.short, skill, speed, sta, fit: fitOf(cond, p.id), ovr: p.ovr } }, cond_(e)));
  }
  return out;
}

/** Confere táticas e plano de jogo enviados pelo técnico. Devolve o texto do erro ou null. */
function validatePlan(tactic, plan, formation, squad, lineup, catalog) {
  if (!TACTICS[tactic]) return 'Tática inválida.';
  if (!Array.isArray(plan) || plan.length > MAX_SUBS + MAX_TACTIC_CHANGES + 3) return 'Plano de jogo inválido.';
  const slots = FORMATIONS[formation];
  let subs = 0, tacs = 0;
  const usedIn = new Set(), usedOut = new Set(), talks = new Set();
  for (const e of plan) {
    if (e && e.when != null && !WHEN[e.when]) return 'Condição inválida.';
    if (e && e.type === 'talk') { // palestra do intervalo: uma por situação do placar
      if (!TALKS[e.style]) return 'Palestra inválida.';
      if (e.when === 'notwinning') return 'Escolha perdendo, empatando ou ganhando para a palestra.';
      const k = e.when || 'any';
      if (talks.has(k) || talks.has('any') || (k === 'any' && talks.size)) return 'Já existe uma palestra para essa situação do placar.';
      talks.add(k);
      continue;
    }
    if (!e || !Number.isInteger(e.min) || e.min < 1 || e.min > MAX_MINUTE) return 'Minuto inválido (1 a ' + MAX_MINUTE + ').';
    if (e.type === 'tactic') { if (!TACTICS[e.style]) return 'Tática inválida.'; if (++tacs > MAX_TACTIC_CHANGES) return 'No máximo ' + MAX_TACTIC_CHANGES + ' mudanças de tática.'; continue; }
    if (e.type !== 'sub') return 'Item do plano inválido.';
    if (++subs > MAX_SUBS) return 'No máximo ' + MAX_SUBS + ' substituições.';
    if (!Number.isInteger(e.out) || e.out < 1 || e.out >= slots.length) return 'Escolha um jogador de linha para sair (o goleiro não sai).';
    const p = catalog.playerById.get(e.in);
    if (!p || !squad.includes(p.id)) return 'O jogador que entra precisa ser do seu elenco.';
    if (p.pos === 'GK') return 'Só jogadores de linha entram por substituição.';
    if (lineup.includes(p.id)) return p.name + ' já está entre os titulares.';
    if (usedIn.has(p.id)) return p.name + ' já entra em outra substituição.';
    if (usedOut.has(e.out)) return 'A mesma posição não pode sair duas vezes.';
    usedIn.add(p.id); usedOut.add(e.out);
  }
  return null;
}

/** Confere se a escalação é válida (ids do elenco, sem repetição, goleiro só no gol). */
function validateLineup(formation, lineup, squad, catalog, requireFull) {
  const slots = FORMATIONS[formation];
  if (!slots) return 'Formação inválida.';
  if (!Array.isArray(lineup) || lineup.length !== slots.length) return 'Escalação inválida.';
  const seen = new Set();
  for (let i = 0; i < slots.length; i++) {
    const id = lineup[i];
    if (id == null) { if (requireFull) return 'Preencha os 11 jogadores.'; continue; }
    if (!squad.includes(id)) return 'Jogador fora do elenco.';
    if (seen.has(id)) return 'Jogador repetido.';
    seen.add(id);
    const p = catalog.playerById.get(id);
    if (!p) return 'Jogador desconhecido.';
    if ((slots[i].pos === 'GK') !== (p.pos === 'GK')) return 'Somente goleiros jogam no gol (e goleiros só no gol).';
  }
  return null;
}

module.exports = { profileFor, START_BUDGET, BUY_PREMIUM, buyPrice, SELL_RATIO, SQUAD_MAX, PRIZE, FORMATIONS, buildTeamDef, validateLineup, validatePlan, TACTICS, MAX_SUBS, MAX_TACTIC_CHANGES, skillsFor, WHEN, TALKS, TALK_MIN };
