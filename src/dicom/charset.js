/**
 * DICOM SpecificCharacterSet (0008,0005) decoding & encoding helpers.
 * Supports UTF-8 (ISO_IR 192), Korean EUC-KR (ISO 2022 IR 149 / ISO_IR 149),
 * Latin-1 (ISO_IR 100), Shift-JIS / EUC-JP, GB18030, and ASCII fallback.
 */

const CHARSET_MAP = {
  '': 'utf-8',
  'ISO_IR 6': 'utf-8',
  'ISO 2022 IR 6': 'utf-8',
  'ISO_IR 192': 'utf-8',
  'ISO_IR 100': 'iso-8859-1',
  'ISO 2022 IR 100': 'iso-8859-1',
  'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4',
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  'ISO_IR 13': 'shift-jis',
  'ISO 2022 IR 13': 'shift-jis',
  'ISO 2022 IR 87': 'iso-2022-jp',
  'ISO 2022 IR 149': 'euc-kr',
  'ISO_IR 149': 'euc-kr',
  'GB18030': 'gb18030',
  'GBK': 'gbk',
};

const EXTENDED_CHARSET_VRS = new Set(['SH', 'LO', 'ST', 'PN', 'LT', 'UT', 'UC']);

/**
 * Determine preferred TextDecoder label from SpecificCharacterSet tag value.
 * @param {string} specificCharacterSet
 * @returns {string}
 */
export function resolveDecoderEncoding(specificCharacterSet) {
  if (!specificCharacterSet) return 'utf-8';
  const terms = specificCharacterSet
    .split('\\')
    .map((s) => s.trim())
    .filter(Boolean);

  // Prefer UTF-8 if explicitly present
  if (terms.includes('ISO_IR 192')) return 'utf-8';

  // For multi-valued ISO 2022 (e.g. "\ISO 2022 IR 149"), use the non-ASCII charset if present
  for (const term of terms) {
    if (term === 'ISO 2022 IR 149' || term === 'ISO_IR 149') return 'euc-kr';
    if (term === 'GB18030' || term === 'GBK') return 'gb18030';
    if (term === 'ISO 2022 IR 87') return 'iso-2022-jp';
    if (term === 'ISO_IR 13' || term === 'ISO 2022 IR 13') return 'shift-jis';
  }

  for (const term of terms) {
    if (CHARSET_MAP[term]) return CHARSET_MAP[term];
  }
  return 'utf-8';
}

/**
 * Strip ISO 2022 Korean escape sequence (ESC $ ) C) so EUC-KR TextDecoder decodes cleanly.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function stripIso2022KoreanEscapes(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    // ESC $ ) C  -> 0x1B 0x24 0x29 0x43
    if (
      bytes[i] === 0x1b &&
      i + 3 < bytes.length &&
      bytes[i + 1] === 0x24 &&
      bytes[i + 2] === 0x29 &&
      bytes[i + 3] === 0x43
    ) {
      i += 3;
      continue;
    }
    // ESC ( B -> 0x1B 0x28 0x42
    if (
      bytes[i] === 0x1b &&
      i + 2 < bytes.length &&
      bytes[i + 1] === 0x28 &&
      bytes[i + 2] === 0x42
    ) {
      i += 2;
      continue;
    }
    out.push(bytes[i]);
  }
  return new Uint8Array(out);
}

/**
 * Decode raw DICOM string bytes using VR and SpecificCharacterSet.
 * @param {Uint8Array} bytes
 * @param {string} vr
 * @param {string} specificCharacterSet
 * @returns {string}
 */
export function decodeDicomString(bytes, vr, specificCharacterSet) {
  if (!bytes || bytes.length === 0) return '';

  // Trim trailing null bytes (UI padding or stray NULs)
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end--;
  const slice = end === bytes.length ? bytes : bytes.subarray(0, end);

  const encoding = EXTENDED_CHARSET_VRS.has(vr)
    ? resolveDecoderEncoding(specificCharacterSet)
    : 'iso-8859-1';

  let text;
  try {
    const targetBytes = encoding === 'euc-kr' ? stripIso2022KoreanEscapes(slice) : slice;
    const decoder = new TextDecoder(encoding, { fatal: false });
    text = decoder.decode(targetBytes);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }

  // Per DICOM PS3.5, trailing spaces are padding for most string VRs (keep internal spaces)
  if (vr !== 'LT' && vr !== 'ST' && vr !== 'UT') {
    text = text.replace(/ +$/, '');
  }
  return text;
}

/**
 * Encode string to bytes for saving.
 * Uses UTF-8 for ISO_IR 192 / extended Unicode, and Latin-1/ASCII otherwise.
 * @param {string} value
 * @param {string} vr
 * @param {string} specificCharacterSet
 * @returns {Uint8Array}
 */
export function encodeDicomString(value, vr, specificCharacterSet) {
  const str = value ?? '';
  if (str.length === 0) return new Uint8Array(0);

  if (vr === 'UI' || !EXTENDED_CHARSET_VRS.has(vr)) {
    // ASCII / single-byte encoding
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
  }

  const enc = resolveDecoderEncoding(specificCharacterSet);
  if (enc === 'iso-8859-1' && !hasNonLatin1(str)) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      out[i] = str.charCodeAt(i) & 0xff;
    }
    return out;
  }

  // Default modern standard: UTF-8 (compatible with ISO_IR 192)
  return new TextEncoder().encode(str);
}

export function hasNonAscii(str) {
  return /[^\x00-\x7F]/.test(str || '');
}

export function hasNonLatin1(str) {
  return /[^\x00-\xFF]/.test(str || '');
}

export function isUtf8Charset(specificCharacterSet) {
  return (specificCharacterSet || '')
    .split('\\')
    .map((s) => s.trim())
    .includes('ISO_IR 192');
}
