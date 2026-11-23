/**
 * DICOM PS3.6 Standard Data Element Dictionary & Transfer Syntax Registry.
 * Keys are normalized 8-char uppercase hex strings: "GGGGEEEE".
 */

import { STANDARD_DICT, STANDARD_SOP_UIDS } from './standardDict.js';

export const TRANSFER_SYNTAXES = {
  '1.2.840.10008.1.2': {
    name: 'Implicit VR Little Endian',
    explicit: false, littleEndian: true, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.1': {
    name: 'Explicit VR Little Endian',
    explicit: true, littleEndian: true, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.1.99': {
    name: 'Deflated Explicit VR Little Endian',
    explicit: true, littleEndian: true, compressed: false, deflated: true,
  },
  '1.2.840.10008.1.2.2': {
    name: 'Explicit VR Big Endian (Retired)',
    explicit: true, littleEndian: false, compressed: false, deflated: false,
  },
  '1.2.840.10008.1.2.4.50': {
    name: 'JPEG Baseline (Process 1)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-baseline',
  },
  '1.2.840.10008.1.2.4.51': {
    name: 'JPEG Extended (Process 2 & 4)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-baseline',
  },
  '1.2.840.10008.1.2.4.57': {
    name: 'JPEG Lossless, Non-Hierarchical (Process 14)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-lossless',
  },
  '1.2.840.10008.1.2.4.70': {
    name: 'JPEG Lossless, Non-Hierarchical, First-Order Prediction',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-lossless',
  },
  '1.2.840.10008.1.2.4.80': {
    name: 'JPEG-LS Lossless Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-ls',
  },
  '1.2.840.10008.1.2.4.81': {
    name: 'JPEG-LS Lossy (Near-Lossless) Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg-ls',
  },
  '1.2.840.10008.1.2.4.90': {
    name: 'JPEG 2000 Image Compression (Lossless Only)',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg2000',
  },
  '1.2.840.10008.1.2.4.91': {
    name: 'JPEG 2000 Image Compression',
    explicit: true, littleEndian: true, compressed: true, codec: 'jpeg2000',
  },
  '1.2.840.10008.1.2.4.201': {
    name: 'High-Throughput JPEG 2000 (Lossless Only)',
    explicit: true, littleEndian: true, compressed: true, codec: 'htj2k',
  },
  '1.2.840.10008.1.2.4.203': {
    name: 'High-Throughput JPEG 2000',
    explicit: true, littleEndian: true, compressed: true, codec: 'htj2k',
  },
  '1.2.840.10008.1.2.5': {
    name: 'RLE Lossless',
    explicit: true, littleEndian: true, compressed: true, codec: 'rle',
  },
};

export function getTransferSyntaxInfo(uid) {
  const clean = (uid || '').replace(/\0+$/, '').trim();
  return TRANSFER_SYNTAXES[clean] || {
    name: clean ? `Unknown (${clean})` : 'Implicit VR Little Endian (Default)',
    explicit: clean !== '',
    littleEndian: true,
    compressed: false,
    deflated: false,
  };
}

export const KNOWN_SOP_UIDS = STANDARD_SOP_UIDS;

/**
 * Resolve human-readable name for a well-known DICOM Transfer Syntax or SOP Class UID.
 * @param {string} uid
 * @returns {string|null}
 */
export function lookupUidName(uid) {
  const clean = (uid || '').replace(/\0+$/, '').trim();
  if (!clean) return null;
  if (TRANSFER_SYNTAXES[clean]) return TRANSFER_SYNTAXES[clean].name;
  if (KNOWN_SOP_UIDS[clean]) return KNOWN_SOP_UIDS[clean];
  return null;
}

function keywordToDisplayName(keyword) {
  return keyword
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

/**
 * Standard DICOM PS3.6 tags whose VR is "US or SS" depending on PixelRepresentation (0028,0103).
 * Used to infer SS vs US in Implicit VR datasets while preserving Explicit VR as encoded.
 */
export const PIXEL_REP_SIGNED_TAGS = new Set([
  '00189810', // ZeroVelocityPixelValue
  '00280104', // SmallestValidPixelValue (Ret)
  '00280105', // LargestValidPixelValue (Ret)
  '00280106', // SmallestImagePixelValue
  '00280107', // LargestImagePixelValue
  '00280108', // SmallestPixelValueInSeries
  '00280109', // LargestPixelValueInSeries
  '00280110', // SmallestImagePixelValueInPlane
  '00280111', // LargestImagePixelValueInPlane
  '00280120', // PixelPaddingValue
  '00280121', // PixelPaddingRangeLimit
  '00281100', // GrayLookupTableDescriptor (Ret)
  '00281101', // RedPaletteColorLookupTableDescriptor
  '00281102', // GreenPaletteColorLookupTableDescriptor
  '00281103', // BluePaletteColorLookupTableDescriptor
  '00283002', // LUTDescriptor
  '00409211', // RealWorldValueLastValueMapped
  '00409216', // RealWorldValueFirstValueMapped
  '00603004', // HistogramFirstBinValue
  '00603006', // HistogramLastBinValue
]);

/**
 * Standard NEMA PS3.6 repeating Overlay group (60xx, even groups) elements.
 */
const OVERLAY_ELEMENTS = {
  0x0010: ['OverlayRows', 'US', '1'],
  0x0011: ['OverlayColumns', 'US', '1'],
  0x0012: ['OverlayPlanes', 'US', '1'],
  0x0015: ['NumberOfFramesInOverlay', 'IS', '1'],
  0x0022: ['OverlayDescription', 'LO', '1'],
  0x0040: ['OverlayType', 'CS', '1'],
  0x0045: ['OverlaySubtype', 'LO', '1'],
  0x0050: ['OverlayOrigin', 'SS', '2'],
  0x0051: ['ImageFrameOrigin', 'US', '1'],
  0x0052: ['OverlayPlaneOrigin', 'US', '1'],
  0x0100: ['OverlayBitsAllocated', 'US', '1'],
  0x0102: ['OverlayBitPosition', 'US', '1'],
  0x0110: ['OverlayFormat', 'CS', '1'],
  0x0200: ['OverlayLocation', 'US', '1'],
  0x1001: ['OverlayActivationLayer', 'CS', '1'],
  0x1100: ['OverlayDescriptorGray', 'US', '1'],
  0x1101: ['OverlayDescriptorRed', 'US', '1'],
  0x1102: ['OverlayDescriptorGreen', 'US', '1'],
  0x1103: ['OverlayDescriptorBlue', 'US', '1'],
  0x1200: ['OverlaysGray', 'US', '1-n'],
  0x1201: ['OverlaysRed', 'US', '1-n'],
  0x1202: ['OverlaysGreen', 'US', '1-n'],
  0x1203: ['OverlaysBlue', 'US', '1-n'],
  0x1301: ['ROIArea', 'IS', '1'],
  0x1302: ['ROIMean', 'DS', '1'],
  0x1303: ['ROIStandardDeviation', 'DS', '1'],
  0x1500: ['OverlayLabel', 'LO', '1'],
  0x3000: ['OverlayData', 'OW', '1'],
  0x4000: ['OverlayComments', 'LT', '1'],
};

/** @type {Map<string, { tag: string, formattedTag: string, keyword: string, name: string, vr: string, vm: string }>} */
export const DICOM_DICTIONARY = new Map();

const allDictEntries = Object.entries(STANDARD_DICT).slice();
for (const [elemKey, entry] of Object.entries(OVERLAY_ELEMENTS)) {
  const hex = `6000${Number(elemKey).toString(16).toUpperCase().padStart(4, '0')}`;
  if (!(hex in STANDARD_DICT)) {
    allDictEntries.push([hex, entry]);
  }
}
allDictEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

for (const [hex, entry] of allDictEntries) {
  const [keyword, vr, vm, explicitName] = entry;
  const formattedTag = `(${hex.slice(0, 4)},${hex.slice(4, 8)})`;
  DICOM_DICTIONARY.set(hex, {
    tag: hex,
    formattedTag,
    keyword,
    name: explicitName || keywordToDisplayName(keyword),
    vr,
    vm,
  });
}

export function formatTag(group, element) {
  const g = group.toString(16).toUpperCase().padStart(4, '0');
  const e = element.toString(16).toUpperCase().padStart(4, '0');
  return `(${g},${e})`;
}

export function tagHex(group, element) {
  return (
    group.toString(16).toUpperCase().padStart(4, '0') +
    element.toString(16).toUpperCase().padStart(4, '0')
  );
}

export function parseTagString(input) {
  const cleaned = (input || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (cleaned.length !== 8) return null;
  const group = parseInt(cleaned.slice(0, 4), 16);
  const element = parseInt(cleaned.slice(4, 8), 16);
  return { group, element, hex: cleaned, formatted: formatTag(group, element) };
}

/**
 * Lookup tag metadata including Private Tag, Repeating Overlay/Curve & Group Length handling.
 * @param {number} group
 * @param {number} element
 * @param {Map<string, string>} [privateCreators]
 */
export function lookupTag(group, element, privateCreators) {
  const hex = tagHex(group, element);
  const std = DICOM_DICTIONARY.get(hex);
  if (std) {
    return { ...std, isPrivate: false };
  }

  if (element === 0x0000) {
    return {
      tag: hex,
      formattedTag: formatTag(group, element),
      keyword: 'GroupLength',
      name: `Group ${group.toString(16).toUpperCase().padStart(4, '0')} Length`,
      vr: 'UL',
      vm: '1',
      isPrivate: (group & 1) === 1,
    };
  }

  // Private tag (odd group number)
  if ((group & 1) === 1) {
    if (element >= 0x0010 && element <= 0x00ff) {
      return {
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: 'PrivateCreator',
        name: 'Private Creator',
        vr: 'LO',
        vm: '1',
        isPrivate: true,
        isPrivateCreator: true,
      };
    }
    const block = (element >> 8) & 0xff;
    const creatorKey = `${group.toString(16).toUpperCase().padStart(4, '0')}:${block.toString(16).toUpperCase().padStart(2, '0')}`;
    const creator = privateCreators?.get(creatorKey);
    return {
      tag: hex,
      formattedTag: formatTag(group, element),
      keyword: creator ? `Private_${creator.replace(/[^A-Za-z0-9]/g, '')}` : 'PrivateTag',
      name: creator ? `Private Tag [${creator}]` : 'Private Tag',
      vr: 'UN',
      vm: '1',
      isPrivate: true,
      privateCreator: creator || null,
    };
  }

  // Repeating overlay group 60xx
  if (group >= 0x6000 && group <= 0x60ff && (group & 1) === 0) {
    const hit = OVERLAY_ELEMENTS[element];
    if (hit) {
      return {
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: hit[0],
        name: keywordToDisplayName(hit[0]),
        vr: hit[1],
        vm: hit[2],
        isPrivate: false,
      };
    }
  }

  // Repeating curve group 50xx (Retired)
  if (group >= 0x5000 && group <= 0x50ff && (group & 1) === 0) {
    const curveMap = {
      0x0005: ['CurveDimensions', 'US', '1'],
      0x0010: ['NumberOfPoints', 'US', '1'],
      0x0020: ['TypeOfData', 'CS', '1'],
      0x0022: ['CurveDescription', 'LO', '1'],
      0x0103: ['DataValueRepresentation', 'US', '1'],
      0x2500: ['CurveLabel', 'LO', '1'],
      0x3000: ['CurveData', 'OW', '1'],
    };
    const hit = curveMap[element];
    if (hit) {
      return {
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: hit[0],
        name: keywordToDisplayName(hit[0]),
        vr: hit[1],
        vm: hit[2],
        isPrivate: false,
      };
    }
  }

  return {
    tag: hex,
    formattedTag: formatTag(group, element),
    keyword: 'UnknownTag',
    name: 'Unknown Standard Tag',
    vr: 'UN',
    vm: '1',
    isPrivate: false,
  };
}

/**
 * Search standard dictionary entries for Add Tag / Batch Edit autocomplete.
 * Excludes Group FFFE structural delimiter tags, supports optional pre-limit filtering,
 * and ranks exact/group-prefix matches ahead of substring matches.
 * @param {string} query
 * @param {number} [limit]
 * @param {(entry: { tag: string, formattedTag: string, keyword: string, name: string, vr: string, vm: string }) => boolean} [filterFn]
 */
export function searchDictionary(query, limit = 25, filterFn = null) {
  const q = (query || '').trim().toLowerCase();
  const isTagLike = q !== '' && /^[0-9a-f(),\s]+$/.test(q);
  const qHex = isTagLike ? q.replace(/[^0-9a-f]/g, '') : '';
  const hasGroupSyntax = isTagLike && (q.startsWith('(') || q.includes(','));
  const groupPrefix = hasGroupSyntax
    ? q.replace(/^\(/, '').split(',')[0].replace(/[^0-9a-f]/g, '')
    : '';
  const elemPart = hasGroupSyntax && q.includes(',')
    ? q.split(',').slice(1).join('').replace(/[^0-9a-f]/g, '')
    : '';

  const tier0 = []; // exact tag or exact keyword
  const tier1 = []; // tag/group prefix or keyword/name prefix
  const tier2 = []; // substring match

  for (const entry of DICOM_DICTIONARY.values()) {
    // Structural Item/Sequence delimiters (Group FFFE) are never valid addable dataset elements
    if (entry.tag.startsWith('FFFE')) continue;
    if (filterFn && !filterFn(entry)) continue;

    if (!q) {
      tier0.push(entry);
      if (tier0.length >= limit) break;
      continue;
    }

    const tagLower = entry.tag.toLowerCase();
    const fmtLower = entry.formattedTag.toLowerCase();
    const kwLower = entry.keyword.toLowerCase();
    const nameLower = entry.name.toLowerCase();

    if (hasGroupSyntax && groupPrefix) {
      const groupMatches = tagLower.slice(0, 4).startsWith(groupPrefix);
      const elemMatches = !elemPart || tagLower.slice(4, 8).startsWith(elemPart);
      if (groupMatches && elemMatches) {
        if (qHex.length === 8 && tagLower === qHex) tier0.push(entry);
        else tier1.push(entry);
      } else if (fmtLower.includes(q)) {
        tier2.push(entry);
      }
      continue;
    }

    if ((qHex !== '' && tagLower === qHex) || kwLower === q) {
      tier0.push(entry);
    } else if (
      (qHex !== '' && tagLower.startsWith(qHex)) ||
      fmtLower.startsWith(q) ||
      kwLower.startsWith(q) ||
      nameLower.startsWith(q)
    ) {
      tier1.push(entry);
    } else if (
      (qHex !== '' && tagLower.includes(qHex)) ||
      fmtLower.includes(q) ||
      kwLower.includes(q) ||
      nameLower.includes(q)
    ) {
      tier2.push(entry);
    }
  }

  return tier0.concat(tier1, tier2).slice(0, limit);
}
