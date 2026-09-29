// Extrae los tiles del cliente (suelos g*.swf y objetos o*.swf) a SVG con su punto de anclaje.
// Uso: node extract-assets.js <carpeta clips/gfx del cliente> <salida assets>
// Genera <salida>/g/<num>.svg, <salida>/o/<num>.svg e index.json { g: {num: {tx,ty,w,h,frames}}, o: {...} }
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const [gfxDir, outDir] = process.argv.slice(2);
if (!gfxDir || !outDir) { console.error('uso: node extract-assets.js <clips/gfx> <assets>'); process.exit(1); }
// FFDec (JPEXS) portable: variable FFDEC o, por defecto, ../ffdec/ffdec-cli.jar
const FFDEC = process.env.FFDEC || path.join(__dirname, '..', 'ffdec', 'ffdec-cli.jar');
if (!fs.existsSync(FFDEC)) { console.error('No encuentro FFDec en ' + FFDEC + ' (define la variable FFDEC con la ruta a ffdec-cli.jar)'); process.exit(1); }
const tmp = path.join(outDir, '_tmp');
const index = fs.existsSync(path.join(outDir, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'))) : { g: {}, o: {} };

for (const file of fs.readdirSync(gfxDir).filter(f => /^[go]\d+\.swf$/.test(f)).sort()) {
  const kind = file[0];
  fs.mkdirSync(path.join(outDir, kind), { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const t0 = Date.now();
  execFileSync('java', ['-Xmx4g', '-jar', FFDEC, '-format', 'sprite:svg', '-export', 'sprite', tmp, path.join(gfxDir, file)], { stdio: 'ignore' });
  let n = 0;
  for (const dir of fs.readdirSync(tmp)) {
    const m = dir.match(/^DefineSprite_\d+_(\d+)$/); // solo sprites exportados con número de tile
    if (!m) continue;
    const frames = fs.readdirSync(path.join(tmp, dir)).filter(f => f.endsWith('.svg'));
    if (!frames.length) continue;
    const svg = fs.readFileSync(path.join(tmp, dir, frames.includes('1.svg') ? '1.svg' : frames[0]), 'utf8');
    const w = parseFloat((svg.match(/width="([\d.]+)px"/) || [])[1] || 0);
    const h = parseFloat((svg.match(/height="([\d.]+)px"/) || [])[1] || 0);
    const tr = svg.match(/<g transform="matrix\(1\.0, 0\.0, 0\.0, 1\.0, (-?[\d.]+), (-?[\d.]+)\)">/);
    index[kind][m[1]] = { tx: tr ? +tr[1] : 0, ty: tr ? +tr[2] : 0, w, h, frames: frames.length, src: file };
    // los suelos con pendiente usan el fotograma = groundSlope; se guardan todos los fotogramas en <num>_<f>.svg
    fs.writeFileSync(path.join(outDir, kind, m[1] + '.svg'), svg);
    if (kind === 'g' && frames.length > 1)
      for (const f of frames) fs.copyFileSync(path.join(tmp, dir, f), path.join(outDir, kind, m[1] + '_' + f));
    n++;
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index));
  console.log(file, '->', n, 'tiles en', Math.round((Date.now() - t0) / 1000), 's');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('listo:', Object.keys(index.g).length, 'suelos,', Object.keys(index.o).length, 'objetos');
