/* Catálogo: exemplo local + cache do Sofascore + jogadores importados por busca (guardados no Supabase). */
const fs = require('fs');
const path = require('path');
const seed = require('./seed');
const F = require('./form');
const TR = require('./training');

const CACHE = path.join(__dirname, '..', 'data', 'catalog.sofascore.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Nota e valor efetivos = base (ovr0/value0, nunca mudam) + forma acumulada (delta em pontos de nota) + treino.
 * O motor e a loja leem ovr/value; a tela mostra a forma em p.form. O treino fica em p.train (pontos por característica) e
 * p.trainOvr (quanto dele entrou na nota): o motor tira trainOvr da nota e soma o treino característica por característica.
 */
function applyForm(p, delta, gains) {
  if (p.ovr0 == null) { p.ovr0 = p.ovr; p.value0 = p.value; }
  p.form = +delta.toFixed(2);
  const base = clamp(p.ovr0 + delta, 40, 99);
  const t = gains && p.role ? TR.trainOvr(p.role, gains) : 0;
  p.ovr = +clamp(base + t, 40, 99).toFixed(1);
  if (t > 0) {
    p.train = {};
    for (const k of TR.KEYS) if (gains[k]) p.train[k] = +gains[k].toFixed(2);
    p.trainOvr = +(p.ovr - base).toFixed(2);
  } else { delete p.train; delete p.trainOvr; }
  p.value = Math.max(1e5, Math.round(p.value0 * F.valueFactor(delta + (p.trainOvr || 0)) / 1e5) * 1e5);
}

/**
 * `imported`: jogadores já importados (vêm do banco); `persist(p)`: grava um jogador importado; `form`: Map id -> forma;
 * `train`: Map id -> estado de treino e condição física (training.js).
 */
function load({ imported = [], persist = () => {}, keep = new Set(), form = new Map(), train = new Map() } = {}) {
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
    source, players, coaches, imported, form, train,
    playerById: new Map(), coachById: new Map(coaches.map(x => [x.id, x])),
    item(id) { return this.playerById.get(id) || this.coachById.get(id) || null; },
    /** Soma pontos de forma a um jogador/técnico (respeitando o teto). Devolve a forma nova ou null se o item não existe. */
    bump(id, points) {
      const it = this.item(id);
      if (!it) return null;
      const d = clamp((this.form.get(id) || 0) + points, -F.MAX_FORM, F.MAX_FORM);
      this.form.set(id, d);
      this.apply(it);
      return d;
    },
    /** Recalcula nota e valor de um item (depois de mudar a forma ou o treino). */
    apply(it) { const s = this.train.get(it.id); applyForm(it, this.form.get(it.id) || 0, s && s.gains); },
    /** Junta jogadores vindos do banco (sem gravar de novo). Devolve quantos eram novos. */
    merge(list) {
      let n = 0;
      for (const p of list) {
        if (dup(p)) continue;
        const old = this.playerById.get(p.id);
        if (old) { Object.assign(old, p, { ovr0: p.ovr, value0: p.value }); this.apply(old); }
        else { this.players.push(p); this.playerById.set(p.id, p); this.apply(p); n++; }
      }
      return n;
    },
    add(p) {
      const base = dup(p);
      if (base) return base; // já existe no catálogo base: usa o original
      persist(Object.assign({}, p)); // grava a versão base, sem a forma
      const old = this.playerById.get(p.id);
      if (old) { Object.assign(old, p, { ovr0: p.ovr, value0: p.value }); this.apply(old); }
      else { this.players.push(p); this.playerById.set(p.id, p); this.apply(p); }
      return this.playerById.get(p.id);
    }
  };
  for (const p of players) cat.playerById.set(p.id, p);
  for (const p of imported) { if (dup(p)) continue; if (!cat.playerById.has(p.id)) players.push(p); cat.playerById.set(p.id, p); }
  for (const p of players) cat.apply(p);
  for (const p of coaches) cat.apply(p);
  return cat;
}

module.exports = { load, CACHE, applyForm };
