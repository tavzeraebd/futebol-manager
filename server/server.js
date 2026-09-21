/* Servidor do jogo: arquivos estáticos + API JSON + eventos em tempo real (SSE). Sem dependências. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('./catalog');
const { createStore } = require('./store');
const R = require('./rules');
const ss = require('./providers/sofascore');
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
    id: c.id, name: c.name, manager: c.manager, color: c.color, budget: c.budget,
    points: c.points, played: c.played, w: c.w, d: c.d, l: c.l, gf: c.gf, ga: c.ga,
    online: online(c.id), squadSize: players.length, squadValue: players.reduce((s, p) => s + p.value, 0)
  };
}
function privateClub(c) {
  return Object.assign(publicClub(c), { squad: c.squad, coach: c.coach, formation: c.formation, lineup: c.lineup, tactic: c.tactic || 'balanced', plan: c.plan || [], google: c.google ? { email: c.google.email } : null, hasPassword: !!c.passHash });
}

/* ---------- partidas ---------- */
function simulate(homeDef, awayDef, seed, knockout) {
  const m = new E.Match(homeDef, awayDef, { seed, knockout: !!knockout });
  const goals = [];
  m.on(ev => { if (ev.type === 'goal') goals.push({ min: ev.min, team: ev.team, side: ev.team, player: ev.player ? ev.player.name : '', og: !!ev.og }); });
  let n = 0;
  while (!m.finished && n < 100000) { m.update(1 / 60); n++; }
  return { score: [m.home.score, m.away.score], goals, stats: { home: m.home.stats, away: m.away.stats }, pens: m.pens ? m.pens.score.slice() : null, winner: m.winner };
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
  return R.buildTeamDef({ name: 'CPU FC', color: '#6b7280' }, lineup, '4-3-3', catalog);
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
  const homeDef = R.buildTeamDef(home, home.lineup, home.formation, catalog);
  const awayDef = isCpu ? cpuDef(home.lineup) : R.buildTeamDef(awayClub, awayClub.lineup, awayClub.formation, catalog);
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
  }

  if (opts.league && opts.fixtureId) {
    const out = LG.recordResult(opts.league, opts.fixtureId, { matchId: rec.id, score: res.score, pens: res.pens, goals: res.goals });
    if (out && out.finished) awardLeague(opts.league);
    notifyLeague(opts.league);
  }
  save();
  return rec;
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
  formations: R.FORMATIONS, tactics: R.TACTICS, maxSubs: R.MAX_SUBS, maxTacticChanges: R.MAX_TACTIC_CHANGES, prize: R.PRIZE, chat: { emojis: CH.EMOJIS, taunts: CH.TAUNTS }
}));

route('GET', '/api/catalog', () => {
  const own = id => { const o = ownerOf(id); return o ? { id: o.id, name: o.name } : null; };
  return {
    source: catalog.source,
    players: catalog.players.map(p => Object.assign({}, p, { owner: own(p.id) })),
    coaches: catalog.coaches.map(c => Object.assign({}, c, { owner: own(c.id) }))
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
    awayDef = R.buildTeamDef(o, o.lineup, o.formation, catalog);
  }
  return { homeDef: R.buildTeamDef(me, me.lineup, me.formation, catalog), awayDef, seed: crypto.randomInt(1, 2 ** 31), engine: E.VERSION };
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

/* ---------- busca ao vivo no Sofascore ---------- */
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const searchCache = new Map(); // termo -> { at, remote }
const SEARCH_TTL = 10 * 60 * 1000;
const MAX_IMPORT = 12;

async function remoteSearch(q) {
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.remote;
  let remote;
  try {
    const found = (await ss.searchPlayers(q)).slice(0, MAX_IMPORT);
    const imported = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < found.length) {
        const e = found[cursor++];
        try { imported.push(catalog.add(await ss.playerFull(e.id))); } catch (_) { /* pula o jogador com erro */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    remote = { ok: true, ids: imported.map(p => p.id) };
  } catch (e) {
    remote = { ok: false, error: e.message, status: e.status || 0 };
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
  return { players, remote: { ok: remote.ok, error: remote.error, status: remote.status } };
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
    res.writeHead(code, headers);
    res.end(JSON.stringify(obj));
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
  catalog = load({ imported: await store.loadImported(), persist: p => store.saveImported(p) });
  XC = createExchange({ db, catalog, R, save, push, pushAll });
  server.listen(PORT, () => console.log('Jogo em http://localhost:' + PORT + '  (banco: Supabase, catálogo: ' + catalog.source + ', ' + catalog.players.length + ' jogadores)'));
}
boot().catch(e => { console.error('Falha ao iniciar:', e.message); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flushNow().finally(() => process.exit(0)); });
