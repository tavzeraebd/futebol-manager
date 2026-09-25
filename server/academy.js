/*
 * Categoria de base (funções puras). Toda semana (virada na segunda-feira, horário de Brasília) cada clube revela PER_WEEK
 * promessas da base: garotos de 16 a 19 anos, baratos e com nota modesta, que evoluem rápido no treino (até 21 anos o treino
 * rende 30% a mais, ver training.js). O Centro de Treinamento melhor revela promessas melhores. Quem não for contratado
 * na semana volta para a base (some da lista); o contratado vira jogador do catálogo e do elenco do clube.
 */
const { ROLE } = require('./seed');

const PER_WEEK = 3;
const TZ = 3 * 3600e3, DAY = 24 * 3600e3;
const FIRST = ['Gabriel', 'Lucas', 'Mateus', 'Pedro', 'Gustavo', 'Rafael', 'Kauã', 'Enzo', 'Davi', 'Arthur', 'Heitor', 'Bernardo', 'Miguel', 'João Pedro',
  'Vitor', 'Caio', 'Thiago', 'Luan', 'Igor', 'Wesley', 'Renan', 'Yuri', 'Breno', 'Ruan', 'Danilo', 'Samuel', 'Otávio', 'Nicolas', 'Eduardo', 'Felipe',
  'Kaio', 'Matheus Henrique', 'Endrick', 'Vinícius', 'Wallace', 'Ryan', 'Alisson', 'Marcos', 'Diego', 'Leandro'];
const LAST = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Pereira', 'Costa', 'Rodrigues', 'Almeida', 'Nascimento', 'Carvalho', 'Araújo', 'Ribeiro',
  'Gomes', 'Martins', 'Rocha', 'Barbosa', 'Moreira', 'Cardoso', 'Teixeira', 'Mendes', 'Freitas', 'Nunes', 'Batista', 'Pinto', 'Vieira', 'Moraes',
  'Campos', 'Duarte', 'Ramos'];
const POS = ['GK', 'CB', 'CB', 'RB', 'LB', 'DM', 'CM', 'CM', 'AM', 'RW', 'LW', 'ST', 'ST'];

/** Semana corrente (número inteiro; muda na segunda-feira à meia-noite de Brasília). */
const weekOf = now => Math.floor((now - TZ + 3 * DAY) / (7 * DAY)); // a época (1/1/1970) foi numa quinta

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; }

/** Valor de mercado de uma promessa (múltiplo de € 100 mil). */
const valueOf = (ovr, age) => Math.max(3e5, Math.round(0.4e6 * Math.pow(1.13, ovr - 55) * (age <= 17 ? 1.3 : age <= 18 ? 1.15 : 1) / 1e5) * 1e5);

/** Promessas da semana de um clube (determinístico pelo clube e pela semana; ct = nível do Centro de Treinamento). */
function prospects(club, week, ct) {
  const r = rng(hash(club.id + '|base|' + week));
  const out = [];
  for (let i = 0; i < PER_WEEK; i++) {
    const pos = POS[Math.floor(r() * POS.length)];
    const age = 16 + Math.floor(r() * 4);
    const ovr = Math.round(Math.min(74, 54 + r() * 10 + (ct - 1) * 1.5 + (r() < 0.12 ? 4 : 0))); // de vez em quando, uma joia
    const first = FIRST[Math.floor(r() * FIRST.length)], last = LAST[Math.floor(r() * LAST.length)];
    const pot = Math.max(1, Math.min(5, Math.round((ovr - 52) / 4 + (19 - age) * 0.5 + r())));
    out.push({
      id: 'base-' + String(club.id).slice(0, 8) + '-' + week + '-' + i, name: first + ' ' + last, short: last, pos, role: ROLE[pos], age, ovr,
      value: valueOf(ovr, age), potential: pot, country: 'Brasil'
    });
  }
  return out;
}

/** Lista da semana para a tela: promessas ainda não contratadas (club.extra.academy guarda quem já foi). */
function list(club, now, ct) {
  const week = weekOf(now);
  const a = (club.extra && club.extra.academy) || {};
  const signed = a.week === week ? a.signed || [] : [];
  return { week, next: (week + 1) * 7 * DAY - 3 * DAY + TZ, players: prospects(club, week, ct).filter(p => !signed.includes(p.id)) };
}

/** Marca como contratado e devolve o jogador pronto para o catálogo (ou null se não está na lista desta semana). */
function sign(club, id, now, ct) {
  const { week, players } = list(club, now, ct);
  const p = players.find(x => x.id === id);
  if (!p) return null;
  if (!club.extra) club.extra = {};
  const a = club.extra.academy && club.extra.academy.week === week ? club.extra.academy : { week, signed: [] };
  a.signed = (a.signed || []).concat(id);
  club.extra.academy = a;
  return { id: p.id, name: p.name, short: p.short, club: 'Base do ' + club.name, pos: p.pos, role: p.role, value: p.value, ovr: p.ovr, age: p.age, country: p.country, source: 'academy', potential: p.potential };
}

module.exports = { PER_WEEK, weekOf, prospects, list, sign, valueOf };
