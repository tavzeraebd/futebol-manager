/*
 * Estrutura do clube: instalações com níveis de 1 a 5, compradas com o saldo do clube (funções puras).
 * - Centro de Treinamento (ct): o treino rende +10% por nível acima do 1; a partir do nível 4, 3 sessões por dia.
 * - Departamento médico (med): condição volta +1% por hora por nível (em descanso, o dobro), lesões duram 10% menos por nível
 *   e a fisioterapia fica 10% mais barata por nível.
 * - Estádio (stadium): bilheteria em cada partida oficial jogada em casa.
 * Os efeitos viram um objeto `mods` que o treino e a condição física usam (training.js).
 */
const TR = require('./training');

const MAX_LEVEL = 5;
const COST = [0, 15e6, 30e6, 60e6, 100e6];       // COST[nível atual] = preço para subir ao próximo
const TICKETS = [0, 0, 2e6, 4e6, 6e6, 9e6];        // bilheteria por jogo oficial em casa, por nível

const FACILITIES = {
  ct: { name: 'Centro de Treinamento', icon: '🏋️', about: 'Treino rende mais e, a partir do nível 4, cada jogador treina 3 vezes por dia.' },
  med: { name: 'Departamento médico', icon: '🩺', about: 'Condição física volta mais rápido, lesões duram menos e a fisioterapia fica mais barata.' },
  stadium: { name: 'Estádio', icon: '🏟️', about: 'Bilheteria em cada partida oficial jogada em casa (quem desafia é o mandante).' }
};

const levelOf = (fac, key) => Math.max(1, Math.min(MAX_LEVEL, (fac && fac[key]) || 1));
const round2 = v => Math.round(v * 100) / 100; // 1 - 0.1 * 3 dá 0.6999...

/** Efeitos das instalações no treino e na condição física. */
function mods(fac) {
  const ct = levelOf(fac, 'ct'), med = levelOf(fac, 'med');
  return {
    gain: round2(1 + 0.1 * (ct - 1)),
    sessions: TR.SESSIONS_PER_DAY + (ct >= 4 ? 1 : 0),
    recovery: TR.RECOVERY + (med - 1),
    rest: 2 * (TR.RECOVERY + (med - 1)),
    injury: round2(1 - 0.1 * (med - 1)),
    physio: round2(1 - 0.1 * (med - 1))
  };
}

const tickets = fac => TICKETS[levelOf(fac, 'stadium')];
const upgradeCost = (fac, key) => (levelOf(fac, key) >= MAX_LEVEL ? null : COST[levelOf(fac, key)]);

/** Texto do efeito de uma instalação num nível (para a tela). */
function effect(key, level) {
  const f = { ct: level, med: level, stadium: level };
  const m = mods(f);
  const pct = v => Math.round(Math.abs(v) * 100) + '%';
  if (key === 'ct') return (m.gain > 1 ? 'Treino rende +' + pct(m.gain - 1) : 'Treino sem bônus') + ' · ' + m.sessions + ' sessões por dia';
  if (key === 'med') return 'Recupera ' + m.recovery + '% por hora (' + m.rest + '% em descanso)' + (m.injury < 1 ? ' · lesões ' + pct(1 - m.injury) + ' mais curtas · fisioterapia ' + pct(1 - m.physio) + ' mais barata' : '');
  const t = TICKETS[level];
  return t ? 'Bilheteria de € ' + t / 1e6 + ' M por jogo oficial em casa' : 'Sem bilheteria';
}

/** Regras para a tela: instalações, efeito de cada nível e preços. */
const meta = () => ({
  maxLevel: MAX_LEVEL, cost: COST,
  list: Object.keys(FACILITIES).map(key => Object.assign({ key }, FACILITIES[key], { effects: [1, 2, 3, 4, 5].map(l => effect(key, l)) }))
});

module.exports = { FACILITIES, MAX_LEVEL, COST, TICKETS, levelOf, mods, tickets, upgradeCost, effect, meta, BASE: mods({}) };
