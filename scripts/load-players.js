/*
 * Carga em massa de jogadores (Wikidata -> tabela imported_players do Supabase): principais ligas e seleções.
 * Uso: node scripts/load-players.js [--refresh] [--only=nome-da-liga]
 *   --refresh  rebusca também os jogadores já guardados (por padrão eles são pulados; dá para interromper e continuar)
 * Precisa de SUPABASE_SERVICE_ROLE_KEY (ou config.local.json). Leva alguns minutos: consulta o Wikidata com calma.
 */
const { createStore } = require('../server/store');
const wd = require('../server/providers/wikidata');

const FOOTBALLER = 'wd:Q937857', CLUB = 'wd:Q476028';
const BORN_AFTER = '"1985-01-01T00:00:00Z"^^xsd:dateTime';
const NT_BORN_AFTER = '"1988-01-01T00:00:00Z"^^xsd:dateTime';
const BATCH = 40;

// [nome, QID da liga, máximo de jogadores (os mais famosos)]
const LEAGUES = [
  ['Premier League', 'Q9448', 600], ['La Liga', 'Q324867', 600], ['Serie A', 'Q15804', 600], ['Bundesliga', 'Q82595', 600],
  ['Ligue 1', 'Q13394', 600], ['Brasileirão Série A', 'Q206813', 600], ['Brasileirão Série B', 'Q610175', 350],
  ['Primeira Liga', 'Q182994', 400], ['Eredivisie', 'Q167541', 350], ['Argentina Primera', 'Q223170', 400], ['MLS', 'Q18543', 400],
  ['Saudi Pro League', 'Q255633', 350], ['Süper Lig', 'Q485568', 350], ['Scottish Premiership', 'Q14377162', 250],
  ['Belgian Pro League', 'Q216022', 300], ['Liga MX', 'Q764690', 350], ['Uruguay Primera', 'Q287453', 250]
];
const COUNTRIES = ['Brazil', 'Argentina', 'France', 'England', 'Germany', 'Spain', 'Portugal', 'Italy', 'Netherlands', 'Belgium', 'Croatia', 'Uruguay', 'Colombia',
  'Mexico', 'United States', 'Morocco', 'Japan', 'South Korea', 'Senegal', 'Switzerland', 'Denmark', 'Poland', 'Serbia', 'Chile', 'Ecuador', 'Paraguay', 'Peru',
  'Venezuela', 'Nigeria', 'Egypt', 'Ghana', 'Cameroon', 'Ivory Coast', 'Algeria', 'Tunisia', 'Turkey', 'Ukraine', 'Sweden', 'Norway', 'Austria', 'Scotland', 'Wales',
  'Czech Republic', 'Canada', 'Australia', 'Saudi Arabia', 'Iran'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, what) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 4) { console.log('  ! desisti de ' + what + ': ' + e.message); return null; }
      await sleep(3000 * i * i);
    }
  }
}
const ids = rows => rows.map(r => wd.qid(r.p.value));

async function leagueIds([name, league, max]) {
  const q = `SELECT DISTINCT ?p ?sl WHERE { ?club wdt:P118 wd:${league} ; wdt:P31 ${CLUB} .
    ?p wdt:P106 ${FOOTBALLER} ; wdt:P569 ?d ; p:P54 ?st . ?st ps:P54 ?club .
    FILTER(?d >= ${BORN_AFTER}) FILTER NOT EXISTS { ?st pq:P582 ?e } ?p wikibase:sitelinks ?sl } ORDER BY DESC(?sl) LIMIT ${max}`;
  return retry(async () => ids(await wd.sparql(q)), name);
}

/** Acha a seleção principal masculina de um país pelo nome. */
async function nationalTeam(country) {
  const url = 'https://www.wikidata.org/w/api.php?' + new URLSearchParams({ action: 'wbsearchentities', search: country + ' national football team', language: 'en', limit: '8', format: 'json' });
  const res = await retry(async () => (await fetch(url, { headers: { 'User-Agent': 'FutebolManagerGame/1.0' }, signal: AbortSignal.timeout(15000) })).json(), country);
  const hit = res && res.search.find(x => /national (association )?(football|soccer) team$/i.test(x.label || '') && !/women|under|U-?\d|olympic|B team|amateur/i.test(x.label + ' ' + (x.description || '')));
  return hit ? hit.id : null;
}
async function nationalIds(country) {
  const team = await nationalTeam(country);
  if (!team) { console.log('  ? sem seleção para ' + country); return []; }
  const q = `SELECT DISTINCT ?p ?sl WHERE { ?p wdt:P106 ${FOOTBALLER} ; wdt:P54 wd:${team} ; wdt:P569 ?d ; wikibase:sitelinks ?sl . FILTER(?d >= ${NT_BORN_AFTER}) } ORDER BY DESC(?sl) LIMIT 45`;
  return (await retry(async () => ids(await wd.sparql(q)), country + ' (seleção)')) || [];
}

(async () => {
  const refresh = process.argv.includes('--refresh');
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).toLowerCase();
  const store = createStore();
  const have = new Set();
  if (!refresh) for (let from = 0; ; from += 1000) {
    const { data, error } = await store.sb.from('imported_players').select('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    data.forEach(r => have.add(r.id));
    if (data.length < 1000) break;
  }
  console.log('Já guardados (pulados): ' + have.size);

  const wanted = new Map(); // QID -> origem
  for (const l of LEAGUES) {
    if (only && !l[0].toLowerCase().includes(only)) continue;
    const got = (await leagueIds(l)) || [];
    got.forEach(id => wanted.has(id) || wanted.set(id, l[0]));
    console.log(l[0].padEnd(22) + got.length + ' jogadores');
    await sleep(1500);
  }
  if (!only) for (const c of COUNTRIES) {
    const got = await nationalIds(c);
    got.forEach(id => wanted.has(id) || wanted.set(id, 'seleção ' + c));
    console.log(('Seleção ' + c).padEnd(22) + got.length + ' jogadores');
    await sleep(1000);
  }

  const todo = [...wanted.keys()].filter(id => refresh || !have.has('wd-' + id));
  console.log('\nÚnicos: ' + wanted.size + ' · a baixar: ' + todo.length);
  let saved = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const players = await retry(() => wd.loadPlayers(part), 'lote ' + (i / BATCH + 1));
    if (players && players.length) {
      await store.upsert('imported_players', players.map(p => ({ id: p.id, name: p.name, club: p.club, data: p, updated_at: new Date().toISOString() })));
      saved += players.length;
    }
    if ((i / BATCH) % 5 === 4 || i + BATCH >= todo.length) console.log('  lote ' + Math.min(todo.length, i + BATCH) + '/' + todo.length + ' · gravados ' + saved);
    await sleep(1200);
  }
  const total = (await store.sb.from('imported_players').select('*', { count: 'exact', head: true })).count;
  console.log('\nConcluído. imported_players no Supabase: ' + total);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
