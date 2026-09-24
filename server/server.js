/* Servidor do jogo: arquivos estáticos + API JSON + eventos em tempo real (SSE). Sem dependências. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { load } = require('./catalog');
const { createStore } = require('./store');
const R = require('./rules');
const ss = require('./providers/sofascore');
const wd = require('./providers/wikidata');
const FM = require('./form');
const PR = require('./pricing');
const TR = require('./training');
const FAC = require('./facilities');
const LG = require('./leagues');
const CH = require('./chat');
const { createExchange } = require('./exchange');
const E = require('../js/engine.js');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 3210;
const store = createStore();
let catalog, XC; // definidos em boot(), depois de carregar o banco

/* ---------- banco (Supabase) ---------- */
// O estado fica em memória (db) e o store grava no Supabase, em segundo plano, só as linhas que mudaram.
let db = { clubs: {}, matches: [], leagues: {}, trades: [] };
const save = () => store.save();
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
const clubs = () => Object.values(db.clubs);
const ownerOf = id => clubs().find(c => c.squad.includes(id) || c.coach === id);

/* ---------- tempo real ---------- */
const streams = new Map(); // clubId -> Set<res>
const challenges = new Map(); // id -> {id, from, to, at}
function push(clubId, type, data) {
  for (const res of streams.get(clubId) || []) res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function pushAll(type, data) { for (const id of streams.keys()) push(id, type, data); }
const online = id => (streams.get(id) || new Set()).size > 0;


/* ---------- visões públicas ---------- */
function publicClub(c) {
  const players = c.squad.map(id => catalog.playerById.get(id)).filter(Boolean);
  return {
    id: c.id, name: c.name, manager: c.manager, color: c.color, budget: c.budget, facilities: facilitiesOf(c),
    points: c.points, played: c.played, w: c.w, d: c.d, l: c.l, gf: c.gf, ga: c.ga,
    online: online(c.id), squadSize: players.length, squadValue: players.reduce((s, p) => s + p.value, 0)
  };
}
const facilitiesOf = c => ({ ct: FAC.levelOf(c.facilities, 'ct'), med: FAC.levelOf(c.facilities, 'med'), stadium: FAC.levelOf(c.facilities, 'stadium') });
/** Efeitos das instalações de um clube (e do clube dono de um jogador) no treino e na condição física. */
const modsOf = c => (c ? FAC.mods(c.facilities) : FAC.BASE);
const modsFor = id => modsOf(ownerOf(id));
function privateClub(c) {
  const now = Date.now(), m = modsOf(c);
  return Object.assign(publicClub(c), {
    squad: c.squad, coach: c.coach, formation: c.formation, lineup: c.lineup, tactic: c.tactic || 'balanced', plan: c.plan || [], google: c.google ? { email: c.google.email } : null, hasPassword: !!c.passHash,
    fitness: Object.fromEntries(c.squad.map(id => [id, TR.view(catalog.train.get(id), now, m)])), // condição física, descanso e treinos que restam hoje
    mods: m
  });
}
/** Condição física atual (0-100) de um jogador: entra na partida como energia inicial. */
const condOf = (id, m = modsFor(id)) => TR.condition(catalog.train.get(id), Date.now(), m);
/**
 * Congela a condição dos jogadores no ritmo de recuperação atual (o do departamento médico do dono). Chamar antes de o ritmo
 * mudar: melhoria do médico ou jogador trocando de clube (senão a recuperação desde o último jogo/treino seria recalculada no ritmo novo).
 */
function settleFitness(ids) {
  const now = Date.now(), rows = [];
  for (const id of ids) { const s = catalog.train.get(id); if (s) { TR.checkpoint(s, now, modsFor(id)); rows.push([id, s]); } }
  if (rows.length) store.saveTraining(rows);
}

/**
 * Time que vai a campo: quem está lesionado ou suspenso sai da escalação e entra o melhor reserva disponível da posição
 * (se não houver ninguém, ele joga no sacrifício, com no máximo 50% de condição). Os reservas saudáveis vão para o banco
 * (o motor usa para trocar quem se machucar). `official`: partida entre jogadores (tem lesões).
 */
function matchSide(club, official) {
  const now = Date.now(), slots = R.FORMATIONS[club.formation], m = modsOf(club);
  const why = id => TR.unavailable(catalog.train.get(id), now);
  const condOf_ = id => condOf(id, m);
  const lineup = club.lineup.slice(), used = new Set(lineup), out = [], hurt = new Set(), skip = new Set();
  const score = (p, slot) => (slot.pos === 'GK' ? p.ovr : p.ovr * (p.pos === slot.pos ? 1.05 : p.role === slot.role ? 1 : 0.85)) * (0.7 + 0.3 * condOf_(p.id) / 100);
  for (const id of club.squad) if (why(id)) skip.add(id);
  lineup.forEach((id, i) => {
    const w = id && why(id);
    if (!w) return;
    const slot = slots[i];
    const best = club.squad.filter(x => !used.has(x) && !skip.has(x)).map(x => catalog.playerById.get(x))
      .filter(p => p && (slot.pos === 'GK') === (p.pos === 'GK')).sort((a, b) => score(b, slot) - score(a, slot))[0];
    if (best) { lineup[i] = best.id; used.add(best.id); out.push({ out: catalog.playerById.get(id), in: best, why: w }); }
    else hurt.add(id);
  });
  return {
    lineup, out, skip, injuries: official,
    bench: club.squad.filter(x => !used.has(x) && !skip.has(x)),
    cond: id => (hurt.has(id) ? Math.min(50, condOf_(id)) : condOf_(id))
  };
}
const sideDef = (club, side) => R.buildTeamDef(club, side.lineup, club.formation, catalog, side.cond, { bench: side.bench, injuries: side.injuries, skip: side.skip });

/* ---------- partidas ---------- */
function simulate(homeDef, awayDef, seed, knockout) {
  const m = new E.Match(homeDef, awayDef, { seed, knockout: !!knockout });
  const goals = [], tally = new FM.Tally();
  m.on(ev => { tally.add(ev); if (ev.type === 'goal') goals.push({ min: ev.min, team: ev.team, side: ev.team, player: ev.player ? ev.player.name : '', og: !!ev.og, assist: ev.og ? null : tally.lastAssist }); });
  let n = 0;
  while (!m.finished && n < 100000) { m.update(1 / 60); n++; }
  return { score: [m.home.score, m.away.score], goals, stats: { home: m.home.stats, away: m.away.stats }, pens: m.pens ? m.pens.score.slice() : null, winner: m.winner, tally, energy: m.energyReport() };
}

function cpuDef(exclude = []) {
  const pool = catalog.players.filter(p => p.ovr >= 74 && p.ovr <= 82 && !exclude.includes(p.id)); // a CPU não repete jogadores do adversário
  const pick = (pred, n) => {
    const l = pool.filter(pred).sort(() => Math.random() - 0.5).slice(0, n);
    return l;
  };
  const slots = R.FORMATIONS['4-3-3'];
  const used = new Set(), lineup = [];
  for (const s of slots) {
    let cand = pick(p => !used.has(p.id) && (s.pos === 'GK' ? p.pos === 'GK' : p.pos !== 'GK' && p.role === s.role), 1)[0]
      || pick(p => !used.has(p.id) && (s.pos === 'GK' ? p.pos === 'GK' : p.pos !== 'GK'), 1)[0];
    used.add(cand.id); lineup.push(cand.id);
  }
  return R.buildTeamDef({ name: 'CPU FC', color: '#6b7280' }, lineup, '4-3-3', catalog); // a CPU entra sempre descansada
}

/* ---------- reprodução sincronizada (partidas entre dois jogadores) ---------- */
// O servidor guarda o "relógio" da partida; cada cliente calcula o mesmo instante (tick) a partir dele.
const sessions = new Map(); // matchId -> { clubs, baseTick, baseTime, speed, paused, ended, createdAt }
const SESSION_TTL = 30 * 60 * 1000;
const START_DELAY = 4000; // dá tempo dos dois navegadores carregarem
function sessionTick(s) {
  if (s.ended) return Infinity;
  if (s.paused) return s.baseTick;
  return s.baseTick + Math.max(0, Date.now() - s.baseTime) / 1000 * s.speed * 60;
}
const playbackOf = s => ({ baseTick: s.baseTick, baseTime: s.baseTime, speed: s.speed, paused: s.paused, ended: s.ended, serverNow: Date.now() });
const liveSession = id => { const s = sessions.get(id); return s && Date.now() - s.createdAt < SESSION_TTL ? s : null; };

function playMatch(home, awayClub, isCpu, opts = {}) {
  const sides = { home: matchSide(home, !isCpu), away: isCpu ? null : matchSide(awayClub, true) };
  const homeDef = sideDef(home, sides.home);
  const awayDef = isCpu ? cpuDef(sides.home.lineup) : sideDef(awayClub, sides.away);
  const seed = crypto.randomInt(1, 2 ** 31);
  const knockout = !!opts.knockout;
  const res = simulate(homeDef, awayDef, seed, knockout);
  const rec = {
    id: crypto.randomUUID(), seed, engine: E.VERSION, at: Date.now(), cpu: !!isCpu, knockout,
    home: { id: home.id, name: home.name }, away: { id: isCpu ? null : awayClub.id, name: awayDef.name },
    homeDef, awayDef, score: res.score, goals: res.goals, stats: res.stats, pens: res.pens, winner: res.winner,
    league: opts.league ? { id: opts.league.id, name: opts.league.name, stage: opts.stage } : null
  };
  db.matches.push(rec);
  if (db.matches.length > 300) db.matches.shift();
  if (!isCpu && !opts.noSession) sessions.set(rec.id, { clubs: [home.id, awayClub.id], baseTick: 0, baseTime: Date.now() + START_DELAY, speed: 1, paused: false, ended: false, createdAt: Date.now(), chat: [] });

  if (!isCpu) { // amistoso contra a CPU é só teste de escalação: não muda pontos, saldo nem campanha
    const apply = (club, gf, ga, won) => {
      club.played++; club.gf += gf; club.ga += ga;
      const k = gf > ga ? 'win' : gf < ga ? 'loss' : won === true ? 'win' : won === false ? 'loss' : 'draw';
      club.budget += R.PRIZE[k];
      club.points += k === 'win' ? 3 : k === 'draw' ? 1 : 0;
      club[k === 'win' ? 'w' : k === 'draw' ? 'd' : 'l']++;
    };
    const tie = res.score[0] === res.score[1] && res.winner;
    apply(home, res.score[0], res.score[1], tie ? res.winner === 'home' : null);
    apply(awayClub, res.score[1], res.score[0], tie ? res.winner === 'away' : null);
    const gate = FAC.tickets(home.facilities);
    home.budget += gate;
    const notes = updateFitness(res, { home, away: awayClub });
    if (gate) notes.home.unshift('🏟️ Bilheteria: € ' + gate / 1e6 + ' M');
    const health = updateHealth(res, { home, away: awayClub }, sides);
    for (const k of ['home', 'away']) notes[k] = health[k].concat(notes[k]);
    updateForm(rec, res, { home, away: awayClub }, notes);
  }

  if (opts.league && opts.fixtureId) {
    const out = LG.recordResult(opts.league, opts.fixtureId, { matchId: rec.id, score: res.score, pens: res.pens, goals: res.goals });
    if (out && out.finished) awardLeague(opts.league);
    notifyLeague(opts.league);
  }
  save();
  return rec;
}
/* ---------- estatísticas (artilharia, assistências...) ---------- */
const pstats = new Map(); // "jogador|clube" -> linha de player_stats
const STAT_COLS = ['apps', 'goals', 'assists', 'og', 'shots', 'on_target', 'saves', 'clean_sheets', 'yellows', 'reds', 'fouls'];
function bumpStats(playerId, clubId, add, touched) {
  const k = playerId + '|' + clubId;
  let row = pstats.get(k);
  if (!row) { row = { player_id: playerId, club_id: clubId }; for (const c of STAT_COLS) row[c] = 0; pstats.set(k, row); }
  for (const c of STAT_COLS) row[c] += add[c] || 0;
  touched.add(row);
}
const sumStats = rows => rows.reduce((t, r) => { for (const c of STAT_COLS) t[c] = (t[c] || 0) + r[c]; return t; }, {});
const statsView = r => ({ apps: r.apps || 0, goals: r.goals || 0, assists: r.assists || 0, ga: (r.goals || 0) + (r.assists || 0), shots: r.shots || 0, onTarget: r.on_target || 0, saves: r.saves || 0, cleanSheets: r.clean_sheets || 0, yellows: r.yellows || 0, reds: r.reds || 0, fouls: r.fouls || 0 });
const clubTag = id => { const c = db.clubs[id]; return c ? { id: c.id, name: c.name, color: c.color } : { id, name: '(removido)', color: '#888888' }; };
const playerTag = p => ({ id: p.id, name: p.name, pos: p.pos, role: p.role, ovr: p.ovr, photo: p.photo || null, club: p.club });

/**
 * Depois de uma partida entre jogadores (a CPU é teste): a condição física de quem atuou cai conforme a energia gasta em campo
 * e quem estava em descanso volta ao ritmo normal. Devolve, por lado, quem ficou abaixo de 60% (para o aviso do fim do jogo).
 */
function updateFitness(res, clubs) {
  const now = Date.now(), rows = [], tired = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const byName = new Map(clubs[side].squad.map(id => catalog.playerById.get(id)).filter(Boolean).map(p => [p.name, p]));
    for (const e of res.energy) {
      const p = e.team === side && byName.get(e.name);
      if (!p) continue;
      const s = trainState(p.id), c = TR.afterMatch(s, e, now, modsOf(clubs[side]));
      rows.push([p.id, s]);
      if (c < 60) tired[side].push({ name: p.short || p.name, cond: Math.floor(c) });
    }
    tired[side].sort((a, b) => a.cond - b.cond);
  }
  store.saveTraining(rows);
  const line = list => (list.length ? ['🔋 Cansados: ' + list.slice(0, 4).map(x => x.name + ' ' + x.cond + '%').join(', ') + ' (veja a aba Treino)'] : []);
  return { home: line(tired.home), away: line(tired.away) };
}

/**
 * Depois de uma partida oficial: quem estava suspenso cumpre o jogo; vermelho ou 3º amarelo suspendem para o próximo; quem se
 * machucou fica de 1 a 6 dias fora. Devolve as linhas do aviso de fim de jogo de cada lado.
 */
function updateHealth(res, clubs, sides) {
  const now = Date.now(), rows = new Map(), notes = { home: [], away: [] };
  for (const side of ['home', 'away']) {
    const club = clubs[side], n = notes[side];
    for (const x of sides[side].out) n.push('🔁 ' + x.out.short + ' (' + (x.why === 'injury' ? 'lesionado' : 'suspenso') + ') ficou fora: entrou ' + x.in.short);
    for (const id of club.squad) { const s = catalog.train.get(id); if (TR.serve(s)) rows.set(id, s); }
    const byName = new Map(club.squad.map(id => catalog.playerById.get(id)).filter(Boolean).map(p => [p.name, p]));
    for (const [key, e] of res.tally.players) {
      const p = key.startsWith(side + '|') && byName.get(e.name);
      if (!p || (!e.yellow && !e.red && !e.injured)) continue;
      const s = trainState(p.id), c = TR.cards(s, e.yellow, e.red);
      if (c === 'red') n.push('🟥 ' + p.short + ' foi expulso: fica fora do próximo jogo');
      else if (c === 'yellows') n.push('🟨 ' + p.short + ' levou o ' + TR.YELLOW_LIMIT + 'º amarelo: fica fora do próximo jogo');
      if (e.injured) { const d = TR.injure(s, now, undefined, undefined, modsOf(club)); n.push('🚑 ' + p.short + ': ' + s.injKind + ', ' + d + (d > 1 ? ' dias' : ' dia') + ' fora'); }
      rows.set(p.id, s);
    }
  }
  store.saveTraining([...rows]);
  return notes;
}

/**
 * Depois de uma partida entre jogadores: a nota de quem atuou (titulares e quem entrou) e do técnico sobe ou cai conforme o
 * resultado e o desempenho em campo (ver form.js); o valor de mercado acompanha. Os dois clubes recebem um resumo.
 */
function updateForm(rec, res, clubs, extra) {
  const changes = [], all = [], touched = new Set();
  for (const side of ['home', 'away']) {
    const club = clubs[side], def = side === 'home' ? rec.homeDef : rec.awayDef;
    const gf = res.score[side === 'home' ? 0 : 1], ga = res.score[side === 'home' ? 1 : 0];
    const r = gf > ga ? 1 : gf < ga ? -1 : res.winner ? (res.winner === side ? 0.5 : -0.5) : 0; // decidido nos pênaltis vale metade
    const who = new Map(); // nome em campo -> { id, role, sub }
    def.players.forEach((p, i) => { const id = p.id || club.lineup[i]; if (id) who.set(p.name, { id, role: p.role, sub: false }); });
    for (const key of res.tally.subsIn) {
      if (!key.startsWith(side + '|')) continue;
      const name = key.slice(side.length + 1);
      const p = club.squad.map(id => catalog.playerById.get(id)).find(x => x && x.name === name);
      if (p) who.set(name, { id: p.id, role: p.role, sub: true });
    }
    const mine = [];
    for (const [name, w] of who) {
      const e = res.tally.players.get(side + '|' + name) || { shots: 0, onTarget: 0, goals: 0, og: 0, assists: 0, saves: 0, steals: 0, intercepts: 0, passes: 0, risky: 0, fouls: 0, yellow: 0, red: 0 };
      const pts = FM.rate(w.role, e, r, ga) * (w.sub ? 0.6 : 1); // quem entrou no decorrer do jogo pesa menos
      mine.push({ id: w.id, name, side, coach: false, pts });
      bumpStats(w.id, club.id, { apps: 1, goals: e.goals, assists: e.assists, og: e.og, shots: e.shots, on_target: e.onTarget, saves: e.saves, clean_sheets: (w.role === 'GK' || w.role === 'DEF') && ga === 0 ? 1 : 0, yellows: e.yellow, reds: e.red || 0, fouls: e.fouls }, touched);
    }
    if (club.coach && catalog.coachById.has(club.coach)) mine.push({ id: club.coach, name: catalog.coachById.get(club.coach).name, side, coach: true, pts: FM.rateCoach(r, gf - ga) });
    for (const m of mine) {
      const d = catalog.bump(m.id, m.pts);
      if (d == null) continue;
      changes.push([m.id, d]);
      all.push({ id: m.id, name: m.name, side, coach: m.coach, delta: +m.pts.toFixed(2) });
    }
  }
  store.saveForm(changes);
  store.saveStats([...touched]);
  rec.stats.form = all; // guardado na partida: dá para mostrar depois quem subiu e quem caiu
  const pct = d => Math.round((FM.valueFactor(d) - 1) * 100);
  const fmt = x => x.name + ' ' + (x.delta > 0 ? '+' : '') + x.delta.toFixed(1) + ' (' + (pct(x.delta) >= 0 ? '+' : '') + pct(x.delta) + '% no valor)';
  for (const side of ['home', 'away']) {
    const list = all.filter(x => x.side === side).sort((a, b) => b.delta - a.delta);
    const up = list.filter(x => x.delta > 0.05).slice(0, 3), down = list.filter(x => x.delta < -0.05).slice(-3).reverse();
    const parts = [];
    if (up.length) parts.push('📈 Em alta: ' + up.map(fmt).join(', '));
    if (down.length) parts.push('📉 Em baixa: ' + down.map(fmt).join(', '));
    if (extra) parts.push(...extra[side]);
    const club = clubs[side];
    if (parts.length && club) note(club.id, parts.join(' · '), rec.id);
  }
  pushAll('market', {}); // preços e notas mudaram
}
const matchSummary = m => ({ id: m.id, at: m.at, cpu: m.cpu, home: m.home, away: m.away, score: m.score, goals: m.goals, pens: m.pens, league: m.league });

/* ---------- API ---------- */
const routes = {};
const route = (method, p, fn) => { routes[method + ' ' + p] = fn; };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

const cookieOf = (req, name) => {
  for (const part of (req.headers.cookie || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
};
/** Sessão vinda do cabeçalho, da query (SSE) ou do cookie; vale a primeira que for válida. */
function auth(req, url) {
  const cands = [req.headers['x-token'], url.searchParams.get('token'), cookieOf(req, 'fm_session')].filter(Boolean);
  for (const t of cands) {
    const h = hash(String(t));
    const club = clubs().find(c => c.sessions.includes(h));
    if (club) return club;
  }
  bad('Não autenticado.', 401);
}

/* ---------- senha ---------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  if (!stored) return false;
  const [, salt, h] = stored.split('$');
  const c = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(c, Buffer.from(h, 'hex'));
}
const attempts = new Map(); // nome do clube -> { n, until }
const MIN_PW = 4;

/* ---------- login com Google ---------- */
function googleClientId() {
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8')).googleClientId || null; } catch (_) { return null; }
}
const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
let jwks = { at: 0, keys: [] };
async function googleKeys(force) {
  if (!force && jwks.keys.length && Date.now() - jwks.at < 3600e3) return jwks.keys;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('certs ' + r.status);
  jwks = { at: Date.now(), keys: (await r.json()).keys };
  return jwks.keys;
}
/** Valida o ID token (JWT RS256) emitido pelo Google e devolve os dados do usuário. */
async function verifyGoogle(credential) {
  const clientId = googleClientId();
  if (!clientId) bad('Login com Google não está configurado neste servidor.', 503);
  try {
    const [h, p, sig] = String(credential).split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (header.alg !== 'RS256') throw new Error('alg');
    let key = (await googleKeys(false)).find(k => k.kid === header.kid);
    if (!key) key = (await googleKeys(true)).find(k => k.kid === header.kid);
    if (!key) throw new Error('kid');
    const pub = crypto.createPublicKey({ key, format: 'jwk' });
    if (!crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), pub, Buffer.from(sig, 'base64url'))) throw new Error('assinatura');
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw new Error('iss');
    if (payload.aud !== clientId) throw new Error('aud');
    if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('expirado');
    if (!payload.sub) throw new Error('sub');
    return { sub: payload.sub, email: payload.email || '', name: payload.name || '', picture: payload.picture || '' };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    bad('Não foi possível validar o login do Google (' + e.message + '). Tente entrar de novo.', 401);
  }
}
function newSession(club) {
  const token = crypto.randomBytes(24).toString('hex');
  club.sessions.push(hash(token));
  if (club.sessions.length > 10) club.sessions.shift();
  save();
  return token;
}
const clubByGoogle = sub => clubs().find(c => c.google && c.google.sub === sub);

route('GET', '/api/config', () => ({ googleClientId: googleClientId() }));

route('POST', '/api/auth/google', async (req, url, body) => {
  const g = await verifyGoogle(body.credential);
  const club = clubByGoogle(g.sub);
  if (!club) return { needsClub: true, profile: { name: g.name, email: g.email } };
  club.google.email = g.email;
  return { token: newSession(club), club: privateClub(club) };
});

route('POST', '/api/auth/link', async (req, url, body) => {
  const club = auth(req, url);
  const g = await verifyGoogle(body.credential);
  const other = clubByGoogle(g.sub);
  if (other && other.id !== club.id) bad('Esta conta Google já está ligada ao clube ' + other.name + '.', 409);
  club.google = { sub: g.sub, email: g.email, name: g.name };
  save();
  return { club: privateClub(club) };
});

route('POST', '/api/register', async (req, url, body) => {
  const manager = String(body.manager || '').trim().slice(0, 30);
  const name = String(body.club || '').trim().slice(0, 30);
  const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#d71920';
  if (manager.length < 2) bad('Informe seu nome (mín. 2 letras).');
  if (name.length < 3) bad('O nome do clube precisa de ao menos 3 letras.');
  if (clubs().some(c => c.name.toLowerCase() === name.toLowerCase())) bad('Já existe um clube com esse nome.', 409);
  const password = String(body.password || '');
  if (!body.credential && password.length < MIN_PW) bad('Crie uma senha com ao menos ' + MIN_PW + ' caracteres (você vai precisar dela para voltar).');
  let google = null;
  if (body.credential) {
    const g = await verifyGoogle(body.credential);
    if (clubByGoogle(g.sub)) bad('Esta conta Google já tem um clube. Use "Entrar com Google".', 409);
    google = { sub: g.sub, email: g.email, name: g.name };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const club = {
    id: crypto.randomUUID(), sessions: [hash(token)], passHash: password ? hashPw(password) : null, google, name, manager, color, budget: R.START_BUDGET,
    squad: [], coach: null, formation: '4-3-3', lineup: Array(11).fill(null),
    points: 0, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, createdAt: Date.now()
  };
  db.clubs[club.id] = club;
  save();
  pushAll('clubs', {});
  return { token, club: privateClub(club) };
});

route('GET', '/api/me', (req, url) => {
  const club = auth(req, url);
  const t = req.headers['x-token'];
  const out = { club: privateClub(club) };
  if (t && club.sessions.includes(hash(String(t)))) out.token = t; // renova o cookie de sessões antigas (só localStorage)
  return out;
});

route('POST', '/api/logout', (req, url) => {
  const t = req.headers['x-token'] || cookieOf(req, 'fm_session');
  if (t) {
    const h = hash(String(t));
    for (const c of clubs()) if (c.sessions.includes(h)) { c.sessions = c.sessions.filter(x => x !== h); save(); }
  }
  return { ok: true, clearCookie: true };
});

route('POST', '/api/login', (req, url, body) => {
  const key = String(body.club || '').trim().toLowerCase();
  const lim = attempts.get(key);
  if (lim && lim.until > Date.now()) bad('Muitas tentativas erradas. Aguarde alguns minutos.', 429);
  const club = clubs().find(c => c.name.toLowerCase() === key);
  if (!club || !checkPw(String(body.password || ''), club.passHash)) {
    const n = ((lim && lim.n) || 0) + 1;
    attempts.set(key, { n, until: n >= 8 ? Date.now() + 5 * 60000 : 0 });
    bad('Clube ou senha incorretos.', 401);
  }
  attempts.delete(key);
  return { token: newSession(club), club: privateClub(club) };
});

route('POST', '/api/password', (req, url, body) => {
  const club = auth(req, url);
  const pw = String(body.password || '');
  if (pw.length < MIN_PW) bad('A senha precisa de ao menos ' + MIN_PW + ' caracteres.');
  if (club.passHash && !checkPw(String(body.current || ''), club.passHash)) bad('Senha atual incorreta.', 401);
  club.passHash = hashPw(pw);
  save();
  return { club: privateClub(club) };
});

route('GET', '/api/meta', () => ({
  engine: E.VERSION, source: catalog.source, startBudget: R.START_BUDGET, buyPremium: R.BUY_PREMIUM, sellRatio: R.SELL_RATIO, squadMax: R.SQUAD_MAX,
  formations: R.FORMATIONS, tactics: R.TACTICS, maxSubs: R.MAX_SUBS, maxTacticChanges: R.MAX_TACTIC_CHANGES, prize: R.PRIZE, chat: { emojis: CH.EMOJIS, taunts: CH.TAUNTS },
  training: TR.meta(), facilities: FAC.meta()
}));

const ownerTag = id => { const o = ownerOf(id); return o ? { id: o.id, name: o.name } : null; };
route('GET', '/api/catalog', () => ({
  source: catalog.source,
  players: catalog.players.map(p => Object.assign({}, p, { owner: ownerTag(p.id) })),
  coaches: catalog.coaches.map(c => Object.assign({}, c, { owner: ownerTag(c.id) }))
}));

/** Classificações de estatísticas de todos os jogadores (artilharia, assistências, gols+assistências, goleiros). */
route('GET', '/api/stats', (req, url) => {
  auth(req, url);
  const rows = [...pstats.values()].map(r => ({ r, p: catalog.playerById.get(r.player_id) })).filter(x => x.p && db.clubs[x.r.club_id]);
  const view = ({ r, p }) => Object.assign({ player: playerTag(p), club: clubTag(r.club_id) }, statsView(r));
  const top = (list, key, ...then) => list.map(view).sort((a, b) => b[key] - a[key] || then.reduce((d, k) => d || (k === 'apps' ? a.apps - b.apps : b[k] - a[k]), 0) || a.player.name.localeCompare(b.player.name)).slice(0, 15);
  return {
    scorers: top(rows.filter(x => x.r.goals > 0), 'goals', 'assists', 'apps'),
    assists: top(rows.filter(x => x.r.assists > 0), 'assists', 'goals', 'apps'),
    contributions: top(rows.filter(x => x.r.goals + x.r.assists > 0), 'ga', 'goals', 'apps'),
    goalkeepers: top(rows.filter(x => x.p.role === 'GK' && x.r.apps > 0), 'cleanSheets', 'saves', 'apps'),
    matches: db.matches.filter(m => !m.cpu).length
  };
});

/** Ficha pública de um clube: campanha, técnico e elenco com as estatísticas de cada jogador pelo clube. */
route('GET', '/api/club', (req, url) => {
  auth(req, url);
  const c = db.clubs[url.searchParams.get('id')];
  if (!c) bad('Clube não encontrado.', 404);
  const own = id => pstats.get(id + '|' + c.id);
  const squad = c.squad.map(id => catalog.playerById.get(id)).filter(Boolean).map(p => ({ player: playerTag(p), stats: statsView(own(p.id) || {}), inLineup: c.lineup.includes(p.id) }))
    .sort((a, b) => b.stats.ga - a.stats.ga || b.stats.goals - a.stats.goals || b.player.ovr - a.player.ovr);
  const coach = c.coach ? catalog.coachById.get(c.coach) : null;
  return {
    club: Object.assign(publicClub(c), { formation: c.formation }), // publicClub já traz as instalações
    coach: coach ? { id: coach.id, name: coach.name, ovr: coach.ovr } : null,
    squad, totals: statsView(sumStats([...pstats.values()].filter(r => r.club_id === c.id)))
  };
});

/** Guia de preço para a tela de venda: jogadores parecidos, média e faixa permitida. */
route('GET', '/api/price-guide', (req, url) => {
  const me = auth(req, url);
  const it = catalog.item(url.searchParams.get('id'));
  if (!it) bad('Item não encontrado.', 404);
  const o = ownerOf(it.id);
  if (!o) bad(it.name + ' está no mercado e não pode ir a leilão: leilão é só para jogadores e técnico do seu clube. Contrate-o direto na aba Mercado.', 409);
  if (o.id !== me.id) bad('Só o dono (' + o.name + ') pode vender esse item.', 409);
  return PR.guide(catalog, it);
});

/** Ficha de um jogador ou técnico: características, nota, valor e forma. */
route('GET', '/api/player', (req, url) => {
  auth(req, url);
  const it = catalog.item(url.searchParams.get('id'));
  if (!it) bad('Jogador não encontrado.', 404);
  const coach = catalog.coachById.has(it.id);
  const o = ownerOf(it.id);
  const delta = catalog.form.get(it.id) || 0;
  return {
    player: it, coach, owner: o ? { id: o.id, name: o.name } : null,
    profile: coach ? null : R.profileFor(it),
    stats: coach ? null : (() => { const mine = [...pstats.values()].filter(x => x.player_id === it.id); return { total: statsView(sumStats(mine)), byClub: mine.filter(x => db.clubs[x.club_id]).map(x => Object.assign({ club: clubTag(x.club_id) }, statsView(x))) }; })(),
    form: { delta: +delta.toFixed(2), baseOvr: it.ovr0 != null ? it.ovr0 : it.ovr, baseValue: it.value0 != null ? it.value0 : it.value, max: FM.MAX_FORM },
    fitness: coach ? null : TR.view(catalog.train.get(it.id), Date.now(), modsFor(it.id)),
    training: coach ? null : { ovr: it.trainOvr || 0, max: TR.TRAIN_MAX },
    price: { buy: R.buyPrice(it), sell: Math.round(it.value * R.SELL_RATIO) },
    teamBonus: coach ? +((it.ovr - 75) / 4).toFixed(1) : null // técnico: efeito nas habilidades do time, em %
  };
});

route('POST', '/api/buy', (req, url, body) => {
  const club = auth(req, url);
  const isCoach = body.kind === 'coach';
  const item = isCoach ? catalog.coachById.get(body.id) : catalog.playerById.get(body.id);
  if (!item) bad('Item não encontrado.', 404);
  const o = ownerOf(item.id);
  if (o) bad(o.id === club.id ? 'Você já contratou esse item.' : 'Já pertence ao clube ' + o.name + '.', 409);
  const lock = XC.lockedReason(item.id);
  if (lock) bad(lock, 409);
  const price = R.buyPrice(item);
  if (price > club.budget) bad('Saldo insuficiente (preço: ' + Math.round(price / 1e5) / 10 + ' M).', 402);
  if (isCoach) {
    if (club.coach) bad('Você já tem um técnico. Demita-o (venda) antes de contratar outro.');
    club.coach = item.id;
  } else {
    if (club.squad.length >= R.SQUAD_MAX) bad('Elenco cheio (máx. ' + R.SQUAD_MAX + ').');
    settleFitness([item.id]);
    club.squad.push(item.id);
  }
  club.budget -= price;
  save();
  pushAll('market', { id: item.id });
  return { club: privateClub(club) };
});

route('POST', '/api/sell', (req, url, body) => {
  const club = auth(req, url);
  const isCoach = body.kind === 'coach';
  const item = isCoach ? catalog.coachById.get(body.id) : catalog.playerById.get(body.id);
  if (!item) bad('Item não encontrado.', 404);
  const lock = XC.lockedReason(item.id);
  if (lock) bad(lock, 409);
  if (isCoach) { if (club.coach !== item.id) bad('Esse técnico não é seu.'); club.coach = null; }
  else {
    if (!club.squad.includes(item.id)) bad('Esse jogador não é seu.');
    settleFitness([item.id]);
    club.squad = club.squad.filter(x => x !== item.id);
    club.lineup = club.lineup.map(x => (x === item.id ? null : x));
  }
  club.budget += Math.round(item.value * R.SELL_RATIO);
  save();
  pushAll('market', { id: item.id });
  return { club: privateClub(club) };
});

route('POST', '/api/lineup', (req, url, body) => {
  const club = auth(req, url);
  const err = R.validateLineup(body.formation, body.lineup, club.squad, catalog, false);
  if (err) bad(err);
  club.formation = body.formation;
  club.lineup = body.lineup;
  save();
  return { club: privateClub(club) };
});

route('POST', '/api/tactics', (req, url, body) => {
  const club = auth(req, url);
  const plan = (Array.isArray(body.plan) ? body.plan : []).map(e => (e && e.type === 'tactic'
    ? { type: 'tactic', min: +e.min, style: String(e.style) }
    : { type: 'sub', min: +(e && e.min), out: +(e && e.out), in: String(e && e.in) }));
  const err = R.validatePlan(body.tactic, plan, club.formation, club.squad, club.lineup, catalog);
  if (err) bad(err);
  club.tactic = body.tactic;
  club.plan = plan.sort((a, b) => a.min - b.min);
  save();
  return { club: privateClub(club) };
});

/* Jogo de treino (você controla um jogador): o servidor só monta os times; não vale prêmio nem pontos. */
route('POST', '/api/practice', (req, url, body) => {
  const me = auth(req, url);
  if (ready(me)) bad('Escale os 11 jogadores antes de jogar.');
  let awayDef;
  if (body.opponent === 'cpu') awayDef = cpuDef(me.lineup);
  else {
    const o = db.clubs[body.opponent];
    if (!o || o.id === me.id) bad('Escolha outro clube.');
    if (ready(o)) bad(o.name + ' ainda não escalou o time.');
    awayDef = sideDef(o, matchSide(o, false));
  }
  return { homeDef: sideDef(me, matchSide(me, false)), awayDef, seed: crypto.randomInt(1, 2 ** 31), engine: E.VERSION };
});

/* ---------- Centro de Treinamento e condição física ---------- */
const trainState = id => { let s = catalog.train.get(id); if (!s) catalog.train.set(id, s = TR.blank()); return s; };
const millions = v => '€ ' + (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' M';
function squadPick(club, ids) {
  if (!Array.isArray(ids) || !ids.length) bad('Escolha ao menos um jogador.');
  return [...new Set(ids.map(String))].map(id => {
    const p = catalog.playerById.get(id);
    if (!p || !club.squad.includes(id)) bad('Só dá para cuidar dos jogadores do seu elenco.');
    return p;
  });
}

/** Sessão de treino para um ou mais jogadores do elenco (foco "auto" = o que mais ajuda na posição de cada um). */
route('POST', '/api/train', (req, url, body) => {
  const club = auth(req, url);
  const intensity = TR.INTENSITY[body.intensity] ? body.intensity : 'normal';
  const focus = body.focus && body.focus !== 'auto' ? String(body.focus) : 'auto';
  if (focus !== 'auto' && !TR.FOCUS[focus]) bad('Treino inválido.');
  const coach = club.coach ? catalog.coachById.get(club.coach) : null;
  const now = Date.now(), done = [], skipped = [], rows = [], m = modsOf(club);
  for (const p of squadPick(club, body.ids)) {
    const cur = catalog.train.get(p.id);
    const f = focus === 'auto' ? TR.autoFocus(p, cur ? cur.gains : {}) : focus;
    const lock = XC.lockedReason(p.id);
    const why = lock ? p.name + ': ' + lock.toLowerCase() : f ? TR.cannotTrain(p, cur, f, intensity, now, m) : p.name + ' já está no máximo em tudo.';
    if (why) { skipped.push(why); continue; }
    const s = trainState(p.id);
    const { gain, injury } = TR.train(p, s, f, intensity, coach, now, undefined, m);
    catalog.apply(p); // nota e valor sobem com o treino
    rows.push([p.id, s]);
    done.push({ id: p.id, name: p.name, focus: f, gain, cond: Math.floor(s.fit), injury, injKind: injury ? s.injKind : null });
  }
  if (!done.length) bad(skipped[0] || 'Nenhum jogador pôde treinar.');
  store.saveTraining(rows);
  return { club: privateClub(club), done, skipped, players: done.map(d => Object.assign({}, catalog.playerById.get(d.id), { owner: ownerTag(d.id) })) };
});

/** Descanso: o jogador recupera a condição duas vezes mais rápido (sai do descanso ao treinar ou jogar). */
route('POST', '/api/rest', (req, url, body) => {
  const club = auth(req, url);
  const now = Date.now();
  const rows = squadPick(club, body.ids).map(p => { const s = trainState(p.id); TR.setRest(s, !!body.on, now, modsOf(club)); return [p.id, s]; });
  store.saveTraining(rows);
  return { club: privateClub(club) };
});

/** Fisioterapia: devolve condição na hora; paga (proporcional ao valor do jogador) e uma vez por dia por jogador. */
route('POST', '/api/physio', (req, url, body) => {
  const club = auth(req, url);
  const now = Date.now(), list = [], skipped = [], m = modsOf(club);
  for (const p of squadPick(club, body.ids)) {
    const s = catalog.train.get(p.id);
    if (TR.condition(s, now, m) >= 99.5 && !TR.injuredFor(s, now)) skipped.push(p.name + ' já está com 100%.');
    else if (!TR.physioLeft(s, now)) skipped.push(p.name + ' já fez fisioterapia hoje.');
    else list.push(p);
  }
  if (!list.length) bad(skipped[0]);
  const cost = list.reduce((t, p) => t + TR.physioCost(p, m), 0);
  if (cost > club.budget) bad('Saldo insuficiente: a fisioterapia de ' + list.length + ' jogador(es) custa ' + millions(cost) + '.', 402);
  const rows = list.map(p => { const s = trainState(p.id); TR.physio(s, now, m); return [p.id, s]; });
  club.budget -= cost;
  save();
  store.saveTraining(rows);
  return { club: privateClub(club), done: list.map(p => Object.assign({ id: p.id, name: p.name }, TR.view(catalog.train.get(p.id), now, m))), skipped, cost };
});

/** Melhora uma instalação do clube (Centro de Treinamento, departamento médico ou estádio) em um nível. */
route('POST', '/api/facility', (req, url, body) => {
  const club = auth(req, url);
  const key = String(body.key || '');
  if (!FAC.FACILITIES[key]) bad('Instalação inválida.');
  const cost = FAC.upgradeCost(club.facilities, key);
  if (cost == null) bad(FAC.FACILITIES[key].name + ' já está no nível máximo.');
  if (cost > club.budget) bad('Saldo insuficiente: melhorar custa ' + millions(cost) + '.', 402);
  if (key === 'med') settleFitness(club.squad); // a recuperação até agora foi no ritmo antigo
  club.facilities = Object.assign({}, club.facilities, { [key]: FAC.levelOf(club.facilities, key) + 1 });
  club.budget -= cost;
  save();
  return { club: privateClub(club), level: club.facilities[key] };
});

route('GET', '/api/clubs', (req, url) => {
  auth(req, url);
  return { clubs: clubs().map(publicClub).sort((a, b) => b.points - a.points || (b.gf - b.ga) - (a.gf - a.ga) || a.name.localeCompare(b.name)) };
});

function ready(club) {
  return R.validateLineup(club.formation, club.lineup, club.squad, catalog, true);
}

/** Confere se o jogo de liga pode ser disputado agora por este clube. */
function checkFixture(ref, me) {
  const l = db.leagues[String(ref.leagueId)];
  if (!l || !l.members.includes(me.id)) bad('Liga não encontrada.', 404);
  if (l.status !== 'running') bad('A competição não está em andamento.');
  const f = l.fixtures.find(x => x.id === ref.fixtureId);
  if (!f || f.score) bad('Este jogo já foi realizado.', 409);
  if (f.home !== me.id && f.away !== me.id) bad('Você não participa deste jogo.', 403);
  return { l, f };
}

route('POST', '/api/challenge', (req, url, body) => {
  const me = auth(req, url);
  const err = ready(me);
  if (err) bad('Sua escalação não está pronta: ' + err);
  if (body.to === 'cpu' && !body.fixture) {
    const rec = playMatch(me, null, true);
    push(me.id, 'match', { id: rec.id });
    return { match: rec.id };
  }
  let toId = body.to, fixture = null, context = null;
  if (body.fixture) {
    const { l, f } = checkFixture(body.fixture, me);
    toId = f.home === me.id ? f.away : f.home;
    fixture = { leagueId: l.id, fixtureId: f.id };
    context = l.name + ' · ' + f.stage;
  }
  const other = db.clubs[toId];
  if (!other || other.id === me.id) bad('Adversário inválido.');
  if (!online(other.id)) bad('O adversário está offline. Combinem um horário ou peça para quem criou a sala simular o jogo.');
  if (ready(other)) bad('O adversário ainda não montou o time.');
  for (const c of challenges.values()) if ((c.from === me.id && c.to === other.id) && Date.now() - c.at < 120000) bad('Desafio já enviado.');
  const ch = { id: crypto.randomUUID(), from: me.id, to: other.id, at: Date.now(), fixture };
  challenges.set(ch.id, ch);
  push(other.id, 'challenge', { id: ch.id, from: { id: me.id, name: me.name, manager: me.manager }, context });
  return { challenge: ch.id };
});

route('POST', '/api/challenge/respond', (req, url, body) => {
  const me = auth(req, url);
  const ch = challenges.get(body.id);
  if (!ch || ch.to !== me.id || Date.now() - ch.at > 120000) bad('Desafio expirado.', 404);
  challenges.delete(ch.id);
  const from = db.clubs[ch.from];
  if (!body.accept) { push(from.id, 'declined', { by: me.name }); return { ok: true }; }
  const e1 = ready(from), e2 = ready(me);
  if (e1 || e2) { push(from.id, 'declined', { by: me.name, reason: 'Escalação incompleta.' }); bad('Escalação incompleta.'); }
  let rec;
  if (ch.fixture) {
    const { l, f } = checkFixture(ch.fixture, me);
    rec = playMatch(db.clubs[f.home], db.clubs[f.away], false, { knockout: l.format === 'cup', league: l, fixtureId: f.id, stage: f.stage });
  } else {
    rec = playMatch(from, me, false);
  }
  push(from.id, 'match', { id: rec.id });
  push(me.id, 'match', { id: rec.id });
  pushAll('clubs', {});
  return { match: rec.id };
});

route('GET', '/api/matches', (req, url) => {
  auth(req, url);
  return { matches: db.matches.slice(-30).reverse().map(matchSummary) };
});

route('GET', '/api/match', (req, url) => {
  auth(req, url);
  const m = db.matches.find(x => x.id === url.searchParams.get('id'));
  if (!m) bad('Partida não encontrada.', 404);
  const sess = liveSession(m.id);
  return { match: m, engine: E.VERSION, playback: sess ? playbackOf(sess) : null, chat: sess ? sess.chat : [] };
});

/* ---------- chat ---------- */
const chatLimit = new CH.RateLimiter(6, 5000);
function makeMsg(me, body) {
  let kind = 'text', text;
  if (body.kind === 'react') {
    if (!CH.EMOJIS.includes(body.text)) bad('Reação inválida.');
    kind = 'react'; text = body.text;
  } else if (body.kind === 'taunt') {
    text = CH.TAUNTS[+body.index];
    if (!text) bad('Frase inválida.');
    kind = 'taunt';
  } else {
    text = CH.clean(body.text);
    if (!text) bad('Escreva uma mensagem.');
  }
  return { id: crypto.randomUUID(), clubId: me.id, from: me.name, color: me.color, kind, text, at: Date.now() };
}

route('POST', '/api/match/chat', (req, url, body) => {
  const me = auth(req, url);
  const sess = liveSession(String(body.id));
  if (!sess) bad('O chat existe só em partidas entre dois jogadores, logo depois de jogadas.', 404);
  if (!sess.clubs.includes(me.id)) bad('Você não participa desta partida.', 403);
  if (!chatLimit.allow(me.id)) bad('Calma! Você está mandando mensagens rápido demais.', 429);
  const msg = makeMsg(me, body);
  sess.chat.push(msg);
  if (sess.chat.length > 60) sess.chat.shift();
  for (const id of sess.clubs) push(id, 'chat', { matchId: String(body.id), msg });
  return { ok: true };
});

route('POST', '/api/leagues/chat', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (!chatLimit.allow(me.id)) bad('Calma! Você está mandando mensagens rápido demais.', 429);
  const msg = makeMsg(me, body);
  if (msg.kind === 'react') bad('Reações só valem durante a partida.');
  if (!l.chat) l.chat = [];
  l.chat.push(msg);
  if (l.chat.length > 100) l.chat.shift();
  save();
  for (const id of l.members) push(id, 'leaguechat', { id: l.id, league: l.name, msg });
  return { ok: true };
});

route('POST', '/api/match/control', (req, url, body) => {
  const me = auth(req, url);
  const sess = liveSession(String(body.id));
  if (!sess) bad('Esta partida não tem controle compartilhado (só vale para partidas entre dois jogadores, recém-jogadas).', 404);
  if (!sess.clubs.includes(me.id)) bad('Você não participa desta partida.', 403);
  const now = Date.now();
  let label;
  if (body.action === 'pause' && !sess.paused && !sess.ended) {
    sess.baseTick = sessionTick(sess); sess.paused = true; label = 'pausou a partida';
  } else if (body.action === 'play' && sess.paused) {
    sess.baseTime = now; sess.paused = false; label = 'retomou a partida';
  } else if (body.action === 'speed' && [1, 2, 4, 8].includes(+body.value) && !sess.ended) {
    if (!sess.paused) { sess.baseTick = sessionTick(sess); sess.baseTime = now; }
    sess.speed = +body.value; label = 'mudou a velocidade para ' + sess.speed + 'x';
  } else if (body.action === 'skip') {
    sess.ended = true; label = 'pulou para o fim da partida';
  } else {
    return { playback: playbackOf(sess) }; // sem mudança (já estava nesse estado)
  }
  const pb = playbackOf(sess);
  for (const id of sess.clubs) push(id, 'playback', { id: String(body.id), playback: pb, by: me.name, label });
  return { playback: pb };
});

/* ---------- leilão e trocas ---------- */
const xc = fn => (req, url, body) => {
  const club = auth(req, url);
  try { return fn(club, body || {}); } catch (e) { if (e.exchange) throw new HttpError(e.code, e.message); throw e; }
};
route('GET', '/api/exchange', xc(club => Object.assign(XC.snapshot(), { trades: XC.tradesOf(club.id), auctionSeconds: XC.AUCTION_SECONDS })));
route('POST', '/api/auction/start', xc((club, b) => ({ auction: XC.startAuction(club, b) })));
route('POST', '/api/auction/bid', xc((club, b) => ({ auction: XC.placeBid(club, b) })));
route('POST', '/api/trade', xc((club, b) => ({ trade: XC.proposeTrade(club, b) })));
route('POST', '/api/trade/respond', xc((club, b) => ({ trade: XC.respondTrade(club, b) })));

/* ---------- ligas e copas ---------- */
const MAX_LEAGUES_PER_CLUB = 6;
function notifyLeague(league) { for (const id of league.members) push(id, 'league', { id: league.id }); }
function note(clubId, text, matchId) { push(clubId, 'note', { text, matchId: matchId || null }); }
function awardLeague(league) {
  const champ = db.clubs[league.champion], runner = league.runnerUp && db.clubs[league.runnerUp];
  if (champ) champ.budget += LG.LEAGUE_PRIZE.champion;
  if (runner) runner.budget += LG.LEAGUE_PRIZE.runnerUp;
  for (const id of league.members) {
    note(id, '🏆 ' + league.name + ' terminou! Campeão: ' + (champ ? champ.name : '—') + '. Prêmio: € ' + LG.LEAGUE_PRIZE.champion / 1e6 + ' M para o campeão e € ' + LG.LEAGUE_PRIZE.runnerUp / 1e6 + ' M para o vice.');
  }
}
const clubInfo = id => { const c = db.clubs[id]; return c ? { id: c.id, name: c.name, manager: c.manager, color: c.color, online: online(c.id) } : { id, name: '(removido)', manager: '', color: '#888888', online: false }; };
function findLeague(id, me) {
  const l = db.leagues[String(id)];
  if (!l || !l.members.includes(me.id)) bad('Liga não encontrada.', 404);
  return l;
}
function leagueSummary(l) {
  return { id: l.id, code: l.code, name: l.name, format: l.format, rounds: l.rounds, status: l.status, members: l.members.length, owner: l.owner, champion: l.champion ? clubInfo(l.champion).name : null };
}
function leagueView(l) {
  const fx = f => ({ id: f.id, round: f.round, stage: f.stage, home: clubInfo(f.home), away: clubInfo(f.away), matchId: f.matchId, score: f.score, pens: f.pens, winner: f.winner });
  return {
    league: Object.assign(leagueSummary(l), { members: l.members.map(clubInfo), runnerUp: l.runnerUp ? clubInfo(l.runnerUp).name : null, limits: LG.LIMITS[l.format], prize: LG.LEAGUE_PRIZE }),
    fixtures: l.fixtures.map(fx),
    standings: l.format === 'league' && l.status !== 'lobby' ? LG.standings(l).map(r => Object.assign({ club: clubInfo(r.clubId) }, r)) : [],
    scorers: LG.scorers(l).map(x => Object.assign({}, x, { club: clubInfo(x.clubId).name })),
    assisters: LG.assisters(l).map(x => Object.assign({}, x, { club: clubInfo(x.clubId).name })),
    chat: l.chat || []
  };
}

route('GET', '/api/leagues', (req, url) => {
  const me = auth(req, url);
  return { leagues: Object.values(db.leagues).filter(l => l.members.includes(me.id)).sort((a, b) => b.createdAt - a.createdAt).map(leagueSummary) };
});

route('POST', '/api/leagues', (req, url, body) => {
  const me = auth(req, url);
  const name = String(body.name || '').trim().slice(0, 30);
  if (name.length < 3) bad('Dê um nome com ao menos 3 letras.');
  const format = body.format === 'cup' ? 'cup' : 'league';
  const mine = Object.values(db.leagues).filter(l => l.members.includes(me.id) && l.status !== 'finished').length;
  if (mine >= MAX_LEAGUES_PER_CLUB) bad('Você já participa de ' + MAX_LEAGUES_PER_CLUB + ' competições em andamento.');
  const league = {
    id: crypto.randomUUID(), code: LG.newCode(c => Object.values(db.leagues).some(l => l.code === c)), name, format,
    rounds: format === 'league' && +body.rounds === 2 ? 2 : 1, owner: me.id, members: [me.id], status: 'lobby',
    fixtures: [], advancing: [], champion: null, runnerUp: null, createdAt: Date.now()
  };
  db.leagues[league.id] = league;
  save();
  return { league: leagueSummary(league) };
});

route('POST', '/api/leagues/join', (req, url, body) => {
  const me = auth(req, url);
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const l = Object.values(db.leagues).find(x => x.code === code);
  if (!l) bad('Código não encontrado. Confira as letras com quem criou a sala.', 404);
  if (l.members.includes(me.id)) bad('Você já está nesta competição.', 409);
  if (l.status !== 'lobby') bad('Esta competição já começou.', 409);
  if (l.members.length >= LG.LIMITS[l.format].max) bad('A sala está cheia (máx. ' + LG.LIMITS[l.format].max + ').', 409);
  const mine = Object.values(db.leagues).filter(x => x.members.includes(me.id) && x.status !== 'finished').length;
  if (mine >= MAX_LEAGUES_PER_CLUB) bad('Você já participa de ' + MAX_LEAGUES_PER_CLUB + ' competições em andamento.');
  l.members.push(me.id);
  save();
  notifyLeague(l);
  return { league: leagueSummary(l) };
});

route('POST', '/api/leagues/leave', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (l.status !== 'lobby') bad('Só dá para sair antes de a competição começar.');
  l.members = l.members.filter(id => id !== me.id);
  if (!l.members.length) delete db.leagues[l.id];
  else { if (l.owner === me.id) l.owner = l.members[0]; notifyLeague(l); }
  save();
  return { ok: true };
});

route('POST', '/api/leagues/start', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (l.owner !== me.id) bad('Só quem criou a sala pode iniciar.', 403);
  const err = LG.start(l);
  if (err) bad(err);
  save();
  notifyLeague(l);
  for (const id of l.members) if (id !== me.id) note(id, '▶ ' + l.name + ' começou! Veja seus jogos na aba Ligas.');
  return leagueView(l);
});

route('GET', '/api/leagues/detail', (req, url) => {
  const me = auth(req, url);
  return Object.assign(leagueView(findLeague(url.searchParams.get('id'), me)), { me: me.id });
});

route('POST', '/api/leagues/simulate', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (l.owner !== me.id) bad('Só quem criou a sala pode simular jogos.', 403);
  if (l.status !== 'running') bad('A competição não está em andamento.');
  const f = l.fixtures.find(x => x.id === body.fixtureId);
  if (!f || f.score) bad('Jogo não encontrado ou já realizado.', 404);
  const home = db.clubs[f.home], away = db.clubs[f.away];
  for (const c of [home, away]) { const e = ready(c); if (e) bad(c.name + ' ainda não montou o time (' + e + ')'); }
  const rec = playMatch(home, away, false, { knockout: l.format === 'cup', league: l, fixtureId: f.id, stage: f.stage, noSession: true });
  const txt = f.stage + ' · ' + home.name + ' ' + rec.score[0] + ' x ' + rec.score[1] + ' ' + away.name + (rec.pens ? ' (pên. ' + rec.pens[0] + '-' + rec.pens[1] + ')' : '') + ' — simulado';
  for (const id of [home.id, away.id]) if (id !== me.id) note(id, l.name + ': ' + txt, rec.id);
  return { match: rec.id, score: rec.score, pens: rec.pens };
});

/* ---------- busca de jogadores (Wikidata por padrão; Sofascore se SOFASCORE_BASE estiver configurado) ---------- */
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const searchCache = new Map(); // termo -> { at, remote }
const SEARCH_TTL = 10 * 60 * 1000;
const MAX_IMPORT = 12;
const SOURCE = process.env.SOFASCORE_BASE ? 'Sofascore' : 'Wikidata';

async function findPlayers(q) {
  if (SOURCE === 'Wikidata') return wd.searchPlayers(q);
  const found = (await ss.searchPlayers(q)).slice(0, MAX_IMPORT);
  const out = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < found.length) {
      const e = found[cursor++];
      try { out.push(await ss.playerFull(e.id)); } catch (_) { /* pula o jogador com erro */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

async function remoteSearch(q) {
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.remote;
  let remote;
  try {
    const imported = (await findPlayers(q)).map(p => catalog.add(p)); // guarda no catálogo (e no Supabase) para todos os clubes
    remote = { ok: true, ids: imported.map(p => p.id), source: SOURCE };
  } catch (e) {
    remote = { ok: false, error: e.message, status: e.status || 0, source: SOURCE };
  }
  // falhas só ficam em cache por pouco tempo, para tentar de novo logo
  searchCache.set(q, { at: remote.ok ? Date.now() : Date.now() - SEARCH_TTL + 30000, remote });
  return remote;
}

route('GET', '/api/search', async (req, url) => {
  auth(req, url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 40);
  if (q.length < 2) bad('Digite ao menos 2 letras.');
  const remote = await remoteSearch(norm(q));
  const nq = norm(q);
  const own = id => { const o = ownerOf(id); return o ? { id: o.id, name: o.name } : null; };
  const ids = new Set(remote.ok ? remote.ids : []);
  const players = catalog.players
    .filter(p => ids.has(p.id) || norm(p.name + ' ' + p.club).includes(nq))
    .map(p => Object.assign({}, p, { owner: own(p.id) }));
  return { players, remote: { ok: remote.ok, error: remote.error, status: remote.status, source: remote.source } };
});

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const PUBLIC_DIRS = ['js', 'css', 'icons'];
const PUBLIC_FILES = ['index.html', 'game.html', 'manifest.webmanifest', 'sw.js'];

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'game.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const ok = PUBLIC_FILES.includes(rel) || PUBLIC_DIRS.includes(rel.split('/')[0]);
  const file = path.normalize(path.join(ROOT, rel));
  if (!ok || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  if (url.pathname === '/api/events') {
    let club;
    try { club = auth(req, url); } catch (e) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    if (!streams.has(club.id)) streams.set(club.id, new Set());
    streams.get(club.id).add(res);
    pushAll('clubs', {});
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      const set = streams.get(club.id);
      if (set) { set.delete(res); if (!set.size) streams.delete(club.id); }
      pushAll('clubs', {});
    });
    return;
  }

  const fn = routes[req.method + ' ' + url.pathname];
  const send = (code, obj) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (obj && obj.token) headers['Set-Cookie'] = 'fm_session=' + obj.token + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax';
    if (obj && obj.clearCookie) headers['Set-Cookie'] = 'fm_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
    const body = JSON.stringify(obj);
    if (body.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) { // o catálogo tem milhares de jogadores
      headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
      res.writeHead(code, headers);
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(code, headers);
    res.end(body);
  };
  if (!fn) return send(404, { error: 'Rota não encontrada.' });

  let raw = '';
  req.on('data', d => { raw += d; if (raw.length > 100e3) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = raw ? JSON.parse(raw) : {};
      send(200, await fn(req, url, body));
    } catch (e) {
      if (e instanceof HttpError) send(e.code, { error: e.message });
      else if (e instanceof SyntaxError) send(400, { error: 'JSON inválido.' });
      else { console.error(e); send(500, { error: 'Erro interno.' }); }
    }
  });
});

async function boot() {
  db = await store.load();
  store.attach(db);
  const owned = new Set(Object.values(db.clubs).flatMap(c => c.squad));
  catalog = load({ imported: await store.loadImported(), persist: p => store.saveImported(p), keep: owned, form: await store.loadForm(), train: await store.loadTraining() });
  for (const r of await store.loadStats()) pstats.set(r.player_id + '|' + r.club_id, r);
  XC = createExchange({ db, catalog, R, save, push, pushAll, beforeMove: id => settleFitness([id]) });
  // jogadores importados por outros meios (ex.: carga em massa) entram no catálogo sem reiniciar
  let since = new Date().toISOString();
  setInterval(async () => {
    try {
      const from = since; since = new Date().toISOString();
      const n = catalog.merge(await store.loadImported(from));
      if (n) { console.log('[catálogo] +' + n + ' jogadores importados'); pushAll('market', {}); }
    } catch (e) { console.error('[catálogo] falha ao atualizar:', e.message); }
  }, 5 * 60 * 1000).unref();
  server.listen(PORT, () => console.log('Jogo em http://localhost:' + PORT + '  (banco: Supabase, catálogo: ' + catalog.source + ', ' + catalog.players.length + ' jogadores)'));
}
boot().catch(e => { console.error('Falha ao iniciar:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flushNow().finally(() => process.exit(0)); });
