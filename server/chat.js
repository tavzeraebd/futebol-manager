/* Utilidades de chat: limpeza/filtro de texto, reações permitidas, provocações prontas e limite de velocidade. */

const EMOJIS = ['👏', '🔥', '😂', '😱', '😡', '🤝', '⚽', '🥱', '😎', '🙏'];
const TAUNTS = ['Bora! 🔥', 'Tá fácil! 😎', 'Foi sorte! 😂', 'Boa jogada! 👏', 'Segura essa! 💪', 'Cadê a defesa? 🥱', 'Respeita o campeão! 🏆', 'Que golaço! ⚽'];

// Filtro básico de palavrões (português). Não é perfeito; serve para o uso entre amigos e crianças.
const BAD_WORDS = ['porra', 'caralho', 'merda', 'puta', 'putaria', 'fdp', 'buceta', 'viado', 'cacete', 'bosta', 'otario', 'idiota', 'imbecil', 'desgraca', 'arrombado', 'cuzao', 'foder', 'foda-se', 'fodase', 'babaca', 'retardado', 'lixo', 'burro'];
const SHORT_WORDS = ['cu', 'pau', 'fdp', 'pnc', 'vsf', 'tnc'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '@': 'a', '$': 's', '7': 't' };

/** Versão simplificada (minúscula, sem acento, sem "leet") com o MESMO comprimento do original. */
function fold(str) {
  let out = '';
  for (const ch of str) {
    let b = ch.normalize('NFD')[0].toLowerCase();
    b = LEET[b] || b;
    out += b;
  }
  return out;
}

function mask(text) {
  const chars = Array.from(text);
  const f = Array.from(fold(text)).join('');
  const isLetter = c => /[a-z]/.test(c || '');
  const hit = (from, to) => { for (let i = from; i < to; i++) if (/\S/.test(chars[i])) chars[i] = '*'; };
  // a palavra precisa começar num limite (não dentro de "disputa" ou "computador") e pode ter "s" no fim
  for (const w of BAD_WORDS.concat(SHORT_WORDS)) {
    let i = f.indexOf(w);
    while (i !== -1) {
      const end = i + w.length;
      const after = f[end] === 's' && !isLetter(f[end + 1]) ? end + 1 : end;
      if (!isLetter(f[i - 1]) && !isLetter(f[after])) hit(i, after);
      i = f.indexOf(w, i + 1);
    }
  }
  return chars.join('');
}

/** Texto seguro para exibir: sem controle, sem links, tamanho limitado e palavrões mascarados. */
function clean(text) {
  let t = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/(https?:\/\/|www\.)\S+/gi, '[link]').slice(0, 140);
  return mask(t);
}

class RateLimiter {
  constructor(max = 6, windowMs = 5000) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (list.length >= this.max) { this.hits.set(key, list); return false; }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

module.exports = { EMOJIS, TAUNTS, clean, mask, RateLimiter };
