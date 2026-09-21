/*
 * Baixa elencos do Sofascore para data/catalog.sofascore.json.
 * Uso: node scripts/sync-sofascore.js "Nottingham Forest=14" "Coventry City=..." [--rating=17:61627]
 *   (nome do clube = id do time no Sofascore; --rating=torneio:temporada busca a nota média)
 * Veja o aviso em server/providers/sofascore.js: pode retornar 403 sem acesso permitido.
 */
const fs = require('fs');
const path = require('path');
const ss = require('../server/providers/sofascore');
const { CACHE } = require('../server/catalog');

(async () => {
  const args = process.argv.slice(2);
  const ratingArg = args.find(a => a.startsWith('--rating='));
  const tournament = ratingArg ? { ut: ratingArg.split('=')[1].split(':')[0], season: ratingArg.split(':')[1] } : null;
  const teams = args.filter(a => !a.startsWith('--')).map(a => { const i = a.lastIndexOf('='); return [a.slice(0, i), a.slice(i + 1)]; });
  if (!teams.length) { console.error('Informe ao menos um time: "Nome=ID"'); process.exit(1); }

  const players = [];
  for (const [name, id] of teams) {
    try {
      const list = await ss.fetchTeamPlayers(id, name, tournament);
      console.log(name + ': ' + list.length + ' jogadores');
      players.push(...list);
    } catch (e) {
      console.error(name + ': ' + e.message);
    }
  }
  if (players.length < 22) { console.error('Poucos jogadores obtidos; catálogo não gravado (o jogo continua usando o catálogo local).'); process.exit(2); }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ updatedAt: new Date().toISOString(), players, coaches: [] }, null, 1));
  console.log('Gravado em ' + CACHE);
})();
