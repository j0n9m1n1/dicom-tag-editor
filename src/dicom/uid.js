/**
 * Standards-compliant DICOM UID generator using the ITU-T / ISO 2.25.<UUID-int> root.
 * Guaranteed globally unique, digits & dots only, and <= 64 bytes (typically 41-44 bytes).
 */

export function generateDicomUid() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set RFC 4122 UUID v4 version & variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let value = 0n;
  for (let i = 0; i < 16; i++) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return `2.25.${value.toString(10)}`;
}

export function getSopInstanceUid(doc) {
  return doc.datasetNodes.find((node) => node.tag === '00080018' && node.status !== 'deleted')?.value.trim() || '';
}

export function isWellKnownDicomUid(uid) {
  return String(uid ?? '').trim().startsWith('1.2.840.10008.');
}
