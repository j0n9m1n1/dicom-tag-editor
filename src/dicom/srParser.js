/**
 * DICOM Structured Report (SR) parser & plain-text/Markdown formatter.
 * Decodes (0040,A730) Content Sequence recursively across ALL standard SR Value Types:
 *  CONTAINER, TEXT, CODE, NUM (+ measurement units), PNAME, DATE, TIME, DATETIME,
 *  UIDREF, IMAGE, WAVEFORM, COMPOSITE, SCOORD, SCOORD3D, TCOORD.
 */

import { lookupUidName } from './dictionary.js';

function findActive(nodes, hex) {
  return (nodes || []).find((n) => n.tag === hex && n.status !== 'deleted') || null;
}

function getActiveValue(nodes, hex) {
  const n = findActive(nodes, hex);
  return n && !n.isBinary && !n.isSequence ? String(n.value || '').trim() : '';
}

function extractCodeTriplet(seqNode) {
  if (!seqNode?.isSequence || !seqNode.items?.length) return null;
  const children = seqNode.items[0].children || [];
  const codeValue = getActiveValue(children, '00080100') || getActiveValue(children, '00080119') || getActiveValue(children, '00080120');
  const scheme = getActiveValue(children, '00080102');
  const meaning = getActiveValue(children, '00080104');
  if (!codeValue && !meaning) return null;
  return { codeValue, scheme, meaning };
}

function formatCode(triplet) {
  if (!triplet) return '';
  const codePart = triplet.codeValue
    ? triplet.scheme
      ? `(${triplet.codeValue}, ${triplet.scheme})`
      : `(${triplet.codeValue})`
    : '';
  if (triplet.meaning && codePart) return `${triplet.meaning} ${codePart}`;
  return triplet.meaning || codePart;
}

function formatDicomDate(val) {
  if (/^\d{8}$/.test(val)) return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
  return val;
}

function formatDicomTime(val) {
  const m = /^(\d{2})(\d{2})(\d{2})?(.*)$/.exec(val);
  if (!m) return val;
  return `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}${m[4] || ''}`;
}

function formatDicomDateTime(val) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(.*)$/.exec(val);
  if (!m) return val;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return date;
  const time = `${m[4]}:${m[5] || '00'}${m[6] ? `:${m[6]}` : ''}${m[7] || ''}`;
  return `${date} ${time}`;
}

/**
 * Determine whether a parsed DICOM document contains Structured Report (SR) content.
 * @param {any} doc
 * @returns {boolean}
 */
export function isSrDocument(doc) {
  if (!doc) return false;
  const nodes = doc.datasetNodes || [];
  if (findActive(nodes, '0040A730')?.isSequence) return true;
  if (getActiveValue(nodes, '00080060').toUpperCase() === 'SR') return true;
  const sopClass = getActiveValue(nodes, '00080016');
  return sopClass.startsWith('1.2.840.10008.5.1.4.1.1.88.');
}

function parseSrItem(nodes, itemId, depth) {
  const valueType = getActiveValue(nodes, '0040A040').toUpperCase() || 'CONTAINER';
  const relationship = getActiveValue(nodes, '0040A010').toUpperCase();
  const concept = extractCodeTriplet(findActive(nodes, '0040A043'));
  const continuity = getActiveValue(nodes, '0040A050').toUpperCase();

  let valueText = '';
  let valueDetail = '';
  let jumpNodeId = itemId || findActive(nodes, '0040A040')?.id || findActive(nodes, '0040A043')?.id || null;

  switch (valueType) {
    case 'TEXT': {
      const n = findActive(nodes, '0040A160');
      valueText = n ? String(n.value || '') : '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'CODE': {
      const seq = findActive(nodes, '0040A168');
      const code = extractCodeTriplet(seq);
      valueText = code?.meaning || code?.codeValue || '';
      valueDetail = code?.codeValue
        ? code.scheme ? `${code.codeValue}, ${code.scheme}` : code.codeValue
        : '';
      if (seq) jumpNodeId = seq.id;
      break;
    }
    case 'NUM': {
      const measSeq = findActive(nodes, '0040A300');
      const qualSeq = findActive(nodes, '0040A301');
      if (measSeq?.isSequence && measSeq.items?.length) {
        const mc = measSeq.items[0].children || [];
        const numNode = findActive(mc, '0040A30A') || findActive(mc, '0040A161');
        const numVal = numNode ? String(numNode.value || '').trim() : '';
        const unitCode = extractCodeTriplet(findActive(mc, '004008EA'));
        const unitStr = unitCode?.codeValue || unitCode?.meaning || '';
        valueText = numVal ? (unitStr ? `${numVal} ${unitStr}` : numVal) : '';
        if (unitCode?.meaning && unitCode.meaning !== unitCode.codeValue) {
          valueDetail = unitCode.meaning;
        }
        if (numNode) jumpNodeId = numNode.id;
        else jumpNodeId = measSeq.id;
      }
      if (!valueText && qualSeq) {
        const qCode = extractCodeTriplet(qualSeq);
        valueText = formatCode(qCode);
        jumpNodeId = qualSeq.id;
      }
      break;
    }
    case 'PNAME': {
      const n = findActive(nodes, '0040A123');
      valueText = n ? String(n.value || '').trim() : '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'DATE': {
      const n = findActive(nodes, '0040A121');
      valueText = n ? formatDicomDate(String(n.value || '').trim()) : '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'TIME': {
      const n = findActive(nodes, '0040A122');
      valueText = n ? formatDicomTime(String(n.value || '').trim()) : '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'DATETIME': {
      const n = findActive(nodes, '0040A120');
      valueText = n ? formatDicomDateTime(String(n.value || '').trim()) : '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'UIDREF': {
      const n = findActive(nodes, '0040A124');
      const uid = n ? String(n.value || '').trim() : '';
      const known = uid ? lookupUidName(uid) : null;
      valueText = uid;
      valueDetail = known || '';
      if (n) jumpNodeId = n.id;
      break;
    }
    case 'IMAGE':
    case 'WAVEFORM':
    case 'COMPOSITE': {
      const refSeq = findActive(nodes, '00081199');
      if (refSeq?.isSequence && refSeq.items?.length) {
        const refs = refSeq.items.map((it) => {
          const rc = it.children || [];
          const cls = getActiveValue(rc, '00081150');
          const inst = getActiveValue(rc, '00081155');
          const frame = getActiveValue(rc, '00081160');
          const clsName = cls ? (lookupUidName(cls) || cls) : '';
          return { clsName, inst, frame };
        });
        const first = refs[0];
        valueText = first.inst || first.clsName || `${refs.length} ref(s)`;
        const detailParts = [];
        if (first.clsName && first.clsName !== valueText) detailParts.push(first.clsName);
        if (first.frame) detailParts.push(`Frame ${first.frame}`);
        if (refs.length > 1) detailParts.push(`+${refs.length - 1} more`);
        valueDetail = detailParts.join(' · ');
        jumpNodeId = refSeq.id;
      }
      break;
    }
    case 'SCOORD':
    case 'SCOORD3D': {
      const gType = getActiveValue(nodes, '00700023');
      const gDataNode = findActive(nodes, '00700022');
      const rawCoords = gDataNode && !gDataNode.isBinary ? String(gDataNode.value || '').split('\\').filter(Boolean) : [];
      const dim = valueType === 'SCOORD3D' ? 3 : 2;
      const ptCount = Math.floor(rawCoords.length / dim);
      valueText = gType || valueType;
      if (ptCount > 0) {
        const preview = rawCoords
          .slice(0, dim * 2)
          .map((v) => {
            const num = Number(v);
            return Number.isFinite(num) ? num.toFixed(1) : v;
          })
          .join(', ');
        valueDetail = `${ptCount} pt(s) [${preview}${rawCoords.length > dim * 2 ? ', …' : ''}]`;
      }
      if (gDataNode) jumpNodeId = gDataNode.id;
      break;
    }
    case 'TCOORD': {
      const tType = getActiveValue(nodes, '0040A130');
      const samplePos = getActiveValue(nodes, '0040A132');
      const timeOff = getActiveValue(nodes, '0040A138');
      valueText = tType || 'TCOORD';
      valueDetail = samplePos || timeOff || '';
      break;
    }
    case 'CONTAINER': {
      if (continuity) valueDetail = continuity;
      break;
    }
    default:
      break;
  }

  const contentSeq = findActive(nodes, '0040A730');
  const children = [];
  if (contentSeq?.isSequence && contentSeq.items?.length) {
    for (const childItem of contentSeq.items) {
      children.push(parseSrItem(childItem.children || [], childItem.id, depth + 1));
    }
  }

  return {
    id: itemId || `sr_${depth}_${Math.random().toString(36).slice(2, 8)}`,
    depth,
    valueType,
    relationship,
    conceptName: concept?.meaning || '',
    conceptCode: concept?.codeValue
      ? concept.scheme ? `${concept.codeValue}, ${concept.scheme}` : concept.codeValue
      : '',
    valueText,
    valueDetail,
    jumpNodeId,
    children,
  };
}

/**
 * Parse a DICOM document into a Structured Report tree with document-level metadata.
 * @param {any} doc
 */
export function extractSrDocument(doc) {
  if (!doc) return null;
  const nodes = doc.datasetNodes || [];
  const rootConcept = extractCodeTriplet(findActive(nodes, '0040A043'));
  const completionFlag = getActiveValue(nodes, '0040A491');
  const verificationFlag = getActiveValue(nodes, '0040A493');
  const contentDate = formatDicomDate(getActiveValue(nodes, '00080023'));
  const contentTime = formatDicomTime(getActiveValue(nodes, '00080033'));
  const sopClassUid = getActiveValue(nodes, '00080016');
  const sopClassName = lookupUidName(sopClassUid) || sopClassUid || 'Structured Report';
  const patientName = getActiveValue(nodes, '00100010');
  const patientId = getActiveValue(nodes, '00100020');
  const studyDesc = getActiveValue(nodes, '00081030');

  const contentSeq = findActive(nodes, '0040A730');
  const items = [];
  if (contentSeq?.isSequence && contentSeq.items?.length) {
    for (const item of contentSeq.items) {
      items.push(parseSrItem(item.children || [], item.id, 0));
    }
  }

  let totalCount = 0;
  const countAll = (list) => {
    for (const it of list) {
      totalCount++;
      if (it.children.length > 0) countAll(it.children);
    }
  };
  countAll(items);

  return {
    title: rootConcept?.meaning || studyDesc || sopClassName,
    titleCode: rootConcept ? formatCode(rootConcept) : '',
    sopClassName,
    completionFlag,
    verificationFlag,
    contentDate,
    contentTime,
    patientName,
    patientId,
    totalCount,
    items,
  };
}

/**
 * Render an extracted SR document as readable Markdown text for Copy / Export.
 * @param {ReturnType<typeof extractSrDocument>} sr
 * @param {string} [fileName]
 */
export function formatSrMarkdown(sr, fileName = '') {
  if (!sr) return '';
  const lines = [`# ${sr.title}`];
  if (fileName) lines.push(`- **File:** ${fileName}`);
  lines.push(`- **SOP Class:** ${sr.sopClassName}`);
  if (sr.completionFlag || sr.verificationFlag) {
    lines.push(`- **Status:** ${[sr.completionFlag, sr.verificationFlag].filter(Boolean).join(' / ')}`);
  }
  if (sr.contentDate || sr.contentTime) {
    lines.push(`- **Content Date/Time:** ${[sr.contentDate, sr.contentTime].filter(Boolean).join(' ')}`);
  }
  if (sr.patientName || sr.patientId) {
    lines.push(`- **Patient:** ${[sr.patientName, sr.patientId ? `(${sr.patientId})` : ''].filter(Boolean).join(' ')}`);
  }
  lines.push('');

  const walk = (list) => {
    for (const item of list) {
      const indent = '  '.repeat(item.depth);
      const concept = item.conceptName || item.conceptCode || item.valueType;
      const val = item.valueText
        ? item.valueDetail ? `${item.valueText} (${item.valueDetail})` : item.valueText
        : item.valueDetail;
      const rel = item.relationship ? `${item.relationship} ` : '';
      lines.push(
        val
          ? `${indent}- **[${item.valueType}]** ${rel}${concept}: ${val}`
          : `${indent}- **[${item.valueType}]** ${rel}${concept}`
      );
      if (item.children.length > 0) walk(item.children);
    }
  };
  walk(sr.items);
  return lines.join('\n');
}
