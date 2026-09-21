/* Catálogo: exemplo local + cache do Sofascore + jogadores importados por busca (guardados no Supabase). */
const fs = require('fs');
const path = require('path');
const seed = require('./seed');

const CACHE = path.join(__dirname, '..', 'data', 'catalog.sofascore.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/** `imported`: jogadores já importados (vêm do banco); `persist(p)`: grava um jogador importado. */
function load({ imported = [], persist = () => {} } = {}) {
  let players = seed.players.slice(), coaches = seed.coaches, source = 'seed';
  const c = readJson(CACHE, null);
  if (c && c.players && c.players.length >= 22) {
    players = c.players;
    coaches = c.coaches && c.coaches.length ? c.coaches : seed.coaches;
    source = 'sofascore';
  }
  const cat = {
    source, players, coaches, imported,
    playerById: new Map(), coachById: new Map(coaches.map(x => [x.id, x])),
    /** Junta jogadores vindos do banco (sem gravar de novo). Devolve quantos eram novos. */
    merge(list) {
      let n = 0;
      for (const p of list) {
        const old = this.playerById.get(p.id);
        if (old) Object.assign(old, p); else { this.players.push(p); this.playerById.set(p.id, p); n++; }
      }
      return n;
    },
    add(p) {
      const old = this.playerById.get(p.id);
      if (old) { Object.assign(old, p); } else { this.players.push(p); this.playerById.set(p.id, p); }
      const i = this.imported.findIndex(x => x.id === p.id);
      if (i >= 0) this.imported[i] = p; else this.imported.push(p);
      persist(p);
      return this.playerById.get(p.id);
    }
  };
  for (const p of players) cat.playerById.set(p.id, p);
  for (const p of imported) { if (!cat.playerById.has(p.id)) players.push(p); cat.playerById.set(p.id, p); }
  return cat;
}

module.exports = { load, CACHE };
