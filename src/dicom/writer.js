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
  LUT_DESCRIPTOR_SIGNED_TAGS,
  VR_SPECS,
  binaryValueUnitSize,
  validateVrValue,
} from './vrSpec.js';
import { getTransferSyntaxInfo, parseTagString, tagHex } from './dictionary.js';
import { encodeDicomString } from './charset.js';
import { getSopInstanceUid } from './uid.js';

const DICOMDIR_SOP_CLASS = '1.2.840.10008.1.3.10';
// Same Implementation Class UID the sample generator writes.
const IMPLEMENTATION_CLASS_UID = '1.2.826.0.1.3680043.8.498.1';
const DEIDENTIFIED_META_REMOVALS = new Set([
  '00020016', '00020017', '00020018', '00020026', '00020027', '00020028', '00020100', '00020102',
]);

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

function safeBigInt(str, unsigned = false) {
  try {
    const val = BigInt((str || '0').trim());
    return unsigned && val < 0n ? 0n : val;
  } catch {
    return 0n;
  }
}

function makeItemHeader(g, e, length, le) {
  if (length !== 0xffffffff && (length % 2 || length > 0xfffffffe)) throw new Error('Invalid DICOM Item length.');
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
export function encodeBinaryNumeric(value, vr, littleEndian, tag = '', original = null) {
  const raw = (value ?? '').trim();
  if (raw === '') return new Uint8Array(0);
  const parts = raw.split('\\').map((s) => s.trim()).filter((s) => s !== '');

  const spec = VR_SPECS[vr];
  const itemSize = spec?.fixedLength || 4;
  const buf = new Uint8Array(parts.length * itemSize);
  const view = new DataView(buf.buffer);
  const isSignedLutDesc = vr === 'SS' && LUT_DESCRIPTOR_SIGNED_TAGS.has(tag);
  const originalParts = original?.originalValue?.split('\\');
  const preserveFloatComponents = (vr === 'FL' || vr === 'FD') &&
    originalParts?.length === parts.length && original.rawBytes?.length === buf.length;

  for (let i = 0; i < parts.length; i++) {
    const off = i * itemSize;
    const str = parts[i];
    if (preserveFloatComponents && str === originalParts[i]) {
      buf.set(original.rawBytes.subarray(off, off + itemSize), off);
      continue;
    }
    switch (vr) {
      case 'US':
        view.setUint16(off, Math.max(0, Math.min(65535, Number(str) || 0)), littleEndian);
        break;
      case 'SS':
        if (isSignedLutDesc && i !== 1) {
          view.setUint16(off, Math.max(0, Math.min(65535, Number(str) || 0)), littleEndian);
        } else {
          view.setInt16(off, Math.max(-32768, Math.min(32767, Number(str) || 0)), littleEndian);
        }
        break;
      case 'UL':
        view.setUint32(off, (Number(str) || 0) >>> 0, littleEndian);
        break;
      case 'SL':
        view.setInt32(off, (Number(str) || 0) | 0, littleEndian);
        break;
      case 'FL':
        view.setFloat32(off, Number(str), littleEndian);
        break;
      case 'FD':
        view.setFloat64(off, Number(str), littleEndian);
        break;
      case 'SV':
        view.setBigInt64(off, safeBigInt(str, false), littleEndian);
        break;
      case 'UV':
        view.setBigUint64(off, safeBigInt(str, true), littleEndian);
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
function buildElementHeader(group, element, vr, valueLength, explicit, littleEndian, encodedVr) {
  if (valueLength !== 0xffffffff && (valueLength % 2 || valueLength > 0xfffffffe)) {
    throw new Error(`Invalid DICOM Value Length ${valueLength} for VR ${vr}.`);
  }
  if (!explicit) {
    const hdr = new Uint8Array(8);
    const v = new DataView(hdr.buffer);
    v.setUint16(0, group, littleEndian);
    v.setUint16(2, element, littleEndian);
    v.setUint32(4, valueLength >>> 0, littleEndian);
    return hdr;
  }

  const vrCode = encodedVr || (vr && vr.length === 2 ? vr : 'UN').toUpperCase();
  if (encodedVr || VR_32BIT_LENGTH.has(vrCode)) {
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
function serializeNode(node, explicit, littleEndian, charset, directory) {
  if (node.group === 0xfffe) {
    throw new Error(`DICOM delimiter tag ${node.formattedTag || '(FFFE,xxxx)'} cannot be serialized as a data element.`);
  }

  // 1) Sequence (SQ)
  if (node.isSequence) {
    const itemExplicit = explicit && !node.sequenceEncodedAsUn;
    const itemLittleEndian = node.sequenceEncodedAsUn || littleEndian;
    const itemChunks = [];
    let itemOffset = 12; // Directory Record Sequence is Explicit VR Little Endian.
    for (const item of node.items || []) {
      if (directory) directory.records.push({ original: item.offset, position: itemOffset });
      const recordLinks = directory ? (child, position, chunk) => {
        if (child.tag === '00041400' || child.tag === '00041420') {
          rememberDirectoryLink(directory.itemLinks, child, itemOffset + 8 + position, chunk);
        }
      } : undefined;
      const childBytes = serializeDatasetNodes(item.children || [], itemExplicit, itemLittleEndian, charset, recordLinks);
      if (item.undefinedLength) {
        itemChunks.push(makeItemHeader(0xfffe, 0xe000, 0xffffffff, itemLittleEndian));
        itemChunks.push(childBytes);
        itemChunks.push(makeItemHeader(0xfffe, 0xe00d, 0, itemLittleEndian));
      } else {
        itemChunks.push(makeItemHeader(0xfffe, 0xe000, childBytes.length, itemLittleEndian));
        itemChunks.push(childBytes);
      }
      itemOffset += 8 + childBytes.length + (item.undefinedLength ? 8 : 0);
    }

    if (node.undefinedLength) {
      const vr = node.sequenceEncodedAsUn ? 'UN' : 'SQ';
      const hdr = buildElementHeader(node.group, node.element, vr, 0xffffffff, explicit, littleEndian, node.encodedVr);
      const delim = makeItemHeader(0xfffe, 0xe0dd, 0, itemLittleEndian);
      return concatUint8Arrays([hdr, ...itemChunks, delim]);
    } else {
      const body = concatUint8Arrays(itemChunks);
      const hdr = buildElementHeader(node.group, node.element, 'SQ', body.length, explicit, littleEndian);
      return concatUint8Arrays([hdr, body]);
    }
  }

  // 2) Encapsulated PixelData or undefined-length raw binary — preserve verbatim with 0xFFFFFFFF header
  if ((node.encapsulated || node.undefinedLength) && node.rawBytes instanceof Uint8Array) {
    const hdr = buildElementHeader(node.group, node.element, node.vr, 0xffffffff, explicit, littleEndian, node.encodedVr);
    return concatUint8Arrays([hdr, node.rawBytes]);
  }

  // 3) Unchanged node with rawBytes — preserve verbatim!
  if (node.status === 'unchanged' && node.rawBytes instanceof Uint8Array &&
      (node.rawCharset === undefined || node.rawCharset === charset)) {
    let body = node.rawBytes;
    if (body.length % 2) {
      // Odd-length values from non-conformant files get the standard pad byte, as before; padding a
      // fixed-width numeric/word value would invent a component, so that is refused instead.
      if (binaryValueUnitSize(node.vr) !== 1) throw new Error(`Invalid Value Length for ${node.vr} at ${node.formattedTag}.`);
      body = padEven(body, NULL_PAD_VRS.has(node.vr) ? 0x00 : 0x20);
    }
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian, node.encodedVr);
    return concatUint8Arrays([hdr, body]);
  }

  // 4) Binary node (OB/OW/UN/etc.)
  if (node.isBinary) {
    const raw = node.rawBytes instanceof Uint8Array ? node.rawBytes : new Uint8Array(0);
    const unit = binaryValueUnitSize(node.vr);
    if (raw.length % unit) throw new Error(`Invalid Value Length for ${node.vr} at ${node.formattedTag}.`);
    const body = unit === 1 ? padEven(raw, 0x00) : raw;
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian, node.encodedVr);
    return concatUint8Arrays([hdr, body]);
  }

  // 5) Numeric or AT node
  if (NUMERIC_VRS.has(node.vr) || node.vr === 'AT') {
    const body = encodeBinaryNumeric(node.value, node.vr, littleEndian, node.tag, node.floatEncoding ?? node);
    const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
    return concatUint8Arrays([hdr, body]);
  }

  // 6) String node
  if (node.charsetError && node.rawBytes && node.rawCharset !== charset && node.value === node.originalValue) {
    throw new Error(`Cannot transcode ${node.formattedTag}: text could not be decoded with its original SpecificCharacterSet.`);
  }
  const rawStrBytes = encodeDicomString(node.value, node.vr, charset, node.tag || tagHex(node.group, node.element));
  const padByte = NULL_PAD_VRS.has(node.vr) ? 0x00 : 0x20;
  const body = padEven(rawStrBytes, padByte);
  const hdr = buildElementHeader(node.group, node.element, node.vr, body.length, explicit, littleEndian);
  return concatUint8Arrays([hdr, body]);
}

/**
 * Serialize a list of dataset nodes (sorted by Group, Element; excluding deleted nodes).
 */
function serializeDatasetNodes(nodes, explicit, littleEndian, inheritedCharset = '', onElement, directory) {
  const active = (nodes || [])
    .filter((n) => n.status !== 'deleted')
    .slice()
    .sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));

  // Determine dataset charset from (0008,0005) if present
  const csNode = active.find((n) => n.tag === '00080005');
  const charset = csNode ? csNode.value : inheritedCharset;

  // Preserve and recalculate any retired Group Length elements already present.
  const chunks = [];
  let i = 0;
  let position = 0;
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

    const memberChunks = groupMembers.map((n) => serializeNode(n, explicit, littleEndian, charset,
      n.tag === '00041220' ? directory : undefined));
    const membersTotalBytes = memberChunks.reduce((acc, c) => acc + c.length, 0);

    if (groupLenNode) {
      if (membersTotalBytes > 0xffffffff) throw new Error('DICOM Group Length exceeds its 32-bit field.');
      const lenBuf = new Uint8Array(4);
      new DataView(lenBuf.buffer).setUint32(0, membersTotalBytes >>> 0, littleEndian);
      const hdr = buildElementHeader(group, 0x0000, 'UL', 4, explicit, littleEndian);
      chunks.push(hdr, lenBuf);
      position += hdr.length + lenBuf.length;
    }
    for (let j = 0; j < memberChunks.length; j++) {
      const chunk = memberChunks[j];
      onElement?.(groupMembers[j], position, chunk);
      chunks.push(chunk);
      position += chunk.length;
    }
  }

  return concatUint8Arrays(chunks);
}

async function deflateRawBytes(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream not supported');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return padEven(new Uint8Array(await new Response(stream).arrayBuffer()), 0x00);
}

function rememberDirectoryLink(links, node, position, chunk) {
  if (node.vr !== 'UL' || chunk.length !== 12) throw new Error(`Invalid DICOMDIR record offset at ${node.formattedTag}.`);
  links.push({ position: position + 8, original: new DataView(chunk.buffer, chunk.byteOffset).getUint32(8, true) });
}

function relocateDirectoryOffsets(dataset, directory, datasetStart) {
  const sequenceStart = directory.sequenceStart;
  const positions = new Map(directory.records.filter(({ original }) => Number.isInteger(original))
    .map(({ original, position }) => [original, datasetStart + sequenceStart + position]));
  const view = new DataView(dataset.buffer, dataset.byteOffset, dataset.byteLength);
  for (const [links, base] of [[directory.rootLinks, 0], [directory.itemLinks, sequenceStart]]) {
    for (const link of links) {
      if (link.original === 0) continue;
      const position = positions.get(link.original);
      if (!position || position > 0xffffffff) {
        throw new Error(`DICOMDIR record offset ${link.original} does not refer to a retained directory record.`);
      }
      view.setUint32(base + link.position, position, true);
    }
  }
}

function upsertMediaUid(activeMeta, tag, value) {
  if (!value) return;
  const index = activeMeta.findIndex((node) => node.tag === tag);
  if (activeMeta[index]?.value === value) return;
  const node = { tag, group: 0x0002, element: parseInt(tag.slice(4), 16), vr: 'UI', value };
  if (index === -1) activeMeta.push(node);
  else activeMeta[index] = node;
}

function checkRequiredMeta(activeMeta) {
  const version = activeMeta.find((node) => node.tag === '00020001');
  if (version?.vr !== 'OB' || version.rawBytes?.length !== 2 || !(version.rawBytes[1] & 1)) {
    throw new Error('A Part 10 file requires File Meta Information Version (0002,0001).');
  }
  for (const tag of ['00020002', '00020003', '00020010', '00020012']) {
    const node = activeMeta.find((entry) => entry.tag === tag);
    if (node?.vr !== 'UI' || !node.value?.trim() || !validateVrValue('UI', node.value, tag).valid || node.value.includes('\\')) {
      throw new Error(`A Part 10 file requires a valid UID at (0002,${tag.slice(4)}).`);
    }
  }
  if (activeMeta.some((node) => node.group !== 0x0002 || (node.vr === 'UN' && !node.encodedVr))) {
    throw new Error('File Meta Information must contain group 0002 elements with known or future explicit VR headers.');
  }
}

/**
 * Serialize the complete edited DICOM document back into a valid Uint8Array (.dcm).
 * @param {object} doc
 * @returns {Promise<Uint8Array>}
 */
export async function writeDicomDocument(doc) {
  const parts = [];
  let directory;
  let mainOffset = 0;

  if (doc.hasPart10Header) {
    // 128-byte preamble + "DICM"
    const preamble = !doc.deidentified && doc.preamble?.length === 128
      ? doc.preamble
      : new Uint8Array(128);
    const dicm = new Uint8Array([0x44, 0x49, 0x43, 0x4d]);
    parts.push(preamble, dicm);

    // Serialize all active group 0002 nodes EXCEPT (0002,0000)
    const activeMeta = (doc.metaNodes || []).filter((n) => n.status !== 'deleted' && n.tag !== '00020000' &&
      (!doc.deidentified || !DEIDENTIFIED_META_REMOVALS.has(n.tag)));
    const mainClass = doc.datasetNodes.find((node) => node.tag === '00080016' && node.status !== 'deleted')?.value.trim();
    const metaClass = activeMeta.find((node) => node.tag === '00020002')?.value.trim();
    const isDicomDir = metaClass === DICOMDIR_SOP_CLASS || mainClass === DICOMDIR_SOP_CLASS;
    if (isDicomDir && mainClass && mainClass !== metaClass) {
      throw new Error('DICOMDIR requires its Media Storage Directory SOP Class.');
    }
    if (!isDicomDir) {
      const sopInstanceUid = getSopInstanceUid(doc);
      if (!sopInstanceUid && doc.datasetNodes.some((node) => node.tag === '00080018')) {
        throw new Error('A Part 10 file requires a non-empty SOP Instance UID (0008,0018).');
      }
      if (!mainClass && doc.datasetNodes.some((node) => node.tag === '00080016')) {
        throw new Error('A Part 10 file requires a non-empty SOP Class UID (0008,0016).');
      }
      upsertMediaUid(activeMeta, '00020002', mainClass);
      upsertMediaUid(activeMeta, '00020003', sopInstanceUid);
    } else {
      directory = { records: [], rootLinks: [], itemLinks: [], sequenceStart: 0 };
    }
    const syntaxNode = activeMeta.find((n) => n.tag === '00020010');
    const uid = syntaxNode ? syntaxNode.value.trim() : doc.transferSyntaxUid;
    const syntax = getTransferSyntaxInfo(uid);
    if (isDicomDir && uid !== '1.2.840.10008.1.2.1') {
      throw new Error('DICOMDIR requires Explicit VR Little Endian encoding.');
    }
    if (!uid || (doc.transferSyntaxUid && uid !== doc.transferSyntaxUid) ||
        syntax.explicit !== doc.explicit || syntax.littleEndian !== doc.littleEndian ||
        Boolean(syntax.deflated) !== Boolean(doc.wasDeflated)) {
      throw new Error('Transfer Syntax UID must match the original dataset encoding.');
    }
    if (!syntaxNode) {
      upsertMediaUid(activeMeta, '00020010', uid);
    }
    // Many real files never had these Type 1 elements; supply them instead of refusing to save.
    // An element the user explicitly deleted is still reported by checkRequiredMeta.
    const originalMeta = doc.metaNodes || [];
    if (!originalMeta.some((node) => node.tag === '00020001')) {
      activeMeta.push({ tag: '00020001', group: 0x0002, element: 0x0001, vr: 'OB', isBinary: true,
        rawBytes: Uint8Array.of(0x00, 0x01), value: '', status: 'unchanged' });
    }
    if (!originalMeta.some((node) => node.tag === '00020012')) {
      upsertMediaUid(activeMeta, '00020012', IMPLEMENTATION_CLASS_UID);
    }
    checkRequiredMeta(activeMeta);
    activeMeta.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
    const metaChunks = activeMeta.map((n) => serializeNode(n, true, true, ''));

    const metaBody = concatUint8Arrays(metaChunks);
    if (metaBody.length > 0xffffffff) throw new Error('File Meta Information exceeds its 32-bit Group Length field.');

    // Always write accurate (0002,0000) FileMetaInformationGroupLength
    const metaLenHeader = buildElementHeader(0x0002, 0x0000, 'UL', 4, true, true);
    const metaLenVal = new Uint8Array(4);
    new DataView(metaLenVal.buffer).setUint32(0, metaBody.length >>> 0, true);

    parts.push(metaLenHeader, metaLenVal, metaBody);
    mainOffset = preamble.length + dicm.length + metaLenHeader.length + metaLenVal.length + metaBody.length;
  }

  const rootLayout = directory ? (node, position, chunk) => {
    if (node.tag === '00041200' || node.tag === '00041202') rememberDirectoryLink(directory.rootLinks, node, position, chunk);
    if (node.tag === '00041220') directory.sequenceStart = position;
  } : undefined;
  const mainBytesRaw = serializeDatasetNodes(doc.datasetNodes, doc.explicit, doc.littleEndian, '', rootLayout, directory);
  if (directory) relocateDirectoryOffsets(mainBytesRaw, directory, mainOffset);
  parts.push(doc.wasDeflated ? await deflateRawBytes(mainBytesRaw) : mainBytesRaw);
  return concatUint8Arrays(parts);
}
