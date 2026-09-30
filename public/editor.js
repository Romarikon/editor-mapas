// Editor de mapas — frontend. Render isométrico con las mismas reglas que ank.battlefield.MapHandler del cliente.
(() => {
  const C = window.MapCodec;
  const $ = s => document.querySelector(s);
  const cv = $('#cv'), ctx = cv.getContext('2d');

  const S = {
    index: { g: {}, o: {} }, imgs: new Map(),
    map: null, cells: [], pos: [], places: [new Set(), new Set()], npcs: [], npcTemplates: [],
    mode: 'view', tile: null, npcTemplate: null, hover: -1, dirty: false,
    view: { scale: 1, ox: 40, oy: 40 }, pan: null, space: false,
    tool: 'brush', drag: null, region: null, stats: null, zoneTiles: null,
  };

  // ---------------------------------------------------------------- historial (deshacer / rehacer)
  const H = { undo: [], redo: [] };
  const snapshot = () => JSON.stringify({ cells: S.cells, places: [[...S.places[0]], [...S.places[1]]], npcs: S.npcs, exits: S.exits });
  function pushHistory() { if (!S.map) return; H.undo.push(snapshot()); if (H.undo.length > 150) H.undo.shift(); H.redo = []; }
  function restore(snap) {
    const o = JSON.parse(snap);
    S.cells = o.cells; S.places = [new Set(o.places[0]), new Set(o.places[1])]; S.npcs = o.npcs; S.exits = o.exits;
    S.pos = C.cellPositions(S.cells, S.map.width); S.dirty = true; S.sel = null; showSelection(); renderExitList(); render();
  }
  function undo() { if (!H.undo.length) return status('Nada que deshacer.'); H.redo.push(snapshot()); restore(H.undo.pop()); status(`Deshecho (${H.undo.length} más).`); }
  function redo() { if (!H.redo.length) return status('Nada que rehacer.'); H.undo.push(snapshot()); restore(H.redo.pop()); status('Rehecho.'); }

  // ---------------------------------------------------------------- carga
  async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); }

  async function init() {
    const info = await api('/api/info').catch(() => ({ offline: false }));
    S.online = !info.offline;
    if (info.offline) document.title += ' (sin conexión)';
    S.index = await api('/assets/index.json').catch(() => ({ g: {}, o: {} }));
    S.npcTemplates = await api('/api/npcs').catch(() => []);
    S.stats = await api('/assets/tilestats.json').catch(() => null);
    S.tags = await api('/api/tags').catch(() => ({ o: {}, g: {} }));
    fillCategories();
    await loadMapList('');
    buildPalette();
    buildNpcList();
    resize();
    status(`${Object.keys(S.index.g).length} suelos y ${Object.keys(S.index.o).length} objetos cargados`);
  }

  async function loadMapList(q) {
    const rows = await api('/api/maps?q=' + encodeURIComponent(q));
    $('#mapList').innerHTML = rows.map(r => `<div class="mapItem" data-id="${r.id}"><span>${r.id}</span><small>${r.dungeon || ''} ${r.width}×${r.height}</small></div>`).join('');
  }

  /** Pone un mapa en el editor. fromServer=false para mapas nuevos o abiertos de archivo (no se guardan en la base). */
  function useMap(m, fromServer) {
    S.map = m; S.cells = m.cells; S.pos = C.cellPositions(m.cells, m.width);
    S.places = [new Set(m.places[0]), new Set(m.places[1])];
    S.npcs = (m.npcs || []).map(n => ({ npcid: n.npcid, cellid: n.cellid, orientation: n.orientation }));
    S.exits = (m.exits || []).map(e => ({ cell: e.cell, map: e.map, destCell: e.destCell }));
    S.reverse = [];
    S.dirty = !fromServer; S.sel = null; S.region = null; S.zoneTiles = null; H.undo = []; H.redo = []; showSelection();
    S.original = { cells: m.cells.map(c => ({ ...c })), places: m.places };
    S.generated = !fromServer; S.zone = null;
    $('#btnSave').disabled = !fromServer || !S.online;
    $('#btnExport').disabled = !S.online;
    fillMeta(m.meta || { mappos: '0,0,0', bgID: 0, musicID: 0, ambianceID: 0, outDoor: 1, capabilities: 0 });
    document.querySelectorAll('.mapItem').forEach(e => e.classList.toggle('sel', +e.dataset.id === m.id));
    fit();
  }

  async function loadMap(id) {
    if (S.dirty && !confirm('Hay cambios sin guardar. ¿Cambiar de mapa?')) return;
    const m = await api('/api/map/' + id);
    useMap(m, true);
    status(`Mapa ${id} ${m.dungeon ? '· ' + m.dungeon : ''} · ${m.width}×${m.height} · ${S.places[0].size}/${S.places[1].size} casillas de combate · ${S.npcs.length} NPC`);
  }

  // ---------------------------------------------------------------- salidas entre mapas
  function renderExitList() {
    const rev = S.reverse.length ? `<p class="pad">Pendiente de guardar: ${S.reverse.length} vuelta(s) en mapas vecinos.</p>` : '';
    $('#exitList').innerHTML = rev + (S.exits.length ? S.exits.map(e =>
      `<div class="exitItem"><span>celda ${e.cell} → mapa <b>${e.map}</b>, celda ${e.destCell}</span><button data-cell="${e.cell}" title="Quitar">✕</button></div>`).join('')
      : '<p class="pad">Este mapa no tiene salidas.</p>');
  }

  /** Celda caminable más cercana a un punto (en píxeles del mapa), opcionalmente filtrada. */
  function nearestCell(cells, pos, x, y, filter = () => true) {
    let best = -1, bd = Infinity;
    cells.forEach((c, i) => { if (!c.active || !c.movement || !filter(i)) return; const d = (pos[i].x - x) ** 2 + (pos[i].y - y) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  }
  const bounds = pos => ({ minX: Math.min(...pos.map(p => p.x)), maxX: Math.max(...pos.map(p => p.x)), minY: Math.min(...pos.map(p => p.y)), maxY: Math.max(...pos.map(p => p.y)) });
  // punto de salida (borde) y de llegada (un poco hacia dentro) de cada lado
  const SIDE = {
    top: b => ({ edge: [(b.minX + b.maxX) / 2, b.minY], inside: [(b.minX + b.maxX) / 2, b.minY + 30] }),
    bottom: b => ({ edge: [(b.minX + b.maxX) / 2, b.maxY], inside: [(b.minX + b.maxX) / 2, b.maxY - 30] }),
    left: b => ({ edge: [b.minX, (b.minY + b.maxY) / 2], inside: [b.minX + 55, (b.minY + b.maxY) / 2] }),
    right: b => ({ edge: [b.maxX, (b.minY + b.maxY) / 2], inside: [b.maxX - 55, (b.minY + b.maxY) / 2] }),
  };
  const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

  async function autoLink() {
    if (!S.map) return;
    const pos = readMeta().mappos;
    const nb = await api(`/api/neighbors/${S.map.id || 0}?pos=${encodeURIComponent(pos)}`);
    pushHistory();
    const mine = bounds(S.pos), made = [];
    S.reverse = [];
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const n = (nb[side] || [])[0];
      if (!n) continue;
      const other = await api('/api/map/' + n.id);
      const opos = C.cellPositions(other.cells, other.width), ob = bounds(opos);
      const me = SIDE[side](mine), them = SIDE[OPPOSITE[side]](ob);
      const exitCell = S.exits.find(e => e.map === n.id)?.cell ?? nearestCell(S.cells, S.pos, ...me.edge);
      const arrive = nearestCell(other.cells, opos, ...them.inside);
      if (exitCell < 0 || arrive < 0) continue;
      S.exits = S.exits.filter(e => e.cell !== exitCell && e.map !== n.id);
      S.exits.push({ cell: exitCell, map: n.id, destCell: arrive });
      if ($('#linkReverse').checked) {
        const theirExit = (other.exits || []).find(e => e.map === S.map.id)?.cell ?? nearestCell(other.cells, opos, ...them.edge);
        const myArrive = nearestCell(S.cells, S.pos, ...me.inside, i => i !== exitCell);
        if (theirExit >= 0 && myArrive >= 0) S.reverse.push({ map: n.id, cell: theirExit, destCell: myArrive });
      }
      made.push(`${side === 'top' ? 'arriba' : side === 'bottom' ? 'abajo' : side === 'left' ? 'izquierda' : 'derecha'} → ${n.id}`);
    }
    S.dirty = true; renderExitList(); render();
    status(made.length ? `Enlazado: ${made.join(', ')}. Guarda o exporta para aplicarlo.` : `No hay mapas vecinos en las coordenadas ${pos} (cámbialas en "Datos del mapa").`);
  }

  // ---------------------------------------------------------------- datos del mapa
  function fillMeta(meta) {
    const f = $('#metaForm'), [x = 0, y = 0, sub = 0] = String(meta.mappos || '0,0,0').split(',');
    f.posX.value = x; f.posY.value = y; f.subarea.value = sub;
    f.bgID.value = meta.bgID | 0; f.musicID.value = meta.musicID | 0; f.ambianceID.value = meta.ambianceID | 0;
    f.capabilities.value = meta.capabilities | 0; f.outDoor.checked = !!+meta.outDoor;
    f.hidden = false;
  }
  function readMeta() {
    const f = $('#metaForm');
    return { mappos: `${f.posX.value | 0},${f.posY.value | 0},${f.subarea.value | 0}`, bgID: f.bgID.value | 0, musicID: f.musicID.value | 0,
             ambianceID: f.ambianceID.value | 0, capabilities: f.capabilities.value | 0, outDoor: f.outDoor.checked ? 1 : 0 };
  }

  // ---------------------------------------------------------------- validación
  function validate() {
    const R = { err: [], warn: [], ok: [] }, w = S.map.width, n = S.cells.length, cells = S.cells;
    if (n !== w * S.map.height + (w - 1) * (S.map.height - 1)) R.err.push(`Número de celdas incorrecto (${n}) para ${w}×${S.map.height}.`);
    const neigh = i => [i - w, i - w + 1, i + w - 1, i + w].filter(j => j >= 0 && j < n);
    // zonas caminables
    const seen = new Uint8Array(n), comps = [];
    cells.forEach((c, s) => {
      if (seen[s] || !c.active || !c.movement) return;
      let size = 0; const st = [s]; seen[s] = 1;
      while (st.length) { const i = st.pop(); size++; for (const j of neigh(i)) if (!seen[j] && cells[j].active && cells[j].movement) { seen[j] = 1; st.push(j); } }
      comps.push(size);
    });
    comps.sort((a, b) => b - a);
    if (!comps.length) R.err.push('No hay ninguna celda caminable.');
    else if (comps.length > 1) R.warn.push(`Hay ${comps.length} zonas caminables separadas (${comps.join(', ')} celdas): algunas no se podrán alcanzar.`);
    else R.ok.push(`Todas las celdas caminables están conectadas (${comps[0]}).`);
    // casillas de combate
    for (const t of [0, 1]) {
      const list = [...S.places[t]], bad = list.filter(i => !cells[i] || !cells[i].movement);
      const name = t ? 'azul' : 'rojo';
      if (!list.length) R.warn.push(`El equipo ${name} no tiene casillas de combate (no se podrá combatir aquí).`);
      else if (list.length < 8) R.warn.push(`El equipo ${name} solo tiene ${list.length} casillas (lo normal son 8).`);
      if (bad.length) R.err.push(`${bad.length} casilla(s) de combate del equipo ${name} están en celdas bloqueadas.`);
    }
    // salidas y NPC
    const blockedExits = (S.map.scriptedCells || []).filter(i => cells[i] && !cells[i].movement);
    if (blockedExits.length) R.err.push(`${blockedExits.length} celda(s) con acción (salidas, teletransportes) están bloqueadas: ${blockedExits.join(', ')}.`);
    const npcBad = S.npcs.filter(p => !cells[p.cellid] || !cells[p.cellid].active);
    if (npcBad.length) R.warn.push(`${npcBad.length} NPC en celdas inactivas.`);
    // sprites inexistentes
    const miss = new Set();
    cells.forEach(c => {
      if (!c.active) return;
      if (c.layerGroundNum && !S.index.g[c.layerGroundNum]) miss.add('suelo ' + c.layerGroundNum);
      for (const o of [c.layerObject1Num, c.layerObject2Num]) if (o && !S.index.o[o]) miss.add('objeto ' + o);
    });
    if (miss.size) R.warn.push(`Tiles sin sprite (saldrán vacíos): ${[...miss].slice(0, 10).join(', ')}${miss.size > 10 ? '…' : ''}.`);
    const seeThrough = cells.filter(c => c.active && !c.movement && c.layerObject2Num && c.lineOfSight).length;
    if (seeThrough) R.ok.push(`${seeThrough} obstáculo(s) dejan ver a través (correcto para objetos bajos; revisa si alguno debería tapar la visión).`);
    return R;
  }

  // ---------------------------------------------------------------- exportar al juego
  function openExport() {
    if (!S.map) { status('No hay ningún mapa abierto.'); return; }
    const R = validate();
    const li = (cls, arr) => arr.map(t => `<li class="${cls}">${t}</li>`).join('');
    $('#exportReport').innerHTML = `<ul>${li('err', R.err)}${li('warn', R.warn)}${li('ok', R.ok)}</ul>`
      + (R.err.length ? '<p class="err">Corrige los errores antes de exportar.</p>'
        : '<p>Se escribirá el SWF del mapa en la carpeta del cliente y la fila en la base. Luego, en el juego: <code>RECARGARMAPA id</code>.</p>');
    const canOverwrite = !!S.map.id;
    $('#expOverwrite').hidden = !canOverwrite; $('#expId').textContent = S.map.id || '';
    $('#expOverwrite').disabled = $('#expNew').disabled = R.err.length > 0;
    $('#exportDlg').showModal();
  }

  async function doExport(asNew) {
    $('#exportDlg').close();
    status('Exportando…');
    const body = { id: asNew ? null : S.map.id, width: S.map.width, height: S.map.height, cells: S.cells,
                   places: [[...S.places[0]], [...S.places[1]]], npcs: S.npcs, meta: readMeta(), exits: S.exits, reverse: S.reverse };
    const r = await api('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.map.id = r.id; S.map.date = r.date; S.map.meta = body.meta;
    S.generated = false; S.dirty = false; S.reverse = []; renderExitList(); $('#btnSave').disabled = false;
    await loadMapList($('#mapSearch').value.trim());
    const also = (r.alsoReload || []).map(id => 'RECARGARMAPA ' + id);
    status(`${r.isNew ? 'Mapa nuevo ' + r.id + ' creado' : 'Mapa ' + r.id + ' actualizado'} (${r.file}). En el juego: ${[r.reload, ...also].join(', ')}`);
    alert(`${r.isNew ? 'Creado el mapa nuevo ' + r.id : 'Actualizado el mapa ' + r.id}.\n\nFichero del cliente: ${r.file}\n\nPara verlo sin reiniciar, en la consola de administración:\n${[r.reload, ...also].join('\n')}${r.isNew ? '\n\nPara ir a él: TP ' + r.id + ' <celda>' : ''}`);
  }

  // ---------------------------------------------------------------- mapa nuevo y archivos
  function newMap() {
    if (S.dirty && !confirm('Hay cambios sin guardar. ¿Crear un mapa nuevo?')) return;
    const size = prompt('Tamaño del mapa (ancho x alto). El estándar de Dofus es 15x17:', '15x17');
    if (!size) return;
    const [w, h] = size.toLowerCase().split(/[x×, ]+/).map(Number);
    if (!(w >= 3 && h >= 3 && w <= 60 && h <= 60)) { alert('Tamaño no válido.'); return; }
    const defaultGround = S.tile && S.tile.kind === 'g' ? S.tile.num : +(Object.keys(S.index.g)[0] || 0);
    const g = +prompt('Número del tile de suelo para rellenar (elige uno en la paleta de Decorado para que salga aquí):', defaultGround);
    const n = w * h + (w - 1) * (h - 1);
    const cells = Array.from({ length: n }, () => ({
      active: true, lineOfSight: true, layerGroundRot: 0, groundLevel: 7, movement: 4, layerGroundNum: g || 0, groundSlope: 1,
      layerGroundFlip: false, layerObject1Num: 0, layerObject1Rot: 0, layerObject1Flip: false, layerObject2Flip: false,
      layerObject2Interactive: false, layerObject2Num: 0 }));
    useMap({ id: null, width: w, height: h, cells, places: [[], []], npcs: [], scriptedCells: [], name: 'Nuevo mapa' }, false);
    status(`Mapa nuevo ${w}×${h} (${n} celdas). Pinta con Decorado; guárdalo con "Guardar archivo".`);
  }

  function saveFile() {
    if (!S.map) { status('No hay ningún mapa abierto.'); return; }
    const name = prompt('Nombre del mapa:', S.map.name || (S.map.id ? 'mapa_' + S.map.id : 'nuevo_mapa'));
    if (!name) return;
    const file = { format: 'dofus-map/1', name, width: S.map.width, height: S.map.height, basedOn: S.map.id || null,
      mapData: C.encodeCells(S.cells), places: C.encodePlaces([...S.places[0]], [...S.places[1]]), npcs: S.npcs, meta: readMeta(), exits: S.exits,
      savedAt: new Date().toISOString() };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
    a.download = name.replace(/[^\w\-áéíóúñ ]+/gi, '_') + '.dmap.json';
    a.click(); URL.revokeObjectURL(a.href);
    S.map.name = name; S.dirty = false;
    status(`Guardado "${a.download}" en tu carpeta de descargas.`);
  }

  async function openFile(f) {
    if (S.dirty && !confirm('Hay cambios sin guardar. ¿Abrir otro mapa?')) return;
    const j = JSON.parse(await f.text());
    if (j.format !== 'dofus-map/1') { alert('No es un archivo de mapa de este editor.'); return; }
    useMap({ id: null, name: j.name, width: j.width, height: j.height, cells: C.decodeCells(j.mapData),
             places: C.decodePlaces(j.places), npcs: j.npcs || [], scriptedCells: [], basedOn: j.basedOn, meta: j.meta, exits: j.exits || [] }, false);
    S.dirty = false;
    status(`Abierto "${j.name}" (${j.width}×${j.height})${j.basedOn ? ', basado en el mapa ' + j.basedOn : ''}.`);
  }

  // ---------------------------------------------------------------- imágenes
  function img(kind, num, frame) {
    const meta = S.index[kind][num];
    if (!meta) return null;
    const file = frame && meta.frames > 1 ? `${num}_${frame}.svg` : `${num}.svg`;
    const key = kind + '/' + file;
    let im = S.imgs.get(key);
    if (!im) { im = new Image(); im.onload = () => { im.raster = rasterize(im, meta); render(); }; im.src = `/assets/${kind}/${file}`; S.imgs.set(key, im); }
    return im.raster ? { im: im.raster, meta } : null;
  }
  // Un SVG se dibuja lento en canvas: se pasa una vez a bitmap (al doble para que el zoom siga nítido)
  function rasterize(im, meta) {
    const k = 2, c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(meta.w * k)); c.height = Math.max(1, Math.ceil(meta.h * k));
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c;
  }

  // Misma transformación que el cliente: rotación en pasos de 90º y, si es 90/270, escala 51.85% x 192.86%
  function drawTile(kind, num, x, y, rot, flip, frame) {
    if (!num) return;
    const t = img(kind, num, frame);
    if (!t) return;
    ctx.save();
    ctx.translate(x, y);
    if (rot) { ctx.rotate(rot * Math.PI / 2); if (rot % 2) ctx.scale(0.5185, 1.9286); }
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(t.im, -t.meta.tx, -t.meta.ty, t.meta.w, t.meta.h);
    ctx.restore();
  }

  // ---------------------------------------------------------------- selección de sprites (por píxel)
  const alphaCache = new Map(); // imagen -> ImageData para leer la transparencia
  function alphaAt(im, px, py) {
    let data = alphaCache.get(im);
    if (!data) {
      const c = document.createElement('canvas'); c.width = im.naturalWidth || im.width; c.height = im.naturalHeight || im.height;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
      data = x.getImageData(0, 0, c.width, c.height); alphaCache.set(im, data);
    }
    const ix = Math.floor(px), iy = Math.floor(py);
    if (ix < 0 || iy < 0 || ix >= data.width || iy >= data.height) return 0;
    return data.data[(iy * data.width + ix) * 4 + 3];
  }

  // Deshace la transformación de drawTile y mira si el píxel del sprite es opaco
  function hitTile(kind, num, x, y, rot, flip, frame, wx, wy) {
    if (!num) return false;
    const t = img(kind, num, frame);
    if (!t) return false;
    let lx = wx - x, ly = wy - y;
    if (rot) {
      const a = -rot * Math.PI / 2, rx = lx * Math.cos(a) - ly * Math.sin(a), ry = lx * Math.sin(a) + ly * Math.cos(a);
      lx = rx; ly = ry;
      if (rot % 2) { lx /= 0.5185; ly /= 1.9286; }
    }
    if (flip) lx = -lx;
    const u = lx + t.meta.tx, v = ly + t.meta.ty;
    if (u < 0 || v < 0 || u > t.meta.w || v > t.meta.h) return false;
    return alphaAt(t.im, u * (t.im.naturalWidth || t.im.width) / t.meta.w, v * (t.im.naturalHeight || t.im.height) / t.meta.h) > 40;
  }

  /** Sprite visible más arriba bajo el ratón: objetos 2, luego objetos 1, luego suelo (orden inverso al de dibujo). */
  function spriteAt(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    const wx = (clientX - r.left - S.view.ox) / S.view.scale, wy = (clientY - r.top - S.view.oy) / S.view.scale;
    const layers = [
      ['o2', $('#lyO2').checked, c => [c.layerObject2Num, 0, c.layerObject2Flip, 0]],
      ['o1', $('#lyO1').checked, c => [c.layerObject1Num, c.groundSlope === 1 ? c.layerObject1Rot : 0, c.layerObject1Flip, 0]],
      ['g', $('#lyG').checked, c => [c.layerGroundNum, c.groundSlope === 1 ? c.layerGroundRot : 0, c.layerGroundFlip, c.groundSlope !== 1 ? c.groundSlope : 0]],
    ];
    for (const [layer, visible, get] of layers) {
      if (!visible) continue;
      for (let i = S.cells.length - 1; i >= 0; i--) {
        const c = S.cells[i]; if (!c.active) continue;
        const [num, rot, flip, frame] = get(c);
        if (hitTile(layer === 'g' ? 'g' : 'o', num, S.pos[i].x, S.pos[i].y, rot, flip, frame, wx, wy)) return { cell: i, layer, num };
      }
    }
    return null;
  }

  const LAYER_NAMES = { g: 'Suelo', o1: 'Objeto 1 (decorado de suelo)', o2: 'Objeto 2 (objetos altos)' };
  const LAYER_FIELDS = { g: ['layerGroundNum', 'layerGroundFlip'], o1: ['layerObject1Num', 'layerObject1Flip'], o2: ['layerObject2Num', 'layerObject2Flip'] };

  function showSelection() {
    const s = S.sel, has = !!s;
    ['#btnSelDel', '#btnSelFlip', '#btnSelPick'].forEach(b => $(b).disabled = !has);
    if (!has) { $('#selInfo').innerHTML = '<p>Haz clic sobre cualquier sprite del mapa (suelo, decoración, árbol…). Se marca la celda a la que pertenece.</p>'; return; }
    const c = S.cells[s.cell], kind = s.layer === 'g' ? 'g' : 'o';
    $('#selInfo').innerHTML = `<img src="/assets/${kind}/${s.num}.svg">
      <table><tr><td>Celda</td><td>${s.cell}</td></tr><tr><td>Capa</td><td>${LAYER_NAMES[s.layer]}</td></tr>
      <tr><td>Tile</td><td>${s.num}</td></tr><tr><td>Volteado</td><td>${c[LAYER_FIELDS[s.layer][1]] ? 'sí' : 'no'}</td></tr>
      <tr><td>Celda</td><td>${c.movement ? 'caminable' : 'bloqueada'}${c.lineOfSight ? '' : ', sin visión'}, altura ${c.groundLevel}</td></tr>
      <tr><td>Roles</td><td>${(tagOf(kind, s.num).r || []).join(', ') || '—'}</td></tr></table>
      <label class="field pad">Etiquetas (separadas por comas)${tagOf(kind, s.num).auto ? ' · automáticas, corrígelas' : ''}
        <input id="selTags" value="${(tagOf(kind, s.num).t || []).join(', ')}"></label>
      <div class="row btns"><button id="btnSaveTags">Guardar etiquetas</button></div>`;
    $('#btnSaveTags').onclick = () => saveTags(kind, s.num, $('#selTags').value).catch(err => status('Error: ' + err.message));
  }
  const tagOf = (kind, num) => ((S.tags || {})[kind] || {})[num] || {};
  async function saveTags(kind, num, text) {
    const tags = text.split(',').map(t => t.trim()).filter(Boolean);
    const r = await api('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id: num, tags }) });
    S.tags[kind][num] = r.tile; showSelection();
    status(`Etiquetas del tile ${num} guardadas: ${tags.join(', ') || '(ninguna)'} · roles: ${(r.tile.r || []).join(', ') || '—'}.`);
  }
  function deleteSelection() {
    if (!S.sel) return;
    pushHistory();
    S.cells[S.sel.cell][LAYER_FIELDS[S.sel.layer][0]] = 0;
    status(`Eliminado el tile ${S.sel.num} (${LAYER_NAMES[S.sel.layer]}) de la celda ${S.sel.cell}`);
    S.sel = null; S.dirty = true; showSelection(); render();
  }
  function flipSelection() {
    if (!S.sel) return;
    pushHistory();
    const f = LAYER_FIELDS[S.sel.layer][1]; S.cells[S.sel.cell][f] = !S.cells[S.sel.cell][f];
    S.dirty = true; showSelection(); render();
  }

  // ---------------------------------------------------------------- render
  function diamond(x, y) {
    ctx.beginPath();
    ctx.moveTo(x, y - C.CELL_HALF_HEIGHT); ctx.lineTo(x + C.CELL_HALF_WIDTH, y);
    ctx.lineTo(x, y + C.CELL_HALF_HEIGHT); ctx.lineTo(x - C.CELL_HALF_WIDTH, y); ctx.closePath();
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!S.map) return;
    const { scale, ox, oy } = S.view;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, ox * dpr, oy * dpr);
    const cells = S.cells, pos = S.pos;

    // fondo: es un símbolo del fichero de suelos colocado en el origen del mapa (MapHandler del cliente)
    const bg = +$('#metaForm').bgID.value;
    if (bg && $('#lyBg').checked) drawTile('g', bg, 0, 0, 0, false);

    if ($('#lyG').checked)
      cells.forEach((c, i) => c.active && drawTile('g', c.layerGroundNum, pos[i].x, pos[i].y,
        c.groundSlope === 1 ? c.layerGroundRot : 0, c.layerGroundFlip, c.groundSlope !== 1 ? c.groundSlope : 0));
    if ($('#lyO1').checked)
      cells.forEach((c, i) => c.active && drawTile('o', c.layerObject1Num, pos[i].x, pos[i].y,
        c.groundSlope === 1 ? c.layerObject1Rot : 0, c.layerObject1Flip));
    if ($('#lyO2').checked)
      cells.forEach((c, i) => c.active && drawTile('o', c.layerObject2Num, pos[i].x, pos[i].y, 0, c.layerObject2Flip));

    // superposiciones según el modo
    cells.forEach((c, i) => {
      if (!c.active) return;
      const { x, y } = pos[i];
      if ($('#lyGrid').checked || S.mode === 'cells') {
        diamond(x, y);
        if (S.mode === 'cells') {
          ctx.fillStyle = !c.movement ? 'rgba(224,85,69,.38)' : !c.lineOfSight ? 'rgba(20,20,20,.5)' : 'rgba(90,200,120,.12)';
          ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,240,200,.18)'; ctx.lineWidth = 1 / S.view.scale; ctx.stroke();
      }
      if (S.mode === 'fight' || S.mode === 'view') {
        const team = S.places[0].has(i) ? 0 : S.places[1].has(i) ? 1 : -1;
        if (team >= 0) { diamond(x, y); ctx.fillStyle = team ? 'rgba(74,143,224,.55)' : 'rgba(224,85,69,.55)'; ctx.fill(); }
      }
    });
    if (S.mode === 'exits' || S.mode === 'view') {
      for (const e of S.exits || []) {
        const p = pos[e.cell]; if (!p) continue;
        diamond(p.x, p.y); ctx.fillStyle = 'rgba(80,190,255,.55)'; ctx.fill();
        if (S.mode === 'exits') {
          ctx.fillStyle = '#0d2233'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('→' + e.map, p.x, p.y + 3);
        }
      }
    }
    for (const n of S.npcs) {
      const p = pos[n.cellid]; if (!p) continue;
      ctx.fillStyle = '#d8893c'; ctx.beginPath(); ctx.arc(p.x, p.y - 18, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1206'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', p.x, p.y - 15);
    }
    if (S.region) for (const i of S.region) { if (!pos[i]) continue; diamond(pos[i].x, pos[i].y); ctx.fillStyle = 'rgba(120,200,255,.28)'; ctx.fill(); }
    if (S.drag) {
      const d = S.drag; ctx.setLineDash([6 / S.view.scale, 4 / S.view.scale]); ctx.strokeStyle = d.purpose === 'region' ? '#7cc8ff' : '#ffd27a';
      ctx.lineWidth = 1.5 / S.view.scale; ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)); ctx.setLineDash([]);
    }
    if (S.sel && pos[S.sel.cell]) {
      diamond(pos[S.sel.cell].x, pos[S.sel.cell].y);
      ctx.fillStyle = 'rgba(255,210,122,.35)'; ctx.fill();
      ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 3 / S.view.scale; ctx.stroke();
    }
    if (S.hover >= 0 && pos[S.hover]) {
      diamond(pos[S.hover].x, pos[S.hover].y);
      ctx.strokeStyle = '#ffd27a'; ctx.lineWidth = 2 / S.view.scale; ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- selección de celda
  function cellAt(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    const x = (clientX - r.left - S.view.ox) / S.view.scale, y = (clientY - r.top - S.view.oy) / S.view.scale;
    for (let i = S.cells.length - 1; i >= 0; i--) {
      if (!S.cells[i].active) continue;
      const p = S.pos[i];
      if (Math.abs(x - p.x) / C.CELL_HALF_WIDTH + Math.abs(y - p.y) / C.CELL_HALF_HEIGHT <= 1) return i;
    }
    return -1;
  }

  function applyAt(i, e) {
    if (i < 0) return;
    const c = S.cells[i], erase = e.button === 2;
    switch (S.mode) {
      case 'paint': {
        const layer = $('#paintLayer').value;
        if (S.tool === 'pick' || e.altKey) { pickTile(i, layer); return; }
        if (!S.tile && !erase) return;
        const num = erase ? 0 : S.tile.num, flip = $('#paintFlip').checked;
        if (S.tool === 'fill') floodFill(i, layer, num, flip);
        else if (S.tool === 'brush') for (const j of brushCells(i, +$('#brushSize').value)) paintCell(j, layer, num, flip);
        else return; // el rectángulo se aplica al soltar el ratón
        break;
      }
      case 'cells':
        if (e.altKey) { c.groundLevel = Math.max(0, Math.min(15, c.groundLevel + (erase ? -1 : 1))); S.pos = C.cellPositions(S.cells, S.map.width); }
        else if (e.shiftKey) c.lineOfSight = !c.lineOfSight;
        else if (!erase) c.movement = c.movement ? 0 : 4;
        break;
      case 'fight':
        S.places[0].delete(i); S.places[1].delete(i);
        if (!erase) S.places[e.shiftKey ? 1 : 0].add(i);
        break;
      case 'exits': {
        const cur = S.exits.find(x => x.cell === i);
        S.exits = S.exits.filter(x => x.cell !== i);
        if (!erase) {
          const txt = prompt(`Salida desde la celda ${i}. Destino "mapa,celda" (vacío = quitar):`, cur ? `${cur.map},${cur.destCell}` : '');
          if (txt === null) { if (cur) S.exits.push(cur); return; }
          const [mp, cl] = txt.split(/[,; ]+/).map(Number);
          if (mp) S.exits.push({ cell: i, map: mp, destCell: cl | 0 });
        }
        renderExitList();
        break;
      }
      case 'npc':
        S.npcs = S.npcs.filter(n => n.cellid !== i);
        if (!erase && S.npcTemplate) S.npcs.push({ npcid: S.npcTemplate, cellid: i, orientation: 1 });
        break;
      default: return;
    }
    S.dirty = true;
    render();
  }

  // ---------------------------------------------------------------- herramientas de pintura
  const LAYER_NUM = { g: 'layerGroundNum', o1: 'layerObject1Num', o2: 'layerObject2Num' };
  const LAYER_FLIP = { g: 'layerGroundFlip', o1: 'layerObject1Flip', o2: 'layerObject2Flip' };
  const neighbours = i => { const w = S.map.width, n = S.cells.length; return [i - w, i - w + 1, i + w - 1, i + w].filter(j => j >= 0 && j < n); };

  function paintCell(i, layer, num, flip) {
    const c = S.cells[i]; if (!c || !c.active) return;
    c[LAYER_NUM[layer]] = num; c[LAYER_FLIP[layer]] = num ? flip : false;
  }
  /** Celdas a distancia < radio en la rejilla (1 = solo la celda). */
  function brushCells(i, size) {
    const out = new Set([i]); let frontier = [i];
    for (let r = 1; r < size; r++) { const next = []; for (const a of frontier) for (const b of neighbours(a)) if (!out.has(b)) { out.add(b); next.push(b); } frontier = next; }
    return out;
  }
  /** Relleno: todas las celdas conectadas que tengan el mismo tile en esa capa. */
  function floodFill(i, layer, num, flip) {
    const key = LAYER_NUM[layer], target = S.cells[i][key];
    if (target === num) return;
    const seen = new Set([i]), stack = [i];
    while (stack.length) {
      const a = stack.pop(); paintCell(a, layer, num, flip);
      for (const b of neighbours(a)) if (!seen.has(b) && S.cells[b].active && S.cells[b][key] === target) { seen.add(b); stack.push(b); }
    }
    status(`Relleno: ${seen.size} celdas.`);
  }
  function pickTile(i, layer) {
    const num = S.cells[i][LAYER_NUM[layer]];
    if (!num) { status('Esa celda no tiene tile en la capa elegida.'); return; }
    setTile(layer === 'g' ? 'g' : 'o', num);
    $('#paintFlip').checked = !!S.cells[i][LAYER_FLIP[layer]];
    status(`Cuentagotas: tile ${num}.`);
  }
  function setTile(kind, num) {
    S.tile = { kind, num };
    const rec = loadList('recent').filter(x => x !== kind + num); rec.unshift(kind + num); saveList('recent', rec.slice(0, 40));
    document.querySelectorAll('.tile').forEach(x => x.classList.toggle('sel', x.dataset.kind === kind && +x.dataset.num === num));
  }
  function setTool(tool) {
    S.tool = tool;
    document.querySelectorAll('#paintTools button').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  }

  // rectángulo de arrastre (pintar zona o seleccionar zona) en coordenadas del mapa
  function worldAt(clientX, clientY) {
    const r = cv.getBoundingClientRect();
    return { x: (clientX - r.left - S.view.ox) / S.view.scale, y: (clientY - r.top - S.view.oy) / S.view.scale };
  }
  function cellsInDrag(d) {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1), out = [];
    S.cells.forEach((c, i) => { if (c.active && S.pos[i].x >= x0 && S.pos[i].x <= x1 && S.pos[i].y >= y0 && S.pos[i].y <= y1) out.push(i); });
    return out;
  }

  // ---------------------------------------------------------------- copiar / pegar zonas
  const COPY_FIELDS = ['layerGroundNum', 'layerGroundRot', 'layerGroundFlip', 'groundLevel', 'groundSlope', 'movement', 'lineOfSight',
    'layerObject1Num', 'layerObject1Rot', 'layerObject1Flip', 'layerObject2Num', 'layerObject2Flip', 'layerObject2Interactive'];
  // posiciones sin alturas: la rejilla es la misma en cualquier mapa del mismo ancho
  const basePos = () => C.cellPositions(S.cells.map(() => ({ groundLevel: 7 })), S.map.width);
  function copyRegion() {
    if (!S.region || !S.region.size) { status('Selecciona antes una zona (Mayús + arrastrar en modo Seleccionar).'); return; }
    const bp = basePos(), ids = [...S.region];
    // referencia = una celda real (la de más arriba y a la izquierda): así los desplazamientos caen en la rejilla
    const anchor = ids.reduce((a, i) => (bp[i].y < bp[a].y || (bp[i].y === bp[a].y && bp[i].x < bp[a].x)) ? i : a, ids[0]);
    const ax = bp[anchor].x, ay = bp[anchor].y;
    const items = ids.map(i => ({ dx: bp[i].x - ax, dy: bp[i].y - ay, c: Object.fromEntries(COPY_FIELDS.map(f => [f, S.cells[i][f]])) }));
    try { localStorage.setItem('mapeditor.clipboard', JSON.stringify(items)); } catch (e) {}
    S.clipboard = items;
    status(`Copiadas ${items.length} celdas. Ctrl+V para pegarlas donde esté el ratón (también en otro mapa).`);
  }
  function pasteRegion() {
    let items = S.clipboard;
    if (!items) try { items = JSON.parse(localStorage.getItem('mapeditor.clipboard')); } catch (e) {}
    if (!items || !items.length) { status('No hay nada copiado.'); return; }
    if (S.hover < 0) { status('Pon el ratón sobre la celda donde quieres pegar.'); return; }
    pushHistory();
    const bp = basePos(), ax = bp[S.hover].x, ay = bp[S.hover].y, lookup = new Map(bp.map((p, i) => [Math.round(p.x * 2) + ',' + Math.round(p.y * 2), i]));
    let n = 0; const pasted = new Set();
    for (const it of items) {
      const j = lookup.get(Math.round((ax + it.dx) * 2) + ',' + Math.round((ay + it.dy) * 2));
      if (j === undefined || !S.cells[j].active) continue;
      Object.assign(S.cells[j], it.c); pasted.add(j); n++;
    }
    S.pos = C.cellPositions(S.cells, S.map.width); S.region = pasted; S.dirty = true; render();
    status(`Pegadas ${n} de ${items.length} celdas.`);
  }
  function clearRegion() {
    if (!S.region || !S.region.size) return false;
    pushHistory();
    for (const i of S.region) Object.assign(S.cells[i], { layerObject1Num: 0, layerObject2Num: 0, layerObject1Flip: false, layerObject2Flip: false });
    S.dirty = true; render(); status(`Vaciados los objetos de ${S.region.size} celdas (el suelo se conserva).`);
    return true;
  }

  // ---------------------------------------------------------------- favoritos (grupos) / recientes
  function favGroups() {
    let g = loadList('favgroups');
    if (!g.length) { const old = loadList('fav'); g = [{ name: 'General', items: old }]; saveList('favgroups', g); }
    return g;
  }
  const saveGroups = g => saveList('favgroups', g);
  function toggleInGroup(gi, key) {
    const g = favGroups(), it = g[gi].items, k = it.indexOf(key);
    k >= 0 ? it.splice(k, 1) : it.push(key); saveGroups(g); buildPalette();
    status(k >= 0 ? `Quitado de «${g[gi].name}».` : `Añadido a «${g[gi].name}».`);
  }
  function newGroup(firstKey) {
    const name = prompt('Nombre del grupo de favoritos:', 'Mi grupo'); if (!name) return;
    const g = favGroups(); g.push({ name, items: firstKey ? [firstKey] : [] }); saveGroups(g);
    fillCategories(); $('#paletteCat').value = 'fg:' + (g.length - 1); buildPalette();
  }
  function showTileMenu(x, y, key) {
    const g = favGroups(), m = $('#ctxMenu');
    m.innerHTML = `<div class="t">Tile ${key.slice(1)} · favoritos</div>`
      + g.map((gr, i) => `<div data-g="${i}">${gr.items.includes(key) ? '✓' : '\u2003'} ${gr.name}</div>`).join('')
      + '<div data-new="1">+ Nuevo grupo…</div>';
    m.style.left = Math.min(x, innerWidth - 220) + 'px'; m.style.top = Math.max(0, Math.min(y, innerHeight - 70 - 30 * g.length)) + 'px'; m.hidden = false;
    m.onclick = e => { const d = e.target.closest('div'); if (!d || d.classList.contains('t')) return; m.hidden = true; d.dataset.new ? newGroup(key) : toggleInGroup(+d.dataset.g, key); };
  }
  document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxMenu')) $('#ctxMenu').hidden = true; });
  function loadList(k) { try { return JSON.parse(localStorage.getItem('mapeditor.' + k)) || []; } catch (e) { return []; } }
  function saveList(k, v) { try { localStorage.setItem('mapeditor.' + k, JSON.stringify(v)); } catch (e) {} }

  // ---------------------------------------------------------------- vista
  function resize() {
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    cv.width = r.width * dpr; cv.height = r.height * dpr; render();
  }
  function fit() {
    if (!S.map) return;
    const xs = S.pos.map(p => p.x), ys = S.pos.map(p => p.y), r = cv.getBoundingClientRect();
    const w = Math.max(...xs) - Math.min(...xs) + 120, h = Math.max(...ys) - Math.min(...ys) + 200;
    S.view.scale = Math.min(r.width / w, r.height / h, 2);
    S.view.ox = (r.width - w * S.view.scale) / 2 - Math.min(...xs) * S.view.scale + 60 * S.view.scale;
    S.view.oy = (r.height - h * S.view.scale) / 2 - Math.min(...ys) * S.view.scale + 120 * S.view.scale;
    render();
  }

  // ---------------------------------------------------------------- paneles
  const CATS = {
    g: [['all', 'Todos los suelos'], ['zone', 'En esta zona'], ['fav', '★ Favoritos'], ['recent', 'Recientes'],
        ['walkable', 'Caminables'], ['blocked', 'De zonas bloqueadas'], ['background', 'Fondos'], ['dark', 'Oscuros (podridos)'], ['unused', 'Sin usar']],
    o: [['all', 'Todos los objetos'], ['zone', 'En esta zona'], ['fav', '★ Favoritos'], ['recent', 'Recientes'],
        ['floor', 'Decorado de suelo'], ['deco', 'Decorativos (no bloquean)'], ['obstacle', 'Obstáculos'],
        ['wall', 'Muros (tapan visión)'], ['tall', 'Árboles y altos'], ['dark', 'Oscuros (podridos)'], ['unused', 'Sin usar']],
  };
  function fillCategories() {
    const kind = $('#paintLayer').value === 'g' ? 'g' : 'o', sel = $('#paletteCat'), prev = sel.value;
    const groups = favGroups().map((g, i) => ['fg:' + i, '★ ' + g.name]);
    const opts = CATS[kind].flatMap(e => e[0] === 'fav' ? groups : [e]);
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    if (opts.some(([v]) => v === prev)) sel.value = prev;
    return;
    if (CATS[kind].some(([v]) => v === prev)) sel.value = prev;
  }
  /** Tiles usados en los mapas de la zona del mapa actual (y en el propio mapa). */
  async function loadZoneTiles() {
    const ref = S.map && (S.map.id || S.map.basedOn);
    const z = ref ? (S.zone || await api('/api/zone/' + ref).catch(() => ({ maps: [] }))) : { maps: [] };
    if (ref && !S.zone) S.zone = z;
    const t = { g: new Map(), o: new Map() };
    for (const m of [...z.maps, { cells: S.cells }])
      for (const c of m.cells) {
        if (!c.active) continue;
        if (c.layerGroundNum) t.g.set(c.layerGroundNum, (t.g.get(c.layerGroundNum) || 0) + 1);
        for (const o of [c.layerObject1Num, c.layerObject2Num]) if (o) t.o.set(o, (t.o.get(o) || 0) + 1);
      }
    S.zoneTiles = t;
  }
  async function buildPalette() {
    const kind = $('#paintLayer').value === 'g' ? 'g' : 'o', cat = $('#paletteCat').value || 'all', q = $('#tileSearch').value.trim();
    const stats = (S.stats && S.stats[kind]) || {}, rec = loadList('recent'), groups = favGroups();
    const favs = new Set(groups.flatMap(g => g.items)), group = cat.startsWith('fg:') ? groups[+cat.slice(3)] : null;
    $('#favTools').hidden = !group;
    let nums;
    if (cat === 'zone') {
      if (!S.map) { $('#palette').innerHTML = '<p>Carga un mapa para ver los tiles de su zona.</p>'; return; }
      if (!S.zoneTiles) { $('#palette').innerHTML = '<p>Buscando los tiles de la zona…</p>'; await loadZoneTiles(); }
      nums = [...S.zoneTiles[kind].entries()].sort((a, b) => b[1] - a[1]).map(([n]) => String(n)).filter(n => S.index[kind][n]);
    } else if (group) nums = group.items.filter(k => k[0] === kind).map(k => k.slice(1)).filter(n => S.index[kind][n]);
    else if (cat === 'recent') nums = rec.filter(k => k[0] === kind).map(k => k.slice(1)).filter(n => S.index[kind][n]);
    else {
      nums = Object.keys(S.index[kind]).filter(n => cat === 'all' || (cat === 'dark' ? S.index[kind][n].darkOf : (stats[n] || {}).cat === cat && !S.index[kind][n].darkOf));
      nums.sort((a, b) => ((stats[b] || {}).n || 0) - ((stats[a] || {}).n || 0) || a - b); // lo más usado primero
    }
    if (q) nums = /^\d+$/.test(q) ? nums.filter(n => n.startsWith(q)) : nums.filter(n => (tagOf(kind, n).t || []).some(t => t.includes(q.toLowerCase())) || (tagOf(kind, n).r || []).includes(q.toLowerCase()));
    const total = nums.length; nums = nums.slice(0, 400);
    $('#palette').innerHTML = nums.map(n => `<div class="tile${S.tile && S.tile.kind === kind && S.tile.num === +n ? ' sel' : ''}" data-kind="${kind}" data-num="${n}"${group ? ' draggable="true"' : ''} title="Tile ${n} · ${(tagOf(kind, n).t || []).join(', ')} · usado ${(stats[n] || {}).n || 0} veces · clic derecho: favoritos${group ? ' · arrastra para ordenar' : ''}">`
      + `${favs.has(kind + n) ? '<span class="fav">★</span>' : ''}<img loading="lazy" src="/assets/${kind}/${n}.svg"><small class="n">${n}</small></div>`).join('')
      + (total > 400 ? `<p>Se muestran 400 de ${total}; filtra por número o categoría.</p>` : !total ? '<p>No hay tiles en esta categoría.</p>' : '');
  }
  function buildNpcList() {
    const q = $('#npcSearch').value.trim();
    $('#npcList').innerHTML = S.npcTemplates.filter(t => !q || String(t.id).startsWith(q)).slice(0, 400)
      .map(t => `<div class="npcItem" data-id="${t.id}">NPC ${t.id} <small>(gfx ${t.gfxID})</small></div>`).join('');
  }
  function setMode(mode) {
    S.mode = mode;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    $('#paintPanel').hidden = mode !== 'paint';
    $('#npcPanel').hidden = mode !== 'npc';
    $('#exitPanel').hidden = mode !== 'exits';
    if (mode === 'exits') renderExitList();
    $('#selPanel').hidden = mode !== 'select';
    $('#infoPanel').hidden = ['paint', 'npc', 'select', 'exits'].includes(mode);
    if (mode !== 'select') { S.sel = null; showSelection(); }
    render();
  }
  function status(t) { $('#status').textContent = t; }

  // ---------------------------------------------------------------- pesadilla / sueño febril
  const DREAM_HINT = {
    nightmare: 'Cada suelo y objeto se sustituye por uno del tema oscuro de la misma categoría y tamaño (siempre el mismo por tile, para que muros y caminos sigan continuos). Menos decoración viva, restos del tema y fondo oscuro.',
    fever: 'Pesadilla + objetos de otras zonas donde no deberían estar, suelos girados y deformados, terreno roto, objetos que se atraviesan, fragmentos repetidos en espejo y un fondo imposible. Se reparan los caminos para que siga siendo jugable.',
  };
  async function openDream() {
    if (!S.map) { status('Carga primero un mapa.'); return; }
    if (!S.themes) S.themes = await api('/api/themes');
    const sel = $('#dreamTheme');
    if (!sel.options.length) sel.innerHTML = '<option value="auto">Automático (al azar según la semilla)</option>' + S.themes.map(t => `<option value="${t.key}">${t.name}</option>`).join('') + '<option value="none">Solo oscurecer (el mismo mapa, podrido)</option>';
    if (!S.dark) S.dark = await api('/assets/dark.json').catch(() => null);
    $('#dreamRot').disabled = !S.dark; if (!S.dark) $('#dreamRot').checked = false;
    updateDreamHint();
    $('#dreamDlg').showModal();
  }
  function updateDreamHint() {
    const k = $('#dreamKind').value;
    $('#dreamIntensityRow').hidden = k !== 'fever';
    $('#dreamHint').textContent = DREAM_HINT[k];
  }
  async function applyDream(again = false) {
    const kind = $('#dreamKind').value, seed = +$('#genSeed').value || 1;
    let theme = $('#dreamTheme').value;
    if (theme === 'auto') theme = S.themes[seed % S.themes.length].key;
    S.themeCache = S.themeCache || {};
    if (theme === 'none') S.themeCache['none'] = { name: 'solo oscurecer', maps: [] };
    const ck = theme + ':' + S.map.width + 'x' + S.map.height;
    if (theme === 'none') S.themeCache[ck] = S.themeCache['none'];
    if (!S.themeCache[ck]) { status('Aprendiendo el tema oscuro…'); S.themeCache[ck] = await api(`/api/theme/${theme}?w=${S.map.width}&h=${S.map.height}`); }
    const th = S.themeCache[ck];
    if (!th.maps.length && theme !== 'none') { status(`El tema «${th.name}» no tiene mapas de ${S.map.width}×${S.map.height}.`); return; }
    if (theme === 'none' && !$('#dreamRot').checked) { status('«Solo oscurecer» necesita los tiles podridos activados.'); return; }
    if (!again) S.preDream = snapshot(); else if (S.preDream) restore(S.preDream);
    pushHistory();
    const protect = [...new Set([...(S.map.scriptedCells || []), ...S.exits.map(e => e.cell), ...S.npcs.map(p => p.cellid)])];
    const allBackgrounds = Object.entries((S.stats && S.stats.g) || {}).filter(([, v]) => v.cat === 'background').map(([id]) => +id);
    const opts = { seed, stats: S.stats || { g: {}, o: {} }, index: S.index, tags: S.tags || { o: {}, g: {} }, protect,
      dark: $('#dreamRot').checked ? S.dark : null, bgID: +$('#metaForm').bgID.value, intensity: +$('#dreamIntensity').value, allBackgrounds };
    const tpl = { width: S.map.width, cells: S.cells };
    const out = kind === 'fever' ? window.MapGenerator.fever(tpl, th.maps, opts) : window.MapGenerator.nightmare(tpl, th.maps, opts);
    S.cells = out.cells; S.pos = C.cellPositions(S.cells, S.map.width);
    if (out.bgID) { $('#metaForm').bgID.value = out.bgID; }
    S.generated = true; S.dirty = true; $('#btnSave').disabled = true; S.sel = null; showSelection();
    render();
    const st = out.stats;
    status(kind === 'fever'
      ? `Sueño febril (${th.name}, semilla ${seed}): ${st.swapped} tiles cambiados, ${st.strange} objetos fuera de lugar, ${st.ghosts} fantasmas, ${st.rotated} suelos girados, ${st.raised} celdas de terreno roto, ${st.mirrored} en espejo${st.scenes && st.scenes.length ? ', escenas: ' + st.scenes.join(', ') : ''}${st.carved ? ', ' + st.carved + ' abiertas para unir zonas' : ''}.`
      : `Pesadilla (${th.name}, semilla ${seed}): ${st.rotten ? st.rotten + ' tiles podridos, ' : ''}${st.swapped} tiles cambiados, ${st.thinned} decoraciones quitadas, ${st.debris} restos añadidos (aprendido de ${st.themeMaps} mapas).`);
  }

  // ---------------------------------------------------------------- generación
  async function generate() {
    if (!S.map) { status("Carga primero un mapa de la lista de la izquierda."); return; }
    if (!S.zone) {
      // mapas nuevos o de archivo: aprender de su mapa base o de uno que indiques
      let ref = S.map.id || S.map.basedOn;
      if (!ref) {
        ref = +prompt('¿De qué zona aprender la decoración? Escribe el id de un mapa de esa zona (búscalo a la izquierda, p. ej. una sala de Kimbo: 11108):', '11108');
        if (!ref) return;
        S.map.basedOn = ref;
      }
      status('Aprendiendo de los mapas de la zona…');
      S.zone = await api('/api/zone/' + ref);
      S.zone.maps = S.zone.maps.filter(z => z.width === S.map.width && z.height === S.map.height);
    }
    if (!S.zone.maps.length) { status('No hay mapas de la misma zona y tamaño para aprender.'); return; }
    const seed = +$('#genSeed').value || 1;
    pushHistory();
    const template = { width: S.map.width, cells: S.original.cells, scriptedCells: S.map.scriptedCells, npcCells: S.npcs.map(n => n.cellid) };
    const algo = $('#genAlgo').value;
    const g = algo === 'classic' ? window.MapGenerator.generate(S.zone.maps, template, seed) : window.MapGenerator.generatePatterns(S.zone.maps, template, seed);
    S.cells = g.cells; S.pos = C.cellPositions(S.cells, S.map.width);
    S.places = [new Set(g.places[0]), new Set(g.places[1])];
    S.generated = true; S.dirty = true; S.sel = null; showSelection();
    $('#btnSave').disabled = true; // guardaría las casillas sobre el mapa original
    render();
    status(`Variante semilla ${seed} de ${S.map.id} · aprendido de ${g.stats.zoneMaps} mapas (${S.zone.zone}) · ${g.stats.obstacles} obstáculos · ${g.stats.exits} accesos protegidos${g.stats.carved ? ` · ${g.stats.carved} celdas abiertas para unir zonas` : ''} (${algo === 'classic' ? 'clásico' : 'patrones'}). Exportar como mapa nuevo: fase 3.`);
  }

  async function save() {
    if (!S.map || S.generated) return;
    const body = { places: [[...S.places[0]], [...S.places[1]]], npcs: S.npcs, exits: S.exits, reverse: S.reverse };
    const r = await api('/api/map/' + S.map.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.dirty = false; S.reverse = []; renderExitList();
    const also = (r.alsoReload || []).map(id => 'RECARGARMAPA ' + id).join(', ');
    status(`Mapa ${S.map.id} guardado (casillas de combate, NPC y salidas). En el juego: RECARGARMAPA ${S.map.id}${also ? ' y ' + also : ''}.`);
  }

  // ---------------------------------------------------------------- eventos
  $('#mapList').addEventListener('click', e => { const it = e.target.closest('.mapItem'); if (it) loadMap(+it.dataset.id); });
  let searchT; $('#mapSearch').addEventListener('input', e => { clearTimeout(searchT); searchT = setTimeout(() => loadMapList(e.target.value.trim()), 250); });
  $('#modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  ['#lyG', '#lyO1', '#lyO2', '#lyGrid'].forEach(s => $(s).addEventListener('change', render));
  $('#paintLayer').addEventListener('change', () => { fillCategories(); buildPalette(); });
  $('#paletteCat').addEventListener('change', buildPalette);
  $('#paintTools').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
  $('#palette').addEventListener('contextmenu', e => {
    const t = e.target.closest('.tile'); if (!t) return; e.preventDefault();
    showTileMenu(e.clientX, e.clientY, t.dataset.kind + t.dataset.num);
  });
  // ordenar dentro de un grupo arrastrando
  let dragKey = null;
  $('#palette').addEventListener('dragstart', e => { const t = e.target.closest('.tile'); if (t) { dragKey = t.dataset.kind + t.dataset.num; e.dataTransfer.effectAllowed = 'move'; } });
  $('#palette').addEventListener('dragover', e => {
    const t = e.target.closest('.tile'); if (!t || !dragKey) return; e.preventDefault();
    document.querySelectorAll('.tile.dragover').forEach(x => x.classList.remove('dragover')); t.classList.add('dragover');
  });
  $('#palette').addEventListener('drop', e => {
    const t = e.target.closest('.tile'), cat = $('#paletteCat').value; if (!t || !dragKey || !cat.startsWith('fg:')) return; e.preventDefault();
    const g = favGroups(), it = g[+cat.slice(3)].items, to = t.dataset.kind + t.dataset.num, from = it.indexOf(dragKey);
    if (from < 0 || dragKey === to) return;
    it.splice(from, 1); it.splice(it.indexOf(to), 0, dragKey); saveGroups(g); dragKey = null; buildPalette();
  });
  $('#palette').addEventListener('dragend', () => { dragKey = null; document.querySelectorAll('.tile.dragover').forEach(x => x.classList.remove('dragover')); });
  $('#favNew').addEventListener('click', () => newGroup());
  $('#favRename').addEventListener('click', () => {
    const cat = $('#paletteCat').value; if (!cat.startsWith('fg:')) return;
    const g = favGroups(), gr = g[+cat.slice(3)], name = prompt('Nuevo nombre:', gr.name); if (!name) return;
    gr.name = name; saveGroups(g); fillCategories(); $('#paletteCat').value = cat; buildPalette();
  });
  $('#favDelete').addEventListener('click', () => {
    const cat = $('#paletteCat').value; if (!cat.startsWith('fg:')) return;
    const g = favGroups(), i = +cat.slice(3);
    if (!confirm(`¿Borrar el grupo «${g[i].name}»? (${g[i].items.length} tiles; los tiles no se borran)`)) return;
    g.splice(i, 1); saveGroups(g.length ? g : [{ name: 'General', items: [] }]); fillCategories(); $('#paletteCat').value = 'all'; buildPalette();
  });
  $('#favExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ format: 'dofus-favs/1', groups: favGroups() }, null, 1)], { type: 'application/json' }));
    a.download = 'favoritos.dfav.json'; a.click(); URL.revokeObjectURL(a.href);
    status('Favoritos guardados en descargas (favoritos.dfav.json).');
  });
  $('#favImport').addEventListener('click', () => $('#favFile').click());
  $('#favFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (j.format !== 'dofus-favs/1') throw new Error('no es un archivo de favoritos');
      const g = favGroups();
      for (const ng of j.groups) { const ex = g.find(x => x.name === ng.name); if (ex) ex.items = [...new Set([...ex.items, ...ng.items])]; else g.push({ name: ng.name, items: ng.items }); }
      saveGroups(g); fillCategories(); buildPalette();
      status(`Importados ${j.groups.length} grupos de favoritos (los de igual nombre se fusionan).`);
    } catch (err) { status('Error al importar: ' + err.message); }
  });
  $('#tileSearch').addEventListener('input', buildPalette);
  $('#npcSearch').addEventListener('input', buildNpcList);
  $('#palette').addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    setTile(t.dataset.kind, +t.dataset.num);
  });
  $('#npcList').addEventListener('click', e => {
    const t = e.target.closest('.npcItem'); if (!t) return;
    S.npcTemplate = +t.dataset.id;
    document.querySelectorAll('.npcItem').forEach(x => x.classList.toggle('sel', x === t));
  });
  $('#btnSave').addEventListener('click', () => save().catch(err => status('Error al guardar: ' + err.message)));
  $('#btnGen').addEventListener('click', () => generate().catch(err => status('Error al generar: ' + err.message)));
  $('#btnGenNext').addEventListener('click', () => { $('#genSeed').value = (+$('#genSeed').value || 0) + 1; generate().catch(err => status('Error al generar: ' + err.message)); });

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('mousedown', e => {
    if (e.button === 1 || S.space) { S.pan = { x: e.clientX, y: e.clientY, ox: S.view.ox, oy: S.view.oy }; e.preventDefault(); return; }
    const w = worldAt(e.clientX, e.clientY);
    if (S.mode === 'select') {
      if (e.button !== 0) return;
      if (e.shiftKey) { S.drag = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, purpose: 'region' }; return; }
      S.region = null; S.sel = spriteAt(e.clientX, e.clientY); showSelection(); render(); return;
    }
    if (S.mode === 'paint' && S.tool === 'rect' && !e.altKey) { pushHistory(); S.drag = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, purpose: 'paint', erase: e.button === 2 }; return; }
    if (['paint', 'cells', 'fight', 'exits', 'npc'].includes(S.mode) && !(S.mode === 'paint' && (S.tool === 'pick' || e.altKey))) pushHistory();
    applyAt(cellAt(e.clientX, e.clientY), e);
  });
  window.addEventListener('mouseup', () => {
    S.pan = null;
    if (!S.drag) return;
    const d = S.drag, cells = cellsInDrag(d); S.drag = null;
    if (d.purpose === 'region') { S.region = new Set(cells); status(`Zona de ${cells.length} celdas. Ctrl+C copiar · Supr vaciar.`); }
    else if (d.purpose === 'paint') {
      const layer = $('#paintLayer').value, flip = $('#paintFlip').checked;
      if (!S.tile && !d.erase) { status('Elige antes un tile en la paleta.'); render(); return; }
      for (const i of cells) paintCell(i, layer, d.erase ? 0 : S.tile.num, flip);
      S.dirty = true; status(`Rectángulo: ${cells.length} celdas.`);
    }
    render();
  });
  cv.addEventListener('mousemove', e => {
    if (S.pan) { S.view.ox = S.pan.ox + e.clientX - S.pan.x; S.view.oy = S.pan.oy + e.clientY - S.pan.y; render(); return; }
    if (S.drag) { const w = worldAt(e.clientX, e.clientY); S.drag.x1 = w.x; S.drag.y1 = w.y; render(); }
    const i = cellAt(e.clientX, e.clientY);
    if (i !== S.hover) {
      S.hover = i; render();
      const c = S.cells[i];
      $('#hover').textContent = i < 0 ? '' : `celda ${i} · suelo ${c.layerGroundNum} · obj1 ${c.layerObject1Num} · obj2 ${c.layerObject2Num} · nivel ${c.groundLevel} · ${c.movement ? 'caminable' : 'bloqueada'}${c.lineOfSight ? '' : ' · sin visión'}`;
    }
    if (e.buttons === 1 && S.mode === 'paint' && S.tool === 'brush' && !e.altKey && !S.drag) applyAt(i, e);
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15, ns = Math.min(6, Math.max(0.2, S.view.scale * k));
    S.view.ox = mx - (mx - S.view.ox) * ns / S.view.scale; S.view.oy = my - (my - S.view.oy) * ns / S.view.scale;
    S.view.scale = ns; render();
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return; // no interferir al escribir en campos
    if (e.code === 'Space') { S.space = true; e.preventDefault(); }
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { redo(); e.preventDefault(); return; }
    if (ctrl && k === 'c') { copyRegion(); e.preventDefault(); return; }
    if (ctrl && k === 'v') { pasteRegion(); e.preventDefault(); return; }
    if (S.mode === 'paint' && !ctrl) { const t = { b: 'brush', r: 'rect', g: 'fill', i: 'pick' }[k]; if (t) setTool(t); }
    if (S.mode === 'select' && (e.key === 'Delete' || e.key === 'Backspace')) { if (!clearRegion()) deleteSelection(); e.preventDefault(); }
    if (S.mode === 'select' && e.key.toLowerCase() === 'f') flipSelection();
  });
  $('#btnSelDel').addEventListener('click', deleteSelection);
  $('#btnSelFlip').addEventListener('click', flipSelection);
  $('#btnSelPick').addEventListener('click', () => {
    if (!S.sel) return;
    S.tile = { kind: S.sel.layer === 'g' ? 'g' : 'o', num: S.sel.num };
    $('#paintLayer').value = S.sel.layer; buildPalette(); setMode('paint');
    status(`Pintando con el tile ${S.tile.num} (${LAYER_NAMES[S.sel.layer]})`);
  });
  $('#btnNew').addEventListener('click', newMap);
  $('#btnDream').addEventListener('click', () => openDream().catch(err => status('Error: ' + err.message)));
  $('#dreamKind').addEventListener('change', updateDreamHint);
  $('#dreamApply').addEventListener('click', () => { $('#dreamDlg').close(); applyDream().catch(err => status('Error al transformar: ' + err.message)); });
  $('#dreamAgain').addEventListener('click', () => { $('#genSeed').value = (+$('#genSeed').value || 0) + 1; $('#dreamDlg').close(); applyDream(true).catch(err => status('Error al transformar: ' + err.message)); });
  $('#dreamClose').addEventListener('click', () => $('#dreamDlg').close());
  $('#btnAutoLink').addEventListener('click', () => autoLink().catch(err => status('Error al enlazar: ' + err.message)));
  $('#exitList').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; pushHistory(); S.exits = S.exits.filter(x => x.cell !== +b.dataset.cell); S.dirty = true; renderExitList(); render(); });
  $('#lyBg').addEventListener('change', render);
  $('#btnExport').addEventListener('click', openExport);
  $('#expOverwrite').addEventListener('click', () => doExport(false).catch(err => status('Error al exportar: ' + err.message)));
  $('#expNew').addEventListener('click', () => doExport(true).catch(err => status('Error al exportar: ' + err.message)));
  $('#expCancel').addEventListener('click', () => $('#exportDlg').close());
  $('#metaForm').addEventListener('input', () => { S.dirty = true; render(); });
  $('#btnFile').addEventListener('click', saveFile);
  $('#btnOpen').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openFile(f).catch(err => status('Error al abrir: ' + err.message)); });
  window.addEventListener('keyup', e => { if (e.code === 'Space') S.space = false; });
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  init().catch(err => status('Error: ' + err.message));
})();
