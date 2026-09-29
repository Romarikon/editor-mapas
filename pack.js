// Empaqueta el editor para usarlo sin servidor ni base de datos (p. ej. para Nemo).
// Uso: node pack.js [salida]   (por defecto F:/Dofus_Dual/dist)
//  1. Vuelca de la base todos los mapas, NPC, celdas con acción y plantillas de NPC a data/maps-pack.json
//  2. Copia editor + sprites + node.exe a <salida>/EditorMapas con un .bat de doble clic
//  3. Comprime <salida>/EditorMapas.zip
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const mysql = require('mysql2/promise');

const OUT = process.argv[2] || 'F:/Dofus_Dual/dist';
const DIST = path.join(OUT, 'EditorMapas');

async function dump() {
  const db = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: '', database: 'aegnor_game' });
  const [maps] = await db.query('SELECT m.id, m.width, m.heigth AS height, m.mappos, m.date, m.`key`, m.mapData, m.places, d.dungeon FROM maps m LEFT JOIN dream_dungeon_maps d ON d.map_id = m.id WHERE m.mapData <> \'\'');
  const [npcRows] = await db.query('SELECT mapid, npcid, cellid, orientation FROM npcs');
  const [scriptedRows] = await db.query('SELECT DISTINCT MapID AS map, CellID AS cell FROM scripted_cells');
  const [npcTemplates] = await db.query('SELECT id, gfxID FROM npc_template ORDER BY id');
  await db.end();
  const npcs = {}, scripted = {};
  for (const n of npcRows) (npcs[n.mapid] ||= []).push({ npcid: n.npcid, cellid: n.cellid, orientation: n.orientation });
  for (const s of scriptedRows) (scripted[s.map] ||= []).push(s.cell);
  return { generatedAt: new Date().toISOString(), maps, npcs, scripted, npcTemplates };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '_tmp') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

(async () => {
  console.log('Volcando la base…');
  const pack = await dump();
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'maps-pack.json'), JSON.stringify(pack));
  console.log(`  ${pack.maps.length} mapas, ${Object.keys(pack.npcs).length} mapas con NPC, ${Object.keys(pack.scripted).length} con celdas de acción`);

  console.log('Armando', DIST);
  fs.rmSync(DIST, { recursive: true, force: true });
  for (const d of ['public', 'data', 'assets']) copyDir(path.join(__dirname, d), path.join(DIST, d));
  for (const f of ['server.js', 'swfmap.js']) fs.copyFileSync(path.join(__dirname, f), path.join(DIST, f));
  fs.copyFileSync(process.execPath, path.join(DIST, 'node.exe'));
  fs.writeFileSync(path.join(DIST, 'Abrir editor.bat'),
    '@echo off\r\ncd /d "%~dp0"\r\nset OFFLINE=1\r\nstart "Editor de mapas (no cerrar)" node.exe server.js\r\ntimeout /t 2 /nobreak >nul\r\nstart "" http://localhost:4600\r\n');
  fs.writeFileSync(path.join(DIST, 'LEEME.txt'), [
    'EDITOR DE MAPAS (versión sin conexión)',
    '',
    '1. Doble clic en "Abrir editor.bat". Se abre una ventana negra (no la cierres mientras uses el editor)',
    '   y el navegador en http://localhost:4600',
    '2. Busca mapas a la izquierda (por id o por mazmorra, p. ej. "Kimbo").',
    '3. Modos: Ver, Seleccionar (clic en un sprite: ver su celda, Supr para borrarlo, F para voltearlo),',
    '   Decorado (pintar tiles), Celdas (caminable / visión / Alt+clic altura), Combate (casillas rojo/azul), NPC.',
    '4. "Nuevo" crea un mapa desde cero. "Generar variante" rehace el interior con la decoración de la zona.',
    '5. "Guardar archivo" descarga un .dmap.json: pásaselo a Miasma para meterlo en el servidor.',
    '   "Abrir" carga un .dmap.json.',
    '',
    'Contiene gráficos del cliente de Dofus Retro: uso privado del equipo, no lo publiques.',
    'Mapas volcados: ' + pack.generatedAt,
  ].join('\r\n'));

  console.log('Comprimiendo…');
  const zip = path.join(OUT, 'EditorMapas.zip');
  fs.rmSync(zip, { force: true });
  // el tar de Windows (bsdtar) sí crea zip; el de Git (GNU) no, y trata "F:" como host remoto
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', OUT, 'EditorMapas'], { stdio: 'inherit' });
  console.log('Listo:', zip, Math.round(fs.statSync(zip).size / 1e6) + ' MB');
})().catch(e => { console.error(e); process.exit(1); });
