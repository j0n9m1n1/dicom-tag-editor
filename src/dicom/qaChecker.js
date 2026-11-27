/**
 * High-signal, zero-false-positive DICOM Conformance & Integrity QA Checker.
 * Checks only concrete structural, VR, UID, charset, pixel, SR, and PHI consistency rules
 * without triggering flat-dataset false positives on nested macro/conditional tags.
 */

import { dicomStringEncodingError } from './charset.js';
import { isPhiNode } from './phiSpec.js';
import { isSrDocument } from './srParser.js';
import { NUMERIC_VRS, validateVrValue } from './vrSpec.js';

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
  let charsetIssueCount = 0;
  let firstCharsetIssue = null;

  const walk = (nodes, inheritedCharset) => {
    const csNode = findActive(nodes, '00080005');
    const charset = csNode ? String(csNode.value || '').trim() : inheritedCharset;
    for (const n of nodes || []) {
      if (n.status === 'deleted') continue;
      if (isPhiNode(n) && (n.isBinary || n.isSequence || String(n.value || '').trim() !== '')) {
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
        if (!NUMERIC_VRS.has(n.vr) && n.vr !== 'AT') {
          const charsetChanged = n.rawCharset !== undefined && n.rawCharset !== charset;
          const usesOriginalText = n.status === 'unchanged' || n.value === n.originalValue;
          const charsetIssue = (usesOriginalText && n.rawBytes && n.charsetError) ||
            ((n.status !== 'unchanged' || charsetChanged) && dicomStringEncodingError(n.value, n.vr, charset, n.tag));
          if (charsetIssue) {
            charsetIssueCount++;
            firstCharsetIssue ??= { id: n.id, charset };
          }
        }
      }
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children, charset);
      }
    }
  };
  walk(meta, '');
  walk(main, '');
  checkedRules += 2;

  if (charsetIssueCount > 0) {
    warnings.push({
      code: 'qaCharsetMismatch',
      severity: 'warning',
      tag: '(0008,0005)',
      nodeId: firstCharsetIssue.id,
      params: { count: charsetIssueCount, charset: firstCharsetIssue.charset || '(default ASCII)' },
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

    const requiredMeta = [
      ['00020000', 'FileMetaInformationGroupLength'],
      ['00020001', 'FileMetaInformationVersion'],
      ['00020002', 'MediaStorageSOPClassUID'],
      ['00020003', 'MediaStorageSOPInstanceUID'],
      ['00020010', 'TransferSyntaxUID'],
      ['00020012', 'ImplementationClassUID'],
    ];
    for (const [hex, keyword] of requiredMeta) {
      const node = findActive(meta, hex);
      const value = getVal(meta, hex);
      const valid = hex === '00020000' ? node?.vr === 'UL' && Boolean(value)
        : hex === '00020001' ? node?.vr === 'OB' && node.rawBytes?.length === 2 && (node.rawBytes[1] & 1)
          : node?.vr === 'UI' && value && !value.includes('\\') && validateVrValue('UI', value, hex).valid;
      if (valid) continue;
      const tag = `(0002,${hex.slice(4)})`;
      errors.push({ code: 'qaMissingTag', severity: 'error', tag, params: { tag, keyword }, nodeId: node?.id });
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
    const samples = parseNum(getVal(main, '00280002'));
    const pixelRep = parseNum(getVal(main, '00280103'));
    const frames = parseNum(getVal(main, '00280008') || '1');
    const photometric = getVal(main, '00280004');
    const validGeometry = [rows, cols, samples, frames].every((value) => Number.isSafeInteger(value) && value > 0);
    if (!validGeometry) {
      errors.push({
        code: 'qaPixelDimInvalid',
        severity: 'error',
        tag: '(0028,0010)',
        nodeId: findActive(main, '00280010')?.id || pixelNode.id,
      });
    }
    const validBits = Number.isInteger(bitsAlloc) && (bitsAlloc === 1 || (bitsAlloc > 0 && bitsAlloc % 8 === 0)) &&
      Number.isInteger(bitsStored) && bitsStored >= 1 && bitsStored <= bitsAlloc;
    if (!validBits) {
      errors.push({
        code: 'qaPixelBitsInvalid',
        severity: 'error',
        tag: '(0028,0101)',
        nodeId: findActive(main, '00280101')?.id,
        params: { stored: bitsStored, alloc: bitsAlloc },
      });
    }
    if (!Number.isInteger(highBit) || highBit < bitsStored - 1 || highBit >= bitsAlloc) {
      errors.push({
        code: 'qaPixelHighBitInvalid',
        severity: 'error',
        tag: '(0028,0102)',
        nodeId: findActive(main, '00280102')?.id,
        params: { highBit, stored: bitsStored, alloc: bitsAlloc },
      });
    } else if (validBits && highBit !== bitsStored - 1) {
      warnings.push({
        code: 'qaPixelHighBitUnusual', severity: 'warning', tag: '(0028,0102)',
        nodeId: findActive(main, '00280102')?.id, params: { highBit, stored: bitsStored, alloc: bitsAlloc },
      });
    }
    if (pixelRep !== 0 && pixelRep !== 1) {
      const tag = '(0028,0103)';
      errors.push({ code: 'qaMissingTag', severity: 'error', tag, params: { tag, keyword: 'PixelRepresentation' } });
    }
    if (!photometric) {
      const tag = '(0028,0004)';
      errors.push({ code: 'qaMissingTag', severity: 'error', tag, params: { tag, keyword: 'PhotometricInterpretation' } });
    }
    if (!pixelNode.encapsulated && validGeometry && validBits && pixelNode.rawBytes) {
      const channels = photometric === 'YBR_FULL_422' ? 2 : samples;
      const byteLength = Math.ceil(rows * cols * channels * frames * bitsAlloc / 8);
      const expected = byteLength + byteLength % 2;
      if (!Number.isSafeInteger(expected) || pixelNode.rawBytes.length !== expected) {
        errors.push({ code: 'qaPixelByteCountInvalid', severity: 'error', tag: '(7FE0,0010)', nodeId: pixelNode.id,
          params: { expected, actual: pixelNode.rawBytes.length } });
      }
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
