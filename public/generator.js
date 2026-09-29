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

  root.MapGenerator = { generate, learn, outerRegion };
})(typeof window !== 'undefined' ? window : globalThis);
