import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { parseDicomBuffer } from '../src/dicom/parser.js';
import { decodePixelFrame, extractPixelMeta } from '../src/dicom/pixelRenderer.js';
import { generateSampleDicomBuffer } from '../src/dicom/sampleGenerator.js';
import { writeDicomDocument } from '../src/dicom/writer.js';
import { validateVrValue } from '../src/dicom/vrSpec.js';
import { formatDicomJson } from '../src/dicom/dcmdump.js';
import { DICOM_DICTIONARY, lookupTag, lookupUidName } from '../src/dicom/dictionary.js';
import { buildCompareRows } from '../src/ui/compareView.js';
import { buildZipArchive } from '../src/utils/zipWriter.js';
import { ANONYMIZE_PRESET_TAGS, AppStore, canEditNodeValue, countDocChanges } from '../src/state/store.js';

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
  await assert.rejects(parse(Buffer.concat([fileMeta(), missingItemDelimiter])), {
    code: 'UNEXPECTED_ITEM',
    message: /Unexpected DICOM delimiter/,
  });
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

test('opening two same-name, same-size files retains different content and recognizes exact duplicates', async () => {
  const first = await generateSampleDicomBuffer();
  const edited = await parseDicomBuffer(first);
  const store = new AppStore();
  store.loadDocument(edited);
  store.updateNodeValue(patientName(edited).id, 'Test^SameSize=가^나다');
  const second = await writeDicomDocument(edited);
  assert.equal(first.byteLength, second.byteLength);

  const workspace = new AppStore();
  const item = (bytes) => ({ name: 'slice.dcm', sourceFile: new File([bytes], 'slice.dcm') });
  await workspace.loadFileItems([item(first)]);
  await workspace.loadFileItems([item(second)]);
  assert.equal(workspace.files.length, 2);
  assert.equal(patientName(workspace.doc).value, 'Test^SameSize=가^나다');
  await workspace.loadFileItems([item(first)]);
  assert.equal(workspace.files.length, 2);
  assert.equal(patientName(workspace.doc).value, patientName(await parseDicomBuffer(first)).value);
});

test('reverting sequence item changes restores the saved item list and remains undoable', async () => {
  const bytes = await generateSampleDicomBuffer();
  const doc = await parseDicomBuffer(bytes);
  const store = new AppStore();
  store.loadDocument(doc);
  const sequence = doc.datasetNodes.find((node) => node.tag === '00081115');
  store.removeSequenceItem(sequence.items[0].id);
  store.addSequenceItem(sequence.id);
  store.toggleDeleteNode(sequence.id);
  store.toggleDeleteNode(sequence.id);
  assert.equal(countDocChanges(doc), 1);

  store.revertNode(sequence.id);
  assert.equal(countDocChanges(doc), 0);
  assert.deepEqual(await writeDicomDocument(doc), new Uint8Array(bytes));
  store.undo();
  assert.equal(sequence.items[0].children.length, 0);
  assert.equal(countDocChanges(doc), 1);
  store.redo();
  assert.deepEqual(await writeDicomDocument(doc), new Uint8Array(bytes));

  store.addSequenceItem(sequence.id);
  assert.equal(store.markSaved(doc, store.getDocumentRevision(doc)), true);
  store.removeSequenceItem(sequence.items[0].id);
  store.revertNode(sequence.id);
  assert.equal(sequence.items.length, 2);
  assert.equal(countDocChanges(doc), 0);
});

test('editing a SOP Instance UID keeps file metadata in sync through undo, batch edit, and export', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer());
  const store = new AppStore();
  store.loadDocument(doc);
  const sop = doc.datasetNodes.find((node) => node.tag === '00080018');
  const meta = doc.metaNodes.find((node) => node.tag === '00020003');
  const originalUid = sop.value;
  const newUid = '2.25.1001';
  assert.equal(canEditNodeValue(meta), false);

  store.updateNodeValue(sop.id, newUid);
  assert.equal(meta.value, newUid);
  store.undo();
  assert.equal(meta.value, originalUid);
  await store.batchEditAcrossFiles({ group: 8, element: 24, vr: 'UI', value: newUid, mode: 'update' });
  assert.equal(meta.value, newUid);

  // A stale metadata value supplied to the writer cannot make the export inconsistent.
  meta.value = originalUid;
  const reopened = await parse(await writeDicomDocument(doc));
  assert.equal(reopened.datasetNodes.find((node) => node.tag === '00080018').value, newUid);
  assert.equal(reopened.metaNodes.find((node) => node.tag === '00020003').value, newUid);
});

test('batch anonymization applies the preset across files and updates only references to regenerated instances', async () => {
  const bytes = await generateSampleDicomBuffer();
  const source = await parseDicomBuffer(bytes);
  const target = await parseDicomBuffer(bytes);
  const store = new AppStore();
  const sop = (doc) => doc.datasetNodes.find((node) => node.tag === '00080018');
  const study = (doc) => doc.datasetNodes.find((node) => node.tag === '0020000D');
  const references = (doc) => doc.datasetNodes.find((node) => node.tag === '00081115').items[0].children
    .find((node) => node.tag === '0008114A').items[0].children;
  const referenced = (doc) => references(doc).find((node) => node.tag === '00081155');
  const externalUid = referenced(target).value;
  const oldTargetUid = sop(target).value;
  store.loadDocument(source);
  store.updateNodeValue(sop(source).id, '2.25.2001');
  store.updateNodeValue(referenced(source).id, oldTargetUid);
  store.loadDocument(target, null, { append: true });
  store.toggleDeleteNode(patientName(target).id);

  const result = await store.applyAnonymizationAllFiles(ANONYMIZE_PRESET_TAGS, { regenerateUids: true });
  assert.equal(result.affectedFiles, 2);
  const savedSource = await parse(await writeDicomDocument(source));
  const savedTarget = await parse(await writeDicomDocument(target));
  assert.equal(patientName(savedSource).value, 'ANONYMOUS');
  assert.equal(patientName(savedTarget), undefined);
  assert.ok([savedSource, savedTarget].every((doc) => !doc.datasetNodes.some((node) => node.tag === '00120062')));
  assert.notEqual(sop(savedTarget).value, oldTargetUid);
  assert.notEqual(sop(savedTarget).value, sop(savedSource).value);
  assert.equal(referenced(savedSource).value, sop(savedTarget).value);
  assert.equal(referenced(savedTarget).value, externalUid);
  assert.equal(study(savedSource).value, study(savedTarget).value);
});

test('YBR_FULL and packed multi-frame YBR_FULL_422 preview the expected RGB colors', async () => {
  const meta = { rows: 1, cols: 2, samplesPerPixel: 3, planarConfig: 0, bitsAllocated: 8 };
  const red = [254, 0, 0, 255];
  const gray = [128, 128, 128, 255];
  for (const [planarConfig, bytes] of [[0, [76, 85, 255, 128, 128, 128]], [1, [76, 128, 85, 128, 255, 128]]]) {
    const frame = await decodePixelFrame({
      ...meta, planarConfig, photometric: 'YBR_FULL', pixelNode: { rawBytes: Uint8Array.from(bytes) },
    });
    assert.deepEqual([...frame.rgba], [...red, ...gray]);
  }
  const packed = {
    ...meta,
    photometric: 'YBR_FULL_422',
    pixelNode: { rawBytes: Uint8Array.of(128, 128, 128, 128, 76, 76, 85, 255) },
  };
  assert.deepEqual([...(await decodePixelFrame(packed, 0)).rgba], [...gray, ...gray]);
  assert.deepEqual([...(await decodePixelFrame(packed, 1)).rgba], [...red, ...red]);
  assert.equal((await decodePixelFrame(packed, 2)).kind, 'unsupported');
});

test('corrupt RLE frames return unsupported instead of throwing', async () => {
  const frame = await decodePixelFrame({
    rows: 2,
    cols: 2,
    samplesPerPixel: 1,
    photometric: 'MONOCHROME2',
    bitsAllocated: 8,
    compressed: true,
    codec: 'rle',
    transferSyntaxName: 'RLE Lossless',
    pixelNode: { fragments: [new Uint8Array([1, 2, 3])] },
  });
  assert.equal(frame.kind, 'unsupported');
  assert.equal(frame.codec, 'rle');
});

test('SV and UV validate 64-bit integer bounds', () => {
  assert.equal(validateVrValue('SV', '-9223372036854775808').valid, true);
  assert.equal(validateVrValue('SV', '9223372036854775807').valid, true);
  assert.equal(validateVrValue('SV', '9223372036854775808').valid, false);
  assert.equal(validateVrValue('UV', '18446744073709551615').valid, true);
  assert.equal(validateVrValue('UV', '18446744073709551616').valid, false);
});

test('batchEditAcrossFiles set mode restores pending-delete tags without duplicating them', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer());
  const store = new AppStore();
  store.loadDocument(doc);
  const nameNode = patientName(doc);
  store.toggleDeleteNode(nameNode.id);
  assert.equal(nameNode.status, 'deleted');

  const res = await store.batchEditAcrossFiles({ group: 0x0010, element: 0x0010, vr: 'PN', value: 'BATCH^NAME', mode: 'set' });
  assert.equal(res.affectedFiles, 1);
  const matching = doc.datasetNodes.filter((n) => n.tag === '00100010');
  assert.equal(matching.length, 1);
  assert.equal(matching[0].status, 'modified');
  assert.equal(matching[0].value, 'BATCH^NAME');

  store.undo();
  assert.equal(matching[0].status, 'deleted');
});

test('addTag restores a pending-delete tag with matching VR and markSaved clears dangling selection', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer());
  const store = new AppStore();
  store.loadDocument(doc);
  const nameNode = patientName(doc);
  store.selectNode(nameNode.id);
  store.toggleDeleteNode(nameNode.id);
  assert.equal(nameNode.status, 'deleted');

  const res = store.addTag({ group: 0x0010, element: 0x0010, vr: 'PN', value: 'ADDED^BACK' });
  assert.equal(res.duplicate, false);
  assert.equal(res.node, nameNode);
  assert.equal(doc.datasetNodes.filter((n) => n.tag === '00100010').length, 1);
  assert.equal(nameNode.value, 'ADDED^BACK');
  assert.equal(nameNode.status, 'modified');

  store.undo();
  assert.equal(nameNode.status, 'deleted');
  assert.equal(store.markSaved(doc, store.getDocumentRevision(doc)), true);
  assert.notEqual(store.selectedId, nameNode.id);
  assert.equal(store.selectedId, doc.datasetNodes[0].id);
});

test('formatDicomJson keeps backslashes intact for single-value text VRs and 00020000 is read-only', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer());
  const metaLen = doc.metaNodes.find((n) => n.tag === '00020000');
  assert.equal(canEditNodeValue(metaLen), false);

  const comment = doc.datasetNodes.find((n) => n.tag === '00104000');
  comment.value = 'C:\\scans\\brain\\note';
  const parsedJson = JSON.parse(formatDicomJson(doc));
  assert.deepEqual(parsedJson.dataset['00104000'].Value, ['C:\\scans\\brain\\note']);
  assert.deepEqual(parsedJson.dataset['00080008'].Value, ['ORIGINAL', 'PRIMARY', 'AXIAL']);
});

test('buildZipArchive normalizes Windows slashes and strips path traversal segments', () => {
  const zipBytes = buildZipArchive([
    { name: '..\\..\\study\\..\\slice_1.dcm', data: new Uint8Array([1, 2, 3]) },
  ]);
  const text = new TextDecoder('utf-8').decode(zipBytes);
  assert.ok(text.includes('study/slice_1.dcm'));
  assert.equal(text.includes('..'), false);
  assert.equal(text.includes('\\'), false);
});

test('full PS3.6 dictionary resolves MPPS tags and SOP Class UIDs', () => {
  assert.ok(DICOM_DICTIONARY.size > 4500);
  assert.equal(lookupTag(0x0040, 0x0252).keyword, 'PerformedProcedureStepStatus');
  assert.equal(lookupTag(0x0040, 0x0270).keyword, 'ScheduledStepAttributesSequence');
  assert.equal(lookupTag(0x0040, 0x0340).keyword, 'PerformedSeriesSequence');
  assert.equal(lookupUidName('1.2.840.10008.3.1.2.3.3'), 'Modality Performed Procedure Step SOP Class');
});

test('AppStore compare mode initializes two files, updates selection, and exits cleanly below two files', async () => {
  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');
  const store = new AppStore();
  store.loadDocument(a);
  store.loadDocument(b, null, { append: true });

  store.enterCompareMode();
  assert.equal(store.compareMode, true);
  assert.notEqual(store.compareFileAId, store.compareFileBId);

  const [id1, id2] = store.files.map((f) => f.id);
  store.setCompareFiles(id1, id2);
  assert.equal(store.compareFileAId, id1);
  assert.equal(store.compareFileBId, id2);

  await store.removeFile(id2);
  assert.equal(store.compareMode, false);
});

test('buildCompareRows orders File Meta (0002) first, then Main Dataset with SQ children directly beneath parent SQ', async () => {
  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');
  const { rows } = buildCompareRows(a, b, { diffOnly: false });

  const metaIdx = rows.findIndex((r) => r.a?.tag === '(0002,0010)');
  const mainFirstIdx = rows.findIndex((r) => r.a?.tag === '(0008,0005)');
  const sqParentIdx = rows.findIndex((r) => r.a?.tag === '(0008,1115)');
  const sqChildIdx = rows.findIndex((r) => r.a?.tag === '(0008,114A)');
  const sqGrandChildIdx = rows.findIndex((r) => r.a?.tag === '(0008,1150)');
  const patientIdx = rows.findIndex((r) => r.a?.tag === '(0010,0010)');

  assert.ok(metaIdx >= 0 && metaIdx < mainFirstIdx);
  assert.ok(mainFirstIdx < sqParentIdx);
  assert.equal(sqChildIdx, sqParentIdx + 1);
  assert.equal(sqGrandChildIdx, sqChildIdx + 1);
  assert.ok(sqGrandChildIdx < patientIdx);
});
