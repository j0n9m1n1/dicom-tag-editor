/**
 * Generates a fully standards-compliant Part 10 DICOM sample file (ArrayBuffer)
 * containing Korean UTF-8 PatientName, multi-value tags, nested SQ sequences,
 * Private tags, and a 256x256 16-bit synthetic CT head phantom PixelData.
 */

import { writeDicomDocument } from './writer.js';
import { formatTag, tagHex } from './dictionary.js';

function makeNode(group, element, vr, value, opts = {}) {
  return {
    id: `sample_${group}_${element}_${Math.random().toString(36).slice(2, 7)}`,
    group,
    element,
    tag: tagHex(group, element),
    formattedTag: formatTag(group, element),
    vr,
    value: value ?? '',
    originalValue: value ?? '',
    isSequence: vr === 'SQ',
    isBinary: Boolean(opts.isBinary),
    encapsulated: false,
    undefinedLength: Boolean(opts.undefinedLength),
    rawBytes: opts.rawBytes || null,
    items: opts.items || undefined,
    status: 'added',
  };
}

/**
 * Create a realistic 256x256 16-bit CT phantom (Shepp-Logan inspired) in raw stored units
 * where HU = storedValue * 1 + (-1024).
 */
function buildSyntheticCtPhantom(size = 256) {
  const bytes = new Uint8Array(size * size * 2);
  const view = new DataView(bytes.buffer);

  // Ellipses: [cx, cy, rx, ry, angleRad, deltaHU]
  const ellipses = [
    [0.0, 0.0, 0.69, 0.90, 0, 1000],          // Skull outer (high HU)
    [0.0, -0.0184, 0.64, 0.85, 0, -960],      // Brain parenchyma (~40 HU)
    [0.22, 0.0, 0.11, 0.31, -0.314, -35],     // Right ventricle (~5 HU)
    [-0.22, 0.0, 0.16, 0.41, 0.314, -35],     // Left ventricle (~5 HU)
    [0.0, 0.35, 0.21, 0.25, 0, 22],           // Hyperdense region
    [0.0, 0.1, 0.046, 0.046, 0, 35],
    [0.0, -0.1, 0.046, 0.046, 0, 35],
    [-0.08, -0.605, 0.046, 0.023, 0, 45],
    [0.0, -0.605, 0.023, 0.023, 0, 45],
    [0.06, -0.605, 0.023, 0.046, 0, 45],
    [0.14, 0.22, 0.08, 0.07, 0.4, 85],        // Focal bright lesion
  ];

  const half = size / 2;
  for (let y = 0; y < size; y++) {
    const ny = (y - half) / half;
    for (let x = 0; x < size; x++) {
      const nx = (x - half) / half;
      let hu = -1000; // air

      for (const [cx, cy, rx, ry, ang, delta] of ellipses) {
        const dx = nx - cx;
        const dy = ny - cy;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        const u = (dx * cosA + dy * sinA) / rx;
        const v = (-dx * sinA + dy * cosA) / ry;
        if (u * u + v * v <= 1.0) {
          hu += delta;
        }
      }

      // Subtle deterministic texture
      const noise = (((x * 73856093) ^ (y * 19349663)) & 15) - 7;
      const stored = Math.max(0, Math.min(4095, Math.round(hu + 1024 + noise * 0.6)));
      view.setUint16((y * size + x) * 2, stored, true);
    }
  }
  return bytes;
}

export async function generateSampleDicomBuffer() {
  const size = 256;
  const pixelBytes = buildSyntheticCtPhantom(size);
  const sopInstanceUid = '1.2.826.0.1.3680043.8.498.987654321001.1';
  const ctSopClassUid = '1.2.840.10008.5.1.4.1.1.2';

  const metaNodes = [
    makeNode(0x0002, 0x0001, 'OB', '', { isBinary: true, rawBytes: new Uint8Array([0x00, 0x01]) }),
    makeNode(0x0002, 0x0002, 'UI', ctSopClassUid),
    makeNode(0x0002, 0x0003, 'UI', sopInstanceUid),
    makeNode(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
    makeNode(0x0002, 0x0012, 'UI', '1.2.826.0.1.3680043.8.498.1'),
    makeNode(0x0002, 0x0013, 'SH', 'DCM_TAG_EDIT_1'),
    makeNode(0x0002, 0x0016, 'AE', 'LOCAL_PACS_01'),
  ];

  const datasetNodes = [
    // 0008
    makeNode(0x0008, 0x0005, 'CS', 'ISO_IR 192'),
    makeNode(0x0008, 0x0008, 'CS', 'ORIGINAL\\PRIMARY\\AXIAL'),
    makeNode(0x0008, 0x0016, 'UI', ctSopClassUid),
    makeNode(0x0008, 0x0018, 'UI', sopInstanceUid),
    makeNode(0x0008, 0x0020, 'DA', '20261119'),
    makeNode(0x0008, 0x0021, 'DA', '20261119'),
    makeNode(0x0008, 0x0030, 'TM', '103015.000'),
    makeNode(0x0008, 0x0050, 'SH', 'ACC-2026-0042'),
    makeNode(0x0008, 0x0060, 'CS', 'CT'),
    makeNode(0x0008, 0x0070, 'LO', 'OpenPhantom Medical'),
    makeNode(0x0008, 0x0080, 'LO', '서울샘플대학병원'),
    makeNode(0x0008, 0x0090, 'PN', 'Kim^MinSu'),
    makeNode(0x0008, 0x1010, 'SH', 'CT_SCANNER_02'),
    makeNode(0x0008, 0x1030, 'LO', 'BRAIN CT WITHOUT CONTRAST'),
    makeNode(0x0008, 0x103e, 'LO', 'Axial 5mm Standard'),
    makeNode(0x0008, 0x1090, 'LO', 'PhantomCT 128'),
    // Nested SQ
    makeNode(0x0008, 0x1115, 'SQ', '', {
      undefinedLength: false,
      items: [
        {
          id: 'sample_item_1',
          undefinedLength: false,
          children: [
            makeNode(0x0008, 0x114a, 'SQ', '', {
              undefinedLength: false,
              items: [
                {
                  id: 'sample_item_1_1',
                  undefinedLength: false,
                  children: [
                    makeNode(0x0008, 0x1150, 'UI', ctSopClassUid),
                    makeNode(0x0008, 0x1155, 'UI', '1.2.826.0.1.3680043.8.498.987654321000.1'),
                  ],
                },
              ],
            }),
            makeNode(0x0020, 0x000e, 'UI', '1.2.826.0.1.3680043.8.498.987654321000'),
          ],
        },
      ],
    }),
    // Private group 0009
    makeNode(0x0009, 0x0010, 'LO', 'OPENPHANTOM_PRIV'),
    makeNode(0x0009, 0x1001, 'LO', 'RECON_ENGINE_V2'),
    makeNode(0x0009, 0x1002, 'OB', '', {
      isBinary: true,
      rawBytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]),
    }),
    // 0010 Patient
    makeNode(0x0010, 0x0010, 'PN', 'Hong^GilDong=홍^길동'),
    makeNode(0x0010, 0x0020, 'LO', 'PT-2026-0001'),
    makeNode(0x0010, 0x0030, 'DA', '19900515'),
    makeNode(0x0010, 0x0040, 'CS', 'M'),
    makeNode(0x0010, 0x1010, 'AS', '036Y'),
    makeNode(0x0010, 0x4000, 'LT', '샘플 테스트용 합성 뇌 CT 팬텀 데이터입니다.'),
    // 0018 Acquisition
    makeNode(0x0018, 0x0015, 'CS', 'BRAIN'),
    makeNode(0x0018, 0x0050, 'DS', '5.0'),
    makeNode(0x0018, 0x0060, 'DS', '120'),
    makeNode(0x0018, 0x1030, 'LO', 'Routine Brain Axial'),
    makeNode(0x0018, 0x1150, 'IS', '500'),
    makeNode(0x0018, 0x1151, 'IS', '240'),
    makeNode(0x0018, 0x5100, 'CS', 'HFS'),
    // 0020 Geometry
    makeNode(0x0020, 0x000d, 'UI', '1.2.826.0.1.3680043.8.498.100001'),
    makeNode(0x0020, 0x000e, 'UI', '1.2.826.0.1.3680043.8.498.100001.1'),
    makeNode(0x0020, 0x0010, 'SH', 'STD001'),
    makeNode(0x0020, 0x0011, 'IS', '2'),
    makeNode(0x0020, 0x0012, 'IS', '1'),
    makeNode(0x0020, 0x0013, 'IS', '14'),
    makeNode(0x0020, 0x0032, 'DS', '-125.0\\-125.0\\42.5'),
    makeNode(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    makeNode(0x0020, 0x0052, 'UI', '1.2.826.0.1.3680043.8.498.100001.1.1'),
    makeNode(0x0020, 0x1040, 'LO', ''),
    makeNode(0x0020, 0x1041, 'DS', '42.5'),
    // 0028 Pixel attributes
    makeNode(0x0028, 0x0002, 'US', '1'),
    makeNode(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    makeNode(0x0028, 0x0010, 'US', String(size)),
    makeNode(0x0028, 0x0011, 'US', String(size)),
    makeNode(0x0028, 0x0030, 'DS', '0.85\\0.85'),
    makeNode(0x0028, 0x0100, 'US', '16'),
    makeNode(0x0028, 0x0101, 'US', '12'),
    makeNode(0x0028, 0x0102, 'US', '11'),
    makeNode(0x0028, 0x0103, 'US', '0'),
    makeNode(0x0028, 0x1050, 'DS', '40'),
    makeNode(0x0028, 0x1051, 'DS', '120'),
    makeNode(0x0028, 0x1052, 'DS', '-1024'),
    makeNode(0x0028, 0x1053, 'DS', '1'),
    makeNode(0x0028, 0x1054, 'LO', 'HU'),
    // 7FE0 Pixel Data
    makeNode(0x7fe0, 0x0010, 'OW', '', { isBinary: true, rawBytes: pixelBytes }),
  ];

  const doc = {
    hasPart10Header: true,
    preamble: new Uint8Array(128),
    explicit: true,
    littleEndian: true,
    wasDeflated: false,
    metaNodes,
    datasetNodes,
  };

  const bytes = await writeDicomDocument(doc);
  return bytes.buffer;
}
