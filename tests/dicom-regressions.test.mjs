import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { parseDicomBuffer } from '../src/dicom/parser.js';
import { decodePixelFrame, extractPixelMeta } from '../src/dicom/pixelRenderer.js';
import { generateSampleDicomBuffer } from '../src/dicom/sampleGenerator.js';
import { writeDicomDocument } from '../src/dicom/writer.js';
import { AppStore, canEditNodeValue, countDocChanges } from '../src/state/store.js';

globalThis.localStorage = { getItem: () => null, setItem() {} };

const explicitLittleEndian = '1.2.840.10008.1.2.1';
const explicitBigEndian = '1.2.840.10008.1.2.2';
const deflatedSyntax = '1.2.840.10008.1.2.1.99';
const patientName = (doc) => doc.datasetNodes.find((node) => node.tag === '00100010');
const parse = (bytes) => parseDicomBuffer(Uint8Array.from(bytes).buffer);
const hex = (value) => Buffer.from(value.replaceAll(' ', ''), 'hex');

function fileMeta(uid = explicitLittleEndian) {
  const syntax = Buffer.from(uid.length % 2 ? `${uid}\0` : uid, 'ascii');
  const header = Buffer.alloc(152);
  header.write('DICM', 128, 'ascii');
  hex('02 00 00 00 55 4c 04 00').copy(header, 132);
  header.writeUInt32LE(8 + syntax.length, 140);
  hex('02 00 10 00 55 49').copy(header, 144);
  header.writeUInt16LE(syntax.length, 150);
  return Buffer.concat([header, syntax]);
}

test('sample saves byte-for-byte and decodes its grayscale frame', async () => {
  const sample = new Uint8Array(await generateSampleDicomBuffer());
  const doc = await parse(sample);
  assert.deepEqual(await writeDicomDocument(doc), sample);
  const frame = await decodePixelFrame(extractPixelMeta(doc));
  assert.deepEqual([frame.kind, frame.width, frame.height], ['scalar', 256, 256]);
});

test('Transfer Syntax UID is read-only across single and batch edits', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer());
  const store = new AppStore();
  store.loadDocument(doc);
  const syntax = doc.metaNodes.find((node) => node.tag === '00020010');
  const params = { group: 2, element: 16, vr: 'UI', value: '1.2.840.10008.1.2' };
  assert.equal(canEditNodeValue(syntax), false);
  store.updateNodeValue(syntax.id, params.value);
  store.toggleDeleteNode(syntax.id);
  assert.equal(store.addTag(params).locked, true);
  for (const mode of ['set', 'update', 'delete']) {
    assert.deepEqual(await store.batchEditAcrossFiles({ ...params, mode }), { affectedFiles: 0, locked: true });
  }
  assert.equal(syntax.value, explicitLittleEndian);
  assert.equal(syntax.status, 'unchanged');
  syntax.value = params.value;
  await assert.rejects(writeDicomDocument(doc), /Transfer Syntax UID/);
});

test('charset edits transcode unchanged Latin-1 text, including inherited item text', async () => {
  const latin1 = hex('08 00 05 00 43 53 0a 00 49 53 4f 5f 49 52 20 31 30 30');
  const name = hex('10 00 10 00 50 4e 06 00 47 61 72 63 ed 61');
  const sequence = hex('08 00 15 11 53 51 00 00 16 00 00 00 fe ff 00 e0 0e 00 00 00');
  const original = Uint8Array.from(Buffer.concat([fileMeta(), latin1, sequence, name, name]));
  const doc = await parse(original);
  const store = new AppStore();
  store.loadDocument(doc);
  const charset = doc.datasetNodes[0];
  const expected = 'Garc\u00eda';
  assert.equal(patientName(doc).value, expected);
  store.updateNodeValue(charset.id, 'ISO_IR 192');
  const written = await writeDicomDocument(doc);
  const reopened = await parse(written);
  assert.equal(patientName(reopened).value, expected);
  assert.equal(reopened.datasetNodes[1].items[0].children[0].value, expected);
  assert.deepEqual(patientName(reopened).rawBytes, new TextEncoder().encode(`${expected} `));
  store.undo();
  assert.deepEqual(await writeDicomDocument(doc), original);
  store.redo();
  assert.equal(store.markSaved(doc, store.getDocumentRevision(doc)), true);
  assert.deepEqual(await writeDicomDocument(doc), written);
});

test('unencodable legacy text fails safely until the file is switched to UTF-8', async () => {
  const doc = await parse(Buffer.concat([fileMeta(), hex('10 00 10 00 50 4e 02 00 41 20')]));
  const store = new AppStore();
  store.loadDocument(doc);
  store.updateNodeValue(patientName(doc).id, '\ud55c\uae00');
  await assert.rejects(writeDicomDocument(doc), /SpecificCharacterSet/);
  store.selectNode(patientName(doc).id);
  store.ensureUtf8Charset();
  assert.equal(patientName(await parse(await writeDicomDocument(doc))).value, '\ud55c\uae00');
});

test('undefined-length explicit UN keeps its implicit little-endian items in either outer byte order', async () => {
  const item = hex('fe ff 00 e0 0a 00 00 00 20 00 13 00 02 00 00 00 35 20 fe ff dd e0 00 00 00 00');
  const littleHeader = hex('19 00 10 10 55 4e 00 00 ff ff ff ff');
  const bigHeader = hex('00 19 10 10 55 4e 00 00 ff ff ff ff');
  const littleTail = hex('20 00 13 00 49 53 02 00 37 20');
  const bigTail = hex('00 20 00 13 49 53 00 02 37 20');
  for (const [uid, header, tail] of [[explicitLittleEndian, littleHeader, littleTail], [explicitBigEndian, bigHeader, bigTail]]) {
    const original = Uint8Array.from(Buffer.concat([fileMeta(uid), header, item, tail]));
    const doc = await parse(original);
    assert.equal(doc.datasetNodes[0].items[0].children[0].value, '5');
    assert.equal(doc.datasetNodes[1].value, '7');
    assert.deepEqual(await writeDicomDocument(doc), original);
    const store = new AppStore();
    store.loadDocument(doc);
    store.updateNodeValue(doc.datasetNodes[0].items[0].children[0].id, '123');
    const edited = await parse(await writeDicomDocument(doc));
    assert.equal(edited.datasetNodes[0].items[0].children[0].value, '123');
    assert.equal(edited.datasetNodes[1].value, '7');
  }
});

test('Deflated DICOM reads and writes the standard trailing NUL padding', async () => {
  const dataset = Buffer.concat([hex('08 00 30 10 4c 4f 0c 00'), Buffer.from('AABCDEBCDEBC')]);
  const compressed = deflateRawSync(dataset);
  assert.equal(compressed.length % 2, 1);
  const meta = fileMeta(deflatedSyntax);
  const doc = await parse(Buffer.concat([meta, compressed, Buffer.from([0])]));
  const written = await writeDicomDocument(doc);
  const payload = written.subarray(meta.length);
  assert.equal(payload.length % 2, 0);
  assert.equal(payload.at(-1), 0);
  assert.deepEqual(inflateRawSync(payload), dataset);
  assert.equal((await parse(written)).datasetNodes[0].value, 'AABCDEBCDEBC');
  assert.equal((await parse(Buffer.concat([meta, compressed]))).datasetNodes[0].value, 'AABCDEBCDEBC');
});

test('grayscale uses Bits Stored for 8-bit signed and unsigned samples and rejects short 16-bit frames', async () => {
  const meta = {
    pixelNode: { rawBytes: hex('ff 7f') }, rows: 1, cols: 2, samplesPerPixel: 1,
    photometric: 'MONOCHROME2', bitsAllocated: 8, bitsStored: 7, highBit: 6,
    pixelRepresentation: 0, rescaleSlope: 1, rescaleIntercept: 0, littleEndian: true,
  };
  assert.deepEqual([...(await decodePixelFrame(meta)).values], [127, 127]);
  assert.deepEqual([...(await decodePixelFrame({ ...meta, pixelRepresentation: 1 })).values], [-1, -1]);
  assert.equal((await decodePixelFrame({ ...meta, bitsAllocated: 16 })).kind, 'unsupported');
});

test('truncated declared values and missing item delimiters reject the entire file', async () => {
  const truncated = hex('20 00 13 00 49 53 04 00 31 20');
  await assert.rejects(parse(Buffer.concat([fileMeta(), truncated])), /Truncated DICOM value at \(0020,0013\)/);
  const missingItemDelimiter = hex('08 00 15 11 53 51 00 00 ff ff ff ff fe ff 00 e0 ff ff ff ff fe ff dd e0 00 00 00 00');
  await assert.rejects(parse(Buffer.concat([fileMeta(), missingItemDelimiter])), /Unexpected DICOM item/);
});

test('saving a snapshot never cleans newer edits or the newly active file', async () => {
  const store = new AppStore();
  const sample = await generateSampleDicomBuffer();
  const first = await parseDicomBuffer(sample, 'first.dcm');
  const second = await parseDicomBuffer(sample, 'second.dcm');
  store.loadDocument(first);
  store.updateNodeValue(patientName(first).id, 'Written^Version');
  const revision = store.getDocumentRevision(first);
  const bytes = await writeDicomDocument(first);
  store.undo();
  store.loadDocument(second, null, { append: true });
  store.updateNodeValue(patientName(second).id, 'Another^Edit');

  assert.equal(store.markSaved(first, revision), false);
  assert.equal(patientName(await parse(bytes)).value, 'Written^Version');
  assert.equal(countDocChanges(first), 1);
  assert.equal(patientName(second).status, 'modified');
  assert.equal(store.canUndo(), true);

  const handle = {};
  assert.equal(store.markSaved(first, store.getDocumentRevision(first), { handle, name: 'saved.dcm', size: 42 }), true);
  assert.equal(store.files[0].fileHandle, handle);
  assert.equal(first.fileName, 'saved.dcm');
  assert.equal(countDocChanges(first), 0);
  assert.equal(store.fileHandle, null);
  assert.equal(store.canUndo(), true);
});
