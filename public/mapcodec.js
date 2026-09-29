// Códec de mapas Dofus 1.x (portado de ank.battlefield.utils.Compressor y dofus.aks.Aks del cliente 1.29).
// Funciona en Node (require) y en el navegador (window.MapCodec).
(function (root) {
  const ZK = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const HEX = '0123456789ABCDEF';
  const hash = {}; for (let i = 0; i < ZK.length; i++) hash[ZK[i]] = i;

  // Constantes isométricas (ank.battlefield.Constants)
  const CELL_WIDTH = 53, CELL_HALF_WIDTH = 26.5, CELL_HALF_HEIGHT = 13.5, LEVEL_HEIGHT = 20;

  const unesc = s => (typeof unescape === 'function' ? unescape(s) : decodeURIComponent(s));

  function prepareKey(d) {
    let s = '';
    for (let i = 0; i < d.length; i += 2) s += String.fromCharCode(parseInt(d.substr(i, 2), 16));
    return unesc(s);
  }
  function checksum(s) {
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i) % 16;
    return HEX[sum % 16];
  }
  function decypher(d, k, c) {
    let s = '', n = 0;
    for (let i = 0; i < d.length; i += 2) s += String.fromCharCode(parseInt(d.substr(i, 2), 16) ^ k.charCodeAt((n++ + c) % k.length));
    return unesc(s);
  }
  /** mapData tal cual la base; si hay clave, se descifra como hace el cliente. */
  function decryptMapData(mapData, key) {
    if (!key) return mapData;
    const k = prepareKey(key);
    return decypher(mapData, k, parseInt(checksum(k), 16) * 2);
  }

  function decodeCell(s) {
    const v = []; for (let i = 0; i < 10; i++) v[i] = hash[s[i]] | 0;
    return {
      active: !!((v[0] & 32) >> 5),
      lineOfSight: !!(v[0] & 1),
      layerGroundRot: (v[1] & 48) >> 4,
      groundLevel: v[1] & 15,
      movement: (v[2] & 56) >> 3,
      layerGroundNum: ((v[0] & 24) << 6) + ((v[2] & 7) << 6) + v[3],
      groundSlope: (v[4] & 60) >> 2,
      layerGroundFlip: !!((v[4] & 2) >> 1),
      layerObject1Num: ((v[0] & 4) << 11) + ((v[4] & 1) << 12) + (v[5] << 6) + v[6],
      layerObject1Rot: (v[7] & 48) >> 4,
      layerObject1Flip: !!((v[7] & 8) >> 3),
      layerObject2Flip: !!((v[7] & 4) >> 2),
      layerObject2Interactive: !!((v[7] & 2) >> 1),
      layerObject2Num: ((v[0] & 2) << 12) + ((v[7] & 1) << 12) + (v[8] << 6) + v[9],
    };
  }
  function encodeCell(c) {
    const v = new Array(10).fill(0);
    v[0] = ((c.active ? 1 : 0) << 5) | (c.lineOfSight ? 1 : 0) | ((c.layerGroundNum & 1536) >> 6)
         | ((c.layerObject1Num & 8192) >> 11) | ((c.layerObject2Num & 8192) >> 12);
    v[1] = ((c.layerGroundRot & 3) << 4) | (c.groundLevel & 15);
    v[2] = ((c.movement & 7) << 3) | ((c.layerGroundNum >> 6) & 7);
    v[3] = c.layerGroundNum & 63;
    v[4] = ((c.groundSlope & 15) << 2) | ((c.layerGroundFlip ? 1 : 0) << 1) | ((c.layerObject1Num >> 12) & 1);
    v[5] = (c.layerObject1Num >> 6) & 63;
    v[6] = c.layerObject1Num & 63;
    v[7] = ((c.layerObject1Rot & 3) << 4) | ((c.layerObject1Flip ? 1 : 0) << 3) | ((c.layerObject2Flip ? 1 : 0) << 2)
         | ((c.layerObject2Interactive ? 1 : 0) << 1) | ((c.layerObject2Num >> 12) & 1);
    v[8] = (c.layerObject2Num >> 6) & 63;
    v[9] = c.layerObject2Num & 63;
    return v.map(x => ZK[x]).join('');
  }

  function decodeCells(data) { const cells = []; for (let i = 0; i + 10 <= data.length; i += 10) cells.push(decodeCell(data.substr(i, 10))); return cells; }
  function encodeCells(cells) { return cells.map(encodeCell).join(''); }

  /** Posición en píxeles de cada celda (misma iteración que MapHandler.build del cliente). */
  function cellPositions(cells, width) {
    const out = []; let col = -1, row = 0, offX = 0, rowLen = width - 1;
    for (let i = 0; i < cells.length; i++) {
      if (col === rowLen) {
        col = 0; row++;
        if (offX === 0) { offX = CELL_HALF_WIDTH; rowLen--; } else { offX = 0; rowLen++; }
      } else col++;
      out.push({ x: col * CELL_WIDTH + offX, y: row * CELL_HALF_HEIGHT - LEVEL_HEIGHT * (cells[i].groundLevel - 7) });
    }
    return out;
  }

  // Casillas de combate: "equipo0|equipo1", 2 caracteres por celda
  const cellToCode = id => ZK[(id / 64) | 0] + ZK[id % 64];
  const codeToCell = s => hash[s[0]] * 64 + hash[s[1]];
  function decodePlaces(p) {
    const [a = '', b = ''] = (p || '').split('|');
    const dec = s => { const r = []; for (let i = 0; i + 2 <= s.length; i += 2) r.push(codeToCell(s.substr(i, 2))); return r; };
    return [dec(a), dec(b)];
  }
  function encodePlaces(t0, t1) { return t0.map(cellToCode).join('') + '|' + t1.map(cellToCode).join(''); }

  const api = { ZK, CELL_WIDTH, CELL_HALF_WIDTH, CELL_HALF_HEIGHT, LEVEL_HEIGHT, prepareKey, checksum, decypher, decryptMapData,
    decodeCell, encodeCell, decodeCells, encodeCells, cellPositions, decodePlaces, encodePlaces, cellToCode, codeToCell };
  if (typeof module !== 'undefined') module.exports = api; else root.MapCodec = api;
})(typeof window !== 'undefined' ? window : globalThis);
