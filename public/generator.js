// Generador de variantes de mapa a partir de los mapas de una zona.
//  1. Aprende de la zona: suelos (y qué suelo va junto a cuál), decoración, obstáculos y si tapan la visión.
//  2. Usa un mapa de la zona como plantilla: conserva intactos muros, bordes y salidas (región exterior bloqueada),
//     y las alturas/pendientes del interior, para que siga encajando con sus vecinos.
//  3. Rehace el interior: grupos de obstáculos (sin romper la conexión entre salidas), suelo por vecindad,
//     decoración y casillas de combate en extremos opuestos.
(function (root) {
  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
  function pick(r, m) { let tot = 0; for (const v of m.values()) tot += v; if (!tot) return 0; let x = r() * tot; for (const [k, v] of m) { x -= v; if (x < 0) return k; } return 0; }

  // Vecinos en diamante de la rejilla Dofus (filas alternas de w y w-1 celdas)
  const neigh = (i, w, n) => [i - w, i - w + 1, i + w - 1, i + w].filter(j => j >= 0 && j < n);

  /** Región exterior bloqueada: celdas no caminables conectadas con el borde (muros, vacío, decorado de marco). */
  function outerRegion(cells, w) {
    const n = cells.length, outer = new Uint8Array(n), stack = [];
    for (let i = 0; i < n; i++) {
      const border = neigh(i, w, n).length < 4 || neigh(i, w, n).some(j => !cells[j].active);
      if ((!cells[i].active || !cells[i].movement) && border) { outer[i] = 1; stack.push(i); }
    }
    while (stack.length) {
      const i = stack.pop();
      for (const j of neigh(i, w, n)) if (!outer[j] && (!cells[j].active || !cells[j].movement)) { outer[j] = 1; stack.push(j); }
    }
    return outer;
  }

  function learn(maps) {
    const M = { gWalk: new Map(), gBlock: new Map(), gLeft: new Map(), gUp: new Map(), o1: new Map(), o2Block: new Map(), o2Walk: new Map(),
                losBlock: new Map(), move: new Map(), interior: 0, blocked: 0, o1n: 0, o2w: 0, walk: 0 };
    for (const m of maps) {
      const w = m.width, cells = m.cells, outer = outerRegion(cells, w), up = 2 * w - 1;
      cells.forEach((c, i) => {
        if (!c.active || outer[i]) return;
        M.interior++;
        if (c.movement) {
          M.walk++; bump(M.gWalk, c.layerGroundNum); bump(M.move, c.movement);
          if (c.layerObject1Num) { M.o1n++; bump(M.o1, c.layerObject1Num); }
          if (c.layerObject2Num) { M.o2w++; bump(M.o2Walk, c.layerObject2Num); }
        } else {
          M.blocked++; bump(M.gBlock, c.layerGroundNum);
          if (c.layerObject2Num) { bump(M.o2Block, c.layerObject2Num); if (!c.lineOfSight) bump(M.losBlock, c.layerObject2Num); }
        }
        const L = cells[i - 1], U = cells[i - up];
        if (L && L.active) { if (!M.gLeft.has(L.layerGroundNum)) M.gLeft.set(L.layerGroundNum, new Map()); bump(M.gLeft.get(L.layerGroundNum), c.layerGroundNum); }
        if (U && U.active) { if (!M.gUp.has(U.layerGroundNum)) M.gUp.set(U.layerGroundNum, new Map()); bump(M.gUp.get(U.layerGroundNum), c.layerGroundNum); }
      });
    }
    M.blockRatio = M.interior ? M.blocked / M.interior : 0.08;
    M.o1Ratio = M.walk ? M.o1n / M.walk : 0;
    M.o2WalkRatio = M.walk ? M.o2w / M.walk : 0;
    return M;
  }

  function groundFor(M, r, cells, i, w, walkable) {
    const cand = new Map(), base = walkable ? M.gWalk : (M.gBlock.size ? M.gBlock : M.gWalk);
    for (const [k, v] of base) bump(cand, k, v * 0.3);
    const L = cells[i - 1], U = cells[i - (2 * w - 1)];
    for (const [nb, table] of [[L, M.gLeft], [U, M.gUp]])
      if (nb && nb.active && table.has(nb.layerGroundNum))
        for (const [k, v] of table.get(nb.layerGroundNum)) if (base.has(k)) bump(cand, k, v * 2);
    return pick(r, cand.size ? cand : base);
  }

  function connectedFrom(cells, w, starts) {
    const n = cells.length, seen = new Uint8Array(n), stack = [...starts];
    starts.forEach(s => seen[s] = 1);
    while (stack.length) { const i = stack.pop(); for (const j of neigh(i, w, n)) if (!seen[j] && cells[j].active && cells[j].movement) { seen[j] = 1; stack.push(j); } }
    return seen;
  }

  function generate(zoneMaps, template, seed) {
    const r = rng(seed), M = learn(zoneMaps), w = template.width;
    const cells = template.cells.map(c => ({ ...c })), n = cells.length, outer = outerRegion(cells, w);
    const interior = []; cells.forEach((c, i) => { if (c.active && !outer[i]) interior.push(i); });

    // Salidas: caminables en el límite del mapa (cambio de mapa) + celdas con acción del servidor (teletransportes
    // de mazmorra, puertas…) + NPC. Nunca se bloquean, ni ellas ni sus vecinas.
    const exits = interior.filter(i => cells[i].movement && (neigh(i, w, n).length < 4 || neigh(i, w, n).some(j => !cells[j].active)));
    const keep = [...exits, ...(template.scriptedCells || []), ...(template.npcCells || [])].filter(i => i >= 0 && i < n);
    const protectedCells = new Set(keep.flatMap(i => [i, ...neigh(i, w, n)]));

    // 1) interior limpio y caminable
    const move = pick(r, M.move) || 4;
    for (const i of interior) Object.assign(cells[i], { movement: move, lineOfSight: true, layerObject1Num: 0, layerObject2Num: 0, layerObject1Flip: false, layerObject2Flip: false });

    // 2) grupos de obstáculos hasta la proporción de la zona, sin desconectar las salidas
    const target = Math.round(interior.length * M.blockRatio * (0.8 + r() * 0.4));
    let placed = 0, tries = 0;
    // la conectividad se comprueba desde las salidas o, si no hay (salas de mazmorra), desde la celda más central
    let startCells = keep.filter(i => cells[i].movement);
    if (!startCells.length) { // la celda de la componente caminable más grande
      let best = null, bestSize = 0;
      const done = new Uint8Array(n);
      for (const i of interior) {
        if (done[i] || !cells[i].movement) continue;
        const comp = connectedFrom(cells, w, [i]); let size = 0;
        for (let j = 0; j < n; j++) if (comp[j]) { done[j] = 1; size++; }
        if (size > bestSize) { bestSize = size; best = i; }
      }
      startCells = best == null ? [] : [best];
    }
    // lo alcanzable antes de poner obstáculos: un obstáculo solo se rechaza si deja sin acceso algo que lo tenía
    const baseReach = connectedFrom(cells, w, startCells);
    while (placed < target && tries++ < target * 30) {
      const seedCell = interior[(r() * interior.length) | 0];
      const cluster = [seedCell];
      const size = 1 + ((r() * 3) | 0);
      while (cluster.length < size) { const nb = neigh(cluster[(r() * cluster.length) | 0], w, n); cluster.push(nb[(r() * nb.length) | 0]); }
      const ok = cluster.filter(i => !outer[i] && cells[i].active && cells[i].movement && !protectedCells.has(i));
      if (!ok.length) continue;
      ok.forEach(i => cells[i].movement = 0);
      const reach = connectedFrom(cells, w, startCells.filter(i => cells[i].movement));
      if (interior.some(i => baseReach[i] && cells[i].movement && !reach[i])) { ok.forEach(i => cells[i].movement = move); continue; } // rompía el paso
      ok.forEach(i => {
        cells[i].layerObject2Num = pick(r, M.o2Block.size ? M.o2Block : M.o2Walk);
        cells[i].layerObject2Flip = r() < 0.5;
        cells[i].lineOfSight = !(M.losBlock.get(cells[i].layerObject2Num) > 0);
      });
      placed += ok.length;
    }

    // 3) suelo por vecindad y decoración
    for (const i of interior) {
      const c = cells[i];
      c.layerGroundNum = groundFor(M, r, cells, i, w, !!c.movement) || c.layerGroundNum;
      if (c.movement) {
        if (r() < M.o1Ratio) { c.layerObject1Num = pick(r, M.o1); c.layerObject1Flip = r() < 0.5; }
        if (r() < M.o2WalkRatio * 0.7) { c.layerObject2Num = pick(r, M.o2Walk); c.layerObject2Flip = r() < 0.5; }
      }
    }

    // 4) casillas de combate: 8 por equipo en extremos opuestos según una dirección al azar
    const pos = root.MapCodec.cellPositions(cells, w), ang = r() * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang);
    const free = interior.filter(i => cells[i].movement && !protectedCells.has(i)).sort((a, b) => (pos[a].x * dx + pos[a].y * dy) - (pos[b].x * dx + pos[b].y * dy));
    const k = Math.min(8, Math.floor(free.length / 3));
    const places = [free.slice(0, k), free.slice(free.length - k)];

    return { cells, places, stats: { zoneMaps: zoneMaps.length, obstacles: placed, interior: interior.length, exits: keep.length } };
  }

  // ================================================================= síntesis por patrones (v2)
  // Cada celda interior se copia de una celda REAL de la zona cuyo entorno ya generado (izquierda, arriba-izquierda,
  // arriba-derecha y arriba: suelo, objeto 2 y si es caminable) coincide con el de la celda actual. Si no hay
  // coincidencia exacta se relaja el entorno por niveles. Así se reproducen patrones de varias celdas (muros
  // continuos, caminos, árboles con su sombra…). Después se reparan zonas aisladas y se colocan las casillas de combate.
  const COPY = ['layerGroundNum', 'layerGroundFlip', 'layerGroundRot', 'layerObject1Num', 'layerObject1Flip', 'layerObject1Rot',
    'layerObject2Num', 'layerObject2Flip', 'layerObject2Interactive', 'movement', 'lineOfSight'];
  const feat = (c, full) => !c || !c.active ? 'x' : full ? `${c.layerGroundNum}.${c.movement ? 1 : 0}.${c.layerObject2Num}` : `${c.layerGroundNum}.${c.movement ? 1 : 0}`;
  // niveles de exigencia: [qué vecinas, con objeto 2 o no]
  const LEVELS = [[['L', 'UL', 'UR', 'U'], true], [['L', 'UL', 'UR'], true], [['UL', 'UR'], true], [['L', 'UL', 'UR'], false], [['UL', 'UR'], false], [['L'], false]];
  const around = (cells, i, w) => ({ L: cells[i - 1], UL: cells[i - w], UR: cells[i - w + 1], U: cells[i - (2 * w - 1)] });
  const keyOf = (nb, [names, full]) => names.map(k => feat(nb[k], full)).join('|');

  function buildIndex(maps) {
    const idx = LEVELS.map(() => new Map()), all = { walk: [], block: [] };
    for (const m of maps) {
      const w = m.width, cells = m.cells, outer = outerRegion(cells, w);
      cells.forEach((c, i) => {
        if (!c.active || outer[i]) return;
        const nb = around(cells, i, w);
        LEVELS.forEach((lv, k) => { const key = keyOf(nb, lv); let a = idx[k].get(key); if (!a) idx[k].set(key, a = []); a.push(c); });
        (c.movement ? all.walk : all.block).push(c);
      });
    }
    return { idx, all };
  }

  function generatePatterns(zoneMaps, template, seed) {
    const r = rng(seed), w = template.width;
    const cells = template.cells.map(c => ({ ...c })), n = cells.length, outer = outerRegion(cells, w);
    const interior = []; cells.forEach((c, i) => { if (c.active && !outer[i]) interior.push(i); });
    const exits = interior.filter(i => cells[i].movement && (neigh(i, w, n).length < 4 || neigh(i, w, n).some(j => !cells[j].active)));
    const keep = [...exits, ...(template.scriptedCells || []), ...(template.npcCells || [])].filter(i => i >= 0 && i < n);
    const mustWalk = new Set(keep.flatMap(i => [i, ...neigh(i, w, n)]).filter(i => !outer[i]));

    const M = learn(zoneMaps), { idx, all } = buildIndex([...zoneMaps, template]);
    const target = M.blockRatio * (0.85 + r() * 0.3);
    let blocked = 0, done = 0, levelsUsed = new Array(LEVELS.length + 1).fill(0);

    for (const i of interior) {
      const nb = around(cells, i, w);
      const ratio = done ? blocked / done : 0;
      // densidad: si vamos pasados de obstáculos, solo caminables; si vamos cortos, se permite todo
      const wantWalk = mustWalk.has(i) || ratio > target * 1.25;
      // si vamos cortos de obstáculos, preferir un candidato bloqueado… pero solo si encaja con el entorno
      const wantBlock = !wantWalk && ratio < target * 0.8 && r() < 0.6;
      let chosen = null;
      for (let k = 0; k < LEVELS.length && !chosen; k++) {
        let cand = idx[k].get(keyOf(nb, LEVELS[k]));
        if (!cand) continue;
        if (wantWalk) cand = cand.filter(c => c.movement);
        else if (wantBlock && k <= 2) { const b = cand.filter(c => !c.movement); if (b.length) cand = b; }
        if (cand.length) { chosen = cand[(r() * cand.length) | 0]; levelsUsed[k]++; }
      }
      if (!chosen) { const pool = wantWalk || !all.block.length ? all.walk : (r() < M.blockRatio ? all.block : all.walk); chosen = pool[(r() * pool.length) | 0]; levelsUsed[LEVELS.length]++; }
      if (chosen) for (const f of COPY) cells[i][f] = chosen[f];
      if (!cells[i].movement) blocked++;
      done++;
    }

    // reparar zonas aisladas: abrir paso desde cada una hasta la principal por el camino más corto
    const carved = repairConnectivity(cells, w, interior, keep, outer, M);

    const pos = root.MapCodec.cellPositions(cells, w), ang = r() * Math.PI * 2, dx = Math.cos(ang), dy = Math.sin(ang);
    const free = interior.filter(i => cells[i].movement && !mustWalk.has(i)).sort((a, b) => (pos[a].x * dx + pos[a].y * dy) - (pos[b].x * dx + pos[b].y * dy));
    const kk = Math.min(8, Math.floor(free.length / 3));
    const places = [free.slice(0, kk), free.slice(free.length - kk)];
    const obstacles = interior.filter(i => !cells[i].movement).length;
    return { cells, places, stats: { zoneMaps: zoneMaps.length, obstacles, interior: interior.length, exits: keep.length, carved, levelsUsed } };
  }

  function repairConnectivity(cells, w, interior, keep, outer, M) {
    const n = cells.length, walkable = i => cells[i].active && cells[i].movement;
    const comps = [], compOf = new Int32Array(n).fill(-1);
    for (const s of interior) {
      if (!walkable(s) || compOf[s] >= 0) continue;
      const id = comps.length, list = [s]; compOf[s] = id;
      for (let q = 0; q < list.length; q++) for (const j of neigh(list[q], w, n)) if (compOf[j] < 0 && walkable(j) && !outer[j]) { compOf[j] = id; list.push(j); }
      comps.push(list);
    }
    if (comps.length < 2) return 0;
    const keepComp = keep.map(i => compOf[i]).find(c => c >= 0);
    const main = keepComp !== undefined ? keepComp : comps.reduce((b, c, k) => c.length > comps[b].length ? k : b, 0);
    const walkGround = [...M.gWalk.entries()].sort((a, b) => b[1] - a[1])[0];
    let carved = 0;
    for (let k = 0; k < comps.length; k++) {
      if (k === main) continue;
      // BFS por el interior desde la componente aislada hasta cualquier celda de la principal
      const prev = new Int32Array(n).fill(-2), queue = [...comps[k]];
      comps[k].forEach(i => prev[i] = -1);
      let hit = -1;
      for (let q = 0; q < queue.length && hit < 0; q++)
        for (const j of neigh(queue[q], w, n)) {
          if (prev[j] !== -2 || outer[j] || !cells[j].active) continue;
          prev[j] = queue[q];
          if (compOf[j] === main) { hit = j; break; }
          queue.push(j);
        }
      for (let c = hit >= 0 ? prev[hit] : -1; c >= 0 && prev[c] !== -1; c = prev[c]) {
        const cell = cells[c];
        if (cell.movement) continue;
        const nbWalk = neigh(c, w, n).map(j => cells[j]).find(x => x && x.active && x.movement);
        Object.assign(cell, { movement: 4, lineOfSight: true, layerObject2Num: 0, layerObject2Flip: false,
          layerGroundNum: nbWalk ? nbWalk.layerGroundNum : (walkGround ? walkGround[0] : cell.layerGroundNum) });
        carved++;
      }
      comps[k].forEach(i => compOf[i] = main);
    }
    return carved;
  }

  // ================================================================= transformaciones temáticas
  // PESADILLA: conserva la estructura (caminable, visión, alturas, muros y salidas) y reviste el mapa con la paleta
  // de un tema oscuro real (cementerio, Brakmar, pantano, tierras devastadas). Cada tile original se sustituye SIEMPRE
  // por el mismo tile del tema, de su misma categoría y tamaño parecido: los muros continuos siguen siendo continuos.
  // SUEÑO FEBRIL: pesadilla + incoherencias controladas (objetos de otras zonas, suelos girados que el cliente deforma,
  // terreno roto, objetos atravesables, fragmentos repetidos en espejo, fondo imposible). Sigue siendo jugable.
  const LAYERS = [['layerGroundNum', 'g'], ['layerObject1Num', 'o'], ['layerObject2Num', 'o']];

  function themePalette(themeMaps) {
    const use = { g: new Map(), o: new Map() }, bg = new Map(), floorDeco = new Map();
    let walk = 0, o1 = 0;
    for (const m of themeMaps) {
      for (const c of m.cells) {
        if (!c.active) continue;
        if (c.layerGroundNum) bump(use.g, c.layerGroundNum);
        if (c.layerObject1Num) bump(use.o, c.layerObject1Num);
        if (c.layerObject2Num) bump(use.o, c.layerObject2Num);
        if (c.movement) { walk++; if (c.layerObject1Num) { o1++; bump(floorDeco, c.layerObject1Num); } }
      }
      if (m.bgID) bump(bg, m.bgID);
    }
    return { use, bg, floorDeco, decoRatio: walk ? o1 / walk : 0.05 };
  }

  /** Sustituto de un tile: misma categoría (según su uso real en todos los mapas) y tamaño parecido, ponderado por uso en el tema. */
  const rolesOf = (tags, kind, id) => (((tags || {})[kind] || {})[id] || {}).r || [];
  function roleSim(a, b) { if (!a.length || !b.length) return 0; const B = new Set(b); const inter = a.filter(x => B.has(x)).length; return inter / (a.length + b.length - inter); }
  function makeMapper(pal, stats, index, r, tags) {
    const cache = new Map();
    return (kind, num) => {
      if (!num) return 0;
      const key = kind + num;
      if (cache.has(key)) return cache.get(key);
      const cat = ((stats[kind] || {})[num] || {}).cat, me = index[kind][num] || { w: 50, h: 50 };
      const cands = [];
      for (const [id, n] of pal.use[kind]) {
        if (((stats[kind] || {})[id] || {}).cat !== cat) continue;
        const o = index[kind][id]; if (!o) continue;
        const size = Math.abs(Math.log((o.w * o.h + 1) / (me.w * me.h + 1)));
        const myRoles = rolesOf(tags, kind, num), theirRoles = rolesOf(tags, kind, id);
        if (myRoles.includes('efecto') !== theirRoles.includes('efecto')) continue; // un efecto solo por otro efecto
        cands.push([id, (n / (1 + size * 3)) * (1 + 4 * roleSim(myRoles, theirRoles))]);
      }
      let out = num;
      if (cands.length) { cands.sort((a, b) => b[1] - a[1]); const top = cands.slice(0, 6); out = pick(r, new Map(top)); }
      cache.set(key, out);
      return out;
    };
  }

  function nightmare(template, themeMaps, opts) {
    const r = rng(opts.seed), w = template.width, n = template.cells.length;
    const cells = template.cells.map(c => ({ ...c }));
    const pal = themePalette(themeMaps), map = makeMapper(pal, opts.stats, opts.index, r, opts.tags);
    let swapped = 0, thinned = 0, debris = 0;
    for (const c of cells) {
      if (!c.active) continue;
      for (const [f, kind] of LAYERS) { const nv = map(kind, c[f]); if (nv !== c[f]) { c[f] = nv; swapped++; } }
    }
    // menos vida: se quita parte del decorado de suelo y se siembran restos del tema (huesos, escombros…)
    const protect = new Set(opts.protect || []);
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      if (!c.active || !c.movement || protect.has(i)) continue;
      if (c.layerObject1Num && r() < 0.3) { c.layerObject1Num = 0; thinned++; }
      else if (!c.layerObject1Num && !c.layerObject2Num && pal.floorDeco.size && r() < pal.decoRatio * 0.8) {
        c.layerObject1Num = pick(r, pal.floorDeco); c.layerObject1Flip = r() < 0.5; debris++;
      }
    }
    const bg = pal.bg.size ? pick(r, pal.bg) : 0;
    return { cells, bgID: bg, stats: { swapped, thinned, debris, themeMaps: themeMaps.length } };
  }

  function fever(template, themeMaps, opts) {
    const base = nightmare(template, themeMaps, opts);
    const r = rng(opts.seed * 7919 + 13), w = template.width, cells = base.cells, n = cells.length, k = Math.max(1, Math.min(3, opts.intensity | 0 || 2));
    const outer = outerRegion(cells, w), protect = new Set((opts.protect || []).flatMap(i => [i, ...neigh(i, w, n)]));
    const interior = []; cells.forEach((c, i) => { if (c.active && !outer[i] && !protect.has(i)) interior.push(i); });
    const any = kind => { const ids = Object.keys(opts.index[kind]); return +ids[(r() * ids.length) | 0]; };
    const cat = (kind, id) => ((opts.stats[kind] || {})[id] || {}).cat;
    const st = { rotated: 0, strange: 0, ghosts: 0, raised: 0, mirrored: 0 };

    // 1) suelos girados: el cliente los aplasta al 51% / estira al 193% al girarlos 90º → aspecto deformado
    for (const i of interior) { const c = cells[i]; if (c.groundSlope === 1 && r() < 0.1 * k) { c.layerGroundRot = 1 + ((r() * 3) | 0); st.rotated++; } }
    // reservas por rol (solo etiquetas puestas a mano/corregidas, nunca efectos)
    const pools = {};
    for (const [id, t] of Object.entries((opts.tags || {}).o || {})) {
      if (t.auto || !opts.index.o[id] || (t.r || []).includes('efecto')) continue;
      for (const role of t.r || []) (pools[role] ||= []).push(+id);
    }
    const fromPool = role => { const p = pools[role]; return p && p.length ? p[(r() * p.length) | 0] : 0; };
    const mainRole = id => { const rs = rolesOf(opts.tags, 'o', id).filter(x => !['efecto', 'oscuro', 'suelo'].includes(x)); return rs[0]; };
    // 2) objetos del mismo tipo… de otro mundo: una puerta sigue siendo una puerta, pero de otro sitio
    for (const i of interior) {
      const c = cells[i];
      if (!c.movement && c.layerObject2Num && r() < 0.12 * k) {
        const role = mainRole(c.layerObject2Num);
        let o = role ? fromPool(role) : 0;
        if (!o) for (let t = 0; t < 20; t++) { o = any('o'); if (['tall', 'deco', 'obstacle'].includes(cat('o', o))) break; }
        c.layerObject2Num = o; st.strange++;
      }
    }
    // 3) fantasmas: muebles, luces, tumbas o puertas sobre celdas caminables… que se atraviesan
    const ghostRoles = ['luz', 'asiento', 'mueble', 'tumba', 'puerta', 'contenedor'];
    for (const i of interior) {
      const c = cells[i];
      if (c.movement && !c.layerObject2Num && r() < 0.02 * k) {
        let o = fromPool(ghostRoles[(r() * ghostRoles.length) | 0]);
        if (!o) for (let t = 0; t < 20; t++) { o = any('o'); if (['tall', 'deco'].includes(cat('o', o))) break; }
        c.layerObject2Num = o; c.layerObject2Flip = r() < 0.5; st.ghosts++;
      }
    }
    // 3b) escenas oníricas en zonas despejadas: comedor abandonado, puerta a ninguna parte, círculo de velas, tumba entre muebles
    const free = i => cells[i] && cells[i].active && cells[i].movement && !cells[i].layerObject2Num && !outer[i] && !protect.has(i);
    const scenes = [
      ['comedor', a => { const t = fromPool('mesa'); if (!t) return 0; cells[a].layerObject2Num = t; cells[a].movement = 0; cells[a].lineOfSight = true;
        let n2 = 0; for (const b of neigh(a, w, n)) if (free(b) && r() < 0.8) { const s2 = fromPool('asiento'); if (s2) { cells[b].layerObject2Num = s2; cells[b].layerObject2Flip = r() < 0.5; n2++; } } return 1 + n2; }],
      ['puerta', a => { const d = fromPool('puerta'); if (!d) return 0; cells[a].layerObject2Num = d; cells[a].movement = 0; cells[a].lineOfSight = true; return 1; }],
      ['velas', a => { let n2 = 0; for (const b of neigh(a, w, n)) if (free(b)) { const l = fromPool('luz'); if (l) { cells[b].layerObject2Num = l; n2++; } } const t = fromPool('tumba'); if (t && free(a)) { cells[a].layerObject2Num = t; n2++; } return n2; }],
      ['tumba', a => { const t = fromPool('tumba'); if (!t) return 0; cells[a].layerObject2Num = t; cells[a].movement = 0; let n2 = 1;
        for (const b of neigh(a, w, n)) if (free(b) && r() < 0.5) { const m2 = fromPool('mueble'); if (m2) { cells[b].layerObject2Num = m2; n2++; } } return n2; }],
    ];
    st.scenes = [];
    for (let p = 0; p < k + 1; p++) {
      const open = interior.filter(i => free(i) && neigh(i, w, n).filter(free).length >= 3);
      if (!open.length) break;
      const [name, fn] = scenes[(r() * scenes.length) | 0];
      if (fn(open[(r() * open.length) | 0])) st.scenes.push(name);
    }
    // 4) terreno roto: parches de 3-6 celdas que suben o bajan de nivel
    for (let p = 0; p < 2 * k && interior.length; p++) {
      const seed = interior[(r() * interior.length) | 0], patch = [seed], delta = (r() < 0.5 ? -1 : 1) * (1 + ((r() * k) | 0));
      while (patch.length < 3 + ((r() * 4) | 0)) { const nb = neigh(patch[(r() * patch.length) | 0], w, n).filter(j => interior.includes(j)); if (!nb.length) break; patch.push(nb[(r() * nb.length) | 0]); }
      for (const i of new Set(patch)) { const c = cells[i]; if (c.groundSlope !== 1) continue; c.groundLevel = Math.max(1, Math.min(14, c.groundLevel + delta)); st.raised++; }
    }
    // 5) fragmentos repetidos en espejo: un trozo del mapa copiado en otro sitio, volteado
    const pos = root.MapCodec.cellPositions(cells.map(() => ({ groundLevel: 7 })), w);
    const lookup = new Map(pos.map((q, i) => [Math.round(q.x * 2) + ',' + Math.round(q.y * 2), i]));
    for (let p = 0; p < k && interior.length > 20; p++) {
      const a = interior[(r() * interior.length) | 0], b = interior[(r() * interior.length) | 0];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if ((dx + dy) % 2) continue; // puntos de la rejilla isométrica
        const src = lookup.get(Math.round((pos[a].x + dx * 26.5) * 2) + ',' + Math.round((pos[a].y + dy * 13.5) * 2));
        const dst = lookup.get(Math.round((pos[b].x - dx * 26.5) * 2) + ',' + Math.round((pos[b].y + dy * 13.5) * 2)); // espejo horizontal
        if (src === undefined || dst === undefined || outer[dst] || protect.has(dst) || !cells[dst].active) continue;
        const S = cells[src], D = cells[dst];
        Object.assign(D, { layerGroundNum: S.layerGroundNum, layerObject1Num: S.layerObject1Num, layerObject2Num: S.layerObject2Num,
          layerGroundFlip: !S.layerGroundFlip, layerObject1Flip: !S.layerObject1Flip, layerObject2Flip: !S.layerObject2Flip,
          movement: S.movement, lineOfSight: S.lineOfSight });
        st.mirrored++;
      }
    }
    // 6) fondo imposible: el de otro tema
    const bgs = opts.allBackgrounds || [];
    const bgID = bgs.length && r() < 0.5 ? bgs[(r() * bgs.length) | 0] : base.bgID;
    // jugable: se reparan zonas aisladas que hayan podido crear los espejos
    const M = learn(themeMaps.length ? themeMaps : [template]);
    st.carved = repairConnectivity(cells, w, cells.map((c, i) => i).filter(i => cells[i].active && !outer[i]), opts.protect || [], outer, M);
    return { cells, bgID, stats: { ...base.stats, ...st } };
  }

  root.MapGenerator = { generate, generatePatterns, nightmare, fever, learn, outerRegion };
})(typeof window !== 'undefined' ? window : globalThis);
