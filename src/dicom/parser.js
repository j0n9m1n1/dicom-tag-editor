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
import { decodeDicomString, usesSpecificCharacterSet } from './charset.js';

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
  const inflate = async (input) => {
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  try {
    return await inflate(compressed);
  } catch (err) {
    // PS3.5 A.5 pads an odd-length Deflate stream with one trailing NUL.
    if (compressed.length % 2 === 0 && compressed.at(-1) === 0) {
      return inflate(compressed.subarray(0, -1));
    }
    throw err;
  }
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

function checkedValueEnd(start, length, limit, tag) {
  const end = start + length;
  if (end > limit) throw new Error(`Truncated DICOM value at ${tag}.`);
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
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    const len = view.getUint32(pos + 4, littleEndian);
    pos += 8;

    if (g === 0xfffe && e === 0xe0dd && len === 0 && basicOffsetTable !== null) {
      return { nextOffset: pos, rawBytes: bytes.slice(startOffset, pos), fragments, basicOffsetTable };
    }
    if (g !== 0xfffe || e !== 0xe000) throw new Error('Invalid encapsulated Pixel Data item.');
    const fragEnd = checkedValueEnd(pos, len, endOffset, '(7FE0,0010)');
    const fragBytes = bytes.slice(pos, fragEnd);
    if (basicOffsetTable === null) {
      basicOffsetTable = fragBytes;
    } else {
      fragments.push(fragBytes);
    }
    pos = fragEnd;
  }
  throw new Error('Missing Sequence Delimitation Item for encapsulated Pixel Data.');
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
  } = opts;

  let pos = startOffset;
  let charset = inheritedCharset;
  const nodes = [];
  const privateCreators = new Map();

  while (pos + 8 <= endOffset) {
    const tagStart = pos;
    const group = view.getUint16(pos, littleEndian);
    const element = view.getUint16(pos + 2, littleEndian);

    if (stopAfterGroup0002 && group !== 0x0002) {
      return { nodes, nextOffset: tagStart };
    }

    if (group === 0xfffe) {
      if (expectItemDelimiter && element === 0xe00d && view.getUint32(pos + 4, littleEndian) === 0) {
        return { nodes, nextOffset: pos + 8 };
      }
      throw new Error(`Unexpected DICOM item ${formatTag(group, element)}.`);
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
          if (pos + 4 > endOffset) throw new Error(`Truncated DICOM header at ${formatTag(group, element)}.`);
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
        const itemG = view.getUint16(sqPos, itemLittleEndian);
        const itemE = view.getUint16(sqPos + 2, itemLittleEndian);
        const itemLen = view.getUint32(sqPos + 4, itemLittleEndian);
        sqPos += 8;

        if (undefinedLength && itemG === 0xfffe && itemE === 0xe0dd && itemLen === 0) {
          delimited = true;
          break;
        }
        if (itemG !== 0xfffe || itemE !== 0xe000) throw new Error(`Invalid DICOM sequence item at ${label}.`);
        const itemUndef = itemLen === 0xffffffff;
        const itemLimit = itemUndef ? sqEnd : checkedValueEnd(sqPos, itemLen, sqEnd, label);
        const itemResult = parseDatasetRange(bytes, view, sqPos, itemLimit, {
          explicit: itemExplicit,
          littleEndian: itemLittleEndian,
          inheritedCharset: charset,
          expectItemDelimiter: itemUndef,
        });
        items.push({ id: genNodeId(), undefinedLength: itemUndef, children: itemResult.nodes });
        sqPos = itemResult.nextOffset;
      }

      if (undefinedLength && !delimited) throw new Error(`Missing Sequence Delimitation Item at ${label}.`);
      if (!undefinedLength && sqPos !== sqEnd) throw new Error(`Truncated DICOM sequence at ${label}.`);
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
    if (undefinedLength) throw new Error(`Unsupported undefined DICOM value length at ${label}.`);
    const valEnd = checkedValueEnd(pos, length, endOffset, label);
    const rawBytes = bytes.slice(pos, valEnd);
    pos = valEnd;

    const isBinary = BINARY_VRS.has(vr) || hex === '7FE00010';
    const rawCharset = usesSpecificCharacterSet(vr) ? charset : undefined;
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

  if (expectItemDelimiter) throw new Error('Missing DICOM Item Delimitation Item.');
  if (!stopAfterGroup0002 && pos !== endOffset) throw new Error('Truncated DICOM element header.');
  return { nodes, nextOffset: pos };
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
