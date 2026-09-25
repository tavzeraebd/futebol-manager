/*
 * Leilão ao vivo e trocas entre amigos. Lógica separada do servidor HTTP (recebe o contexto por parâmetro).
 *  - Leilão: só o dono abre, e só para jogador/técnico do PRÓPRIO clube (quem está no mercado, sem clube, se contrata direto e não vai
 *    a leilão); lances em tempo real; +10s se der lance no final. O vencedor paga o valor ao vendedor (sem o desconto da venda ao banco).
 *  - Troca: proposta de jogadores/técnico + dinheiro entre dois clubes; o outro aceita ou recusa.
 */
const crypto = require('crypto');
const PR = require('./pricing');

const AUCTION_SECONDS = 45;
const SNIPE_SECONDS = 10;      // lance nos últimos segundos estende o leilão até aqui
const MAX_AUCTIONS_PER_CLUB = 2;
const MAX_TRADES_PENDING = 5;
const MIN_STEP = 1e6;

const roundStep = v => Math.ceil(v / 1e5) * 1e5;
const nextMin = a => (a.bid ? a.bid.amount + Math.max(MIN_STEP, roundStep(a.bid.amount * 0.05)) : a.startPrice);

function createExchange(ctx) {
  // beforeMove(id): antes de o item mudar de clube; afterGive(club, id): jogador chegou ao clube (apresentação no vestiário)
  const { db, catalog, R, save, push, pushAll, now = Date.now, beforeMove = () => {}, afterGive = () => {} } = ctx;
  const auctions = new Map();  // id -> leilão (em memória: leilão em andamento não sobrevive a reinício)
  const finished = [];          // últimos encerrados
  if (!db.trades) db.trades = [];

  const item = id => catalog.playerById.get(id) || catalog.coachById.get(id) || null;
  const isCoach = id => catalog.coachById.has(id);
  const ownerOf = id => Object.values(db.clubs).find(c => c.squad.includes(id) || c.coach === id) || null;
  const err = (msg, code = 400) => { const e = new Error(msg); e.code = code; e.exchange = true; return e; };
  const money = v => (v >= 1e6 ? (Math.round(v / 1e5) / 10) + ' M' : Math.round(v / 1e3) + ' mil');

  const liveAuctionOf = id => [...auctions.values()].find(a => a.itemId === id);
  /** Dinheiro e vagas já comprometidos com lances vencendo em outros leilões. */
  function committed(clubId, exceptId) {
    let cash = 0, players = 0, coaches = 0;
    for (const a of auctions.values()) {
      if (a.id === exceptId || !a.bid || a.bid.clubId !== clubId) continue;
      cash += a.bid.amount;
      if (a.kind === 'coach') coaches++; else players++;
    }
    return { cash, players, coaches };
  }

  function take(club, id) { // tira o item do clube
    beforeMove(id);
    if (club.coach === id) club.coach = null;
    else { club.squad = club.squad.filter(x => x !== id); club.lineup = club.lineup.map(x => (x === id ? null : x)); }
  }
  function give(club, id) { if (isCoach(id)) club.coach = id; else { club.squad.push(id); afterGive(club, id); } }

  /* ---------- leilão ---------- */
  function auctionView(a) {
    const it = item(a.itemId);
    const seller = a.seller && db.clubs[a.seller];
    return {
      id: a.id, itemId: a.itemId, kind: a.kind, name: it ? it.name : a.itemId, short: it ? it.short : '', value: it ? it.value : 0,
      pos: it && it.pos, ovr: it && it.ovr, team: it && it.club,
      seller: a.seller, sellerName: seller ? seller.name : 'Sem clube', startPrice: a.startPrice,
      bid: a.bid ? { clubId: a.bid.clubId, name: (db.clubs[a.bid.clubId] || {}).name, amount: a.bid.amount } : null,
      bids: a.bids.slice(-8), minBid: nextMin(a), endsAt: a.endsAt, now: now(), status: a.status, result: a.result || null
    };
  }
  const snapshot = () => ({ live: [...auctions.values()].map(auctionView), done: finished.slice(-8).reverse(), now: now() });
  const broadcast = () => pushAll('auction', snapshot());

  function startAuction(club, body) {
    const it = item(body.id);
    if (!it) throw err('Item não encontrado.', 404);
    const owner = ownerOf(it.id);
    if (!owner) throw err(it.name + ' está no mercado e não pode ir a leilão: leilão é só para jogadores e técnico do seu clube. Contrate-o direto na aba Mercado.', 409);
    if (owner.id !== club.id) throw err('Só o dono (' + owner.name + ') pode leiloar esse item.', 409);
    if (liveAuctionOf(it.id)) throw err('Esse item já está em leilão.', 409);
    if ([...auctions.values()].filter(a => a.starter === club.id).length >= MAX_AUCTIONS_PER_CLUB) throw err('Você já tem ' + MAX_AUCTIONS_PER_CLUB + ' leilões abertos.');
    if (db.trades.some(t => t.status === 'pending' && (t.give.includes(it.id) || t.get.includes(it.id)))) throw err('Esse item está numa proposta de troca pendente.', 409);
    const g = PR.guide(catalog, it); // preço fica perto da média de jogadores parecidos (evita "vender" quase de graça entre contas do mesmo dono)
    const start = body.startPrice == null ? g.reference : Math.round(+body.startPrice);
    if (!Number.isFinite(start)) throw err('Preço inicial inválido.');
    if (start < g.band.min) throw err('Preço muito abaixo da média: o mínimo é € ' + money(g.band.min) + ' (' + Math.round(g.band.low * 100) + '% da média de € ' + money(g.reference) + ' de jogadores parecidos).');
    if (start > g.band.max) throw err('Preço muito acima da média: o máximo é € ' + money(g.band.max) + ' (' + Math.round(g.band.high * 100) + '% da média de € ' + money(g.reference) + ' de jogadores parecidos).');
    const a = { id: crypto.randomUUID(), itemId: it.id, kind: isCoach(it.id) ? 'coach' : 'player', seller: owner.id, starter: club.id, startPrice: start, bid: null, bids: [], createdAt: now(), endsAt: now() + AUCTION_SECONDS * 1000, status: 'live' };
    auctions.set(a.id, a);
    broadcast();
    return auctionView(a);
  }

  function placeBid(club, body) {
    const a = auctions.get(body.id);
    if (!a || a.status !== 'live') throw err('Leilão encerrado.', 404);
    if (now() >= a.endsAt) { closeAuction(a); throw err('Leilão encerrado.', 409); }
    if (a.seller === club.id || a.starter === club.id) throw err('Você não pode dar lance no seu próprio leilão.');
    if (a.bid && a.bid.clubId === club.id) throw err('Você já está vencendo esse leilão.');
    const amount = Math.round(+body.amount);
    if (!Number.isFinite(amount)) throw err('Lance inválido.');
    if (amount < nextMin(a)) throw err('O lance mínimo agora é € ' + money(nextMin(a)) + '.', 409);
    const c = committed(club.id, a.id);
    if (amount + c.cash > club.budget) throw err('Saldo insuficiente' + (c.cash ? ' (você já tem € ' + money(c.cash) + ' em lances vencendo)' : '') + '.', 402);
    if (a.kind === 'coach') { if (club.coach || c.coaches) throw err('Você já tem um técnico.'); }
    else if (club.squad.length + c.players >= R.SQUAD_MAX) throw err('Elenco cheio (contando os leilões que você está vencendo).');
    a.bid = { clubId: club.id, amount, at: now() };
    a.bids.push({ clubId: club.id, name: club.name, amount });
    if (a.endsAt - now() < SNIPE_SECONDS * 1000) a.endsAt = now() + SNIPE_SECONDS * 1000;
    broadcast();
    return auctionView(a);
  }

  function closeAuction(a) {
    if (a.status !== 'live') return;
    a.status = 'done';
    auctions.delete(a.id);
    const it = item(a.itemId);
    const seller = a.seller && db.clubs[a.seller];
    let result;
    if (!a.bid) {
      result = { sold: false, text: 'Sem lances: ' + it.name + ' continua ' + (seller ? 'com ' + seller.name : 'no mercado') + '.' };
    } else {
      const buyer = db.clubs[a.bid.clubId];
      const valid = buyer && buyer.budget >= a.bid.amount && (a.kind === 'coach' ? !buyer.coach : buyer.squad.length < R.SQUAD_MAX) &&
        (!a.seller || (seller && (seller.squad.includes(a.itemId) || seller.coach === a.itemId)));
      if (!valid) result = { sold: false, text: 'Leilão de ' + it.name + ' anulado (o vencedor não pôde pagar ou o item mudou de dono).' };
      else {
        if (seller) { take(seller, a.itemId); seller.budget += a.bid.amount; }
        buyer.budget -= a.bid.amount;
        give(buyer, a.itemId);
        result = { sold: true, buyer: buyer.id, buyerName: buyer.name, amount: a.bid.amount, text: it.name + ' vai para o ' + buyer.name + ' por € ' + money(a.bid.amount) + '!' };
        save();
        pushAll('market', { id: a.itemId });
        push(buyer.id, 'note', { text: '🔨 Você levou ' + it.name + ' por € ' + money(a.bid.amount) + '!' });
        if (seller) push(seller.id, 'note', { text: '💰 ' + it.name + ' foi vendido por € ' + money(a.bid.amount) + '.' });
      }
    }
    a.result = result;
    const v = auctionView(a);
    finished.push(v);
    if (finished.length > 30) finished.shift();
    pushAll('auction', snapshot());
    pushAll('clubs', {});
  }

  const timer = setInterval(() => { for (const a of [...auctions.values()]) if (now() >= a.endsAt) closeAuction(a); }, 500);
  if (timer.unref) timer.unref();

  /* ---------- trocas ---------- */
  const tradeView = t => {
    const list = ids => ids.map(id => { const it = item(id); return { id, name: it ? it.name : id, coach: isCoach(id), ovr: it && it.ovr, pos: it && it.pos, value: it ? it.value : 0 }; });
    return { id: t.id, from: t.from, fromName: (db.clubs[t.from] || {}).name, to: t.to, toName: (db.clubs[t.to] || {}).name, give: list(t.give), get: list(t.get), cash: t.cash, status: t.status, at: t.at, why: t.why || null };
  };
  const tradesOf = clubId => db.trades.filter(t => t.from === clubId || t.to === clubId).slice(-30).reverse().map(tradeView);

  /** Confere se a troca ainda é possível. Devolve o texto do problema, ou null. */
  function tradeProblem(t) {
    const a = db.clubs[t.from], b = db.clubs[t.to];
    if (!a || !b) return 'Clube não existe mais.';
    for (const id of t.give) if (!(a.squad.includes(id) || a.coach === id)) return item(id).name + ' não é mais de ' + a.name + '.';
    for (const id of t.get) if (!(b.squad.includes(id) || b.coach === id)) return item(id).name + ' não é mais de ' + b.name + '.';
    for (const id of [...t.give, ...t.get]) if (liveAuctionOf(id)) return item(id).name + ' está em leilão.';
    const pl = ids => ids.filter(id => !isCoach(id)).length, co = ids => ids.filter(isCoach).length;
    if (a.squad.length - pl(t.give) + pl(t.get) > R.SQUAD_MAX) return 'O elenco de ' + a.name + ' ficaria acima de ' + R.SQUAD_MAX + '.';
    if (b.squad.length - pl(t.get) + pl(t.give) > R.SQUAD_MAX) return 'O elenco de ' + b.name + ' ficaria acima de ' + R.SQUAD_MAX + '.';
    if ((a.coach && !t.give.includes(a.coach) ? 1 : 0) + co(t.get) > 1) return a.name + ' ficaria com dois técnicos.';
    if ((b.coach && !t.get.includes(b.coach) ? 1 : 0) + co(t.give) > 1) return b.name + ' ficaria com dois técnicos.';
    if (t.cash > 0 && a.budget < t.cash) return a.name + ' não tem saldo para o dinheiro da proposta.';
    if (t.cash < 0 && b.budget < -t.cash) return b.name + ' não tem saldo para o dinheiro da proposta.';
    return null;
  }

  function proposeTrade(club, body) {
    const to = db.clubs[body.to];
    if (!to || to.id === club.id) throw err('Escolha outro clube.');
    const ids = x => (Array.isArray(x) ? [...new Set(x.map(String))] : []);
    const t = { id: crypto.randomUUID(), from: club.id, to: to.id, give: ids(body.give), get: ids(body.get), cash: Math.round(+body.cash || 0), status: 'pending', at: now() };
    if (!t.give.length && !t.get.length && !t.cash) throw err('A proposta está vazia.');
    if (t.give.length > 5 || t.get.length > 5) throw err('No máximo 5 itens de cada lado.');
    if (Math.abs(t.cash) > 5e9) throw err('Valor em dinheiro inválido.');
    for (const id of [...t.give, ...t.get]) if (!item(id)) throw err('Item não encontrado.', 404);
    if (db.trades.filter(x => x.from === club.id && x.status === 'pending').length >= MAX_TRADES_PENDING) throw err('Você já tem ' + MAX_TRADES_PENDING + ' propostas pendentes.');
    const p = tradeProblem(t);
    if (p) throw err(p, 409);
    const worth = ids => ids.reduce((s, id) => s + (item(id) ? item(id).value : 0), 0);
    const out = worth(t.give) + Math.max(t.cash, 0), inn = worth(t.get) + Math.max(-t.cash, 0); // o que você entrega x o que recebe
    if (Math.min(out, inn) <= 0 || Math.max(out, inn) / Math.min(out, inn) > PR.TRADE_MAX_RATIO) {
      throw err('Troca desequilibrada: você entrega € ' + money(out) + ' e recebe € ' + money(inn) + ' (valores de mercado). A diferença pode ser de no máximo ' + Math.round((PR.TRADE_MAX_RATIO - 1) * 100) + '%; ajuste jogadores ou dinheiro.');
    }
    db.trades.push(t);
    if (db.trades.length > 400) db.trades.splice(0, db.trades.length - 400);
    save();
    push(to.id, 'trade', { id: t.id });
    push(to.id, 'note', { text: '🤝 ' + club.name + ' enviou uma proposta de troca. Veja em "Leilão e trocas".' });
    push(club.id, 'trade', { id: t.id });
    return tradeView(t);
  }

  function respondTrade(club, body) {
    const t = db.trades.find(x => x.id === body.id);
    if (!t || t.status !== 'pending') throw err('Proposta não está mais aberta.', 404);
    const a = db.clubs[t.from], b = db.clubs[t.to];
    const other = id => push(id, 'trade', { id: t.id });
    if (body.action === 'cancel') {
      if (t.from !== club.id) throw err('Só quem propôs pode cancelar.', 403);
      t.status = 'canceled';
    } else {
      if (t.to !== club.id) throw err('Essa proposta não é para você.', 403);
      if (body.action === 'reject') { t.status = 'rejected'; push(a.id, 'note', { text: '❌ ' + b.name + ' recusou sua proposta de troca.' }); }
      else if (body.action === 'accept') {
        const p = tradeProblem(t);
        if (p) { t.status = 'void'; t.why = p; save(); other(a.id); other(b.id); throw err('Troca anulada: ' + p, 409); }
        for (const id of t.give) { take(a, id); give(b, id); }
        for (const id of t.get) { take(b, id); give(a, id); }
        a.budget -= t.cash; b.budget += t.cash;
        t.status = 'accepted';
        pushAll('market', {});
        push(a.id, 'note', { text: '✅ ' + b.name + ' aceitou a troca!' });
      } else throw err('Ação inválida.');
    }
    save();
    other(a.id); other(b.id);
    pushAll('clubs', {});
    return tradeView(t);
  }

  /** Usado por comprar/vender no mercado: bloqueia item que está em leilão ou em troca pendente. */
  const lockedReason = id => (liveAuctionOf(id) ? 'Esse item está em leilão.' : db.trades.some(t => t.status === 'pending' && (t.give.includes(id) || t.get.includes(id))) ? 'Esse item está numa proposta de troca pendente.' : null);

  return { snapshot, startAuction, placeBid, closeAuction, proposeTrade, respondTrade, tradesOf, lockedReason, auctions, AUCTION_SECONDS };
}

module.exports = { createExchange, AUCTION_SECONDS, SNIPE_SECONDS, nextMin };
