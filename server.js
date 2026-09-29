// Editor de mapas — backend local. Uso: node server.js  →  http://localhost:4600
// Con base de datos (aegnor_game en 127.0.0.1:3306) lee y guarda mapas, casillas de combate y NPC.
// Sin base de datos (o con OFFLINE=1) usa data/maps-pack.json (lo genera pack.js) y no guarda en servidor.
const http = require('http'), fs = require('fs'), path = require('path');
const C = require('./public/mapcodec.js');

const PORT = +process.env.PORT || 4600;
const PACK = path.join(__dirname, 'data', 'maps-pack.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

// ------------------------------------------------------------------ fuentes de datos
function decodeRow(r) {
  return { id: r.id, width: r.width, height: r.height, cells: C.decodeCells(C.decryptMapData(r.mapData, r.key)), places: C.decodePlaces(r.places) };
}

function packSource() {
  const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
  const byId = new Map(pack.maps.map(m => [m.id, m]));
  const subarea = m => (m.mappos || '').split(',')[2];
  return {
    offline: true,
    async listMaps(q) {
      const ql = q.toLowerCase();
      return pack.maps.filter(m => !q || String(m.id).startsWith(q) || (m.dungeon || '').toLowerCase().includes(ql))
        .sort((a, b) => (!a.dungeon - !b.dungeon) || (a.dungeon || '').localeCompare(b.dungeon || '') || a.id - b.id)
        .slice(0, 300).map(m => ({ id: m.id, width: m.width, height: m.height, dungeon: m.dungeon }));
    },
    async getMap(id) {
      const m = byId.get(id); if (!m) return null;
      return { ...decodeRow(m), date: m.date, dungeon: m.dungeon, npcs: pack.npcs[id] || [], scriptedCells: pack.scripted[id] || [] };
    },
    async zoneOf(id) {
      const m = byId.get(id); if (!m) return null;
      const same = pack.maps.filter(x => x.width === m.width && x.height === m.height
        && (m.dungeon ? x.dungeon === m.dungeon : !x.dungeon && subarea(x) === subarea(m))).slice(0, 80);
      return { zone: m.dungeon ? 'Mazmorra ' + m.dungeon : 'Subzona ' + subarea(m), maps: same.map(decodeRow) };
    },
    async npcTemplates() { return pack.npcTemplates; },
    async saveServerSide() { throw new Error('Modo sin conexión: guarda el mapa como archivo y pásaselo a quien tenga el servidor.'); },
  };
}

function dbSource(db) {
  return {
    offline: false,
    async listMaps(q) {
      const where = q ? 'WHERE m.id LIKE ? OR d.dungeon LIKE ?' : '';
      const [rows] = await db.query(`SELECT m.id, m.width, m.heigth AS height, d.dungeon FROM maps m LEFT JOIN dream_dungeon_maps d ON d.map_id = m.id ${where} ORDER BY d.dungeon IS NULL, d.dungeon, m.id LIMIT 300`, q ? [q + '%', '%' + q + '%'] : []);
      return rows;
    },
    async getMap(id) {
      const [[m]] = await db.query('SELECT id, width, heigth AS height, `key`, mapData, places, date FROM maps WHERE id = ?', [id]);
      if (!m) return null;
      const [npcs] = await db.query('SELECT npcid, cellid, orientation FROM npcs WHERE mapid = ?', [id]);
      const [scripted] = await db.query('SELECT DISTINCT CellID AS cell FROM scripted_cells WHERE MapID = ?', [id]).catch(() => [[]]);
      const [[dg]] = await db.query('SELECT dungeon FROM dream_dungeon_maps WHERE map_id = ?', [id]).catch(() => [[null]]);
      return { ...decodeRow(m), date: m.date, dungeon: dg ? dg.dungeon : null, npcs, scriptedCells: scripted.map(s => s.cell) };
    },
    async zoneOf(id) {
      const [[m]] = await db.query('SELECT id, width, heigth AS height, mappos FROM maps WHERE id = ?', [id]);
      if (!m) return null;
      const [[dg]] = await db.query('SELECT dungeon FROM dream_dungeon_maps WHERE map_id = ?', [id]).catch(() => [[null]]);
      const subarea = (m.mappos || '').split(',')[2];
      const [rows] = dg
        ? await db.query('SELECT m.id, m.width, m.heigth AS height, m.`key`, m.mapData, m.places FROM maps m JOIN dream_dungeon_maps d ON d.map_id = m.id WHERE d.dungeon = ? AND m.width = ? AND m.heigth = ? LIMIT 80', [dg.dungeon, m.width, m.height])
        : await db.query("SELECT id, width, heigth AS height, `key`, mapData, places FROM maps WHERE SUBSTRING_INDEX(mappos, ',', -1) = ? AND width = ? AND heigth = ? LIMIT 80", [subarea, m.width, m.height]);
      const maps = rows.map(r => { try { return decodeRow(r); } catch (e) { return null; } }).filter(x => x && x.cells.length);
      return { zone: dg ? 'Mazmorra ' + dg.dungeon : 'Subzona ' + subarea, maps };
    },
    async npcTemplates() { const [rows] = await db.query('SELECT id, gfxID FROM npc_template ORDER BY id'); return rows; },
    /** Casillas de combate y NPC: los envía el servidor de juego, así que funcionan sin tocar el cliente. */
    async saveServerSide(id, body) {
      const places = C.encodePlaces(body.places[0] || [], body.places[1] || []);
      await db.query('UPDATE maps SET places = ? WHERE id = ?', [places, id]);
      await db.query('DELETE FROM npcs WHERE mapid = ?', [id]);
      for (const n of body.npcs || [])
        await db.query('INSERT INTO npcs (mapid, npcid, cellid, orientation, isMovable) VALUES (?, ?, ?, ?, 0)', [id, n.npcid, n.cellid, n.orientation | 0]);
      return { ok: true, places };
    },
  };
}

async function openSource() {
  if (process.env.OFFLINE !== '1') {
    try {
      const mysql = require('mysql2/promise');
      const db = mysql.createPool({ host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'aegnor_game', connectionLimit: 4 });
      await db.query('SELECT 1');
      console.log('Conectado a la base de datos aegnor_game.');
      return dbSource(db);
    } catch (e) {
      console.log('Sin base de datos (' + (e.code || e.message) + '): modo sin conexión.');
    }
  }
  if (!fs.existsSync(PACK)) { console.error('Falta ' + PACK + ' (genéralo con pack.js).'); process.exit(1); }
  return packSource();
}

// ------------------------------------------------------------------ http
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

openSource().then(src => {
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      let m;
      if (p === '/api/info') return send(res, 200, { offline: src.offline });
      if (p === '/api/maps') return send(res, 200, await src.listMaps(url.searchParams.get('q') || ''));
      if (p === '/api/npcs') return send(res, 200, await src.npcTemplates());
      if ((m = p.match(/^\/api\/zone\/(\d+)$/))) { const z = await src.zoneOf(+m[1]); return z ? send(res, 200, z) : send(res, 404, { error: 'mapa no encontrado' }); }
      if ((m = p.match(/^\/api\/map\/(\d+)$/))) {
        if (req.method === 'GET') { const map = await src.getMap(+m[1]); return map ? send(res, 200, map) : send(res, 404, { error: 'mapa no encontrado' }); }
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk;
          return send(res, 200, await src.saveServerSide(+m[1], JSON.parse(body)));
        }
      }
      if (p.startsWith('/assets/')) return serveStatic(res, path.join(__dirname, 'assets', path.normalize(p.slice(8))), !p.endsWith('index.json'));
      return serveStatic(res, path.join(__dirname, 'public', p === '/' ? 'index.html' : path.normalize(p)));
    } catch (e) {
      console.error(e);
      send(res, 500, { error: String(e.message || e) });
    }
  }).listen(PORT, '127.0.0.1', () => console.log('Editor de mapas en http://localhost:' + PORT + (src.offline ? ' (sin conexión)' : '')));
});
