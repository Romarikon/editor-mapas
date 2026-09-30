// Editor de mapas — backend local. Uso: node server.js  →  http://localhost:4600
// Con base de datos (aegnor_game en 127.0.0.1:3306) lee y guarda mapas, casillas de combate y NPC.
// Sin base de datos (o con OFFLINE=1) usa data/maps-pack.json (lo genera pack.js) y no guarda en servidor.
const http = require('http'), fs = require('fs'), path = require('path');
const C = require('./public/mapcodec.js');

const X = require('./swfmap.js');
const PORT = +process.env.PORT || 4600;
// carpeta data/maps del cliente donde se escriben los SWF exportados
const CLIENT_MAPS = process.env.CLIENT_MAPS || 'F:/Dofus_Dual/clients/Retro-1.43.7/resources/app/retroclient/data/maps';
const NEW_MAP_MIN = 30000, NEW_MAP_MAX = 32767; // rango propio para mapas nuevos (el servidor usa short)
// Temas oscuros para la transformación "pesadilla": subzonas reales del juego (nombres del lang maps_es del cliente)
const THEMES = {
  cementerio: { name: 'Cementerio', subareas: [6, 7, 59, 61, 230, 449, 467, 499, 500] },
  brakmar: { name: 'Brakmar', subareas: [53, 72, 75, 280, 338, 492] },
  pantano: { name: 'Pantano', subareas: [31, 232, 233, 457] },
  devastado: { name: 'Tierras devastadas', subareas: [71, 275, 168, 455] },
};
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
      // pack nuevo: [celda, acción, evento, args]; pack antiguo: solo celdas
      const rows = (pack.scripted[id] || []).map(s => Array.isArray(s) ? { cell: s[0], action: s[1], event: s[2], args: s[3] } : { cell: s, action: -1 });
      const { exits, other } = parseExits(rows);
      return { ...decodeRow(m), date: m.date, dungeon: m.dungeon, npcs: pack.npcs[id] || [],
               meta: { mappos: m.mappos, bgID: m.bgID | 0, musicID: m.musicID | 0, ambianceID: m.ambianceID | 0, outDoor: m.outDoor | 0, capabilities: m.capabilities | 0 },
               scriptedCells: [...new Set(rows.map(r => r.cell))], exits, otherActions: other };
    },
    async neighbors(id, pos) {
      const m = pos ? { mappos: pos } : byId.get(id); if (!m) return null;
      const [x, y, sub] = String(m.mappos || '').split(',').map(Number), out = {};
      for (const [side, dx, dy] of [['top', 0, -1], ['bottom', 0, 1], ['left', -1, 0], ['right', 1, 0]])
        out[side] = pack.maps.filter(r => r.id !== id && String(r.mappos || '').startsWith(`${x + dx},${y + dy},`))
          .map(r => ({ id: r.id, width: r.width, height: r.height, subarea: +String(r.mappos).split(',')[2] }))
          .sort((a, b) => (b.subarea === sub) - (a.subarea === sub) || a.id - b.id);
      return out;
    },
    async zoneOf(id) {
      const m = byId.get(id); if (!m) return null;
      const same = pack.maps.filter(x => x.width === m.width && x.height === m.height
        && (m.dungeon ? x.dungeon === m.dungeon : !x.dungeon && subarea(x) === subarea(m))).slice(0, 80);
      return { zone: m.dungeon ? 'Mazmorra ' + m.dungeon : 'Subzona ' + subarea(m), maps: same.map(decodeRow) };
    },
    async npcTemplates() { return pack.npcTemplates; },
    async theme(key, w, h) {
      const t = THEMES[key]; if (!t) return null;
      const set = new Set(t.subareas.map(String));
      const maps = pack.maps.filter(m => m.width === w && m.height === h && set.has(String(m.mappos || '').split(',')[2])).slice(0, 150);
      return { key, name: t.name, maps: maps.map(m => ({ ...decodeRow(m), bgID: m.bgID | 0 })) };
    },
    async saveServerSide() { throw new Error('Modo sin conexión: guarda el mapa como archivo y pásaselo a quien tenga el servidor.'); },
    async exportMap() { throw new Error('Modo sin conexión: guarda el mapa como archivo; la exportación al juego se hace en el PC del servidor.'); },
  };
}

/** Salidas = celdas con acción 0 (teletransporte) al pisar (evento 1), argumentos "mapa,celda". */
function parseExits(rows) {
  const exits = [], other = [];
  for (const r of rows) {
    const [map, cell] = String(r.args || '').split(',').map(Number);
    if (r.action === 0 && r.event === 1 && map) exits.push({ cell: r.cell, map, destCell: cell | 0 });
    else other.push({ cell: r.cell, action: r.action, args: r.args });
  }
  return { exits, other };
}

async function saveExits(db, id, exits, reverse) {
  if (!exits) return;
  await db.query('DELETE FROM scripted_cells WHERE MapID = ? AND ActionID = 0 AND EventID = 1', [id]);
  for (const e of exits)
    await db.query('INSERT INTO scripted_cells (MapID, CellID, ActionID, EventID, ActionsArgs, Conditions) VALUES (?, ?, 0, 1, ?, \'-1\')', [id, e.cell, e.map + ',' + e.destCell]);
  for (const r of reverse || []) { // la vuelta, en el mapa vecino
    await db.query('DELETE FROM scripted_cells WHERE MapID = ? AND CellID = ? AND ActionID = 0 AND EventID = 1', [r.map, r.cell]);
    await db.query('INSERT INTO scripted_cells (MapID, CellID, ActionID, EventID, ActionsArgs, Conditions) VALUES (?, ?, 0, 1, ?, \'-1\')', [r.map, r.cell, id + ',' + r.destCell]);
  }
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
      const [[m]] = await db.query('SELECT id, width, heigth AS height, `key`, mapData, places, date, mappos, bgID, musicID, ambianceID, outDoor, capabilities FROM maps WHERE id = ?', [id]);
      if (!m) return null;
      m.meta = { mappos: m.mappos, bgID: m.bgID, musicID: m.musicID, ambianceID: m.ambianceID, outDoor: m.outDoor, capabilities: m.capabilities };
      const [npcs] = await db.query('SELECT npcid, cellid, orientation FROM npcs WHERE mapid = ?', [id]);
      const [scripted] = await db.query('SELECT CellID AS cell, ActionID AS action, EventID AS event, ActionsArgs AS args FROM scripted_cells WHERE MapID = ?', [id]).catch(() => [[]]);
      const [[dg]] = await db.query('SELECT dungeon FROM dream_dungeon_maps WHERE map_id = ?', [id]).catch(() => [[null]]);
      const { exits, other } = parseExits(scripted);
      return { ...decodeRow(m), date: m.date, meta: m.meta, dungeon: dg ? dg.dungeon : null, npcs,
               scriptedCells: [...new Set(scripted.map(s => s.cell))], exits, otherActions: other };
    },
    /** Mapas vecinos por coordenadas del mundo (mappos x,y): arriba y-1, abajo y+1, izquierda x-1, derecha x+1. */
    async neighbors(id, pos) {
      let m = pos ? { mappos: pos } : null;
      if (!m) [[m]] = await db.query('SELECT mappos FROM maps WHERE id = ?', [id]);
      if (!m) return null;
      const [x, y, sub] = String(m.mappos || '').split(',').map(Number);
      const out = {};
      for (const [side, dx, dy] of [['top', 0, -1], ['bottom', 0, 1], ['left', -1, 0], ['right', 1, 0]]) {
        const [rows] = await db.query("SELECT id, width, heigth AS height, mappos FROM maps WHERE mappos LIKE ? AND id <> ?", [`${x + dx},${y + dy},%`, id]);
        out[side] = rows.map(r => ({ id: r.id, width: r.width, height: r.height, subarea: +String(r.mappos).split(',')[2] }))
          .sort((a, b) => (b.subarea === sub) - (a.subarea === sub) || a.id - b.id);
      }
      return out;
    },
    /**
     * Exporta al juego: SWF del mapa (sin cifrar) en la carpeta del cliente + fila de la base (mapData, clave vacía,
     * fecha nueva, casillas de combate, metadatos) + NPC. id null = mapa nuevo en el rango 30000+.
     * Verifica leyendo el SWF escrito antes de tocar la base.
     */
    async exportMap(body) {
      const cells = body.cells, w = body.width, h = body.height;
      if (!Array.isArray(cells) || cells.length !== w * h + (w - 1) * (h - 1)) throw new Error('número de celdas incorrecto para ' + w + 'x' + h);
      const meta = body.meta || {};
      let id = body.id, isNew = !id;
      if (isNew) {
        const [[r]] = await db.query('SELECT MAX(id) AS m FROM maps WHERE id BETWEEN ? AND ?', [NEW_MAP_MIN, NEW_MAP_MAX]);
        id = r.m ? r.m + 1 : NEW_MAP_MIN;
        if (id > NEW_MAP_MAX) throw new Error('no quedan ids libres para mapas nuevos');
      }
      const date = X.mapDate();
      const mapData = C.encodeCells(cells);
      const places = C.encodePlaces(body.places[0] || [], body.places[1] || []);
      const files = fs.readdirSync(CLIENT_MAPS).filter(f => /^\d+_\d+X?\.swf$/.test(f));
      const template = path.join(CLIENT_MAPS, files.find(f => f.startsWith(id + '_')) || files[0]);
      const swf = X.buildMapSwf(template, { id, width: w, height: h, backgroundNum: meta.bgID | 0, ambianceId: meta.ambianceID | 0,
        musicId: meta.musicID | 0, outdoor: !!+meta.outDoor, capabilities: meta.capabilities | 0, mapData });
      const file = path.join(CLIENT_MAPS, `${id}_${date}.swf`);
      fs.writeFileSync(file, swf);
      const back = X.readMapSwf(file);
      if (back.mapData !== mapData || back.id !== id) { fs.rmSync(file, { force: true }); throw new Error('verificación del SWF fallida; no se ha tocado la base'); }

      if (isNew) {
        await db.query('INSERT INTO maps (id, date, width, heigth, places, `key`, mapData, monsters, capabilities, mappos, numgroup, minSize, fixSize, maxSize, forbidden, sniffed, musicID, ambianceID, bgID, outDoor, maxMerchant) VALUES (?, ?, ?, ?, ?, \'\', ?, \'\', ?, ?, 0, 1, -1, 8, \'\', 0, ?, ?, ?, ?, 5)',
          [id, date, w, h, places, mapData, meta.capabilities | 0, meta.mappos || '0,0,0', meta.musicID | 0, meta.ambianceID | 0, meta.bgID | 0, +meta.outDoor ? 1 : 0]);
      } else {
        await db.query('UPDATE maps SET date = ?, width = ?, heigth = ?, places = ?, `key` = \'\', mapData = ?, capabilities = ?, mappos = COALESCE(?, mappos), musicID = ?, ambianceID = ?, bgID = ?, outDoor = ? WHERE id = ?',
          [date, w, h, places, mapData, meta.capabilities | 0, meta.mappos || null, meta.musicID | 0, meta.ambianceID | 0, meta.bgID | 0, +meta.outDoor ? 1 : 0, id]);
      }
      await db.query('DELETE FROM npcs WHERE mapid = ?', [id]);
      for (const n of body.npcs || [])
        await db.query('INSERT INTO npcs (mapid, npcid, cellid, orientation, isMovable) VALUES (?, ?, ?, ?, 0)', [id, n.npcid, n.cellid, n.orientation | 0]);
      await saveExits(db, id, body.exits, body.reverse);
      const touched = [...new Set((body.reverse || []).map(r => r.map))];
      return { ok: true, id, date, isNew, file: path.basename(file), reload: 'RECARGARMAPA ' + id, alsoReload: touched };
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
    /** Mapas de un tema oscuro (mismo tamaño) para aprender su paleta. */
    async theme(key, w, h) {
      const t = THEMES[key]; if (!t) return null;
      const [rows] = await db.query(`SELECT id, width, heigth AS height, \`key\`, mapData, places, bgID FROM maps WHERE SUBSTRING_INDEX(mappos, ',', -1) IN (${t.subareas.map(() => '?').join(',')}) AND width = ? AND heigth = ? LIMIT 150`, [...t.subareas.map(String), w, h]);
      return { key, name: t.name, maps: rows.map(r => { try { return { ...decodeRow(r), bgID: r.bgID | 0 }; } catch (e) { return null; } }).filter(Boolean) };
    },
    /** Casillas de combate y NPC: los envía el servidor de juego, así que funcionan sin tocar el cliente. */
    async saveServerSide(id, body) {
      const places = C.encodePlaces(body.places[0] || [], body.places[1] || []);
      await db.query('UPDATE maps SET places = ? WHERE id = ?', [places, id]);
      await db.query('DELETE FROM npcs WHERE mapid = ?', [id]);
      for (const n of body.npcs || [])
        await db.query('INSERT INTO npcs (mapid, npcid, cellid, orientation, isMovable) VALUES (?, ?, ?, ?, 0)', [id, n.npcid, n.cellid, n.orientation | 0]);
      await saveExits(db, id, body.exits, body.reverse);
      return { ok: true, places, alsoReload: [...new Set((body.reverse || []).map(r => r.map))] };
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
      if (p === '/api/themes') return send(res, 200, Object.entries(THEMES).map(([key, t]) => ({ key, name: t.name })));
      if ((m = p.match(/^\/api\/theme\/(\w+)$/))) {
        const t = await src.theme(m[1], +url.searchParams.get('w') || 15, +url.searchParams.get('h') || 17);
        return t ? send(res, 200, t) : send(res, 404, { error: 'tema desconocido' });
      }
      if (p === '/api/export' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        return send(res, 200, await src.exportMap(JSON.parse(body)));
      }
      if (p === '/api/maps') return send(res, 200, await src.listMaps(url.searchParams.get('q') || ''));
      if (p === '/api/npcs') return send(res, 200, await src.npcTemplates());
      if ((m = p.match(/^\/api\/neighbors\/(\d+)$/))) { const n = await src.neighbors(+m[1], url.searchParams.get('pos')); return n ? send(res, 200, n) : send(res, 404, { error: 'mapa no encontrado' }); }
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
