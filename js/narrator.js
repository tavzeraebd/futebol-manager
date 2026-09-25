/*
 * Narrador: transforma os eventos do motor em frases em português, contando a jogada lance a lance:
 *   "Hudson-Odoi toca para Nico Williams, Nico Williams cruza para Lewandowski e GOOOOL! Lewandowski marca..."
 * Não depende do DOM. Cada linha: { min, text, voice, big, type }
 *  - voice: vale falar em voz alta   - big: lance decisivo (gol, apito), falado mesmo com a voz ocupada
 * As variações de frase usam um contador (não sorteio), então os dois clientes narram igual.
 */
(function (g) {
  'use strict';

  // sobrenomes comuns: nesses casos fala o nome completo para não confundir (ex.: Nico Williams x Neco Williams)
  const AMBIGUOUS = new Set(['Williams', 'Thomas', 'Fernandes', 'Fernández', 'Martínez', 'Silva', 'Díaz', 'Dias', 'Jesus', 'Santos', 'Pereira', 'Rodriguez', 'Costa', 'Ferreira', 'Júnior', 'Junior', 'Álvarez']);
  const CHAIN_GAP = 5;    // s sem passe = jogada acabou
  const STALE = 3;        // s parado: solta o que estava pendente

  class Narrator {
    constructor(match, onLine) {
      this.match = match;
      this.onLine = onLine;
      this.n = 0;
      this.chain = [];          // passes seguidos do mesmo time: [{ from, to, kind }]
      this.chainTeam = null;
      this.chainT = 0;
      this.recent = [];         // últimos passes (para ligar chute e gol ao passe de quem deu a assistência)
      this.shotCtx = null;      // jogada que levou ao último chute
      const count = {};
      for (const p of match.players) count[p.short] = (count[p.short] || 0) + 1;
      this.dup = new Set(Object.keys(count).filter(k => count[k] > 1));
      const full = {};
      for (const p of match.players) full[p.name] = (full[p.name] || 0) + 1;
      this.twin = new Set(Object.keys(full).filter(k => full[k] > 1)); // mesmo jogador nos dois times (ex.: contra a CPU)
      const handle = ev => { for (const line of this.describe(ev)) this.onLine(line); };
      for (const ev of match.events) handle(ev); // lances já ocorridos (o apito inicial acontece na criação da partida)
      match.on(handle);
    }

    _pick(list) { return list[this.n++ % list.length]; }
    _team(key) { return key === 'home' ? this.match.home.name : this.match.away.name; }
    _score() { const m = this.match; return m.home.name + ' ' + m.home.score + ' x ' + m.away.score + ' ' + m.away.name; }
    nm(p) {
      if (!p) return 'o jogador';
      const n = this.dup.has(p.short) || AMBIGUOUS.has(p.short) ? p.name : p.short;
      return this.twin.has(p.name) ? n + ' do ' + p.team.name : n;
    }
    _verb(kind) {
      if (kind === 'cross') return 'cruza';
      if (kind === 'long') return 'lança';
      if (kind === 'back') return 'recua';
      if (kind === 'through') return 'enfia a bola';
      return this._pick(['toca', 'toca', 'rola', 'passa']);
    }
    _seq(chain) { return chain.map(c => this.nm(c.from) + ' ' + this._verb(c.kind) + ' para ' + this.nm(c.to)).join(', '); }

    /** Fecha a jogada pendente numa frase (só se tiver `minLen` passes ou mais). */
    _flush(ev, out, minLen) {
      if (this.chain.length >= minLen) {
        out.push({ min: ev.min, type: 'play', text: this._seq(this.chain) + '.', voice: false, big: false, prio: 0 });
        for (const c of this.chain) c.told = true;
      }
      this.chain = [];
    }

    describe(ev) {
      const out = [];
      const p = ev.player, T = ev.t || 0;

      if (ev.type === 'pass') {
        if (this.chain.length && (ev.team !== this.chainTeam || T - this.chainT > CHAIN_GAP)) this._flush(ev, out, 1);
        // o passe nem sempre chega a quem foi mirado: quem passa em seguida é quem realmente ficou com a bola
        const prev = this.chain[this.chain.length - 1];
        if (prev) { if (prev.to !== p && p !== prev.from) prev.to = p; else if (p === prev.from) this._flush(ev, out, 1); }
        if (this.chain.length >= 3) this._flush(ev, out, 1); // solta 3 passes só depois de confirmar o último receptor
        const item = { from: p, to: ev.to, kind: ev.kind, team: ev.team, t: T, told: false };
        this.chain.push(item);
        this.recent.push(item);
        if (this.recent.length > 3) this.recent.shift();
        this.chainTeam = ev.team; this.chainT = T;
        out.push({ min: ev.min, type: 'call', feed: false, text: this.nm(p) + ' ' + this._verb(ev.kind) + ' para ' + this.nm(ev.to) + '.', voice: true, big: false, prio: 1 });
        return out;
      }

      if (ev.type === 'shot') {
        const last = this.recent[this.recent.length - 1];
        if (last && !last.told && last.team === ev.team && last.to !== p && last.from !== p && T - last.t <= 4) last.to = p;
        const setPiece = ev.kind === 'pen' || ev.kind === 'fk'; // bola parada: não herda a jogada de antes da falta
        const linked = !setPiece && !!last && last.to === p && last.team === ev.team && T - last.t <= 6;
        const lead = [];
        if (linked) {
          // só passes encadeados do mesmo time (quem recebeu é quem passa em seguida) e ainda não narrados
          for (let i = this.recent.length - 1; i >= 0 && lead.length < 2; i--) {
            const it = this.recent[i];
            if (it.told || it.team !== ev.team || (lead.length && it.to !== lead[0].from)) break;
            lead.unshift(it);
          }
        }
        if (linked && lead.length) { for (const c of lead) c.told = true; this.chain = []; } else this._flush(ev, out, 1);
        this.shotCtx = { shooter: p, lead, assist: linked && last.from !== p ? last.from : null, t: T, kind: ev.kind || null };
        const who = this.nm(p), seq = lead.length ? this._seq(lead) + ', que ' : who + ' ';
        let text, sh;
        if (ev.kind === 'pen') { // pênalti e falta direta: bola parada, sem jogada antes
          text = sh = ev.outcome === 'miss' ? who + ' bate o pênalti para fora!' : who + ' ' + this._pick(['bate o pênalti!', 'parte para a cobrança!']);
        } else if (ev.kind === 'fk') {
          text = sh = ev.outcome === 'block' ? who + ' cobra a falta e a bola explode na barreira!' : ev.outcome === 'miss' ? who + ' cobra a falta por cima do gol.' : who + ' ' + this._pick(['cobra a falta direto para o gol!', 'bate a falta com efeito!']);
        } else if (ev.kind === 'head') {
          text = seq + (ev.outcome === 'block' ? 'cabeceia e a zaga afasta!' : ev.outcome === 'miss' ? 'cabeceia para fora!' : this._pick(['sobe e cabeceia!', 'testa firme!']));
          sh = who + (ev.outcome === 'block' ? ' cabeceia e a zaga afasta!' : ev.outcome === 'miss' ? ' cabeceia para fora!' : ' cabeceia!');
        } else {
          if (ev.outcome === 'block') text = seq + 'finaliza e a zaga bloqueia!';
          else if (ev.outcome === 'miss') text = seq + 'chuta, mas a bola passa longe do gol.';
          else text = seq + this._pick(['finaliza!', 'chuta forte!', 'arrisca o chute!']);
          sh = ev.outcome === 'block' ? who + ' finaliza e a zaga bloqueia!' : ev.outcome === 'miss' ? who + ' chuta para fora!' : who + ' ' + this._pick(['finaliza!', 'chuta forte!', 'arrisca!']);
        }
        out.push({ min: ev.min, type: 'shot', text: text.charAt(0).toUpperCase() + text.slice(1), vtext: sh, voice: true, big: false, prio: 2 });
        return out;
      }

      // qualquer outro lance encerra a jogada pendente (passes soltos só contam se forem ≥ 2, ou se ficaram velhos)
      if (this.chain.length) this._flush(ev, out, T - this.chainT > STALE ? 1 : 2);

      switch (ev.type) {
        case 'kickoff':
          out.push({ min: ev.min, type: ev.type, text: ev.text + '! ' + this.match.home.name + ' e ' + this.match.away.name + ' em campo.', voice: true, big: true, prio: 3 });
          break;
        case 'goal': {
          const ctx = this.shotCtx && this.shotCtx.shooter === p && T - this.shotCtx.t <= 10 ? this.shotCtx : null;
          const lead = ctx && ctx.lead.length ? this._seq(ctx.lead) + ' e ' : '';
          const assist = ctx && !ctx.lead.length && ctx.assist ? ' Assistência de ' + this.nm(ctx.assist) + '.' : '';
          const who = p ? p.name : this._team(ev.team);
          const head = this._pick(['GOOOOL!', 'É GOL!', 'GOLAÇO!', 'BALANÇOU A REDE!']);
          const how = ctx && ctx.kind ? { pen: ' de pênalti', fk: ' de falta', head: ' de cabeça' }[ctx.kind] || '' : '';
          const body = ev.og ? head + ' Gol contra de ' + who + '!' : head + ' ' + who + ' marca' + how + ' para o ' + this._team(ev.team) + '!';
          out.push({ min: ev.min, type: 'goal', text: (lead ? lead.charAt(0).toUpperCase() + lead.slice(1) : '') + body + assist + ' ' + this._score() + '.', vtext: (lead ? lead.charAt(0).toUpperCase() + lead.slice(1) : '') + body + assist, voice: true, big: true, prio: 3 });
          this.shotCtx = null;
          break;
        }
        case 'save':
          out.push({ min: ev.min, type: 'save', text: this._pick(['Que defesa de ', 'Defesaça de ', 'Salvou! ']) + this.nm(p) + '!', voice: true, big: false, prio: 2 });
          this.shotCtx = null;
          break;
        case 'steal':
          out.push({ min: ev.min, type: 'steal', text: this.nm(p) + this._pick([' desarma ', ' tira a bola de ']) + this.nm(ev.from) + ' e recupera a posse!', voice: true, big: false, prio: 1 });
          break;
        case 'intercept':
          out.push({ min: ev.min, type: 'intercept', text: this.nm(p) + ' corta o passe de ' + this.nm(ev.from) + '!', voice: true, big: false, prio: 1 });
          break;
        case 'sub':
          out.push({ min: ev.min, type: ev.type, text: (ev.injury ? 'Substituição forçada no ' : 'Substituição no ') + this._team(ev.team) + ': sai ' + ev.out.name + (ev.injury ? ', machucado' : '') + ', entra ' + p.name + '.', voice: true, big: false, prio: 2 });
          break;
        case 'injury':
          out.push({ min: ev.min, type: ev.type, text: this._pick(['Ih! ', 'Preocupação: ', 'Lance feio! ']) + this.nm(p) + ' fica no chão sentindo a lesão.', voice: true, big: false, prio: 2 });
          break;
        case 'red':
          out.push({ min: ev.min, type: ev.type, text: (ev.second ? 'Segundo amarelo e cartão vermelho' : 'Cartão vermelho direto') + ' para ' + (p ? p.name : 'o jogador') + '! O ' + this._team(ev.team) + ' fica com um a menos.', voice: true, big: true, prio: 3 });
          break;
        case 'tactic':
          out.push({ min: ev.min, type: ev.type, text: ev.text + '.', voice: true, big: false, prio: 2 });
          break;
        case 'talk': { // palestra do intervalo (v8)
          const eff = ev.effect > 0 ? ' O time volta mais ligado para o segundo tempo.' : ev.effect < 0 ? ' A bronca parece ter deixado o time nervoso.' : '';
          out.push({ min: ev.min, type: ev.type, text: ev.text + '.' + eff, vtext: ev.text, voice: true, big: false, prio: 2 });
          break;
        }
        case 'corner':
          out.push({ min: ev.min, type: ev.type, text: 'Escanteio para o ' + this._team(ev.team) + '.', voice: false, big: false, prio: 0 });
          break;
        case 'foul':
          out.push({ min: ev.min, type: ev.type, text: ev.text + '.', voice: false, big: false, prio: 0 });
          break;
        case 'penalty':
          out.push({ min: ev.min, type: ev.type, text: 'PÊNALTI para o ' + this._team(ev.team) + '! ' + (ev.by ? this.nm(ev.by) + ' derruba ' : 'Falta em ') + this.nm(ev.fouled) + ' dentro da área. ' + this.nm(p) + ' vai para a cobrança.',
            vtext: 'Pênalti para o ' + this._team(ev.team) + '!', voice: true, big: true, prio: 3 });
          break;
        case 'yellow':
          out.push({ min: ev.min, type: ev.type, text: 'Cartão amarelo para ' + (p ? p.name : 'o jogador') + '.', voice: true, big: false, prio: 2 });
          break;
        case 'halftime':
        case 'fulltime':
          out.push({ min: ev.min, type: ev.type, text: ev.text + '. ' + this._score() + '.', voice: true, big: true, prio: 3 });
          break;
        case 'pens':
          out.push({ min: ev.min, type: ev.type, text: 'Vai começar a disputa de pênaltis! Haja coração!', voice: true, big: true, prio: 3 });
          break;
        case 'pen': {
          const s = ev.pens ? ev.pens[0] + ' a ' + ev.pens[1] : '';
          const who = this.nm(p);
          out.push({
            min: ev.min, type: ev.type, voice: true, big: false, prio: 2,
            text: ev.scored ? this._pick([who + ' bate e converte! ', 'Gol! ' + who + ' não perdoa! ']) + s + '.'
              : this._pick(['Defendeu! ', 'Perdeu! ', 'Para fora! ']) + who + ' desperdiça a cobrança. ' + s + '.'
          });
          break;
        }
        default:
          break;
      }
      return out;
    }
  }

  g.Narrator = Narrator;
  if (typeof module !== 'undefined') module.exports = Narrator;
})(typeof window !== 'undefined' ? window : globalThis);
