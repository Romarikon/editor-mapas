// Convierte tags-manual.txt (+ categorías de tilestats) en assets/tags.json. Uso: node build-tags.js
// Cada tile: { t: [etiquetas], r: [roles], auto?: true }. Los roles agrupan etiquetas para la lógica del generador.
const fs = require('fs'), path = require('path');
const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'tilestats.json')));

const { roles } = require('./tag-roles.js');
const AUTO = { floor: ['decorado de suelo'], deco: ['decorativo'], obstacle: ['obstáculo'], wall: ['muro'], tall: ['objeto alto'],
               walkable: ['suelo'], blocked: ['suelo bloqueado'], background: ['fondo'], unused: [] };


const out = { o: {}, g: {} };
for (const line of fs.readFileSync(path.join(__dirname, 'tags-manual.txt'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([og])(\d+):\s*(.+)$/);
  if (!m) continue;
  const tags = m[3].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  out[m[1]][m[2]] = { t: tags, r: roles(tags) };
}
let auto = 0;
for (const kind of ['o', 'g'])
  for (const [id, s] of Object.entries(st[kind])) {
    if (out[kind][id]) continue;
    const tags = AUTO[s.cat] || [];
    out[kind][id] = { t: tags, r: roles(tags), auto: true };
    auto++;
  }
fs.writeFileSync(path.join(__dirname, 'assets', 'tags.json'), JSON.stringify(out));
const manual = Object.values(out.o).concat(Object.values(out.g)).filter(x => !x.auto).length;
const count = {}; for (const k of ['o', 'g']) for (const v of Object.values(out[k])) if (!v.auto) for (const r of v.r) count[r] = (count[r] || 0) + 1;
console.log(`etiquetas: ${manual} a mano, ${auto} automáticas (por categoría)\nroles:`, JSON.stringify(count));
