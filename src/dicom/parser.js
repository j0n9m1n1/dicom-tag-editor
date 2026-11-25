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
  validateVrValue,
} from './vrSpec.js';
import {
  formatTag,
  tagHex,
  lookupTag,
  getTransferSyntaxInfo,
  PIXEL_REP_SIGNED_TAGS,
} from './dictionary.js';
import { decodeDicomString, usesSpecificCharacterSet } from './charset.js';

let _nextNodeId = 1;
export function genNodeId() {
  return `n_${_nextNodeId++}`;
}

export function resetNodeIdCounter() {
  _nextNodeId = 1;
}

const VALID_VR_SET = new Set(Object.keys(VR_SPECS));

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

/**
 * Inflate Deflated Explicit VR Little Endian stream using browser DecompressionStream.
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function inflateRawBytes(compressed, offset = 0) {
  if (typeof DecompressionStream === 'undefined') {
    throw new DicomParseError(
      'DEFLATE_FAILED',
      'This browser does not support DecompressionStream for Deflated Transfer Syntax.',
      { offset }
    );
  }
  const inflate = async (input) => {
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await inflate(compressed);
  } catch (err) {
    // PS3.5 A.5 pads an odd-length Deflate stream with one trailing NUL.
    if (compressed.length % 2 === 0 && compressed.at(-1) === 0) {
      try {
        return await inflate(compressed.subarray(0, -1));
      } catch (err2) {
        throw new DicomParseError(
          'DEFLATE_FAILED',
          `Deflated dataset decompression failed: ${err2.message || err2}`,
          { offset }
        );
      }
    }
    throw new DicomParseError(
      'DEFLATE_FAILED',
      `Deflated dataset decompression failed: ${err.message || err}`,
      { offset }
    );
  }
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
        const num = view.getFloat32(i, littleEndian);
        vals.push(Number.isInteger(num) ? String(num) : String(Number(num.toPrecision(7))));
      }
      break;
    case 'FD':
      for (let i = 0; i + 8 <= bytes.length; i += 8) {
        vals.push(String(view.getFloat64(i, littleEndian)));
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

/**
 * Heuristic to detect if raw dataset without DICM preamble uses Explicit VR.
 */
function detectRawExplicitVr(bytes, startOffset) {
  if (startOffset + 6 > bytes.length) return true;
  const c1 = bytes[startOffset + 4];
  const c2 = bytes[startOffset + 5];
  if (c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90) {
    const vr = String.fromCharCode(c1, c2);
    return isKnownVr(vr);
  }
  return false;
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
  const fragments = [];
  let basicOffsetTable = null;

  while (pos + 8 <= endOffset) {
    const itemStart = pos;
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    const len = view.getUint32(pos + 4, littleEndian);
    pos += 8;

    if (g === 0xfffe && e === 0xe0dd && len === 0 && basicOffsetTable !== null) {
      return { nextOffset: pos, rawBytes: bytes.slice(startOffset, pos), fragments, basicOffsetTable };
    }
    if (g !== 0xfffe || e !== 0xe000) {
      throw new DicomParseError(
        'INVALID_ENCAP_PIXEL',
        `Invalid encapsulated Pixel Data item ${formatTag(g, e)} (expected (FFFE,E000)).`,
        { tag: '(7FE0,0010)', offset: itemStart }
      );
    }
    const fragEnd = checkedValueEnd(pos, len, endOffset, '(7FE0,0010)');
    const fragBytes = bytes.slice(pos, fragEnd);
    if (basicOffsetTable === null) {
      basicOffsetTable = fragBytes;
    } else {
      fragments.push(fragBytes);
    }
    pos = fragEnd;
  }
  throw new DicomParseError(
    'MISSING_SQ_DELIM',
    'Missing Sequence Delimitation Item (FFFE,E0DD) for encapsulated Pixel Data.',
    { tag: '(7FE0,0010)', offset: pos }
  );
}

function applyPixelRepToImplicitNodes(nodes, pixelRep, littleEndian, itemHasOwnPixelRepMap) {
  const targetVr = pixelRep === 1 ? 'SS' : 'US';
  for (const node of nodes || []) {
    if (node.isSequence && node.items) {
      const itemLittleEndian = node.sequenceEncodedAsUn || littleEndian;
      for (const item of node.items) {
        if (!itemHasOwnPixelRepMap.get(item)) {
          applyPixelRepToImplicitNodes(item.children, pixelRep, itemLittleEndian, itemHasOwnPixelRepMap);
        }
      }
      continue;
    }
    if (
      node.vrSource === 'dict' &&
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
    inheritedPixelRepresentation = null,
    expectItemDelimiter = false,
    itemHasOwnPixelRepMap = new WeakMap(),
  } = opts;

  let pos = startOffset;
  let charset = inheritedCharset;
  let pixelRepresentation = inheritedPixelRepresentation;
  let hasOwnPixelRepresentation = false;
  const nodes = [];
  const privateCreators = new Map();

  while (pos + 8 <= endOffset) {
    const tagStart = pos;
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);

    if (stopAfterGroup0002 && group !== 0x0002) {
      return { nodes, nextOffset: tagStart, hasOwnPixelRepresentation };
    }

    if (group === 0xfffe) {
      if (expectItemDelimiter && element === 0xe00d && view.getUint32(pos + 4, littleEndian) === 0) {
        if (hasOwnPixelRepresentation && pixelRepresentation !== inheritedPixelRepresentation) {
          applyPixelRepToImplicitNodes(nodes, pixelRepresentation, littleEndian, itemHasOwnPixelRepMap);
        }
        return { nodes, nextOffset: pos + 8, hasOwnPixelRepresentation };
      }
      throw new DicomParseError(
        'UNEXPECTED_ITEM',
        `Unexpected DICOM delimiter ${formatTag(group, element)}.`,
        { tag: formatTag(group, element), offset: tagStart }
      );
    }

    pos += 4;
    let vr = '';
    let vrSource = 'explicit';
    let length = 0;

    if (explicit) {
      const candidate = String.fromCharCode(bytes[pos], bytes[pos + 1]);
      if (isKnownVr(candidate)) {
        vr = candidate;
        pos += 2;
        if (VR_32BIT_LENGTH.has(vr)) {
          pos += 2; // 2 reserved bytes
          if (pos + 4 > endOffset) {
            throw new DicomParseError(
              'TRUNCATED_HEADER',
              `Truncated DICOM header at ${formatTag(group, element)}.`,
              { tag: formatTag(group, element), offset: tagStart, availableBytes: Math.max(0, endOffset - tagStart) }
            );
          }
          length = view.getUint32(pos, littleEndian);
          pos += 4;
        } else {
          length = view.getUint16(pos, littleEndian);
          pos += 2;
        }
      } else {
        // Fallback if an element inside explicit dataset is unexpectedly implicit
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

    if (vrSource === 'dict' && PIXEL_REP_SIGNED_TAGS.has(hex) && pixelRepresentation === 1) {
      vr = 'SS';
    }

    // PS3.5 6.2.2 defines an explicit UN sequence's value as Implicit VR Little Endian.
    const sequenceEncodedAsUn = explicit && vrSource === 'explicit' && vr === 'UN' && undefinedLength && hex !== '7FE00010';
    if (
      sequenceEncodedAsUn || (
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
          inheritedPixelRepresentation: pixelRepresentation,
          expectItemDelimiter: itemUndef,
          itemHasOwnPixelRepMap,
        });
        const itemObj = { id: genNodeId(), undefinedLength: itemUndef, children: itemResult.nodes };
        if (itemResult.hasOwnPixelRepresentation) {
          itemHasOwnPixelRepMap.set(itemObj, true);
        }
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
    const rawBytes = bytes.slice(pos, valEnd);
    pos = valEnd;

    const isBinary = BINARY_VRS.has(vr) || hex === '7FE00010';
    const rawCharset = usesSpecificCharacterSet(vr) ? charset : undefined;
    let decodedValue = '';

    if (isBinary) {
      decodedValue = `[Binary ${vr}: ${formatByteSize(rawBytes.length)}]`;
    } else if (NUMERIC_VRS.has(vr) || vr === 'AT') {
      decodedValue = decodeBinaryNumeric(rawBytes, vr, littleEndian, hex);
    } else {
      decodedValue = decodeDicomString(rawBytes, vr, charset);
    }

    // Track SpecificCharacterSet for subsequent tags in this dataset
    if (hex === '00080005') {
      charset = decodedValue;
    }

    // Track PixelRepresentation (0 = unsigned US, 1 = signed SS) for Implicit VR US/SS tags
    if (hex === '00280103' && !isBinary) {
      const firstVal = decodedValue.split('\\')[0]?.trim();
      const rep = firstVal !== '' ? Number(firstVal) : NaN;
      if (rep === 0 || rep === 1) {
        pixelRepresentation = rep;
        hasOwnPixelRepresentation = true;
      }
    }

    // Track Private Creator IDs
    if (isPrivate && element >= 0x0010 && element <= 0x00ff) {
      const creatorName = decodeDicomString(rawBytes, 'LO', charset).trim();
      const creatorKey = `${group.toString(16).toUpperCase().padStart(4, '0')}:${element.toString(16).toUpperCase().padStart(2, '0')}`;
      if (creatorName) {
        privateCreators.set(creatorKey, creatorName);
        if (isBinary && vr === 'UN') {
          // Even if encoded as UN in implicit VR, private creator is a readable string
          decodedValue = creatorName;
        }
      }
    }

    const validation = isBinary
      ? { valid: true, severity: 'ok', messages: [] }
      : validateVrValue(vr, decodedValue, hex);

    nodes.push({
      id: genNodeId(),
      group,
      element,
      tag: hex,
      formattedTag: label,
      keyword: dictInfo.keyword,
      name: dictInfo.name,
      vr,
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
      originalValue: decodedValue,
      value: decodedValue,
      status: 'unchanged',
      validation,
    });

    if (stopAfterGroup0002 && hex === '00020000' && length === 4 && nodes.length === 1) {
      endOffset = checkedValueEnd(pos, view.getUint32(valEnd - 4, true), endOffset, label);
    }
  }

  if (expectItemDelimiter) {
    throw new DicomParseError(
      'MISSING_ITEM_DELIM',
      'Missing DICOM Item Delimitation Item (FFFE,E00D).',
      { offset: pos }
    );
  }
  if (!stopAfterGroup0002 && pos !== endOffset) {
    throw new DicomParseError(
      'TRUNCATED_HEADER',
      `Truncated DICOM element header (${endOffset - pos} trailing byte(s) remaining).`,
      { offset: pos, availableBytes: endOffset - pos }
    );
  }
  if (hasOwnPixelRepresentation && pixelRepresentation !== inheritedPixelRepresentation) {
    applyPixelRepToImplicitNodes(nodes, pixelRepresentation, littleEndian, itemHasOwnPixelRepMap);
  }
  return { nodes, nextOffset: pos, hasOwnPixelRepresentation };
}

export function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function gunzipBytes(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new DicomParseError(
      'DEFLATE_FAILED',
      'This browser does not support DecompressionStream for .dcm.gz files.',
      { offset: 0 }
    );
  }
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
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
 */
export async function parseDicomBuffer(arrayBuffer, fileName = 'untitled.dcm') {
  const inputBytes = new Uint8Array(arrayBuffer);
  let bytes = inputBytes;
  let wasGzipped = false;

  // Transparently decompress .dcm.gz (Gzip magic 1F 8B) before DICOM parsing
  if (inputBytes.length >= 18 && inputBytes[0] === 0x1f && inputBytes[1] === 0x8b) {
    try {
      const gunzipped = await gunzipBytes(inputBytes);
      if (gunzipped.length >= 16) {
        bytes = gunzipped;
        wasGzipped = true;
      }
    } catch {
      // Fall through so detectNonDicomSignature can classify non-DICOM .gz archives cleanly
    }
  }

  const hasPart10Header =
    bytes.length >= 132 &&
    bytes[128] === 0x44 && // D
    bytes[129] === 0x49 && // I
    bytes[130] === 0x43 && // C
    bytes[131] === 0x4d;   // M

  let metaNodes = [];
  let transferSyntaxUid = '';
  let tsInfo = null;

  const enrichAndThrow = (err) => {
    const detectedFormat = hasPart10Header ? null : detectNonDicomSignature(bytes);
    const baseCode = err instanceof DicomParseError ? err.code : 'UNKNOWN';
    const baseDetails = err instanceof DicomParseError && err.details ? err.details : {};
    const finalCode =
      !hasPart10Header && detectedFormat && baseCode !== 'TOO_SMALL'
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
    if (bytes.length < 16) {
      throw new DicomParseError(
        'TOO_SMALL',
        `File is too small (${bytes.length} byte(s)) to be a valid DICOM file.`,
        { offset: 0, availableBytes: bytes.length }
      );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let preamble = hasPart10Header ? bytes.slice(0, 128) : new Uint8Array(128);
    let mainOffset = 0;

    if (hasPart10Header) {
      // Parse File Meta Information (0002,xxxx) — always Explicit VR Little Endian
      const metaResult = parseDatasetRange(bytes, view, 132, bytes.length, {
        explicit: true,
        littleEndian: true,
        isMetaSection: true,
        stopAfterGroup0002: true,
        inheritedCharset: '',
      });
      metaNodes = metaResult.nodes;
      mainOffset = metaResult.nextOffset;
    }

    // Determine Transfer Syntax
    const tsNode = metaNodes.find((n) => n.tag === '00020010');
    transferSyntaxUid = tsNode ? tsNode.value.trim() : '';

    if (hasPart10Header && transferSyntaxUid) {
      tsInfo = getTransferSyntaxInfo(transferSyntaxUid);
    } else {
      const rawExplicit = detectRawExplicitVr(bytes, mainOffset);
      transferSyntaxUid = rawExplicit ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2';
      tsInfo = getTransferSyntaxInfo(transferSyntaxUid);
    }

    // Handle Deflated Explicit VR Little Endian
    let datasetBytes = bytes;
    let datasetView = view;
    let datasetStart = mainOffset;
    let datasetEnd = bytes.length;

    if (tsInfo.deflated) {
      const inflated = await inflateRawBytes(bytes.subarray(mainOffset), mainOffset);
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

    if (metaNodes.length === 0 && mainResult.nodes.length === 0) {
      throw new DicomParseError(
        'NO_TAGS',
        'No readable DICOM data elements were found in this file.',
        { offset: mainOffset }
      );
    }

    return {
      fileName: wasGzipped ? fileName.replace(/\.gz$/i, '') : fileName,
      fileSize: bytes.length,
      wasGzipped,
      hasPart10Header,
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
