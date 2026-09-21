/*
 * Adaptador da API do Sofascore (não oficial).
 *
 * ATENÇÃO: o Sofascore protege a API contra acesso automatizado (retorna 403) e o uso dos
 * dados é regido pelos termos deles. Este adaptador NÃO tenta burlar essa proteção; ele só
 * funciona se você tiver acesso permitido (por exemplo, um proxy/licença próprios apontados
 * por SOFASCORE_BASE, com cabeçalhos extras em SOFASCORE_HEADERS como JSON).
 *
 * Endpoints usados (formato conhecido do site, podem mudar sem aviso; não verificados aqui):
 *   GET /search/players?q=...                 busca por nome
 *   GET /player/{id}                          dados do jogador (posição, valor, idade, altura...)
 *   GET /player/{id}/attribute-overviews      atributos 0-100 (ataque, técnica, tática, defesa, criatividade)
 *   GET /team/{id}/players                    elenco de um time
 */
const BASE = process.env.SOFASCORE_BASE || 'https://api.sofascore.com/api/v1';
const EXTRA = process.env.SOFASCORE_HEADERS ? JSON.parse(process.env.SOFASCORE_HEADERS) : {};

class SofascoreError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function get(path) {
  let res;
  try {
    res = await fetch(BASE + path, { headers: Object.assign({ Accept: 'application/json' }, EXTRA), signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new SofascoreError('Sem conexão com o Sofascore (' + (e.name === 'TimeoutError' ? 'tempo esgotado' : e.message) + ')', 0);
  }
  if (!res.ok) throw new SofascoreError('Sofascore respondeu HTTP ' + res.status, res.status);
  return res.json();
}

const POS_MAP = { G: 'GK', D: 'CB', M: 'CM', F: 'ST' };
const ROLE = { GK: 'GK', CB: 'DEF', RB: 'DEF', LB: 'DEF', RWB: 'DEF', LWB: 'DEF', DM: 'MID', CM: 'MID', AM: 'MID', RM: 'MID', LM: 'MID', RW: 'FWD', LW: 'FWD', ST: 'FWD' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Sem atributos disponíveis, estima pela faixa de valor de mercado (1M≈62, 10M≈75, 100M≈88). */
const ovrFromValue = v => Math.round(clamp(62 + 13 * Math.log10(Math.max(1, v / 1e6)), 55, 93));

const WEIGHTS = {
  GK:  { attacking: 0.05, technical: 0.2, tactical: 0.35, defending: 0.3, creativity: 0.1 },
  DEF: { attacking: 0.05, technical: 0.15, tactical: 0.25, defending: 0.45, creativity: 0.1 },
  MID: { attacking: 0.1, technical: 0.3, tactical: 0.2, defending: 0.1, creativity: 0.3 },
  FWD: { attacking: 0.4, technical: 0.25, tactical: 0.1, defending: 0.05, creativity: 0.2 }
};
/** Atributos Sofascore (0-100) -> nota geral do jogo. */
function ovrFromAttrs(a, role) {
  const w = WEIGHTS[role];
  let s = 0, t = 0;
  for (const k of Object.keys(w)) if (typeof a[k] === 'number') { s += a[k] * w[k]; t += w[k]; }
  return t ? Math.round(clamp(s / t * 0.75 + 30, 55, 95)) : null;
}

function mapPlayer(p, attrs) {
  const detailed = p.positionsDetailed && p.positionsDetailed[0];
  const pos = ROLE[detailed] ? detailed : POS_MAP[p.position] || 'CM';
  const role = ROLE[pos];
  const raw = p.proposedMarketValueRaw && p.proposedMarketValueRaw.value;
  const value = raw || 0;
  const cleanAttrs = attrs && Object.values(attrs).some(v => typeof v === 'number') ? attrs : null;
  const ovr = (cleanAttrs && ovrFromAttrs(cleanAttrs, role)) || ovrFromValue(value || 1e6);
  return {
    id: 'ss-' + p.id, sofascoreId: p.id, source: 'sofascore',
    name: p.name, short: p.shortName || p.name.split(' ').slice(-1)[0],
    club: (p.team && p.team.name) || '—', pos, role,
    value: value || Math.round(Math.pow(10, (ovr - 62) / 13) * 1e6), valueEstimated: !value,
    ovr, attrs: cleanAttrs,
    age: p.dateOfBirthTimestamp ? Math.floor((Date.now() / 1000 - p.dateOfBirthTimestamp) / 31557600) : null,
    height: p.height || null, foot: p.preferredFoot || null,
    country: (p.country && p.country.name) || null, number: p.jerseyNumber || null
  };
}

/** Busca jogadores pelo nome (ex.: "Igor"): devolve os resultados básicos. */
async function searchPlayers(q) {
  const d = await get('/search/players?q=' + encodeURIComponent(q));
  const list = (d.results || d.players || []).map(r => r.entity || r.player || r);
  return list.filter(e => e && e.id && e.name);
}

/** Dados completos + atributos de um jogador. */
async function playerFull(id) {
  const d = await get('/player/' + id);
  let attrs = null;
  try {
    const a = await get('/player/' + id + '/attribute-overviews');
    const o = (a.averageAttributeOverviews && a.averageAttributeOverviews[0]) || (a.playerAttributeOverviews && a.playerAttributeOverviews[0]);
    if (o) attrs = { attacking: o.attacking, technical: o.technical, tactical: o.tactical, defending: o.defending, creativity: o.creativity };
  } catch (_) { /* jogador sem atributos: usa estimativa por valor */ }
  return mapPlayer(d.player, attrs);
}

async function fetchTeamPlayers(teamId, clubName) {
  const data = await get('/team/' + teamId + '/players');
  return data.players.map(x => x.player || x).map(p => Object.assign(mapPlayer(p, null), { club: clubName })).filter(p => !p.valueEstimated);
}

module.exports = { searchPlayers, playerFull, fetchTeamPlayers, SofascoreError, ovrFromAttrs };
