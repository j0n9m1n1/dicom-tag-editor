/**
 * Raw text (DCMTK dcmdump-style) & structured JSON exporters for DICOM documents.
 */

import { computeVm } from './parser.js';
import { BINARY_VRS, binaryValueUnitSize, getVrSpec, NUMERIC_VRS } from './vrSpec.js';
import { parseTagString } from './dictionary.js';

function padRight(str, len) {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function dumpNodes(nodes, depth, lines, includeDeleted) {
  const indent = '  '.repeat(depth);
  const encoder = new TextEncoder();

  for (const n of nodes || []) {
    if (!includeDeleted && n.status === 'deleted') continue;

    const tag = n.formattedTag.toLowerCase();
    const statusMark =
      n.status === 'modified' ? ' [MOD]' :
      n.status === 'added' ? ' [ADD]' :
      n.status === 'deleted' ? ' [DEL]' : '';

    if (n.isSequence) {
      const items = n.items || [];
      const lenStr = n.undefinedLength ? 'u/l' : String(n.rawLength);
      const left = `${indent}${tag} SQ (Sequence with ${n.undefinedLength ? 'undefined' : 'explicit'} length #=${items.length})`;
      lines.push(`${padRight(left, 64)} # ${lenStr.padStart(4)}, 1 ${n.keyword}${statusMark}`);

      items.forEach((item, idx) => {
        const iIndent = '  '.repeat(depth + 1);
        const childCount = (item.children || []).filter((c) => includeDeleted || c.status !== 'deleted').length;
        lines.push(`${iIndent}(fffe,e000) na (Item #${idx} with ${childCount} tag(s))`);
        dumpNodes(item.children, depth + 2, lines, includeDeleted);
        lines.push(`${iIndent}(fffe,e00d) na (ItemDelimitationItem)`);
      });

      lines.push(`${indent}(fffe,e0dd) na (SequenceDelimitationItem)`);
      continue;
    }

    const vm = computeVm(n);
    let valRepr;
    let byteLen;

    if (n.isBinary) {
      byteLen = n.rawLength;
      if (n.rawBytes && n.rawBytes.length > 0) {
        const preview = Array.from(n.rawBytes.subarray(0, 12))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('\\');
        valRepr = n.rawBytes.length > 12 ? `${preview}\\... (${byteLen} bytes)` : preview;
      } else {
        valRepr = '(no value available)';
      }
    } else if (n.value === '' || n.value === null || n.value === undefined) {
      byteLen = 0;
      valRepr = '(no value available)';
    } else {
      const spec = getVrSpec(n.vr);
      byteLen =
        n.status === 'unchanged' && n.rawBytes
          ? n.rawBytes.length
          : spec.fixedLength && (NUMERIC_VRS.has(n.vr) || n.vr === 'AT')
            ? vm * spec.fixedLength
            : encoder.encode(n.value).length;
      const singleLine = String(n.value).replace(/\r?\n/g, '\\n');
      valRepr = `[${singleLine}]`;
    }

    const left = `${indent}${tag} ${n.vr} ${valRepr}`;
    lines.push(`${padRight(left, 64)} # ${String(byteLen).padStart(4)}, ${vm} ${n.keyword}${statusMark}`);
  }
}

/**
 * Format document into DCMTK dcmdump-compatible text.
 */
export function formatDcmDump(doc, { includeDeleted = false } = {}) {
  if (!doc) return '';
  const lines = [
    '# Dicom-File-Format',
    `# File: ${doc.fileName}`,
    `# TransferSyntax: ${doc.transferSyntaxUid} (${doc.transferSyntaxInfo?.name || 'Unknown'})`,
    '',
  ];

  if (doc.hasPart10Header && doc.metaNodes.length > 0) {
    lines.push('# Dicom-Meta-Information-Header');
    lines.push('# Used TransferSyntax: Little Endian Explicit');
    dumpNodes(doc.metaNodes, 0, lines, includeDeleted);
    lines.push('');
  }

  lines.push('# Dicom-Data-Set');
  lines.push(`# Used TransferSyntax: ${doc.transferSyntaxInfo?.name || doc.transferSyntaxUid}`);
  dumpNodes(doc.datasetNodes, 0, lines, includeDeleted);
  return lines.join('\n');
}

const SORTED_DICOM_KEYS = { ownKeys: (dataset) => Object.keys(dataset).sort() };
const PN_GROUP_NAMES = ['Alphabetic', 'Ideographic', 'Phonetic'];

function jsonBinary(bytes, littleEndian, vr) {
  const wordSize = binaryValueUnitSize(vr);
  let value = bytes;
  if (!littleEndian && wordSize > 1) {
    value = new Uint8Array(bytes.length);
    for (let i = 0; i + wordSize <= bytes.length; i += wordSize) {
      for (let j = 0; j < wordSize; j++) value[i + j] = bytes[i + wordSize - 1 - j];
    }
  }
  if (typeof value.toBase64 === 'function') return value.toBase64();
  const chunks = [];
  const chunkSize = 24 * 1024; // Multiple of 3, so only the final base64 chunk can contain padding.
  for (let i = 0; i < value.length; i += chunkSize) {
    chunks.push(btoa(String.fromCharCode(...value.subarray(i, i + chunkSize))));
  }
  return chunks.join('');
}

function jsonValue(value, vr) {
  if (value === '') return null;
  if (vr === 'PN') {
    return Object.fromEntries(value.split('=').slice(0, 3)
      .map((group, i) => [PN_GROUP_NAMES[i], group]).filter(([, group]) => group));
  }
  if (vr === 'AT') return parseTagString(value)?.hex;
  if (NUMERIC_VRS.has(vr) && vr !== 'SV' && vr !== 'UV') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Cannot represent non-finite ${vr} as a DICOM JSON number.`);
    return number;
  }
  return value;
}

function nodesToJsonObj(nodes, includeDeleted, littleEndian) {
  const out = Object.create(null);
  for (const n of nodes || []) {
    if (!includeDeleted && n.status === 'deleted') continue;
    if (n.tag.endsWith('0000') || n.tag.startsWith('0002')) continue;
    const vr = n.isBinary && !BINARY_VRS.has(n.vr) ? 'UN' : n.vr;
    const entry = { vr };
    if (n.isSequence) {
      if (n.items?.length) entry.Value = n.items.map((item) => nodesToJsonObj(item.children, includeDeleted,
        n.sequenceEncodedAsUn || littleEndian));
    } else if (n.isBinary) {
      if (n.rawBytes?.length) entry.InlineBinary = jsonBinary(n.rawBytes, littleEndian, vr);
    } else if (n.value !== '' && n.value != null) {
      const values = getVrSpec(vr).allowMultiValue ? n.value.split('\\') : [n.value];
      entry.Value = values.map((value) => jsonValue(value, vr));
    }
    out[n.tag] = entry;
  }
  // ECMAScript orders numeric property names first by default; DICOM requires lexical order.
  return new Proxy(out, SORTED_DICOM_KEYS);
}

/**
 * Format the dataset as a PS3.18 DICOM JSON Model object.
 */
export function formatDicomJson(doc, { includeDeleted = false } = {}) {
  if (!doc) return '{}';
  return JSON.stringify(nodesToJsonObj(doc.datasetNodes, includeDeleted, doc.littleEndian !== false), null, 2);
}
