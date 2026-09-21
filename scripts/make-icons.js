/* Gera os ícones do PWA (PNG) sem dependências: campo escuro com bola. Uso: node scripts/make-icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x / size, y / size), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [9, 15, 29], PITCH = [22, 120, 60], LINE = [255, 255, 255], BALL = [250, 250, 255], PATCH = [20, 20, 30], ACCENT = [209, 107, 244];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const AA = 1.5; // suavização das bordas, em fração do tamanho

/** scale: raio da arte em relação ao ícone (menor no "maskable", que o Android recorta). */
function icon(size, scale, rounded) {
  const px = 1 / size;
  const cover = (d, r) => Math.min(1, Math.max(0, (r - d) / (px * AA) + 0.5)); // cobertura 0..1 de um disco
  return (u, v) => {
    const x = (u - 0.5) / scale, y = (v - 0.5) / scale, d = Math.hypot(x, y);
    let col = rounded ? BG : PITCH, a = 1;
    if (rounded) { const dc = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)); a = Math.min(1, Math.max(0, (0.5 - dc) / (px * AA) + 0.5)); }
    // gramado com listras e círculo central
    const disc = cover(d, 0.46);
    col = mix(col, mix(PITCH, [30, 140, 72], Math.floor((y + 0.5) * 8) % 2 ? 0 : 1), disc);
    col = mix(col, LINE, Math.max(0, 1 - Math.abs(d - 0.44) / (px * 3)) * disc * 0.9);
    // bola
    const r = 0.26, cx = 0.0, cy = 0.0;
    const bd = Math.hypot(x - cx, y - cy);
    col = mix(col, [0, 0, 0], cover(bd, r + 0.012) * 0.35);
    col = mix(col, BALL, cover(bd, r));
    // pentágono central + costuras + gomos cortados pela borda
    const pent = (ang0, rad) => Array.from({ length: 5 }, (_, i) => [Math.cos(ang0 + i * 2 * Math.PI / 5) * rad, Math.sin(ang0 + i * 2 * Math.PI / 5) * rad]);
    const inPoly = (poly, X, Y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i][1] > Y) !== (poly[j][1] > Y) && X < (poly[j][0] - poly[i][0]) * (Y - poly[i][1]) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c; return c; };
    const A0 = -Math.PI / 2, inner = pent(A0, 0.11);
    let ink = inPoly(inner, x, y) ? 1 : 0;
    for (let i = 0; i < 5; i++) { // costura do vértice do pentágono até a borda e gomo na ponta
      const ang = A0 + i * 2 * Math.PI / 5, [vx, vy] = inner[i], ex = Math.cos(ang) * r, ey = Math.sin(ang) * r;
      const t = Math.max(0, Math.min(1, ((x - vx) * (ex - vx) + (y - vy) * (ey - vy)) / ((ex - vx) ** 2 + (ey - vy) ** 2)));
      ink = Math.max(ink, cover(Math.hypot(x - (vx + (ex - vx) * t), y - (vy + (ey - vy) * t)), 0.008));
      const pa = ang + Math.PI / 5; // gomos entre as costuras, na borda
      if (inPoly(pent(pa + Math.PI, 0.1).map(([px2, py2]) => [px2 + Math.cos(pa) * 0.27, py2 + Math.sin(pa) * 0.27]), x, y)) ink = 1;
    }
    col = mix(col, PATCH, ink * cover(bd, r - 0.006));
    col = mix(col, ACCENT, Math.max(0, 1 - Math.abs(bd - r) / (px * 2.5)) * 0.9);
    return [...col, Math.round(a * 255)];
  };
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, icon(192, 1, true)));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, icon(512, 1, true)));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, icon(512, 1.45, false))); // arte na área segura (80%)
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180, icon(180, 1.2, false)));
console.log('Ícones gerados em icons/');
