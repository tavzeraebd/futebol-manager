/*
 * Efeitos sonoros sintetizados com Web Audio (sem arquivos): torcida, gol e apito.
 * O navegador só libera áudio depois de um clique do usuário; antes disso tudo fica mudo sem erro.
 */
(function (g) {
  'use strict';

  class Sfx {
    constructor() {
      this.enabled = true;
      this.paused = false;
      this.ctx = null;
      this.crowd = null;
      this._timer = null;
    }

    ensure() {
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return false;
      try {
        if (!this.ctx) this.ctx = new AC();
        // "suspended" (antes do 1º toque) ou "interrupted" (iOS, depois de ligação ou de outro app): só volta a tocar com resume()
        if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') { const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {}); }
        return this.ctx.state !== 'closed';
      } catch (_) { return false; }
    }

    /** Chamado dentro de um toque/clique: no iOS e no Android o áudio só destrava assim (toca 1 amostra muda). */
    unlock() {
      if (!this.ensure()) return;
      if (this._unlocked && this.ctx.state === 'running') return;
      try {
        const c = this.ctx, src = c.createBufferSource();
        src.buffer = c.createBuffer(1, 1, 22050);
        src.connect(c.destination);
        src.start(0);
        this._unlocked = true;
      } catch (_) { /* ok */ }
    }

    _noise() {
      if (this._buf) return this._buf;
      const c = this.ctx, len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; } // ruído "marrom": som de multidão
      return (this._buf = buf);
    }

    /** Torcida de fundo, contínua e baixa. */
    startCrowd() {
      if (!this.enabled || !this.ensure() || this.crowd) return; // ensure() antes: reativa um contexto que nasceu suspenso
      const c = this.ctx, src = c.createBufferSource(), filter = c.createBiquadFilter(), gain = c.createGain();
      src.buffer = this._noise(); src.loop = true;
      filter.type = 'bandpass'; filter.frequency.value = 600; filter.Q.value = 0.5;
      gain.gain.value = 0;
      src.connect(filter); filter.connect(gain); gain.connect(c.destination);
      src.start();
      this.crowd = { src, gain };
      this._level(0.05);
    }

    _level(v, tc = 0.3) {
      if (this.crowd) this.crowd.gain.gain.setTargetAtTime(this.paused || !this.enabled ? 0 : v, this.ctx.currentTime, tc);
    }

    /** Torcida "levanta" por um instante (chute, defesa, gol). */
    swell(amount, ms = 1300) {
      if (!this.enabled) return;
      this.startCrowd();
      if (!this.crowd) return;
      this._level(0.05 + amount, 0.08);
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._level(0.05, 0.7), ms);
    }

    goal() { this.swell(0.28, 3200); }

    /** Apito (curto ou longo). */
    whistle(long) {
      if (!this.enabled || !this.ensure()) return;
      const c = this.ctx, t = c.currentTime, dur = long ? 1.0 : 0.4;
      const osc = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), gain = c.createGain();
      osc.type = 'sine'; osc.frequency.value = 2900;
      lfo.frequency.value = 32; lg.gain.value = 180;
      lfo.connect(lg); lg.connect(osc.frequency);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.03);
      gain.gain.setValueAtTime(0.09, t + dur - 0.05);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(gain); gain.connect(c.destination);
      osc.start(t); lfo.start(t); osc.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    }

    setPaused(p) { this.paused = p; this._level(0.05, 0.2); }
    setEnabled(on) { this.enabled = on; if (on) this.startCrowd(); else this._level(0, 0.1); }

    stop() {
      clearTimeout(this._timer);
      if (!this.crowd) return;
      const { src, gain } = this.crowd;
      this.crowd = null;
      try { gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); setTimeout(() => { try { src.stop(); } catch (_) { /* ok */ } }, 500); } catch (_) { /* ok */ }
    }
  }

  g.Sfx = Sfx;
})(typeof window !== 'undefined' ? window : globalThis);
