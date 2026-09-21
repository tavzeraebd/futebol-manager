/* Renderizador do campo (canvas 2D). Só lê o estado de Match; não altera nada. */
(function (g) {
  'use strict';

  const { L, W, GY0, GY1 } = g.FootballEngine.PITCH;
  const PAD = 3; // margem (m) ao redor do campo

  class PitchRenderer {
    constructor(canvas, match, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.match = match;
      this.opts = Object.assign({ showNames: true, showNumbers: true }, opts);
      this.selected = null;
      this.trail = [];
      this.resize();
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.resize()).observe(canvas);
    }

    setMatch(m) { this.match = m; this.trail = []; this.selected = null; }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.cw = Math.max(1, r.width);
      this.ch = Math.max(1, r.height);
      this.canvas.width = Math.round(this.cw * dpr);
      this.canvas.height = Math.round(this.ch * dpr);
      this.dpr = dpr;
      this.s = Math.min(this.cw / (L + PAD * 2), this.ch / (W + PAD * 2));
      this.ox = (this.cw - L * this.s) / 2;
      this.oy = (this.ch - W * this.s) / 2;
    }

    X(x) { return this.ox + x * this.s; }
    Y(y) { return this.oy + y * this.s; }

    /** Converte coordenadas de tela (CSS px relativos ao canvas) para metros. */
    toWorld(px, py) { return { x: (px - this.ox) / this.s, y: (py - this.oy) / this.s }; }

    pickPlayer(px, py) {
      const w = this.toWorld(px, py);
      let best = null, bd = 3;
      for (const p of this.match.players) {
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    draw() {
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawPitch(c);
      this.drawPlayers(c);
      this.drawBall(c);
    }

    drawPitch(c) {
      const s = this.s;
      c.fillStyle = '#2c7a39';
      c.fillRect(0, 0, this.cw, this.ch);
      const n = 14, sw = L / n;
      for (let i = 0; i < n; i++) {
        c.fillStyle = i % 2 ? '#3a9147' : '#3f9a4c';
        c.fillRect(this.X(i * sw), this.Y(0), sw * s + 0.5, W * s);
      }

      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = Math.max(1.5, s * 0.18);
      c.lineJoin = 'round';
      const line = (x1, y1, x2, y2) => { c.beginPath(); c.moveTo(this.X(x1), this.Y(y1)); c.lineTo(this.X(x2), this.Y(y2)); c.stroke(); };
      const rect = (x, y, w, h) => c.strokeRect(this.X(x), this.Y(y), w * s, h * s);
      const arc = (x, y, r, a0, a1) => { c.beginPath(); c.arc(this.X(x), this.Y(y), r * s, a0, a1); c.stroke(); };
      const dot = (x, y) => { c.fillStyle = 'rgba(255,255,255,0.85)'; c.beginPath(); c.arc(this.X(x), this.Y(y), Math.max(2, s * 0.25), 0, 7); c.fill(); };

      rect(0, 0, L, W);
      line(L / 2, 0, L / 2, W);
      arc(L / 2, W / 2, 9.15, 0, Math.PI * 2);
      dot(L / 2, W / 2);

      for (const side of [0, 1]) {
        const sx = side ? L : 0, d = side ? -1 : 1;
        rect(side ? L - 16.5 : 0, W / 2 - 20.16, 16.5, 40.32);
        rect(side ? L - 5.5 : 0, W / 2 - 9.16, 5.5, 18.32);
        dot(sx + d * 11, W / 2);
        const a = Math.acos(5.5 / 9.15);
        if (side) arc(L - 11, W / 2, 9.15, Math.PI - a, Math.PI + a);
        else arc(11, W / 2, 9.15, -a, a);
        // corners
        const cy = [0, W];
        for (const y of cy) {
          const a0 = side ? (y ? Math.PI : Math.PI) : 0;
          c.beginPath();
          const cx = this.X(sx), cyy = this.Y(y);
          const start = side ? (y ? Math.PI : Math.PI / 2) : (y ? 1.5 * Math.PI : 0);
          c.arc(cx, cyy, s * 1, start, start + Math.PI / 2);
          c.stroke();
        }
        // gol
        c.save();
        c.strokeStyle = 'rgba(255,255,255,0.95)';
        c.fillStyle = 'rgba(255,255,255,0.12)';
        const gx = side ? L : -2, gw = 2;
        c.fillRect(this.X(gx), this.Y(GY0), gw * s, (GY1 - GY0) * s);
        c.strokeRect(this.X(gx), this.Y(GY0), gw * s, (GY1 - GY0) * s);
        c.restore();
      }
    }

    drawPlayers(c) {
      const m = this.match, s = this.s;
      const compact = this.cw < 560; // celular em pé: campo pequeno, então jogadores menores e só alguns nomes
      const r = Math.max(compact ? 6.5 : 8, s * 1.05);
      const owner = m.ball.owner;
      const list = m.players.slice().sort((a, b) => a.y - b.y);

      for (const p of list) {
        const x = this.X(p.x), y = this.Y(p.y);
        const col = p.team.colors;
        const gk = p.role === 'GK';

        c.fillStyle = 'rgba(0,0,0,0.25)';
        c.beginPath(); c.ellipse(x + 1.5, y + r * 0.85, r * 0.95, r * 0.4, 0, 0, 7); c.fill();

        if (p === owner) {
          const pulse = 1 + 0.12 * Math.sin(m.time * 8);
          c.strokeStyle = 'rgba(255,235,59,0.95)';
          c.lineWidth = 2.5;
          c.beginPath(); c.arc(x, y, r * 1.35 * pulse, 0, 7); c.stroke();
        }
        if (m.home.ctrl === p || m.away.ctrl === p) {
          const tag = m.home.human && m.away.human ? (p.team === m.home ? 'P1' : 'P2') : 'VOCÊ';
          c.fillStyle = '#00e5ff';
          c.beginPath(); c.moveTo(x, y - r * 1.5); c.lineTo(x - r * 0.6, y - r * 2.2); c.lineTo(x + r * 0.6, y - r * 2.2); c.closePath(); c.fill();
          c.font = '800 ' + Math.max(10, Math.round(r * 0.9)) + 'px system-ui, sans-serif';
          c.textAlign = 'center'; c.textBaseline = 'bottom';
          c.strokeStyle = 'rgba(0,0,0,0.7)'; c.lineWidth = 3; c.strokeText(tag, x, y - r * 2.25); c.fillText(tag, x, y - r * 2.25);
        }
        if (p === this.selected) {
          c.strokeStyle = '#fff';
          c.setLineDash([4, 3]);
          c.lineWidth = 2;
          c.beginPath(); c.arc(x, y, r * 1.6, 0, 7); c.stroke();
          c.setLineDash([]);
        }

        c.fillStyle = gk ? col.gk : col.shirt;
        c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
        c.strokeStyle = col.trim;
        c.lineWidth = 2;
        c.stroke();

        if (this.opts.showNumbers) {
          c.fillStyle = gk ? col.gkNumber : col.number;
          c.font = '700 ' + Math.max(8, Math.round(r * 1.05)) + 'px system-ui, sans-serif';
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(p.num, x, y + 0.5);
        }
      }

      if (this.opts.showNames) {
        c.font = '600 ' + Math.max(compact ? 9 : 10, Math.round(s * 1.1)) + 'px system-ui, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'top';
        c.lineJoin = 'round';
        for (const p of list) {
          if (compact && p !== owner && p !== this.selected && m.home.ctrl !== p && m.away.ctrl !== p) continue; // campo apertado: nome só de quem importa
          const x = this.X(p.x), y = this.Y(p.y) + r + 2;
          c.strokeStyle = 'rgba(0,0,0,0.65)';
          c.lineWidth = 3;
          c.strokeText(p.short, x, y);
          c.fillStyle = '#fff';
          c.fillText(p.short, x, y);
        }
      }
    }

    drawBall(c) {
      const b = this.match.ball, s = this.s;
      const speed = Math.hypot(b.vx, b.vy);
      this.trail.push({ x: b.x, y: b.y });
      if (this.trail.length > 12) this.trail.shift();
      if (!b.owner && speed > 10 && this.trail.length > 1) {
        for (let i = 1; i < this.trail.length; i++) {
          c.strokeStyle = 'rgba(255,255,255,' + (i / this.trail.length * 0.45) + ')';
          c.lineWidth = Math.max(2, s * 0.3) * (i / this.trail.length);
          c.beginPath();
          c.moveTo(this.X(this.trail[i - 1].x), this.Y(this.trail[i - 1].y));
          c.lineTo(this.X(this.trail[i].x), this.Y(this.trail[i].y));
          c.stroke();
        }
      }
      const r = Math.max(4.5, s * 0.42);
      const x = this.X(b.x), y = this.Y(b.y);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.beginPath(); c.ellipse(x + 1.5, y + r * 0.9, r, r * 0.45, 0, 0, 7); c.fill();
      c.fillStyle = '#fff';
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
      c.strokeStyle = '#111';
      c.lineWidth = 1.2;
      c.stroke();
      c.fillStyle = '#111';
      c.beginPath(); c.arc(x, y, r * 0.38, 0, 7); c.fill();
    }
  }

  g.PitchRenderer = PitchRenderer;
})(window);
