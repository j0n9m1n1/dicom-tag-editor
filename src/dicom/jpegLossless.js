/**
 * Pure JavaScript, zero-dependency ITU-T T.81 (Annex H) JPEG Lossless decoder
 * supporting DICOM Transfer Syntaxes:
 *  - 1.2.840.10008.1.2.4.57 (JPEG Lossless, Non-Hierarchical, Process 14, SV 1-7)
 *  - 1.2.840.10008.1.2.4.70 (JPEG Lossless, Non-Hierarchical, First-Order Prediction, SV 1)
 *
 * Handles 2..16-bit grayscale & multi-component (RGB/YBR) images, interleaved and
 * multi-scan non-interleaved scans, SSSS=16 (-32768), point transform (Al),
 * and Restart Intervals (DRI / RST0-RST7).
 */

import { checkedPixelCount } from './pixelGeometry.js';

/**
 * Build a canonical JPEG Huffman table with an 8-bit fast lookup table
 * and 1..16-bit canonical fallback (ITU-T T.81 Annex C / F.2.2.3).
 */
function buildHuffmanTable(bits, huffVal) {
  const maxCode = new Int32Array(17);
  const minCode = new Int32Array(17);
  const valPtr = new Int32Array(17);
  const lookBits = new Uint8Array(256);
  const lookSym = new Uint8Array(256);

  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len];
    if (count > 0) {
      if (code + count > 1 << len) throw new Error('Oversubscribed JPEG Huffman table.');
      valPtr[len] = k;
      minCode[len] = code;
      for (let j = 0; j < count; j++) {
        if (len <= 8) {
          const shift = 8 - len;
          const base = code << shift;
          const fill = 1 << shift;
          const sym = huffVal[k];
          for (let f = 0; f < fill; f++) {
            lookBits[base + f] = len;
            lookSym[base + f] = sym;
          }
        }
        code++;
        k++;
      }
      maxCode[len] = code - 1;
    } else {
      maxCode[len] = -1;
    }
    code <<= 1;
  }

  return { maxCode, minCode, valPtr, huffVal, lookBits, lookSym };
}

class JpegBitReader {
  /**
   * @param {Uint8Array} data
   * @param {number} offset
   */
  constructor(data, offset) {
    this.data = data;
    this.pos = offset;
    this.end = data.length;
    this.bitBuf = 0;
    this.bitCount = 0;
    this.marker = 0; // non-zero when an entropy-terminating marker (0xD0..0xFE) was hit
  }

  /**
   * Pull bytes into bitBuf until at least 16 bits are available (or marker/EOF reached).
   */
  fillBits() {
    const data = this.data;
    const end = this.end;
    while (this.bitCount <= 16 && this.pos < end && this.marker === 0) {
      const b = data[this.pos++];
      if (b === 0xff) {
        // Skip any 0xFF fill bytes per T.81 B.1.1.2
        let next = 0xff;
        while (this.pos < end) {
          next = data[this.pos++];
          if (next !== 0xff) break;
        }
        if (next === 0xff) throw new Error('Truncated JPEG marker.');
        if (next === 0x00) {
          // Byte-stuffed literal 0xFF
          this.bitBuf = (this.bitBuf << 8) | 0xff;
          this.bitCount += 8;
        } else {
          // Marker encountered — stop feeding entropy bits; remember marker byte
          this.marker = next;
          break;
        }
      } else {
        this.bitBuf = (this.bitBuf << 8) | b;
        this.bitCount += 8;
      }
    }
  }

  decodeHuffman(table) {
    if (this.bitCount < 16) this.fillBits();

    // Fast path: 8-bit direct lookup when >= 8 bits are buffered
    if (this.bitCount >= 8) {
      const peek = (this.bitBuf >>> (this.bitCount - 8)) & 0xff;
      const len = table.lookBits[peek];
      if (len > 0) {
        this.bitCount -= len;
        return table.lookSym[peek];
      }
    }

    // Slow path: bit-by-bit canonical decode for 9..16-bit codes (or near EOF)
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      if (this.bitCount === 0) {
        this.fillBits();
        if (this.bitCount === 0) {
          throw new Error('Unexpected end of JPEG Lossless entropy stream.');
        }
      }
      this.bitCount--;
      code = (code << 1) | ((this.bitBuf >>> this.bitCount) & 1);
      if (table.maxCode[len] >= 0 && code >= table.minCode[len] && code <= table.maxCode[len]) {
        const idx = table.valPtr[len] + (code - table.minCode[len]);
        return table.huffVal[idx];
      }
    }
    throw new Error('Invalid Huffman code in JPEG Lossless stream.');
  }

  /**
   * Read `n` bits (1..15) and perform JPEG sign extension (ITU-T T.81 Table H.1).
   */
  receiveExtend(s) {
    if (s === 0) return 0;
    if (s === 16) return 32768; // -32768 mod 65536 (0 extra bits per T.81 Table H.1)
    if (!Number.isInteger(s) || s > 16) {
      throw new Error(`Invalid JPEG Lossless SSSS category: ${s}`);
    }
    if (this.bitCount < s) this.fillBits();
    if (this.bitCount < s) {
      throw new Error('Truncated JPEG Lossless sample magnitude.');
    }
    this.bitCount -= s;
    const v = (this.bitBuf >>> this.bitCount) & ((1 << s) - 1);
    const threshold = 1 << (s - 1);
    return v < threshold ? v - ((1 << s) - 1) : v;
  }

  /**
   * Consume a restart marker (RST0..RST7) between restart intervals.
   */
  consumeRestartMarker(index) {
    this.requireScanBoundary();
    if (this.marker !== 0xd0 + index) throw new Error(`Missing expected JPEG restart marker RST${index}.`);
    this.bitBuf = this.bitCount = this.marker = 0;
  }

  requireScanBoundary() {
    if (!this.marker) this.fillBits();
    if (!this.marker || this.bitCount > 7) throw new Error('Missing JPEG marker at the end of entropy data.');
    // T.81 F.1.2.3 asks for 1-bit padding, but some encoders pad with zeros; libjpeg ignores it too.
  }

  /**
   * Return byte offset positioned at the next marker (0xFF <marker>) after the scan.
   */
  getNextMarkerOffset() {
    this.requireScanBoundary();
    if (this.marker >= 0xd0 && this.marker <= 0xd7) throw new Error('Unexpected JPEG restart marker after the scan.');
    return this.pos - 2;
  }
}

/**
 * Compute ITU-T T.81 Table H.1 spatial prediction value for Selection Values 1..7.
 */
function predictSample(sv, ra, rb, rc) {
  switch (sv) {
    case 1:
      return ra;
    case 2:
      return rb;
    case 3:
      return rc;
    case 4:
      return ra + rb - rc;
    case 5:
      return ra + ((rb - rc) >> 1);
    case 6:
      return rb + ((ra - rc) >> 1);
    case 7:
      return (ra + rb) >> 1;
    default:
      return ra;
  }
}

/**
 * Decode a single JPEG Lossless (SOF3) frame bitstream into raw pixel bytes.
 *
 * @param {Uint8Array} bytes Encapsulated JPEG Lossless frame bytes
 * @param {{ rows?: number, cols?: number, bitsAllocated?: number, firstOrderOnly?: boolean }} [hints]
 * @returns {{
 *   width: number,
 *   height: number,
 *   precision: number,
 *   numComponents: number,
 *   bytesPerSample: number,
 *   data: Uint8Array,
 * }}
 */
export function decodeJpegLossless(bytes, hints = {}) {
  if (!bytes || bytes.length < 4) {
    throw new Error('JPEG Lossless stream is too short.');
  }

  const len = bytes.length;
  let pos = 0;

  // Locate SOI (0xFF 0xD8)
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Missing JPEG SOI marker (0xFFD8).');
  }
  pos = 2;

  let precision = 0;
  let width = 0;
  let height = 0;
  let numComponents = 0;
  let frameComponents = [];
  let restartInterval = 0;
  const huffTables = [null, null, null, null];
  let outSamples = null; // Uint16Array storing interleaved decoded samples
  const decodedComponents = new Set();
  let reachedEoi = false;

  const readU16 = (offset) => (bytes[offset] << 8) | bytes[offset + 1];

  while (pos + 1 < len) {
    if (bytes[pos] !== 0xff) {
      throw new Error('Expected a JPEG marker.');
    }
    while (pos < len && bytes[pos] === 0xff) pos++;
    if (pos >= len) break;

    const marker = bytes[pos++];
    if (marker === 0x01) continue;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) throw new Error('Unexpected JPEG marker.');
    if (marker === 0xd9) {
      reachedEoi = true;
      break;
    }

    if (pos + 2 > len) break;
    const segLen = readU16(pos);
    const segStart = pos + 2;
    const segEnd = pos + segLen;
    if (segLen < 2 || segEnd > len) {
      throw new Error(`Truncated JPEG segment 0xFF${marker.toString(16).toUpperCase()}.`);
    }

    if (marker === 0xc3) {
      if (outSamples || segLen < 11) throw new Error('Invalid JPEG Lossless frame header.');
      precision = bytes[segStart];
      height = readU16(segStart + 1) || hints.rows || 0;
      width = readU16(segStart + 3);
      numComponents = bytes[segStart + 5];
      if (precision < 2 || precision > 16 || numComponents < 1 || numComponents > 4 || segLen !== 8 + 3 * numComponents) {
        throw new Error(`Unsupported JPEG Lossless SOF3 parameters (${width}x${height}, P=${precision}, C=${numComponents}).`);
      }
      const pixelCount = checkedPixelCount(height, width);
      frameComponents = [];
      for (let i = 0; i < numComponents; i++) {
        const base = segStart + 6 + i * 3;
        const id = bytes[base];
        if (frameComponents.includes(id) || bytes[base + 1] !== 0x11 || bytes[base + 2] !== 0) {
          throw new Error('Unsupported JPEG Lossless component layout.');
        }
        frameComponents.push(id);
      }
      outSamples = new Uint16Array(pixelCount * numComponents);
      pos = segEnd;
    } else if (marker === 0xc4) {
      // DHT — may contain multiple Huffman tables in a single segment
      let p = segStart;
      while (p < segEnd) {
        if (p + 17 > segEnd) throw new Error('Truncated DHT Huffman table.');
        const tcTh = bytes[p++];
        const th = tcTh & 0x0f;
        if (tcTh !== th || th >= huffTables.length) throw new Error('Invalid JPEG Lossless Huffman table selector.');
        const bits = new Uint8Array(17);
        let totalSyms = 0;
        for (let i = 1; i <= 16; i++) {
          bits[i] = bytes[p++];
          totalSyms += bits[i];
        }
        if (!totalSyms || p + totalSyms > segEnd) {
          throw new Error('Truncated DHT Huffman table.');
        }
        const huffVal = bytes.subarray(p, p + totalSyms);
        p += totalSyms;
        if (huffVal.some((category) => category > 16)) throw new Error('Invalid JPEG Lossless Huffman category.');
        huffTables[th] = buildHuffmanTable(bits, huffVal);
      }
      pos = segEnd;
    } else if (marker === 0xdd) {
      if (segLen !== 4) throw new Error('Invalid JPEG restart interval segment.');
      restartInterval = readU16(segStart);
      pos = segEnd;
    } else if (marker === 0xda) {
      // SOS — Start of Scan
      if (!outSamples || numComponents === 0) {
        throw new Error('SOS encountered before SOF3 in JPEG Lossless stream.');
      }
      const ns = bytes[segStart];
      if (ns < 1 || ns > numComponents || segLen !== 6 + 2 * ns) throw new Error('Invalid JPEG Lossless scan header.');
      const scanComps = [];
      for (let i = 0; i < ns; i++) {
        const cs = bytes[segStart + 1 + i * 2];
        const tdTa = bytes[segStart + 2 + i * 2];
        const td = (tdTa >> 4) & 0x0f;
        const compIdx = frameComponents.indexOf(cs);
        if (compIdx < 0 || (tdTa & 0x0f) !== 0 || decodedComponents.has(compIdx) ||
            scanComps.some((component) => component.compIdx === compIdx)) {
          throw new Error('Invalid or repeated JPEG Lossless scan component.');
        }
        const table = huffTables[td];
        if (!table) {
          throw new Error(`Missing Huffman table #${td} in JPEG Lossless scan.`);
        }
        scanComps.push({ compIdx, table });
      }
      const ss = bytes[segStart + 1 + ns * 2]; // Predictor Selection Value (1..7)
      const al = bytes[segStart + 3 + ns * 2]; // High nibble reserved; low nibble is point transform.
      if (ss < 1 || ss > 7 || (hints.firstOrderOnly && ss !== 1) ||
          bytes[segStart + 2 + ns * 2] !== 0 || al >= precision || restartInterval % width !== 0) {
        throw new Error('Invalid JPEG Lossless predictor, point transform, or restart interval.');
      }
      const initPred = 1 << (precision - al - 1);

      const reader = new JpegBitReader(bytes, segEnd);
      const rowStride = width * numComponents;
      let mcuUntilRestart = restartInterval > 0 ? restartInterval : 0;
      let mcuInRestart = 0;
      let restartIndex = 0;

      // Fast path for the most common DICOM case: 1-component grayscale + SV 1 (.70) + no restart
      if (numComponents === 1 && ns === 1 && ss === 1 && restartInterval === 0 && al === 0) {
        const table = scanComps[0].table;
        for (let y = 0; y < height; y++) {
          const rowOff = y * width;
          // First pixel in row
          const px0 = y === 0 ? initPred : outSamples[rowOff - width];
          const diff0 = reader.receiveExtend(reader.decodeHuffman(table));
          let prev = (px0 + diff0) & 0xffff;
          outSamples[rowOff] = prev;
          for (let x = 1; x < width; x++) {
            const diff = reader.receiveExtend(reader.decodeHuffman(table));
            prev = (prev + diff) & 0xffff;
            outSamples[rowOff + x] = prev;
          }
        }
      } else {
        // General path: SV 1..7, multi-component interleaved/non-interleaved, DRI/RST, point transform
        for (let y = 0; y < height; y++) {
          const rowOff = y * rowStride;
          for (let x = 0; x < width; x++) {
            const isRestartOrigin = restartInterval > 0 && mcuInRestart === 0;
            const inFirstRestartRow = restartInterval > 0 && mcuInRestart < width;
            for (let sIdx = 0; sIdx < ns; sIdx++) {
              const { compIdx, table } = scanComps[sIdx];
              const dstIdx = rowOff + x * numComponents + compIdx;
              let pred;
              if (isRestartOrigin || (y === 0 && x === 0)) {
                pred = initPred;
              } else if (x === 0) {
                pred = outSamples[dstIdx - rowStride];
              } else if (y === 0 || inFirstRestartRow) {
                pred = outSamples[dstIdx - numComponents];
              } else {
                const ra = outSamples[dstIdx - numComponents];
                const rb = outSamples[dstIdx - rowStride];
                const rc = outSamples[dstIdx - rowStride - numComponents];
                pred = predictSample(ss, ra, rb, rc);
              }
              const diff = reader.receiveExtend(reader.decodeHuffman(table));
              outSamples[dstIdx] = (pred + diff) & 0xffff;
            }

            if (restartInterval > 0) {
              mcuInRestart++;
              mcuUntilRestart--;
              if (mcuUntilRestart === 0 && (y < height - 1 || x < width - 1)) {
                 reader.consumeRestartMarker(restartIndex);
                 restartIndex = (restartIndex + 1) % 8;
                mcuUntilRestart = restartInterval;
                mcuInRestart = 0;
              }
            }
          }
        }
      }

      if (al > 0) {
        for (let sIdx = 0; sIdx < ns; sIdx++) {
          const { compIdx } = scanComps[sIdx];
          for (let i = compIdx; i < outSamples.length; i += numComponents) {
            outSamples[i] = (outSamples[i] << al) & 0xffff;
          }
        }
      }

      pos = reader.getNextMarkerOffset();
      for (const { compIdx } of scanComps) decodedComponents.add(compIdx);
    } else {
      // Skip APPn, COM, DQT, etc.
      pos = segEnd;
    }
  }

  if (!reachedEoi || !outSamples || decodedComponents.size !== numComponents) {
    throw new Error('Incomplete JPEG Lossless frame: EOI and scans for all components are required.');
  }

  const use16Bit = precision > 8 || hints.bitsAllocated > 8;
  const bytesPerSample = use16Bit ? 2 : 1;
  const totalSamples = width * height * numComponents;
  const data = new Uint8Array(totalSamples * bytesPerSample);

  if (bytesPerSample === 1) {
    for (let i = 0; i < totalSamples; i++) {
      data[i] = outSamples[i] & 0xff;
    }
  } else {
    // Little-endian 16-bit samples matching decodeUncompressedBytes({ littleEndian: true })
    for (let i = 0; i < totalSamples; i++) {
      const v = outSamples[i];
      data[i * 2] = v & 0xff;
      data[i * 2 + 1] = (v >>> 8) & 0xff;
    }
  }

  return {
    width,
    height,
    precision,
    numComponents,
    bytesPerSample,
    data,
  };
}
