/**
 * Modular DICOM PixelData renderer.
 * Currently supports:
 *  - Uncompressed Grayscale (8/16-bit signed/unsigned, MONOCHROME1 & MONOCHROME2)
 *  - Uncompressed Color (RGB, YBR_FULL, YBR_FULL_422)
 *  - RLE Lossless (1.2.840.10008.1.2.5)
 *  - JPEG Lossless Process 14 / First-Order Prediction (1.2.840.10008.1.2.4.57 / .70) via pure JS decoder
 *  - JPEG Baseline / Extended (1.2.840.10008.1.2.4.50 / .51) via browser native decoder
 *  - Multi-frame stepping, Rescale Slope/Intercept, interactive Window/Level & Invert
 *
 * Designed as an isolated module so WASM decoders (JPEG2000, JPEG-LS, HTJ2K)
 * can be plugged in later without touching the tag editor core.
 */

import { decodeJpegLossless } from './jpegLossless.js';
import { basicOffsetFrameStarts } from './encapsulation.js';
import { checkedPixelCount, MAX_FRAME_PIXELS } from './pixelGeometry.js';
import { t } from '../i18n.js';

function findTagValue(nodes, tagHex) {
  const node = (nodes || []).find((n) => n.tag === tagHex && n.status !== 'deleted');
  return node ? node.value : null;
}

function findTagNode(nodes, tagHex) {
  return (nodes || []).find((n) => n.tag === tagHex && n.status !== 'deleted') || null;
}

function parseFirstNumber(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const first = String(val).split('\\')[0].trim();
  if (!first) return fallback;
  const n = Number(first);
  return Number.isFinite(n) ? n : fallback;
}

const OVERLAY_PALETTE = [
  [34, 197, 94],   // emerald green (6000)
  [56, 189, 248],  // sky cyan (6002)
  [245, 158, 11],  // amber (6004)
  [244, 114, 182], // pink (6006)
  [163, 230, 53],  // lime (6008)
  [192, 132, 252], // violet (600A)
];

function oppositeWordByte(offset) {
  return offset % 2 ? offset - 1 : offset + 1;
}

function extractOverlayDefinitions(nodes, defaultRows, defaultCols, bitsAllocated, bitsStored, highBit) {
  const byGroup = new Map();
  for (const n of nodes || []) {
    if (n.status === 'deleted') continue;
    const g = n.group;
    if (g >= 0x6000 && g <= 0x601e && (g & 1) === 0) {
      let bucket = byGroup.get(g);
      if (!bucket) {
        bucket = new Map();
        byGroup.set(g, bucket);
      }
      bucket.set(n.element, n);
    }
  }
  if (byGroup.size === 0) return [];

  const overlays = [];
  const sortedGroups = Array.from(byGroup.keys()).sort((a, b) => a - b);
  for (const group of sortedGroups) {
    const tags = byGroup.get(group);
    const getVal = (el) => {
      const node = tags.get(el);
      return node && !node.isBinary && !node.isSequence ? node.value : null;
    };
    const dataNode = tags.get(0x3000) || null;
    const rows = parseFirstNumber(getVal(0x0010), defaultRows);
    const cols = parseFirstNumber(getVal(0x0011), defaultCols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) continue;

    const originRaw = getVal(0x0050);
    const originParts = originRaw ? String(originRaw).split('\\').map((s) => Number(s.trim())) : [];
    const originRow = Number.isFinite(originParts[0]) ? Math.trunc(originParts[0]) - 1 : 0;
    const originCol = Number.isFinite(originParts[1]) ? Math.trunc(originParts[1]) - 1 : 0;
    const appliesToAllFrames = !tags.has(0x0015) && !tags.has(0x0051);
    const numberOfFrames = Math.max(1, Math.floor(parseFirstNumber(getVal(0x0015), 1)));
    const imageFrameOrigin = Math.max(1, Math.floor(parseFirstNumber(getVal(0x0051), 1)));
    const ovBitsAlloc = parseFirstNumber(getVal(0x0100), dataNode ? 1 : bitsAllocated);
    const bitPosRaw = getVal(0x0102);
    const bitPosition = bitPosRaw !== null ? parseFirstNumber(bitPosRaw, -1) : (dataNode ? 0 : -1);

    const hasSeparateData = Boolean(dataNode?.rawBytes && dataNode.rawBytes.length > 0);
    const lowStoredBit = Math.max(0, highBit + 1 - bitsStored);
    const inStoredRange = bitPosition >= lowStoredBit && bitPosition <= highBit;
    const isEmbedded = !hasSeparateData && bitPosition >= 0 && bitPosition < bitsAllocated && !inStoredRange;
    if (!hasSeparateData && !isEmbedded) continue;

    overlays.push({
      group,
      groupHex: group.toString(16).toUpperCase().padStart(4, '0'),
      rows,
      cols,
      originRow,
      originCol,
      appliesToAllFrames,
      numberOfFrames,
      imageFrameOrigin,
      bitsAllocated: ovBitsAlloc,
      bitPosition,
      type: (getVal(0x0040) || 'G').trim().toUpperCase(),
      label: (getVal(0x1500) || getVal(0x0022) || `60${group.toString(16).toUpperCase().slice(2)}`).trim(),
      dataNode,
      embedded: isEmbedded,
      color: OVERLAY_PALETTE[overlays.length % OVERLAY_PALETTE.length],
    });
  }
  return overlays;
}

/**
 * Extract active 1-bit overlay masks for a given frame index from both
 * separate (60xx,3000) OverlayData and embedded PixelData bit-planes.
 */
function extractOverlayPlanesForFrame(meta, frameIndex, rawFrameBytes, rawLittleEndian, rawBitsAllocated, frameStart = 0, swapWords = false) {
  const defs = meta.overlays || [];
  if (defs.length === 0) return [];

  const activePlanes = [];
  let pixelsRemaining = MAX_FRAME_PIXELS;
  for (const ov of defs) {
    // Check multi-frame overlay visibility window (1-based ImageFrameOrigin)
    const ovFrameIdx = ov.appliesToAllFrames ? 0 : (frameIndex + 1) - ov.imageFrameOrigin;
    if (ovFrameIdx < 0 || ovFrameIdx >= ov.numberOfFrames) continue;

    const pixelCount = ov.rows * ov.cols;
    if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || pixelCount > pixelsRemaining) continue;

    if (!ov.embedded && ov.dataNode?.rawBytes) {
      const src = ov.dataNode.rawBytes;
      const isBigEndianOw = meta.littleEndian === false && ov.dataNode.vr === 'OW';
      const bitStart = ovFrameIdx * pixelCount;
      if (!Number.isSafeInteger(bitStart) || bitStart + pixelCount > src.length * 8) continue;
      const mask = new Uint8Array(pixelCount);
      pixelsRemaining -= pixelCount;
      let anySet = false;
      for (let i = 0; i < pixelCount; i++) {
        const bitIdx = bitStart + i;
        let byteIdx = Math.floor(bitIdx / 8);
        if (isBigEndianOw) byteIdx = oppositeWordByte(byteIdx);
        if (byteIdx >= src.length) break;
        if ((src[byteIdx] >>> (bitIdx & 7)) & 1) {
          mask[i] = 1;
          anySet = true;
        }
      }
      if (anySet) {
        activePlanes.push({
          group: ov.group,
          groupHex: ov.groupHex,
          label: ov.label,
          type: ov.type,
          rows: ov.rows,
          cols: ov.cols,
          originRow: ov.originRow,
          originCol: ov.originCol,
          color: ov.color,
          mask,
        });
      }
    } else if (ov.embedded && rawFrameBytes && (rawBitsAllocated === 8 || rawBitsAllocated === 16)) {
      const end = frameStart + pixelCount * (rawBitsAllocated / 8);
      if (pixelCount > meta.rows * meta.cols || end + (swapWords ? end % 2 : 0) > rawFrameBytes.length) continue;
      const mask = new Uint8Array(pixelCount);
      pixelsRemaining -= pixelCount;
      const bitMask = 1 << ov.bitPosition;
      const view = new DataView(rawFrameBytes.buffer, rawFrameBytes.byteOffset, rawFrameBytes.byteLength);
      let anySet = false;
      for (let i = 0; i < pixelCount; i++) {
        const sample = rawBitsAllocated === 8 ? view.getUint8(swapWords ? oppositeWordByte(frameStart + i) : frameStart + i)
          : view.getUint16(frameStart + i * 2, rawLittleEndian);
        if (sample & bitMask) {
          mask[i] = 1;
          anySet = true;
        }
      }
      if (anySet) {
        activePlanes.push({
          group: ov.group,
          groupHex: ov.groupHex,
          label: ov.label,
          type: ov.type,
          rows: ov.rows,
          cols: ov.cols,
          originRow: ov.originRow,
          originCol: ov.originCol,
          color: ov.color,
          mask,
        });
      }
    }
  }
  return activePlanes;
}

function sequenceItemNodes(nodes, tag, index = 0) {
  return findTagNode(nodes, tag)?.items?.[index]?.children || [];
}

function readPresentationTags(nodes, fallback = {}) {
  return {
    rescaleSlope: parseFirstNumber(findTagValue(nodes, '00281053'), fallback.rescaleSlope ?? 1),
    rescaleIntercept: parseFirstNumber(findTagValue(nodes, '00281052'), fallback.rescaleIntercept ?? 0),
    windowCenter: parseFirstNumber(findTagValue(nodes, '00281050'), fallback.windowCenter ?? null),
    windowWidth: parseFirstNumber(findTagValue(nodes, '00281051'), fallback.windowWidth ?? null),
    voiFunction: (findTagValue(nodes, '00281056') || fallback.voiFunction || 'LINEAR').trim().toUpperCase(),
  };
}

function framePresentation(meta, frameIndex) {
  const group = meta.perFrameGroups?.[frameIndex]?.children;
  if (!group) return meta;
  return { ...meta,
    ...readPresentationTags(sequenceItemNodes(group, '00289145'), meta),
    ...readVoiTags(sequenceItemNodes(group, '00289132'), meta),
  };
}

function readVoiTags(nodes, fallback) {
  const { windowCenter, windowWidth, voiFunction } = readPresentationTags(nodes, fallback);
  return { windowCenter, windowWidth, voiFunction };
}

function compositeOverlaysOnImageData(imgData, overlays) {
  if (!overlays || overlays.length === 0) return;
  const imgW = imgData.width;
  const imgH = imgData.height;
  const dst = imgData.data;

  for (const ov of overlays) {
    const [cr, cg, cb] = ov.color;
    const mask = ov.mask;
    for (let r = 0; r < ov.rows; r++) {
      const dstY = ov.originRow + r;
      if (dstY < 0 || dstY >= imgH) continue;
      const srcRowOff = r * ov.cols;
      const dstRowOff = dstY * imgW;
      for (let c = 0; c < ov.cols; c++) {
        if (!mask[srcRowOff + c]) continue;
        const dstX = ov.originCol + c;
        if (dstX < 0 || dstX >= imgW) continue;
        const p = (dstRowOff + dstX) * 4;
        dst[p] = cr;
        dst[p + 1] = cg;
        dst[p + 2] = cb;
        dst[p + 3] = 255;
      }
    }
  }
}

/**
 * Extract pixel-related metadata from the live document (reflects unsaved tag edits!).
 */
export function extractPixelMeta(doc) {
  if (!doc) return null;
  const nodes = doc.datasetNodes || [];
  const pixelNode = findTagNode(nodes, '7FE00010');
  if (!pixelNode) return null;

  const rows = parseFirstNumber(findTagValue(nodes, '00280010'), 0);
  const cols = parseFirstNumber(findTagValue(nodes, '00280011'), 0);
  const samplesPerPixel = parseFirstNumber(findTagValue(nodes, '00280002'), 1);
  const photometric = (findTagValue(nodes, '00280004') || 'MONOCHROME2').trim().toUpperCase();
  const planarConfig = parseFirstNumber(findTagValue(nodes, '00280006'), 0);
  const numberOfFrames = Math.max(1, Math.floor(parseFirstNumber(findTagValue(nodes, '00280008'), 1)));
  const bitsAllocated = parseFirstNumber(findTagValue(nodes, '00280100'), 16);
  const bitsStored = parseFirstNumber(findTagValue(nodes, '00280101'), bitsAllocated);
  const highBit = parseFirstNumber(findTagValue(nodes, '00280102'), bitsStored - 1);
  const pixelRepresentation = parseFirstNumber(findTagValue(nodes, '00280103'), 0); // 0=unsigned, 1=signed
  const shared = sequenceItemNodes(nodes, '52009229');
  const rootPresentation = readPresentationTags(nodes);
  const sharedPresentation = readPresentationTags(sequenceItemNodes(shared, '00289145'), rootPresentation);

  const tsInfo = doc.transferSyntaxInfo || {};
  const compressed = Boolean(pixelNode.encapsulated || tsInfo.compressed);
  const codec = tsInfo.codec || (compressed ? 'unknown' : 'raw');
  const overlays = extractOverlayDefinitions(nodes, rows, cols, bitsAllocated, bitsStored, highBit);

  return {
    pixelNode,
    rows,
    cols,
    samplesPerPixel,
    photometric,
    planarConfig,
    numberOfFrames,
    bitsAllocated,
    bitsStored,
    highBit,
    pixelRepresentation,
    ...sharedPresentation,
    ...readVoiTags(sequenceItemNodes(shared, '00289132'), sharedPresentation),
    perFrameGroups: findTagNode(nodes, '52009230')?.items,
    littleEndian: doc.littleEndian !== false,
    compressed,
    codec,
    transferSyntaxUid: doc.transferSyntaxUid,
    overlays,
    transferSyntaxName: tsInfo.name || doc.transferSyntaxUid || 'Unknown',
  };
}

/**
 * Decode DICOM RLE Lossless segment (PS3.5 Annex G PackBits).
 */
function decodeRleFrame(fragment, rows, cols, samplesPerPixel, bitsAllocated) {
  if (!fragment || fragment.length < 64) {
    throw new Error('Invalid RLE header.');
  }
  const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  const numSegments = view.getUint32(0, true);
  const pixelCount = checkedPixelCount(rows, cols);
  if (!((samplesPerPixel === 1 && (bitsAllocated === 8 || bitsAllocated === 16)) ||
      (samplesPerPixel === 3 && bitsAllocated === 8))) {
    throw new Error('Unsupported RLE sample format.');
  }
  const bytesPerSample = bitsAllocated / 8;
  if (numSegments !== samplesPerPixel * bytesPerSample) {
    throw new Error('Invalid RLE segment count.');
  }
  const offsets = [];
  for (let i = 0; i < numSegments; i++) {
    const off = view.getUint32(4 + i * 4, true);
    if ((i === 0 ? off !== 64 : off <= offsets[i - 1]) || off >= fragment.length || off % 2) {
      throw new Error('Invalid RLE segment offset.');
    }
    offsets.push(off);
  }

  const decodedSegments = [];

  for (let s = 0; s < numSegments; s++) {
    const start = offsets[s];
    const end = offsets[s + 1] ?? fragment.length;
    if ((end - start) % 2) throw new Error('RLE segment must have even length.');
    const segOut = new Uint8Array(pixelCount);
    let inPos = start;
    let outPos = 0;

    while (outPos < pixelCount) {
      if (inPos >= end) throw new Error('Truncated RLE segment.');
      const command = view.getInt8(inPos++);
      if (command === -128) continue;
      const count = Math.abs(command) + 1;
      const encodedBytes = command < 0 ? 1 : count;
      if (inPos + encodedBytes > end || count > cols - outPos % cols) {
        throw new Error('Invalid RLE run length.');
      }
      if (command < 0) segOut.fill(fragment[inPos], outPos, outPos + count);
      else segOut.set(fragment.subarray(inPos, inPos + count), outPos);
      inPos += encodedBytes;
      outPos += count;
    }
    while (inPos < end && fragment[inPos] === 0x80) inPos++;
    if (inPos !== end && !(inPos === end - 1 && fragment[inPos] === 0)) throw new Error('Unexpected RLE segment data.');
    decodedSegments.push(segOut);
  }

  // Recombine segments (MSB first per sample in RLE) into interleaved Little Endian raw bytes
  const totalBytes = pixelCount * samplesPerPixel * bytesPerSample;
  const out = new Uint8Array(totalBytes);

  if (samplesPerPixel === 1 && bytesPerSample === 2 && decodedSegments.length >= 2) {
    const msb = decodedSegments[0];
    const lsb = decodedSegments[1];
    for (let i = 0; i < pixelCount; i++) {
      out[i * 2] = lsb[i];
      out[i * 2 + 1] = msb[i];
    }
  } else if (samplesPerPixel === 1 && bytesPerSample === 1 && decodedSegments.length >= 1) {
    out.set(decodedSegments[0]);
  } else if (samplesPerPixel === 3 && bytesPerSample === 1 && decodedSegments.length >= 3) {
    for (let i = 0; i < pixelCount; i++) {
      out[i * 3] = decodedSegments[0][i];
      out[i * 3 + 1] = decodedSegments[1][i];
      out[i * 3 + 2] = decodedSegments[2][i];
    }
  }
  return out;
}

function concatFragments(frags) {
  if (frags.length === 1) return frags[0];
  let total = 0;
  for (const f of frags) total += f.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const f of frags) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}

const jpegFragmentRanges = new WeakMap();

/** Locate complete JPEG frames without copying the encapsulated pixel data. */
function findJpegFragmentRanges(fragments) {
  const ranges = [];
  let fragmentIndex = 0;
  let offset = 0;

  const nextByte = () => {
    while (fragmentIndex < fragments.length) {
      const fragment = fragments[fragmentIndex];
      if (offset < fragment.length) return fragment[offset++];
      fragmentIndex++;
      offset = 0;
    }
    return -1;
  };

  while (fragmentIndex < fragments.length) {
    const first = fragmentIndex;
    if (nextByte() !== 0xff || nextByte() !== 0xd8) return [];
    while (true) {
      while (fragmentIndex < fragments.length) {
        const prefix = fragments[fragmentIndex].indexOf(0xff, offset);
        if (prefix >= 0) {
          offset = prefix + 1;
          break;
        }
        fragmentIndex++;
        offset = 0;
      }
      if (fragmentIndex === fragments.length) return [];

      let marker;
      do { marker = nextByte(); } while (marker === 0xff);
      if (marker < 0 || marker === 0xd8) return [];
      // Stuffed entropy byte, restart marker, or standalone TEM marker.
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
      if (marker === 0xd9) {
        const fragment = fragments[fragmentIndex];
        const remaining = fragment.length - offset;
        if (remaining !== 0 && !(remaining === 1 && fragment[offset] === 0)) return [];
        ranges.push([first, ++fragmentIndex]);
        offset = 0;
        break;
      }

      // Skip length-bearing segments so marker-like bytes in APP/COM data do not split frames.
      const high = nextByte();
      const low = nextByte();
      const length = high * 256 + low;
      if (low < 0 || length < 2) return [];
      for (let i = 2; i < length; i++) {
        if (nextByte() < 0) return [];
      }
    }
  }
  return ranges;
}

/**
 * Extract the encapsulated byte stream for a given frame index, handling
 * single-frame streams, Basic Offset Tables and JPEG frame markers.
 */
function extractEncapsulatedFrameBytes(pixelNode, numberOfFrames, frameIndex, codec) {
  const frags = pixelNode.fragments || [];
  if (frags.length === 0 || frameIndex < 0 || frameIndex >= numberOfFrames) return null;
  const bot = pixelNode.basicOffsetTable;
  let starts;
  try {
    starts = basicOffsetFrameStarts(bot, frags, numberOfFrames);
  } catch {
    return null;
  }
  if (codec === 'rle' && (frags.length !== numberOfFrames || (starts && starts[frameIndex] !== frameIndex))) return null;
  if (starts) return concatFragments(frags.slice(starts[frameIndex], starts[frameIndex + 1]));
  if (numberOfFrames <= 1) {
    return concatFragments(frags);
  }
  if (frags.length === numberOfFrames) {
    return frags[frameIndex];
  }
  if (codec !== 'jpeg-lossless' && codec !== 'jpeg-baseline') return null;

  let ranges = jpegFragmentRanges.get(frags);
  if (!ranges) {
    ranges = findJpegFragmentRanges(frags);
    jpegFragmentRanges.set(frags, ranges);
  }
  if (ranges.length !== numberOfFrames) return null;
  const [first, end] = ranges[frameIndex];
  return concatFragments(frags.slice(first, end));
}

function grayscaleBitmapBytes(bitmap) {
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(bitmap.width, bitmap.height) : document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const samples = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < samples.length; i++) samples[i] = rgba[i * 4];
  return samples;
}

/**
 * Decode a single frame into either:
 *  - { kind: 'scalar', width, height, values: Float32Array, min, max, autoWC, autoWW }
 *  - { kind: 'rgb', width, height, rgba: Uint8ClampedArray }
 *  - { kind: 'bitmap', width, height, bitmap: ImageBitmap }
 *  - { kind: 'unsupported', reason: string, codec: string }
 */
export async function decodePixelFrame(meta, frameIndex = 0) {
  if (!meta) {
    return { kind: 'unsupported', reason: t('pixelErrNoTag'), codec: 'none' };
  }
  try {
    checkedPixelCount(meta.rows, meta.cols);
  } catch {
    return { kind: 'unsupported', reason: t('pixelErrDim'), codec: meta.codec };
  }
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || (meta.numberOfFrames && frameIndex >= meta.numberOfFrames)) {
    return { kind: 'unsupported', reason: t('pixelErrDim'), codec: meta.codec };
  }
  meta = framePresentation(meta, frameIndex);

  // 1) Compressed formats
  if (meta.compressed) {
    const frag = extractEncapsulatedFrameBytes(meta.pixelNode, meta.numberOfFrames || 1, frameIndex, meta.codec);
    if (!frag || frag.length === 0) {
      return { kind: 'unsupported', reason: t('pixelErrNoFrag'), codec: meta.codec };
    }

    // JPEG Baseline / Extended via browser native decoder
    if (meta.codec === 'jpeg-baseline') {
      let bitmap;
      try {
        const blob = new Blob([frag], { type: 'image/jpeg' });
        bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', imageOrientation: 'none' });
        checkedPixelCount(bitmap.height, bitmap.width);
        const overlays = extractOverlayPlanesForFrame(meta, frameIndex, null, true, 8);
        if (meta.photometric === 'MONOCHROME1' || meta.photometric === 'MONOCHROME2') {
          try {
            const decoded = decodeUncompressedBytes(grayscaleBitmapBytes(bitmap), {
              ...meta, rows: bitmap.height, cols: bitmap.width, samplesPerPixel: 1, bitsAllocated: 8,
              bitsStored: 8, highBit: 7, pixelRepresentation: 0, littleEndian: true,
            }, 0);
            return { ...decoded, overlays };
          } finally {
            bitmap.close?.();
            bitmap = null;
          }
        }
        return { kind: 'bitmap', width: bitmap.width, height: bitmap.height, bitmap, overlays };
      } catch {
        bitmap?.close?.();
        return {
          kind: 'unsupported',
          reason: t('pixelErrJpeg', { ts: meta.transferSyntaxName }),
          codec: meta.codec,
        };
      }
    }

    // JPEG Lossless (Process 14 / First-Order Prediction, .57 / .70) via pure JS decoder
    if (meta.codec === 'jpeg-lossless') {
      try {
        const decoded = decodeJpegLossless(frag, {
          rows: meta.rows,
          cols: meta.cols,
          bitsAllocated: meta.bitsAllocated,
          firstOrderOnly: meta.transferSyntaxUid === '1.2.840.10008.1.2.4.70',
        });
        const bitsAllocated = decoded.bytesPerSample * 8;
        const bitsStored = Math.min(bitsAllocated, meta.bitsStored || decoded.precision);
        const highBit = decoded.precision <= bitsStored ? bitsStored - 1 : Math.min(bitsAllocated - 1, meta.highBit);
        const result = decodeUncompressedBytes(
          decoded.data,
          {
            ...meta,
            rows: decoded.height,
            cols: decoded.width,
            samplesPerPixel: decoded.numComponents,
            bitsAllocated,
            bitsStored,
            highBit,
            littleEndian: true,
            planarConfig: 0,
          },
          0
        );
        if (result.kind !== 'unsupported') {
          result.overlays = extractOverlayPlanesForFrame(meta, frameIndex, decoded.data, true, bitsAllocated);
        }
        return result;
      } catch {
        return {
          kind: 'unsupported',
          reason: t('pixelErrJpeg', { ts: meta.transferSyntaxName }),
          codec: meta.codec,
        };
      }
    }

    // RLE Lossless
    if (meta.codec === 'rle') {
      try {
        const raw = decodeRleFrame(frag, meta.rows, meta.cols, meta.samplesPerPixel, meta.bitsAllocated);
        const result = decodeUncompressedBytes(raw, { ...meta, littleEndian: true, planarConfig: 0 }, 0);
        if (result.kind !== 'unsupported') {
          result.overlays = extractOverlayPlanesForFrame(meta, frameIndex, raw, true, meta.bitsAllocated);
        }
        return result;
      } catch {
        return {
          kind: 'unsupported',
          reason: t('pixelErrRle', { ts: meta.transferSyntaxName }),
          codec: meta.codec,
        };
      }
    }

    // Other codecs (JPEG2000, JPEG-LS, HTJ2K)
    return {
      kind: 'unsupported',
      reason: t('pixelErrCodec', { ts: meta.transferSyntaxName }),
      codec: meta.codec,
    };
  }

  // 2) Uncompressed
  const rawBytes = meta.pixelNode.rawBytes;
  if (!rawBytes || rawBytes.length === 0) {
    return { kind: 'unsupported', reason: t('pixelErrEmpty'), codec: 'raw' };
  }

  const result = decodeUncompressedBytes(rawBytes, meta, frameIndex);
  if (result.kind !== 'unsupported') {
    const bytesPerSample = meta.bitsAllocated / 8;
    const isPackedYbr = meta.photometric === 'YBR_FULL_422';
    const frameByteSize = meta.rows * meta.cols * (isPackedYbr ? 2 : meta.samplesPerPixel) * bytesPerSample;
    const frameStart = frameIndex * frameByteSize;
    result.overlays = extractOverlayPlanesForFrame(meta, frameIndex, rawBytes, meta.littleEndian,
      meta.bitsAllocated, frameStart, usesBigEndianBytePairs(meta));
  }
  return result;
}

function usesBigEndianBytePairs(meta) {
  return meta.bitsAllocated === 8 && meta.littleEndian === false && meta.pixelNode?.vr === 'OW';
}

function decodeUncompressedBytes(rawBytes, meta, frameIndex) {
  const {
    rows,
    cols,
    samplesPerPixel,
    photometric,
    planarConfig,
    bitsAllocated,
    bitsStored = bitsAllocated,
    highBit = bitsStored - 1,
    pixelRepresentation,
    rescaleSlope = 1,
    rescaleIntercept = 0,
    littleEndian,
  } = meta;

  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    return { kind: 'unsupported', reason: t('pixelErrBits', { bits: bitsAllocated }), codec: 'raw' };
  }

  const isPackedYbr = photometric === 'YBR_FULL_422';
  const isColor = samplesPerPixel === 3 &&
    (photometric === 'RGB' || photometric === 'YBR_FULL' || isPackedYbr);
  const isGrayscale = samplesPerPixel === 1 && (photometric === 'MONOCHROME1' || photometric === 'MONOCHROME2');
  if ((!isColor && !isGrayscale) || (isPackedYbr && (cols % 2 !== 0 || planarConfig !== 0))) {
    return { kind: 'unsupported', reason: t('pixelErrPhotometric', { mode: photometric }), codec: 'raw' };
  }
  if (isColor && bitsAllocated !== 8) {
    return { kind: 'unsupported', reason: t('pixelErrBits', { bits: bitsAllocated }), codec: 'raw' };
  }

  const pixelCount = rows * cols;
  const bytesPerSample = bitsAllocated / 8;
  const frameByteSize = pixelCount * (isPackedYbr ? 2 : samplesPerPixel) * bytesPerSample;
  const frameOffset = frameIndex * frameByteSize;
  const swapWords = usesBigEndianBytePairs(meta);

  const frameEnd = frameOffset + frameByteSize;
  if (frameEnd + (swapWords ? frameEnd % 2 : 0) > rawBytes.length) {
    return {
      kind: 'unsupported',
      reason: t('pixelErrSmall', { len: rawBytes.length, cols, rows }),
      codec: 'raw',
    };
  }

  if (!Number.isInteger(bitsStored) || !Number.isInteger(highBit) ||
      bitsStored < 1 || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
    return { kind: 'unsupported', reason: t('pixelErrStoredBits'), codec: 'raw' };
  }
  const shift = highBit + 1 - bitsStored;
  const rangeSize = 1 << bitsStored;
  const readByteSample = (offset) => (rawBytes[swapWords ? oppositeWordByte(offset) : offset] >>> shift) & (rangeSize - 1);
  if (isColor) {
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    const scale = 255 / (rangeSize - 1);
    const middle = rangeSize / 2;
    const writePixel = (i, a, b, c) => {
      const out = i * 4;
      if (photometric === 'RGB') {
        rgba[out] = a * scale;
        rgba[out + 1] = b * scale;
        rgba[out + 2] = c * scale;
      } else {
        const cb = b - middle;
        const cr = c - middle;
        rgba[out] = (a + 1.402 * cr) * scale;
        rgba[out + 1] = (a - 0.344136 * cb - 0.714136 * cr) * scale;
        rgba[out + 2] = (a + 1.772 * cb) * scale;
      }
      rgba[out + 3] = 255;
    };
    if (isPackedYbr) {
      // Each Y1, Y2, Cb, Cr group represents two adjacent pixels.
      for (let i = 0; i < pixelCount; i += 2) {
        const start = frameOffset + i * 2;
        const cb = readByteSample(start + 2);
        const cr = readByteSample(start + 3);
        writePixel(i, readByteSample(start), cb, cr);
        writePixel(i + 1, readByteSample(start + 1), cb, cr);
      }
    } else {
      const stride = planarConfig === 1 ? 1 : 3;
      const channelOffset = planarConfig === 1 ? pixelCount : 1;
      for (let i = 0; i < pixelCount; i++) {
        const start = frameOffset + i * stride;
        writePixel(i, readByteSample(start), readByteSample(start + channelOffset), readByteSample(start + channelOffset * 2));
      }
    }
    return { kind: 'rgb', width: cols, height: rows, rgba };
  }

  // Grayscale (8-bit or 16-bit)
  const values = new Float32Array(pixelCount);
  const view = bitsAllocated === 16 ? new DataView(rawBytes.buffer, rawBytes.byteOffset + frameOffset, frameByteSize) : null;

  let min = Infinity;
  let max = -Infinity;
  const signBit = rangeSize >> 1;

  for (let i = 0; i < pixelCount; i++) {
    let value = view ? (view.getUint16(i * 2, littleEndian) >>> shift) & (rangeSize - 1) : readByteSample(frameOffset + i);
    if (pixelRepresentation === 1 && (value & signBit)) value -= rangeSize;
    const modalityValue = value * rescaleSlope + rescaleIntercept;
    values[i] = modalityValue;
    if (modalityValue < min) min = modalityValue;
    if (modalityValue > max) max = modalityValue;
  }

  const range = Math.max(1, max - min);
  const autoWC = Math.round(min + range / 2);
  const autoWW = Math.max(1, Math.round(range));

  return {
    kind: 'scalar',
    width: cols,
    height: rows,
    values,
    min,
    max,
    autoWC,
    autoWW,
    windowCenter: meta.windowCenter ?? null,
    windowWidth: meta.windowWidth ?? null,
    voiFunction: meta.voiFunction || 'LINEAR',
  };
}

/**
 * Render decoded frame onto a target HTMLCanvasElement with Window/Level, Invert, and Overlays.
 */
export function renderFrameToCanvas(canvas, decoded, meta, { wc, ww, invert = false, showOverlays = true } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !decoded || decoded.kind === 'unsupported') return;

  canvas.width = decoded.width;
  canvas.height = decoded.height;
  const activeOverlays = showOverlays ? decoded.overlays : null;

  if (decoded.kind === 'bitmap') {
    ctx.save();
    if (invert) ctx.filter = 'invert(1)';
    ctx.drawImage(decoded.bitmap, 0, 0);
    ctx.restore();
    if (activeOverlays && activeOverlays.length > 0) {
      const imgData = ctx.getImageData(0, 0, decoded.width, decoded.height);
      compositeOverlaysOnImageData(imgData, activeOverlays);
      ctx.putImageData(imgData, 0, 0);
    }
    return;
  }

  if (decoded.kind === 'rgb') {
    const imgData = ctx.createImageData(decoded.width, decoded.height);
    if (!invert) {
      imgData.data.set(decoded.rgba);
    } else {
      const src = decoded.rgba;
      const dst = imgData.data;
      for (let i = 0; i < src.length; i += 4) {
        dst[i] = 255 - src[i];
        dst[i + 1] = 255 - src[i + 1];
        dst[i + 2] = 255 - src[i + 2];
        dst[i + 3] = 255;
      }
    }
    if (activeOverlays && activeOverlays.length > 0) {
      compositeOverlaysOnImageData(imgData, activeOverlays);
    }
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  // Scalar grayscale with VOI windowing (DICOM PS3.3 C.11.2).
  const imgData = ctx.createImageData(decoded.width, decoded.height);
  const dst = imgData.data;
  const vals = decoded.values;
  const center = wc ?? decoded.windowCenter ?? meta.windowCenter ?? decoded.autoWC;
  const width = ww ?? decoded.windowWidth ?? meta.windowWidth ?? decoded.autoWW;
  const voi = decoded.voiFunction || meta.voiFunction || 'LINEAR';
  const span = voi === 'LINEAR_EXACT' ? Math.max(Number.MIN_VALUE, width) : Math.max(1, width) - 1;
  const midpoint = voi === 'LINEAR_EXACT' ? center : center - 0.5;
  const low = midpoint - span / 2;
  const high = midpoint + span / 2;
  const sigmoidWidth = Math.max(Number.MIN_VALUE, width);
  const mono1 = meta.photometric === 'MONOCHROME1';
  const shouldInvert = mono1 ? !invert : invert;

  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    let g;
    if (voi === 'SIGMOID') g = Math.round(255 / (1 + Math.exp(-4 * (v - center) / sigmoidWidth)));
    else if (v <= low) g = 0;
    else if (v > high) g = 255;
    else g = Math.round(((v - midpoint) / span + 0.5) * 255);

    if (shouldInvert) g = 255 - g;
    const p = i * 4;
    dst[p] = g;
    dst[p + 1] = g;
    dst[p + 2] = g;
    dst[p + 3] = 255;
  }
  if (activeOverlays && activeOverlays.length > 0) {
    compositeOverlaysOnImageData(imgData, activeOverlays);
  }
  ctx.putImageData(imgData, 0, 0);
}
