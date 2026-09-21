/*
 * Define/reseta a senha de um clube (recuperação de acesso). Grava direto no Supabase.
 * Se o servidor estiver rodando, ele ainda tem a senha antiga em memória e a sobrescreveria: PARE-O antes.
 * Uso: node scripts/set-password.js "Nome do Clube" "nova senha"
 */
const crypto = require('crypto');
const { createStore } = require('../server/store');

const [name, pw] = process.argv.slice(2);
if (!name || !pw || pw.length < 4) { console.error('Uso: node scripts/set-password.js "Nome do Clube" "senha (mín. 4)"'); process.exit(1); }

(async () => {
  const { sb } = createStore();
  const { data, error } = await sb.from('clubs').select('id, name');
  if (error) throw new Error(error.message);
  const club = data.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!club) { console.error('Clube não encontrado. Existentes: ' + data.map(c => c.name).join(', ')); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const passHash = 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex');
  const up = await sb.from('clubs').update({ pass_hash: passHash }).eq('id', club.id);
  if (up.error) throw new Error(up.error.message);
  console.log('Senha definida para "' + club.name + '".');
})().catch(e => { console.error('Falhou:', e.message); process.exit(1); });
