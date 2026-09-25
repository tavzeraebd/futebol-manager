/*
 * Jogos em horário marcado (funções puras). O dono da liga escolhe os dias da semana e o horário (de Brasília, UTC-3, sem
 * horário de verão); cada rodada ganha um horário e o servidor joga sozinho quando ele chega (server.js, runScheduler).
 *
 * schedule = { days: [0..6] (0 = domingo), time: 'HH:MM' }
 */
const TZ = 3 * 3600e3;        // Brasília = UTC-3
const DAY = 24 * 3600e3;
const MIN_LEAD = 10 * 60e3;   // o primeiro jogo fica pelo menos 10 minutos depois de agendar (dá tempo de escalar)
const DAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Confere e normaliza a agenda enviada pela tela. Devolve { schedule } ou { error }. */
function parse(s) {
  if (!s || typeof s !== 'object') return { error: 'Agenda inválida.' };
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) return { error: 'Escolha ao menos um dia da semana para os jogos.' };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.time || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return { error: 'Horário inválido (use HH:MM).' };
  return { schedule: { days, time: String(+m[1]).padStart(2, '0') + ':' + m[2] } };
}

/** Próximos `n` horários da agenda a partir de `from` (ms). */
function slots(schedule, from, n) {
  const [h, mi] = schedule.time.split(':').map(Number);
  const out = [];
  let dayStart = Math.floor((from - TZ) / DAY) * DAY + TZ; // meia-noite de Brasília do dia de `from`
  for (let i = 0; out.length < n && i < 400; i++, dayStart += DAY) {
    const wd = new Date(dayStart - TZ).getUTCDay();
    if (!schedule.days.includes(wd)) continue;
    const at = dayStart + (h * 60 + mi) * 60e3;
    if (at >= from + MIN_LEAD) out.push(at);
  }
  return out;
}

/**
 * Dá horário às rodadas ainda sem jogo marcado (todas as partidas da mesma rodada no mesmo horário). Rodadas já com horário
 * mantêm o delas; as novas começam depois do último horário usado. Devolve quantos jogos ganharam horário.
 */
function assign(league, now) {
  const s = league.extra && league.extra.schedule;
  if (!s) return 0;
  const pending = league.fixtures.filter(f => !f.score && !f.at);
  if (!pending.length) return 0;
  const rounds = [...new Set(pending.map(f => f.round))].sort((a, b) => a - b);
  const used = league.fixtures.filter(f => f.at).map(f => f.at);
  const from = Math.max(now, used.length ? Math.max(...used) + 60e3 : now);
  const times = slots(s, from, rounds.length);
  let n = 0;
  rounds.forEach((r, i) => { for (const f of pending) if (f.round === r && times[i]) { f.at = times[i]; n++; } });
  return n;
}

/** "qua 24/09 às 20:00" (horário de Brasília). */
function label(at) {
  const d = new Date(at - TZ);
  return DAY_SHORT[d.getUTCDay()] + ' ' + String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + ' às ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

/** "segunda, quarta e sexta às 20:00" */
function describe(s) {
  if (!s) return '';
  const names = s.days.map(d => DAY_NAMES[d]);
  const list = names.length === 7 ? 'todos os dias' : names.length > 1 ? names.slice(0, -1).join(', ') + ' e ' + names[names.length - 1] : names[0];
  return list + ' às ' + s.time;
}

module.exports = { parse, slots, assign, label, describe, DAY_NAMES, DAY_SHORT, TZ, MIN_LEAD };
