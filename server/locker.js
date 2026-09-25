/*
 * Vestiário (funções puras sobre club.extra.locker e club.extra.talk; o servidor grava e envia as mensagens).
 *
 * Moral (0-100) de cada jogador do elenco: começa em 60 (70 para quem acabou de chegar), sobe com vitórias, boas atuações e
 * minutos em campo, cai com derrotas, banco seguido e promessas quebradas. Em campo vale no máximo ±3% nas habilidades
 * (moralMult), montado pelo servidor na definição do time (rules.buildTeamDef, opts.mult): o motor não muda.
 *
 * Os jogadores mandam mensagens ao técnico depois dos jogos (pedem chance, agradecem, avisam lesão, pedem descanso...). Cada
 * mensagem traz opções de resposta (OPTIONS) que mexem na moral; "prometer vaga" vira compromisso (PROMISE_GAMES jogos oficiais).
 *
 * Preleção: antes de uma partida oficial o técnico escolhe incentivar, cobrar ou tranquilizar; vale para o próximo jogo oficial
 * e o efeito depende de o time ser favorito, azarão ou os dois parelhos (PRE).
 */
const DEFAULT = 60, NEW_SIGNING = 70;
const MOODS = [[80, 'Motivado', '😄'], [60, 'Confiante', '🙂'], [40, 'Normal', '😐'], [25, 'Insatisfeito', '😕'], [0, 'Revoltado', '😠']];
const MORAL_EFFECT = 0.03;      // moral 100 = +3%; moral 20 = -3%
const PROMISE_GAMES = 2;        // a vaga prometida precisa sair num dos próximos 2 jogos oficiais
const DAY = 24 * 3600e3;
const COOLDOWN = { chance: 3 * DAY, thanks: 2 * DAY, bad: 2 * DAY, tired: 2 * DAY, unhappy: 4 * DAY };
const MAX_MSGS_PER_MATCH = 3;

/** Preleção: fração nas habilidades conforme o time é favorito, parelho ou azarão (pela nota média dos titulares). */
const PRE = {
  motivate: { label: 'Incentivar', fav: 0.02, even: 0.02, dog: 0.02, about: 'Seguro: +2% em qualquer jogo.' },
  push: { label: 'Cobrar', fav: 0.04, even: 0.02, dog: -0.01, about: 'Funciona quando o time é favorito (+4%); contra time mais forte, pesa (-1%).' },
  calm: { label: 'Tranquilizar', fav: 0.01, even: 0.02, dog: 0.04, about: 'Funciona quando o time é azarão (+4%); sendo favorito, rende pouco (+1%).' }
};
const FAV_GAP = 1.5; // diferença de nota média para um time ser favorito

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function store(club) {
  if (!club.extra) club.extra = {};
  if (!club.extra.locker) club.extra.locker = {};
  return club.extra.locker;
}
/** Estado do jogador no vestiário (cria com a moral padrão). */
function entry(club, id, moral) {
  const L = store(club);
  if (!L[id]) L[id] = { moral: moral != null ? moral : DEFAULT, bench: 0 };
  return L[id];
}
const moralOf = (club, id) => { const e = club.extra && club.extra.locker && club.extra.locker[id]; return e ? e.moral : DEFAULT; };
const moralMult = m => 1 + clamp((m - DEFAULT) / 40, -1, 1) * MORAL_EFFECT;
const mood = m => { const x = MOODS.find(r => m >= r[0]); return { label: x[1], icon: x[2] }; };
function bump(club, id, d) { const e = entry(club, id); e.moral = Math.round(clamp(e.moral + d, 0, 100)); return e.moral; }

/** Tira do vestiário quem não é mais do elenco. */
function prune(club) {
  const L = store(club), keep = new Set(club.squad);
  for (const id of Object.keys(L)) if (!keep.has(id)) delete L[id];
}

/** Chegou ao elenco (compra, troca, leilão ou base): moral alta e mensagem de apresentação. */
function arrive(club, p) {
  const L = store(club);
  L[p.id] = { moral: NEW_SIGNING, bench: 0 };
  return msg(p, 'hello', 'Cheguei, professor! Pronto para ajudar o ' + club.name + '. Pode contar comigo' + (p.role === 'GK' ? ' debaixo das traves.' : ' em campo.'));
}

/** Mensagem de um jogador para o técnico (sem opções = só aviso). */
function msg(p, kind, text, extra) {
  const o = OPTIONS[kind] ? OPTIONS[kind](p, extra || {}) : [];
  return Object.assign({ from: 'player', playerId: p.id, name: p.name, short: p.short || p.name, pos: p.pos, kind, text, options: o, answered: null }, extra ? { ctx: extra } : {});
}

const FOCUS_NAME = { shot: 'finalização', pass: 'passe', dribble: 'drible', def: 'defesa', speed: 'velocidade', stamina: 'resistência' };

/** Respostas possíveis por tipo de mensagem: { key, label, hint? }. O efeito fica em answer(). */
const OPTIONS = {
  chance: () => [
    { key: 'promise', label: 'Prometer vaga de titular', hint: 'Moral +10 agora; se não for titular em ' + PROMISE_GAMES + ' jogos oficiais, -20' },
    { key: 'patience', label: 'Pedir paciência', hint: 'Entende se os titulares da posição forem melhores; senão, fica chateado' },
    { key: 'train', label: 'Mandar treinar para ganhar espaço', hint: 'Moral -3; abre o Centro de Treinamento' }
  ],
  thanks: () => [
    { key: 'praise', label: 'Elogiar na frente do grupo', hint: 'Moral +5' },
    { key: 'ground', label: 'Pedir pé no chão', hint: 'Moral +2' }
  ],
  bad: (p, x) => [
    { key: 'support', label: 'Dar apoio', hint: 'Moral +6' },
    { key: 'demand', label: 'Cobrar mais empenho', hint: 'Com moral alta, reage (+3); com moral baixa, se abala (-6)' },
    { key: 'train', label: 'Mandar treinar ' + (FOCUS_NAME[x.focus] || 'mais'), hint: 'Moral -1; abre o Centro de Treinamento' }
  ],
  injury: () => [
    { key: 'care', label: 'Desejar boa recuperação', hint: 'Moral +3' },
    { key: 'physio', label: 'Mandar para a fisioterapia', hint: 'Moral +4; abre o Centro de Treinamento (a fisioterapia tira um dia de lesão)' }
  ],
  tired: () => [
    { key: 'rest', label: 'Colocar em descanso', hint: 'Moral +4; recupera o dobro por hora' },
    { key: 'hold', label: 'Pedir para aguentar', hint: 'Moral -4' }
  ],
  unhappy: () => [
    { key: 'convince', label: 'Conversar e convencer a ficar', hint: 'Moral +12' },
    { key: 'sell', label: 'Dizer que vai negociá-lo', hint: 'Moral +4; abre o Elenco' }
  ],
  hello: () => [{ key: 'welcome', label: 'Dar as boas-vindas', hint: 'Moral +5' }]
};

/**
 * Resposta do técnico. Devolve { moral, reply, goto? } (goto: { tab, ids, focus?, physio? } = tela para a tela abrir) ou null se a opção não existe.
 * ctx: { squad: jogadores do elenco, lineup: ids dos titulares, catalog }.
 */
function answer(club, m, key, ctx) {
  if (!(OPTIONS[m.kind] ? OPTIONS[m.kind]({}, m.ctx || {}) : []).some(o => o.key === key)) return null;
  const id = m.playerId, e = entry(club, id);
  let d = 0, reply = '', go = null;
  const p = ctx.catalog.playerById.get(id);
  switch (m.kind + ':' + key) {
    case 'chance:promise': d = 10; e.promise = { n: PROMISE_GAMES }; reply = 'Valeu, professor! Vou estar pronto.'; break;
    case 'chance:patience': {
      const xi = ctx.lineup.map(x => ctx.catalog.playerById.get(x)).filter(x => x && p && x.role === p.role);
      const worse = p && xi.length && p.ovr < Math.min(...xi.map(x => x.ovr));
      d = worse ? 2 : -4;
      reply = worse ? 'Entendo. Vou continuar trabalhando.' : 'Paciência? Estou jogando melhor que muita gente…';
      break;
    }
    case 'chance:train': d = -3; reply = 'Tá bom… vou treinar.'; go = { tab: 'train', ids: [id] }; break;
    case 'thanks:praise': d = 5; reply = 'Obrigado! Isso me dá ainda mais confiança.'; break;
    case 'thanks:ground': d = 2; reply = 'Pode deixar, pé no chão e trabalho.'; break;
    case 'bad:support': d = 6; reply = 'Obrigado pelo apoio. No próximo eu compenso!'; break;
    case 'bad:demand': d = e.moral >= 50 ? 3 : -6; reply = e.moral >= 50 ? 'Justo. Vou dar a vida no próximo.' : 'Poxa, professor… já estou mal com isso.'; break;
    case 'bad:train': d = -1; reply = 'Certo, vou focar nisso.'; go = { tab: 'train', ids: [id], focus: (m.ctx && m.ctx.focus) || null }; break;
    case 'injury:care': d = 3; reply = 'Valeu! Volto logo.'; break;
    case 'injury:physio': d = 4; reply = 'Vou para a fisioterapia agora mesmo.'; go = { tab: 'train', ids: [id], physio: true }; break;
    case 'tired:rest': d = 4; reply = 'Obrigado, vou recarregar as energias.'; go = { rest: [id] }; break;
    case 'tired:hold': d = -4; reply = 'Tá… eu aguento.'; break;
    case 'unhappy:convince': d = 12; reply = 'Tudo bem, vou dar mais uma chance para esse projeto.'; break;
    case 'unhappy:sell': d = 4; reply = 'Obrigado pela sinceridade.'; go = { tab: 'squad' }; break;
    case 'hello:welcome': d = 5; reply = 'Obrigado! Bora ganhar tudo.'; break;
  }
  return { moral: bump(club, id, d), delta: d, reply, goto: go };
}

/**
 * Depois de uma partida oficial: moral de todo o elenco e mensagens dos jogadores ao técnico.
 * ctx: { r (1 vitória, 0 empate, -1 derrota; ±0,5 nos pênaltis), played: Map(id -> { rating, started }), xi: ids que começaram,
 *        injured: [{ id, days, kind }], tired: [{ id, cond }], unavailable: Set(ids lesionados/suspensos), catalog, now, focusOf(id) }
 * Devolve a lista de mensagens (no máximo MAX_MSGS_PER_MATCH, por prioridade).
 */
function afterMatch(club, ctx) {
  prune(club);
  const out = [], now = ctx.now, P = id => ctx.catalog.playerById.get(id);
  const can = (e, kind) => { e.sent = e.sent || {}; if (e.sent[kind] && now - e.sent[kind] < COOLDOWN[kind]) return false; e.sent[kind] = now; return true; };
  const push = (prio, m) => out.push({ prio, m });
  for (const id of club.squad) {
    const p = P(id);
    if (!p) continue;
    const e = entry(club, id), pl = ctx.played.get(id);
    let d = 0;
    if (pl) {
      e.bench = 0;
      d += ctx.r * 3 + 2 + (pl.rating >= 8 ? 4 : pl.rating >= 7 ? 2 : pl.rating < 5 ? -3 : 0);
    } else if (!ctx.unavailable.has(id)) {
      e.bench = (e.bench || 0) + 1;
      d -= e.bench >= 3 ? 3 : 2;
    }
    if (e.promise) {
      if (ctx.xi.includes(id)) { delete e.promise; d += 6; }
      else if (--e.promise.n <= 0) {
        delete e.promise; d -= 20;
        push(1, msg(p, 'broken', 'Professor, você me prometeu uma vaga e não cumpriu. Fiquei muito decepcionado.'));
      }
    }
    e.moral = Math.round(clamp(e.moral + d, 0, 100));
    if (pl && pl.rating >= 8.5 && can(e, 'thanks')) push(5, msg(p, 'thanks', ['Que jogo! Obrigado pela confiança, professor.', 'Saí de campo feliz demais. Obrigado por acreditar em mim!', 'Dia inspirado! Vamos manter essa pegada.'][id.length % 3]));
    if (pl && pl.rating <= 4.8 && can(e, 'bad')) {
      const focus = ctx.focusOf(id);
      push(4, msg(p, 'bad', 'Sei que não fui bem hoje (nota ' + pl.rating.toFixed(1).replace('.', ',') + '). Vou me dedicar mais.', { focus }));
    }
    if (!pl && !ctx.unavailable.has(id) && e.bench === 3 && !e.promise && can(e, 'chance')) push(2, msg(p, 'chance', 'Professor, estou há ' + e.bench + ' jogos sem entrar em campo. Quero uma chance para mostrar meu valor.'));
    if (e.moral < 25 && can(e, 'unhappy')) push(3, msg(p, 'unhappy', 'Não estou feliz aqui. Se as coisas não mudarem, quero sair do clube.'));
  }
  for (const x of ctx.injured) { const p = P(x.id); if (p) push(0, msg(p, 'injury', 'Me machuquei no jogo (' + x.kind + '). O médico disse que fico ' + x.days + (x.days > 1 ? ' dias' : ' dia') + ' fora.')); }
  for (const x of ctx.tired) { const p = P(x.id), e = p && entry(club, x.id); if (p && x.cond < 35 && can(e, 'tired')) push(6, msg(p, 'tired', 'Estou esgotado (' + x.cond + '% de condição). Preciso descansar antes do próximo jogo.')); }
  return out.sort((a, b) => a.prio - b.prio).slice(0, MAX_MSGS_PER_MATCH).map(x => x.m);
}

/** Preleção guardada para o próximo jogo oficial. */
function setTalk(club, style, now) {
  if (!PRE[style]) return false;
  if (!club.extra) club.extra = {};
  club.extra.talk = { style, at: now };
  return true;
}
/** Situação pela nota média dos titulares: 'fav' | 'even' | 'dog'. */
const sideOf = (mine, theirs) => (mine - theirs >= FAV_GAP ? 'fav' : theirs - mine >= FAV_GAP ? 'dog' : 'even');
/** Efeito da preleção guardada (e a consome). Devolve { style, label, side, k } ou null. */
function useTalk(club, mineOvr, oppOvr) {
  const t = club.extra && club.extra.talk;
  if (!t || !PRE[t.style]) return null;
  delete club.extra.talk;
  const side = sideOf(mineOvr, oppOvr);
  return { style: t.style, label: PRE[t.style].label, side, k: PRE[t.style][side] };
}

/**
 * Análise do auxiliar técnico antes de um jogo marcado: como o adversário joga, quem é o destaque, desfalques dos dois lados e
 * quem do nosso time está cansado. info = { opp, oppXi (jogadores), mineXi, oppOut (n), mineOut (nomes), tired ([{short, cond}]), oppForm ('VVEDV') }.
 */
function scout(info) {
  const T = { balanced: 'equilibrado', attack: 'ofensivo', defend: 'na retranca', counter: 'no contra-ataque', press: 'com pressão alta' };
  const TIP = {
    attack: 'eles deixam espaço atrás: o contra-ataque pode machucar.',
    defend: 'vão se fechar: vale mais gente no ataque (tática Ofensivo) e paciência.',
    counter: 'cuidado com a saída rápida deles: evite subir demais a linha.',
    press: 'marcam em cima: jogo rápido e bola longa ajudam a sair da pressão.',
    balanced: 'jogo parelho: o detalhe (bola parada e condição física) deve decidir.'
  };
  const avg = l => (l.length ? l.reduce((t, p) => t + p.ovr, 0) / l.length : 0);
  const a = avg(info.mineXi), b = avg(info.oppXi);
  const star = info.oppXi.slice().sort((x, y) => y.ovr - x.ovr)[0];
  const lines = [];
  lines.push('O ' + info.opp.name + ' deve vir no ' + (info.opp.formation || '4-3-3') + ', jogando ' + (T[info.opp.tactic] || 'equilibrado') + ': ' + (TIP[info.opp.tactic] || TIP.balanced));
  if (b) lines.push('Nota média deles: ' + b.toFixed(1).replace('.', ',') + ' contra ' + a.toFixed(1).replace('.', ',') + ' nossa — ' + (a - b >= FAV_GAP ? 'somos favoritos (uma preleção cobrando funciona bem).' : b - a >= FAV_GAP ? 'somos azarões (tranquilizar o grupo na preleção ajuda).' : 'jogo equilibrado.'));
  if (star) lines.push('Destaque deles: ' + star.name + ' (' + star.pos + ', nota ' + star.ovr + ').');
  if (info.oppForm) lines.push('Últimos jogos deles: ' + info.oppForm + '.');
  if (info.oppOut) lines.push('Eles têm ' + info.oppOut + ' desfalque(s) por lesão ou suspensão.');
  if (info.mineOut.length) lines.push('Nossos desfalques: ' + info.mineOut.join(', ') + ' (entra o melhor reserva).');
  if (info.tired.length) lines.push('Atenção à condição física: ' + info.tired.map(t => t.short + ' ' + t.cond + '%').join(', ') + '. Descanso ou fisioterapia antes do jogo ajudam.');
  return lines.join('\n');
}

module.exports = { DEFAULT, NEW_SIGNING, PRE, PROMISE_GAMES, MORAL_EFFECT, moralOf, moralMult, mood, entry, bump, prune, arrive, msg, answer, afterMatch, setTalk, useTalk, sideOf, scout, OPTIONS };
