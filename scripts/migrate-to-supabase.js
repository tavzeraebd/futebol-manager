/*
 * Copia os dados antigos (data/db.json e data/imported.json) para o Supabase. Rode uma vez, com o servidor parado.
 * Uso: node scripts/migrate-to-supabase.js [caminho/db.json]
 * Precisa de SUPABASE_SERVICE_ROLE_KEY (ou config.local.json). É seguro repetir: usa upsert.
 */
const fs = require('fs');
const path = require('path');
const { createStore } = require('../server/store');

const DB = process.argv[2] || path.join(__dirname, '..', 'data', 'db.json');
const IMPORTED = path.join(__dirname, '..', 'data', 'imported.json');

(async () => {
  const store = createStore();
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  db.clubs = db.clubs || {}; db.leagues = db.leagues || {}; db.matches = db.matches || []; db.trades = db.trades || [];
  for (const c of Object.values(db.clubs)) { // formato antigo: token único -> várias sessões
    if (!c.sessions) { c.sessions = c.tokenHash ? [c.tokenHash] : []; delete c.tokenHash; }
  }
  store.attach(db);
  store.save();
  await store.flushNow();
  const imported = fs.existsSync(IMPORTED) ? JSON.parse(fs.readFileSync(IMPORTED, 'utf8')) : [];
  if (imported.length) {
    await store.upsert('imported_players', imported.map(p => ({ id: p.id, name: p.name, club: p.club || null, data: p })));
  }
  const count = async t => (await store.sb.from(t).select('*', { count: 'exact', head: true })).count;
  console.log('Migração concluída. No Supabase agora:');
  for (const t of ['clubs', 'club_players', 'matches', 'leagues', 'league_members', 'league_fixtures', 'trades', 'imported_players']) console.log('  ' + t + ': ' + await count(t));
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
