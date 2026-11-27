import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { decodeDicomText, encodeDicomString } from '../src/dicom/charset.js';
import { formatDicomJson } from '../src/dicom/dcmdump.js';
import { decodeJpegLossless } from '../src/dicom/jpegLossless.js';
import { parseDicomBuffer } from '../src/dicom/parser.js';
import { ANONYMIZE_PRESET_TAGS, ANONYMIZE_PROFILES, getPhiTagInfo, isPhiNode, shiftDicomDateValue } from '../src/dicom/phiSpec.js';
import { decodePixelFrame, extractPixelMeta, renderFrameToCanvas } from '../src/dicom/pixelRenderer.js';
import { runDicomQaCheck } from '../src/dicom/qaChecker.js';
import { generateSampleDicomBuffer } from '../src/dicom/sampleGenerator.js';
import { extractSrDocument, formatSrMarkdown } from '../src/dicom/srParser.js';
import { isWellKnownDicomUid } from '../src/dicom/uid.js';
import { validateVrValue, VR_32BIT_LENGTH } from '../src/dicom/vrSpec.js';
import { encodeBinaryNumeric, writeDicomDocument } from '../src/dicom/writer.js';
import { buildZipArchive } from '../src/utils/zipWriter.js';

globalThis.localStorage = { getItem: () => null, setItem() {} };

const EXPLICIT_LE = '1.2.840.10008.1.2.1';
const EXPLICIT_BE = '1.2.840.10008.1.2.2';
const IMPLICIT_LE = '1.2.840.10008.1.2';
const DEFLATED = '1.2.840.10008.1.2.1.99';
const CT = '1.2.840.10008.5.1.4.1.1.2';
const DIR = '1.2.840.10008.1.3.10';
const hex = (value) => Buffer.from(value.replaceAll(' ', ''), 'hex');
const join = (...chunks) => Buffer.concat(chunks.flat());
const parse = (bytes, options) => parseDicomBuffer(Uint8Array.from(bytes).buffer, 'test.dcm', options);
const find = (nodes, tag) => nodes.find((node) => node.tag === tag);

function numberBytes(...values) {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => bytes.writeUInt16LE(value & 0xffff, i * 2));
  return bytes;
}

function ul(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function element(tag, vr, value = Buffer.alloc(0), { littleEndian = true, implicit = false, length, longVr = false } = {}) {
  let bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (typeof value === 'string' && bytes.length % 2) bytes = join(bytes, Buffer.from([vr === 'UI' ? 0 : 32]));
  const wide = !implicit && (longVr || VR_32BIT_LENGTH.has(vr));
  const header = Buffer.alloc(wide ? 12 : 8);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint16(0, parseInt(tag.slice(0, 4), 16), littleEndian);
  view.setUint16(2, parseInt(tag.slice(4), 16), littleEndian);
  if (!implicit) header.write(vr, 4, 2, 'ascii');
  if (wide || implicit) view.setUint32(wide ? 8 : 4, length ?? bytes.length, littleEndian);
  else view.setUint16(6, length ?? bytes.length, littleEndian);
  return join(header, bytes);
}

function item(bytes, length) {
  return element('FFFEE000', 'na', bytes, { implicit: true, length });
}

const sequenceEnd = hex('fe ff dd e0 00 00 00 00');
const itemEnd = hex('fe ff 0d e0 00 00 00 00');

function part10(dataset, { syntax = EXPLICIT_LE, sopClass = CT, preamble = Buffer.alloc(128), extraMeta = [] } = {}) {
  const meta = join(
    element('00020001', 'OB', hex('00 01')),
    element('00020002', 'UI', sopClass),
    element('00020003', 'UI', '2.25.1'),
    element('00020010', 'UI', syntax),
    element('00020012', 'UI', '2.25.2'),
    extraMeta
  );
  return join(preamble, Buffer.from('DICM'), element('00020000', 'UL', ul(meta.length)), meta, dataset);
}

function valueNode(tag, value, vr = 'US') {
  return { tag, value: String(value), vr, status: 'unchanged' };
}

function sequenceNode(tag, ...items) {
  return { tag, vr: 'SQ', isSequence: true, status: 'unchanged', items: items.map((children) => ({ children })) };
}

function frameMeta(overrides) {
  return { rows: 1, cols: 2, bitsAllocated: 8, bitsStored: 8, highBit: 7, samplesPerPixel: 1,
    photometric: 'MONOCHROME2', littleEndian: true, pixelRepresentation: 0, ...overrides };
}

function canvasMock() {
  let image;
  return {
    get pixels() { return [...image.data]; },
    getContext: () => ({
      createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (value) => { image = value; },
    }),
  };
}

test('partial PHI profiles identify nested sequences and select direct identifiers for removal', () => {
  for (const tag of ['00101002', '00420011', '00102155', '04000561', 'FFFAFFFA']) {
    assert.ok(getPhiTagInfo(tag));
    assert.equal(ANONYMIZE_PRESET_TAGS.find((entry) => entry.tag === tag)?.action, 'remove');
  }
  const sequence = sequenceNode('00101002', [valueNode('00100020', 'identifying', 'LO')]);
  assert.equal(isPhiNode(sequence), true);
  assert.equal(isPhiNode({ ...sequence, status: 'deleted' }), false);
  const qa = runDicomQaCheck({ datasetNodes: [sequence] });
  assert.equal(qa.phiCount, 2);
  for (const { methodText } of Object.values(ANONYMIZE_PROFILES)) {
    assert.ok(methodText.includes('partial'));
    assert.ok(methodText.length <= 64);
    assert.equal(validateVrValue('LO', methodText).valid, true);
    assert.doesNotMatch(methodText, /Safe Harbor|Basic Application Level Confidentiality Profile/);
  }
  assert.equal(ANONYMIZE_PROFILES.basic.stripPrivate, true);
  assert.equal(ANONYMIZE_PROFILES.basic.regenerateUids, true);
  assert.equal(isWellKnownDicomUid(EXPLICIT_LE), true);
  assert.equal(isWellKnownDicomUid('1.2.840.100080.1'), false);
  assert.equal(isWellKnownDicomUid('2.25.1'), false);
});

test('de-identified Part 10 export clears the preamble and exactly the contracted File Meta tags', async () => {
  const strip = [
    element('00020016', 'AE', 'SOURCE'), element('00020017', 'AE', 'SENDER'), element('00020018', 'AE', 'RECEIVER'),
    element('00020026', 'UR', 'dicom://device'), element('00020027', 'UR', 'dicom://sender'),
    element('00020028', 'UR', 'dicom://receiver'), element('00020100', 'UI', '2.25.3'), element('00020102', 'OB', hex('de ad')),
  ];
  const original = part10(element('00100010', 'PN', 'ANONYMOUS'), {
    preamble: Buffer.alloc(128, 0x5a),
    extraMeta: [element('00020013', 'SH', 'KEEP'), ...strip],
  });
  const doc = await parse(original);
  assert.deepEqual(Buffer.from(await writeDicomDocument(doc)), original);
  doc.deidentified = true;
  const written = await writeDicomDocument(doc);
  assert.deepEqual(written.subarray(0, 128), new Uint8Array(128));
  const reopened = await parse(written);
  assert.deepEqual(reopened.metaNodes.map((node) => node.tag), [
    '00020000', '00020001', '00020002', '00020003', '00020010', '00020012', '00020013',
  ]);
  const metaLength = find(reopened.metaNodes, '00020000').value;
  assert.equal(Number(metaLength), written.length - 144 - element('00100010', 'PN', 'ANONYMOUS').length);
  assert.equal(doc.preamble[0], 0x5a);
});

test('DICOMDIR relocates first, last, next, and lower-level links after size-changing edits', async () => {
  const directory = (first, second) => join(
    element('00041200', 'UL', ul(first)),
    element('00041202', 'UL', ul(second)),
    element('00041220', 'SQ', join(
      item(join(
        element('00041400', 'UL', ul(second)), element('00041420', 'UL', ul(second)),
        element('00041430', 'CS', 'PATIENT'), element('00100010', 'PN', 'A')
      ), 0xffffffff), itemEnd,
      item(join(element('00041400', 'UL', ul(0)), element('00041420', 'UL', ul(0)), element('00041430', 'CS', 'STUDY')))
    ))
  );
  const opts = { sopClass: DIR, extraMeta: [element('00020013', 'SH', 'A')] };
  const blank = await parse(part10(directory(0, 0), opts));
  const [first, second] = find(blank.datasetNodes, '00041220').items;
  const input = part10(directory(first.offset, second.offset), opts);
  const doc = await parse(input);
  assert.deepEqual(Buffer.from(await writeDicomDocument(doc)), input);
  Object.assign(find(doc.metaNodes, '00020013'), { value: 'LONGER_META', status: 'modified' });
  const records = find(doc.datasetNodes, '00041220').items;
  Object.assign(find(records[0].children, '00100010'), { value: 'LONGER^PATIENT', status: 'modified' });
  const reopened = await parse(await writeDicomDocument(doc));
  const [a, b] = find(reopened.datasetNodes, '00041220').items;
  assert.ok(a.offset > first.offset);
  assert.ok(b.offset - a.offset > second.offset - first.offset);
  assert.equal(find(reopened.datasetNodes, '00041200').value, String(a.offset));
  assert.equal(find(reopened.datasetNodes, '00041202').value, String(b.offset));
  assert.equal(find(a.children, '00041400').value, String(b.offset));
  assert.equal(find(a.children, '00041420').value, String(b.offset));
  assert.equal(find(b.children, '00041400').value, '0');
  records.pop();
  await assert.rejects(writeDicomDocument(doc), /does not refer to a retained directory record/);
});

test('gzip, deflate, and recursive SQ enforce resource budgets', async () => {
  let large = element('00191001', 'OB', Buffer.alloc(4096));
  const budget = { maxDecompressedBytes: 1024 };
  for (const bytes of [gzipSync(large), part10(deflateRawSync(large), { syntax: DEFLATED })]) {
    await assert.rejects(parse(bytes, budget), { code: 'RESOURCE_LIMIT', message: /limit/ });
  }
  const valid = await parse(gzipSync(large), { maxDecompressedBytes: large.length });
  assert.equal(valid.wasGzipped, true);
  for (let i = 0; i < 130; i++) large = element('00081115', 'SQ', item(large));
  await assert.rejects(parse(part10(large)), { code: 'RESOURCE_LIMIT', message: /nesting/ });
});

test('writer synchronizes SOP Class and rejects broken required File Meta', async () => {
  const doc = await parse(part10(join(element('00080016', 'UI', CT), element('00080018', 'UI', '2.25.1'))));
  const mr = '1.2.840.10008.5.1.4.1.1.4';
  Object.assign(find(doc.datasetNodes, '00080016'), { value: mr, status: 'modified' });
  const reopened = await parse(await writeDicomDocument(doc));
  assert.equal(find(reopened.metaNodes, '00020002').value, mr);
  for (const tag of ['00020001', '00020012']) {
    const node = find(doc.metaNodes, tag);
    node.status = 'deleted';
    await assert.rejects(writeDicomDocument(doc), /requires/);
    assert.ok(runDicomQaCheck(doc).errors.some((error) => error.code === 'qaMissingTag' && error.tag.endsWith(`${tag.slice(4)})`)));
    node.status = 'unchanged';
  }
});

test('Part 10 group length must match its boundary and a dataset must follow', async () => {
  const good = part10(element('00100010', 'PN', 'TEST^ONE'));
  const declared = good.readUInt32LE(140);
  const short = Buffer.from(good);
  short.writeUInt32LE(declared - element('00020012', 'UI', '2.25.2').length, 140);
  await assert.rejects(parse(short), { code: 'INVALID_META_LENGTH' });
  const long = Buffer.from(good);
  long.writeUInt32LE(declared + 8, 140);
  await assert.rejects(parse(long), { code: 'INVALID_META_LENGTH' });
  await assert.rejects(parse(good.subarray(0, 144 + declared)), { code: 'NO_TAGS' });
});

test('raw syntax probing handles short and Big Endian datasets with an explicit override', async () => {
  const be = join(
    element('00080060', 'CS', 'CT', { littleEndian: false }),
    element('00100010', 'PN', 'TEST^ONE', { littleEndian: false })
  );
  const big = await parse(be);
  assert.equal(big.littleEndian, false);
  assert.equal(big.transferSyntaxUid, EXPLICIT_BE);
  assert.equal(find(big.datasetNodes, '00100010').value, 'TEST^ONE');
  assert.deepEqual(Buffer.from(await writeDicomDocument(big)), be);
  const tiny = element('00100010', 'PN', 'NAME');
  assert.equal(tiny.length, 12);
  assert.equal((await parse(tiny)).datasetNodes[0].value, 'NAME');
  const implicit = element('00100010', 'PN', 'NAME', { implicit: true });
  assert.equal((await parse(implicit)).transferSyntaxUid, IMPLICIT_LE);
  assert.equal((await parse(implicit, { transferSyntaxUid: IMPLICIT_LE })).datasetNodes[0].value, 'NAME');
});

test('unrecognized explicit VRs use long headers and round-trip their original VR bytes', async () => {
  for (const littleEndian of [true, false]) {
    const bytes = part10(join(
      element('00081030', 'ZZ', hex('ca fe 10 27'), { littleEndian, longVr: true }),
      element('00100010', 'PN', 'NAME', { littleEndian })
    ), { syntax: littleEndian ? EXPLICIT_LE : EXPLICIT_BE });
    const doc = await parse(bytes);
    assert.equal(doc.datasetNodes[0].vr, 'UN');
    assert.equal(doc.datasetNodes[0].encodedVr, 'ZZ');
    assert.deepEqual(Buffer.from(doc.datasetNodes[0].rawBytes), hex('ca fe 10 27'));
    assert.equal(doc.datasetNodes[1].value, 'NAME');
    assert.deepEqual(Buffer.from(await writeDicomDocument(doc)), bytes);
  }
  const unknownSequence = element('00191001', 'ZZ', join(item(element('00100010', 'PN', 'NAME')), sequenceEnd),
    { longVr: true, length: 0xffffffff });
  const doc = await parse(part10(unknownSequence));
  assert.equal(doc.datasetNodes[0].items[0].children[0].value, 'NAME');
  assert.deepEqual(Buffer.from(await writeDicomDocument(doc)), part10(unknownSequence));
});

test('invalid VR lengths are rejected instead of manufacturing padded numeric values', async () => {
  for (const [vr, size] of [['US', 3], ['PN', 3], ['OW', 3], ['OL', 6], ['OF', 6], ['OD', 10], ['OV', 10], ['UV', 6]]) {
    await assert.rejects(parse(part10(element('00191001', vr, Buffer.alloc(size)))), { code: 'INVALID_VALUE_LENGTH' });
  }
  const doc = await parse(element('00280010', 'US', numberBytes(1)));
  doc.datasetNodes[0].rawBytes = Uint8Array.of(1, 0, 255);
  await assert.rejects(writeDicomDocument(doc), /Invalid Value Length for US/);
  const paddedOb = await parse(element('00191001', 'OB', hex('ab 00')));
  Object.assign(paddedOb.datasetNodes[0], { rawBytes: Uint8Array.of(0xab), status: 'modified' });
  assert.deepEqual(Buffer.from(await writeDicomDocument(paddedOb)), element('00191001', 'OB', hex('ab 00')));
});

test('implicit VOI LUT uses the modality output sign and alpha descriptors keep unsigned fields', async () => {
  const implicit = (tag, vr, value) => element(tag, vr, value, { implicit: true });
  const ct = await parse(part10(join(
    implicit('00280101', 'US', numberBytes(12)), implicit('00280103', 'US', numberBytes(0)),
    implicit('00281052', 'DS', '-1024'), implicit('00281053', 'DS', '1'),
    implicit('00283010', 'SQ', item(implicit('00283002', 'US', numberBytes(40000, -1024, 16))))
  ), { syntax: IMPLICIT_LE }));
  const desc = find(ct.datasetNodes, '00283010').items[0].children[0];
  assert.deepEqual([desc.vr, desc.value], ['SS', '40000\\-1024\\16']);
  const alpha = join(implicit('00280103', 'US', numberBytes(1)), implicit('00281104', 'US', numberBytes(40000, -1, 8)));
  const alphaDoc = await parse(alpha, { transferSyntaxUid: IMPLICIT_LE });
  assert.deepEqual([alphaDoc.datasetNodes[1].vr, alphaDoc.datasetNodes[1].value], ['SS', '40000\\-1\\8']);
  assert.deepEqual(Buffer.from(encodeBinaryNumeric('40000\\-2\\8', 'SS', true, '00281104')), numberBytes(40000, -2, 8));
});

test('ISO 2022 switches G0/G1 repertoires and respects multibyte delimiter bytes while transcoding', async () => {
  const declaration = 'ISO 2022 IR 6\\ISO 2022 IR 100\\ISO 2022 IR 144\\ISO 2022 IR 87';
  const latinAndCyrillic = hex('41 1b 2d 41 e9 5c 42 1b 2d 4c b0 20');
  const pn = hex('41 3d 1b 24 42 46 7c 4b 5c 1b 28 42 5e 42');
  const bytes = part10(join(
    element('00080005', 'CS', declaration), element('00081030', 'LO', latinAndCyrillic), element('00100010', 'PN', pn)
  ));
  const doc = await parse(bytes);
  assert.deepEqual(doc.datasetNodes.slice(1).map((node) => [node.value, node.charsetError]), [['Aé\\BА', false], ['A=日本^B', false]]);
  assert.deepEqual(Buffer.from(await writeDicomDocument(doc)), bytes);
  Object.assign(doc.datasetNodes[0], { value: 'ISO_IR 192', status: 'modified' });
  const reopened = await parse(await writeDicomDocument(doc));
  assert.deepEqual(reopened.datasetNodes.slice(1).map((node) => node.value), ['Aé\\BА', 'A=日本^B']);
  const lossy = await parse(join(element('00080005', 'CS', 'ISO_IR 6'), element('00100010', 'PN', hex('c3 a9'))));
  Object.assign(lossy.datasetNodes[0], { value: 'ISO_IR 192', status: 'modified' });
  await assert.rejects(writeDicomDocument(lossy), /could not be decoded/);
});

test('QA accepts valid Latin-1 and repertoire checks reject invalid UR and Private Creator text', async () => {
  const valid = await parse(part10(join(
    element('00080005', 'CS', 'ISO_IR 100'), element('00081030', 'LO', hex('e9 20')), element('00190010', 'LO', 'VALID')
  )));
  assert.ok(!runDicomQaCheck(valid).warnings.some((error) => error.code === 'qaCharsetMismatch'));
  const creator = find(valid.datasetNodes, '00190010');
  assert.equal(creator.rawCharset, undefined);
  Object.assign(creator, { status: 'modified', value: 'Créateur' });
  await assert.rejects(writeDicomDocument(valid), /default character repertoire/);
  assert.equal(decodeDicomText(hex('c3 a9'), 'LO', 'ISO_IR 192', '00190010').charsetError, true);
  assert.equal(validateVrValue('UR', 'https://example.org/漢').valid, false);
  assert.throws(() => encodeDicomString('https://example.org/漢', 'UR', 'ISO_IR 192'), /percent-encoded/);
  assert.equal(Buffer.from(encodeDicomString('https://example.org/%E6%BC%A2', 'UR')).toString(), 'https://example.org/%E6%BC%A2');
});

test('preview bounds dimensions and skips overlays whose masks cannot fit their payload budget', async () => {
  const meta = frameMeta({
    cols: 1, pixelNode: { rawBytes: Uint8Array.of(7) },
    overlays: [{ rows: 65535, cols: 65535, appliesToAllFrames: true, numberOfFrames: 1, dataNode: { rawBytes: Uint8Array.of(1) } }],
  });
  assert.deepEqual((await decodePixelFrame(meta)).overlays, []);
  assert.equal((await decodePixelFrame({ ...meta, rows: 65535, cols: 65535 })).kind, 'unsupported');
  const hugeSof = hex('ff d8 ff c3 00 0b 08 ff ff ff ff 01 01 11 00');
  assert.throws(() => decodeJpegLossless(hugeSof), /dimensions|exceeds/);
});

test('8-bit Big Endian OW pairs stay ordered across odd-sized native frames', async () => {
  const meta = frameMeta({ cols: 1, numberOfFrames: 3, littleEndian: false, pixelNode: { vr: 'OW', rawBytes: Uint8Array.of(20, 10, 0, 30) } });
  for (const [index, expected] of [10, 20, 30].entries()) {
    assert.deepEqual([...(await decodePixelFrame(meta, index)).values], [expected]);
  }
  assert.equal((await decodePixelFrame(meta, 3)).kind, 'unsupported');
  assert.deepEqual([...(await decodePixelFrame({ ...meta, pixelNode: { ...meta.pixelNode, vr: 'OB' } })).values], [20]);
});

test('RGB and YBR use stored sample precision instead of reading unused color bits', async () => {
  const meta = frameMeta({ cols: 1, bitsStored: 7, highBit: 6, samplesPerPixel: 3, photometric: 'RGB',
    pixelNode: { rawBytes: Uint8Array.of(0x80, 0xff, 0x80) } });
  assert.deepEqual([...(await decodePixelFrame(meta)).rgba], [0, 255, 0, 255]);
  const ybr = { ...meta, photometric: 'YBR_FULL', pixelNode: { rawBytes: Uint8Array.of(0xff, 0xc0, 0xc0) } };
  assert.deepEqual([...(await decodePixelFrame(ybr)).rgba], [255, 255, 255, 255]);
});

test('Enhanced CT uses per-frame rescale and renders LINEAR_EXACT and SIGMOID windows', async () => {
  const val = (tag, value) => valueNode(tag, value, 'DS');
  const transform = (intercept) => sequenceNode('00289145', [val('00281052', intercept), val('00281053', 1)]);
  const window = (center, width, voi) => sequenceNode('00289132', [
    val('00281050', center), val('00281051', width), valueNode('00281056', voi, 'CS'),
  ]);
  const meta = extractPixelMeta({ datasetNodes: [
    valueNode('00280010', 1), valueNode('00280011', 1), valueNode('00280008', 2), valueNode('00280100', 8),
    sequenceNode('52009229', [window(0, 0.5, 'LINEAR_EXACT')]),
    sequenceNode('52009230', [transform(-5)], [transform(-12), window(0, 4, 'SIGMOID')]),
    { tag: '7FE00010', rawBytes: Uint8Array.of(5, 10) },
  ] });
  const canvas = canvasMock();
  const frame0 = await decodePixelFrame(meta, 0);
  assert.deepEqual([[...frame0.values], frame0.windowWidth, frame0.voiFunction], [[0], 0.5, 'LINEAR_EXACT']);
  renderFrameToCanvas(canvas, frame0, meta);
  assert.equal(canvas.pixels[0], 128);
  const frame1 = await decodePixelFrame(meta, 1);
  assert.deepEqual([[...frame1.values], frame1.windowWidth, frame1.voiFunction], [[-2], 4, 'SIGMOID']);
  renderFrameToCanvas(canvas, frame1, meta);
  assert.equal(canvas.pixels[0], 30);
});

test('JPEG Baseline MONOCHROME1 uses scalar rescale, windowing, and polarity', async (t) => {
  const bitmap = { width: 2, height: 1, closed: false, close() { this.closed = true; } };
  const originalCanvas = globalThis.OffscreenCanvas;
  const originalBitmap = globalThis.createImageBitmap;
  t.after(() => {
    globalThis.OffscreenCanvas = originalCanvas;
    globalThis.createImageBitmap = originalBitmap;
  });
  globalThis.OffscreenCanvas = class {
    getContext() {
      return { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.of(20, 20, 20, 255, 100, 100, 100, 255) }) };
    }
  };
  globalThis.createImageBitmap = async (_, options) => {
    assert.equal(options.colorSpaceConversion, 'none');
    return bitmap;
  };
  const meta = frameMeta({ compressed: true, codec: 'jpeg-baseline', photometric: 'MONOCHROME1', rescaleSlope: 2,
    rescaleIntercept: -40, pixelNode: { fragments: [hex('ff d8 ff d9')] } });
  const decoded = await decodePixelFrame(meta);
  assert.equal(decoded.kind, 'scalar');
  assert.deepEqual([...decoded.values], [0, 160]);
  assert.equal(bitmap.closed, true);
  const canvas = canvasMock();
  renderFrameToCanvas(canvas, decoded, meta, { wc: 80.5, ww: 161 });
  assert.deepEqual(canvas.pixels.filter((_, index) => index % 4 === 0), [255, 0]);
});

function rle(...segments) {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(segments.length);
  let offset = 64;
  for (const [index, segment] of segments.entries()) {
    header.writeUInt32LE(offset, 4 + index * 4);
    offset += segment.length;
  }
  return join(header, segments);
}

test('RLE rejects missing segments, nonincreasing offsets, truncated runs, and row overruns', async () => {
  const decode = (data, overrides) => decodePixelFrame(frameMeta({ compressed: true, codec: 'rle',
    pixelNode: { fragments: [data] }, ...overrides }));
  assert.deepEqual([...(await decode(rle(hex('ff 19')))).values], [25, 25]);
  assert.deepEqual([...(await decode(rle(hex('ff 01'), hex('ff 02')), { bitsAllocated: 16, bitsStored: 16, highBit: 15 })).values], [258, 258]);
  assert.equal((await decode(rle(hex('ff 19')), { bitsAllocated: 16 })).kind, 'unsupported');
  assert.equal((await decode(rle(hex('80 ff')))).kind, 'unsupported');
  assert.equal((await decode(rle(hex('fe 19')))).kind, 'unsupported');
  const duplicateOffset = rle(hex('ff 01'), hex('ff 02'));
  duplicateOffset.writeUInt32LE(64, 8);
  assert.equal((await decode(duplicateOffset, { bitsAllocated: 16 })).kind, 'unsupported');
});

function jpegLossless({ width = 1, height = 1, components = 1, category = 0, predictor = 1, point = 0, interval = 0,
  entropy = hex('7f'), eoi = true } = {}) {
  const componentSpecs = Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat();
  const header = Buffer.from([0xff, 0xc3, 0, 8 + 3 * components, 8, 0, height, 0, width, components, ...componentSpecs]);
  const table = Buffer.from([0xff, 0xc4, 0, 20, 0, 1, ...Array(15).fill(0), category]);
  const scan = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, predictor, 0, point]);
  const restart = interval ? Buffer.from([0xff, 0xdd, 0, 4, 0, interval]) : Buffer.alloc(0);
  return join(hex('ff d8'), table, header, restart, scan, entropy, eoi ? hex('ff d9') : Buffer.alloc(0));
}

test('JPEG Lossless validates scan coverage, entropy, restart order, and point transform', () => {
  assert.deepEqual([...decodeJpegLossless(jpegLossless({ point: 2 })).data], [128]);
  assert.throws(() => decodeJpegLossless(jpegLossless({ point: 8 })), /point transform/);
  assert.throws(() => decodeJpegLossless(jpegLossless({ predictor: 4 }), { firstOrderOnly: true }), /predictor/);
  assert.throws(() => decodeJpegLossless(jpegLossless({ category: 15 })), /sample magnitude/);
  assert.throws(() => decodeJpegLossless(jpegLossless({ components: 3 })), /scans for all components/);
  assert.throws(() => decodeJpegLossless(jpegLossless({ eoi: false })), /Missing JPEG marker/);
  const restart = { width: 2, height: 2, interval: 2 };
  assert.deepEqual([...decodeJpegLossless(jpegLossless({ ...restart, entropy: hex('3f ff d0 3f') })).data], [128, 128, 128, 128]);
  assert.throws(() => decodeJpegLossless(jpegLossless({ ...restart, entropy: hex('3f ff d1 3f') })), /RST0/);
  assert.throws(() => decodeJpegLossless(jpegLossless({ ...restart, entropy: hex('3f') })), /RST0/);
});

test('encapsulation requires fragments and BOT entries at strictly increasing Item starts', async () => {
  const syntax = '1.2.840.10008.1.2.4.57';
  const enc = (table, ...fragments) => part10(join(
    element('00280008', 'IS', '2'),
    element('7FE00010', 'OB', join(item(table), fragments.map((fragment) => item(fragment)), sequenceEnd), { length: 0xffffffff })
  ), { syntax });
  const fragments = [hex('00 01'), hex('02 03'), hex('04 05')];
  await parse(enc(join(ul(0), ul(20)), ...fragments));
  for (const table of [join(ul(0), ul(11)), join(ul(0), ul(0)), join(ul(0)), hex('00 00')]) {
    await assert.rejects(parse(enc(table, ...fragments)), { code: 'INVALID_ENCAP_PIXEL' });
  }
  await assert.rejects(parse(enc(Buffer.alloc(0))), { code: 'INVALID_ENCAP_PIXEL', message: /no fragments/ });
  await assert.rejects(parse(enc(Buffer.alloc(0), hex('01'))), { code: 'INVALID_ENCAP_PIXEL' });
  const meta = frameMeta({ numberOfFrames: 2, compressed: true, codec: 'jpeg-lossless',
    pixelNode: { basicOffsetTable: join(ul(0), ul(11)), fragments: [jpegLossless(), jpegLossless()] } });
  assert.equal((await decodePixelFrame(meta, 1)).kind, 'unsupported');
});

test('DICOM JSON emits ordered PS3.18 attributes, PN groups, nested values and InlineBinary', async () => {
  const be = { littleEndian: false };
  const doc = await parse(part10(join(
    element('00080000', 'UL', hex('00 00 00 00'), be),
    element('00080008', 'CS', 'ORIGINAL\\\\AXIAL', be),
    element('00100010', 'PN', 'Name^Given=Ideographic=', be),
    element('00100020', 'LO', '', be),
    element('60000010', 'US', hex('00 04'), be),
    element('60003000', 'OW', hex('12 34'), be)
  ), { syntax: EXPLICIT_BE }));
  doc.datasetNodes.push(sequenceNode('00081115', [valueNode('00081155', '2.25.1', 'UI')], []));
  const text = formatDicomJson(doc);
  assert.ok(text.indexOf('"00080008"') < text.indexOf('"60000010"'));
  const model = JSON.parse(text);
  assert.equal(model['00020010'], undefined);
  assert.equal(model['00080000'], undefined);
  assert.deepEqual(model['00100010'], { vr: 'PN', Value: [{ Alphabetic: 'Name^Given', Ideographic: 'Ideographic' }] });
  assert.deepEqual(model['00100020'], { vr: 'LO' });
  assert.deepEqual(model['00080008'].Value, ['ORIGINAL', null, 'AXIAL']);
  assert.deepEqual(model['00081115'].Value, [{ '00081155': { vr: 'UI', Value: ['2.25.1'] } }, {}]);
  assert.deepEqual(model['60000010'].Value, [4]);
  assert.deepEqual(Buffer.from(model['60003000'].InlineBinary, 'base64'), hex('34 12'));
});

test('classic ZIP rejects overflowing counts, names and total size before assembling the archive', () => {
  assert.throws(() => buildZipArchive(new Array(65536)), /Too many entries/);
  assert.throws(() => buildZipArchive([{ name: '한'.repeat(22000), data: new Uint8Array() }]), /name exceeds/);
  const shared = new Uint8Array(1024 * 1024);
  assert.throws(() => buildZipArchive(Array.from({ length: 4096 }, (_, index) => ({ name: `${index}.dcm`, data: shared }))), /size limit/);
});

test('ZIP clamps DOS dates, deduplicates normalized names and preserves CRC and UTF-8 flags', () => {
  const entries = [
    { name: 'Étude/파일.DCM', data: Buffer.from('123456789') },
    { name: 'E\u0301TUDE/파일.dcm', data: Uint8Array.of(1) },
  ];
  const archive = Buffer.from(buildZipArchive(entries, { date: new Date(2108, 0, 1) }));
  assert.equal(archive.readUInt16LE(6), 0x0800);
  assert.equal(archive.readUInt16LE(10), 0xbf7d);
  assert.equal(archive.readUInt16LE(12), 0xff9f);
  assert.equal(archive.readUInt32LE(14), 0xcbf43926);
  const second = 30 + archive.readUInt16LE(26) + 9;
  assert.match(archive.toString('utf8', second + 30, second + 30 + archive.readUInt16LE(second + 26)), /파일_2\.dcm$/);
  const cdStart = archive.readUInt32LE(archive.length - 6);
  assert.equal(archive.readUInt16LE(cdStart + 8), 0x0800);
  assert.equal(archive.readUInt16LE(cdStart + 14), 0xff9f);
  const old = Buffer.from(buildZipArchive(entries, { date: new Date(1979, 11, 31) }));
  assert.equal(old.readUInt16LE(10), 0);
  assert.equal(old.readUInt16LE(12), 0x21);
});

test('date validation and shifting preserve early years and report non-shiftable components', () => {
  assert.equal(validateVrValue('DA', '00991231').valid, true);
  assert.equal(shiftDicomDateValue('00991231', 'DA', 1), '01000101');
  assert.equal(shiftDicomDateValue('20240229023500.123+0900', 'DT', 1), '20240301023500.123+0900');
  assert.equal(validateVrValue('DT', '20260230').valid, false);
  assert.equal(validateVrValue('DT', '202601+1401').valid, false);
  assert.equal(validateVrValue('DT', '202601+1400').valid, true);
  const skipped = [];
  const report = (component, reason) => skipped.push([component, reason]);
  assert.equal(shiftDicomDateValue('202601\\20260101\\20161231235960+0000', 'DT', 1, report),
    '202601\\20260102\\20161231235960+0000');
  assert.equal(shiftDicomDateValue('99991231', 'DA', 1, report), '99991231');
  assert.deepEqual(skipped, [['202601', 'partial'], ['20161231235960+0000', 'leap-second'], ['99991231', 'out-of-range']]);
});

test('editing one FL component preserves exact other components, NaN payload, and negative zero', async () => {
  const raw = hex('01 00 80 3f 23 01 c0 7f 00 00 00 80 00 00 00 40');
  const doc = await parse(element('00700022', 'FL', raw));
  const node = doc.datasetNodes[0];
  assert.equal(node.value, '1.0000001192092896\\NaN\\-0\\2');
  assert.equal(node.validation.valid, true);
  Object.assign(node, { value: node.value.replace(/2$/, '3'), status: 'modified' });
  const firstSave = await writeDicomDocument(doc);
  const reopened = await parse(firstSave);
  assert.deepEqual(Buffer.from(reopened.datasetNodes[0].rawBytes.subarray(0, 12)), raw.subarray(0, 12));
  assert.ok(Number.isNaN(new DataView(encodeBinaryNumeric('NaN', 'FD', true).buffer).getFloat64(0, true)));
  assert.throws(() => formatDicomJson(reopened), /non-finite FL/);
  Object.assign(node, { rawBytes: null, originalValue: node.value, status: 'unchanged' });
  assert.deepEqual(await writeDicomDocument(doc), firstSave);
});

test('SR retains absolute temporal coordinates, DT suffixes, and by-reference paths', () => {
  const doc = { datasetNodes: [sequenceNode('0040A730',
    [valueNode('0040A040', 'DATETIME', 'CS'), valueNode('0040A120', '20261127+0900', 'DT')],
    [valueNode('0040A040', 'TCOORD', 'CS'), valueNode('0040A130', 'SEGMENT', 'CS'),
      valueNode('0040A13A', '2026112709+0900\\20261127101500.1+0900', 'DT')],
    [{ ...valueNode('0040DB73', '1\\2', 'UL'), id: 'reference' }, valueNode('0040A010', 'SELECTED FROM', 'CS')]
  )] };
  const sr = extractSrDocument(doc);
  assert.equal(sr.items[0].valueText, '2026-11-27+0900');
  assert.equal(sr.items[1].valueDetail, '2026-11-27 09+0900 · 2026-11-27 10:15:00.1+0900');
  assert.deepEqual([sr.items[2].valueType, sr.items[2].valueText, sr.items[2].jumpNodeId], ['REFERENCE', '1.2', 'reference']);
  assert.match(formatSrMarkdown(sr), /SELECTED FROM REFERENCE: 1\.2/);
});

test('sample supplies mandatory CT acquisition and frame of reference attributes', async () => {
  const sample = await parseDicomBuffer(await generateSampleDicomBuffer());
  for (const tag of ['00200012', '00200052', '00201040']) assert.ok(find(sample.datasetNodes, tag));
  assert.ok(find(sample.datasetNodes, '00200052').value);
  assert.equal(find(sample.datasetNodes, '00201040').value, '');
});

test('pixel QA checks required geometry, bit ranges, and native byte counts', async () => {
  const sample = await parseDicomBuffer(await generateSampleDicomBuffer());
  find(sample.datasetNodes, '00280102').value = '3';
  find(sample.datasetNodes, '00280010').value = '1';
  find(sample.datasetNodes, '00280103').status = 'deleted';
  const qa = runDicomQaCheck(sample);
  assert.ok(qa.errors.some((error) => error.code === 'qaPixelHighBitInvalid'));
  assert.ok(qa.errors.some((error) => error.code === 'qaPixelByteCountInvalid'));
  assert.ok(qa.errors.some((error) => error.tag === '(0028,0103)'));
  find(sample.datasetNodes, '00280101').value = '0';
  assert.ok(runDicomQaCheck(sample).errors.some((error) => error.code === 'qaPixelBitsInvalid'));
});
