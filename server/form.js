/*
 * Forma dos jogadores e técnicos: depois de cada partida entre jogadores, a nota de quem atuou sobe ou cai conforme
 * o resultado E o desempenho em campo (defesas, desarmes, chutes no gol, passes de risco, gols, faltas, gols sofridos...).
 * A nota muda em "pontos" (delta) e o valor de mercado acompanha (VALUE_PER_POINT ao ano de cada ponto).
 *
 * Funções puras: recebem os eventos do motor e devolvem o quanto cada um sobe ou desce.
 */
const MAX_FORM = 8;               // teto/piso do acumulado, em pontos de nota
const VALUE_PER_POINT = 1.06;     // cada ponto de nota vale ~6% de valor de mercado
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cap = (v, lim) => clamp(v, -lim, lim);

/** Efeito de um delta acumulado no valor de mercado (fator multiplicador). */
const valueFactor = delta => Math.pow(VALUE_PER_POINT, delta);

/** Conta o que cada jogador fez, a partir dos eventos do motor. Chave: "home|Nome". */
class Tally {
  constructor() { this.players = new Map(); this.subsIn = new Set(); this.goals = { home: 0, away: 0 }; this.last = { home: null, away: null }; this.lastAssist = null; }
  get(side, name) {
    const k = side + '|' + name;
    let e = this.players.get(k);
    if (!e) this.players.set(k, e = { side, name, shots: 0, onTarget: 0, goals: 0, og: 0, assists: 0, saves: 0, steals: 0, intercepts: 0, passes: 0, risky: 0, fouls: 0, yellow: 0, red: 0, injured: false });
    return e;
  }
  add(ev) {
    const p = ev.player;
    if (!p || !ev.team) return;
    const other = ev.team === 'home' ? 'away' : 'home';
    if (ev.type === 'goal') this.goals[ev.team]++;
    const e = this.get(ev.type === 'goal' && ev.og ? other : ev.team, p.name); // gol contra: o jogador é do time que sofreu
    switch (ev.type) {
      case 'shot': e.shots++; if (ev.outcome === 'goal' || ev.outcome === 'save') e.onTarget++; break;
      case 'goal': {
        this.lastAssist = null;
        if (ev.og) { e.og++; this.last.home = this.last.away = null; break; }
        e.goals++;
        // assistência: o último passe do time, para quem fez o gol, pouco antes (a posse não pode ter mudado de time no meio)
        const la = this.last[ev.team];
        if (la && la.to === p.name && la.from !== p.name && ev.t - la.t <= 9) { this.get(ev.team, la.from).assists++; this.lastAssist = la.from; }
        this.last[ev.team] = null;
        break;
      }
      case 'save': e.saves++; break;
      case 'steal': e.steals++; this.last[other] = null; break; // quem perdeu a bola não constrói mais jogada
      case 'intercept': e.intercepts++; this.last[other] = null; break;
      case 'pass': e.passes++; if (ev.kind === 'cross' || ev.kind === 'long' || ev.kind === 'through') e.risky++; this.last[ev.team] = { from: p.name, to: ev.to && ev.to.name, t: ev.t }; this.last[other] = null; break;
      case 'foul': e.fouls++; this.last.home = this.last.away = null; break; // bola parada: a jogada anterior não dá assistência (pênalti, falta direta)
      case 'yellow': e.yellow++; break;
      case 'red': e.red++; break;
      case 'injury': e.injured = true; break;
      case 'sub': this.subsIn.add(ev.team + '|' + p.name); break;
    }
  }
}

// Bônus médio de cada posição num jogo (medido em simulações): descontado para que a média geral fique em zero.
const BASELINE = { GK: 0.5, DEF: 0, MID: 0.5, FWD: 0.5 };

/**
 * Pontos de nota (positivos ou negativos) de um jogador nesta partida.
 * role: GK | DEF | MID | FWD. r: resultado do time (+1 vitória, 0 empate, -1 derrota). conceded: gols sofridos pelo time.
 */
function rate(role, e, r, conceded) {
  const clean = conceded === 0;
  let s = r * 0.6 + e.goals * 0.6 + (e.assists || 0) * 0.35 - e.og * 0.4 - e.yellow * 0.2 - (e.red || 0) * 0.6 - e.fouls * 0.05;
  const def = e.steals + e.intercepts;
  if (role === 'GK') {
    s += cap(e.saves * 0.18, 0.9) + (clean ? 0.5 : 0) - Math.min(1, conceded * 0.22);
  } else if (role === 'DEF') {
    s += cap(def * 0.07, 0.5) + (clean ? 0.4 : 0) - Math.min(0.75, conceded * 0.15) + Math.min(0.25, e.risky * 0.05) + Math.min(0.2, e.onTarget * 0.1);
  } else if (role === 'MID') {
    s += cap(def * 0.05, 0.3) + Math.min(0.35, e.passes * 0.012) + Math.min(0.25, e.risky * 0.06) + Math.min(0.4, e.onTarget * 0.12)
      - Math.min(0.25, conceded * 0.05) + (clean ? 0.15 : 0);
  } else { // FWD
    s += Math.min(0.6, e.onTarget * 0.14) - Math.min(0.25, (e.shots - e.onTarget) * 0.05) + Math.min(0.25, e.risky * 0.06) + Math.min(0.2, e.passes * 0.02) + Math.min(0.15, def * 0.03);
  }
  return +clamp(s - (BASELINE[role] || 0), -2, 2.5).toFixed(2);
}

/** Técnico: resultado do time e saldo de gols. */
const rateCoach = (r, goalDiff) => +clamp(r * 0.6 + cap(goalDiff * 0.1, 0.3), -1, 1).toFixed(2);

module.exports = { Tally, rate, rateCoach, valueFactor, MAX_FORM, VALUE_PER_POINT };
