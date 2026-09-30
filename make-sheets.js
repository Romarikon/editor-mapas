// Hojas de contacto de tiles (para etiquetarlos a ojo). Uso: node make-sheets.js <salida> [objetosTop] [suelosTop]
// Agrupa por categoría (tilestats.json) y ordena por uso. 8x6 tiles por hoja, con su número debajo.
const fs = require('fs'), path = require('path'), sharp = require('sharp');
const [outDir, topO = 830, topG = 98] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'tilestats.json')));
const COLS = 8, ROWS = 6, CW = 128, CH = 140, PAD = 4;

function pickTop(kind, n) {
  return Object.entries(st[kind]).filter(([, v]) => v.n > 0).sort((a, b) => b[1].n - a[1].n).slice(0, +n)
    .sort((a, b) => a[1].cat.localeCompare(b[1].cat) || b[1].n - a[1].n).map(([id, v]) => ({ kind, id, cat: v.cat }));
}

async function sheet(items, file) {
  const comps = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i], x = (i % COLS) * CW, y = ((i / COLS) | 0) * CH;
    try {
      const buf = await sharp(path.join(__dirname, 'assets', it.kind, it.id + '.svg'), { density: 96 })
        .resize(CW - 2 * PAD, CH - 24, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
      const meta = await sharp(buf).metadata();
      comps.push({ input: buf, left: x + ((CW - meta.width) >> 1), top: y + PAD + ((CH - 24 - meta.height) >> 1) });
    } catch (e) { /* sprite roto: hueco */ }
    const label = Buffer.from(`<svg width="${CW}" height="18"><text x="${CW / 2}" y="14" font-size="13" font-family="Arial" font-weight="bold" fill="#ffd27a" text-anchor="middle">${it.kind}${it.id}</text></svg>`);
    comps.push({ input: label, left: x, top: y + CH - 18 });
  }
  await sharp({ create: { width: COLS * CW, height: ROWS * CH, channels: 4, background: '#2a2a33' } }).composite(comps).png().toFile(file);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const all = [...pickTop('o', topO), ...pickTop('g', topG)];
  const per = COLS * ROWS, index = [];
  for (let s = 0; s * per < all.length; s++) {
    const items = all.slice(s * per, (s + 1) * per), file = path.join(outDir, `hoja_${String(s + 1).padStart(2, '0')}.png`);
    await sheet(items, file);
    index.push({ file: path.basename(file), cats: [...new Set(items.map(i => i.kind + ':' + i.cat))].join(','), first: items[0].kind + items[0].id, last: items[items.length - 1].kind + items[items.length - 1].id });
  }
  fs.writeFileSync(path.join(outDir, 'indice.json'), JSON.stringify({ items: all, sheets: index }, null, 1));
  console.log(index.length, 'hojas');
  index.forEach(i => console.log(i.file, i.cats));
})();
