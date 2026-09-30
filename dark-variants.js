// Versiones oscuras ("pesadilla") de los tiles usados en los mapas, inyectadas en el cliente como tiles nuevos.
// Uso: node dark-variants.js <carpeta clips del cliente> [--limit N]
//  - cada tile nuevo es un sprite que importa el original (vectorial) y lo coloca con un filtro de matriz de color
//  - escribe las bibliotecas SWF compartidas clips/gfx/o13.swf y g3.swf (importaciones + sprites + export);
//    el editor recibe una vista previa rasterizada con el mismo filtro
//  - añade la importación de cada biblioteca a clips/objects.swf y clips/ground.swf (copia .orig la primera vez)
//  - para el editor: assets/{o,g}/<id>.svg, index.json y assets/dark.json { o: {orig: nuevo}, g: {...} }
// Es repetible: parte siempre de los .orig y del índice sin las versiones oscuras anteriores.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), sharp = require('sharp');

const clips = process.argv[2];
if (!clips) { console.error('uso: node dark-variants.js <cliente>/resources/app/retroclient/clips [--limit N]'); process.exit(1); }
const LIMIT = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : Infinity;
const A = path.join(__dirname, 'assets');
const LIM = { g: 2047, o: 16383 };        // máximo que admite el formato de celda del mapa
const FIRST_LIB = { g: 3, o: 13 };        // g1-g2 y o1-o12 ya existen

// ------------------------------------------------------------------ filtro de pesadilla
async function darken(svgFile) {
  const { data, info } = await sharp(svgFile, { density: 96 })
    .modulate({ brightness: 0.62, saturation: 0.35 })
    .recomb([[0.85, 0.08, 0.12], [0.06, 0.78, 0.12], [0.14, 0.06, 0.95]])  // tinte frío, algo morado
    .linear([1.18, 1.18, 1.18, 1], [-14, -14, -14, 0])                   // más contraste (sin tocar la transparencia)
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, w: info.width, h: info.height };
}

// ------------------------------------------------------------------ escritor SWF mínimo
class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  u(v, nb) { for (let i = nb - 1; i >= 0; i--) { this.cur = (this.cur << 1) | ((v >>> i) & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } } }
  s(v, nb) { this.u(v & ((1 << nb) - 1), nb); }
  flush() { if (this.n) { this.bytes.push(this.cur << (8 - this.n)); this.cur = 0; this.n = 0; } return Buffer.from(this.bytes); }
}
const nbitsS = (...vals) => Math.max(1, ...vals.map(v => { v = Math.abs(v | 0); let n = 1; while (v >= (1 << (n - 1))) n++; return n; }));
function rect(xmin, xmax, ymin, ymax) { const b = new Bits(), n = nbitsS(xmin, xmax, ymin, ymax); b.u(n, 5); [xmin, xmax, ymin, ymax].forEach(v => b.s(v, n)); return b.flush(); }
function tag(code, body) {
  const h = Buffer.alloc(6); h.writeUInt16LE((code << 6) | 63, 0); h.writeUInt32LE(body.length, 2);
  return Buffer.concat([h, body]);
}
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

// Matriz de color (ColorMatrixFilter de Flash 8) equivalente al filtro de pesadilla de darken():
// brillo 0.62 y saturación 0.35 → tinte frío (recomb) → contraste ×1.18 −14. Fila i: salida = Σ m[i][j]·entrada[j] + offset.
function nightmareMatrix() {
  const L = [0.2126, 0.7152, 0.0722], sat = 0.35, bri = 0.62, k = 1.18, off = -14;
  const S = [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? sat : 0) + (1 - sat) * L[j]));
  const R = [[0.85, 0.08, 0.12], [0.06, 0.78, 0.12], [0.14, 0.06, 0.95]];
  const M = R.map(row => [0, 1, 2].map(j => k * bri * row.reduce((t, r, x) => t + r * S[x][j], 0)));
  return [...M[0], 0, off, ...M[1], 0, off, ...M[2], 0, off, 0, 0, 0, 1, 0];
}
const MATRIX = nightmareMatrix();

// PlaceObject3 del tile original (importado) con nombre "t" y el filtro de pesadilla: sigue siendo vectorial
function placeFiltered(charId) {
  const f = Buffer.alloc(1 + 1 + 80); f[0] = 1; f[1] = 6;      // 1 filtro: ColorMatrix
  MATRIX.forEach((v, i) => f.writeFloatLE(v, 2 + i * 4));
  return tag(70, Buffer.concat([Buffer.from([0x22, 0x01]), u16(1), u16(charId), Buffer.from("t\0"), f])); // HasName|HasCharacter, HasFilterList
}
// DoAction: [stop();] tellTarget("t") { gotoAndStop(frame); }
function actionTag(frame, stop) {
  const tgt = Buffer.from([0x8b, 2, 0, 0x74, 0]), gf = Buffer.from([0x81, 2, 0, frame & 255, frame >> 8]), back = Buffer.from([0x8b, 1, 0, 0]);
  return tag(12, Buffer.concat([stop ? Buffer.from([0x07]) : Buffer.alloc(0), tgt, gf, Buffer.from([0x07]), back, Buffer.from([0])]));
}
// Sprite envoltorio con tantos fotogramas como el original (los suelos con pendiente se eligen por fotograma):
// en cada fotograma f lleva al original también a f. El primero hace stop() como los sprites del juego.
function wrapperTag(id, innerId, frames) {
  const inner = [];
  for (let f = 0; f < frames; f++) {
    if (!f) inner.push(placeFiltered(innerId));
    inner.push(actionTag(f, f === 0), Buffer.from([0x40, 0x00]));
  }
  inner.push(Buffer.from([0, 0]));
  return tag(39, Buffer.concat([u16(id), u16(frames), ...inner]));
}
function emptySpriteTag(id) { return tag(39, Buffer.concat([u16(id), u16(1), Buffer.from([0x40, 0x00, 0, 0])])); }
function importTag(url, pairs) {                // ImportAssets2 (SWF 8)
  return tag(71, Buffer.concat([Buffer.from(url + "\0"), Buffer.from([1, 0]), u16(pairs.length), ...pairs.map(([id, name]) => Buffer.concat([u16(id), Buffer.from(name + "\0")]))]));
}

function exportTag(pairs) {
  return tag(56, Buffer.concat([u16(pairs.length), ...pairs.map(([id, name]) => Buffer.concat([u16(id), Buffer.from(name + '\0', 'utf8')]))]));
}

function swfFile(tags) {
  const body = Buffer.concat([rect(0, 11000, 0, 8000), Buffer.from([0, 24]), u16(1), tag(69, Buffer.from([0, 0, 0, 0])), ...tags, Buffer.from([0x40, 0x00]), Buffer.from([0, 0])]);
  const head = Buffer.alloc(8); head.write('FWS', 0, 'ascii'); head[3] = 8; head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([Buffer.from('CWS'), head.subarray(3, 8), zlib.deflateSync(body, { level: 9 })]);
}

// ------------------------------------------------------------------ cascarones objects.swf / ground.swf
function addImports(shellFile, libs) {
  if (!fs.existsSync(shellFile + '.orig')) fs.copyFileSync(shellFile, shellFile + '.orig');
  const raw = fs.readFileSync(shellFile + '.orig');
  const b = Buffer.concat([raw.subarray(0, 8), zlib.inflateSync(raw.subarray(8))]);
  const nbits = b[8] >> 3; let off = 8 + Math.ceil((5 + 4 * nbits) / 8) + 4, maxId = 0, insertAt = -1;
  while (off < b.length) {
    const start = off, h = b.readUInt16LE(off); let code = h >> 6, len = h & 63; off += 2;
    if (len === 63) { len = b.readUInt32LE(off); off += 4; }
    // el id nuevo debe ser mayor que TODOS los usados: importaciones (57), definiciones de sprite (39) y exportaciones (56)
    if (code === 57) { let p = off; p = b.indexOf(0, p) + 1; const cnt = b.readUInt16LE(p); p += 2; for (let i = 0; i < cnt; i++) { maxId = Math.max(maxId, b.readUInt16LE(p)); p = b.indexOf(0, p + 2) + 1; } }
    if (code === 39) maxId = Math.max(maxId, b.readUInt16LE(off));
    if (code === 56) { let p = off + 2; const cnt = b.readUInt16LE(off); for (let i = 0; i < cnt; i++) { maxId = Math.max(maxId, b.readUInt16LE(p)); p = b.indexOf(0, p + 2) + 1; } }
    if (code === 56 && insertAt < 0) insertAt = start; // antes del ExportAssets del cascarón
    off += len; if (code === 0) break;
  }
  const imports = libs.map((lib, i) => {
    const url = Buffer.from('clips/gfx/' + lib.file + '\0'), name = Buffer.from(lib.link + '\0');
    return tag(57, Buffer.concat([url, u16(1), u16(maxId + 1 + i), name]));
  });
  const out = Buffer.concat([b.subarray(0, insertAt), ...imports, b.subarray(insertAt)]);
  out.writeUInt32LE(out.length, 4);
  fs.writeFileSync(shellFile, Buffer.concat([Buffer.from('CWS'), out.subarray(3, 8), zlib.deflateSync(out.subarray(8), { level: 9 })]));
}

// ------------------------------------------------------------------ principal
(async () => {
  if (process.argv.includes('--shells-only')) { // reutiliza las bibliotecas ya generadas y solo rehace los cascarones
    const libs = kind => fs.readdirSync(path.join(clips, 'gfx'))
      .filter(f => f.startsWith(kind) && f.endsWith('.swf') && /^\d+$/.test(f.slice(1, -4)) && +f.slice(1, -4) >= FIRST_LIB[kind])
      .sort((a, b) => a.slice(1, -4) - b.slice(1, -4))
      .map(f => ({ file: f, link: '[Link_' + f.slice(0, -4) + '-' + (kind === 'o' ? 'objects' : 'ground') + ']' }));
    addImports(path.join(clips, 'objects.swf'), libs('o'));
    addImports(path.join(clips, 'ground.swf'), libs('g'));
    console.log('cascarones rehechos:', libs('o').map(l => l.file).join(', '), '+', libs('g').map(l => l.file).join(', '));
    return;
  }
  const index = JSON.parse(fs.readFileSync(path.join(A, 'index.json')));
  const stats = JSON.parse(fs.readFileSync(path.join(A, 'tilestats.json')));
  const prevDark = fs.existsSync(path.join(A, 'dark.json')) ? JSON.parse(fs.readFileSync(path.join(A, 'dark.json'))) : { o: {}, g: {} };
  // quitar del índice las versiones oscuras de una ejecución anterior (se reutilizan sus ids para no romper mapas ya hechos)
  for (const k of ['o', 'g']) for (const id of Object.values(prevDark[k] || {})) delete index[k][id];
  const dark = { o: {}, g: {} }, libsByKind = { o: [], g: [] };
  // las bibliotecas de una ejecución anterior se sustituyen enteras
  for (const f of fs.readdirSync(path.join(clips, 'gfx'))) { const m = /^([og])(\d+)\.swf$/.exec(f); if (m && +m[2] >= FIRST_LIB[m[1]]) fs.rmSync(path.join(clips, 'gfx', f)); }

  for (const kind of ['g', 'o']) {
    const used = Object.entries(stats[kind]).filter(([id, s]) => s.n > 0 && index[kind][id] && index[kind][id].src).sort((a, b) => b[1].n - a[1].n).map(([id]) => id).slice(0, LIMIT);
    const taken = new Set(Object.keys(index[kind]).map(Number)); let next = 1;
    const prev = prevDark[kind] || {};
    Object.values(prev).forEach(id => taken.add(+id));
    const freeId = () => { while (taken.has(next)) next++; if (next > LIM[kind]) throw new Error('sin ids libres para ' + kind); taken.add(next); return next; };
    // una biblioteca por tipo: cada tile oscuro es un envoltorio del original importado (vectorial, pocos bytes)
    const n = FIRST_LIB[kind], lib = { file: `${kind}${n}.swf`, link: `[Link_${kind}${n}-${kind === 'o' ? 'objects' : 'ground'}]` };
    const imports = {}, sprites = [], exports = []; let nextChar = 1, done = 0;
    for (const orig of used) {
      const meta = index[kind][orig];
      // para el editor: SVG con el PNG oscuro y el mismo anclaje (se reutiliza si ya existe); si el original no se
      // puede renderizar, el tile se salta como antes
      const known = prev[orig] !== undefined, nid = known ? +prev[orig] : freeId();
      const svg = path.join(A, kind, nid + '.svg');
      if (!known || !fs.existsSync(svg)) {
        const src = [path.join(A, kind, orig + '.svg'), path.join(A, kind, `${orig}_1.svg`)].find(f => fs.existsSync(f));
        let img = null;
        try { img = src && await darken(src); } catch (e) { }
        if (!img) { if (!known) taken.delete(nid); continue; }
        {
          const png = await sharp(img.rgba, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
          fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${meta.w}px" height="${meta.h}px"><g transform="matrix(1.0, 0.0, 0.0, 1.0, ${meta.tx}, ${meta.ty})"><image x="${-meta.tx}" y="${-meta.ty}" width="${meta.w}" height="${meta.h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/></g></svg>`);
        }
      }
      const inner = nextChar++, spr = nextChar++;
      (imports[meta.src] ||= []).push([inner, orig]);
      sprites.push(wrapperTag(spr, inner, Math.max(1, meta.frames || 1)));
      exports.push([spr, String(nid)]);
      index[kind][nid] = { ...meta, frames: 1, src: lib.file, darkOf: +orig };
      dark[kind][orig] = nid;
      if (++done % 500 === 0) console.log(`  ${kind}: ${done}/${used.length}`);
    }
    const linkId = nextChar++;
    const tags = [...Object.entries(imports).map(([src, pairs]) => importTag('clips/gfx/' + src, pairs)), ...sprites, emptySpriteTag(linkId)];
    exports.push([linkId, lib.link]);
    fs.writeFileSync(path.join(clips, 'gfx', lib.file), swfFile([...tags, exportTag(exports)]));
    libsByKind[kind].push(lib);
    console.log(`${kind === 'o' ? 'objetos' : 'suelos'}: ${done} versiones oscuras en ${lib.file}`);
  }
  // SVG del editor de ids que ya no se usan
  for (const k of ['o', 'g']) for (const id of Object.values(prevDark[k] || {})) if (!Object.values(dark[k]).includes(+id)) fs.rmSync(path.join(A, k, id + '.svg'), { force: true });

  addImports(path.join(clips, 'objects.swf'), libsByKind.o);
  addImports(path.join(clips, 'ground.swf'), libsByKind.g);
  fs.writeFileSync(path.join(A, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(A, 'dark.json'), JSON.stringify(dark));
  console.log('cascarones actualizados (objects.swf, ground.swf); índice y dark.json escritos');
})().catch(e => { console.error(e); process.exit(1); });
