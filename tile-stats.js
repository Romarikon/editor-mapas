// Estadísticas de uso de cada tile en todos los mapas, para clasificar la paleta del editor.
// Uso: node tile-stats.js   (lee data/maps-pack.json; genera assets/tilestats.json)
// Por tile: n = apariciones; objetos: o1/o2 = veces en cada capa, blk = en celda bloqueada, los = tapando visión;
// suelos: walk/blk = en celda caminable/bloqueada. Categoría calculada con reglas simples.
const fs = require('fs'), path = require('path');
const C = require('./public/mapcodec.js');

const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'maps-pack.json'), 'utf8'));
const index = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'index.json'), 'utf8'));
const g = {}, o = {};
const G = id => (g[id] ||= { n: 0, walk: 0, blk: 0 });
const O = id => (o[id] ||= { n: 0, o1: 0, o2: 0, blk: 0, los: 0 });

for (const m of pack.maps) {
  let cells;
  try { cells = C.decodeCells(C.decryptMapData(m.mapData, m.key)); } catch (e) { continue; }
  if (m.bgID) { const s = G(m.bgID); s.bg = (s.bg || 0) + 1; }
  for (const c of cells) {
    if (!c.active) continue;
    if (c.layerGroundNum) { const s = G(c.layerGroundNum); s.n++; c.movement ? s.walk++ : s.blk++; }
    if (c.layerObject1Num) { const s = O(c.layerObject1Num); s.n++; s.o1++; if (!c.movement) s.blk++; }
    if (c.layerObject2Num) { const s = O(c.layerObject2Num); s.n++; s.o2++; if (!c.movement) s.blk++; if (!c.lineOfSight) s.los++; }
  }
}

function catObject(id, s) {
  const meta = index.o[id] || {};
  if (!s || !s.n) return 'unused';
  if (s.o1 >= s.o2) return 'floor';                       // decorado pegado al suelo
  if (s.los / s.o2 > 0.5) return (meta.h || 0) > 150 ? 'tall' : 'wall'; // tapa la visión
  if (s.blk / s.o2 > 0.5) return (meta.h || 0) > 150 ? 'tall' : 'obstacle';
  return 'deco';                                           // objeto alto que no bloquea
}
function catGround(id, s) {
  const meta = index.g[id] || {};
  if ((s && s.bg) || (meta.w || 0) > 600) return 'background';
  if (!s || !s.n) return 'unused';
  return s.blk > s.walk ? 'blocked' : 'walkable';
}

const out = { generatedAt: new Date().toISOString(), g: {}, o: {} };
const darkOrig = (kind, id) => (index[kind][id] || {}).darkOf;
for (const id of Object.keys(index.g)) { const src = darkOrig('g', id) || id, s = g[src]; out.g[id] = { n: s ? s.n : 0, cat: catGround(src, s), ...(darkOrig('g', id) ? { dark: true } : {}) }; }
for (const id of Object.keys(index.o)) { const src = darkOrig('o', id) || id, s = o[src]; out.o[id] = { n: s ? s.n : 0, cat: catObject(src, s), ...(darkOrig('o', id) ? { dark: true } : {}) }; }
fs.writeFileSync(path.join(__dirname, 'assets', 'tilestats.json'), JSON.stringify(out));
const count = (t, k) => Object.values(out[t]).reduce((m, v) => (m[v.cat] = (m[v.cat] || 0) + 1, m), {});
console.log('suelos:', JSON.stringify(count('g')), '\nobjetos:', JSON.stringify(count('o')));
