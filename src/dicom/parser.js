/**
 * Byte-preserving DICOM binary parser.
 * Supports Part 10 & Raw DICOM, Explicit/Implicit VR, Little/Big Endian,
 * Deflated Explicit VR, Nested Sequences (defined & undefined length),
 * and Encapsulated PixelData fragment extraction.
 */

import {
  VR_32BIT_LENGTH,
  BINARY_VRS,
  NUMERIC_VRS,
  LUT_DESCRIPTOR_SIGNED_TAGS,
  VR_SPECS,
  binaryValueUnitSize,
  validateVrValue,
} from './vrSpec.js';
import {
  formatTag,
  tagHex,
  lookupTag,
  getTransferSyntaxInfo,
  PIXEL_REP_SIGNED_TAGS,
} from './dictionary.js';
import { decodeDicomText, usesSpecificCharacterSet } from './charset.js';
import { basicOffsetFrameStarts } from './encapsulation.js';

let _nextNodeId = 1;
export function genNodeId() {
  return `n_${_nextNodeId++}`;
}

export function resetNodeIdCounter() {
  _nextNodeId = 1;
}

const VALID_VR_SET = new Set(Object.keys(VR_SPECS));
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_SEQUENCE_DEPTH = 128;

export class DicomParseError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, any>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DicomParseError';
    this.code = code;
    this.details = details;
  }
}

function toAsciiPreview(slice) {
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i];
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  }
  return out;
}

function toHexLine(slice) {
  return Array.from(slice, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function buildHeaderPreview(bytes) {
  const head = bytes.subarray(0, Math.min(16, bytes.length));
  const preview = {
    headHex: toHexLine(head),
    headAscii: toAsciiPreview(head),
    offset128Hex: null,
    offset128Ascii: null,
  };
  if (bytes.length >= 132) {
    const mid = bytes.subarray(128, Math.min(136, bytes.length));
    preview.offset128Hex = toHexLine(mid);
    preview.offset128Ascii = toAsciiPreview(mid);
  }
  return preview;
}

function detectNonDicomSignature(bytes) {
  const n = bytes.length;
  const startsWith = (...sig) => n >= sig.length && sig.every((b, i) => bytes[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'PNG Image (89 50 4E 47)';
  if (startsWith(0xff, 0xd8, 0xff)) return 'JPEG Image (FF D8 FF)';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'GIF Image (GIF8)';
  if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'PDF Document (%PDF-)';
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) return 'ZIP / Office Archive (PK)';
  if (startsWith(0x1f, 0x8b)) return 'GZIP Archive (.gz / .nii.gz)';
  if (startsWith(0x52, 0x61, 0x72, 0x21)) return 'RAR Archive (Rar!)';
  if (startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7-Zip Archive (7z)';
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return 'TIFF Image';
  if (n >= 12 && startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'WebP Image (RIFF/WEBP)';
  }
  if (startsWith(0x42, 0x4d)) return 'BMP Image (BM)';
  if (startsWith(0x4d, 0x5a)) return 'Windows Executable (MZ)';
  // NIfTI-1 magic at offset 344 ("n+1\0" or "ni1\0")
  if (
    n >= 348 &&
    bytes[344] === 0x6e &&
    (bytes[345] === 0x2b || bytes[345] === 0x69) &&
    bytes[346] === 0x31 &&
    bytes[347] === 0x00
  ) {
    return 'NIfTI-1 Medical Volume (.nii)';
  }

  // Check for HTML / XML / JSON / plain UTF-8 text
  const sampleLen = Math.min(n, 96);
  if (sampleLen > 0) {
    let start = 0;
    if (startsWith(0xef, 0xbb, 0xbf)) start = 3; // UTF-8 BOM
    let printable = 0;
    for (let i = start; i < sampleLen; i++) {
      const b = bytes[i];
      if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0xc2) {
        printable++;
      }
    }
    const checked = sampleLen - start;
    if (checked > 0 && printable / checked >= 0.95) {
      const textStart = toAsciiPreview(bytes.subarray(start, Math.min(n, start + 32))).trimStart();
      if (/^<!doctype\s+html|^<html/i.test(textStart)) return 'HTML Document';
      if (/^<\?xml|^<[a-z]/i.test(textStart)) return 'XML / Markup Text';
      if (/^[\[{]/.test(textStart)) return 'JSON / Text Data';
      return 'Plain Text File';
    }
  }
  return null;
}

function isKnownVr(twoChars) {
  return VALID_VR_SET.has(twoChars);
}

async function decompressBytes(input, format, limit, offset) {
  if (typeof DecompressionStream === 'undefined') {
    throw new DicomParseError(
      'DEFLATE_FAILED',
      `This browser does not support DICOM ${format} decompression.`,
      { offset }
    );
  }
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new DicomParseError('RESOURCE_LIMIT', `Decompressed DICOM data exceeds the ${formatByteSize(limit)} limit.`, {
          offset, limit, format,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.length;
  }
  return bytes;
}

async function inflateRawBytes(compressed, offset, limit) {
  try {
    return await decompressBytes(compressed, 'deflate-raw', limit, offset);
  } catch (err) {
    if (err instanceof DicomParseError) throw err;
    // PS3.5 A.5 permits one trailing NUL after an odd-length stream.
    if (compressed.length % 2 === 0 && compressed.at(-1) === 0) {
      try {
        return await decompressBytes(compressed.subarray(0, -1), 'deflate-raw', limit, offset);
      } catch (retryError) {
        if (retryError instanceof DicomParseError) throw retryError;
        err = retryError;
      }
    }
    throw new DicomParseError('DEFLATE_FAILED', `Deflated dataset decompression failed: ${err.message || err}`, { offset });
  }
}

function formatFloat(value, single = false) {
  if (Object.is(value, -0)) return '-0';
  if (single && Number.isFinite(value)) {
    // Shortest decimal that maps back to the same float32 (e.g. "0.1", not "0.10000000149011612").
    for (let digits = 1; digits <= 9; digits++) {
      const candidate = Number(value.toPrecision(digits));
      if (Math.fround(candidate) === value) return String(candidate);
    }
  }
  return String(value);
}

/**
 * Decode numeric or AT binary values into display/editable string (backslash-separated for VM > 1).
 */
export function decodeBinaryNumeric(bytes, vr, littleEndian, tag = '') {
  if (!bytes || bytes.length === 0) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vals = [];

  switch (vr) {
    case 'US':
      for (let i = 0; i + 2 <= bytes.length; i += 2) vals.push(String(view.getUint16(i, littleEndian)));
      break;
    case 'SS': {
      const isSignedLutDesc = LUT_DESCRIPTOR_SIGNED_TAGS.has(tag);
      for (let i = 0, idx = 0; i + 2 <= bytes.length; i += 2, idx++) {
        const num = isSignedLutDesc && idx !== 1
          ? view.getUint16(i, littleEndian)
          : view.getInt16(i, littleEndian);
        vals.push(String(num));
      }
      break;
    }
    case 'UL':
      for (let i = 0; i + 4 <= bytes.length; i += 4) vals.push(String(view.getUint32(i, littleEndian)));
      break;
    case 'SL':
      for (let i = 0; i + 4 <= bytes.length; i += 4) vals.push(String(view.getInt32(i, littleEndian)));
      break;
    case 'FL':
      for (let i = 0; i + 4 <= bytes.length; i += 4) {
        vals.push(formatFloat(view.getFloat32(i, littleEndian), true));
      }
      break;
    case 'FD':
      for (let i = 0; i + 8 <= bytes.length; i += 8) {
        vals.push(formatFloat(view.getFloat64(i, littleEndian)));
      }
      break;
    case 'SV':
      for (let i = 0; i + 8 <= bytes.length; i += 8) {
        vals.push(view.getBigInt64(i, littleEndian).toString());
      }
      break;
    case 'UV':
      for (let i = 0; i + 8 <= bytes.length; i += 8) {
        vals.push(view.getBigUint64(i, littleEndian).toString());
      }
      break;
    case 'AT':
      for (let i = 0; i + 4 <= bytes.length; i += 4) {
        const g = view.getUint16(i, littleEndian);
        const e = view.getUint16(i + 2, littleEndian);
        vals.push(formatTag(g, e));
      }
      break;
    default:
      return '';
  }
  return vals.join('\\');
}

/**
 * Compute VM (Value Multiplicity) of a node.
 */
export function computeVm(node) {
  if (node.isSequence) return node.items ? node.items.length : 0;
  if (node.isBinary) return node.rawLength > 0 ? 1 : 0;
  const val = node.value ?? '';
  if (val === '') return 0;
  const spec = VR_SPECS[node.vr];
  if (spec && !spec.allowMultiValue) return 1;
  return val.split('\\').length;
}

function readExplicitHeader(bytes, view, pos, end, littleEndian, tag) {
  const code = String.fromCharCode(bytes[pos], bytes[pos + 1]);
  const known = isKnownVr(code);
  if (!known && (!/^[A-Z]{2}$/.test(code) || bytes[pos + 2] !== 0 || bytes[pos + 3] !== 0)) {
    throw new DicomParseError('INVALID_VR', `Invalid Explicit VR at ${tag}.`, { tag, offset: pos });
  }
  if (known && !VR_32BIT_LENGTH.has(code)) {
    return { vr: code, length: view.getUint16(pos + 2, littleEndian), next: pos + 4 };
  }
  if (pos + 8 > end) {
    throw new DicomParseError('TRUNCATED_HEADER', `Truncated DICOM header at ${tag}.`, {
      tag, offset: pos - 4, availableBytes: end - pos + 4,
    });
  }
  return { vr: known ? code : 'UN', encodedVr: known ? undefined : code, length: view.getUint32(pos + 4, littleEndian), next: pos + 8 };
}

/** Rank raw transfer syntaxes by a bounded, allocation-free probe of element headers. */
function detectRawSyntax(bytes, view, startOffset) {
  const probe = (explicit, littleEndian) => {
    let position = startOffset;
    let score = 0;
    let previous = -1;
    for (let i = 0; i < 12 && position + 8 <= bytes.length; i++) {
      const group = view.getUint16(position, littleEndian);
      const element = view.getUint16(position + 2, littleEndian);
      const tagNumber = group * 65536 + element;
      const info = lookupTag(group, element);
      if (group === 0xfffe || group === 0xffff) return score - 8;
      if (tagNumber <= previous) score -= 3;
      previous = tagNumber;
      let header;
      try {
        header = explicit ? readExplicitHeader(bytes, view, position + 4, bytes.length, littleEndian, info.formattedTag)
          : { vr: info.vr, length: view.getUint32(position + 4, littleEndian), next: position + 8 };
      } catch {
        return score - 8;
      }
      if (info.keyword !== 'UnknownTag') score += header.vr === info.vr ? 6 : 3;
      if (explicit && !header.encodedVr) score += 1;
      if (header.length === 0xffffffff && (header.vr === 'SQ' || header.vr === 'UN' || info.tag === '7FE00010')) {
        return score + (header.next + 8 <= bytes.length ? 1 : -8);
      }
      position = header.next + header.length;
      if (header.length % 2 || position > bytes.length) return score - 8;
      score += 2;
      if (position === bytes.length) return score + 3;
    }
    return score;
  };
  const candidates = [
    ['1.2.840.10008.1.2.1', probe(true, true)],
    ['1.2.840.10008.1.2', probe(false, true)],
    ['1.2.840.10008.1.2.2', probe(true, false)],
  ];
  return candidates.reduce((best, candidate) => candidate[1] > best[1] ? candidate : best)[0];
}

function checkedValueEnd(start, length, limit, tag) {
  const end = start + length;
  if (end > limit) {
    throw new DicomParseError('TRUNCATED_VALUE', `Truncated DICOM value at ${tag}.`, {
      tag,
      offset: start,
      expectedLength: length,
      availableBytes: Math.max(0, limit - start),
    });
  }
  return end;
}

/**
 * Parse encapsulated PixelData (undefined length) into raw bytes + fragment slices.
 */
function parseEncapsulatedPixelData(bytes, view, startOffset, endOffset, littleEndian) {
  let pos = startOffset;
  const fragmentRanges = [];
  let tableEnd = null;

  while (pos + 8 <= endOffset) {
    const itemStart = pos;
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    const len = view.getUint32(pos + 4, littleEndian);
    pos += 8;

    // Odd-length or empty fragments and malformed Basic Offset Tables occur in real files. The stream is
    // preserved verbatim, so only the Item structure is enforced here; frame lookup validates the BOT.
    if (g === 0xfffe && e === 0xe0dd && len === 0 && tableEnd !== null) {
      const rawBytes = bytes.slice(startOffset, pos);
      const basicOffsetTable = rawBytes.subarray(8, tableEnd);
      const fragments = fragmentRanges.map(([start, end]) => rawBytes.subarray(start, end));
      return { nextOffset: pos, rawBytes, fragments, basicOffsetTable };
    }
    if (g !== 0xfffe || e !== 0xe000) {
      throw new DicomParseError(
        'INVALID_ENCAP_PIXEL',
        `Invalid encapsulated Pixel Data item ${formatTag(g, e)} (expected (FFFE,E000)).`,
        { tag: '(7FE0,0010)', offset: itemStart }
      );
    }
    const fragEnd = checkedValueEnd(pos, len, endOffset, '(7FE0,0010)');
    if (tableEnd === null) {
      tableEnd = fragEnd - startOffset;
    } else {
      fragmentRanges.push([pos - startOffset, fragEnd - startOffset]);
    }
    pos = fragEnd;
  }
  throw new DicomParseError(
    'MISSING_SQ_DELIM',
    'Missing Sequence Delimitation Item (FFFE,E0DD) for encapsulated Pixel Data.',
    { tag: '(7FE0,0010)', offset: pos }
  );
}

function resolveImplicitPixelVrs(nodes, littleEndian, inherited = {}) {
  const firstNumber = (tag, list = nodes) => {
    const value = list.find((node) => node.tag === tag)?.value.split('\\')[0].trim();
    return value ? Number(value) : NaN;
  };
  const representation = firstNumber('00280103');
  const pixelRep = representation === 0 || representation === 1 ? representation : inherited.pixelRep;
  const bitsStored = firstNumber('00280101') || inherited.bitsStored;
  const transform = nodes.find((node) => node.tag === '00289145')?.items?.[0]?.children || nodes;
  const slope = firstNumber('00281053', transform);
  const intercept = firstNumber('00281052', transform);
  let voiSigned = inherited.voiSigned;
  if (Number.isFinite(slope) && Number.isFinite(intercept) && bitsStored >= 1 && bitsStored <= 64) {
    const min = pixelRep === 1 ? -(2 ** (bitsStored - 1)) : 0;
    const max = pixelRep === 1 ? -min - 1 : 2 ** bitsStored - 1;
    voiSigned = Math.min(min * slope, max * slope) + intercept < 0;
  } else if (Number.isFinite(intercept) && intercept < 0) {
    voiSigned = true;
  } else if (nodes.some((node) => node.tag === '00283000' && node.items?.length)) {
    voiSigned = false; // Modality LUT output is unsigned (PS3.3 C.11.1).
  }
  for (const node of nodes || []) {
    if (node.isSequence && node.items) {
      const itemLittleEndian = node.sequenceEncodedAsUn || littleEndian;
      for (const item of node.items) {
        resolveImplicitPixelVrs(item.children, itemLittleEndian, {
          pixelRep, bitsStored, voiSigned, isVoiLut: node.tag === '00283010',
        });
      }
      continue;
    }
    const signed = node.tag === '00283002' && inherited.isVoiLut && voiSigned !== undefined ? voiSigned : pixelRep === 1;
    const targetVr = signed ? 'SS' : 'US';
    if (
      node.vrSource === 'dict' &&
      (node.vr === 'US' || node.vr === 'SS') &&
      PIXEL_REP_SIGNED_TAGS.has(node.tag) &&
      node.rawBytes instanceof Uint8Array &&
      node.vr !== targetVr
    ) {
      const decoded = decodeBinaryNumeric(node.rawBytes, targetVr, littleEndian, node.tag);
      node.vr = targetVr;
      node.originalValue = decoded;
      node.value = decoded;
      node.validation = validateVrValue(targetVr, decoded, node.tag);
    }
  }
}

/**
 * Parse a dataset range into an array of tag nodes.
 */
function parseDatasetRange(bytes, view, startOffset, endOffset, opts) {
  const {
    explicit,
    littleEndian,
    isMetaSection = false,
    stopAfterGroup0002 = false,
    inheritedCharset = '',
    expectItemDelimiter = false,
    ignoreGroupLength = false,
    depth = 0,
  } = opts;
  const rangeLimit = endOffset;
  if (depth > MAX_SEQUENCE_DEPTH) {
    throw new DicomParseError('RESOURCE_LIMIT', `DICOM sequence nesting exceeds ${MAX_SEQUENCE_DEPTH} levels.`, { offset: startOffset });
  }

  let pos = startOffset;
  let charset = inheritedCharset;
  let declaredMetaEnd = null;
  const nodes = [];
  const privateCreators = new Map();

  while (pos + 8 <= endOffset) {
    const tagStart = pos;
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);

    if (stopAfterGroup0002 && group !== 0x0002) {
      if (declaredMetaEnd !== null) {
        throw new DicomParseError('INVALID_META_LENGTH', 'File Meta Information Group Length extends into the dataset.', { offset: tagStart });
      }
      return { nodes, nextOffset: tagStart };
    }

    if (group === 0xfffe) {
      if (expectItemDelimiter && element === 0xe00d && view.getUint32(pos + 4, littleEndian) === 0) {
        return { nodes, nextOffset: pos + 8 };
      }
      throw new DicomParseError(
        'UNEXPECTED_ITEM',
        `Unexpected DICOM delimiter ${formatTag(group, element)}.`,
        { tag: formatTag(group, element), offset: tagStart }
      );
    }

    pos += 4;
    let vr = '';
    let encodedVr;
    let vrSource = 'explicit';
    let length = 0;

    if (explicit) {
      try {
        ({ vr, encodedVr, length, next: pos } = readExplicitHeader(bytes, view, pos, endOffset, littleEndian, formatTag(group, element)));
      } catch (error) {
        if (error?.code !== 'INVALID_VR') throw error;
        // Some writers switch a single element (or File Meta) to Implicit VR inside an Explicit VR
        // stream; read it with the dictionary VR as earlier versions did instead of rejecting the file.
        const info = lookupTag(group, element, privateCreators);
        vr = info.vr;
        vrSource = 'dict';
        length = view.getUint32(pos, littleEndian);
        pos += 4;
      }
    } else {
      const info = lookupTag(group, element, privateCreators);
      vr = info.vr;
      vrSource = info.keyword !== 'UnknownTag' ? 'dict' : 'fallback';
      length = view.getUint32(pos, littleEndian);
      pos += 4;
    }

    const undefinedLength = length === 0xffffffff;
    const hex = tagHex(group, element);

    // PS3.5 6.2.2 defines an explicit UN sequence's value as Implicit VR Little Endian.
    const sequenceEncodedAsUn = explicit && !encodedVr && vr === 'UN' && undefinedLength && hex !== '7FE00010';
    if (
      sequenceEncodedAsUn || (encodedVr && undefinedLength && hex !== '7FE00010') || (
        !explicit && undefinedLength && vr !== 'SQ' && hex !== '7FE00010' &&
        pos + 4 <= endOffset && view.getUint16(pos, littleEndian) === 0xfffe &&
        [0xe000, 0xe0dd].includes(view.getUint16(pos + 2, littleEndian))
      )
    ) {
      vr = 'SQ';
      vrSource = 'inferred';
    }

    const dictInfo = lookupTag(group, element, privateCreators);
    const isPrivate = (group & 1) === 1;

    // 1) Sequence (SQ)
    if (vr === 'SQ') {
      const label = formatTag(group, element);
      const sqEnd = undefinedLength ? endOffset : checkedValueEnd(pos, length, endOffset, label);
      const itemExplicit = explicit && !sequenceEncodedAsUn;
      const itemLittleEndian = sequenceEncodedAsUn || littleEndian;
      const items = [];
      let sqPos = pos;
      let delimited = false;

      while (sqPos + 8 <= sqEnd) {
        const itemStart = sqPos;
        const itemG = view.getUint16(sqPos, itemLittleEndian);
        const itemE = view.getUint16(sqPos + 2, itemLittleEndian);
        const itemLen = view.getUint32(sqPos + 4, itemLittleEndian);
        sqPos += 8;

        if (undefinedLength && itemG === 0xfffe && itemE === 0xe0dd && itemLen === 0) {
          delimited = true;
          break;
        }
        if (itemG !== 0xfffe || itemE !== 0xe000) {
          throw new DicomParseError(
            'INVALID_SQ_ITEM',
            `Invalid DICOM sequence item ${formatTag(itemG, itemE)} inside ${label} (expected (FFFE,E000)).`,
            { tag: label, offset: itemStart }
          );
        }
        const itemUndef = itemLen === 0xffffffff;
        const itemLimit = itemUndef ? sqEnd : checkedValueEnd(sqPos, itemLen, sqEnd, label);
        const itemResult = parseDatasetRange(bytes, view, sqPos, itemLimit, {
          explicit: itemExplicit,
          littleEndian: itemLittleEndian,
          inheritedCharset: charset,
          expectItemDelimiter: itemUndef,
          depth: depth + 1,
        });
        const itemObj = { id: genNodeId(), offset: itemStart, undefinedLength: itemUndef, children: itemResult.nodes };
        items.push(itemObj);
        sqPos = itemResult.nextOffset;
      }

      if (undefinedLength && !delimited) {
        throw new DicomParseError(
          'MISSING_SQ_DELIM',
          `Missing Sequence Delimitation Item (FFFE,E0DD) at ${label}.`,
          { tag: label, offset: sqPos }
        );
      }
      if (!undefinedLength && sqPos !== sqEnd) {
        throw new DicomParseError(
          'TRUNCATED_VALUE',
          `Truncated DICOM sequence at ${label}.`,
          { tag: label, offset: sqPos, availableBytes: Math.max(0, sqEnd - sqPos) }
        );
      }
      nodes.push({
        id: genNodeId(),
        group,
        element,
        tag: hex,
        formattedTag: label,
        keyword: dictInfo.keyword,
        name: dictInfo.name,
        vr: 'SQ',
        encodedVr,
        vrSource,
        sequenceEncodedAsUn,
        vmSpec: dictInfo.vm,
        isMeta: isMetaSection,
        isPrivate,
        isSequence: true,
        isBinary: false,
        encapsulated: false,
        undefinedLength,
        rawLength: sqPos - pos,
        rawBytes: null,
        originalValue: '',
        value: '',
        items,
        status: 'unchanged',
        validation: { valid: true, severity: 'ok', messages: [] },
      });
      pos = sqPos;
      continue;
    }

    // 2) Encapsulated PixelData (7FE0,0010 with undefined length)
    if (hex === '7FE00010' && undefinedLength) {
      const enc = parseEncapsulatedPixelData(bytes, view, pos, endOffset, littleEndian);
      nodes.push({
        id: genNodeId(),
        group,
        element,
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: dictInfo.keyword,
        name: dictInfo.name,
        vr,
        vrSource,
        vmSpec: dictInfo.vm,
        isMeta: isMetaSection,
        isPrivate: false,
        isSequence: false,
        isBinary: true,
        encapsulated: true,
        offset: tagStart,
        undefinedLength: true,
        rawLength: enc.rawBytes.length,
        rawBytes: enc.rawBytes,
        fragments: enc.fragments,
        basicOffsetTable: enc.basicOffsetTable,
        originalValue: `[Encapsulated: ${enc.fragments.length} fragment(s), ${formatByteSize(enc.rawBytes.length)}]`,
        value: `[Encapsulated: ${enc.fragments.length} fragment(s), ${formatByteSize(enc.rawBytes.length)}]`,
        status: 'unchanged',
        validation: { valid: true, severity: 'ok', messages: [] },
      });
      pos = enc.nextOffset;
      continue;
    }

    const label = formatTag(group, element);
    if (undefinedLength) {
      throw new DicomParseError(
        'UNSUPPORTED_UNDEF_LEN',
        `Unsupported undefined DICOM value length (0xFFFFFFFF) at ${label} (VR: ${vr}).`,
        { tag: label, offset: tagStart }
      );
    }
    const valEnd = checkedValueEnd(pos, length, endOffset, label);
    // Odd lengths and fixed-width mismatches violate PS3.5 7.1 but are common in the wild. Keep the
    // original bytes (the writer preserves them verbatim or refuses to invent padding) instead of
    // rejecting the whole file. A dictionary-derived Implicit VR that cannot hold the value is
    // demoted to UN so it stays opaque rather than being shown truncated.
    let lengthIssue = length % 2 !== 0 || length % binaryValueUnitSize(vr) !== 0;
    if (lengthIssue && vrSource !== 'explicit' && length % binaryValueUnitSize(vr) !== 0) {
      vr = 'UN';
      lengthIssue = length % 2 !== 0;
    }
    const rawBytes = bytes.slice(pos, valEnd);
    pos = valEnd;

    const isBinary = BINARY_VRS.has(vr) || hex === '7FE00010';
    const rawCharset = usesSpecificCharacterSet(vr, hex) ? charset : undefined;
    let decodedValue = '';
    let charsetError = false;

    if (isBinary) {
      decodedValue = `[Binary ${vr}: ${formatByteSize(rawBytes.length)}]`;
    } else if (NUMERIC_VRS.has(vr) || vr === 'AT') {
      decodedValue = decodeBinaryNumeric(rawBytes, vr, littleEndian, hex);
    } else {
      ({ value: decodedValue, charsetError } = decodeDicomText(rawBytes, vr, charset, hex));
    }

    // Track SpecificCharacterSet for subsequent tags in this dataset
    if (hex === '00080005') {
      charset = decodedValue;
    }

    // Track Private Creator IDs
    if (isPrivate && element >= 0x0010 && element <= 0x00ff) {
      // Private Creators re-encoded as UN by intermediaries still identify their block (PS3.5 7.8.1).
      const creatorName = vr === 'LO' ? decodedValue.trim()
        : vr === 'UN' ? decodeDicomText(rawBytes, 'LO', '', hex).value.replace(/\0+$/, '').trim() : '';
      const creatorKey = `${group.toString(16).toUpperCase().padStart(4, '0')}:${element.toString(16).toUpperCase().padStart(2, '0')}`;
      if (creatorName) {
        privateCreators.set(creatorKey, creatorName);
      }
    }

    const validation = isBinary
      ? { valid: true, severity: 'ok', messages: [] }
      : validateVrValue(vr, decodedValue, hex);
    if (lengthIssue) {
      validation.messages = [...validation.messages,
        `Value Length ${length} is invalid for VR ${vr}; the original bytes are kept unchanged.`];
      if (validation.severity === 'ok') validation.severity = 'warning';
    }

    nodes.push({
      id: genNodeId(),
      group,
      element,
      tag: hex,
      formattedTag: label,
      keyword: dictInfo.keyword,
      name: dictInfo.name,
      vr,
      encodedVr,
      vrSource,
      vmSpec: dictInfo.vm,
      isMeta: isMetaSection,
      isPrivate,
      isSequence: false,
      isBinary,
      encapsulated: false,
      undefinedLength,
      rawLength: rawBytes.length,
      rawBytes,
      rawCharset,
      charsetError,
      floatEncoding: vr === 'FL' || vr === 'FD' ? { rawBytes, originalValue: decodedValue } : undefined,
      originalValue: decodedValue,
      value: decodedValue,
      status: 'unchanged',
      validation,
    });

    if (stopAfterGroup0002 && !ignoreGroupLength && hex === '00020000' && length === 4 && nodes.length === 1) {
      const declaredEnd = pos + view.getUint32(valEnd - 4, true);
      if (declaredEnd > endOffset) {
        throw new DicomParseError('INVALID_META_LENGTH', 'File Meta Information Group Length extends past the end of the file.', { offset: tagStart });
      }
      declaredMetaEnd = declaredEnd;
      endOffset = declaredMetaEnd;
    }
  }
  if (declaredMetaEnd !== null && pos === declaredMetaEnd && pos + 2 <= rangeLimit && view.getUint16(pos, true) === 0x0002) {
    throw new DicomParseError('INVALID_META_LENGTH', 'File Meta Information Group Length ends before the last group 0002 element.', { offset: pos });
  }

  if (expectItemDelimiter) {
    throw new DicomParseError(
      'MISSING_ITEM_DELIM',
      'Missing DICOM Item Delimitation Item (FFFE,E00D).',
      { offset: pos }
    );
  }
  if ((!stopAfterGroup0002 || declaredMetaEnd !== null) && pos !== endOffset) {
    throw new DicomParseError(
      'TRUNCATED_HEADER',
      `Truncated DICOM element header (${endOffset - pos} trailing byte(s) remaining).`,
      { offset: pos, availableBytes: endOffset - pos }
    );
  }
  // A malformed Basic Offset Table only affects frame lookup (the renderer falls back to fragment
  // heuristics); it must not make the tags of an otherwise readable file uneditable.
  const frameCount = Number(nodes.find((node) => node.tag === '00280008')?.value || '1');
  for (const node of nodes) {
    if (!node.encapsulated) continue;
    let problem = node.fragments.length ? null : 'Encapsulated Pixel Data has no fragments.';
    try {
      basicOffsetFrameStarts(node.basicOffsetTable, node.fragments, frameCount);
    } catch (error) {
      problem = error.message;
    }
    if (problem) node.validation = { valid: true, severity: 'warning', messages: [problem] };
  }
  return { nodes, nextOffset: pos };
}

export function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function gunzipBytes(compressed, limit) {
  try {
    return await decompressBytes(compressed, 'gzip', limit, 0);
  } catch (err) {
    if (err instanceof DicomParseError) throw err;
    throw new DicomParseError(
      'DEFLATE_FAILED',
      `Gzip decompression failed: ${err.message || err}`,
      { offset: 0 }
    );
  }
}

/**
 * Parse a complete DICOM ArrayBuffer into a structured editable document.
 * Transparently decompresses Gzip-wrapped .dcm.gz files.
 * Throws a DicomParseError with rich diagnostics on failure.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 * @param {{ transferSyntaxUid?: string, maxDecompressedBytes?: number }} [options]
 */
export async function parseDicomBuffer(arrayBuffer, fileName = 'untitled.dcm', options = {}) {
  const inputBytes = new Uint8Array(arrayBuffer);
  let bytes = inputBytes;
  let wasGzipped = false;
  let hasPart10Header = false;
  const requestedLimit = options.maxDecompressedBytes;
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_DECOMPRESSED_BYTES) : MAX_DECOMPRESSED_BYTES;

  let metaNodes = [];
  let transferSyntaxUid = '';
  let tsInfo = null;

  const enrichAndThrow = (err) => {
    const detectedFormat = hasPart10Header ? null : detectNonDicomSignature(bytes);
    const baseCode = err instanceof DicomParseError ? err.code : 'UNKNOWN';
    const baseDetails = err instanceof DicomParseError && err.details ? err.details : {};
    const finalCode =
      !hasPart10Header && detectedFormat && !['TOO_SMALL', 'DEFLATE_FAILED', 'RESOURCE_LIMIT'].includes(baseCode)
        ? 'NON_DICOM_FORMAT'
        : baseCode;

    throw new DicomParseError(finalCode, err?.message || 'Failed to parse DICOM file.', {
      ...baseDetails,
      fileName,
      fileSize: bytes.length,
      hasPart10Header,
      detectedFormat,
      transferSyntaxUid: transferSyntaxUid || null,
      transferSyntaxName: tsInfo?.name || null,
      parsedMetaCount: metaNodes.length,
      headerPreview: buildHeaderPreview(bytes),
      rawMessage: err?.message || String(err),
    });
  };

  try {
    if (inputBytes[0] === 0x1f && inputBytes[1] === 0x8b) {
      bytes = await gunzipBytes(inputBytes, limit);
      wasGzipped = true;
    }
    hasPart10Header = bytes.length >= 132 &&
      bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;

    if (bytes.length < 8) {
      throw new DicomParseError(
        'TOO_SMALL',
        `File is too small (${bytes.length} byte(s)) to be a valid DICOM file.`,
        { offset: 0, availableBytes: bytes.length }
      );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let preamble = hasPart10Header ? bytes.slice(0, 128) : new Uint8Array(128);
    let mainOffset = 0;

    // Some writers omit the 128-byte preamble and "DICM" but still emit File Meta (0002,xxxx).
    const metaStart = hasPart10Header ? 132 : 0;
    const metaWithoutPreamble = !hasPart10Header && bytes.length >= 8 && view.getUint16(0, true) === 0x0002;
    if (hasPart10Header || metaWithoutPreamble) {
      // Parse File Meta Information (0002,xxxx) — always Explicit VR Little Endian
      const parseMeta = (ignoreGroupLength) => parseDatasetRange(bytes, view, metaStart, bytes.length, {
        explicit: true,
        littleEndian: true,
        isMetaSection: true,
        stopAfterGroup0002: true,
        inheritedCharset: '',
        ignoreGroupLength,
      });
      let metaResult;
      try {
        metaResult = parseMeta(false);
      } catch (error) {
        // A wrong (0002,0000) is common; fall back to the group number boundary like DCMTK/pydicom.
        try {
          metaResult = parseMeta(true);
        } catch {
          throw error;
        }
      }
      metaNodes = metaResult.nodes;
      mainOffset = metaResult.nextOffset;
      if (metaWithoutPreamble) hasPart10Header = true; // Saved back as a conformant Part 10 file.
    }

    // Determine Transfer Syntax
    const tsNode = metaNodes.find((n) => n.tag === '00020010');
    transferSyntaxUid = tsNode ? tsNode.value.trim() : '';

    if (hasPart10Header && transferSyntaxUid) {
      tsInfo = getTransferSyntaxInfo(transferSyntaxUid);
    } else {
      transferSyntaxUid = options.transferSyntaxUid || detectRawSyntax(bytes, view, mainOffset);
      tsInfo = getTransferSyntaxInfo(transferSyntaxUid);
    }

    // Handle Deflated Explicit VR Little Endian
    let datasetBytes = bytes;
    let datasetView = view;
    let datasetStart = mainOffset;
    let datasetEnd = bytes.length;

    if (tsInfo.deflated) {
      const inflated = await inflateRawBytes(bytes.subarray(mainOffset), mainOffset, limit);
      datasetBytes = inflated;
      datasetView = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
      datasetStart = 0;
      datasetEnd = inflated.length;
    }

    const mainResult = parseDatasetRange(datasetBytes, datasetView, datasetStart, datasetEnd, {
      explicit: tsInfo.explicit,
      littleEndian: tsInfo.littleEndian,
      isMetaSection: false,
      stopAfterGroup0002: false,
      inheritedCharset: '',
    });

    if (mainResult.nodes.length === 0) {
      throw new DicomParseError(
        'NO_TAGS',
        'No readable DICOM data elements were found in this file.',
        { offset: mainOffset }
      );
    }
    resolveImplicitPixelVrs(mainResult.nodes, tsInfo.littleEndian);

    return {
      fileName: wasGzipped ? fileName.replace(/\.gz$/i, '') : fileName,
      fileSize: bytes.length,
      wasGzipped,
      hasPart10Header,
      missingPreamble: metaWithoutPreamble,
      preamble,
      transferSyntaxUid,
      transferSyntaxInfo: tsInfo,
      explicit: tsInfo.explicit,
      littleEndian: tsInfo.littleEndian,
      wasDeflated: Boolean(tsInfo.deflated),
      metaNodes,
      datasetNodes: mainResult.nodes,
    };
  } catch (err) {
    enrichAndThrow(err);
  }
}
