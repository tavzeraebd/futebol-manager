/* Catálogo: exemplo local + cache do Sofascore + jogadores importados por busca (guardados no Supabase). */
const fs = require('fs');
const path = require('path');
const seed = require('./seed');
const F = require('./form');

const CACHE = path.join(__dirname, '..', 'data', 'catalog.sofascore.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Nota e valor efetivos = base (ovr0/value0, nunca mudam) + forma acumulada (delta em pontos de nota).
 * O motor e a loja leem ovr/value; a tela mostra a forma em p.form.
 */
function applyForm(p, delta) {
  if (p.ovr0 == null) { p.ovr0 = p.ovr; p.value0 = p.value; }
  p.form = +delta.toFixed(2);
  p.ovr = +clamp(p.ovr0 + delta, 40, 99).toFixed(1);
  p.value = Math.max(1e5, Math.round(p.value0 * F.valueFactor(delta) / 1e5) * 1e5);
}

/** `imported`: jogadores já importados (vêm do banco); `persist(p)`: grava um jogador importado; `form`: Map id -> forma. */
function load({ imported = [], persist = () => {}, keep = new Set(), form = new Map() } = {}) {
  let players = seed.players.slice(), coaches = seed.coaches, source = 'seed';
  const c = readJson(CACHE, null);
  if (c && c.players && c.players.length >= 22) {
    players = c.players;
    coaches = c.coaches && c.coaches.length ? c.coaches : seed.coaches;
    source = 'sofascore';
  }
  const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const baseByName = new Map(players.map(p => [norm(p.name), p])); // catálogo base tem prioridade sobre o mesmo jogador vindo do Wikidata
  const dup = p => p.source === 'wikidata' && !keep.has(p.id) && baseByName.get(norm(p.name));
  const cat = {
    source, players, coaches, imported, form,
    playerById: new Map(), coachById: new Map(coaches.map(x => [x.id, x])),
    item(id) { return this.playerById.get(id) || this.coachById.get(id) || null; },
    /** Soma pontos de forma a um jogador/técnico (respeitando o teto). Devolve a forma nova ou null se o item não existe. */
    bump(id, points) {
      const it = this.item(id);
      if (!it) return null;
      const d = clamp((this.form.get(id) || 0) + points, -F.MAX_FORM, F.MAX_FORM);
      this.form.set(id, d);
      applyForm(it, d);
      return d;
    },
    /** Junta jogadores vindos do banco (sem gravar de novo). Devolve quantos eram novos. */
    merge(list) {
      let n = 0;
      for (const p of list) {
        if (dup(p)) continue;
        const old = this.playerById.get(p.id);
        if (old) { Object.assign(old, p, { ovr0: p.ovr, value0: p.value }); applyForm(old, this.form.get(p.id) || 0); }
        else { this.players.push(p); this.playerById.set(p.id, p); applyForm(p, this.form.get(p.id) || 0); n++; }
      }
      return n;
    },
    add(p) {
      const base = dup(p);
      if (base) return base; // já existe no catálogo base: usa o original
      persist(Object.assign({}, p)); // grava a versão base, sem a forma
      const old = this.playerById.get(p.id);
      if (old) { Object.assign(old, p, { ovr0: p.ovr, value0: p.value }); applyForm(old, this.form.get(p.id) || 0); }
      else { this.players.push(p); this.playerById.set(p.id, p); applyForm(p, this.form.get(p.id) || 0); }
      return this.playerById.get(p.id);
    }
  };
  for (const p of players) cat.playerById.set(p.id, p);
  for (const p of imported) { if (dup(p)) continue; if (!cat.playerById.has(p.id)) players.push(p); cat.playerById.set(p.id, p); }
  for (const p of players) applyForm(p, form.get(p.id) || 0);
  for (const p of coaches) applyForm(p, form.get(p.id) || 0);
  return cat;
}

module.exports = { load, CACHE, applyForm };
