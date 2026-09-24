/*
 * Centro de Treinamento e condição física (funções puras; o servidor guarda o estado de cada jogador).
 *
 * Treino: cada sessão melhora uma característica (Finalização, Passe, Drible, Defesa, Velocidade ou Resistência), gasta
 * condição física e vale no máximo SESSIONS_PER_DAY vezes por dia por jogador (o dia vira à meia-noite de Brasília).
 * O ganho diminui perto do teto (TRAIN_MAX), é maior com técnico bom e em jogador jovem, e fica com o jogador se ele for vendido.
 * Cada ponto treinado vale, naquela característica, o mesmo que um ponto de nota (ver rules.skillsFor); a nota geral sobe
 * pela média ponderada do que é importante na posição (OVR_WEIGHT) e o valor de mercado acompanha.
 *
 * Condição física (0-100): cai depois de cada partida entre jogadores (quanto mais o jogador correu, mais cai) e com o treino;
 * volta com o tempo (RECOVERY por hora, ou REST_RECOVERY em descanso). A fisioterapia devolve PHYSIO de uma vez (paga, 1 vez
 * por dia). Na partida o jogador começa com a energia igual à condição e cansa ao longo do jogo (js/engine.js).
 *
 * Lesões e suspensões: quem se machuca numa partida oficial fica de 1 a 6 dias fora (tempo real); treino forte com o jogador
 * cansado também pode machucar (1 ou 2 dias). Cartão vermelho ou 3 amarelos acumulados = fora do próximo jogo oficial do clube.
 * Lesionado não treina nem joga; suspenso não joga. Quem estiver escalado assim é trocado na hora do jogo pelo melhor reserva.
 *
 * Estado de um jogador: { gains: { shot, pass, ... }, fit, fitAt, rest, day, sessions, physioDay, injUntil, injKind, susp, yellows }
 * (fit = condição no instante fitAt; a condição atual soma a recuperação desde então).
 */
const FOCUS = { shot: 'Finalização', pass: 'Passe', dribble: 'Drible', def: 'Defesa', speed: 'Velocidade', stamina: 'Resistência' };
const KEYS = Object.keys(FOCUS);
const GK_FOCUS = ['def', 'pass', 'speed', 'stamina'];
const INTENSITY = {
  light: { label: 'Leve', gain: 0.5, cost: 8, min: 30 },
  normal: { label: 'Normal', gain: 1, cost: 15, min: 40 },
  hard: { label: 'Forte', gain: 1.6, cost: 25, min: 55 }
};
const TRAIN_MAX = 10;          // pontos treinados, no máximo, em cada característica
const SESSIONS_PER_DAY = 2;    // sessões por jogador por dia
const RECOVERY = 4;            // condição recuperada por hora
const REST_RECOVERY = 8;       // ... em descanso (sem treinar)
const PHYSIO = 30;             // fisioterapia: condição devolvida na hora
const PHYSIO_RATIO = 0.02, PHYSIO_MIN = 1e6; // preço: 2% do valor de mercado (mínimo € 1 M)
const MATCH_COST = 75;         // condição perdida por unidade de energia gasta em campo (90 min ≈ 25 a 30; meio-campo corre mais)
const TZ_OFFSET = 3 * 3600e3;  // Brasília (UTC-3): quando o dia vira
const DAY = 24 * 3600e3;
const YELLOW_LIMIT = 3;        // amarelos acumulados que dão suspensão
const TRAIN_INJURY = { base: 0.02, tired: 0.06, below: 35 }; // treino forte: chance de lesão (maior se terminar abaixo de 35%)
const INJURY_KINDS = ['lesão muscular na coxa', 'entorse no tornozelo', 'pancada no joelho', 'dores nas costas', 'estiramento na panturrilha', 'lesão na virilha', 'contusão no pé'];

// Quanto cada característica treinada soma na nota geral, por posição (soma 0,8: tudo no teto = +8 na nota).
const OVR_WEIGHT = {
  GK: { def: 0.5, pass: 0.1, speed: 0.1, stamina: 0.1 },
  DEF: { def: 0.35, speed: 0.15, pass: 0.1, stamina: 0.1, dribble: 0.05, shot: 0.05 },
  MID: { pass: 0.3, dribble: 0.15, def: 0.1, shot: 0.1, stamina: 0.1, speed: 0.05 },
  FWD: { shot: 0.3, dribble: 0.2, speed: 0.15, pass: 0.05, stamina: 0.05, def: 0.05 }
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round2 = v => Math.round(v * 100) / 100;
const dayKey = now => new Date(now - TZ_OFFSET).toISOString().slice(0, 10);

/** Efeitos das instalações do clube (facilities.js); BASE = clube sem melhorias. */
const BASE = { gain: 1, sessions: SESSIONS_PER_DAY, recovery: RECOVERY, rest: REST_RECOVERY, injury: 1, physio: 1 };

const blank = () => ({ gains: {}, fit: 100, fitAt: 0, rest: false, day: null, sessions: 0, physioDay: null, injUntil: 0, injKind: null, susp: 0, yellows: 0 });
const focusFor = p => (p.role === 'GK' ? GK_FOCUS : KEYS);

/** Condição atual (0-100) de um estado (sem estado = 100). */
function condition(s, now, m = BASE) {
  if (!s) return 100;
  const h = Math.max(0, now - s.fitAt) / 3600e3;
  return clamp(s.fit + (s.rest ? m.rest : m.recovery) * h, 0, 100);
}
/** Congela a condição atual em fit/fitAt (antes de mudar o ritmo de recuperação ou de somar/tirar condição). */
function checkpoint(s, now, m) { s.fit = round2(condition(s, now, m)); s.fitAt = now; }

const sessionsLeft = (s, now, m = BASE) => (s && s.day === dayKey(now) ? Math.max(0, m.sessions - s.sessions) : m.sessions);
const physioLeft = (s, now) => !s || s.physioDay !== dayKey(now);
const physioCost = (p, m = BASE) => Math.round(Math.max(PHYSIO_MIN, p.value * PHYSIO_RATIO) * m.physio / 1e5) * 1e5; // múltiplo de € 100 mil (o saldo é inteiro)

/** Soma na nota geral pelo que foi treinado. */
function trainOvr(role, gains) {
  const w = OVR_WEIGHT[role] || OVR_WEIGHT.MID;
  let t = 0;
  for (const k of Object.keys(w)) t += w[k] * (gains[k] || 0);
  return t;
}

/** Característica que mais ajuda na posição, considerando o quanto ainda dá para evoluir (foco "automático"). */
function autoFocus(p, gains) {
  const w = OVR_WEIGHT[p.role] || OVR_WEIGHT.MID;
  let best = null, bs = -1;
  for (const k of focusFor(p)) {
    const room = 1 - (gains[k] || 0) / TRAIN_MAX;
    const s = (w[k] || 0) * room;
    if (room > 0 && s > bs) { bs = s; best = k; }
  }
  return best;
}

/** Fator do técnico (nota 75 = 1) e da idade (jovem evolui mais rápido); sem técnico o treino rende menos. */
const coachFactor = coach => (coach ? clamp(1 + (coach.ovr - 75) / 100, 0.8, 1.25) : 0.85);
function ageFactor(age) {
  if (!age) return 1;
  return age <= 21 ? 1.3 : age <= 25 ? 1.15 : age <= 29 ? 1 : age <= 32 ? 0.8 : 0.6;
}

/** Pontos ganhos numa sessão (já limitados ao teto). */
function gainFor(p, gains, focus, intensity, coach, m = BASE) {
  const cur = gains[focus] || 0;
  const g = INTENSITY[intensity].gain * (1 - 0.8 * cur / TRAIN_MAX) * coachFactor(coach) * ageFactor(p.age) * m.gain;
  return round2(clamp(g, 0, TRAIN_MAX - cur));
}

/* ---------- lesões e suspensões ---------- */
const injuredFor = (s, now) => (s && s.injUntil > now ? s.injUntil - now : 0); // ms que faltam
/** 'injury' | 'susp' | null: por que o jogador não pode jogar. */
const unavailable = (s, now) => (injuredFor(s, now) ? 'injury' : s && s.susp > 0 ? 'susp' : null);
/** Machuca o jogador por um número de dias sorteado (rand injetável nos testes; o departamento médico encurta). Devolve os dias. */
function injure(s, now, rand = Math.random, days, m = BASE) {
  if (days == null) { const r = rand(); days = r < 0.55 ? 1 : r < 0.85 ? 2 + Math.floor(rand() * 2) : 4 + Math.floor(rand() * 3); }
  days = Math.round(days * m.injury * 10) / 10;
  s.injUntil = now + days * DAY;
  s.injKind = INJURY_KINDS[Math.floor(rand() * INJURY_KINDS.length)];
  return days;
}
/** Cartões de uma partida oficial. Devolve 'red' | 'yellows' (suspenso) ou null. */
function cards(s, yellows, red) {
  if (red) { s.susp = (s.susp || 0) + 1; return 'red'; } // os amarelos do lance da expulsão não acumulam
  s.yellows = (s.yellows || 0) + yellows;
  if (s.yellows >= YELLOW_LIMIT) { s.yellows -= YELLOW_LIMIT; s.susp = (s.susp || 0) + 1; return 'yellows'; }
  return null;
}
/** O clube jogou uma partida oficial: quem estava suspenso cumpre um jogo. */
function serve(s) { if (s && s.susp > 0) { s.susp--; return true; } return false; }

/** Por que o jogador não pode treinar agora (ou null). */
function cannotTrain(p, s, focus, intensity, now, m = BASE) {
  if (injuredFor(s, now)) return p.name + ' está lesionado (' + s.injKind + ').';
  if (!focusFor(p).includes(focus)) return p.name + ': goleiro não treina ' + FOCUS[focus].toLowerCase() + '.';
  if ((s && s.gains[focus] || 0) >= TRAIN_MAX) return p.name + ' já está no máximo em ' + FOCUS[focus] + '.';
  if (!sessionsLeft(s, now, m)) return p.name + ' já treinou ' + m.sessions + ' vezes hoje.';
  const c = condition(s, now, m), it = INTENSITY[intensity];
  if (c < it.min) return p.name + ' está com ' + Math.floor(c) + '% de condição (treino ' + it.label.toLowerCase() + ' pede ' + it.min + '%).';
  return null;
}

/** Aplica uma sessão (o estado precisa existir). Devolve { gain, injury } (injury = dias fora, se machucou no treino forte). */
function train(p, s, focus, intensity, coach, now, rand = Math.random, m = BASE) {
  const g = gainFor(p, s.gains, focus, intensity, coach, m);
  checkpoint(s, now, m);
  s.gains[focus] = round2((s.gains[focus] || 0) + g);
  s.fit = round2(Math.max(0, s.fit - INTENSITY[intensity].cost));
  s.rest = false;
  const d = dayKey(now);
  s.sessions = s.day === d ? s.sessions + 1 : 1;
  s.day = d;
  let injury = 0;
  if (intensity === 'hard' && rand() < TRAIN_INJURY.base + (s.fit < TRAIN_INJURY.below ? TRAIN_INJURY.tired : 0)) injury = injure(s, now, rand, rand() < 0.7 ? 1 : 2, m);
  return { gain: g, injury };
}

/** Depois de uma partida: energy = { start, end } (0-1) do motor. Devolve a condição nova. */
function afterMatch(s, energy, now, m) {
  checkpoint(s, now, m);
  s.fit = round2(Math.max(0, s.fit - Math.max(0, energy.start - energy.end) * MATCH_COST));
  s.rest = false;
  return s.fit;
}

function setRest(s, on, now, m) { checkpoint(s, now, m); s.rest = !!on; }

/** Fisioterapia: +PHYSIO de condição e, se estiver lesionado, um dia a menos de lesão. */
function physio(s, now, m) {
  checkpoint(s, now, m);
  s.fit = Math.min(100, s.fit + PHYSIO);
  s.physioDay = dayKey(now);
  if (injuredFor(s, now)) { s.injUntil -= DAY; if (s.injUntil <= now) { s.injUntil = 0; s.injKind = null; } }
}

/** O que a tela do clube precisa de cada jogador do elenco. */
const view = (s, now, m = BASE) => {
  const v = { cond: Math.floor(condition(s, now, m)), rest: !!(s && s.rest), left: sessionsLeft(s, now, m), physio: physioLeft(s, now) };
  const inj = injuredFor(s, now);
  if (inj) { v.inj = Math.ceil(inj / 3600e3); v.injKind = s.injKind; } // horas que faltam
  if (s && s.susp) v.susp = s.susp;
  if (s && s.yellows) v.yellows = s.yellows;
  return v;
};

/** Regras para a tela (aba Treino). */
const meta = () => ({
  focus: FOCUS, gkFocus: GK_FOCUS, intensity: INTENSITY, trainMax: TRAIN_MAX, sessionsPerDay: SESSIONS_PER_DAY,
  recovery: RECOVERY, restRecovery: REST_RECOVERY, physio: PHYSIO, physioRatio: PHYSIO_RATIO, physioMin: PHYSIO_MIN, yellowLimit: YELLOW_LIMIT
});

module.exports = {
  FOCUS, KEYS, GK_FOCUS, INTENSITY, TRAIN_MAX, SESSIONS_PER_DAY, RECOVERY, REST_RECOVERY, PHYSIO, OVR_WEIGHT,
  blank, condition, checkpoint, sessionsLeft, physioLeft, physioCost, trainOvr, autoFocus, gainFor, cannotTrain, train, afterMatch, setRest, physio, view, meta, dayKey,
  injuredFor, unavailable, injure, cards, serve, YELLOW_LIMIT, BASE
};
