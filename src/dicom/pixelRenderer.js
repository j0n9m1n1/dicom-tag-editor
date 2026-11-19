/**
 * Modular DICOM PixelData renderer.
 * Currently supports:
 *  - Uncompressed Grayscale (8/16-bit signed/unsigned, MONOCHROME1 & MONOCHROME2)
 *  - Uncompressed Color (RGB, PlanarConfiguration 0 & 1)
 *  - RLE Lossless (1.2.840.10008.1.2.5)
 *  - JPEG Baseline / Extended (1.2.840.10008.1.2.4.50 / .51) via browser native decoder
 *  - Multi-frame stepping, Rescale Slope/Intercept, interactive Window/Level & Invert
 *
 * Designed as an isolated module so WASM decoders (JPEG2000, JPEG-LS, HTJ2K)
 * can be plugged in later without touching the tag editor core.
 */

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
    return { kind: 'unsupported', reason: 'PixelData(7FE0,0010) 태그가 없는 DICOM 파일입니다.', codec: 'none' };
  }
  if (meta.rows <= 0 || meta.cols <= 0) {
    return { kind: 'unsupported', reason: 'Rows(0028,0010) 또는 Columns(0028,0011) 값이 유효하지 않습니다.', codec: meta.codec };
  }

  const pixelCount = meta.rows * meta.cols;

  // 1) Compressed formats
  if (meta.compressed) {
    const frags = meta.pixelNode.fragments || [];
    if (frags.length === 0) {
      return { kind: 'unsupported', reason: '압축된 PixelData 프래그먼트를 찾을 수 없습니다.', codec: meta.codec };
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
          reason: `JPEG 스트림 디코딩에 실패했습니다 (${meta.transferSyntaxName}). 원본 바이트는 무손실 보존됩니다.`,
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
      reason: `${meta.transferSyntaxName} 압축 포맷은 별도 코덱(WASM)이 필요합니다. 태그 수정 및 저장 시 원본 PixelData 바이트는 100% 무손실 보존됩니다.`,
      codec: meta.codec,
    };
  }

  // 2) Uncompressed
  const rawBytes = meta.pixelNode.rawBytes;
  if (!rawBytes || rawBytes.length === 0) {
    return { kind: 'unsupported', reason: 'PixelData 바이트가 비어 있습니다.', codec: 'raw' };
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
    pixelRepresentation,
    rescaleSlope,
    rescaleIntercept,
    littleEndian,
  } = meta;

  const pixelCount = rows * cols;
  const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8));
  const frameByteSize = pixelCount * samplesPerPixel * bytesPerSample;
  const frameOffset = frameIndex * frameByteSize;

  if (frameOffset + pixelCount * samplesPerPixel > rawBytes.length) {
    return {
      kind: 'unsupported',
      reason: `PixelData 크기(${rawBytes.length} B)가 예상 해상도(${cols}x${rows})보다 작습니다.`,
      codec: 'raw',
    };
  }

  // Color RGB
  if (samplesPerPixel === 3 && (photometric === 'RGB' || photometric.startsWith('YBR'))) {
    const rgba = new Uint8ClampedArray(pixelCount * 4);
    if (planarConfig === 1) {
      // RRR... GGG... BBB...
      const rOff = frameOffset;
      const gOff = frameOffset + pixelCount;
      const bOff = frameOffset + pixelCount * 2;
      for (let i = 0; i < pixelCount; i++) {
        rgba[i * 4] = rawBytes[rOff + i];
        rgba[i * 4 + 1] = rawBytes[gOff + i];
        rgba[i * 4 + 2] = rawBytes[bOff + i];
        rgba[i * 4 + 3] = 255;
      }
    } else {
      // RGB RGB RGB...
      for (let i = 0; i < pixelCount; i++) {
        const s = frameOffset + i * 3;
        rgba[i * 4] = rawBytes[s];
        rgba[i * 4 + 1] = rawBytes[s + 1];
        rgba[i * 4 + 2] = rawBytes[s + 2];
        rgba[i * 4 + 3] = 255;
      }
    }
    return { kind: 'rgb', width: cols, height: rows, rgba };
  }

  // Grayscale (8-bit or 16-bit)
  const values = new Float32Array(pixelCount);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset + frameOffset, Math.min(frameByteSize, rawBytes.length - frameOffset));

  let min = Infinity;
  let max = -Infinity;
  const signBit = 1 << (bitsStored - 1);
  const mask = bitsStored < 16 ? (1 << bitsStored) - 1 : 0xffff;

  if (bitsAllocated <= 8) {
    for (let i = 0; i < pixelCount; i++) {
      let v = pixelRepresentation === 1 ? view.getInt8(i) : view.getUint8(i);
      const modalityVal = v * rescaleSlope + rescaleIntercept;
      values[i] = modalityVal;
      if (modalityVal < min) min = modalityVal;
      if (modalityVal > max) max = modalityVal;
    }
  } else if (bitsAllocated <= 16) {
    for (let i = 0; i < pixelCount; i++) {
      let rawVal = view.getUint16(i * 2, littleEndian);
      if (bitsStored < 16) {
        rawVal &= mask;
        if (pixelRepresentation === 1 && (rawVal & signBit)) {
          rawVal = rawVal - (1 << bitsStored);
        }
      } else if (pixelRepresentation === 1) {
        rawVal = view.getInt16(i * 2, littleEndian);
      }
      const modalityVal = rawVal * rescaleSlope + rescaleIntercept;
      values[i] = modalityVal;
      if (modalityVal < min) min = modalityVal;
      if (modalityVal > max) max = modalityVal;
    }
  } else {
    return {
      kind: 'unsupported',
      reason: `BitsAllocated=${bitsAllocated} 포맷은 현재 프리뷰를 지원하지 않습니다.`,
      codec: 'raw',
    };
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
