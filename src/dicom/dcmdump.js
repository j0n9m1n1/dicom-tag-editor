/**
 * Raw text (DCMTK dcmdump-style) & structured JSON exporters for DICOM documents.
 */

import { computeVm } from './parser.js';
import { getVrSpec, NUMERIC_VRS } from './vrSpec.js';

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

function nodesToJsonObj(nodes, includeDeleted) {
  const out = {};
  for (const n of nodes || []) {
    if (!includeDeleted && n.status === 'deleted') continue;
    const entry = {
      tag: n.formattedTag,
      keyword: n.keyword,
      vr: n.vr,
    };
    if (n.status !== 'unchanged') entry.status = n.status;
    if (n.isSequence) {
      entry.Value = (n.items || []).map((item) => nodesToJsonObj(item.children, includeDeleted));
    } else if (n.isBinary) {
      entry.byteLength = n.rawLength;
      if (n.encapsulated) entry.fragments = (n.fragments || []).length;
    } else {
      const spec = getVrSpec(n.vr);
      entry.Value = n.value === '' ? [] : spec.allowMultiValue ? n.value.split('\\') : [n.value];
    }
    out[n.tag] = entry;
  }
  return out;
}

/**
 * Format document into clean structured DICOM JSON text.
 */
export function formatDicomJson(doc, { includeDeleted = false } = {}) {
  if (!doc) return '{}';
  const payload = {
    fileName: doc.fileName,
    transferSyntaxUID: doc.transferSyntaxUid,
    transferSyntaxName: doc.transferSyntaxInfo?.name || '',
    fileMetaInformation: nodesToJsonObj(doc.metaNodes, includeDeleted),
    dataset: nodesToJsonObj(doc.datasetNodes, includeDeleted),
  };
  return JSON.stringify(payload, null, 2);
}
