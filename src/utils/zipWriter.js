/**
 * Zero-dependency standard PKZIP (Store / method 0) archive builder.
 * Supports UTF-8 filenames (general purpose bit 11) and IEEE 802.3 CRC-32.
 */

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  if (date.getFullYear() > 2107) return { dosTime: 0xbf7d, dosDate: 0xff9f }; // 2107-12-31 23:59:58
  if (!(date.getFullYear() >= 1980)) return { dosTime: 0, dosDate: 0x0021 }; // 1980-01-01 00:00:00
  const year = date.getFullYear();
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Create a valid .zip Uint8Array from an array of { name: string, data: Uint8Array }.
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function buildZipArchive(entries, { date = new Date() } = {}) {
  if (entries.length >= 0xffff) throw new Error('Too many entries for a classic ZIP archive (ZIP64 is unsupported).');
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = dosDateTime(date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  // Deduplicate filenames safely
  const usedNames = new Set();
  const nextSuffix = new Map();
  const nameKey = (name) => name.normalize('NFC').toLowerCase();
  const uniqueName = (rawName) => {
    const segments = String(rawName || 'file.dcm')
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..');
    const clean = segments.length > 0 ? segments.join('/') : 'file.dcm';
    if (!usedNames.has(nameKey(clean))) {
      usedNames.add(nameKey(clean));
      return clean;
    }
    const dot = clean.lastIndexOf('.');
    const slash = clean.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    const base = hasExt ? clean.slice(0, dot) : clean;
    const ext = hasExt ? clean.slice(dot) : '';
    const key = nameKey(clean);
    let idx = nextSuffix.get(key) || 2;
    while (usedNames.has(nameKey(`${base}_${idx}${ext}`))) idx++;
    const candidate = `${base}_${idx}${ext}`;
    nextSuffix.set(key, idx + 1);
    usedNames.add(nameKey(candidate));
    return candidate;
  };

  let cdSize = 0;
  let totalLocalSize = 0;
  const prepared = entries.map((entry) => {
    const nameStr = uniqueName(entry.name);
    const nameBytes = encoder.encode(nameStr);
    if (nameBytes.length > 0xffff) throw new Error('UTF-8 ZIP entry name exceeds 65,535 bytes.');
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    totalLocalSize += 30 + nameBytes.length + data.length;
    cdSize += 46 + nameBytes.length;
    if (data.length >= 0xffffffff || totalLocalSize + cdSize + 22 >= 0xffffffff) {
      throw new Error('Archive exceeds the classic ZIP size limit (ZIP64 is unsupported).');
    }
    return { nameBytes, data };
  });

  for (const { nameBytes, data } of prepared) {
    const crc = crc32(data);
    const size = data.length;

    // Local File Header (30 bytes + filename)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true);         // Version needed (2.0)
    lv.setUint16(6, 0x0800, true);     // UTF-8 filename flag
    lv.setUint16(8, 0, true);          // Compression method: 0 (store)
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);         // Extra field length
    lfh.set(nameBytes, 30);

    localParts.push(lfh, data);

    // Central Directory Header (46 bytes + filename)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true);         // Version made by
    cv.setUint16(6, 20, true);         // Version needed
    cv.setUint16(8, 0x0800, true);     // UTF-8 flag
    cv.setUint16(10, 0, true);         // Compression: store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);         // Extra length
    cv.setUint16(32, 0, true);         // Comment length
    cv.setUint16(34, 0, true);         // Disk start
    cv.setUint16(36, 0, true);         // Internal attrs
    cv.setUint32(38, 0, true);         // External attrs
    cv.setUint32(42, offset, true); // Local header offset
    cdh.set(nameBytes, 46);

    centralParts.push(cdh);
    offset += lfh.length + data.length;
  }

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + cdSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}
