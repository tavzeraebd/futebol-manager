/*
 * Zera a temporada para um recomeço justo: todos os clubes voltam ao saldo inicial, sem jogadores, técnico, escalação,
 * pontos nem campanha; somem partidas, ligas, trocas e a "forma" dos jogadores. As CONTAS (nome do clube, senha, login com
 * Google e sessões) são mantidas, então ninguém precisa se cadastrar de novo. O catálogo de jogadores importados não muda.
 *
 * Antes de apagar, grava um backup em data/backup-temporada-<data>-<hora>.json (nunca sobrescreve um anterior).
 * Uso:  node scripts/reset-season.js --yes [--drop="Clube A,Clube B"]      (--drop remove clubes inteiros, ex.: de teste)
 * Rode com o servidor PARADO (ou reinicie-o logo depois): ele guarda o estado em memória e regravaria o antigo.
 */
const fs = require('fs');
const path = require('path');
const { createStore } = require('../server/store');
const R = require('../server/rules');

const TABLES = ['clubs', 'club_players', 'matches', 'leagues', 'league_members', 'league_fixtures', 'trades', 'player_form', 'player_stats'];

(async () => {
  if (!process.argv.includes('--yes')) { console.error('Isto apaga partidas, ligas, trocas, elencos e saldos. Confirme com --yes.'); process.exit(1); }
  const drop = ((process.argv.find(a => a.startsWith('--drop=')) || '').slice(7).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const { sb } = createStore();
  const all = async t => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(t).select('*').range(from, from + 999);
      if (error) throw new Error(t + ': ' + error.message);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  };

  const backup = {};
  for (const t of TABLES) backup[t] = await all(t);
  const file = path.join(__dirname, '..', 'data', 'backup-temporada-' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-') + '.json'); // com hora: nunca sobrescreve um backup anterior
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(backup));
  console.log('Backup: ' + file + ' (' + TABLES.map(t => t + ' ' + backup[t].length).join(', ') + ')');

  const del = async (t, col) => { const { error } = await sb.from(t).delete().not(col, 'is', null); if (error) throw new Error('apagar ' + t + ': ' + error.message); };
  for (const [t, col] of [['league_fixtures', 'id'], ['league_members', 'league_id'], ['leagues', 'id'], ['trades', 'id'], ['matches', 'id'], ['club_players', 'club_id'], ['player_form', 'player_id'], ['player_stats', 'player_id']]) await del(t, col);

  const dropIds = backup.clubs.filter(c => drop.includes(c.name.toLowerCase())).map(c => c.id);
  if (dropIds.length) { const { error } = await sb.from('clubs').delete().in('id', dropIds); if (error) throw new Error(error.message); console.log('Clubes removidos: ' + drop.join(', ')); }

  const { error } = await sb.from('clubs').update({
    budget: R.START_BUDGET, coach: null, formation: '4-3-3', lineup: Array(11).fill(null), tactic: 'balanced', plan: [],
    points: 0, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0
  }).not('id', 'is', null);
  if (error) throw new Error('clubes: ' + error.message);

  const left = (await sb.from('clubs').select('name, budget, points')).data;
  console.log('Clubes zerados (' + left.length + '): ' + left.map(c => c.name + ' € ' + c.budget / 1e6 + ' M').join(' · '));
  for (const t of TABLES) console.log('  ' + t.padEnd(16) + (await sb.from(t).select('*', { count: 'exact', head: true })).count);
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
