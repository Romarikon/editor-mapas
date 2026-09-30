// Versiones oscuras ("pesadilla") de los tiles usados en los mapas, inyectadas en el cliente como tiles nuevos.
// Uso: node dark-variants.js <carpeta clips del cliente> [--limit N]
//  - renderiza cada tile (SVG del editor), aplica un filtro de pesadilla y lo guarda como tile nuevo con un id libre
//  - escribe bibliotecas SWF compartidas clips/gfx/o13.swf, o14.swf… y g3.swf (bitmap + forma + sprite + export),
//    con el mismo punto de anclaje que el original
//  - añade la importación de cada biblioteca a clips/objects.swf y clips/ground.swf (copia .orig la primera vez)
//  - para el editor: assets/{o,g}/<id>.svg, index.json y assets/dark.json { o: {orig: nuevo}, g: {...} }
// Es repetible: parte siempre de los .orig y del índice sin las versiones oscuras anteriores.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), sharp = require('sharp');

const clips = process.argv[2];
if (!clips) { console.error('uso: node dark-variants.js <cliente>/resources/app/retroclient/clips [--limit N]'); process.exit(1); }
const LIMIT = process.argv.includes('--limit') ? +process.argv[process.argv.indexOf('--limit') + 1] : Infinity;
const A = path.join(__dirname, 'assets');
const CHUNK = 1200;                       // tiles por biblioteca
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

function bitmapTag(id, rgba, w, h) {           // DefineBitsLossless2, ARGB premultiplicado
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    px[i * 4] = a;
    px[i * 4 + 1] = (rgba[i * 4] * a / 255) | 0;
    px[i * 4 + 2] = (rgba[i * 4 + 1] * a / 255) | 0;
    px[i * 4 + 3] = (rgba[i * 4 + 2] * a / 255) | 0;
  }
  const hdr = Buffer.alloc(7); hdr.writeUInt16LE(id, 0); hdr[2] = 5; hdr.writeUInt16LE(w, 3); hdr.writeUInt16LE(h, 5);
  return tag(36, Buffer.concat([hdr, zlib.deflateSync(px, { level: 9 })]));
}

// DefineBitsJPEG3: JPEG del color + transparencia aparte comprimida (mucho más ligero que sin pérdidas).
// El color va premultiplicado por la transparencia: si el reproductor lo esperase sin premultiplicar, los bordes
// saldrían algo más oscuros, que en una pesadilla no molesta; al revés saldrían halos claros.
async function jpegTag(id, rgba, w, h) {
  const rgb = Buffer.alloc(w * h * 3), alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3]; alpha[i] = a;
    rgb[i * 3] = (rgba[i * 4] * a / 255) | 0; rgb[i * 3 + 1] = (rgba[i * 4 + 1] * a / 255) | 0; rgb[i * 3 + 2] = (rgba[i * 4 + 2] * a / 255) | 0;
  }
  const jpg = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 86, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false, optimiseCoding: true }).toBuffer(); // Flash solo admite JPEG básico (baseline) dentro de un SWF
  const hdr = Buffer.alloc(6); hdr.writeUInt16LE(id, 0); hdr.writeUInt32LE(jpg.length, 2);
  return tag(35, Buffer.concat([hdr, jpg, zlib.deflateSync(alpha, { level: 9 })]));
}

function shapeTag(id, bmpId, w, h, tx, ty) {    // DefineShape: rectángulo con relleno de bitmap, origen en el anclaje
  const x0 = Math.round(-tx * 20), y0 = Math.round(-ty * 20), W = w * 20, H = h * 20;
  const parts = [u16(id), rect(x0, x0 + W, y0, y0 + H)];
  // FILLSTYLEARRAY: 1 relleno de bitmap recortado (0x41) con matriz escala 20 (twips por píxel) y traslación al origen
  const m = new Bits(); m.u(1, 1); const sb = nbitsS(20 << 16); m.u(sb + 1, 5); m.s(20 << 16, sb + 1); m.s(20 << 16, sb + 1);
  m.u(0, 1); const tb = nbitsS(x0, y0); m.u(tb, 5); m.s(x0, tb); m.s(y0, tb);
  parts.push(Buffer.from([1, 0x41]), u16(bmpId), m.flush(), Buffer.from([0])); // 1 relleno, 0 líneas
  const b = new Bits(); b.u(1, 4); b.u(0, 4);                                   // NumFillBits=1, NumLineBits=0
  // StyleChange: moveTo + FillStyle1
  const mb = nbitsS(x0, y0); b.u(0, 1); b.u(0, 1); b.u(0, 1); b.u(1, 1); b.u(0, 1); b.u(1, 1); b.u(mb, 5); b.s(x0, mb); b.s(y0, mb); b.u(1, 1);
  const edge = (dx, dy) => { const nb = nbitsS(dx, dy); b.u(1, 1); b.u(1, 1); b.u(nb - 2, 4);
    if (dx && dy) { b.u(1, 1); b.s(dx, nb); b.s(dy, nb); } else { b.u(0, 1); b.u(dy ? 1 : 0, 1); b.s(dx || dy, nb); } };
  edge(W, 0); edge(0, H); edge(-W, 0); edge(0, -H);
  b.u(0, 6); // EndShapeRecord
  parts.push(b.flush());
  return tag(2, Buffer.concat(parts));
}

function spriteTag(id, shapeIds) {              // DefineSprite: un fotograma por forma (los suelos con pendiente usan el fotograma)
  if (!shapeIds.length) return tag(39, Buffer.concat([u16(id), u16(1), Buffer.from([0x40, 0x00, 0, 0])])); // sprite vacío de 1 fotograma
  const inner = [];
  shapeIds.forEach((sid, f) => {
    inner.push(tag(26, Buffer.concat([Buffer.from([f ? 0x03 : 0x02]), u16(1), u16(sid)]))); // PlaceObject2 (mover/colocar)
    inner.push(Buffer.from([0x40, 0x00]));                                                  // ShowFrame
  });
  inner.push(Buffer.from([0, 0]));                                                          // End
  return tag(39, Buffer.concat([u16(id), u16(shapeIds.length), ...inner]));
}

function exportTag(pairs) {
  return tag(56, Buffer.concat([u16(pairs.length), ...pairs.map(([id, name]) => Buffer.concat([u16(id), Buffer.from(name + '\0', 'utf8')]))]));
}

function swfFile(tags) {
  const body = Buffer.concat([rect(0, 11000, 0, 8000), Buffer.from([0, 24]), u16(1), ...tags, Buffer.from([0x40, 0x00]), Buffer.from([0, 0])]);
  const head = Buffer.alloc(8); head.write('FWS', 0, 'ascii'); head[3] = 7; head.writeUInt32LE(8 + body.length, 4);
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
  // quitar del índice las versiones oscuras de una ejecución anterior
  for (const k of ['o', 'g']) for (const id of Object.values(prevDark[k] || {})) { delete index[k][id]; fs.rmSync(path.join(A, k, id + '.svg'), { force: true }); }
  const dark = { o: {}, g: {} }, libsByKind = { o: [], g: [] };

  for (const kind of ['g', 'o']) {
    const used = Object.entries(stats[kind]).filter(([id, s]) => s.n > 0 && index[kind][id]).sort((a, b) => b[1].n - a[1].n).map(([id]) => id).slice(0, LIMIT);
    const taken = new Set(Object.keys(index[kind]).map(Number)); let next = 1;
    const freeId = () => { while (taken.has(next)) next++; if (next > LIM[kind]) throw new Error('sin ids libres para ' + kind); taken.add(next); return next; };
    let lib = null, done = 0;
    const flush = () => {
      if (!lib || !lib.tags.length) return;
      const linkId = lib.nextChar++;
      lib.tags.push(spriteTag(linkId, []));
      lib.exports.push([linkId, lib.link]);
      fs.writeFileSync(path.join(clips, 'gfx', lib.file), swfFile([...lib.tags, exportTag(lib.exports)]));
      libsByKind[kind].push({ file: lib.file, link: lib.link, tiles: lib.exports.length - 1 });
    };
    for (const orig of used) {
      if (!lib || lib.exports.length >= CHUNK) {
        flush();
        const n = FIRST_LIB[kind] + libsByKind[kind].length;
        lib = { file: `${kind}${n}.swf`, link: `[Link_${kind}${n}-${kind === 'o' ? 'objects' : 'ground'}]`, tags: [], exports: [], nextChar: 1 };
      }
      const meta = index[kind][orig], nid = freeId();
      const frames = kind === 'g' && meta.frames > 1 ? Array.from({ length: meta.frames }, (_, f) => path.join(A, kind, `${orig}_${f + 1}.svg`)).filter(f => fs.existsSync(f)) : [path.join(A, kind, orig + '.svg')];
      const shapeIds = [];
      let firstPng = null;
      for (const f of frames) {
        let img;
        try { img = await darken(f); } catch (e) { continue; }
        const bmp = lib.nextChar++, shp = lib.nextChar++;
        lib.tags.push(await jpegTag(bmp, img.rgba, img.w, img.h), shapeTag(shp, bmp, img.w, img.h, meta.tx * img.w / meta.w, meta.ty * img.h / meta.h));
        shapeIds.push(shp);
        if (!firstPng) firstPng = await sharp(img.rgba, { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
      }
      if (!shapeIds.length) { taken.delete(nid); continue; }
      const spr = lib.nextChar++;
      lib.tags.push(spriteTag(spr, shapeIds));
      lib.exports.push([spr, String(nid)]);
      // para el editor: SVG con el PNG oscuro y el mismo anclaje
      fs.writeFileSync(path.join(A, kind, nid + '.svg'),
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${meta.w}px" height="${meta.h}px"><g transform="matrix(1.0, 0.0, 0.0, 1.0, ${meta.tx}, ${meta.ty})"><image x="${-meta.tx}" y="${-meta.ty}" width="${meta.w}" height="${meta.h}" xlink:href="data:image/png;base64,${firstPng.toString('base64')}"/></g></svg>`);
      index[kind][nid] = { ...meta, frames: 1, src: lib.file, darkOf: +orig };
      dark[kind][orig] = nid;
      if (++done % 250 === 0) console.log(`  ${kind}: ${done}/${used.length}`);
    }
    flush();
    console.log(`${kind === 'o' ? 'objetos' : 'suelos'}: ${done} versiones oscuras en ${libsByKind[kind].map(l => l.file).join(', ')}`);
  }

  addImports(path.join(clips, 'objects.swf'), libsByKind.o);
  addImports(path.join(clips, 'ground.swf'), libsByKind.g);
  fs.writeFileSync(path.join(A, 'index.json'), JSON.stringify(index));
  fs.writeFileSync(path.join(A, 'dark.json'), JSON.stringify(dark));
  console.log('cascarones actualizados (objects.swf, ground.swf); índice y dark.json escritos');
})().catch(e => { console.error(e); process.exit(1); });
