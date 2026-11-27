/**
 * DICOM text decoding, including ISO 2022 G0/G1 designation and delimiter resets.
 * Writing supports the default repertoire, UTF-8, and Latin-1.
 */

const SINGLE_BYTE_SETS = [
  ['100', 'A', 'iso-8859-1'],
  ['101', 'B', 'iso-8859-2'],
  ['109', 'C', 'iso-8859-3'],
  ['110', 'D', 'iso-8859-4'],
  ['144', 'L', 'iso-8859-5'],
  ['127', 'G', 'iso-8859-6'],
  ['126', 'F', 'iso-8859-7'],
  ['138', 'H', 'iso-8859-8'],
  ['148', 'M', 'iso-8859-9'],
  ['166', 'T', 'windows-874'],
  ['203', 'b', 'iso-8859-15'],
];

const ASCII = 'ascii';
const JIS_ROMAN = 'jis-roman';
const KATAKANA = 'katakana';
const JIS_208 = 'jis-x-0208';
const JIS_212 = 'jis-x-0212';
const ESCAPES = new Map([
  ['(B', ['6', 0, ASCII, 2]],
  ['(J', ['13', 0, JIS_ROMAN, 2]],
  [')I', ['13', 1, KATAKANA, 2]],
  ['$B', ['87', 0, JIS_208, 2]],
  ['$(D', ['159', 0, JIS_212, 3]],
  ['$)C', ['149', 1, 'euc-kr', 3]],
  ['$)A', ['58', 1, 'gbk', 3]],
  ...SINGLE_BYTE_SETS.map(([id, esc, decoder]) => [`-${esc}`, [id, 1, decoder, 2]]),
]);
const LEGACY_BY_ID = new Map(SINGLE_BYTE_SETS.map(([id, , decoder]) => [id, decoder]));
const EXTENDED_CHARSET_VRS = new Set(['SH', 'LO', 'ST', 'PN', 'LT', 'UT', 'UC']);
const FREE_TEXT_VRS = new Set(['ST', 'LT', 'UT']);
const decoders = new Map();

export function usesSpecificCharacterSet(vr, tag = '') {
  const group = Number.parseInt(tag.slice(0, 4), 16);
  const element = Number.parseInt(tag.slice(4), 16);
  const privateCreator = (group & 1) === 1 && element >= 0x0010 && element <= 0x00ff;
  return EXTENDED_CHARSET_VRS.has(vr) && !privateCreator;
}

function charsetTerms(specificCharacterSet) {
  return (specificCharacterSet || '').split('\\').map((term) => term.trim());
}

function legacyId(term) {
  return /^(?:ISO_IR|ISO 2022 IR) (\d+)$/.exec(term)?.[1] || (term ? null : '6');
}

export function resolveDecoderEncoding(specificCharacterSet) {
  const terms = charsetTerms(specificCharacterSet);
  if (terms.length > 1 || terms[0].startsWith('ISO 2022')) return 'iso-2022';
  const term = terms[0];
  if (term === 'GB18030' || term === 'GBK') return term.toLowerCase();
  const id = legacyId(term);
  if (id === '192') return 'utf-8';
  if (id === '13') return 'jis-x-0201';
  if (id === '149') return 'euc-kr';
  return LEGACY_BY_ID.get(id) ?? (id === '6' ? ASCII : null);
}

function decode(bytes, encoding) {
  let decoder = decoders.get(encoding);
  if (!decoder) {
    decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    decoders.set(encoding, decoder);
  }
  return decoder.decode(bytes);
}

function decodeIso2022(bytes, vr, terms) {
  const ids = new Set(terms.map(legacyId));
  const first = legacyId(terms[0]);
  if (first !== '6' && first !== '13' && !LEGACY_BY_ID.has(first)) {
    throw new Error('Unsupported initial ISO 2022 repertoire.');
  }
  const initialG0 = first === '13' ? JIS_ROMAN : ASCII;
  const initialG1 = first === '13' ? KATAKANA : LEGACY_BY_ID.get(first);
  let g0 = initialG0;
  let g1 = initialG1;
  const parts = [];

  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    if (byte === 0x1b) {
      const prefix = String.fromCharCode(bytes[i + 1], bytes[i + 2]);
      const key = prefix === '$(' || prefix === '$)' ? prefix + String.fromCharCode(bytes[i + 3]) : prefix;
      const designation = ESCAPES.get(key);
      if (!designation || terms.length < 2 || (designation[0] !== '6' && !ids.has(designation[0]))) {
        throw new Error('Invalid or undeclared ISO 2022 designation.');
      }
      const [, slot, encoding, size] = designation;
      if (slot === 0) g0 = encoding;
      else g1 = encoding;
      i += size + 1;
      continue;
    }

    if (byte < 0x20 || byte === 0x20 || (byte < 0x80 && g0 === initialG0 &&
        ((byte === 0x5c && !FREE_TEXT_VRS.has(vr)) || (vr === 'PN' && (byte === 0x5e || byte === 0x3d))))) {
      parts.push(String.fromCharCode(byte));
      if (byte !== 0x20) {
        g0 = initialG0;
        g1 = initialG1;
      }
      i++;
      continue;
    }

    const encoding = byte < 0x80 ? g0 : g1;
    if (!encoding || byte === 0x7f || (byte >= 0x80 && byte < 0xa0)) {
      throw new Error('Byte outside the active character repertoire.');
    }
    if (encoding === ASCII || encoding === JIS_ROMAN) {
      const start = i++;
      while (i < bytes.length && bytes[i] >= 0x20 && bytes[i] < 0x7f &&
          (FREE_TEXT_VRS.has(vr) || bytes[i] !== 0x5c) &&
          (vr !== 'PN' || (bytes[i] !== 0x5e && bytes[i] !== 0x3d))) i++;
      let text = decode(bytes.subarray(start, i), 'utf-8');
      // Keep the VM separator as "\"; 05/12 is a Yen sign in Roman free text.
      if (encoding === JIS_ROMAN) text = text.replace(/~/g, '\u203e').replace(/\\/g, '\u00a5');
      parts.push(text);
    } else if (encoding === KATAKANA) {
      if (byte < 0xa1 || byte > 0xdf) throw new Error('Invalid JIS X 0201 Katakana byte.');
      parts.push(String.fromCharCode(0xff61 + byte - 0xa1));
      i++;
    } else if (encoding === JIS_208 || encoding === JIS_212 || encoding === 'euc-kr' || encoding === 'gbk') {
      const trail = bytes[i + 1];
      const japanese = byte < 0x80;
      const min = japanese ? 0x21 : 0xa1;
      const max = japanese ? 0x7e : 0xfe;
      if (byte < min || byte > max || trail === undefined || trail < min || trail > max) {
        throw new Error('Incomplete or invalid ISO 2022 character.');
      }
      const pair = japanese ? [byte | 0x80, trail | 0x80] : [byte, trail];
      if (encoding === JIS_212) pair.unshift(0x8f);
      parts.push(decode(Uint8Array.from(pair), japanese ? 'euc-jp' : encoding));
      i += 2;
    } else {
      const start = i++;
      while (i < bytes.length && bytes[i] >= 0xa0) i++;
      parts.push(decode(bytes.subarray(start, i), encoding));
    }
  }
  return parts.join('');
}

function hasInvalidControls(value, vr) {
  return FREE_TEXT_VRS.has(vr)
    ? /[\x00-\x08\x0B\x0E-\x1F\x7F-\x9F]/.test(value)
    : /[\x00-\x1F\x7F-\x9F]/.test(value);
}

export function isValidDicomUri(value) {
  return /^(?:[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=-]|%[0-9a-fA-F]{2})*$/.test(value.replace(/ +$/, ''));
}

export function decodeDicomText(bytes, vr, specificCharacterSet, tag = '') {
  if (!bytes?.length) return { value: '', charsetError: false };
  const slice = vr === 'UI' && bytes.at(-1) === 0 ? bytes.subarray(0, -1) : bytes;
  const terms = usesSpecificCharacterSet(vr, tag) ? charsetTerms(specificCharacterSet) : [''];
  const encoding = resolveDecoderEncoding(terms.join('\\'));
  let value;
  let charsetError = false;
  try {
    if (encoding === ASCII) {
      if (slice.some((byte) => byte > 0x7f)) throw new Error('Byte outside the default repertoire.');
      value = decode(slice, 'utf-8');
    } else if (encoding === 'iso-2022' || encoding === 'jis-x-0201') {
      value = decodeIso2022(slice, vr, terms);
    } else {
      if (!encoding || (LEGACY_BY_ID.has(legacyId(terms[0])) && slice.some((b) => b >= 0x80 && b < 0xa0))) {
        throw new Error('Unsupported or invalid character repertoire.');
      }
      value = decode(slice, encoding);
    }
    charsetError = hasInvalidControls(value, vr);
  } catch {
    charsetError = true;
    value = new TextDecoder('utf-8', { ignoreBOM: true }).decode(slice);
  }
  if (!FREE_TEXT_VRS.has(vr)) value = value.replace(/ +$/, '');
  return { value, charsetError };
}

export function decodeDicomString(bytes, vr, specificCharacterSet, tag = '') {
  return decodeDicomText(bytes, vr, specificCharacterSet, tag).value;
}

/** Return the reason an edited value cannot be encoded, without allocating its bytes. */
export function dicomStringEncodingError(value, vr, specificCharacterSet = '', tag = '') {
  const str = value ?? '';
  if (hasInvalidControls(str, vr) || /[\uD800-\uDFFF]/u.test(str)) return `Invalid character for VR ${vr}.`;
  if (vr === 'UR' && !isValidDicomUri(str)) return 'URI characters outside RFC 3986 must be percent-encoded.';
  const usesCharset = usesSpecificCharacterSet(vr, tag);
  if (usesCharset && legacyId(charsetTerms(specificCharacterSet)[0]) === '13' &&
      (str.includes('~') || (FREE_TEXT_VRS.has(vr) && str.includes('\\')))) {
    return 'Cannot encode this text with SpecificCharacterSet ISO-IR 13 without changing its meaning.';
  }
  if (!hasNonAscii(str)) return null;
  if (!usesCharset) return `VR ${vr} requires the DICOM default character repertoire.`;
  const charset = specificCharacterSet.trim();
  if (charset === 'ISO_IR 192' || (isLatin1Charset(charset) && !hasNonLatin1(str))) return null;
  return `Cannot encode text with SpecificCharacterSet ${charset || '(default)'}. Set it to ISO_IR 192 (UTF-8) to save Unicode text.`;
}

function isLatin1Charset(charset) {
  return charset === 'ISO_IR 100' || charset === 'ISO 2022 IR 100';
}

export function encodeDicomString(value, vr, specificCharacterSet = '', tag = '') {
  const str = value ?? '';
  const error = dicomStringEncodingError(str, vr, specificCharacterSet, tag);
  if (error) throw new Error(error);
  if (isLatin1Charset(specificCharacterSet.trim()) && hasNonAscii(str)) {
    return Uint8Array.from(str, (char) => char.charCodeAt(0));
  }
  return new TextEncoder().encode(str);
}

export function hasNonAscii(str) {
  return /[^\x00-\x7F]/.test(str || '');
}

export function hasNonLatin1(str) {
  return /[^\x00-\xFF]/.test(str || '');
}

export function isUtf8Charset(specificCharacterSet) {
  return charsetTerms(specificCharacterSet).includes('ISO_IR 192');
}
