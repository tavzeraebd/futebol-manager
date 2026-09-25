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
const LK = require('./locker');
const RP = require('./report');
const MS = require('./missions');
const AC = require('./academy');
const NW = require('./news');
const SC = require('./schedule');
const { createExchange } = require('./exchange');
const { createInbox } = require('./inbox');
const { createPush } = require('./push');
const E = require('../js/engine.js');

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 3210;
const store = createStore();
const inbox = createInbox(store, (id, type, data) => push(id, type, data));
const pushSvc = createPush(store);
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
/** Notificação no celular (push.js) para quem não está com o jogo aberto; force = mesmo se estiver. */
function notify(clubId, payload, force) { if (force || !online(clubId)) pushSvc.send(clubId, payload); }
/** Aviso na tela; quem está fora recebe no celular (leilão, trocas e avisos de liga passam por aqui). */
function pushNote(clubId, type, data) {
  push(clubId, type, data);
  if (type === 'note' && data && data.text) notify(clubId, { title: 'Football Manager Online', body: data.text, tag: 'note' });
}


/* ---------- visões públicas ---------- */
function publicClub(c) {
  const players = c.squad.map(id => catalog.playerById.get(id)).filter(Boolean);
  const h = hiddenCampaign(c.id); // jogo ainda passando na tela: a campanha só muda no apito final
  return {
    id: c.id, name: c.name, manager: c.manager, color: c.color, budget: c.budget, facilities: facilitiesOf(c),
    points: c.points - h.points, played: c.played - h.played, w: c.w - h.w, d: c.d - h.d, l: c.l - h.l, gf: c.gf - h.gf, ga: c.ga - h.ga,
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
    mods: m,
    moral: Object.fromEntries(c.squad.map(id => [id, LK.moralOf(c, id)])), // vestiário (0-100)
    talk: c.extra && c.extra.talk ? c.extra.talk.style : null, // preleção guardada para o próximo jogo oficial
    unread: inbox.unread(c.id),
    trophies: (c.extra && c.extra.trophies) || []
  });
}
/** Condição física (0-100) de um jogador agora (ou no instante `at`): entra na partida como energia inicial. */
const condOf = (id, m = modsFor(id), at = Date.now()) => TR.condition(catalog.train.get(id), at, m);
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
 * o.lineup: escalação deste jogo (jogo marcado com vagas completadas pelo auxiliar); o.at: instante do jogo (condição física).
 */
function matchSide(club, official, o = {}) {
  const now = o.at || Date.now(), slots = R.FORMATIONS[club.formation], m = modsOf(club);
  const why = id => TR.unavailable(catalog.train.get(id), now);
  const condOf_ = id => condOf(id, m, now);
  const lineup = (o.lineup || club.lineup).slice(), used = new Set(lineup), out = [], hurt = new Set(), skip = new Set();
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
const sideDef = (club, side) => R.buildTeamDef(club, side.lineup, club.formation, catalog, side.cond, { bench: side.bench, injuries: side.injuries, skip: side.skip, crowd: side.crowd, mult: side.mult });
const avgOvr = ids => { const l = ids.map(id => catalog.playerById.get(id)).filter(Boolean); return l.length ? l.reduce((t, p) => t + p.ovr, 0) / l.length : 0; };

/* ---------- partidas ---------- */
function simulate(homeDef, awayDef, seed, knockout) {
  const m = new E.Match(homeDef, awayDef, { seed, knockout: !!knockout });
  const goals = [], tally = new FM.Tally();
  m.on(ev => {
    tally.add(ev);
    if (ev.type === 'goal') goals.push(Object.assign({ min: ev.min, team: ev.team, side: ev.team, player: ev.player ? ev.player.name : '', og: !!ev.og, assist: ev.og ? null : tally.lastAssist }, tally.lastKind ? { kind: tally.lastKind } : {}));
  });
  let n = 0;
  while (!m.finished && n < 100000) { m.update(1 / 60); n++; }
  return { score: [m.home.score, m.away.score], goals, stats: { home: m.home.stats, away: m.away.stats }, pens: m.pens ? m.pens.score.slice() : null, winner: m.winner, tally, energy: m.energyReport(), steps: n };
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
// Jogo marcado de liga: "transmissão" (broadcast) que começa no horário do jogo; os membros da liga assistem e conversam juntos,
// e ninguém pausa nem acelera para os outros (quem mexe nos controles sai da transmissão só na própria tela).
const sessions = new Map(); // matchId -> { clubs, spectators, broadcast, baseTick, baseTime, speed, paused, ended, createdAt, chat }
const SESSION_TTL = 30 * 60 * 1000;
const START_DELAY = 4000; // dá tempo dos dois navegadores carregarem
function sessionTick(s) {
  if (s.ended) return Infinity;
  if (s.paused) return s.baseTick;
  return s.baseTick + Math.max(0, Date.now() - s.baseTime) / 1000 * s.speed * 60;
}
const playbackOf = s => ({ baseTick: s.baseTick, baseTime: s.baseTime, speed: s.speed, paused: s.paused, ended: s.ended, broadcast: !!s.broadcast, serverNow: Date.now() });
const liveSession = id => { const s = sessions.get(id); return s && Date.now() - s.createdAt < SESSION_TTL ? s : null; };
const sessionMembers = s => [...new Set(s.clubs.concat(s.spectators || []))];
/**
 * A partida ainda está passando na tela (o servidor já sabe o resultado, mas ninguém deveria saber)? Enquanto estiver, placar,
 * tabela, campanha, jornal e avisos não mostram o resultado (quem pula para o fim encerra a sessão e libera).
 */
const unrevealed = id => { const s = liveSession(id); return !!(s && s.steps && !s.ended && sessionTick(s) < s.steps); };
/** O que as partidas ainda não reveladas somaram na campanha de um clube (para descontar das telas até o fim do jogo). */
function hiddenCampaign(clubId) {
  const d = { played: 0, points: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  for (const [id, s] of sessions) {
    if (!s.result || !s.result.clubs.includes(clubId) || !unrevealed(id)) continue;
    const i = s.result.clubs.indexOf(clubId), gf = s.result.score[i], ga = s.result.score[1 - i];
    const won = gf > ga || (gf === ga && s.result.winner === (i ? 'away' : 'home')), lost = gf < ga || (gf === ga && s.result.winner && !won);
    d.played++; d.gf += gf; d.ga += ga;
    if (won) { d.w++; d.points += 3; } else if (lost) d.l++; else { d.d++; d.points++; }
  }
  return d;
}

/**
 * Joga uma partida. opts: { knockout, league, fixtureId, stage, noSession, lineups: { home, away } (jogo marcado: escalação com as
 * vagas completadas), filled: { home, away } (nomes de quem o auxiliar escalou), at (horário do jogo marcado), session: { baseTime,
 * spectators } (transmissão ao vivo) }.
 */
function playMatch(home, awayClub, isCpu, opts = {}) {
  const at = opts.at || Date.now(), lu = opts.lineups || {};
  const sides = { home: matchSide(home, !isCpu, { lineup: lu.home, at }), away: isCpu ? null : matchSide(awayClub, true, { lineup: lu.away, at }) };
  let talks = null, classic = false;
  if (!isCpu) {
    sides.home.crowd = FAC.crowd(home.facilities); // torcida do mandante (como a bilheteria, só em partida oficial)
    classic = NW.isClassic(db.matches, home.id, awayClub.id);
    // vestiário: moral de cada jogador (até ±3%) e a preleção guardada (depende de o time ser favorito ou azarão)
    const oh = avgOvr(sides.home.lineup), oa = avgOvr(sides.away.lineup);
    talks = { home: LK.useTalk(home, oh, oa), away: LK.useTalk(awayClub, oa, oh) };
    for (const [k, c] of [['home', home], ['away', awayClub]]) {
      const t = talks[k];
      sides[k].mult = id => +(LK.moralMult(LK.moralOf(c, id)) * (1 + (t ? t.k : 0))).toFixed(4);
    }
  }
  const homeDef = sideDef(home, sides.home);
  const awayDef = isCpu ? cpuDef(sides.home.lineup) : sideDef(awayClub, sides.away);
  const seed = crypto.randomInt(1, 2 ** 31);
  const knockout = !!opts.knockout;
  const res = simulate(homeDef, awayDef, seed, knockout);
  const rec = {
    id: crypto.randomUUID(), seed, engine: E.VERSION, at, cpu: !!isCpu, knockout,
    home: { id: home.id, name: home.name }, away: { id: isCpu ? null : awayClub.id, name: awayDef.name },
    homeDef, awayDef, score: res.score, goals: res.goals, stats: res.stats, pens: res.pens, winner: res.winner,
    league: opts.league ? { id: opts.league.id, name: opts.league.name, stage: opts.stage } : null
  };
  db.matches.push(rec);
  if (db.matches.length > 300) db.matches.shift();
  // steps e result: para esconder o resultado até a partida terminar na tela (unrevealed)
  const hide = { steps: res.steps, result: { clubs: isCpu ? [] : [home.id, awayClub.id], score: res.score, winner: res.winner } };
  if (!isCpu && opts.session) {
    sessions.set(rec.id, Object.assign({ clubs: [home.id, awayClub.id], spectators: opts.session.spectators || [], broadcast: true, baseTick: 0, baseTime: opts.session.baseTime, speed: 1, paused: false, ended: false, createdAt: Date.now(), chat: [] }, hide));
  } else if (!isCpu && !opts.noSession) {
    sessions.set(rec.id, Object.assign({ clubs: [home.id, awayClub.id], spectators: [], baseTick: 0, baseTime: Date.now() + START_DELAY, speed: 1, paused: false, ended: false, createdAt: Date.now(), chat: [] }, hide));
  }

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
    const gate = FAC.tickets(home.facilities) * (classic ? 2 : 1); // clássico: bilheteria em dobro
    home.budget += gate;
    const fit = updateFitness(res, { home, away: awayClub });
    const notes = { home: fit.home, away: fit.away };
    if (gate) notes.home.unshift('🏟️ Bilheteria: € ' + gate / 1e6 + ' M' + (classic ? ' (clássico: em dobro)' : ''));
    const health = updateHealth(res, { home, away: awayClub }, sides);
    for (const k of ['home', 'away']) notes[k] = health[k].concat(notes[k]);
    for (const k of ['home', 'away']) if (opts.filled && opts.filled[k] && opts.filled[k].length) notes[k].unshift('📝 O auxiliar completou a escalação: ' + opts.filled[k].join(', '));
    const rated = updateForm(rec, res, { home, away: awayClub }, notes);
    afterOfficial(rec, res, { home, away: awayClub }, sides, rated, notes, { talks, classic, fit, injured: health.injured });
  }

  if (opts.league && opts.fixtureId) {
    const out = LG.recordResult(opts.league, opts.fixtureId, { matchId: rec.id, score: res.score, pens: res.pens, goals: res.goals });
    afterLeagueResult(opts.league, opts.fixtureId, out);
  }
  save();
  return rec;
}

/**
 * Depois de uma partida oficial: notas de 0 a 10 (guardadas na partida para o jornal e os prêmios), relatório de cada clube na
 * caixa de entrada, moral e mensagens do vestiário, missões do dia e notificação no celular de quem está fora.
 */
function afterOfficial(rec, res, cl, sides, rated, notes, x) {
  const now = Date.now(), day = TR.dayKey(now);
  // partida vista ao vivo: relatório, vestiário e missões aparecem quando o jogo termina na tela (sem estragar a surpresa)
  const at = revealAt(rec.id);
  const later = fn => { if (at > now) { const t = setTimeout(fn, at - now); if (t.unref) t.unref(); } else fn(); };
  rec.stats.ratings = rated.map(r => ({ id: r.id, name: r.name, side: r.side, role: r.role, rating: r.rating }));
  const energy = new Map(res.energy.map(e => [e.team + '|' + e.name, e.end]));
  const SIDE = { fav: 'time favorito', even: 'jogo parelho', dog: 'time azarão' };
  for (const side of ['home', 'away']) {
    const club = cl[side], i = side === 'home' ? 0 : 1;
    const gf = res.score[i], ga = res.score[1 - i];
    const won = gf > ga || (gf === ga && res.winner === side);
    const r = gf > ga ? 1 : gf < ga ? -1 : res.winner ? (res.winner === side ? 0.5 : -0.5) : 0;
    const mine = rated.filter(y => y.side === side);
    const focusOf = id => {
      const y = mine.find(z => z.id === id), p = catalog.playerById.get(id);
      const t = y && RP.trainFor(y.role, y.e, ga, energy.get(side + '|' + y.name));
      return t ? t.focus : p ? TR.autoFocus(p, (catalog.train.get(id) || { gains: {} }).gains) : null;
    };
    const msgs = LK.afterMatch(club, {
      r, played: new Map(mine.map(y => [y.id, { rating: y.rating, started: !y.sub }])), xi: sides[side].lineup,
      injured: x.injured[side], tired: x.fit.tired[side], unavailable: new Set(club.squad.filter(id => TR.unavailable(catalog.train.get(id), now))),
      catalog, now, focusOf
    });
    const t = x.talks && x.talks[side], extra = {};
    if (t) extra.talk = t.label + ' (' + SIDE[t.side] + '): ' + (t.k >= 0 ? '+' : '') + Math.round(t.k * 100) + '% nas habilidades';
    if (x.classic) extra.classic = true;
    if (side === 'home' && rec.homeDef.crowd) extra.crowd = Math.round(rec.homeDef.crowd * 100);
    inbox.add(club.id, 'report', RP.build(rec, side, rated, energy, notes[side], extra), { at });
    for (const m of msgs) inbox.add(club.id, 'locker', m, { at: at + 1 });
    const kinds = (rec.goals || []).filter(g => g.side === side && !g.og && g.kind).map(g => g.kind);
    const st = rec.stats[side] || {}, so = rec.stats[side === 'home' ? 'away' : 'home'] || {};
    const poss = st.poss + so.poss ? Math.round(st.poss / (st.poss + so.poss) * 100) : 50;
    const done = MS.afterMatch(club, day, { gf, ga, won, poss, kinds });
    if (t) done.push(...MS.progress(club, day, 'talk'));
    missionsDone(club, done, at + 2);
    const icon = won ? '✅' : r < 0 ? '❌' : '🤝';
    later(() => notify(club.id, { title: icon + ' ' + rec.home.name + ' ' + rec.score[0] + ' x ' + rec.score[1] + ' ' + rec.away.name, body: 'Relatório da partida: notas, destaques e quem precisa treinar.', url: '/?report=' + rec.id, tag: 'report-' + rec.id }));
  }
  if (at > now) later(() => pushAll('clubs', {})); // apito final: tabela e campanha atualizam nas telas
}

/** Jogador chegou ao elenco: moral de recém-chegado; reforço (time já tinha 11) se apresenta no vestiário. */
function arrived(club, p, always) {
  const m = LK.arrive(club, p);
  if (always || club.squad.length > 11) inbox.add(club.id, 'locker', m);
}

/** Missões cumpridas: aviso da diretoria (o prêmio já entrou no saldo). at: quando o aviso aparece (fim da transmissão). */
function missionsDone(club, done, at) {
  for (const d of done) inbox.add(club.id, 'board', { icon: '🎯', title: 'Missão cumprida', text: d.text + ': + ' + millions(d.prize) + ' no saldo.' }, { at });
}

/** Resultado registrado numa liga: bolão, próxima fase (com horário, se a liga tem agenda), prêmios no fim e aviso aos membros. */
function afterLeagueResult(l, fixtureId, out) {
  const f = l.fixtures.find(x => x.id === fixtureId);
  const at = f && f.matchId ? revealAt(f.matchId) : Date.now(); // avisos só no fim da transmissão
  if (f) settleBets(l, f, at);
  if (out && out.newRound) SC.assign(l, Date.now());
  if (out && out.finished) awardLeague(l, at);
  notifyLeague(l);
  if (at > Date.now()) { const t = setTimeout(() => notifyLeague(l), at - Date.now()); if (t.unref) t.unref(); } // a tabela muda na tela no apito final
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
      if (c < 60) tired[side].push({ id: p.id, name: p.short || p.name, cond: Math.floor(c) });
    }
    tired[side].sort((a, b) => a.cond - b.cond);
  }
  store.saveTraining(rows);
  const line = list => (list.length ? ['🔋 Cansados: ' + list.slice(0, 4).map(x => x.name + ' ' + x.cond + '%').join(', ') + ' (veja a aba Treino)'] : []);
  return { home: line(tired.home), away: line(tired.away), tired };
}

/**
 * Depois de uma partida oficial: quem estava suspenso cumpre o jogo; vermelho ou 3º amarelo suspendem para o próximo; quem se
 * machucou fica de 1 a 6 dias fora. Devolve as linhas do aviso de fim de jogo de cada lado.
 */
function updateHealth(res, clubs, sides) {
  const now = Date.now(), rows = new Map(), notes = { home: [], away: [], injured: { home: [], away: [] } };
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
      if (e.injured) {
        const d = TR.injure(s, now, undefined, undefined, modsOf(club));
        n.push('🚑 ' + p.short + ': ' + s.injKind + ', ' + d + (d > 1 ? ' dias' : ' dia') + ' fora');
        notes.injured[side].push({ id: p.id, days: d, kind: s.injKind });
      }
      rows.set(p.id, s);
    }
  }
  store.saveTraining([...rows]);
  return notes;
}

/**
 * Depois de uma partida entre jogadores: a nota de quem atuou (titulares e quem entrou) e do técnico sobe ou cai conforme o
 * resultado e o desempenho em campo (ver form.js); o valor de mercado acompanha. Os dois clubes recebem um resumo.
 * Devolve quem atuou com a nota da partida (0 a 10): [{ id, name, side, role, pos, sub, rating, e (linha do Tally) }].
 */
function updateForm(rec, res, clubs, extra) {
  const changes = [], all = [], touched = new Set(), rated = [];
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
      const e = res.tally.players.get(side + '|' + name) || { shots: 0, onTarget: 0, goals: 0, og: 0, assists: 0, saves: 0, steals: 0, intercepts: 0, passes: 0, risky: 0, passLost: 0, lost: 0, fouls: 0, yellow: 0, red: 0 };
      const raw = FM.rate(w.role, e, r, ga);
      const pts = raw * (w.sub ? 0.6 : 1); // quem entrou no decorrer do jogo pesa menos
      mine.push({ id: w.id, name, side, coach: false, pts });
      const cp = catalog.playerById.get(w.id);
      rated.push({ id: w.id, name, side, role: w.role, pos: cp ? cp.pos : w.role, sub: w.sub, rating: FM.matchRating(raw), e });
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
    if (extra) { extra[side].push(...parts); parts.length = 0; parts.push(...extra[side]); } // o relatório também mostra
    const club = clubs[side];
    // jogo simulado: aviso na hora; jogo visto ao vivo: nada agora (o relatório chega no fim); quem está fora recebe o relatório
    if (parts.length && club && !sessions.has(rec.id)) push(club.id, 'note', { text: parts.join(' · '), matchId: rec.id });
  }
  pushAll('market', {}); // preços e notas mudaram
  return rated;
}
const matchSummary = m => (unrevealed(m.id)
  ? { id: m.id, at: m.at, cpu: m.cpu, home: m.home, away: m.away, score: null, goals: [], pens: null, league: m.league, live: true } // ainda passando: sem placar
  : { id: m.id, at: m.at, cpu: m.cpu, home: m.home, away: m.away, score: m.score, goals: m.goals, pens: m.pens, league: m.league });
/** Partidas cujo resultado já pode aparecer (as que ainda passam ao vivo ficam de fora do jornal, da seleção e dos prêmios). */
const revealedMatches = () => db.matches.filter(m => !unrevealed(m.id));
/** Quando o resultado de uma partida pode aparecer (fim da transmissão; já, se não há transmissão). */
const revealAt = id => { const s = sessions.get(id); return s && s.steps ? Math.max(Date.now(), s.baseTime + s.steps / 60 * 1000 + 3000) : Date.now(); };

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
  training: TR.meta(), facilities: FAC.meta(),
  when: R.WHEN, talks: R.TALKS, talkEffects: E.TALK, pre: LK.PRE, promiseGames: LK.PROMISE_GAMES, days: SC.DAY_NAMES, missionPrize: MS.GOAL_PRIZE,
  push: !!pushSvc.publicKey()
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
  const me = auth(req, url);
  const c = db.clubs[url.searchParams.get('id')];
  if (!c) bad('Clube não encontrado.', 404);
  const own = id => pstats.get(id + '|' + c.id);
  const squad = c.squad.map(id => catalog.playerById.get(id)).filter(Boolean).map(p => ({ player: playerTag(p), stats: statsView(own(p.id) || {}), inLineup: c.lineup.includes(p.id) }))
    .sort((a, b) => b.stats.ga - a.stats.ga || b.stats.goals - a.stats.goals || b.player.ovr - a.player.ovr);
  const coach = c.coach ? catalog.coachById.get(c.coach) : null;
  return {
    club: Object.assign(publicClub(c), { formation: c.formation }), // publicClub já traz as instalações
    coach: coach ? { id: coach.id, name: coach.name, ovr: coach.ovr } : null,
    squad, totals: statsView(sumStats([...pstats.values()].filter(r => r.club_id === c.id))),
    trophies: (c.extra && c.extra.trophies) || [],
    h2h: me.id !== c.id ? NW.h2h(revealedMatches(), me.id, c.id) : null // retrospecto do meu clube contra este
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
    arrived(club, item);
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
  const plan = (Array.isArray(body.plan) ? body.plan : []).map(e => {
    const when = e && e.when ? { when: String(e.when) } : {}; // instrução condicional (motor v8): perdendo, empatando, ganhando...
    if (e && e.type === 'talk') return Object.assign({ type: 'talk', min: R.TALK_MIN, style: String(e.style) }, when);
    if (e && e.type === 'tactic') return Object.assign({ type: 'tactic', min: +e.min, style: String(e.style) }, when);
    return Object.assign({ type: 'sub', min: +(e && e.min), out: +(e && e.out), in: String(e && e.in) }, when);
  });
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
  missionsDone(club, MS.progress(club, TR.dayKey(now), 'train', done.length));
  save();
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
  const me = auth(req, url), inSess = sess && sessionMembers(sess).includes(me.id);
  // quem não participa vê a transmissão (jogo marcado) sincronizada, mas sem o chat se não for da liga
  return { match: m, engine: E.VERSION, playback: sess && (inSess || sess.broadcast) ? playbackOf(sess) : null, chat: inSess ? sess.chat : [], canChat: !!inSess };
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
  if (!sessionMembers(sess).includes(me.id)) bad('Você não participa desta partida.', 403);
  if (!chatLimit.allow(me.id)) bad('Calma! Você está mandando mensagens rápido demais.', 429);
  const msg = makeMsg(me, body);
  sess.chat.push(msg);
  if (sess.chat.length > 60) sess.chat.shift();
  for (const id of sessionMembers(sess)) push(id, 'chat', { matchId: String(body.id), msg });
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
  if (sess.broadcast) bad('Transmissão ao vivo: ninguém pausa nem acelera para os outros.', 409);
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
function note(clubId, text, matchId) { pushNote(clubId, 'note', { text, matchId: matchId || null }); }
const AWARD_PRIZE = 5e6; // artilheiro e craque da competição: prêmio para o clube do jogador
function addTrophy(club, t) {
  if (!club) return;
  if (!club.extra) club.extra = {};
  club.extra.trophies = ((club.extra.trophies || []).concat([Object.assign({ at: Date.now() }, t)])).slice(-60);
}
/** Craque da competição: melhor média de notas (quem jogou pelo menos metade dos jogos do próprio clube). */
function bestOfLeague(league) {
  const per = new Map(), games = new Map();
  for (const f of league.fixtures) {
    const m = f.matchId && db.matches.find(x => x.id === f.matchId);
    if (!m || !m.stats || !m.stats.ratings) continue;
    for (const side of ['home', 'away']) games.set(m[side].id, (games.get(m[side].id) || 0) + 1);
    for (const r of m.stats.ratings) {
      const clubId = m[r.side].id, k = clubId + '|' + r.id;
      const cur = per.get(k) || { id: r.id, name: r.name, clubId, sum: 0, n: 0 };
      cur.sum += r.rating; cur.n++;
      per.set(k, cur);
    }
  }
  const list = [...per.values()].filter(x => x.n >= Math.max(1, Math.ceil((games.get(x.clubId) || 1) / 2))).map(x => Object.assign(x, { avg: +(x.sum / x.n).toFixed(2) }));
  return list.sort((a, b) => b.avg - a.avg || b.n - a.n)[0] || null;
}
/** Fim da competição: prêmios em dinheiro, metas da diretoria, artilheiro e craque, troféus e avisos (at: quando os avisos aparecem). */
function awardLeague(league, at = Date.now()) {
  const champ = db.clubs[league.champion], runner = league.runnerUp && db.clubs[league.runnerUp];
  if (champ) champ.budget += LG.LEAGUE_PRIZE.champion;
  if (runner) runner.budget += LG.LEAGUE_PRIZE.runnerUp;
  const cup = league.format === 'cup';
  addTrophy(champ, { kind: cup ? 'cup' : 'league', title: 'Campeão · ' + league.name, league: league.id });
  addTrophy(runner, { kind: 'runner', title: 'Vice-campeão · ' + league.name, league: league.id });
  const top = LG.scorers(league)[0], best = bestOfLeague(league);
  const awards = { champion: league.champion, runnerUp: league.runnerUp || null };
  if (top) {
    awards.scorer = { player: top.player, clubId: top.clubId, goals: top.goals };
    const c = db.clubs[top.clubId];
    if (c) { c.budget += AWARD_PRIZE; addTrophy(c, { kind: 'scorer', title: 'Artilheiro · ' + league.name + ': ' + top.player + ' (' + top.goals + ' gols)', league: league.id }); }
  }
  if (best) {
    awards.best = { player: best.name, clubId: best.clubId, avg: best.avg, games: best.n };
    const c = db.clubs[best.clubId];
    if (c) { c.budget += AWARD_PRIZE; addTrophy(c, { kind: 'best', title: 'Craque · ' + league.name + ': ' + best.name + ' (média ' + best.avg.toFixed(1).replace('.', ',') + ')', league: league.id }); }
  }
  if (!league.extra) league.extra = {};
  league.extra.awards = awards;
  const met = MS.evalGoals(league, cup ? [] : LG.standings(league));
  for (const id of league.members) {
    const c = db.clubs[id];
    if (!c) continue;
    const lines = ['Campeão: ' + (champ ? champ.name : '—') + (runner ? ' · vice: ' + runner.name : '') + '. Prêmio de ' + millions(LG.LEAGUE_PRIZE.champion) + ' para o campeão e ' + millions(LG.LEAGUE_PRIZE.runnerUp) + ' para o vice.'];
    if (awards.scorer) lines.push('Artilheiro: ' + awards.scorer.player + ' (' + clubInfo(awards.scorer.clubId).name + '), ' + awards.scorer.goals + ' gols — ' + millions(AWARD_PRIZE) + ' para o clube.');
    if (awards.best) lines.push('Craque da competição: ' + awards.best.player + ' (' + clubInfo(awards.best.clubId).name + '), média ' + awards.best.avg.toFixed(1).replace('.', ',') + ' — ' + millions(AWARD_PRIZE) + ' para o clube.');
    const g = league.extra.goals && league.extra.goals[id];
    if (g) {
      const ok = met.get(id);
      if (ok) c.budget += MS.GOAL_PRIZE;
      lines.push(ok ? '🏅 Meta da diretoria cumprida ("' + g.text + '"): bônus de ' + millions(MS.GOAL_PRIZE) + '.' : '📋 A meta da diretoria ("' + g.text + '") não foi cumprida.');
    }
    inbox.add(id, 'board', { icon: '🏆', title: league.name + ' terminou!', text: lines.join('\n'), league: league.id }, { at });
    const tell = () => note(id, '🏆 ' + league.name + ' terminou! Campeão: ' + (champ ? champ.name : '—') + '. Veja os prêmios na caixa de mensagens.');
    if (at > Date.now()) { const t = setTimeout(tell, at - Date.now()); if (t.unref) t.unref(); } else tell();
  }
}

/* bolão: 3 pontos por placar exato, 1 por acertar o vencedor (ou o empate); prêmio em dinheiro para quem acerta */
const BET_PRIZE = { 3: 3e6, 1: 1e6 };
function betPoints(bet, score) {
  if (!bet || !score) return 0;
  if (bet[0] === score[0] && bet[1] === score[1]) return 3;
  return Math.sign(bet[0] - bet[1]) === Math.sign(score[0] - score[1]) ? 1 : 0;
}
function settleBets(l, f, at) {
  const bets = (f.extra && f.extra.bets) || {};
  for (const [id, bet] of Object.entries(bets)) {
    const c = db.clubs[id], pts = betPoints(bet, f.score);
    if (!c || !pts) continue;
    c.budget += BET_PRIZE[pts];
    inbox.add(id, 'board', { icon: '🎯', title: 'Bolão · ' + l.name, text: (pts === 3 ? 'Na mosca! Você cravou ' : 'Você acertou o resultado de ') + clubInfo(f.home).name + ' ' + f.score[0] + ' x ' + f.score[1] + ' ' + clubInfo(f.away).name + ' (palpite ' + bet[0] + ' x ' + bet[1] + '): + ' + millions(BET_PRIZE[pts]) + '.' }, { at });
  }
}
/** Jogo com resultado já visível (o que ainda passa ao vivo conta como não jogado nas telas). */
const shown = f => f.score && !(f.matchId && unrevealed(f.matchId));
/** A liga como as telas devem ver: jogos ainda passando ao vivo sem placar. */
const leagueShown = l => (l.fixtures.some(f => f.score && !shown(f))
  ? Object.assign({}, l, { fixtures: l.fixtures.map(f => (shown(f) || !f.score ? f : Object.assign({}, f, { score: null, pens: null, winner: null, goals: [] }))) })
  : l);
function betTable(l) {
  const rows = new Map(l.members.map(id => [id, { club: clubInfo(id), pts: 0, exact: 0, hits: 0, bets: 0 }]));
  for (const f of l.fixtures) for (const [id, bet] of Object.entries((f.extra && f.extra.bets) || {})) {
    const r = rows.get(id);
    if (!r) continue;
    r.bets++;
    if (!shown(f)) continue;
    const p = betPoints(bet, f.score);
    r.pts += p; if (p === 3) r.exact++; if (p) r.hits++;
  }
  return [...rows.values()].sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.club.name.localeCompare(b.club.name));
}
const clubInfo = id => { const c = db.clubs[id]; return c ? { id: c.id, name: c.name, manager: c.manager, color: c.color, online: online(c.id) } : { id, name: '(removido)', manager: '', color: '#888888', online: false }; };
function findLeague(id, me) {
  const l = db.leagues[String(id)];
  if (!l || !l.members.includes(me.id)) bad('Liga não encontrada.', 404);
  return l;
}
// A final ainda passando ao vivo: a competição aparece em andamento, sem campeão (o resultado sai no apito final).
const endHidden = l => l.status === 'finished' && l.fixtures.some(f => f.score && !shown(f));
function leagueSummary(l) {
  const s = l.extra && l.extra.schedule, hide = endHidden(l);
  const next = l.fixtures.filter(f => !f.score && f.at).sort((a, b) => a.at - b.at)[0];
  return { id: l.id, code: l.code, name: l.name, format: l.format, rounds: l.rounds, status: hide ? 'running' : l.status, members: l.members.length, owner: l.owner,
    champion: l.champion && !hide ? clubInfo(l.champion).name : null, schedule: s || null, scheduleText: s ? SC.describe(s) : null, next: next ? next.at : null };
}
function leagueView(l, me) {
  const now = Date.now(), V = leagueShown(l), hide = endHidden(l);
  const fx = f => {
    const bets = (f.extra && f.extra.bets) || {};
    return {
      id: f.id, round: f.round, stage: f.stage, home: clubInfo(f.home), away: clubInfo(f.away), matchId: f.matchId, score: f.score, pens: f.pens, winner: f.winner,
      at: f.at || null, atLabel: f.at ? SC.label(f.at) : null, wo: (f.extra && f.extra.wo) || null,
      live: !!(f.matchId && unrevealed(f.matchId)), // transmissão em andamento
      myBet: me && bets[me.id] ? bets[me.id] : null, bets: Object.keys(bets).length, betOpen: !f.score && !f.matchId && (!f.at || f.at > now),
      classic: NW.isClassic(revealedMatches(), f.home, f.away)
    };
  };
  const goals = (l.extra && l.extra.goals) || {};
  return {
    league: Object.assign(leagueSummary(l), { members: l.members.map(clubInfo), runnerUp: l.runnerUp && !hide ? clubInfo(l.runnerUp).name : null, limits: LG.LIMITS[l.format], prize: LG.LEAGUE_PRIZE,
      myGoal: me && goals[me.id] ? goals[me.id] : null, goalPrize: MS.GOAL_PRIZE, awards: hide ? null : (l.extra && l.extra.awards) || null }),
    fixtures: V.fixtures.map(fx),
    standings: l.format === 'league' && l.status !== 'lobby' ? LG.standings(V).map(r => Object.assign({ club: clubInfo(r.clubId) }, r)) : [],
    scorers: LG.scorers(V).map(x => Object.assign({}, x, { club: clubInfo(x.clubId).name })),
    assisters: LG.assisters(V).map(x => Object.assign({}, x, { club: clubInfo(x.clubId).name })),
    bolao: l.status !== 'lobby' ? betTable(l) : [],
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
  let schedule = null;
  if (body.schedule) { const p = SC.parse(body.schedule); if (p.error) bad(p.error); schedule = p.schedule; }
  const league = {
    id: crypto.randomUUID(), code: LG.newCode(c => Object.values(db.leagues).some(l => l.code === c)), name, format,
    rounds: format === 'league' && +body.rounds === 2 ? 2 : 1, owner: me.id, members: [me.id], status: 'lobby',
    fixtures: [], advancing: [], champion: null, runnerUp: null, createdAt: Date.now(), extra: schedule ? { schedule } : {}
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
  SC.assign(l, Date.now()); // liga com agenda: cada rodada ganha horário
  const goals = MS.boardGoals(l, new Map(l.members.map(id => [id, publicClub(db.clubs[id] || { squad: [] }).squadValue || 0])));
  save();
  notifyLeague(l);
  const first = l.fixtures.filter(f => f.at).sort((a, b) => a.at - b.at)[0];
  for (const id of l.members) {
    if (id !== me.id) note(id, '▶ ' + l.name + ' começou! Veja seus jogos na aba Ligas.');
    const g = goals[id];
    inbox.add(id, 'board', { icon: '📋', title: 'Diretoria · ' + l.name, text: 'A competição começou' + (first ? ' (primeira rodada ' + SC.label(first.at) + ', horário de Brasília)' : '') + '. Meta da diretoria para o seu clube: "' + g.text + '". Cumprindo, bônus de ' + millions(MS.GOAL_PRIZE) + '.', league: l.id });
  }
  return leagueView(l, me);
});

route('GET', '/api/leagues/detail', (req, url) => {
  const me = auth(req, url);
  return Object.assign(leagueView(findLeague(url.searchParams.get('id'), me), me), { me: me.id });
});

/** Agenda da liga (dono): dias e horário dos jogos automáticos; null tira a agenda (volta a ser só desafio/simular). */
route('POST', '/api/leagues/schedule', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (l.owner !== me.id) bad('Só quem criou a sala pode mudar a agenda.', 403);
  if (l.status === 'finished') bad('A competição já terminou.');
  let schedule = null;
  if (body.schedule) { const p = SC.parse(body.schedule); if (p.error) bad(p.error); schedule = p.schedule; }
  l.extra = Object.assign({}, l.extra, { schedule });
  if (!schedule) delete l.extra.schedule;
  for (const f of l.fixtures) if (!f.score) { f.at = null; if (f.extra) { delete f.extra.pre; delete f.extra.remind; } }
  const n = SC.assign(l, Date.now());
  save();
  notifyLeague(l);
  for (const id of l.members) if (id !== me.id) note(id, '🗓️ ' + l.name + ': ' + (schedule ? 'jogos automáticos ' + SC.describe(schedule) + ' (horário de Brasília).' : 'os jogos voltaram a ser por desafio.'));
  return Object.assign(leagueView(l, me), { me: me.id, scheduled: n });
});

/** Bolão: palpite de placar de um jogo da liga (até o horário do jogo; pode mudar até lá). */
route('POST', '/api/leagues/bet', (req, url, body) => {
  const me = auth(req, url);
  const l = findLeague(body.id, me);
  if (l.status !== 'running') bad('A competição não está em andamento.');
  const f = l.fixtures.find(x => x.id === body.fixtureId);
  if (!f || f.score) bad('Esse jogo já aconteceu.', 409);
  if (f.at && f.at <= Date.now()) bad('O palpite fecha no horário do jogo.', 409);
  const s = Array.isArray(body.score) ? body.score.map(Number) : [];
  if (s.length !== 2 || s.some(v => !Number.isInteger(v) || v < 0 || v > 20)) bad('Palpite inválido.');
  f.extra = Object.assign({}, f.extra);
  const first = !f.extra.bets || !f.extra.bets[me.id];
  f.extra.bets = Object.assign({}, f.extra.bets, { [me.id]: s });
  if (first) missionsDone(me, MS.progress(me, TR.dayKey(Date.now()), 'bet'));
  save();
  return { ok: true, bet: s, club: privateClub(me) };
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
  save();
  const txt = f.stage + ' · ' + home.name + ' ' + rec.score[0] + ' x ' + rec.score[1] + ' ' + away.name + (rec.pens ? ' (pên. ' + rec.pens[0] + '-' + rec.pens[1] + ')' : '') + ' — simulado';
  for (const id of [home.id, away.id]) if (id !== me.id) note(id, l.name + ': ' + txt, rec.id);
  return { match: rec.id, score: rec.score, pens: rec.pens };
});

/* ---------- jogos em horário marcado ---------- */
// A cada SCHEDULER_MS o servidor confere as ligas com agenda: 3 h antes o auxiliar manda a análise do adversário, 15 min antes
// avisa no celular e no horário o jogo acontece sozinho (transmitido ao vivo para a liga). Se o servidor estava dormindo no
// horário (plano grátis), joga os atrasados ao acordar: ninguém consegue mexer no time enquanto ele dorme, então dá no mesmo.
const SCHEDULER_MS = 15000, PRE_NOTICE = 3 * 3600e3, REMIND = 15 * 60e3, LIVE_WINDOW = 10 * 60e3;

/** Escalação do jogo marcado: a do técnico, com as vagas vazias completadas pelos melhores disponíveis. null = não tem 11 (W.O.). */
function autoLineup(club, at) {
  const slots = R.FORMATIONS[club.formation], m = modsOf(club), seen = new Set(), filled = [];
  const P = id => catalog.playerById.get(id);
  const lineup = slots.map((s, i) => {
    const id = club.lineup[i], p = id && club.squad.includes(id) && P(id);
    if (!p || seen.has(id) || (s.pos === 'GK') !== (p.pos === 'GK')) return null;
    seen.add(id);
    return id;
  });
  const pool = club.squad.map(P).filter(Boolean);
  for (let i = 0; i < slots.length; i++) {
    if (lineup[i]) continue;
    const s = slots[i];
    const score = p => (s.pos === 'GK' ? p.ovr : p.ovr * (p.pos === s.pos ? 1.05 : p.role === s.role ? 1 : 0.85)) *
      (0.7 + 0.3 * TR.condition(catalog.train.get(p.id), at, m) / 100) * (TR.unavailable(catalog.train.get(p.id), at) ? 0.01 : 1);
    const best = pool.filter(p => !seen.has(p.id) && (s.pos === 'GK') === (p.pos === 'GK')).sort((a, b) => score(b) - score(a))[0];
    if (!best) return null;
    lineup[i] = best.id; seen.add(best.id); filled.push(best.short || best.name);
  }
  return { lineup, filled };
}

function playScheduled(l, f, now) {
  const home = db.clubs[f.home], away = db.clubs[f.away];
  const H = home && autoLineup(home, f.at), A = away && autoLineup(away, f.at);
  const title = l.name + ' · ' + f.stage;
  if (!H || !A) { // W.O.: não tinha 11 jogadores com goleiro no horário
    const wo = !H && !A ? 'both' : !H ? 'home' : 'away';
    const score = wo === 'both' ? [0, 0] : wo === 'home' ? [0, 3] : [3, 0];
    const out = LG.recordResult(l, f.id, { matchId: null, score, pens: null, goals: [], wo });
    for (const c of [home, away]) {
      if (!c) continue;
      const absent = wo === 'both' || (wo === 'home') === (c === home);
      inbox.add(c.id, 'board', { icon: '📋', title: 'W.O. · ' + title, text: absent
        ? 'O ' + c.name + ' não tinha 11 jogadores (com um goleiro) no horário do jogo e perdeu por W.O. Mantenha o elenco completo para os jogos marcados.'
        : 'O adversário não tinha time no horário: vitória por W.O. (3 x 0).' });
      notify(c.id, { title: '📋 W.O. · ' + title, body: absent ? 'Seu clube não tinha 11 jogadores e perdeu por W.O.' : 'Vitória por W.O. (3 x 0).' });
    }
    afterLeagueResult(l, f.id, out);
    return null;
  }
  const live = now - f.at < LIVE_WINDOW;
  const rec = playMatch(home, away, false, {
    knockout: l.format === 'cup', league: l, fixtureId: f.id, stage: f.stage, at: f.at,
    lineups: { home: H.lineup, away: A.lineup }, filled: { home: H.filled, away: A.filled },
    session: live ? { baseTime: f.at + START_DELAY, spectators: l.members.slice() } : null, noSession: !live
  });
  if (live) for (const id of l.members) push(id, 'live', { matchId: rec.id, league: l.name, stage: f.stage, home: home.name, away: away.name, mine: id === home.id || id === away.id });
  pushAll('clubs', {});
  return rec;
}

/** Análise do auxiliar para os dois clubes de um jogo marcado. */
function scoutFixture(l, f) {
  const now = Date.now();
  for (const [meId, oppId] of [[f.home, f.away], [f.away, f.home]]) {
    const me = db.clubs[meId], opp = db.clubs[oppId];
    if (!me || !opp) continue;
    const xi = c => c.lineup.map(id => id && catalog.playerById.get(id)).filter(Boolean);
    const out = c => xi(c).filter(p => TR.unavailable(catalog.train.get(p.id), f.at));
    const st = NW.streak(db.matches, opp.id).all.slice(0, 5).map(x => ({ w: 'V', d: 'E', l: 'D' }[x])).join(' ');
    const text = LK.scout({
      opp: { name: opp.name, formation: opp.formation, tactic: opp.tactic || 'balanced' }, oppXi: xi(opp), mineXi: xi(me), oppOut: out(opp).length,
      mineOut: out(me).map(p => p.short || p.name), oppForm: st,
      tired: xi(me).map(p => ({ short: p.short || p.name, cond: Math.floor(condOf(p.id, modsOf(me), now)) })).filter(x => x.cond < 60)
    });
    inbox.add(me.id, 'aux', { title: 'Análise do adversário · ' + opp.name, text, league: l.id, fixtureId: f.id, at: f.at, home: clubInfo(f.home).name, away: clubInfo(f.away).name, stage: f.stage });
  }
}

function remindFixture(l, f) {
  const h = clubInfo(f.home).name, a = clubInfo(f.away).name, when = SC.label(f.at).split(' às ')[1];
  for (const id of [f.home, f.away]) {
    notify(id, { title: '⏰ Seu jogo começa às ' + when, body: h + ' x ' + a + ' (' + l.name + '). Confira a escalação, as instruções do auxiliar e a preleção!', url: '/', urgent: true }, true);
    push(id, 'note', { text: '⏰ ' + h + ' x ' + a + ' começa às ' + when + ' (' + l.name + '). Confira a escalação e faça a preleção!' });
  }
}

let schedRunning = false;
function runScheduler() {
  if (schedRunning || !catalog) return;
  schedRunning = true;
  try {
    const now = Date.now();
    for (const l of Object.values(db.leagues)) {
      if (l.status !== 'running' || !l.fixtures.some(f => f.at && !f.score)) continue;
      let changed = false;
      for (const f of l.fixtures) {
        if (f.score || !f.at || f.at <= now) continue;
        f.extra = f.extra || {};
        if (!f.extra.pre && f.at - now <= PRE_NOTICE) { f.extra.pre = true; changed = true; scoutFixture(l, f); }
        if (!f.extra.remind && f.at - now <= REMIND) { f.extra.remind = true; changed = true; remindFixture(l, f); }
      }
      for (const f of l.fixtures.filter(x => !x.score && x.at && x.at <= now).sort((a, b) => a.at - b.at)) {
        if (l.status !== 'running' || f.score) continue;
        try { playScheduled(l, f, now); } catch (e) { console.error('[agenda] falha no jogo', f.id, e); }
        changed = true;
      }
      if (changed) save();
    }
  } finally { schedRunning = false; }
}

/** Acorda o servidor (chamado pelo "despertador" do Supabase perto dos jogos marcados). */
route('GET', '/api/wake', () => { runScheduler(); return { ok: true }; });

/* ---------- caixa de entrada, vestiário e conversas entre técnicos ---------- */
route('GET', '/api/inbox', (req, url) => {
  const me = auth(req, url);
  const kind = url.searchParams.get('kind');
  return { messages: inbox.list(me.id, inbox.KINDS.includes(kind) ? kind : null), unread: inbox.unread(me.id) };
});
route('POST', '/api/inbox/read', (req, url, body) => {
  const me = auth(req, url);
  inbox.markRead(me.id, { ids: Array.isArray(body.ids) ? body.ids.map(String) : null, kind: inbox.KINDS.includes(body.kind) ? body.kind : null, withId: body.with ? String(body.with) : null });
  return { unread: inbox.unread(me.id) };
});
/** Relatório de uma partida do meu clube (para o botão do visualizador). */
route('GET', '/api/report', (req, url) => {
  const me = auth(req, url);
  const id = url.searchParams.get('match');
  const m = inbox.list(me.id, 'report', 150).find(x => x.data.matchId === id);
  if (!m) bad('Relatório não encontrado para esta partida.', 404);
  return { message: m };
});

/** Vestiário: moral de cada jogador, promessas e a preleção guardada. */
route('GET', '/api/locker', (req, url) => {
  const me = auth(req, url);
  LK.prune(me);
  const L = (me.extra && me.extra.locker) || {};
  return {
    players: me.squad.map(id => { const e = L[id] || {}, m = LK.moralOf(me, id); return { id, moral: m, mood: LK.mood(m), bench: e.bench || 0, promise: e.promise ? e.promise.n : 0, effect: +((LK.moralMult(m) - 1) * 100).toFixed(1) }; }),
    talk: me.extra && me.extra.talk ? me.extra.talk.style : null
  };
});
route('POST', '/api/locker/reply', (req, url, body) => {
  const me = auth(req, url);
  const m = inbox.get(me.id, String(body.id));
  if (!m || m.kind !== 'locker') bad('Mensagem não encontrada.', 404);
  if (m.data.answered) bad('Você já respondeu esta mensagem.', 409);
  if (!me.squad.includes(m.data.playerId)) bad(m.data.name + ' não é mais do seu elenco.', 409);
  const r = LK.answer(me, m.data, String(body.option), { catalog, lineup: me.lineup.filter(Boolean) });
  if (!r) bad('Resposta inválida.');
  if (r.goto && r.goto.rest) { // colocar em descanso já é feito aqui
    const rows = r.goto.rest.filter(id => me.squad.includes(id)).map(id => { const s = trainState(id); TR.setRest(s, true, Date.now(), modsOf(me)); return [id, s]; });
    store.saveTraining(rows);
    r.goto = null;
  }
  const opt = (m.data.options || []).find(o => o.key === String(body.option));
  m.data = Object.assign({}, m.data, { answered: String(body.option), answerLabel: opt ? opt.label : '', reply: r.reply, moral: r.moral, delta: r.delta });
  m.read = true;
  inbox.update(me.id, m);
  missionsDone(me, MS.progress(me, TR.dayKey(Date.now()), 'locker'));
  save();
  return { message: m, goto: r.goto, club: privateClub(me), unread: inbox.unread(me.id) };
});
/** Preleção para o próximo jogo oficial (null tira). */
route('POST', '/api/talk', (req, url, body) => {
  const me = auth(req, url);
  if (body.style == null) { if (me.extra) delete me.extra.talk; }
  else if (!LK.setTalk(me, String(body.style), Date.now())) bad('Preleção inválida.');
  save();
  return { club: privateClub(me) };
});

const dmLimit = new CH.RateLimiter(5, 10000);
/** Conversas com outros técnicos: uma por clube, com a última mensagem e quantas não li. */
route('GET', '/api/dm', (req, url) => {
  const me = auth(req, url);
  const withId = url.searchParams.get('with');
  const all = inbox.list(me.id, 'dm', 150);
  if (withId) return { with: clubInfo(withId), messages: all.filter(m => m.data.with === withId).reverse() };
  const threads = new Map();
  for (const m of all) { // mais novas primeiro
    const t = threads.get(m.data.with) || { with: clubInfo(m.data.with), last: m, unread: 0 };
    if (!m.read) t.unread++;
    threads.set(m.data.with, t);
  }
  return { threads: [...threads.values()] };
});
route('POST', '/api/dm', (req, url, body) => {
  const me = auth(req, url);
  const to = db.clubs[String(body.to)];
  if (!to || to.id === me.id) bad('Escolha outro clube.');
  const text = CH.clean(body.text);
  if (!text) bad('Escreva uma mensagem.');
  if (!dmLimit.allow(me.id)) bad('Calma! Você está mandando mensagens rápido demais.', 429);
  const mine = inbox.add(me.id, 'dm', { with: to.id, from: me.id, text }, { read: true, silent: true });
  inbox.add(to.id, 'dm', { with: me.id, from: me.id, text });
  notify(to.id, { title: '💬 ' + me.name + ' (' + me.manager + ')', body: text, url: '/?dm=' + me.id, tag: 'dm-' + me.id });
  missionsDone(me, MS.progress(me, TR.dayKey(Date.now()), 'dm'));
  save();
  return { message: mine };
});

/* ---------- missões, base, jornal ---------- */
route('GET', '/api/missions', (req, url) => {
  const me = auth(req, url);
  const now = Date.now(), day = TR.dayKey(now);
  const list = MS.view(me, day);
  const goals = Object.values(db.leagues).filter(l => l.members.includes(me.id) && l.status === 'running' && l.extra && l.extra.goals && l.extra.goals[me.id])
    .map(l => ({ league: l.name, id: l.id, text: l.extra.goals[me.id].text, prize: MS.GOAL_PRIZE }));
  save(); // o sorteio das missões do dia fica gravado
  return { day, missions: list, goals, resetsAt: Math.floor((now - SC.TZ) / 864e5 + 1) * 864e5 + SC.TZ };
});

route('GET', '/api/academy', (req, url) => {
  const me = auth(req, url);
  const now = Date.now();
  return Object.assign(AC.list(me, now, FAC.levelOf(me.facilities, 'ct')), { squad: me.squad.length, squadMax: R.SQUAD_MAX });
});
route('POST', '/api/academy/sign', (req, url, body) => {
  const me = auth(req, url);
  const now = Date.now(), ct = FAC.levelOf(me.facilities, 'ct');
  const cand = AC.list(me, now, ct).players.find(p => p.id === String(body.id));
  if (!cand) bad('Essa promessa não está mais na base.', 404);
  if (me.squad.length >= R.SQUAD_MAX) bad('Elenco cheio (máx. ' + R.SQUAD_MAX + ').');
  if (cand.value > me.budget) bad('Saldo insuficiente (preço: ' + millions(cand.value) + ').', 402);
  const p = catalog.add(AC.sign(me, cand.id, now, ct)); // vira jogador do catálogo (gravado como os importados)
  me.squad.push(p.id);
  me.budget -= cand.value;
  arrived(me, p, true); // a promessa da base sempre se apresenta
  save();
  pushAll('market', { id: p.id });
  return { club: privateClub(me), player: Object.assign({}, p, { owner: ownerTag(p.id) }) };
});

let newsCache = { at: 0, data: null };
route('GET', '/api/news', (req, url) => {
  const me = auth(req, url);
  const now = Date.now();
  const seen = revealedMatches(); // o que ainda passa ao vivo não vira notícia antes do apito final
  const key = seen.length + '|' + (seen.length ? seen[seen.length - 1].id : '');
  if (!newsCache.data || newsCache.key !== key || now - newsCache.at > 20000) newsCache = { at: now, key, data: { headlines: NW.headlines(seen, now), team: NW.teamOfWeek(seen, now) } };
  // próximo jogo marcado do meu clube e jogos ao vivo agora
  const mine = [], live = [];
  for (const l of Object.values(db.leagues)) {
    if (l.status !== 'running' || !l.members.includes(me.id)) continue;
    for (const f of l.fixtures) {
      if (!f.score && f.at && (f.home === me.id || f.away === me.id)) mine.push({ league: l.name, leagueId: l.id, fixtureId: f.id, stage: f.stage, at: f.at, atLabel: SC.label(f.at),
        home: clubInfo(f.home), away: clubInfo(f.away), myBet: f.extra && f.extra.bets && f.extra.bets[me.id] ? f.extra.bets[me.id] : null, classic: NW.isClassic(db.matches, f.home, f.away) });
      if (f.matchId && unrevealed(f.matchId)) live.push({ matchId: f.matchId, league: l.name, stage: f.stage, home: clubInfo(f.home).name, away: clubInfo(f.away).name });
    }
  }
  mine.sort((a, b) => a.at - b.at);
  return Object.assign({}, newsCache.data, { next: mine[0] || null, live });
});

/* ---------- notificações no celular ---------- */
route('GET', '/api/push/key', () => ({ key: pushSvc.publicKey() }));
route('POST', '/api/push/subscribe', (req, url, body) => {
  const me = auth(req, url);
  if (!pushSvc.add(me.id, body.subscription)) bad('Inscrição inválida.');
  return { ok: true };
});
route('POST', '/api/push/unsubscribe', (req, url, body) => {
  auth(req, url);
  if (body.endpoint) pushSvc.remove(String(body.endpoint));
  return { ok: true };
});
route('POST', '/api/push/test', (req, url) => {
  const me = auth(req, url);
  notify(me.id, { title: '🔔 Notificações ligadas', body: 'Você vai saber dos seus jogos, resultados e mensagens mesmo com o jogo fechado.' }, true);
  return { ok: true };
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
  XC = createExchange({ db, catalog, R, save, push: pushNote, pushAll, beforeMove: id => settleFitness([id]),
    afterGive: (club, id) => { const p = catalog.playerById.get(id); if (p) arrived(club, p); } });
  try { await inbox.load(); } catch (e) { console.error('[caixa de entrada] não carregou (a tabela messages existe?):', e.message); }
  try { await pushSvc.init(); } catch (e) { console.error('[notificações] desligadas:', e.message); }
  for (const l of Object.values(db.leagues)) if (l.status === 'running') SC.assign(l, Date.now()); // agenda nova, rodada nova de copa...
  runScheduler(); // jogos marcados que venceram enquanto o servidor estava desligado
  setInterval(runScheduler, SCHEDULER_MS);
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
