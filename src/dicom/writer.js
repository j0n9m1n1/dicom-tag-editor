/**
 * Byte-preserving (Round-trip Safe) DICOM binary writer.
 * - Unmodified tags & PixelData keep their exact original rawBytes untouched.
 * - Modified/added tags are encoded strictly per DICOM PS3.5 VR & padding rules.
 * - Group 0002 FileMetaInformationGroupLength (0002,0000) is always recalculated.
 * - Sequences (SQ) preserve defined/undefined length semantics and recalculate lengths accurately.
 */

import {
  VR_32BIT_LENGTH,
  NUMERIC_VRS,
  NULL_PAD_VRS,
  VR_SPECS,
} from './vrSpec.js';
import { parseTagString } from './dictionary.js';
import { encodeDicomString } from './charset.js';

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function makeUint16Pair(g, e, le) {
  const buf = new Uint8Array(4);
  const v = new DataView(buf.buffer);
  v.setUint16(0, g, le);
  v.setUint16(2, e, le);
  return buf;
}

function makeItemHeader(g, e, length, le) {
  const buf = new Uint8Array(8);
  const v = new DataView(buf.buffer);
  v.setUint16(0, g, le);
  v.setUint16(2, e, le);
  v.setUint32(4, length >>> 0, le);
  return buf;
}

function padEven(bytes, padByte) {
  if ((bytes.length & 1) === 0) return bytes;
  const padded = new Uint8Array(bytes.length + 1);
  padded.set(bytes, 0);
  padded[bytes.length] = padByte;
  return padded;
}

/**
 * Encode numeric / AT value string into binary bytes.
 */
function encodeBinaryNumeric(value, vr, littleEndian) {
  const raw = (value ?? '').trim();
  if (raw === '') return new Uint8Array(0);
  const parts = raw.split('\\').map((s) => s.trim()).filter((s) => s !== '');

  const spec = VR_SPECS[vr];
  const itemSize = spec?.fixedLength || 4;
  const buf = new Uint8Array(parts.length * itemSize);
  const view = new DataView(buf.buffer);

  for (let i = 0; i < parts.length; i++) {
    const off = i * itemSize;
    const str = parts[i];
    switch (vr) {
      case 'US':
        view.setUint16(off, Math.max(0, Math.min(65535, Number(str) || 0)), littleEndian);
        break;
      case 'SS':
        view.setInt16(off, Math.max(-32768, Math.min(32767, Number(str) || 0)), littleEndian);
        break;
      case 'UL':
        view.setUint32(off, (Number(str) || 0) >>> 0, littleEndian);
        break;
      case 'SL':
        view.setInt32(off, (Number(str) || 0) | 0, littleEndian);
        break;
      case 'FL':
        view.setFloat32(off, Number(str) || 0, littleEndian);
        break;
      case 'FD':
        view.setFloat64(off, Number(str) || 0, littleEndian);
        break;
      case 'SV':
        view.setBigInt64(off, BigInt(str || '0'), littleEndian);
        break;
      case 'UV':
        view.setBigUint64(off, BigInt(str || '0'), littleEndian);
        break;
      case 'AT': {
        const parsed = parseTagString(str);
        if (parsed) {
          view.setUint16(off, parsed.group, littleEndian);
          view.setUint16(off + 2, parsed.element, littleEndian);
        }
        break;
      }
      default:
        break;
    }
  }
  return buf;
}

/**
 * Serialize a single element's header (tag + VR + length).
 */
function buildElementHeader(group, element, vr, valueLength, explicit, littleEndian) {
  if (!explicit) {
    const hdr = new Uint8Array(8);
    const v = new DataView(hdr.buffer);
    v.setUint16(0, group, littleEndian);
    v.setUint16(2, element, littleEndian);
    v.setUint32(4, valueLength >>> 0, littleEndian);
    return hdr;
  }

  const vrCode = (vr && vr.length === 2 ? vr : 'UN').toUpperCase();
  if (VR_32BIT_LENGTH.has(vrCode)) {
    const hdr = new Uint8Array(12);
    const v = new DataView(hdr.buffer);
    v.setUint16(0, group, littleEndian);
    v.setUint16(2, element, littleEndian);
    hdr[4] = vrCode.charCodeAt(0);
    hdr[5] = vrCode.charCodeAt(1);
    hdr[6] = 0;
    hdr[7] = 0;
    v.setUint32(8, valueLength >>> 0, littleEndian);
    return hdr;
  }

  // Standard 16-bit explicit VR length
  if (valueLength > 0xffff) {
    // Safety guard: fallback to 32-bit UN if value exceeds 65535 bytes on a 16-bit VR
    const hdr = new Uint8Array(12);
    const v = new DataView(hdr.buffer);
    v.setUint16(0, group, littleEndian);
    v.setUint16(2, element, littleEndian);
    hdr[4] = 85; // 'U'
    hdr[5] = 78; // 'N'
    hdr[6] = 0;
    hdr[7] = 0;
    v.setUint32(8, valueLength >>> 0, littleEndian);
    return hdr;
  }

  const hdr = new Uint8Array(8);
  const v = new DataView(hdr.buffer);
  v.setUint16(0, group, littleEndian);
  v.setUint16(2, element, littleEndian);
  hdr[4] = vrCode.charCodeAt(0);
  hdr[5] = vrCode.charCodeAt(1);
  v.setUint16(6, valueLength, littleEndian);
  return hdr;
}

/**
 * Serialize a single node (including SQ recursion).
 */
function serializeNode(node, explicit, littleEndian, charset) {
  // 1) Sequence (SQ)
  if (node.isSequence) {
    const itemChunks = [];
    for (const item of node.items || []) {
      const childBytes = serializeDatasetNodes(item.children || [], explicit, littleEndian, charset);
      if (item.undefinedLength) {
        itemChunks.push(makeItemHeader(0xfffe, 0xe000, 0xffffffff, littleEndian));
        itemChunks.push(childBytes);
        itemChunks.push(makeItemHeader(0xfffe, 0xe00d, 0, littleEndian));
      } else {
        itemChunks.push(makeItemHeader(0xfffe, 0xe000, childBytes.length, littleEndian));
        itemChunks.push(childBytes);
      }
    }

    if (node.undefinedLength) {
      const hdr = buildElementHeader(node.group, node.element, 'SQ', 0xffffffff, explicit, littleEndian);
      const delim = makeItemHeader(0xfffe, 0xe0dd, 0, littleEndian);
      return concatUint8Arrays([hdr, ...itemChunks, delim]);
    } else {
      const body = concatUint8Arrays(itemChunks);
      const hdr = buildElementHeader(node.group, node.element, 'SQ', body.length, explicit, littleEndian);
      return concatUint8Arrays([hdr, body]);
    }
  }

  // 2) Encapsulated PixelData (undefined length) — preserve raw bytes verbatim
  if (node.encapsulated && node.rawBytes) {
    const hdr = buildElementHeader(node.group, node.element, node.vr, 0xffffffff, explicit, littleEndian);
    return concatUint8Arrays([hdr, node.rawBytes]);
  }

  // 3) Unchanged node with rawBytes — preserve verbatim!
  if (node.status === 'unchanged' && node.rawBytes instanceof Uint8Array) {
    const body = padEven(node.rawBytes, NULL_PAD_VRS.has(node.vr) ? 0x00 : 0x20);
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
    return concatUint8Arrays([hdr, body]);
  }

  // 4) Binary node (OB/OW/UN/etc.)
  if (node.isBinary) {
    const raw = node.rawBytes instanceof Uint8Array ? node.rawBytes : new Uint8Array(0);
    const body = padEven(raw, 0x00);
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
    return concatUint8Arrays([hdr, body]);
  }

  // 5) Numeric or AT node
  if (NUMERIC_VRS.has(node.vr) || node.vr === 'AT') {
    const body = encodeBinaryNumeric(node.value, node.vr, littleEndian);
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
    return concatUint8Arrays([hdr, body]);
  }

  // 6) String node
  const rawStrBytes = encodeDicomString(node.value, node.vr, charset);
  const padByte = NULL_PAD_VRS.has(node.vr) ? 0x00 : 0x20;
  const body = padEven(rawStrBytes, padByte);
  const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
  return concatUint8Arrays([hdr, body]);
}

/**
 * Serialize a list of dataset nodes (sorted by Group, Element; excluding deleted nodes).
 */
function serializeDatasetNodes(nodes, explicit, littleEndian, inheritedCharset = '') {
  const active = (nodes || [])
    .filter((n) => n.status !== 'deleted')
    .slice()
    .sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));

  // Determine dataset charset from (0008,0005) if present
  const csNode = active.find((n) => n.tag === '00080005');
  const charset = csNode ? csNode.value : inheritedCharset;

  // Skip retired non-meta group length tags (xxxx,0000) if dataset was modified, or recalculate them accurately
  // Grouping by group number lets us recalculate any existing (xxxx,0000) accurately!
  const chunks = [];
  let i = 0;
  while (i < active.length) {
    const group = active[i].group;
    let groupLenNode = null;
    const groupMembers = [];

    while (i < active.length && active[i].group === group) {
      if (active[i].element === 0x0000) {
        groupLenNode = active[i];
      } else {
        groupMembers.push(active[i]);
      }
      i++;
    }

    const memberChunks = groupMembers.map((n) => serializeNode(n, explicit, littleEndian, charset));
    const membersTotalBytes = memberChunks.reduce((acc, c) => acc + c.length, 0);

    if (groupLenNode) {
      const lenBuf = new Uint8Array(4);
      new DataView(lenBuf.buffer).setUint32(0, membersTotalBytes >>> 0, littleEndian);
      const hdr = buildElementHeader(group, 0x0000, 'UL', 4, explicit, littleEndian);
      chunks.push(hdr, lenBuf);
    }
    for (const c of memberChunks) chunks.push(c);
  }

  return concatUint8Arrays(chunks);
}

async function deflateRawBytes(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not supported');
  }
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Serialize the complete edited DICOM document back into a valid Uint8Array (.dcm).
 * @param {object} doc
 * @returns {Promise<Uint8Array>}
 */
export async function writeDicomDocument(doc) {
  const parts = [];

  // Serialize Main Dataset first so we know if deflation succeeded
  const mainBytesRaw = serializeDatasetNodes(
    doc.datasetNodes,
    doc.explicit,
    doc.littleEndian,
    ''
  );

  let mainBytes = mainBytesRaw;
  let forceExplicitTs = false;
  if (doc.wasDeflated) {
    try {
      mainBytes = await deflateRawBytes(mainBytesRaw);
    } catch {
      forceExplicitTs = true;
    }
  }

  if (doc.hasPart10Header) {
    // 128-byte preamble + "DICM"
    const preamble = doc.preamble && doc.preamble.length === 128
      ? doc.preamble
      : new Uint8Array(128);
    const dicm = new Uint8Array([0x44, 0x49, 0x43, 0x4d]);
    parts.push(preamble, dicm);

    // Serialize all active group 0002 nodes EXCEPT (0002,0000)
    const activeMeta = (doc.metaNodes || [])
      .filter((n) => n.status !== 'deleted' && n.tag !== '00020000')
      .slice()
      .sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));

    const metaChunks = activeMeta.map((n) => {
      if (forceExplicitTs && n.tag === '00020010') {
        const patched = { ...n, value: '1.2.840.10008.1.2.1', status: 'modified' };
        return serializeNode(patched, true, true, '');
      }
      return serializeNode(n, true, true, '');
    });

    const metaBody = concatUint8Arrays(metaChunks);

    // Always write accurate (0002,0000) FileMetaInformationGroupLength
    const metaLenHeader = buildElementHeader(0x0002, 0x0000, 'UL', 4, true, true);
    const metaLenVal = new Uint8Array(4);
    new DataView(metaLenVal.buffer).setUint32(0, metaBody.length >>> 0, true);

    parts.push(metaLenHeader, metaLenVal, metaBody);
  }

  parts.push(mainBytes);
  return concatUint8Arrays(parts);
}
