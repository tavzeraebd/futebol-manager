/*
 * Relatório pós-jogo de cada clube (função pura): placar, números do time, nota de 0 a 10 de quem atuou (form.matchRating),
 * craque da partida, destaques, quem ficou abaixo e quem precisa treinar o quê, com o motivo tirado dos números do jogo.
 * O servidor guarda o relatório na caixa de entrada do clube e a tela abre em janela quando o técnico entra no jogo.
 */
const FOCUS = { shot: 'Finalização', pass: 'Passe', dribble: 'Drible', def: 'Defesa', speed: 'Velocidade', stamina: 'Resistência' };
const MAX_TRAIN = 4;

const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

/**
 * Sugestão de treino de um jogador (ou null): o problema mais claro nos números do jogo.
 * e = linha do Tally (form.js); conceded = gols sofridos pelo time; energy = energia no fim (0-1).
 */
function trainFor(role, e, conceded, energy) {
  const out = [];
  if (role !== 'GK' && e.shots >= 3 && e.onTarget / e.shots < 0.34) out.push([3, 'shot', 'chutou ' + e.shots + ' vezes e acertou só ' + e.onTarget + ' no gol']);
  if (e.passes >= 6 && e.passLost >= 3 && e.passLost / e.passes >= 0.2) out.push([2.5, 'pass', 'errou ' + e.passLost + ' de ' + e.passes + ' passes']);
  if (role !== 'GK' && e.lost >= 3) out.push([2, 'dribble', 'perdeu a bola ' + e.lost + ' vezes nas disputas']);
  if (role === 'DEF' && conceded >= 2 && e.steals + e.intercepts <= 1) out.push([2.2, 'def', 'só ' + (e.steals + e.intercepts) + ' desarme(s) com o time sofrendo ' + conceded + ' gols']);
  if (role === 'GK' && conceded >= 3 && e.saves <= 1) out.push([2.4, 'def', 'sofreu ' + conceded + ' gols e fez ' + e.saves + ' defesa(s)']);
  if (energy != null && energy < 0.35) out.push([1.5, 'stamina', 'terminou o jogo esgotado (' + Math.round(energy * 100) + '% de energia)']);
  if (!out.length) return null;
  const [, focus, why] = out.sort((a, b) => b[0] - a[0])[0];
  return { focus, focusName: FOCUS[focus], why };
}

/** O que o jogador fez de destaque, em poucas palavras (para a lista de notas). */
function highlights(role, e, conceded) {
  const h = [];
  if (e.goals) h.push(e.goals === 1 ? '⚽ gol' : '⚽×' + e.goals);
  if (e.assists) h.push(e.assists === 1 ? '🅰️ assistência' : '🅰️×' + e.assists);
  if (role === 'GK' && e.saves) h.push('🧤 ' + e.saves + (e.saves > 1 ? ' defesas' : ' defesa'));
  if ((role === 'GK' || role === 'DEF') && conceded === 0) h.push('🔒 sem sofrer gol');
  if (role !== 'GK' && e.steals + e.intercepts >= 3) h.push('🛡️ ' + (e.steals + e.intercepts) + ' desarmes');
  if (e.og) h.push('😬 gol contra');
  if (e.red) h.push('🟥'); else if (e.yellow) h.push('🟨');
  if (e.injured) h.push('🚑');
  return h;
}

/**
 * Monta o relatório de um lado. m = partida gravada; side = 'home' | 'away'; rated = [{ id, name, side, role, pos, sub, rating, e }]
 * (os dois times); energy = Map("lado|nome" -> fim 0-1); notes = linhas do aviso de fim de jogo (lesões, bilheteria, forma...).
 * extra = { talk, crowd, wo, classic, auxiliar } (texto já pronto para a tela).
 */
function build(m, side, rated, energy, notes, extra = {}) {
  const other = side === 'home' ? 'away' : 'home';
  const i = side === 'home' ? 0 : 1, gf = m.score[i], ga = m.score[1 - i];
  let res = gf > ga ? 'w' : gf < ga ? 'l' : 'd';
  if (res === 'd' && m.pens) res = m.pens[i] > m.pens[1 - i] ? 'w' : 'l';
  const st = m.stats || {}, h = st[side] || {}, a = st[other] || {};
  const tp = (h.poss || 0) + (a.poss || 0);
  const mine = rated.filter(x => x.side === side).sort((x, y) => y.rating - x.rating);
  const motm = rated.slice().sort((x, y) => y.rating - x.rating || (y.e.goals - x.e.goals))[0] || null;
  const train = [];
  for (const x of mine.slice().sort((p, q) => p.rating - q.rating)) {
    if (train.length >= MAX_TRAIN) break;
    const t = trainFor(x.role, x.e, ga, energy.get(side + '|' + x.name));
    if (t) train.push(Object.assign({ id: x.id, name: x.name, pos: x.pos }, t));
  }
  const team = s => ({ poss: tp ? pct(s.poss || 0, tp) : 50, shots: s.shots || 0, onTarget: s.onTarget || 0, passes: s.passes || 0, passOk: s.passOk || 0, corners: s.corners || 0, fouls: s.fouls || 0, yellow: s.yellow || 0, red: s.red || 0 });
  return {
    matchId: m.id, at: m.at, side, result: res,
    comp: m.league ? m.league.name + (m.league.stage ? ' · ' + m.league.stage : '') : 'Amistoso',
    home: { id: m.home.id, name: m.home.name, color: m.homeDef.colors.shirt }, away: { id: m.away.id, name: m.away.name, color: m.awayDef.colors.shirt },
    score: m.score, pens: m.pens || null,
    goals: (m.goals || []).map(g => ({ min: g.min, side: g.side, player: g.player, og: g.og, assist: g.assist || null, kind: g.kind || null })),
    team: { mine: team(h), theirs: team(a) },
    motm: motm ? { name: motm.name, side: motm.side, rating: motm.rating, mine: motm.side === side } : null,
    players: mine.map(x => ({ id: x.id, name: x.name, pos: x.pos, role: x.role, sub: x.sub, rating: x.rating, tags: highlights(x.role, x.e, ga) })),
    best: mine.filter(x => x.rating >= 7).slice(0, 3).map(x => ({ id: x.id, name: x.name, rating: x.rating, why: highlights(x.role, x.e, ga).join(' · ') || 'boa atuação' })),
    worst: mine.filter(x => x.rating < 6).slice(-2).reverse().map(x => ({ id: x.id, name: x.name, rating: x.rating })),
    train,
    notes: notes || [],
    extra
  };
}

module.exports = { build, trainFor, FOCUS };
