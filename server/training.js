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
 * Estado de um jogador: { gains: { shot, pass, ... }, fit, fitAt, rest, day, sessions, physioDay }
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

const blank = () => ({ gains: {}, fit: 100, fitAt: 0, rest: false, day: null, sessions: 0, physioDay: null });
const focusFor = p => (p.role === 'GK' ? GK_FOCUS : KEYS);

/** Condição atual (0-100) de um estado (sem estado = 100). */
function condition(s, now) {
  if (!s) return 100;
  const h = Math.max(0, now - s.fitAt) / 3600e3;
  return clamp(s.fit + (s.rest ? REST_RECOVERY : RECOVERY) * h, 0, 100);
}
/** Congela a condição atual em fit/fitAt (antes de mudar o ritmo de recuperação ou de somar/tirar condição). */
function checkpoint(s, now) { s.fit = round2(condition(s, now)); s.fitAt = now; }

const sessionsLeft = (s, now) => (s && s.day === dayKey(now) ? Math.max(0, SESSIONS_PER_DAY - s.sessions) : SESSIONS_PER_DAY);
const physioLeft = (s, now) => !s || s.physioDay !== dayKey(now);
const physioCost = p => Math.max(PHYSIO_MIN, Math.round(p.value * PHYSIO_RATIO / 1e5) * 1e5);

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
function gainFor(p, gains, focus, intensity, coach) {
  const cur = gains[focus] || 0;
  const g = INTENSITY[intensity].gain * (1 - 0.8 * cur / TRAIN_MAX) * coachFactor(coach) * ageFactor(p.age);
  return round2(clamp(g, 0, TRAIN_MAX - cur));
}

/** Por que o jogador não pode treinar agora (ou null). */
function cannotTrain(p, s, focus, intensity, now) {
  if (!focusFor(p).includes(focus)) return p.name + ': goleiro não treina ' + FOCUS[focus].toLowerCase() + '.';
  if ((s && s.gains[focus] || 0) >= TRAIN_MAX) return p.name + ' já está no máximo em ' + FOCUS[focus] + '.';
  if (!sessionsLeft(s, now)) return p.name + ' já treinou ' + SESSIONS_PER_DAY + ' vezes hoje.';
  const c = condition(s, now), it = INTENSITY[intensity];
  if (c < it.min) return p.name + ' está com ' + Math.floor(c) + '% de condição (treino ' + it.label.toLowerCase() + ' pede ' + it.min + '%).';
  return null;
}

/** Aplica uma sessão (o estado precisa existir). Devolve os pontos ganhos. */
function train(p, s, focus, intensity, coach, now) {
  const g = gainFor(p, s.gains, focus, intensity, coach);
  checkpoint(s, now);
  s.gains[focus] = round2((s.gains[focus] || 0) + g);
  s.fit = round2(Math.max(0, s.fit - INTENSITY[intensity].cost));
  s.rest = false;
  const d = dayKey(now);
  s.sessions = s.day === d ? s.sessions + 1 : 1;
  s.day = d;
  return g;
}

/** Depois de uma partida: energy = { start, end } (0-1) do motor. Devolve a condição nova. */
function afterMatch(s, energy, now) {
  checkpoint(s, now);
  s.fit = round2(Math.max(0, s.fit - Math.max(0, energy.start - energy.end) * MATCH_COST));
  s.rest = false;
  return s.fit;
}

function setRest(s, on, now) { checkpoint(s, now); s.rest = !!on; }

function physio(s, now) {
  checkpoint(s, now);
  s.fit = Math.min(100, s.fit + PHYSIO);
  s.physioDay = dayKey(now);
}

/** O que a tela do clube precisa de cada jogador do elenco. */
const view = (s, now) => ({ cond: Math.floor(condition(s, now)), rest: !!(s && s.rest), left: sessionsLeft(s, now), physio: physioLeft(s, now) });

/** Regras para a tela (aba Treino). */
const meta = () => ({
  focus: FOCUS, gkFocus: GK_FOCUS, intensity: INTENSITY, trainMax: TRAIN_MAX, sessionsPerDay: SESSIONS_PER_DAY,
  recovery: RECOVERY, restRecovery: REST_RECOVERY, physio: PHYSIO, physioRatio: PHYSIO_RATIO, physioMin: PHYSIO_MIN
});

module.exports = {
  FOCUS, KEYS, GK_FOCUS, INTENSITY, TRAIN_MAX, SESSIONS_PER_DAY, RECOVERY, REST_RECOVERY, PHYSIO, OVR_WEIGHT,
  blank, condition, sessionsLeft, physioLeft, physioCost, trainOvr, autoFocus, gainFor, cannotTrain, train, afterMatch, setRest, physio, view, meta, dayKey
};
