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
  };

  // ---------------------------------------------------------------- carga
  async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw new Error((await r.json()).error || r.status); return r.json(); }

  async function init() {
    S.index = await api('/assets/index.json').catch(() => ({ g: {}, o: {} }));
    S.npcTemplates = await api('/api/npcs').catch(() => []);
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

  async function loadMap(id) {
    if (S.dirty && !confirm('Hay cambios sin guardar. ¿Cambiar de mapa?')) return;
    const m = await api('/api/map/' + id);
    S.map = m; S.cells = m.cells; S.pos = C.cellPositions(m.cells, m.width);
    S.places = [new Set(m.places[0]), new Set(m.places[1])];
    S.npcs = m.npcs.map(n => ({ npcid: n.npcid, cellid: n.cellid, orientation: n.orientation }));
    S.dirty = false;
    S.original = { cells: m.cells.map(c => ({ ...c })), places: m.places };
    S.generated = false; S.zone = null;
    $('#btnGen').disabled = $('#btnGenNext').disabled = false;
    $('#btnSave').disabled = false;
    document.querySelectorAll('.mapItem').forEach(e => e.classList.toggle('sel', +e.dataset.id === id));
    fit();
    status(`Mapa ${id} ${m.dungeon ? '· ' + m.dungeon : ''} · ${m.width}×${m.height} · ${S.places[0].size}/${S.places[1].size} casillas de combate · ${S.npcs.length} NPC`);
  }

  // ---------------------------------------------------------------- imágenes
  function img(kind, num, frame) {
    const meta = S.index[kind][num];
    if (!meta) return null;
    const file = frame && meta.frames > 1 ? `${num}_${frame}.svg` : `${num}.svg`;
    const key = kind + '/' + file;
    let im = S.imgs.get(key);
    if (!im) { im = new Image(); im.onload = () => render(); im.src = `/assets/${kind}/${file}`; S.imgs.set(key, im); }
    return im.complete && im.naturalWidth ? { im, meta } : null;
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
    for (const n of S.npcs) {
      const p = pos[n.cellid]; if (!p) continue;
      ctx.fillStyle = '#d8893c'; ctx.beginPath(); ctx.arc(p.x, p.y - 18, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1206'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', p.x, p.y - 15);
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
        if (!S.tile && !erase) return;
        const layer = $('#paintLayer').value, num = erase ? 0 : S.tile.num, flip = $('#paintFlip').checked;
        if (layer === 'g') { c.layerGroundNum = num; c.layerGroundFlip = flip; }
        else if (layer === 'o1') { c.layerObject1Num = num; c.layerObject1Flip = flip; }
        else { c.layerObject2Num = num; c.layerObject2Flip = flip; }
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
      case 'npc':
        S.npcs = S.npcs.filter(n => n.cellid !== i);
        if (!erase && S.npcTemplate) S.npcs.push({ npcid: S.npcTemplate, cellid: i, orientation: 1 });
        break;
      default: return;
    }
    S.dirty = true;
    render();
  }

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
  function buildPalette() {
    const layer = $('#paintLayer').value === 'g' ? 'g' : 'o';
    const q = $('#tileSearch').value.trim();
    const nums = Object.keys(S.index[layer]).filter(n => !q || n.startsWith(q)).sort((a, b) => a - b).slice(0, 600);
    $('#palette').innerHTML = nums.map(n => `<div class="tile" data-kind="${layer}" data-num="${n}"><img loading="lazy" src="/assets/${layer}/${n}.svg"><small>${n}</small></div>`).join('')
      + (nums.length === 600 ? '<p>Se muestran 600; filtra por número para ver más.</p>' : '');
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
    $('#infoPanel').hidden = mode === 'paint' || mode === 'npc';
    render();
  }
  function status(t) { $('#status').textContent = t; }

  // ---------------------------------------------------------------- generación
  async function generate() {
    if (!S.map) { status("Carga primero un mapa de la lista de la izquierda."); return; }
    if (!S.zone) {
      status('Aprendiendo de los mapas de la zona…');
      S.zone = await api('/api/zone/' + S.map.id);
    }
    if (!S.zone.maps.length) { status('No hay mapas de la misma zona y tamaño para aprender.'); return; }
    const seed = +$('#genSeed').value || 1;
    const template = { width: S.map.width, cells: S.original.cells, scriptedCells: S.map.scriptedCells, npcCells: S.npcs.map(n => n.cellid) };
    const g = window.MapGenerator.generate(S.zone.maps, template, seed);
    S.cells = g.cells; S.pos = C.cellPositions(S.cells, S.map.width);
    S.places = [new Set(g.places[0]), new Set(g.places[1])];
    S.generated = true; S.dirty = true;
    $('#btnSave').disabled = true; // guardaría las casillas sobre el mapa original
    render();
    status(`Variante semilla ${seed} de ${S.map.id} · aprendido de ${g.stats.zoneMaps} mapas (${S.zone.zone}) · ${g.stats.obstacles} obstáculos · ${g.stats.exits} accesos protegidos. Exportar como mapa nuevo: fase 3.`);
  }

  async function save() {
    if (!S.map || S.generated) return;
    const body = { places: [[...S.places[0]], [...S.places[1]]], npcs: S.npcs };
    await api('/api/map/' + S.map.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.dirty = false;
    status(`Mapa ${S.map.id} guardado: casillas de combate y NPC. Reinicia el servidor de juego para verlo.`);
  }

  // ---------------------------------------------------------------- eventos
  $('#mapList').addEventListener('click', e => { const it = e.target.closest('.mapItem'); if (it) loadMap(+it.dataset.id); });
  let searchT; $('#mapSearch').addEventListener('input', e => { clearTimeout(searchT); searchT = setTimeout(() => loadMapList(e.target.value.trim()), 250); });
  $('#modes').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); });
  ['#lyG', '#lyO1', '#lyO2', '#lyGrid'].forEach(s => $(s).addEventListener('change', render));
  $('#paintLayer').addEventListener('change', buildPalette);
  $('#tileSearch').addEventListener('input', buildPalette);
  $('#npcSearch').addEventListener('input', buildNpcList);
  $('#palette').addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    S.tile = { kind: t.dataset.kind, num: +t.dataset.num };
    document.querySelectorAll('.tile').forEach(x => x.classList.toggle('sel', x === t));
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
    applyAt(cellAt(e.clientX, e.clientY), e);
  });
  window.addEventListener('mouseup', () => { S.pan = null; });
  cv.addEventListener('mousemove', e => {
    if (S.pan) { S.view.ox = S.pan.ox + e.clientX - S.pan.x; S.view.oy = S.pan.oy + e.clientY - S.pan.y; render(); return; }
    const i = cellAt(e.clientX, e.clientY);
    if (i !== S.hover) {
      S.hover = i; render();
      const c = S.cells[i];
      $('#hover').textContent = i < 0 ? '' : `celda ${i} · suelo ${c.layerGroundNum} · obj1 ${c.layerObject1Num} · obj2 ${c.layerObject2Num} · nivel ${c.groundLevel} · ${c.movement ? 'caminable' : 'bloqueada'}${c.lineOfSight ? '' : ' · sin visión'}`;
    }
    if (e.buttons === 1 && S.mode === 'paint') applyAt(i, e);
  });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15, ns = Math.min(6, Math.max(0.2, S.view.scale * k));
    S.view.ox = mx - (mx - S.view.ox) * ns / S.view.scale; S.view.oy = my - (my - S.view.oy) * ns / S.view.scale;
    S.view.scale = ns; render();
  }, { passive: false });
  window.addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { S.space = true; e.preventDefault(); } });
  window.addEventListener('keyup', e => { if (e.code === 'Space') S.space = false; });
  window.addEventListener('resize', resize);
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  init().catch(err => status('Error: ' + err.message));
})();
