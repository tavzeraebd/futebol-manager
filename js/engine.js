/*
 * Motor da partida (sem DOM). Unidades em metros e segundos; campo 105 x 68.
 * Uso:
 *   const match = new FootballEngine.Match(TEAM_DATA.home, TEAM_DATA.away);
 *   match.on(ev => ...);            // gols, cartões, escanteios...
 *   match.update(1 / 60);           // passo fixo
 * Para o futuro jogo: cada Player tem x, y, vx, vy, face; a bola é match.ball.
 * O ponto de entrada para controle humano é Match._target(player) (ver "human").
 */
(function (g) {
  'use strict';

  const L = 105, W = 68;
  const GOAL_W = 7.32, GY0 = (W - GOAL_W) / 2, GY1 = GY0 + GOAL_W;
  const BALL_FRIC = 3.0;

  /*
   * Matemática determinística: só usa + - * / e sqrt (exatos em qualquer navegador).
   * Math.sin/cos/exp/atan2/hypot mudam no último bit entre navegadores, e a simulação é caótica:
   * um bit de diferença já faz dois jogadores verem placares diferentes.
   */
  const DM = (() => {
    const PI = 3.141592653589793, TWO_PI = 6.283185307179586, HALF_PI = 1.5707963267948966, LN2 = 0.6931471805599453;
    const sin = x => {
      x -= TWO_PI * Math.round(x / TWO_PI);
      if (x > HALF_PI) x = PI - x; else if (x < -HALF_PI) x = -PI - x;
      const x2 = x * x;
      return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))));
    };
    const atanPos = z => { // z >= 0
      let k = 1;
      if (z > 1) { z = 1 / z; k = -1; }
      z = z / (1 + Math.sqrt(1 + z * z));
      z = z / (1 + Math.sqrt(1 + z * z));
      const z2 = z * z;
      const a = 4 * z * (1 + z2 * (-1 / 3 + z2 * (1 / 5 + z2 * (-1 / 7 + z2 * (1 / 9 + z2 * (-1 / 11))))));
      return k > 0 ? a : HALF_PI - a;
    };
    const atan2 = (y, x) => {
      if (x === 0 && y === 0) return 0;
      const a = atanPos(Math.abs(y) / Math.abs(x === 0 ? 1e-300 : x));
      const r = x === 0 ? HALF_PI : a;
      if (x >= 0) return y < 0 ? -r : r;
      return y < 0 ? -(PI - r) : PI - r;
    };
    const exp = x => {
      const k = Math.round(x / LN2), r = x - k * LN2;
      let e = 1 + r * (1 + r * (1 / 2 + r * (1 / 6 + r * (1 / 24 + r * (1 / 120 + r * (1 / 720 + r * (1 / 5040 + r * (1 / 40320 + r * (1 / 362880)))))))));
      for (let i = 0; i < k; i++) e *= 2;
      for (let i = 0; i > k; i--) e /= 2;
      return e;
    };
    return { sin, cos: x => sin(x + HALF_PI), atan2, exp, hypot: (x, y) => Math.sqrt(x * x + y * y) };
  })();

  let rng = Math.random;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = (a, b) => a + rng() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => DM.hypot(a.x - b.x, a.y - b.y);
  const segDist = (p, a, b) => {
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    const t = l2 ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1) : 0;
    return DM.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
  };

  const ROLE = {
    GK:  { speed: 5.4, accel: 8 },
    DEF: { speed: 7.2, accel: 9 },
    MID: { speed: 7.6, accel: 10 },
    FWD: { speed: 8.0, accel: 10.5 }
  };

  /* Táticas: line = quanto a linha do time avança (+) ou recua (-); shot/fwd = vontade de finalizar e de jogar para frente;
     chase = distância para o 2º jogador ajudar a pressionar; fwdAtt = atacantes a mais na frente quando o time tem a bola. */
  const TACTICS = {
    balanced: { line: 0, shot: 1, fwd: 1, chase: 11, fwdAtt: 0 },
    attack:   { line: 6, shot: 1.15, fwd: 1.2, chase: 11, fwdAtt: 0 },
    defend:   { line: -8, shot: 0.8, fwd: 0.8, chase: 9, fwdAtt: 0 },
    counter:  { line: -4, shot: 1.15, fwd: 1.5, chase: 9, fwdAtt: 8 },
    press:    { line: 4, shot: 1, fwd: 1, chase: 17, fwdAtt: 0 }
  };
  const TACTIC_NAMES = { balanced: 'equilibrado', attack: 'ofensivo', defend: 'retranca', counter: 'contra-ataque', press: 'pressão alta' };

  /*
   * Cansaço (só quando a definição do time traz a condição física "fit" dos jogadores; partidas antigas continuam iguais).
   * A energia começa em fit (0-1) e cai a cada passo: um pouco parado e mais correndo perto da velocidade máxima, no ritmo
   * "sta" (resistência: menos = cansa mais devagar). Abaixo de `limit` de energia o jogador fica mais lento e menos preciso
   * (quem começa descansado só sente no fim do jogo; quem começa cansado sente o jogo todo).
   */
  const FATIGUE = { base: 0.0005, run: 0.0017, min: 0.15, halftime: 0.05, limit: 0.8, speedLoss: 0.3, skillLoss: 0.18 };

  /*
   * Regras da versão 6 (só quando as duas definições de time trazem v >= 6; partidas antigas continuam iguais):
   * cartão vermelho (direto ou segundo amarelo: o expulso sai e o time fica com um a menos), lesões em disputas de bola
   * (só em partidas com `injuries` nos dois times; cansado se machuca mais) e troca automática do lesionado pelo melhor
   * reserva da posição (def.bench) na primeira bola parada, dentro do limite de trocas.
   */
  const CARDS = { red: 0.015, yellow: 0.22 };
  const INJURY = { base: 0.004, tired: 2, fouled: 3 };
  const MAX_SUBS = 5;
  const OFF = { x: -40, y: -40 }; // onde fica quem foi expulso (fora do campo e longe de qualquer lance)

  class Player {
    constructor(team, d, idx) {
      this.team = team;
      this.idx = idx;
      this.id = team.key + idx;
      this.num = d.num;
      this.name = d.name;
      this.short = d.short || d.name.split(' ').slice(-1)[0];
      this.role = d.role;
      this.pos = d.pos;
      this.fx = d.fx;
      this.fy = d.fy;
      const R = ROLE[d.role];
      this.accel = R.accel;
      this._setup(d);
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.face = 0;
      this.cooldown = 0;
      this.hold = 0;
      this.nextDecision = 1;
      this.yellow = 0;
      this.phase = rng() * 6.28;
    }

    /** Habilidades, velocidade e energia de quem está em campo (no início ou quando entra numa substituição). */
    _setup(d) {
      this.speed0 = ROLE[this.role].speed * (d.speed || 1);
      this.maxSpeed = this.speed0;
      this.skill0 = Object.assign({ pass: 1, shot: 1, def: 1, dribble: 1 }, d.skill);
      this.skill = Object.assign({}, this.skill0);
      this.energy = this.e0 = d.fit != null ? d.fit : 1;
      this.sta = d.sta || 1;
    }

    /** Aplica a energia atual à velocidade e às habilidades. */
    _tire() {
      const f = this.energy < FATIGUE.limit ? (FATIGUE.limit - this.energy) / FATIGUE.limit : 0;
      const k = 1 - FATIGUE.skillLoss * f, s = this.skill, s0 = this.skill0;
      this.maxSpeed = this.speed0 * (1 - FATIGUE.speedLoss * f);
      s.pass = s0.pass * k; s.shot = s0.shot * k; s.def = s0.def * k; s.dribble = s0.dribble * k;
    }
  }

  class Match {
    constructor(homeDef, awayDef, opts) {
      this.opts = Object.assign({ clockRate: 12 }, opts);
      // seed => partida reproduzível (servidor e clientes veem o mesmo jogo)
      this.rng = this.opts.seed != null ? mulberry32(this.opts.seed >>> 0) : Math.random;
      rng = this.rng;
      this.listeners = [];
      this.teams = [this._makeTeam(homeDef, 'home'), this._makeTeam(awayDef, 'away')];
      this.home = this.teams[0];
      this.away = this.teams[1];
      this.home.opp = this.away;
      this.away.opp = this.home;
      this.home.dir = 1;
      this.away.dir = -1;
      this.players = this.home.players.concat(this.away.players);
      this.fatigue = [homeDef, awayDef].some(d => d.players.some(p => p.fit != null));
      this.rules = Math.min(homeDef.v || 0, awayDef.v || 0);
      this.injuries = this.rules >= 6 && !!homeDef.injuries && !!awayDef.injuries;
      this.used = []; // energia de quem saiu por substituição
      if (this.fatigue) for (const p of this.players) p._tire();

      this.ball = { x: L / 2, y: W / 2, vx: 0, vy: 0, owner: null, lastTeam: null, lastPlayer: null, receiver: null, shot: null };
      this.events = [];
      this.time = 0;
      this.clock = 0;
      this.half = 1;
      this.nextHalf = 2;   // período que começa após o intervalo/pausa
      this.pens = null;    // disputa de pênaltis (só em mata-mata)
      this.stoppage = [Math.floor(rand(1, 4)), Math.floor(rand(1, 5))];
      this.halfLimit = 2700 + this.stoppage[0] * 60;
      this.possTeam = this.home;
      this.restart = null;
      this.lastGoal = null;
      this._placeForKickoff();
      this._setRestart('kickoff', this.home, { x: L / 2, y: W / 2 });
      this._emit({ type: 'kickoff', team: null, text: 'Início da partida' });
    }

    /* ---------- API pública ---------- */
    on(fn) { this.listeners.push(fn); }

    /* Modo jogável: um humano controla, em cada time, o jogador mais próximo da bola (ou quem está com ela). */
    setHuman(teamKey, on) { const t = teamKey === 'home' ? this.home : this.away; t.human = !!on; t.ctrl = null; t.act = null; }
    /** dx, dy em -1..1 (direções da tela: x+ = direita), sprint = correr. */
    setInput(teamKey, dx, dy, sprint) { const t = teamKey === 'home' ? this.home : this.away; t.input = { dx, dy, sprint: !!sprint }; }
    /** 'pass' | 'shoot': vale por 0,3 s de jogo, para o toque não se perder entre dois passos da simulação. */
    press(teamKey, action) { const t = teamKey === 'home' ? this.home : this.away; if (t.human) t.act = { type: action, until: this.time + 0.3 }; }
    controlled(teamKey) { const t = teamKey === 'home' ? this.home : this.away; return t.human ? t.ctrl : null; }

    minute() {
      const m = Math.floor(this.clock / 60) + 1;
      if (this.half === 1 && m > 45) return '45+' + (m - 45);
      if (this.half === 2 && m > 90) return '90+' + (m - 90);
      if (this.half === 3 && m > 105) return '105+' + (m - 105);
      if (this.half === 4 && m > 120) return '120+' + (m - 120);
      return String(Math.min(m, 120));
    }

    /** 'home' | 'away' | null (empate; só acontece em jogo que não é mata-mata). */
    get winner() {
      if (this.state !== 'fulltime') return null;
      if (this.home.score !== this.away.score) return this.home.score > this.away.score ? 'home' : 'away';
      if (this.pens) return this.pens.score[0] > this.pens.score[1] ? 'home' : 'away';
      return null;
    }

    get finished() { return this.state === 'fulltime'; }

    /** Energia (0-1) no começo e no fim de cada jogador que atuou, inclusive quem saiu: [{ team, name, start, end }]. */
    energyReport() {
      return this.used.concat(this.players.map(p => ({ team: p.team.key, name: p.name, start: p.e0, end: +p.energy.toFixed(3) })));
    }

    /* ---------- construção ---------- */
    _makeTeam(def, key) {
      const t = {
        key, def, name: def.name, short: def.short, colors: def.colors,
        players: [], dir: 1, opp: null, score: 0, chasers: new Set(),
        human: false, ctrl: null, input: { dx: 0, dy: 0, sprint: false }, act: null,
        tactic: TACTICS[def.tactic] ? def.tactic : 'balanced', plan: (def.plan || []).slice().sort((a, b) => a.min - b.min), planIdx: 0,
        bench: (def.bench || []).slice(), benchUsed: new Set(), subs: 0,
        stats: { shots: 0, onTarget: 0, passes: 0, corners: 0, fouls: 0, yellow: 0, red: 0, poss: 0 }
      };
      t.tac = TACTICS[t.tactic];
      def.players.forEach((d, i) => t.players.push(new Player(t, d, i)));
      return t;
    }

    _homePos(p, kickoff) {
      const fx = kickoff ? p.fx * 0.62 : p.fx;
      return p.team.dir > 0
        ? { x: fx * L, y: p.fy * W }
        : { x: L - fx * L, y: W - p.fy * W };
    }

    _placeForKickoff() {
      for (const p of this.players) {
        if (p.off) continue;
        const h = this._homePos(p, true);
        p.x = h.x; p.y = h.y; p.vx = p.vy = 0;
        p.face = p.team.dir > 0 ? 0 : Math.PI;
        p.cooldown = 0;
      }
    }

    _gk(team) { return team.players[0]; }

    _emit(ev) {
      ev.min = this.minute();
      ev.half = this.half;
      ev.t = Math.round(this.time * 100) / 100;
      this.events.push(ev);
      for (const fn of this.listeners) fn(ev);
    }

    /* ---------- reinícios ---------- */
    _setRestart(type, team, spot) {
      const b = this.ball;
      b.owner = null; b.vx = b.vy = 0; b.shot = null; b.receiver = null;
      b.x = spot.x; b.y = spot.y;
      b.lastTeam = team;
      this.possTeam = team;
      this.state = 'dead';
      this.stateTimer = type === 'kickoff' ? 2.5 : 1.6;
      const taker = this._pickTaker(type, team, spot);
      this.restart = { type, team, spot, taker, wait: 0 };
    }

    _pickTaker(type, team, spot) {
      const out = team.players.filter(p => p.role !== 'GK' && !p.off);
      const nearest = list => list.reduce((a, c) => (dist(c, spot) < dist(a, spot) ? c : a));
      if (type === 'goalkick') return this._gk(team);
      const pick = list => nearest(list.length ? list : out);
      if (type === 'kickoff') return pick(out.filter(p => p.role === 'FWD'));
      if (type === 'corner') return pick(out.filter(p => p.role !== 'DEF'));
      if (type === 'freekick') return pick(out.filter(p => p.role !== 'FWD' || dist(p, spot) < 12));
      return nearest(out);
    }

    _give(p) {
      const b = this.ball;
      b.owner = p; b.receiver = null; b.shot = null;
      b.lastTeam = p.team; b.lastPlayer = p;
      this.possTeam = p.team;
      p.hold = 0;
      p.nextDecision = p.role === 'GK' ? rand(1.4, 2.4) : rand(0.4, 1.1);
    }

    /** Substituições e mudanças de tática combinadas antes do jogo. Só acontecem com a bola parada; não usam números aleatórios. */
    _applyPlans() {
      for (const t of this.teams) {
        if (this.rules >= 6) for (const p of t.players) if (p.injured && !p.off && !p.hurt) this._injurySub(t, p);
        while (t.planIdx < t.plan.length && this.clock / 60 >= t.plan[t.planIdx].min - 1) {
          const e = t.plan[t.planIdx++];
          if (e.type === 'tactic' && TACTICS[e.style]) {
            t.tactic = e.style; t.tac = TACTICS[e.style];
            this._emit({ type: 'tactic', team: t.key, style: e.style, text: t.name + ' muda para ' + TACTIC_NAMES[e.style] });
          } else if (e.type === 'sub' && e.out >= 1 && e.out < t.players.length && e.in) {
            const p = t.players[e.out], outP = { name: p.name, short: p.short };
            if (this.rules >= 6) { // expulso não é substituído; quem já entrou por lesão não entra de novo; no máximo 5 trocas
              if (p.off || t.subs >= MAX_SUBS || t.benchUsed.has(e.in.name)) continue;
              t.subs++; t.benchUsed.add(e.in.name);
            }
            this.used.push({ team: t.key, name: p.name, start: p.e0, end: +p.energy.toFixed(3) });
            p.name = e.in.name; p.short = e.in.short || e.in.name.split(' ').slice(-1)[0]; p.num = e.in.num;
            p._setup(e.in);
            if (this.fatigue) p._tire();
            p.yellow = 0;
            this._emit({ type: 'sub', team: t.key, player: p, out: outP, text: 'Substituição no ' + t.name + ': sai ' + outP.name + ', entra ' + p.name });
          }
        }
      }
    }

    /* ---------- loop principal ---------- */
    update(dt) {
      if (this.state === 'fulltime') return;
      rng = this.rng;
      this.time += dt;

      if (this.state === 'dead' || this.state === 'halftime') this._applyPlans();

      if (this.state === 'halftime') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this._startPeriod(this.nextHalf);
        return;
      }

      if (this.state === 'pens') {
        for (const p of this.players) {
          if (p.off) continue;
          const t = this._target(p);
          this._steer(p, t.x, t.y, dt, t.u || 1);
        }
        this._updatePens(dt);
        return;
      }

      this.clock += dt * this.opts.clockRate;
      if (this.clock >= this.halfLimit && !this.ball.shot && this.state !== 'goal') { this._endHalf(); return; }

      const poss = this.ball.owner ? this.ball.owner.team : this.ball.lastTeam;
      if (poss) poss.stats.poss += dt;

      for (const p of this.players) if (p.cooldown > 0) p.cooldown -= dt;
      if (this.fatigue) this._fatigue(dt);

      this._assignChasers();
      for (const t of this.teams) if (t.human) this._pickCtrl(t);
      for (const p of this.players) {
        if (p.off) continue;
        const t = this._target(p);
        this._steer(p, t.x, t.y, dt, t.u || 1);
      }
      this._separate();
      this._updateBall(dt);

      if (this.state === 'goal') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) this._setRestart('kickoff', this.lastGoal.opp, { x: L / 2, y: W / 2 });
      } else if (this.state === 'dead') {
        this._updateDead(dt);
      } else {
        this._updateLive(dt);
      }
    }

    /** Lesionado sai para o melhor reserva disponível (mesma função em campo, se houver); sem reserva ou sem trocas, joga no sacrifício. */
    _injurySub(t, p) {
      let best = null;
      if (t.subs < MAX_SUBS) {
        for (const b of t.bench) {
          if (t.benchUsed.has(b.name) || (b.role === 'GK') !== (p.role === 'GK')) continue;
          const sc = (b.ovr || 75) * (b.role === p.role ? 1 : 0.85);
          if (!best || sc > best.sc) best = { b, sc };
        }
      }
      if (!best) { p.hurt = true; p.energy = Math.min(p.energy, 0.3); if (this.fatigue) p._tire(); return; }
      const b = best.b, outP = { name: p.name, short: p.short };
      t.subs++; t.benchUsed.add(b.name);
      this.used.push({ team: t.key, name: p.name, start: p.e0, end: +p.energy.toFixed(3) });
      p.name = b.name; p.short = b.short || b.name.split(' ').slice(-1)[0]; p.num = b.num;
      p._setup(b);
      if (b.role !== p.role) for (const k of Object.keys(p.skill0)) p.skill0[k] *= 0.85; // fora de posição
      if (this.fatigue) p._tire(); else Object.assign(p.skill, p.skill0);
      p.yellow = 0; p.injured = false;
      this._emit({ type: 'sub', team: t.key, player: p, out: outP, injury: true, text: 'Substituição por lesão no ' + t.name + ': sai ' + outP.name + ', entra ' + p.name });
    }

    _injure(p) {
      p.injured = true;
      this._emit({ type: 'injury', team: p.team.key, player: p, text: p.name + ' se machuca e pede atendimento' });
    }

    /** Expulsão: o jogador sai de campo e o time fica com um a menos até o fim. */
    _sendOff(p, second) {
      const b = this.ball, t = p.team;
      p.off = true; t.stats.red++;
      p.x = OFF.x; p.y = OFF.y; p.vx = p.vy = 0;
      if (b.receiver === p) b.receiver = null;
      if (t.ctrl === p) t.ctrl = null;
      this._emit({ type: 'red', team: t.key, player: p, second, text: 'Cartão vermelho para ' + p.name + (second ? ' (segundo amarelo)' : '') });
    }

    /** Cansaço: a energia cai com o tempo e mais quando o jogador corre perto do máximo (só + - * /: determinístico). */
    _fatigue(dt) {
      for (const p of this.players) {
        if (p.off) continue;
        const r = (p.vx * p.vx + p.vy * p.vy) / (p.speed0 * p.speed0);
        p.energy = Math.max(FATIGUE.min, p.energy - dt * p.sta * (FATIGUE.base + FATIGUE.run * r));
        p._tire();
      }
    }

    _pickCtrl(t) {
      const b = this.ball;
      if (this.state !== 'live') return;
      if (b.owner && b.owner.team === t && b.owner.role !== 'GK') { t.ctrl = b.owner; return; }
      const bx = b.x + b.vx * 0.2, by = b.y + b.vy * 0.2;
      let best = null, bd = 1e9;
      for (const p of t.players) { if (p.role === 'GK' || p.off) continue; const d = DM.hypot(p.x - bx, p.y - by); if (d < bd) { bd = d; best = p; } }
      if (!t.ctrl || t.ctrl.role === 'GK' || bd < DM.hypot(t.ctrl.x - bx, t.ctrl.y - by) - 2.5) t.ctrl = best;
    }

    /** Ações do humano com a bola: passe (para quem está na direção que ele aponta) e chute. */
    _humanAct(o) {
      const t = o.team, a = t.act;
      if (!a) return false;
      if (this.time > a.until) { t.act = null; return false; }
      t.act = null;
      const dir = t.dir, gx = dir > 0 ? L : 0;
      if (a.type === 'shoot') {
        const dg = DM.hypot(gx - o.x, W / 2 - o.y);
        if ((gx - o.x) * dir > 0 && dg < 42) { this._shoot(o, dg); return true; }
        // longe do gol: chutão para frente
        const q = t.players.filter(x => x !== o && x.role !== 'GK' && (x.x - o.x) * dir > 15).sort((m, n) => dist(o, m) - dist(o, n))[0];
        if (q) { this._kickPass(o, q); return true; }
        return false;
      }
      const inp = t.input;
      let ax = inp.dx, ay = inp.dy;
      if (!ax && !ay) { ax = DM.hypot(o.vx, o.vy) > 0.8 ? o.vx : DM.cos(o.face); ay = DM.hypot(o.vx, o.vy) > 0.8 ? o.vy : DM.sin(o.face); }
      const am = DM.hypot(ax, ay) || 1; ax /= am; ay /= am;
      let best = null, bs = -1e9;
      for (const q of t.players) {
        if (q === o || q.role === 'GK' || q.off) continue;
        const dx = q.x - o.x, dy = q.y - o.y, d = DM.hypot(dx, dy);
        if (d < 4 || d > 48) continue;
        const cos = (dx * ax + dy * ay) / d;
        if (cos < 0.55) continue;
        let open = 10;
        for (const e of t.opp.players) open = Math.min(open, segDist(e, o, q));
        const s = cos * 5 + Math.min(open, 6) * 0.35 - d * 0.02;
        if (s > bs) { bs = s; best = q; }
      }
      if (best) { this._kickPass(o, best); return true; }
      return false;
    }

    _endHalf() {
      const b = this.ball;
      b.owner = null; b.vx = b.vy = 0; b.shot = null;
      const tied = this.home.score === this.away.score;
      const ko = this.opts.knockout;
      const pause = (next, text) => {
        this.state = 'halftime';
        this.nextHalf = next;
        this.stateTimer = 3;
        this._emit({ type: 'halftime', team: null, text });
      };
      if (this.half === 1) pause(2, 'Fim do primeiro tempo');
      else if (this.half === 2 && ko && tied) pause(3, 'Fim do tempo normal: vai haver prorrogação');
      else if (this.half === 3) pause(4, 'Fim do primeiro tempo da prorrogação');
      else if (this.half === 4 && ko && tied) this._startPens();
      else {
        this.state = 'fulltime';
        this._emit({ type: 'fulltime', team: null, text: this.half > 2 ? 'Fim da prorrogação' : 'Fim de jogo' });
      }
    }

    /** Começa o 2º tempo (2) ou a prorrogação (3 e 4). Os times trocam de lado a cada período. */
    _startPeriod(h) {
      this.half = h;
      if (this.fatigue) for (const p of this.players) { p.energy = Math.min(p.e0, p.energy + FATIGUE.halftime); p._tire(); } // fôlego no intervalo
      if (h === 2) { this.clock = 2700; this.halfLimit = 5400 + this.stoppage[1] * 60; }
      else if (h === 3) { this.clock = 5400; this.halfLimit = 6300; }
      else { this.clock = 6300; this.halfLimit = 7200; }
      const homeAttacksRight = h % 2 === 1;
      this.home.dir = homeAttacksRight ? 1 : -1;
      this.away.dir = -this.home.dir;
      if (h === 3) this.et1Kick = rng() < 0.5 ? this.home : this.away;
      const kicker = h === 2 ? this.away : h === 3 ? this.et1Kick : this.et1Kick.opp;
      this._placeForKickoff();
      this._setRestart('kickoff', kicker, { x: L / 2, y: W / 2 });
      this._emit({ type: 'kickoff', team: null, text: h === 2 ? 'Início do segundo tempo' : h === 3 ? 'Início da prorrogação' : 'Início do segundo tempo da prorrogação' });
    }

    /* ---------- pênaltis ---------- */
    _startPens() {
      const spot = { x: L - 11, y: W / 2 };
      const order = t => t.players.filter(p => p.role !== 'GK' && !p.off).sort((a, b) => b.skill.shot - a.skill.shot || a.idx - b.idx);
      this.state = 'pens';
      this.pens = { score: [0, 0], taken: [0, 0], kicks: [], first: rng() < 0.5 ? 0 : 1, order: 0, takers: [order(this.home), order(this.away)],
        phase: 'setup', timer: 3, spot, cur: null, decided: false };
      const b = this.ball;
      b.owner = null; b.receiver = null; b.shot = null; b.vx = b.vy = 0; b.x = spot.x; b.y = spot.y;
      this._emit({ type: 'pens', team: null, text: 'Disputa de pênaltis' });
    }

    _penSetup() {
      const pn = this.pens, teams = [this.home, this.away];
      const ti = (pn.first + pn.order) % 2;
      const team = teams[ti];
      const shooter = pn.takers[ti][pn.taken[ti] % pn.takers[ti].length];
      pn.cur = { ti, team, shooter, keeper: this._gk(team.opp), outcome: null, aimY: W / 2 };
      this.ball.x = pn.spot.x; this.ball.y = pn.spot.y; this.ball.vx = this.ball.vy = 0;
      pn.phase = 'setup'; pn.timer = 2.2;
    }

    _penKick() {
      const pn = this.pens, c = pn.cur;
      const side = rng() < 0.5 ? -1 : 1;
      const pGoal = clamp(0.76 + (c.shooter.skill.shot - 1) * 0.12 - (c.keeper.skill.def - 1) * 0.08, 0.55, 0.9);
      const r = rng();
      if (r < pGoal) { c.outcome = 'goal'; c.aimY = W / 2 + side * rand(2.2, 3.4); c.diveY = W / 2 - side * rand(1.5, 3); }
      else if (r < pGoal + (1 - pGoal) * 0.6) { c.outcome = 'save'; c.aimY = W / 2 + side * rand(1, 3.3); c.diveY = c.aimY; }
      else { c.outcome = 'miss'; c.aimY = W / 2 + side * rand(4.2, 6); c.diveY = W / 2 + side * rand(1, 2.5); }
      const tx = L + 0.6, ang = DM.atan2(c.aimY - pn.spot.y, tx - pn.spot.x), v = 24;
      this.ball.vx = DM.cos(ang) * v; this.ball.vy = DM.sin(ang) * v;
      pn.phase = 'flight'; pn.timer = 1.4;
    }

    _penResolve() {
      const pn = this.pens, c = pn.cur, scored = c.outcome === 'goal';
      if (scored) pn.score[c.ti]++;
      pn.taken[c.ti]++;
      pn.kicks.push({ team: c.team.key, player: c.shooter.name, scored });
      pn.order++;
      this._emit({ type: 'pen', team: c.team.key, player: c.shooter, scored, pens: pn.score.slice(),
        text: (scored ? 'Pênalti convertido: ' : c.outcome === 'save' ? 'Pênalti defendido: ' : 'Pênalti para fora: ') + c.shooter.short + ' (' + pn.score[0] + '-' + pn.score[1] + ')' });
      const [s0, s1] = pn.score, [n0, n1] = pn.taken;
      const left0 = Math.max(0, 5 - n0), left1 = Math.max(0, 5 - n1);
      let done = false;
      if (s0 > s1 + left1 && (n0 < 5 || n1 < 5 || n0 === n1)) done = true;
      else if (s1 > s0 + left0 && (n0 < 5 || n1 < 5 || n0 === n1)) done = true;
      else if (n0 >= 5 && n1 >= 5 && n0 === n1 && s0 !== s1) done = true;
      if (!done && pn.order >= 40) { pn.score[rng() < 0.5 ? 0 : 1]++; done = true; }
      if (done) {
        pn.decided = true; pn.phase = 'end'; pn.timer = 2.5;
      } else { pn.phase = 'pause'; pn.timer = 1.1; }
    }

    _updatePens(dt) {
      const pn = this.pens, b = this.ball;
      pn.timer -= dt;
      if (pn.phase === 'flight') {
        b.x += b.vx * dt; b.y += b.vy * dt;
        const c = pn.cur;
        if (c.outcome === 'save' && b.x >= L - 1.6) { b.vx = b.vy = 0; b.x = L - 1.6; b.y = c.keeper.y; }
        else if (b.x >= L + 2.6) { b.vx = b.vy = 0; }
        if (pn.timer <= 0) this._penResolve();
      } else if (pn.phase === 'setup') {
        if (!pn.cur) this._penSetup();
        if (pn.timer <= 0) this._penKick();
      } else if (pn.phase === 'pause') {
        if (pn.timer <= 0) { pn.cur = null; this._penSetup(); }
      } else if (pn.phase === 'end') {
        if (pn.timer <= 0) {
          this.state = 'fulltime';
          this._emit({ type: 'fulltime', team: null, text: 'Fim de jogo: pênaltis ' + pn.score[0] + '-' + pn.score[1] });
        }
      }
    }

    _updateDead(dt) {
      const r = this.restart, b = this.ball;
      this.stateTimer -= dt;
      if (this.stateTimer > 0) return;
      r.wait += dt;
      if (dist(r.taker, r.spot) < 1.3 || r.wait > 4) {
        if (r.wait > 4) { r.taker.x = r.spot.x; r.taker.y = r.spot.y; }
        for (const o of r.team.opp.players) o.cooldown = Math.max(o.cooldown, 1.0);
        r.taker.cooldown = 0;
        this._give(r.taker);
        r.taker.nextDecision = rand(0.4, 0.9);
        if (r.type === 'corner') r.taker.nextDecision = rand(0.9, 1.4);
        this.restart = null;
        this.state = 'live';
      }
      b.x = r.spot.x; b.y = r.spot.y;
    }

    /* ---------- jogo corrido ---------- */
    _updateLive(dt) {
      const b = this.ball;
      if (b.owner) {
        const o = b.owner;
        o.hold += dt;
        if (this._tackles(o, dt)) return;
        if (o.team.human && o === o.team.ctrl) { if (o.team.act && o.cooldown <= 0 && this._humanAct(o)) return; }
        else if (o.hold >= o.nextDecision) this._decide(o);
      } else {
        this._loose(dt);
      }
      this._checkBounds();
    }

    _tackles(o, dt) {
      if (o.role === 'GK') return false; // ninguém disputa a bola com o goleiro que a segura
      const opp = o.team.opp.players;
      for (const d of opp) {
        if (d.cooldown > 0) continue;
        if (dist(d, o) > 2.0) continue;
        const rate = 3.2 * d.skill.def / o.skill.dribble;
        if (rng() > rate * dt) continue;
        const r = rng();
        const b = this.ball;
        if (r < 0.09) {
          d.team.stats.fouls++;
          if (this.rules >= 6) {
            this._emit({ type: 'foul', team: d.team.key, player: d, text: 'Falta de ' + d.short });
            const c = rng(), gk = d.role === 'GK';
            if (c < CARDS.red && !gk) this._sendOff(d, false);
            else if (c < CARDS.red + CARDS.yellow && !(gk && d.yellow)) {
              d.yellow++; d.team.stats.yellow++;
              this._emit({ type: 'yellow', team: d.team.key, player: d, text: 'Cartão amarelo para ' + d.name });
              if (d.yellow >= 2) this._sendOff(d, true);
            }
          } else {
            const card = d.yellow === 0 && rng() < 0.22;
            this._emit({ type: 'foul', team: d.team.key, player: d, text: 'Falta de ' + d.short });
            if (card) {
              d.yellow++; d.team.stats.yellow++;
              this._emit({ type: 'yellow', team: d.team.key, player: d, text: 'Cartão amarelo para ' + d.name });
            }
          }
          const spot = { x: clamp(o.x, 1, L - 1), y: clamp(o.y, 1, W - 1) };
          this._setRestart('freekick', o.team, spot);
          this._hurt(o, INJURY.fouled);
        } else if (r < 0.62) {
          o.cooldown = 0.7;
          this._emit({ type: 'steal', team: d.team.key, player: d, from: o, text: '' });
          this._give(d);
        } else {
          const ang = DM.atan2(o.y - d.y, o.x - d.x) + rand(-0.8, 0.8);
          b.owner = null; b.receiver = null;
          b.vx = DM.cos(ang) * rand(4, 8); b.vy = DM.sin(ang) * rand(4, 8);
          b.lastTeam = d.team; b.lastPlayer = d; // último toque é de quem desarmou (se a bola entrar, o gol é dele)
          o.cooldown = 0.4; d.cooldown = 0.25;
        }
        if (r >= 0.09) this._hurt(o, 1);
        return true;
      }
      return false;
    }

    /** Chance de lesão de quem sofreu a disputa (maior se sofreu falta e se está cansado). Só sorteia em partidas com lesões. */
    _hurt(p, k) {
      if (!this.injuries || p.role === 'GK' || p.injured || p.hurt) return;
      if (rng() < INJURY.base * k * (1 + INJURY.tired * (1 - p.energy))) this._injure(p);
    }

    _loose(dt) {
      const b = this.ball;
      const sp = DM.hypot(b.vx, b.vy);
      if (b.shot) {
        const s = b.shot;
        if (s.blockAt != null && s.traveled >= s.blockAt) {
          const a = rand(0, Math.PI * 2), v = rand(5, 10);
          b.vx = DM.cos(a) * v; b.vy = DM.sin(a) * v;
          b.lastTeam = s.team.opp; b.shot = null; b.receiver = null;
          return;
        }
        if (s.outcome === 'save' && (s.gx - b.x) * s.dir < 1.5) { this._saveResolve(s); }
        return;
      }
      const cands = [];
      for (const p of this.players) {
        if (p.cooldown > 0) continue;
        const d = dist(p, b);
        if (d < 1.25) cands.push([d, p]);
      }
      cands.sort((a, c) => a[0] - c[0]);
      for (const [, p] of cands) {
        let pr;
        if (p === b.receiver) pr = sp < 15 ? 1 : 0.35;
        else if (p.team === b.lastTeam) pr = sp < 9 ? 0.5 : 0.1;
        else pr = (sp < 12 ? 0.16 : 0.07) * p.skill.def;
        if (rng() < pr * dt * 60) {
          if (b.receiver && p.team !== b.lastTeam && b.lastPlayer) this._emit({ type: 'intercept', team: p.team.key, player: p, from: b.lastPlayer, text: '' });
          this._give(p); return;
        }
      }
    }

    _saveResolve(s) {
      const b = this.ball, gk = this._gk(s.team.opp);
      b.x = gk.x; b.y = gk.y; b.shot = null;
      this._emit({ type: 'save', team: gk.team.key, player: gk, text: 'Defesa de ' + gk.short + ' (chute de ' + s.shooter.short + ')' });
      if (rng() < 0.58) {
        this._give(gk);
      } else {
        const d = -s.dir;
        const toCorner = rng() < 0.35;
        const side = rng() < 0.5 ? -1 : 1;
        b.owner = null; b.receiver = null;
        // espalmada para escanteio: sai pelo lado em que a bola já estava, passando por fora da trave (antes podia entrar no gol)
        const away = gk.y >= W / 2 ? 1 : -1;
        b.vx = toCorner ? -d * 2 : d * rand(5, 10);
        b.vy = toCorner ? (side * 0 + away) * 9 : rand(-6, 6);
        b.lastTeam = gk.team; b.lastPlayer = gk;
        gk.cooldown = 0.6;
      }
    }

    _updateBall(dt) {
      const b = this.ball;
      if (this.state === 'pens') return;
      if (this.state === 'dead' || this.state === 'goal') {
        if (this.state === 'dead') { b.vx = b.vy = 0; }
        return;
      }
      if (b.owner) {
        const o = b.owner;
        b.x = clamp(o.x + DM.cos(o.face) * 0.75, 0.3, L - 0.3); // a bola conduzida nunca passa da linha
        b.y = clamp(o.y + DM.sin(o.face) * 0.75, 0.3, W - 0.3);
        b.vx = o.vx; b.vy = o.vy;
        return;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const sp = DM.hypot(b.vx, b.vy);
      if (b.shot) {
        b.shot.traveled += sp * dt;
      } else if (sp > 0) {
        const ns = Math.max(0, sp - BALL_FRIC * dt);
        b.vx *= ns / sp; b.vy *= ns / sp;
      }
    }

    _checkBounds() {
      const b = this.ball;
      if (b.owner) return;
      if (b.x >= 0 && b.x <= L && b.y >= 0 && b.y <= W) return;

      if (b.x < 0 || b.x > L) {
        const endX = b.x < 0 ? 0 : L;
        const defTeam = this.teams.find(t => (t.dir > 0) === (endX === 0));
        if (b.y > GY0 && b.y < GY1) { this._goal(defTeam.opp); return; }
        if (b.lastTeam === defTeam) {
          defTeam.opp.stats.corners++;
          this._emit({ type: 'corner', team: defTeam.opp.key, text: 'Escanteio para ' + defTeam.opp.short });
          this._setRestart('corner', defTeam.opp, { x: endX === 0 ? 0.6 : L - 0.6, y: b.y < W / 2 ? 0.6 : W - 0.6 });
        } else {
          this._setRestart('goalkick', defTeam, { x: endX === 0 ? 5.5 : L - 5.5, y: W / 2 });
        }
      } else {
        const team = b.lastTeam ? b.lastTeam.opp : this.home;
        this._setRestart('throw', team, { x: clamp(b.x, 1, L - 1), y: b.y < 0 ? 0.6 : W - 0.6 });
      }
    }

    _goal(att) {
      const b = this.ball;
      const scorer = b.lastPlayer;
      const og = scorer && scorer.team !== att;
      att.score++;
      this.lastGoal = att;
      this.state = 'goal';
      this.stateTimer = 4.5;
      b.x = clamp(b.x, -1.5, L + 1.5);
      b.vx = b.vy = 0; b.owner = null; b.shot = null; b.receiver = null;
      this.possTeam = att;
      this._emit({
        type: 'goal', team: att.key, player: scorer, og,
        text: 'GOL! ' + (scorer ? scorer.name : att.name) + (og ? ' (contra)' : '')
      });
    }

    /* ---------- decisões ---------- */
    _decide(p) {
      const t = p.team, dir = t.dir;
      const gx = dir > 0 ? L : 0;
      const dg = DM.hypot(gx - p.x, W / 2 - p.y);
      let pressure = 99;
      for (const o of t.opp.players) pressure = Math.min(pressure, dist(p, o));
      p.hold = 0;
      p.nextDecision = pressure < 3 ? rand(0.25, 0.7) : rand(0.6, 1.7);

      if (p.role === 'GK') { this._pass(p, true); return; }

      if (dg < 34 && (gx - p.x) * dir > 0) {
        // perto do gol o jogador decide mais rápido e tenta finalizar com mais frequência
        if (dg < 26) p.nextDecision = rand(0.35, 0.9);
        let prob = (1 - dg / 34) * 1.3 * p.skill.shot * t.tac.shot;
        if (Math.abs(p.y - W / 2) > 16) prob *= 0.6;
        if (rng() < prob) { this._shoot(p, dg); return; }
      }
      if (pressure > 4.5 && rng() < 0.4) return; // segue conduzindo
      this._pass(p, false);
    }

    _pass(p, force) {
      const t = p.team, dir = t.dir, opp = t.opp.players;
      let best = null, bs = -1e9;
      for (const q of t.players) {
        if (q === p || q.off) continue;
        const d = dist(p, q);
        if (d < 5 || d > (force ? 60 : 42)) continue;
        const fwd = (q.x - p.x) * dir;
        let open = 12, lane = 6;
        for (const o of opp) {
          open = Math.min(open, dist(q, o));
          lane = Math.min(lane, segDist(o, p, q));
        }
        let s = 0.075 * fwd * t.tac.fwd + 0.28 * open + 0.55 * lane - 0.045 * d + rand(0, 1.6);
        if (lane < 1.3) s -= 3;
        if (q.role === 'GK') s -= 4;
        if (dir > 0 ? q.x > 70 : q.x < 35) s += 0.6;
        if (s > bs) { bs = s; best = q; }
      }
      if (!best || (bs < 0 && !force)) return false;
      this._kickPass(p, best);
      return true;
    }

    _kickPass(p, q) {
      const b = this.ball;
      const lead = Math.min(dist(p, q) / 16, 1.2);
      const tx = clamp(q.x + q.vx * lead, 1, L - 1);
      const ty = clamp(q.y + q.vy * lead, 1, W - 1);
      const dd = DM.hypot(tx - p.x, ty - p.y);
      const v = clamp(Math.sqrt(64 + 6 * dd), 11, 27);
      const ang = DM.atan2(ty - p.y, tx - p.x) + (rng() - 0.5) * 0.1 * (1 + dd / 35) / p.skill.pass;
      b.vx = DM.cos(ang) * v; b.vy = DM.sin(ang) * v;
      b.owner = null; b.receiver = q; b.lastTeam = p.team; b.lastPlayer = p;
      p.cooldown = 0.45;
      p.team.stats.passes++;
      const dir = p.team.dir, gx = dir > 0 ? L : 0, fwd = (q.x - p.x) * dir;
      let kind = 'pass';
      if (Math.abs(p.y - W / 2) > 20 && Math.abs(gx - q.x) < 20 && Math.abs(q.y - W / 2) < 15 && fwd > 3) kind = 'cross';
      else if (dd > 30 && (fwd > 10 || p.role === 'GK')) kind = 'long';
      else if (fwd < -8) kind = 'back';
      this._emit({ type: 'pass', team: p.team.key, player: p, to: q, kind, text: '' });
    }

    _shoot(p, dg) {
      const t = p.team, dir = t.dir, b = this.ball;
      const gx = dir > 0 ? L : 0;
      const gks = this._gk(t.opp).skill.def;
      const xg = clamp(0.19 * DM.exp(-(dg - 6) / 8), 0.015, 0.3) * p.skill.shot / gks;
      const sv = 0.27 * Math.min(1.3, gks);
      const r = rng();
      let outcome, aimY;
      if (r < xg) { outcome = 'goal'; aimY = W / 2 + (rng() < 0.5 ? -1 : 1) * rand(1.5, 3.4); }
      else if (r < xg + sv) { outcome = 'save'; aimY = W / 2 + rand(-3.4, 3.4); }
      else if (r < xg + sv + 0.22) { outcome = 'block'; aimY = W / 2 + rand(-3.4, 3.4); }
      else { outcome = 'miss'; aimY = W / 2 + (rng() < 0.5 ? -1 : 1) * rand(4.5, 8); }

      const ang = DM.atan2(aimY - p.y, gx - p.x);
      const v = rand(22, 30);
      b.vx = DM.cos(ang) * v; b.vy = DM.sin(ang) * v;
      b.owner = null; b.receiver = null; b.lastTeam = t; b.lastPlayer = p;
      p.cooldown = 0.6;
      b.shot = { team: t, shooter: p, outcome, aimY, gx, dir, traveled: 0, blockAt: outcome === 'block' ? dg * rand(0.25, 0.6) : null };
      t.stats.shots++;
      if (outcome === 'goal' || outcome === 'save') t.stats.onTarget++;
      this._emit({ type: 'shot', team: t.key, player: p, text: 'Chute de ' + p.short, outcome });
    }

    /* ---------- movimento ---------- */
    _assignChasers() {
      const b = this.ball;
      for (const t of this.teams) {
        t.chasers = new Set();
        if (this.state !== 'live') continue;
        if (b.owner && b.owner.team === t) continue;
        if (b.shot) continue;
        const gk = this._gk(t);
        const gkBox = (t.dir > 0 ? b.x < 16.5 : b.x > L - 16.5) && Math.abs(b.y - W / 2) < 20;
        const bx = b.x + b.vx * 0.25, by = b.y + b.vy * 0.25;
        const list = t.players
          .filter(p => !p.off && (p.role !== 'GK' || (gkBox && !b.owner)))
          .sort((a, c) => DM.hypot(a.x - bx, a.y - by) - DM.hypot(c.x - bx, c.y - by));
        t.chasers.add(list[0]);
        if (b.owner && list[1] && dist(list[1], b.owner) < t.tac.chase) t.chasers.add(list[1]);
      }
    }

    _target(p) {
      const b = this.ball, live = this.state === 'live';
      if (this.state === 'pens') {
        const pn = this.pens;
        if (!pn.cur) this._penSetup();
        const c = pn.cur;
        if (p === c.shooter) return { x: pn.spot.x - 1.6, y: pn.spot.y, u: 1 };
        if (p === c.keeper) return pn.phase === 'flight' ? { x: L - 1.2, y: c.diveY, u: 1.9 } : { x: L - 1.2, y: W / 2, u: 1 };
        const i = p.team.players.indexOf(p) + (p.team.key === 'home' ? 0 : 11);
        const a = i / 22 * Math.PI * 2;
        return { x: L / 2 + DM.cos(a) * 7, y: W / 2 + DM.sin(a) * 7, u: 0.8 };
      }
      if (live && p.team.human && p === p.team.ctrl) {
        const i = p.team.input;
        if (i.dx || i.dy) { const m = DM.hypot(i.dx, i.dy); return { x: p.x + i.dx / m * 9, y: p.y + i.dy / m * 9, u: i.sprint ? 1.18 : 0.92 }; }
        return { x: p.x, y: p.y, u: 0 };
      }
      if (live && p === b.owner) {
        if (p.role === 'GK') { // goleiro com a bola fica na área esperando a saída de bola (antes recuava para dentro do próprio gol)
          const ownX = p.team.dir > 0 ? 0 : L;
          return { x: ownX + p.team.dir * 5, y: clamp(p.y, W / 2 - 8, W / 2 + 8), u: 0.6 };
        }
        return this._dribbleTarget(p);
      }
      if (this.state === 'dead' && this.restart && p === this.restart.taker) {
        return { x: this.restart.spot.x, y: this.restart.spot.y, u: 1.2 };
      }
      if (live && !b.owner && !b.shot && p === b.receiver) return this._intercept(p);
      if (p.role === 'GK') return this._gkTarget(p);
      if (this.state === 'dead' && this.restart) {
        const sp = this._setPieceTarget(p, this.restart);
        if (sp) return sp;
      }
      if (live && p.team.chasers.has(p)) {
        const o = b.owner;
        return o ? { x: o.x + o.vx * 0.25, y: o.y + o.vy * 0.25, u: 1 } : this._intercept(p);
      }
      return this._formationTarget(p);
    }

    _dribbleTarget(p) {
      const dir = p.team.dir;
      let vx = dir, vy = (W / 2 - p.y) / W * 0.9;
      for (const o of p.team.opp.players) {
        const dx = p.x - o.x, dy = p.y - o.y, d = DM.hypot(dx, dy);
        if (d < 6 && d > 0.01) { const w = (6 - d) / 6 * 2.2; vx += dx / d * w; vy += dy / d * w; }
      }
      if (p.y < 5) vy += 1;
      if (p.y > W - 5) vy -= 1;
      const m = DM.hypot(vx, vy) || 1;
      return { x: p.x + vx / m * 10, y: p.y + vy / m * 10, u: 1 };
    }

    _intercept(p) {
      const b = this.ball;
      const sp = DM.hypot(b.vx, b.vy);
      if (sp < 0.3) return { x: b.x, y: b.y, u: 1.1 };
      const ux = b.vx / sp, uy = b.vy / sp;
      const tStop = sp / BALL_FRIC;
      let px = b.x, py = b.y;
      for (let tt = 0.1; tt <= Math.min(tStop, 3); tt += 0.1) {
        const s = sp * tt - 0.5 * BALL_FRIC * tt * tt;
        px = b.x + ux * s; py = b.y + uy * s;
        if (DM.hypot(px - p.x, py - p.y) <= p.maxSpeed * tt + 0.6) break;
      }
      return { x: clamp(px, 0.5, L - 0.5), y: clamp(py, 0.5, W - 0.5), u: 1.1 };
    }

    _gkTarget(p) {
      const t = p.team, b = this.ball, dir = t.dir;
      const ownX = dir > 0 ? 0 : L;
      const s = b.shot;
      if (s && s.team !== t) {
        let sy;
        if (s.outcome === 'save') sy = s.aimY;
        else if (s.outcome === 'goal') sy = W / 2 + (s.aimY - W / 2) * 0.4;
        else if (s.outcome === 'miss') sy = clamp(s.aimY, GY0, GY1);
        else sy = W / 2 + (s.aimY - W / 2) * 0.5;
        return { x: ownX + dir * 1.5, y: sy, u: 1.7 };
      }
      if (this.state === 'dead' && this.restart && p === this.restart.taker) return { x: this.restart.spot.x, y: this.restart.spot.y, u: 1 };
      const adv = Math.abs(b.x - ownX) * 0.05;
      return { x: ownX + dir * (3 + adv), y: clamp(W / 2 + (b.y - W / 2) * 0.2, W / 2 - 5, W / 2 + 5), u: 0.9 };
    }

    _setPieceTarget(p, r) {
      const t = p.team, n = p.idx;
      if (r.type === 'kickoff') { const h = this._homePos(p, true); return { x: h.x, y: h.y, u: 1.4 }; }
      if (r.type === 'corner') {
        if (t === r.team) {
          const central = p.fy > 0.3 && p.fy < 0.7;
          if (p.role === 'FWD' || (central && p.role !== 'GK')) {
            const gx = t.dir > 0 ? L : 0;
            return { x: gx - t.dir * (6 + (n % 3) * 3), y: W / 2 + ((n % 5) - 2) * 4, u: 1 };
          }
        } else {
          const ownX = t.dir > 0 ? 0 : L;
          return { x: ownX + t.dir * (4 + (n % 4) * 2.5), y: W / 2 + ((n % 5) - 2) * 3.6, u: 1 };
        }
      }
      return null;
    }

    _formationTarget(p) {
      const t = p.team, dir = t.dir, b = this.ball;
      const base = this._homePos(p, false);
      const att = this.possTeam === t;
      const rf = { DEF: 0.55, MID: 1, FWD: 1.25 }[p.role];
      let x = base.x + (b.x - L / 2) * 0.34 + dir * (att ? 6 : -4) * rf;
      if (att && p.role === 'FWD') x += dir * (5 + t.tac.fwdAtt);
      if (p.role !== 'GK') x += dir * t.tac.line * { DEF: 0.8, MID: 1, FWD: 0.6 }[p.role];
      let y = base.y + (b.y - W / 2) * 0.26;
      if (att && p.role !== 'DEF') y += (base.y - W / 2) * 0.25;
      const w = this.time * 0.35 + p.phase;
      x += DM.sin(w) * 2.2;
      y += DM.cos(w * 1.3) * 2.2;
      if (p.role === 'DEF') x = dir > 0 ? Math.min(x, 75) : Math.max(x, 30);
      return { x: clamp(x, 2, L - 2), y: clamp(y, 2, W - 2), u: 0.85 };
    }

    _steer(p, tx, ty, dt, urgency) {
      const dx = tx - p.x, dy = ty - p.y, d = DM.hypot(dx, dy);
      let sp = Math.min(p.maxSpeed * urgency, d * 1.8);
      if (p === this.ball.owner) sp *= 0.86;
      const dvx = d > 0.01 ? dx / d * sp : 0, dvy = d > 0.01 ? dy / d * sp : 0;
      let ax = dvx - p.vx, ay = dvy - p.vy;
      const am = DM.hypot(ax, ay), maxA = p.accel * dt;
      if (am > maxA) { ax *= maxA / am; ay *= maxA / am; }
      p.vx += ax; p.vy += ay;
      p.x = clamp(p.x + p.vx * dt, 0.5, L - 0.5);
      p.y = clamp(p.y + p.vy * dt, 0.5, W - 0.5);
      if (DM.hypot(p.vx, p.vy) > 0.8) p.face = DM.atan2(p.vy, p.vx);
    }

    _separate() {
      const ps = this.players;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const a = ps[i], c = ps[j];
          const dx = c.x - a.x, dy = c.y - a.y, d = DM.hypot(dx, dy);
          if (d < 1.6 && d > 0.001) {
            const push = (1.6 - d) * 0.25;
            a.x -= dx / d * push; a.y -= dy / d * push;
            c.x += dx / d * push; c.y += dy / d * push;
          }
        }
      }
    }
  }

  g.FootballEngine = { VERSION: 6, TACTICS: TACTIC_NAMES, Match, Player, PITCH: { L, W, GOAL_W, GY0, GY1 } };
  if (typeof module !== 'undefined') module.exports = g.FootballEngine;
})(typeof window !== 'undefined' ? window : globalThis);
