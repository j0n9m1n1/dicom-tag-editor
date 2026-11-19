/**
 * Modular DICOM PixelData renderer.
 * Currently supports:
 *  - Uncompressed Grayscale (8/16-bit signed/unsigned, MONOCHROME1 & MONOCHROME2)
 *  - Uncompressed Color (RGB, YBR_FULL, YBR_FULL_422)
 *  - RLE Lossless (1.2.840.10008.1.2.5)
 *  - JPEG Baseline / Extended (1.2.840.10008.1.2.4.50 / .51) via browser native decoder
 *  - Multi-frame stepping, Rescale Slope/Intercept, interactive Window/Level & Invert
 *
 * Designed as an isolated module so WASM decoders (JPEG2000, JPEG-LS, HTJ2K)
 * can be plugged in later without touching the tag editor core.
 */

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
  const n = Number(first);
  return Number.isFinite(n) ? n : fallback;
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
  const rescaleIntercept = parseFirstNumber(findTagValue(nodes, '00281052'), 0);
  const rescaleSlope = parseFirstNumber(findTagValue(nodes, '00281053'), 1);
  const windowCenterRaw = findTagValue(nodes, '00281050');
  const windowWidthRaw = findTagValue(nodes, '00281051');
  const windowCenter = windowCenterRaw !== null ? parseFirstNumber(windowCenterRaw, null) : null;
  const windowWidth = windowWidthRaw !== null ? parseFirstNumber(windowWidthRaw, null) : null;

  const tsInfo = doc.transferSyntaxInfo || {};
  const compressed = Boolean(pixelNode.encapsulated || tsInfo.compressed);
  const codec = tsInfo.codec || (compressed ? 'unknown' : 'raw');

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
    rescaleIntercept,
    rescaleSlope,
    windowCenter,
    windowWidth,
    littleEndian: doc.littleEndian !== false,
    compressed,
    codec,
    transferSyntaxName: tsInfo.name || doc.transferSyntaxUid || 'Unknown',
  };
}

/**
 * Decode DICOM RLE Lossless segment (PS3.5 Annex G PackBits).
 */
function decodeRleFrame(fragment, rows, cols, samplesPerPixel, bitsAllocated) {
  if (!fragment || fragment.length < 64) {
    throw new Error('유효하지 않은 RLE 헤더입니다.');
  }
  const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
  const numSegments = view.getUint32(0, true);
  const offsets = [];
  for (let i = 0; i < Math.min(numSegments, 15); i++) {
    offsets.push(view.getUint32(4 + i * 4, true));
  }

  const pixelCount = rows * cols;
  const bytesPerSample = Math.ceil(bitsAllocated / 8);
  const expectedSegments = samplesPerPixel * bytesPerSample;
  const decodedSegments = [];

  for (let s = 0; s < Math.min(numSegments, expectedSegments); s++) {
    const start = offsets[s];
    const end = s + 1 < numSegments && offsets[s + 1] > start ? offsets[s + 1] : fragment.length;
    const segOut = new Uint8Array(pixelCount);
    let inPos = start;
    let outPos = 0;

    while (inPos < end && outPos < pixelCount) {
      let n = fragment[inPos++];
      if (n > 127) n -= 256; // signed int8
      if (n >= 0 && n <= 127) {
        const count = n + 1;
        for (let k = 0; k < count && inPos < end && outPos < pixelCount; k++) {
          segOut[outPos++] = fragment[inPos++];
        }
      } else if (n >= -127 && n <= -1) {
        const count = -n + 1;
        const val = inPos < end ? fragment[inPos++] : 0;
        for (let k = 0; k < count && outPos < pixelCount; k++) {
          segOut[outPos++] = val;
        }
      }
      // n === -128 is a no-op
    }
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
  if (meta.rows <= 0 || meta.cols <= 0) {
    return { kind: 'unsupported', reason: t('pixelErrDim'), codec: meta.codec };
  }

  // 1) Compressed formats
  if (meta.compressed) {
    const frags = meta.pixelNode.fragments || [];
    if (frags.length === 0) {
      return { kind: 'unsupported', reason: t('pixelErrNoFrag'), codec: meta.codec };
    }

    // JPEG Baseline / Extended via browser native decoder
    if (meta.codec === 'jpeg-baseline') {
      const frag = frags[Math.min(frameIndex, frags.length - 1)];
      try {
        const blob = new Blob([frag], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        return { kind: 'bitmap', width: bitmap.width, height: bitmap.height, bitmap };
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
      const frag = frags[Math.min(frameIndex, frags.length - 1)];
      const raw = decodeRleFrame(frag, meta.rows, meta.cols, meta.samplesPerPixel, meta.bitsAllocated);
      return decodeUncompressedBytes(raw, { ...meta, littleEndian: true, planarConfig: 0 }, 0);
    }

    // Other codecs (JPEG2000, JPEG-LS, JPEG Lossless, HTJ2K)
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

  return decodeUncompressedBytes(rawBytes, meta, frameIndex);
}

function decodeUncompressedBytes(rawBytes, meta, frameIndex) {
  const {
    rows,
    cols,
    samplesPerPixel,
    photometric,
    planarConfig,
    bitsAllocated,
    bitsStored,
    highBit = bitsStored - 1,
    pixelRepresentation,
    rescaleSlope,
    rescaleIntercept,
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

  if (frameOffset + frameByteSize > rawBytes.length) {
    return {
      kind: 'unsupported',
      reason: t('pixelErrSmall', { len: rawBytes.length, cols, rows }),
      codec: 'raw',
    };
  }

  if (isColor) {
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    const writePixel = (i, a, b, c) => {
      const out = i * 4;
      if (photometric === 'RGB') {
        rgba[out] = a;
        rgba[out + 1] = b;
        rgba[out + 2] = c;
      } else {
        const cb = b - 128;
        const cr = c - 128;
        rgba[out] = a + 1.402 * cr;
        rgba[out + 1] = a - 0.344136 * cb - 0.714136 * cr;
        rgba[out + 2] = a + 1.772 * cb;
      }
      rgba[out + 3] = 255;
    };
    if (isPackedYbr) {
      // Each Y1, Y2, Cb, Cr group represents two adjacent pixels.
      for (let i = 0; i < pixelCount; i += 2) {
        const start = frameOffset + i * 2;
        writePixel(i, rawBytes[start], rawBytes[start + 2], rawBytes[start + 3]);
        writePixel(i + 1, rawBytes[start + 1], rawBytes[start + 2], rawBytes[start + 3]);
      }
    } else {
      const stride = planarConfig === 1 ? 1 : 3;
      const channelOffset = planarConfig === 1 ? pixelCount : 1;
      for (let i = 0; i < pixelCount; i++) {
        const start = frameOffset + i * stride;
        writePixel(i, rawBytes[start], rawBytes[start + channelOffset], rawBytes[start + channelOffset * 2]);
      }
    }
    return { kind: 'rgb', width: cols, height: rows, rgba };
  }

  // Grayscale (8-bit or 16-bit)
  if (!Number.isInteger(bitsStored) || !Number.isInteger(highBit) ||
      bitsStored < 1 || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
    return { kind: 'unsupported', reason: t('pixelErrStoredBits'), codec: 'raw' };
  }
  const values = new Float32Array(pixelCount);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset + frameOffset, frameByteSize);

  let min = Infinity;
  let max = -Infinity;
  const rangeSize = 1 << bitsStored;
  const signBit = rangeSize >> 1;
  const shift = highBit + 1 - bitsStored;

  for (let i = 0; i < pixelCount; i++) {
    const sample = bitsAllocated === 8 ? view.getUint8(i) : view.getUint16(i * 2, littleEndian);
    let value = (sample >>> shift) & (rangeSize - 1);
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
  };
}

/**
 * Render decoded frame onto a target HTMLCanvasElement with Window/Level & Invert.
 */
export function renderFrameToCanvas(canvas, decoded, meta, { wc, ww, invert = false }) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !decoded || decoded.kind === 'unsupported') return;

  canvas.width = decoded.width;
  canvas.height = decoded.height;

  if (decoded.kind === 'bitmap') {
    ctx.save();
    if (invert) ctx.filter = 'invert(1)';
    ctx.drawImage(decoded.bitmap, 0, 0);
    ctx.restore();
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
    ctx.putImageData(imgData, 0, 0);
    return;
  }

  // Scalar grayscale with linear VOI LUT (DICOM PS3.3 C.11.2.1.2)
  const imgData = ctx.createImageData(decoded.width, decoded.height);
  const dst = imgData.data;
  const vals = decoded.values;
  const width = Math.max(1, ww);
  const low = wc - 0.5 - (width - 1) / 2;
  const high = wc - 0.5 + (width - 1) / 2;
  const invSpan = 255 / Math.max(1e-6, width - 1);
  const mono1 = meta.photometric === 'MONOCHROME1';
  const shouldInvert = mono1 ? !invert : invert;

  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    let g;
    if (v <= low) g = 0;
    else if (v > high) g = 255;
    else g = Math.round((v - (wc - 0.5)) * invSpan + 127.5);

    if (shouldInvert) g = 255 - g;
    const p = i * 4;
    dst[p] = g;
    dst[p + 1] = g;
    dst[p + 2] = g;
    dst[p + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}
