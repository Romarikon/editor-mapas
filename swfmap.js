// Escribe el SWF de un mapa para el cliente Dofus 1.x (data/maps/<id>_<fecha>[X].swf).
// Formato (visto en los mapas del cliente 1.43.7): un DoAction que define id, width, height, backgroundNum,
// ambianceId, musicId, bOutdoor, capabilities, mapData y permisos (canAggro, canUseInventory...).
// Exportamos SIN cifrar: fichero sin "X" y clave vacía en la base (cliente y servidor lo admiten).
const fs = require('fs'), path = require('path'), zlib = require('zlib');

// ---------------------------------------------------------------- AS2
const OP = { GetVariable: 0x1C, SetVariable: 0x1D, GetMember: 0x4E, CallMethod: 0x52, Pop: 0x17, Push: 0x96 };
function push(...vals) {
  const parts = vals.map(v => {
    if (typeof v === 'string') return Buffer.concat([Buffer.from([0]), Buffer.from(v, 'utf8'), Buffer.from([0])]);
    if (typeof v === 'boolean') return Buffer.from([5, v ? 1 : 0]);
    if (Number.isInteger(v)) { const b = Buffer.alloc(5); b[0] = 7; b.writeInt32LE(v, 1); return b; }
    throw new Error('valor no soportado: ' + v);
  });
  const data = Buffer.concat(parts);
  if (data.length > 0xffff) throw new Error('Push demasiado largo (' + data.length + ')');
  const h = Buffer.alloc(3); h[0] = OP.Push; h.writeUInt16LE(data.length, 1);
  return Buffer.concat([h, data]);
}
const op = c => Buffer.from([c]);
const setVar = (name, value) => Buffer.concat([push(name, value), op(OP.SetVariable)]);

function mapActions(m) {
  return Buffer.concat([
    // System.security.allowDomain(_parent._url) — igual que los mapas originales
    push('_parent'), op(OP.GetVariable), push('_url'), op(OP.GetMember), push(1, 'System'), op(OP.GetVariable),
    push('security'), op(OP.GetMember), push('allowDomain'), op(OP.CallMethod), op(OP.Pop),
    setVar('id', m.id), setVar('width', m.width), setVar('height', m.height),
    setVar('backgroundNum', m.backgroundNum | 0), setVar('ambianceId', m.ambianceId | 0), setVar('musicId', m.musicId | 0),
    setVar('bOutdoor', !!m.outdoor), setVar('capabilities', m.capabilities | 0), setVar('mapData', m.mapData),
    setVar('canAggro', m.canAggro !== false), setVar('canUseInventory', m.canUseInventory !== false),
    setVar('canUseObject', m.canUseObject !== false), setVar('canChangeCharac', m.canChangeCharac !== false),
    Buffer.from([0]), // ActionEnd
  ]);
}

// ---------------------------------------------------------------- SWF
function inflate(raw) {
  const sig = raw.toString('ascii', 0, 3);
  if (sig === 'CWS') return Buffer.concat([raw.subarray(0, 8), zlib.inflateSync(raw.subarray(8))]);
  if (sig === 'FWS') return Buffer.from(raw);
  throw new Error('formato SWF no soportado: ' + sig);
}
function tags(b) {
  const out = [], nbits = b[8] >> 3;
  let off = 8 + Math.ceil((5 + 4 * nbits) / 8) + 4;
  const headerEnd = off;
  while (off < b.length) {
    const start = off, h = b.readUInt16LE(off); let code = h >> 6, len = h & 63; off += 2;
    if (len === 63) { len = b.readUInt32LE(off); off += 4; }
    out.push({ code, start, body: off, len });
    off += len;
    if (code === 0) break;
  }
  return { headerEnd, list: out };
}

/** Crea el SWF del mapa a partir de un SWF de mapa del cliente usado como plantilla. */
function buildMapSwf(templateFile, m) {
  const b = inflate(fs.readFileSync(templateFile));
  const t = tags(b);
  const doAction = t.list.find(x => x.code === 12);
  if (!doAction) throw new Error('la plantilla no tiene DoAction');
  const body = mapActions(m);
  const header = Buffer.alloc(6); header.writeUInt16LE((12 << 6) | 63, 0); header.writeUInt32LE(body.length, 2);
  const out = Buffer.concat([b.subarray(0, doAction.start), header, body, b.subarray(doAction.body + doAction.len)]);
  out.write('FWS', 0, 'ascii'); out.writeUInt32LE(out.length, 4);
  return Buffer.concat([Buffer.from('CWS'), out.subarray(3, 8), zlib.deflateSync(out.subarray(8), { level: 9 })]);
}

/** Lee de vuelta las variables de un SWF de mapa (solo pushes literales, como los que escribimos). */
function readMapSwf(file) {
  const b = inflate(fs.readFileSync(file));
  const d = tags(b).list.find(x => x.code === 12);
  const vars = {}, stack = [];
  let p = d.body;
  while (p < d.body + d.len) {
    const c = b[p];
    if (c === 0) break;
    if (c >= 0x80) {
      const l = b.readUInt16LE(p + 1);
      if (c === OP.Push) {
        let q = p + 3;
        while (q < p + 3 + l) {
          const t = b[q++];
          if (t === 0) { const e = b.indexOf(0, q); stack.push(b.toString('utf8', q, e)); q = e + 1; }
          else if (t === 5) stack.push(!!b[q++]);
          else if (t === 7) { stack.push(b.readInt32LE(q)); q += 4; }
          else { stack.push(null); break; } // tipos que no usamos (constantes, doubles…)
        }
      }
      p += 3 + l;
    } else {
      if (c === OP.SetVariable) { const v = stack.pop(), k = stack.pop(); vars[k] = v; }
      p += 1;
    }
  }
  return vars;
}

/** Fecha de versión del mapa en el formato del cliente (yyMMddHHmm). */
function mapDate(d = new Date()) {
  const z = n => String(n).padStart(2, '0');
  return z(d.getFullYear() % 100) + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes());
}

module.exports = { buildMapSwf, readMapSwf, mapDate, mapActions };
