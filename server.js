// Editor de mapas — backend local. Uso: node server.js  →  http://localhost:4600
// Lee y guarda en la base de juego (aegnor_game): maps (mapData, places) y npcs.
const http = require('http'), fs = require('fs'), path = require('path');
const mysql = require('mysql2/promise');
const C = require('./public/mapcodec.js');

const PORT = 4600;
const db = mysql.createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'aegnor_game', connectionLimit: 4 });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function getMap(id) {
  const [[m]] = await db.query('SELECT id, width, heigth AS height, `key`, mapData, places, bgID, outDoor, date FROM maps WHERE id = ?', [id]);
  if (!m) return null;
  const plain = C.decryptMapData(m.mapData, m.key);
  const [npcs] = await db.query('SELECT npcid, cellid, orientation FROM npcs WHERE mapid = ?', [id]);
  const [scripted] = await db.query('SELECT DISTINCT CellID AS cell FROM scripted_cells WHERE MapID = ?', [id]).catch(() => [[]]);
  const [[dg]] = await db.query('SELECT dungeon FROM dream_dungeon_maps WHERE map_id = ?', [id]).catch(() => [[null]]);
  return { id: m.id, width: m.width, height: m.height, date: m.date, bgID: m.bgID, outDoor: m.outDoor, encrypted: !!m.key,
           dungeon: dg ? dg.dungeon : null, cells: C.decodeCells(plain), places: C.decodePlaces(m.places), npcs,
           scriptedCells: scripted.map(s => s.cell) };
}

/** Guarda casillas de combate y NPC (los envía el servidor: funcionan sin tocar el cliente). */
async function saveServerSide(id, body) {
  const places = C.encodePlaces(body.places[0] || [], body.places[1] || []);
  await db.query('UPDATE maps SET places = ? WHERE id = ?', [places, id]);
  await db.query('DELETE FROM npcs WHERE mapid = ?', [id]);
  for (const n of body.npcs || [])
    await db.query('INSERT INTO npcs (mapid, npcid, cellid, orientation, isMovable) VALUES (?, ?, ?, ?, 0)', [id, n.npcid, n.cellid, n.orientation | 0]);
  return { ok: true, places };
}

async function listMaps(q) {
  const where = q ? 'WHERE m.id LIKE ? OR d.dungeon LIKE ?' : '';
  const args = q ? [q + '%', '%' + q + '%'] : [];
  const [rows] = await db.query(`SELECT m.id, m.width, m.heigth AS height, d.dungeon FROM maps m LEFT JOIN dream_dungeon_maps d ON d.map_id = m.id ${where} ORDER BY d.dungeon IS NULL, d.dungeon, m.id LIMIT 300`, args);
  return rows;
}

/** Mapas de la misma zona (mazmorra si la hay; si no, subzona de mappos), del mismo tamaño, para aprender de ellos. */
async function zoneOf(id) {
  const [[m]] = await db.query('SELECT id, width, heigth AS height, mappos FROM maps WHERE id = ?', [id]);
  if (!m) return null;
  const [[dg]] = await db.query('SELECT dungeon FROM dream_dungeon_maps WHERE map_id = ?', [id]).catch(() => [[null]]);
  const subarea = (m.mappos || '').split(',')[2];
  let rows, zone;
  if (dg) {
    zone = 'Mazmorra ' + dg.dungeon;
    [rows] = await db.query('SELECT m.id, m.width, m.heigth AS height, m.`key`, m.mapData, m.places FROM maps m JOIN dream_dungeon_maps d ON d.map_id = m.id WHERE d.dungeon = ? AND m.width = ? AND m.heigth = ? LIMIT 80', [dg.dungeon, m.width, m.height]);
  } else {
    zone = 'Subzona ' + subarea;
    [rows] = await db.query("SELECT id, width, heigth AS height, `key`, mapData, places FROM maps WHERE SUBSTRING_INDEX(mappos, ',', -1) = ? AND width = ? AND heigth = ? LIMIT 80", [subarea, m.width, m.height]);
  }
  const maps = rows.map(r => {
    try { return { id: r.id, width: r.width, height: r.height, cells: C.decodeCells(C.decryptMapData(r.mapData, r.key)), places: C.decodePlaces(r.places) }; }
    catch (e) { return null; }
  }).filter(x => x && x.cells.length);
  return { zone, maps };
}

async function npcTemplates() {
  const [rows] = await db.query('SELECT id, gfxID FROM npc_template ORDER BY id');
  return rows;
}

function send(res, code, data, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
}

function serveStatic(res, file, cacheable = false) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'no existe' });
  // el código del editor nunca se cachea (cambia a menudo); los sprites sí
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cacheable ? 'max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    let m;
    if (p === '/api/maps') return send(res, 200, await listMaps(url.searchParams.get('q') || ''));
    if (p === '/api/npcs') return send(res, 200, await npcTemplates());
    if ((m = p.match(/^\/api\/zone\/(\d+)$/))) { const z = await zoneOf(+m[1]); return z ? send(res, 200, z) : send(res, 404, { error: 'mapa no encontrado' }); }
    if ((m = p.match(/^\/api\/map\/(\d+)$/))) {
      if (req.method === 'GET') { const map = await getMap(+m[1]); return map ? send(res, 200, map) : send(res, 404, { error: 'mapa no encontrado' }); }
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        return send(res, 200, await saveServerSide(+m[1], JSON.parse(body)));
      }
    }
    if (p.startsWith('/assets/')) return serveStatic(res, path.join(__dirname, 'assets', path.normalize(p.slice(8))), !p.endsWith('index.json'));
    return serveStatic(res, path.join(__dirname, 'public', p === '/' ? 'index.html' : path.normalize(p)));
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log('Editor de mapas en http://localhost:' + PORT));
