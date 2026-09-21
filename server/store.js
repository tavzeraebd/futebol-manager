/*
 * Persistência no Supabase (Postgres). O servidor continua trabalhando com o objeto `db` em memória
 * ({ clubs, matches, leagues, trades }); este módulo carrega o estado na partida e grava só o que mudou
 * (diff por linha) em segundo plano, em ordem e com nova tentativa se falhar.
 *
 * Configuração: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (variáveis de ambiente ou config.local.json:
 * { "supabaseUrl": "...", "supabaseServiceRoleKey": "..." }). A chave service_role nunca vai para o navegador.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const KEEP_MATCHES = 300, KEEP_TRADES = 400, PAGE = 1000, CHUNK = 200, FLUSH_DELAY = 80;

function settings() {
  let local = {};
  try { local = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8')); } catch (_) { /* opcional */ }
  return {
    url: process.env.SUPABASE_URL || local.supabaseUrl || 'https://huqgozqeiizqzpnjihlk.supabase.co',
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || local.supabaseServiceRoleKey || null
  };
}

const iso = ms => new Date(ms || 0).toISOString();
const ms = s => new Date(s).getTime();

/* ---------- objeto do jogo <-> linhas ---------- */
const clubRow = c => ({
  id: c.id, name: c.name, manager: c.manager, color: c.color, budget: c.budget, formation: c.formation, coach: c.coach || null,
  lineup: c.lineup, tactic: c.tactic || 'balanced', plan: c.plan || [], points: c.points, played: c.played, w: c.w, d: c.d, l: c.l, gf: c.gf, ga: c.ga,
  pass_hash: c.passHash || null, google_sub: c.google ? c.google.sub : null, google_email: c.google ? c.google.email || null : null,
  google_name: c.google ? c.google.name || null : null, sessions: c.sessions || [], created_at: iso(c.createdAt)
});
const clubFrom = r => ({
  id: r.id, sessions: r.sessions, passHash: r.pass_hash, google: r.google_sub ? { sub: r.google_sub, email: r.google_email, name: r.google_name } : null,
  name: r.name, manager: r.manager, color: r.color, budget: Number(r.budget), squad: [], coach: r.coach, formation: r.formation, lineup: r.lineup,
  tactic: r.tactic, plan: r.plan, points: r.points, played: r.played, w: r.w, d: r.d, l: r.l, gf: r.gf, ga: r.ga, createdAt: ms(r.created_at)
});

const matchRow = m => ({
  id: m.id, seed: m.seed, engine: m.engine || null, played_at: iso(m.at), cpu: !!m.cpu, knockout: !!m.knockout,
  home_club_id: m.home.id || null, home_name: m.home.name, away_club_id: m.away.id || null, away_name: m.away.name,
  home_def: m.homeDef, away_def: m.awayDef, score: m.score, goals: m.goals || [], stats: m.stats || null, pens: m.pens || null,
  winner: m.winner || null, league_id: m.league ? m.league.id : null, league_name: m.league ? m.league.name : null, stage: m.league ? m.league.stage || null : null
});
const matchFrom = r => ({
  id: r.id, seed: Number(r.seed), engine: r.engine, at: ms(r.played_at), cpu: r.cpu, knockout: r.knockout,
  home: { id: r.home_club_id, name: r.home_name }, away: { id: r.away_club_id, name: r.away_name },
  homeDef: r.home_def, awayDef: r.away_def, score: r.score, goals: r.goals, stats: r.stats, pens: r.pens, winner: r.winner,
  league: r.league_id ? { id: r.league_id, name: r.league_name, stage: r.stage } : null
});

const leagueRow = l => ({
  id: l.id, code: l.code, name: l.name, format: l.format, rounds: l.rounds, owner_id: l.owner || null, status: l.status,
  advancing: l.advancing || [], champion_id: l.champion || null, runner_up_id: l.runnerUp || null, chat: l.chat || [], created_at: iso(l.createdAt)
});
const fixtureRow = (l, f, i) => ({
  id: f.id, league_id: l.id, position: i, round: f.round, stage: f.stage, home_id: f.home, away_id: f.away, match_id: f.matchId || null,
  score: f.score || null, pens: f.pens || null, winner_id: f.winner || null, goals: f.goals || []
});
const fixtureFrom = r => ({ id: r.id, round: r.round, stage: r.stage, home: r.home_id, away: r.away_id, matchId: r.match_id, score: r.score, pens: r.pens, winner: r.winner_id, goals: r.goals });

const tradeRow = t => ({
  id: t.id, from_club_id: t.from, to_club_id: t.to, give: t.give, get_items: t.get, cash: t.cash, status: t.status, why: t.why || null, created_at: iso(t.at)
});
const tradeFrom = r => {
  const t = { id: r.id, from: r.from_club_id, to: r.to_club_id, give: r.give, get: r.get_items, cash: Number(r.cash), status: r.status, at: ms(r.created_at) };
  if (r.why) t.why = r.why;
  return t;
};

function createStore() {
  const cfg = settings();
  if (!cfg.key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY (variável de ambiente ou "supabaseServiceRoleKey" em config.local.json).');
  const sb = createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });

  const ok = (what, { error, data }) => { if (error) throw new Error(what + ': ' + error.message); return data; };

  async function all(table, build) { // pagina: o PostgREST devolve no máximo 1000 linhas por consulta
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const rows = ok(table, await build(sb.from(table).select('*')).range(from, from + PAGE - 1));
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  }
  async function upsert(table, rows, onConflict) {
    for (let i = 0; i < rows.length; i += CHUNK) ok('upsert ' + table, await sb.from(table).upsert(rows.slice(i, i + CHUNK), onConflict ? { onConflict } : undefined));
  }
  const delIn = async (table, col, ids) => { for (let i = 0; i < ids.length; i += CHUNK) ok('delete ' + table, await sb.from(table).delete().in(col, ids.slice(i, i + CHUNK))); };

  /* ---------- estado sincronizado (para o diff) ---------- */
  const seen = { clubs: new Map(), squads: new Map(), leagues: new Map(), members: new Map(), fixtures: new Map(), trades: new Map(), matches: new Set() };

  async function load() {
    const db = { clubs: {}, matches: [], leagues: {}, trades: [] };
    for (const r of await all('clubs', q => q.order('created_at'))) db.clubs[r.id] = clubFrom(r);
    for (const r of await all('club_players', q => q.order('club_id').order('position'))) if (db.clubs[r.club_id]) db.clubs[r.club_id].squad.push(r.player_id);
    const ms_ = ok('matches', await sb.from('matches').select('*').order('played_at', { ascending: false }).limit(KEEP_MATCHES));
    db.matches = ms_.reverse().map(matchFrom);
    for (const r of await all('leagues', q => q.order('created_at'))) db.leagues[r.id] = Object.assign(leagueFrom(r), { members: [], fixtures: [] });
    for (const r of await all('league_members', q => q.order('league_id').order('position'))) if (db.leagues[r.league_id]) db.leagues[r.league_id].members.push(r.club_id);
    for (const r of await all('league_fixtures', q => q.order('league_id').order('position'))) if (db.leagues[r.league_id]) db.leagues[r.league_id].fixtures.push(fixtureFrom(r));
    const tr = ok('trades', await sb.from('trades').select('*').order('created_at', { ascending: false }).limit(KEEP_TRADES));
    db.trades = tr.reverse().map(tradeFrom);
    // marca tudo o que acabou de ser carregado como já gravado
    const snap = computeRows(db);
    for (const k of Object.keys(snap)) seen[k] = new Map([...snap[k]].map(([id, x]) => [id, x.json]));
    seen.matches = new Set(db.matches.map(m => m.id));
    return db;
  }

  function leagueFrom(r) {
    return { id: r.id, code: r.code, name: r.name, format: r.format, rounds: r.rounds, owner: r.owner_id, status: r.status, advancing: r.advancing,
      champion: r.champion_id, runnerUp: r.runner_up_id, chat: r.chat, createdAt: ms(r.created_at) };
  }

  /** Linhas atuais por tabela: Map(id -> { row, json }). Filhos (elenco, membros) são gravados em bloco por pai. */
  function computeRows(db) {
    const wrap = (map, id, row) => map.set(id, { row, json: JSON.stringify(row) });
    const out = { clubs: new Map(), squads: new Map(), leagues: new Map(), members: new Map(), fixtures: new Map(), trades: new Map() };
    for (const c of Object.values(db.clubs)) {
      wrap(out.clubs, c.id, clubRow(c));
      wrap(out.squads, c.id, c.squad.map((p, i) => ({ club_id: c.id, player_id: p, position: i })));
    }
    for (const l of Object.values(db.leagues)) {
      wrap(out.leagues, l.id, leagueRow(l));
      wrap(out.members, l.id, l.members.map((c, i) => ({ league_id: l.id, club_id: c, position: i })));
      l.fixtures.forEach((f, i) => wrap(out.fixtures, f.id, fixtureRow(l, f, i)));
    }
    for (const t of db.trades) wrap(out.trades, t.id, tradeRow(t));
    return out;
  }

  const changed = (cur, old) => [...cur].filter(([id, x]) => old.get(id) !== x.json);

  async function writeDiff(db) {
    const cur = computeRows(db);
    const next = {};
    const upd = k => changed(cur[k], seen[k]);
    const clubsUp = upd('clubs'), squadsUp = upd('squads'), leaguesUp = upd('leagues'), membersUp = upd('members'), fixturesUp = upd('fixtures'), tradesUp = upd('trades');
    const newMatches = db.matches.filter(m => !seen.matches.has(m.id));

    await upsert('clubs', clubsUp.map(([, x]) => x.row));
    if (squadsUp.length) {
      await delIn('club_players', 'club_id', squadsUp.map(([id]) => id));
      await upsert('club_players', squadsUp.flatMap(([, x]) => x.row));
    }
    await upsert('matches', newMatches.map(matchRow));
    const goneLeagues = [...seen.leagues.keys()].filter(id => !cur.leagues.has(id));
    if (goneLeagues.length) await delIn('leagues', 'id', goneLeagues); // fixtures e members saem em cascata
    await upsert('leagues', leaguesUp.map(([, x]) => x.row));
    if (membersUp.length) {
      await delIn('league_members', 'league_id', membersUp.map(([id]) => id));
      await upsert('league_members', membersUp.flatMap(([, x]) => x.row));
    }
    await upsert('league_fixtures', fixturesUp.map(([, x]) => x.row));
    await upsert('trades', tradesUp.map(([, x]) => x.row));

    for (const k of ['clubs', 'squads', 'leagues', 'members', 'fixtures', 'trades']) {
      next[k] = new Map(seen[k]);
      for (const [id, x] of cur[k]) next[k].set(id, x.json);
      for (const id of [...next[k].keys()]) if (!cur[k].has(id)) next[k].delete(id);
    }
    Object.assign(seen, next);
    for (const m of newMatches) seen.matches.add(m.id);
  }

  /* ---------- gravação em segundo plano ---------- */
  let db = null, timer = null, running = null, dirty = false;
  async function flush() {
    if (running) { dirty = true; return running; }
    dirty = false;
    running = (async () => {
      try { await writeDiff(db); } catch (e) { console.error('[supabase] falha ao gravar (tentarei de novo):', e.message); dirty = true; }
    })();
    await running;
    running = null;
    if (dirty && !timer) { timer = setTimeout(() => { timer = null; flush(); }, 2000); if (timer.unref) timer.unref(); }
  }
  function attach(state) { db = state; }
  function save() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, FLUSH_DELAY);
  }
  async function flushNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    for (let i = 0; i < 3; i++) { await flush(); if (!dirty && !running) break; }
  }

  /* ---------- jogadores importados (busca ao vivo) ---------- */
  /** `since` (ISO): só os gravados depois disso. */
  async function loadImported(since) { return (await all('imported_players', q => (since ? q.gt('updated_at', since).order('updated_at') : q.order('name')))).map(r => r.data); }
  function saveImported(p) {
    sb.from('imported_players').upsert({ id: p.id, name: p.name, club: p.club || null, data: p, updated_at: new Date().toISOString() })
      .then(r => { if (r.error) console.error('[supabase] imported_players:', r.error.message); });
  }

  /* ---------- forma dos jogadores e técnicos ---------- */
  async function loadForm() { return new Map((await all('player_form', q => q.order('player_id'))).map(r => [r.player_id, r.delta])); }
  function saveForm(rows) { // rows: [[id, delta]]
    if (!rows.length) return;
    upsert('player_form', rows.map(([id, delta]) => ({ player_id: id, delta, updated_at: new Date().toISOString() })))
      .catch(e => console.error('[supabase] player_form:', e.message));
  }

  /* ---------- estatísticas por jogador e clube (artilharia, assistências...) ---------- */
  async function loadStats() { return all('player_stats', q => q.order('player_id')); }
  function saveStats(rows) {
    if (!rows.length) return;
    upsert('player_stats', rows.map(r => Object.assign({}, r, { updated_at: new Date().toISOString() }))).catch(e => console.error('[supabase] player_stats:', e.message));
  }

  return { sb, load, loadForm, saveForm, loadStats, saveStats, attach, save, flushNow, loadImported, saveImported, upsert, rows: { clubRow, matchRow, leagueRow, fixtureRow, tradeRow } };
}

module.exports = { createStore };
