/*
 * Provedor de jogadores pelo Wikidata (dados abertos, sem chave): qualquer jogador de futebol do mundo, com foto do
 * Wikimedia Commons (licença livre), posição, clube atual, nacionalidade, altura e nascimento.
 *
 * O Wikidata não tem valor de mercado nem notas de atributos. Estimamos a nota pela fama (quantidade de edições da
 * Wikipédia sobre o jogador) e o valor pela nota; esses jogadores ficam marcados como estimados na tela.
 *
 *   busca:  api.php?action=query&list=search&srsearch=<nome> haswbstatement:P106=Q937857   (ocupação: jogador de futebol)
 *   dados:  query.wikidata.org/sparql  (um pedido só para todos os candidatos)
 */
const API = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const UA = process.env.WIKIDATA_USER_AGENT || 'FutebolManagerGame/1.0 (https://github.com/tavzeraebd/futebol-manager)';
const CANDIDATES = 50; // resultados de texto examinados por busca
const KEEP = 15;       // jogadores devolvidos por busca (os mais famosos)

class WikidataError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function getJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }, opts));
  } catch (e) {
    throw new WikidataError('Sem conexão com o Wikidata (' + (e.name === 'TimeoutError' ? 'tempo esgotado' : e.message) + ')', 0);
  }
  if (!res.ok) throw new WikidataError('Wikidata respondeu HTTP ' + res.status, res.status);
  return res.json();
}

const ROLE = { GK: 'GK', CB: 'DEF', RB: 'DEF', LB: 'DEF', RWB: 'DEF', LWB: 'DEF', DM: 'MID', CM: 'MID', AM: 'MID', RM: 'MID', LM: 'MID', RW: 'FWD', LW: 'FWD', ST: 'FWD' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Posição (rótulo em inglês do Wikidata) -> posição do jogo. */
function posFromLabel(label) {
  const s = String(label || '').toLowerCase();
  if (/goalkeeper/.test(s)) return 'GK';
  if (/left.?(back|wing-back)/.test(s)) return /wing/.test(s) ? 'LWB' : 'LB';
  if (/right.?(back|wing-back)/.test(s)) return /wing/.test(s) ? 'RWB' : 'RB';
  if (/centre.?back|center.?back|central defender|sweeper|stopper/.test(s)) return 'CB';
  if (/defensive midfielder|holding|anchor/.test(s)) return 'DM';
  if (/attacking midfielder|playmaker|trequartista|second striker|shadow/.test(s)) return 'AM';
  if (/left.?(winger|midfielder|wing)/.test(s)) return 'LW';
  if (/right.?(winger|midfielder|wing)/.test(s)) return 'RW';
  if (/winger/.test(s)) return 'RW';
  if (/striker|forward|centre.?forward|center.?forward/.test(s)) return 'ST';
  if (/midfield/.test(s)) return 'CM';
  if (/defen[cs]e?|defender|full.?back|back/.test(s)) return 'CB';
  return null;
}

/** Fama (edições da Wikipédia) -> nota geral 0-100, no mesmo intervalo do catálogo local. */
function ovrFromFame(sitelinks, retired) {
  const n = Math.max(1, sitelinks || 1);
  return Math.round(clamp(49 + 5.6 * Math.log2(n + 1) - (retired ? 4 : 0), 52, 93));
}
/** Mesma curva do adaptador do Sofascore: nota 75 ~ 10 M€, 88 ~ 100 M€. */
const valueFromOvr = ovr => Math.round(Math.pow(10, (ovr - 62) / 13) * 1e5) * 10;

const NATIONAL = /national|sele[çc][ãa]o|selecci[óo]n|nazionale|under-?\d|sub-?\d|\bU-?\d{2}\b|olympic|ol[íi]mpic/i;
const qid = uri => uri.slice(uri.lastIndexOf('/') + 1);

/** Junta as linhas do SPARQL (várias por jogador) num jogador do jogo. */
function buildPlayer(id, rows) {
  const first = rows[0];
  const uniq = (key, val = r => r[key] && r[key].value) => [...new Set(rows.map(val).filter(Boolean))];
  const name = first.name ? first.name.value : id;
  if (/^Q\d+$/.test(name)) return null; // sem rótulo legível
  const clubs = new Map();
  for (const r of rows) if (r.club && r.clubName && !r.end && !NATIONAL.test(r.clubName.value)) {
    const start = r.start ? r.start.value : '';
    if (!clubs.has(r.club.value) || start > clubs.get(r.club.value).start) clubs.set(r.club.value, { name: r.clubName.value, start });
  }
  const current = [...clubs.values()].sort((a, b) => (b.start > a.start) - (b.start < a.start))[0];
  const retired = !current || !!(first.death);
  const GENERIC = ['ST', 'CB', 'CM']; // posições amplas só valem se não houver uma específica (ex.: ponta, lateral)
  const found = uniq('posName').map(posFromLabel).filter(Boolean);
  const pos = found.find(x => !GENERIC.includes(x)) || found.find(x => x === 'ST') || found[0] || 'CM';
  const dob = first.dob ? new Date(first.dob.value) : null;
  const age = dob && !isNaN(dob) ? Math.floor(((first.death ? new Date(first.death.value) : Date.now()) - dob) / 31557600000) : null;
  let height = first.height ? +first.height.value : null;
  if (height && height < 3) height *= 100; // veio em metros
  const sitelinks = +(first.sl ? first.sl.value : 1);
  const ovr = ovrFromFame(sitelinks, retired);
  const img = uniq('img')[0];
  return {
    id: 'wd-' + id, wikidataId: id, source: 'wikidata',
    name, short: name.split(/\s+/).slice(-1)[0],
    club: current ? current.name : 'Sem clube', pos, role: ROLE[pos],
    value: valueFromOvr(ovr), valueEstimated: true, ovr, attrs: null,
    age: age && age > 0 && age < 70 ? age : null, height: height ? Math.round(height) : null, foot: null,
    country: uniq('natName')[0] || null, number: null,
    photo: img ? img.replace(/^http:/, 'https:').replace(/\?.*$/, '') + '?width=240' : null,
    retired: retired || undefined
  };
}

function sparqlFor(ids) {
  return `SELECT ?p ?name ?posName ?club ?clubName ?start ?end ?natName ?dob ?death ?height ?img ?sl WHERE {
  VALUES ?p { ${ids.map(i => 'wd:' + i).join(' ')} }
  ?p wikibase:sitelinks ?sl .
  OPTIONAL { ?p wdt:P413 ?pos . ?pos rdfs:label ?posName . FILTER(LANG(?posName) = "en") }
  OPTIONAL { ?p p:P54 ?st . ?st ps:P54 ?club . ?club rdfs:label ?clubName . FILTER(LANG(?clubName) = "pt" || LANG(?clubName) = "en")
             OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end } }
  OPTIONAL { ?p wdt:P27 ?nat . ?nat rdfs:label ?natName . FILTER(LANG(?natName) = "pt") }
  OPTIONAL { ?p wdt:P569 ?dob } OPTIONAL { ?p wdt:P570 ?death }
  OPTIONAL { ?p wdt:P2048 ?height } OPTIONAL { ?p wdt:P18 ?img }
  OPTIONAL { ?p rdfs:label ?nlPt . FILTER(LANG(?nlPt) = "pt") }
  OPTIONAL { ?p rdfs:label ?nlEn . FILTER(LANG(?nlEn) = "en") }
  BIND(COALESCE(?nlPt, ?nlEn) AS ?name)
}`;
}

/** Busca por nome e devolve até KEEP jogadores completos (os mais famosos primeiro). */
async function searchPlayers(q) {
  const s = await getJson(API + '?' + new URLSearchParams({
    action: 'query', list: 'search', srsearch: q + ' haswbstatement:P106=Q937857', srlimit: String(CANDIDATES), srnamespace: '0', format: 'json'
  }));
  const ids = ((s.query && s.query.search) || []).map(x => x.title).filter(t => /^Q\d+$/.test(t));
  if (!ids.length) return [];
  const d = await getJson(SPARQL + '?' + new URLSearchParams({ query: sparqlFor(ids), format: 'json' }), { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  const byId = new Map();
  for (const r of d.results.bindings) {
    const id = qid(r.p.value);
    if (r.clubName) r.clubName.value = r.clubName.value.replace(/\s+$/, '');
    (byId.get(id) || byId.set(id, []).get(id)).push(r);
  }
  const players = [];
  for (const [id, rows] of byId) {
    const p = buildPlayer(id, rows);
    if (p) players.push({ p, sl: +rows[0].sl.value });
  }
  return players.sort((a, b) => b.sl - a.sl).slice(0, KEEP).map(x => x.p);
}

module.exports = { searchPlayers, WikidataError, ovrFromFame, valueFromOvr, posFromLabel };
