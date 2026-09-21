/*
 * Preço de referência de um jogador/técnico: metade é o valor dele, metade é a média do valor de jogadores de características
 * parecidas (mesma função em campo, nota e habilidades próximas). Serve de guia na tela de venda e limita o preço pedido pelo dono.
 *
 * Por que limitar: sem faixa, alguém com várias contas pode comprar jogadores caros no mercado em cada conta e "vender" quase
 * de graça para a conta principal (ou pedir uma fortuna para passar dinheiro). Com a faixa, o preço de venda fica perto do mercado.
 */
const R = require('./rules');

const NEIGHBORS = 7;                       // quantos parecidos entram na média
const BAND = { low: 0.8, high: 1.3 };      // preço inicial permitido: 80% a 130% da referência
const TRADE_MAX_RATIO = 1.35;              // numa troca, o lado que dá mais pode valer no máximo 35% a mais que o outro
const CANDIDATE_OVR_GAP = 8;               // só compara com quem tem nota até 8 pontos de diferença

const round = v => Math.round(v / 1e5) * 1e5;

/** Habilidades comparáveis (0-99), com os atributos reais quando existem. */
function stats(p) {
  if (p.attrs && p.role !== 'GK') {
    const a = p.attrs;
    return { shot: a.attacking, pass: Math.round(a.creativity * 0.6 + a.technical * 0.4), dribble: a.technical, def: a.defending, speed: Math.round(p.ovr) };
  }
  const out = {};
  for (const s of R.profileFor(p).stats) out[s.key] = s.value;
  return out;
}
const KEYS = ['shot', 'pass', 'dribble', 'def', 'speed'];
const distance = (a, sa, b, sb) => {
  let d = 0;
  for (const k of KEYS) d += ((sa[k] || 0) - (sb[k] || 0)) ** 2;
  const other = (a.source || 'seed') !== (b.source || 'seed') ? 25 : 0; // catálogos diferentes têm escalas de valor diferentes: prefere a mesma origem
  return Math.sqrt(d) + 2 * Math.abs(a.ovr - b.ovr) + other - (a.pos === b.pos ? 3 : 0); // mesma posição exata pesa a favor
};

/** Guia de preço de um jogador ou técnico do catálogo. */
function guide(catalog, it) {
  const coach = catalog.coachById.has(it.id);
  let neighbors;
  if (coach) {
    neighbors = catalog.coaches.filter(c => c.id !== it.id).sort((a, b) => Math.abs(a.ovr - it.ovr) - Math.abs(b.ovr - it.ovr)).slice(0, 5)
      .map(c => ({ id: c.id, name: c.name, club: c.club, pos: 'TEC', ovr: c.ovr, value: c.value, stats: null }));
  } else {
    const mine = stats(it);
    neighbors = catalog.players
      .filter(p => p.id !== it.id && p.role === it.role && Math.abs(p.ovr - it.ovr) <= CANDIDATE_OVR_GAP && p.value > 0)
      .map(p => { const s = stats(p); return { p, s, d: distance(it, mine, p, s) }; })
      .sort((a, b) => a.d - b.d).slice(0, NEIGHBORS)
      .map(x => ({ id: x.p.id, name: x.p.name, club: x.p.club, pos: x.p.pos, ovr: x.p.ovr, value: x.p.value, photo: x.p.photo || null, stats: x.s }));
  }
  const avg = neighbors.length ? neighbors.reduce((s, n) => s + n.value, 0) / neighbors.length : it.value;
  const reference = round(0.5 * it.value + 0.5 * avg);
  // a faixa sempre acomoda o valor de mercado do próprio jogador (astros acima dos parecidos não ficam presos abaixo do que valem)
  const min = Math.min(round(reference * BAND.low), round(it.value * 0.9)), max = Math.max(round(reference * BAND.high), round(it.value * 1.1));
  return {
    self: { id: it.id, name: it.name, club: it.club, pos: coach ? 'TEC' : it.pos, ovr: it.ovr, value: it.value, photo: it.photo || null, stats: coach ? null : stats(it) },
    coach, neighbors, reference, similarAverage: round(avg),
    band: { min, max, low: BAND.low, high: BAND.high }
  };
}

module.exports = { guide, BAND, TRADE_MAX_RATIO };
