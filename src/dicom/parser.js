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
  VR_SPECS,
  validateVrValue,
} from './vrSpec.js';
import {
  formatTag,
  tagHex,
  lookupTag,
  getTransferSyntaxInfo,
} from './dictionary.js';
import { decodeDicomString } from './charset.js';

let _nextNodeId = 1;
export function genNodeId() {
  return `n_${_nextNodeId++}`;
}

export function resetNodeIdCounter() {
  _nextNodeId = 1;
}

const VALID_VR_SET = new Set(Object.keys(VR_SPECS));

function isKnownVr(twoChars) {
  return VALID_VR_SET.has(twoChars);
}

/**
 * Inflate Deflated Explicit VR Little Endian stream using browser DecompressionStream.
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function inflateRawBytes(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('이 브라우저는 Deflated Transfer Syntax 압축 해제를 지원하지 않습니다.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressed);
  writer.close();
  const chunks = [];
  const reader = ds.readable.getReader();
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
 * Decode numeric or AT binary values into display/editable string (backslash-separated for VM > 1).
 */
export function decodeBinaryNumeric(bytes, vr, littleEndian) {
  if (!bytes || bytes.length === 0) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vals = [];

  switch (vr) {
    case 'US':
      for (let i = 0; i + 2 <= bytes.length; i += 2) vals.push(String(view.getUint16(i, littleEndian)));
      break;
    case 'SS':
      for (let i = 0; i + 2 <= bytes.length; i += 2) vals.push(String(view.getInt16(i, littleEndian)));
      break;
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

/**
 * Parse encapsulated PixelData (undefined length) into raw bytes + fragment slices.
 */
function parseEncapsulatedPixelData(bytes, view, startOffset, endOffset, littleEndian) {
  let pos = startOffset;
  const fragments = [];
  let isFirstItem = true;
  let basicOffsetTable = null;

  while (pos + 8 <= endOffset) {
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    const len = view.getUint32(pos + 4, littleEndian);
    pos += 8;

    if (g === 0xfffe && e === 0xe0dd) {
      // Sequence delimitation item ends encapsulated pixel data
      break;
    }
    if (g === 0xfffe && e === 0xe000) {
      const fragEnd = Math.min(pos + len, endOffset);
      const fragBytes = bytes.slice(pos, fragEnd);
      if (isFirstItem) {
        basicOffsetTable = fragBytes;
        isFirstItem = false;
      } else {
        fragments.push(fragBytes);
      }
      pos = fragEnd;
    } else {
      // Unexpected tag inside encapsulated pixel data; advance safely to end
      pos = endOffset;
      break;
    }
  }

  return {
    nextOffset: pos,
    rawBytes: bytes.slice(startOffset, pos),
    fragments,
    basicOffsetTable,
  };
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
    depth = 0,
  } = opts;

  let pos = startOffset;
  let charset = inheritedCharset;
  const nodes = [];
  const privateCreators = new Map();

  while (pos + 8 <= endOffset) {
    const tagStart = pos;
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);

    // Delimitation items stop current dataset/item
    if (group === 0xfffe && (element === 0xe00d || element === 0xe0dd)) {
      pos += 8; // skip tag + 4-byte zero length
      return { nodes, nextOffset: pos, delimited: true, charset };
    }

    if (stopAfterGroup0002 && group > 0x0002) {
      return { nodes, nextOffset: tagStart, delimited: false, charset };
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
          if (pos + 4 > endOffset) break;
          length = view.getUint32(pos, littleEndian);
          pos += 4;
        } else {
          if (pos + 2 > endOffset) break;
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

    // Heuristic for Implicit VR or UN-encoded Private SQ (when length === 0xFFFFFFFF and next tag is FFFE,E000)
    if (
      (!explicit || vr === 'UN') &&
      undefinedLength &&
      vr !== 'SQ' &&
      hex !== '7FE00010' &&
      pos + 4 <= endOffset &&
      view.getUint16(pos, littleEndian) === 0xfffe &&
      view.getUint16(pos + 2, littleEndian) === 0xe000
    ) {
      vr = 'SQ';
      vrSource = 'inferred';
    }

    const dictInfo = lookupTag(group, element, privateCreators);
    const isPrivate = (group & 1) === 1;

    // 1) Sequence (SQ)
    if (vr === 'SQ') {
      const sqEnd = undefinedLength ? endOffset : Math.min(pos + length, endOffset);
      const items = [];
      let sqPos = pos;

      while (sqPos + 8 <= sqEnd) {
        const itemG = view.getUint16(sqPos, littleEndian);
        const itemE = view.getUint16(sqPos + 2, littleEndian);
        const itemLen = view.getUint32(sqPos + 4, littleEndian);
        sqPos += 8;

        if (itemG === 0xfffe && itemE === 0xe0dd) {
          break;
        }
        if (itemG === 0xfffe && itemE === 0xe000) {
          const itemUndef = itemLen === 0xffffffff;
          const itemLimit = itemUndef ? sqEnd : Math.min(sqPos + itemLen, sqEnd);
          const itemResult = parseDatasetRange(bytes, view, sqPos, itemLimit, {
            explicit,
            littleEndian,
            isMetaSection: false,
            stopAfterGroup0002: false,
            inheritedCharset: charset,
            depth: depth + 1,
          });
          items.push({
            id: genNodeId(),
            undefinedLength: itemUndef,
            children: itemResult.nodes,
          });
          sqPos = itemUndef ? itemResult.nextOffset : itemLimit;
        } else {
          // Unexpected tag inside SQ without delimiter; rewind 8 bytes so outer loop can read it
          sqPos -= 8;
          break;
        }
      }

      const rawEnd = undefinedLength ? sqPos : Math.min(pos + length, endOffset);
      nodes.push({
        id: genNodeId(),
        group,
        element,
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: dictInfo.keyword,
        name: dictInfo.name,
        vr: 'SQ',
        vrSource,
        vmSpec: dictInfo.vm,
        isMeta: isMetaSection,
        isPrivate,
        isSequence: true,
        isBinary: false,
        encapsulated: false,
        undefinedLength,
        rawLength: rawEnd - pos,
        rawBytes: null,
        originalValue: '',
        value: '',
        items,
        status: 'unchanged',
        validation: { valid: true, severity: 'ok', messages: [] },
      });
      pos = rawEnd;
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

    // 3) Unknown undefined-length non-SQ element (rare fallback: scan for FFFE,E0DD)
    let valEnd;
    if (undefinedLength) {
      let scan = pos;
      while (scan + 8 <= endOffset) {
        if (
          view.getUint16(scan, littleEndian) === 0xfffe &&
          view.getUint16(scan + 2, littleEndian) === 0xe0dd
        ) {
          scan += 8;
          break;
        }
        scan += 2;
      }
      valEnd = Math.min(scan, endOffset);
    } else {
      valEnd = Math.min(pos + length, endOffset);
    }

    const rawBytes = bytes.slice(pos, valEnd);
    pos = valEnd;

    const isBinary = BINARY_VRS.has(vr) || hex === '7FE00010';
    let decodedValue = '';

    if (isBinary) {
      decodedValue = `[Binary ${vr}: ${formatByteSize(rawBytes.length)}]`;
    } else if (NUMERIC_VRS.has(vr) || vr === 'AT') {
      decodedValue = decodeBinaryNumeric(rawBytes, vr, littleEndian);
    } else {
      decodedValue = decodeDicomString(rawBytes, vr, charset);
    }

    // Track SpecificCharacterSet for subsequent tags in this dataset
    if (hex === '00080005') {
      charset = decodedValue;
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
      : validateVrValue(vr, decodedValue);

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
      isPrivate,
      isSequence: false,
      isBinary,
      encapsulated: false,
      undefinedLength,
      rawLength: rawBytes.length,
      rawBytes,
      originalValue: decodedValue,
      value: decodedValue,
      status: 'unchanged',
      validation,
    });
  }

  return { nodes, nextOffset: pos, delimited: false, charset };
}

export function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Parse a complete DICOM ArrayBuffer into a structured editable document.
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} fileName
 */
export async function parseDicomBuffer(arrayBuffer, fileName = 'untitled.dcm') {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 16) {
    throw new Error('파일이 너무 작아 유효한 DICOM 파일이 아닙니다.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Detect Part 10 Preamble + "DICM"
  const hasPart10Header =
    bytes.length >= 132 &&
    bytes[128] === 0x44 && // D
    bytes[129] === 0x49 && // I
    bytes[130] === 0x43 && // C
    bytes[131] === 0x4d;   // M

  let preamble = hasPart10Header ? bytes.slice(0, 128) : new Uint8Array(128);
  let metaNodes = [];
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
  let transferSyntaxUid = tsNode ? tsNode.value.trim() : '';
  let tsInfo;

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
    const inflated = await inflateRawBytes(bytes.subarray(mainOffset));
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
    throw new Error('DICOM 태그를 찾을 수 없습니다. 올바른 .dcm 파일인지 확인해 주세요.');
  }

  return {
    fileName,
    fileSize: bytes.length,
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
}
