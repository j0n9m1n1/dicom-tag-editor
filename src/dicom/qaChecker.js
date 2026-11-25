/**
 * High-signal, zero-false-positive DICOM Conformance & Integrity QA Checker.
 * Checks only concrete structural, VR, UID, charset, pixel, SR, and PHI consistency rules
 * without triggering flat-dataset false positives on nested macro/conditional tags.
 */

import { hasNonAscii, isUtf8Charset, usesSpecificCharacterSet } from './charset.js';
import { isPhiNode } from './phiSpec.js';
import { isSrDocument } from './srParser.js';

function findActive(nodes, hex) {
  return (nodes || []).find((n) => n.tag === hex && n.status !== 'deleted') || null;
}

function getVal(nodes, hex) {
  const n = findActive(nodes, hex);
  return n && !n.isBinary && !n.isSequence ? String(n.value || '').trim() : '';
}

/**
 * Run deterministic conformance & integrity checks on a parsed DICOM document.
 * @param {any} doc
 * @returns {{
 *   errors: Array<{ code: string, severity: 'error', tag?: string, nodeId?: string, params?: Record<string, any> }>,
 *   warnings: Array<{ code: string, severity: 'warning', tag?: string, nodeId?: string, params?: Record<string, any> }>,
 *   infos: Array<{ code: string, severity: 'info', tag?: string, nodeId?: string, params?: Record<string, any> }>,
 *   phiCount: number,
 *   checkedRules: number,
 * }}
 */
export function runDicomQaCheck(doc) {
  const errors = [];
  const warnings = [];
  const infos = [];
  if (!doc) return { errors, warnings, infos, phiCount: 0, checkedRules: 0 };

  const meta = doc.metaNodes || [];
  const main = doc.datasetNodes || [];
  let checkedRules = 0;

  // 1) Recursive VR validation errors & PHI count & charset checks
  let phiCount = 0;
  let nonAsciiWithoutUtf8 = 0;
  let firstNonAsciiNodeId = null;

  const walk = (nodes, inheritedCharset, section) => {
    const csNode = findActive(nodes, '00080005');
    const charset = csNode ? String(csNode.value || '').trim() : inheritedCharset;
    for (const n of nodes || []) {
      if (n.status === 'deleted') continue;
      if (isPhiNode(n) && (n.isBinary || String(n.value || '').trim() !== '')) {
        phiCount++;
      }
      if (!n.isBinary && !n.isSequence) {
        if (n.validation && !n.validation.valid) {
          errors.push({
            code: 'qaVrError',
            severity: 'error',
            tag: n.formattedTag,
            nodeId: n.id,
            params: {
              tag: n.formattedTag,
              keyword: n.keyword,
              vr: n.vr,
              detail: n.validation.messages.join(' / '),
            },
          });
        }
        if (
          section === 'main' &&
          usesSpecificCharacterSet(n.vr) &&
          hasNonAscii(n.value) &&
          !isUtf8Charset(charset)
        ) {
          nonAsciiWithoutUtf8++;
          if (!firstNonAsciiNodeId) firstNonAsciiNodeId = n.id;
        }
      }
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children, charset, section);
      }
    }
  };
  walk(meta, '', 'meta');
  walk(main, '', 'main');
  checkedRules += 2;

  if (nonAsciiWithoutUtf8 > 0) {
    warnings.push({
      code: 'qaCharsetMismatch',
      severity: 'warning',
      tag: '(0008,0005)',
      nodeId: findActive(main, '00080005')?.id || firstNonAsciiNodeId,
      params: { count: nonAsciiWithoutUtf8, charset: getVal(main, '00080005') || '(default ASCII)' },
    });
  }

  // 2) Part 10 File Meta consistency
  checkedRules++;
  if (doc.hasPart10Header) {
    const metaSopClass = getVal(meta, '00020002');
    const mainSopClass = getVal(main, '00080016');
    if (metaSopClass && mainSopClass && metaSopClass !== mainSopClass) {
      errors.push({
        code: 'qaMetaSopClassMismatch',
        severity: 'error',
        tag: '(0002,0002)',
        nodeId: findActive(meta, '00020002')?.id,
        params: { metaVal: metaSopClass, mainVal: mainSopClass },
      });
    }

    const metaSopInst = getVal(meta, '00020003');
    const mainSopInst = getVal(main, '00080018');
    if (metaSopInst && mainSopInst && metaSopInst !== mainSopInst) {
      errors.push({
        code: 'qaMetaSopInstMismatch',
        severity: 'error',
        tag: '(0002,0003)',
        nodeId: findActive(meta, '00020003')?.id,
        params: { metaVal: metaSopInst, mainVal: mainSopInst },
      });
    }

    if (!getVal(meta, '00020010')) {
      errors.push({
        code: 'qaMissingTag',
        severity: 'error',
        tag: '(0002,0010)',
        params: { tag: '(0002,0010)', keyword: 'TransferSyntaxUID' },
      });
    }
  } else {
    infos.push({ code: 'qaRawNoPart10', severity: 'info' });
  }

  // 3) Core root IOD UIDs & Modality (skip for DICOMDIR Media Storage Directory)
  const isDicomDir = getVal(meta, '00020002') === '1.2.840.10008.1.3.10';
  if (!isDicomDir) {
    checkedRules++;
    const coreRequired = [
      ['00080016', '(0008,0016)', 'SOPClassUID'],
      ['00080018', '(0008,0018)', 'SOPInstanceUID'],
      ['0020000D', '(0020,000D)', 'StudyInstanceUID'],
      ['0020000E', '(0020,000E)', 'SeriesInstanceUID'],
      ['00080060', '(0008,0060)', 'Modality'],
    ];
    for (const [hex, fmt, kw] of coreRequired) {
      const node = findActive(main, hex);
      if (!node || !String(node.value || '').trim()) {
        warnings.push({
          code: 'qaMissingTag',
          severity: 'warning',
          tag: fmt,
          nodeId: node?.id,
          params: { tag: fmt, keyword: kw },
        });
      }
    }
  }

  // 4) Image Pixel consistency (only if PixelData is present)
  const pixelNode = findActive(main, '7FE00010');
  if (pixelNode) {
    checkedRules++;
    const parseNum = (s) => (s !== '' ? Number(s) : NaN);
    const rows = parseNum(getVal(main, '00280010'));
    const cols = parseNum(getVal(main, '00280011'));
    const bitsAlloc = parseNum(getVal(main, '00280100'));
    const bitsStored = parseNum(getVal(main, '00280101'));
    const highBit = parseNum(getVal(main, '00280102'));
    if (!Number.isFinite(rows) || rows <= 0 || !Number.isFinite(cols) || cols <= 0) {
      errors.push({
        code: 'qaPixelDimInvalid',
        severity: 'error',
        tag: '(0028,0010)',
        nodeId: findActive(main, '00280010')?.id || pixelNode.id,
      });
    }
    if (Number.isFinite(bitsAlloc) && bitsAlloc > 0 && Number.isFinite(bitsStored) && bitsStored > bitsAlloc) {
      errors.push({
        code: 'qaPixelBitsInvalid',
        severity: 'error',
        tag: '(0028,0101)',
        nodeId: findActive(main, '00280101')?.id,
        params: { stored: bitsStored, alloc: bitsAlloc },
      });
    }
    if (Number.isFinite(bitsAlloc) && bitsAlloc > 0 && Number.isFinite(highBit) && highBit >= bitsAlloc) {
      errors.push({
        code: 'qaPixelHighBitInvalid',
        severity: 'error',
        tag: '(0028,0102)',
        nodeId: findActive(main, '00280102')?.id,
        params: { highBit, alloc: bitsAlloc },
      });
    }
  }

  // 5) Structured Report (SR) header checks
  if (isSrDocument(doc)) {
    checkedRules++;
    if (!findActive(main, '0040A730')?.isSequence) {
      warnings.push({
        code: 'qaMissingTag',
        severity: 'warning',
        tag: '(0040,A730)',
        params: { tag: '(0040,A730)', keyword: 'ContentSequence' },
      });
    }
    const comp = getVal(main, '0040A491');
    if (comp && comp !== 'PARTIAL' && comp !== 'COMPLETE') {
      warnings.push({
        code: 'qaSrFlagInvalid',
        severity: 'warning',
        tag: '(0040,A491)',
        nodeId: findActive(main, '0040A491')?.id,
        params: { tag: '(0040,A491)', value: comp, expected: 'PARTIAL / COMPLETE' },
      });
    }
    const verif = getVal(main, '0040A493');
    if (verif && verif !== 'UNVERIFIED' && verif !== 'VERIFIED') {
      warnings.push({
        code: 'qaSrFlagInvalid',
        severity: 'warning',
        tag: '(0040,A493)',
        nodeId: findActive(main, '0040A493')?.id,
        params: { tag: '(0040,A493)', value: verif, expected: 'UNVERIFIED / VERIFIED' },
      });
    }
  }

  // 6) PHI advisory
  checkedRules++;
  if (phiCount > 0) {
    infos.push({
      code: 'qaPhiPresent',
      severity: 'info',
      params: { count: phiCount },
    });
  }

  return { errors, warnings, infos, phiCount, checkedRules };
}
