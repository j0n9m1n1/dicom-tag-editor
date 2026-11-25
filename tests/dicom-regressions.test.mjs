import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync, gzipSync, inflateRawSync } from 'node:zlib';
import { parseDicomBuffer } from '../src/dicom/parser.js';
import { getPhiTagInfo, isPhiNode, shiftDicomDateValue } from '../src/dicom/phiSpec.js';
import { decodePixelFrame, extractPixelMeta } from '../src/dicom/pixelRenderer.js';
import { runDicomQaCheck } from '../src/dicom/qaChecker.js';
import { generateSampleDicomBuffer } from '../src/dicom/sampleGenerator.js';
import { extractSrDocument, formatSrMarkdown, isSrDocument } from '../src/dicom/srParser.js';
import { writeDicomDocument, encodeBinaryNumeric } from '../src/dicom/writer.js';
import { validateVrValue } from '../src/dicom/vrSpec.js';
import { formatDicomJson } from '../src/dicom/dcmdump.js';
import { DICOM_DICTIONARY, lookupTag, lookupUidName, searchDictionary } from '../src/dicom/dictionary.js';
import { buildCompareRows } from '../src/ui/compareView.js';
import { formatHexSlice, formatHexRuler, findSerializedLandmarks } from '../src/ui/rawView.js';
import { formatTabLabel } from '../src/ui/fileTabs.js';
import { buildUniqueRelativePath } from '../src/io/fileIo.js';
import { buildZipArchive } from '../src/utils/zipWriter.js';
import { ANONYMIZE_PRESET_TAGS, AppStore, canEditNodeValue, countDocChanges, hasPixelData } from '../src/state/store.js';

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

test('file tab label middle-truncates long DICOM UID filenames and store supports reorderFile / removeFiles', async () => {
  assert.equal(formatTabLabel('Series1/IM0001.dcm'), 'IM0001.dcm');
  const truncated = formatTabLabel('Series1/1.2.840.113619.2.55.3.604688119.868.1234567890.0001.dcm', 28);
  assert.ok(truncated.length <= 28);
  assert.ok(truncated.includes('…'));
  assert.ok(truncated.endsWith('0001.dcm'));

  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');
  const c = await parseDicomBuffer(bytes, 'c.dcm');
  const store = new AppStore();
  store.loadDocument(a);
  store.loadDocument(b, null, { append: true });
  store.loadDocument(c, null, { append: true });

  const [idA, idB, idC] = store.files.map((f) => f.id);
  store.reorderFile(idC, idA, false);
  assert.deepEqual(store.files.map((f) => f.id), [idC, idA, idB]);
  store.reorderFile(idC, idB, true);
  assert.deepEqual(store.files.map((f) => f.id), [idA, idB, idC]);

  await store.removeFiles([idB, idC]);
  assert.deepEqual(store.files.map((f) => f.id), [idA]);
  assert.equal(store.activeFileId, idA);
});

test('Group FFFE delimiters are blocked from dictionary search, addTag, batchEdit, and writer while SQ remains intact', async () => {
  assert.deepEqual(searchDictionary('FFFE', 10), []);
  assert.equal(searchDictionary('Item', 50).some((e) => e.tag.startsWith('FFFE')), false);

  const bytes = await generateSampleDicomBuffer();
  const doc = await parseDicomBuffer(bytes, 'fffe.dcm');
  const store = new AppStore();
  store.loadDocument(doc);

  assert.equal(store.addTag({ group: 0xfffe, element: 0xe000, vr: 'UN', value: '' }).locked, true);
  assert.equal(store.addTag({ group: 0xfffe, element: 0xe0dd, vr: 'UN', value: '' }).locked, true);
  assert.deepEqual(
    await store.batchEditAcrossFiles({ group: 0xfffe, element: 0xe000, vr: 'LO', value: 'bad', mode: 'set' }),
    { affectedFiles: 0, locked: true }
  );

  // Normal SQ still round-trips cleanly
  assert.deepEqual(await writeDicomDocument(doc), new Uint8Array(bytes));

  // Writer also defends against raw Group FFFE elements injected into datasetNodes
  doc.datasetNodes.push({
    id: 'bad_fffe',
    group: 0xfffe,
    element: 0xe000,
    tag: 'FFFEE000',
    formattedTag: '(FFFE,E000)',
    vr: 'UN',
    isSequence: false,
    isBinary: true,
    rawBytes: new Uint8Array(0),
    value: '',
    status: 'added',
  });
  await assert.rejects(writeDicomDocument(doc), /FFFE/);
});

test('dictionary search prioritizes 0002/0040 groups, supports pre-limit filtering, and resolves repeating Overlay tags', () => {
  const g0002 = searchDictionary('0002', 8);
  assert.equal(g0002.length, 8);
  assert.ok(g0002.every((e) => e.tag.startsWith('0002')));

  const g0002Fmt = searchDictionary('(0002,', 8);
  assert.equal(g0002Fmt.length, 8);
  assert.ok(g0002Fmt.every((e) => e.tag.startsWith('0002')));

  const g0040 = searchDictionary('0040', 8);
  assert.equal(g0040.length, 8);
  assert.ok(g0040.every((e) => e.tag.startsWith('0040')));

  const editableSeq = searchDictionary('Sequence', 8, (e) => e.vr !== 'SQ' && e.vr !== 'OB' && e.vr !== 'OW' && e.vr !== 'UN');
  assert.ok(editableSeq.length > 0);
  assert.ok(editableSeq.every((e) => e.vr !== 'SQ'));

  assert.equal(lookupTag(0x6000, 0x1301).keyword, 'ROIArea');
  assert.equal(lookupTag(0x6000, 0x1301).vr, 'IS');
  assert.equal(lookupTag(0x6002, 0x1302).keyword, 'ROIMean');
  assert.equal(lookupTag(0x6004, 0x1303).keyword, 'ROIStandardDeviation');
  assert.equal(lookupTag(0x6000, 0x1001).keyword, 'OverlayActivationLayer');
});

test('Implicit VR signed pixel-dependent tags resolve SS/US by PixelRepresentation across nested items, JSON, edit, and save', async () => {
  const implicitU16 = (g, e, vals) => {
    const b = Buffer.alloc(8 + vals.length * 2);
    b.writeUInt16LE(g, 0);
    b.writeUInt16LE(e, 2);
    b.writeUInt32LE(vals.length * 2, 4);
    vals.forEach((v, i) => b.writeUInt16LE(v & 0xffff, 8 + i * 2));
    return b;
  };
  const implicitItem = (payload) => {
    const hdr = Buffer.alloc(8);
    hdr.writeUInt16LE(0xfffe, 0);
    hdr.writeUInt16LE(0xe000, 2);
    hdr.writeUInt32LE(payload.length, 4);
    return Buffer.concat([hdr, payload]);
  };
  const implicitSq = (g, e, items) => {
    const body = Buffer.concat(items);
    const hdr = Buffer.alloc(8);
    hdr.writeUInt16LE(g, 0);
    hdr.writeUInt16LE(e, 2);
    hdr.writeUInt32LE(body.length, 4);
    return Buffer.concat([hdr, body]);
  };

  // Signed Implicit VR dataset: (0018,9810) before (0028,0103)=1, (0028,0120)=-1024, (0028,0121)=-100,
  // signed Palette LUT Descriptor (0028,1101) & nested LUT Descriptor (0028,3002) with unsigned #1/#3 & signed #2
  const itemInherit = implicitItem(implicitU16(0x0028, 0x3002, [0x9c40, 0xffff, 0x0010]));
  const itemOverrideUnsigned = implicitItem(
    Buffer.concat([implicitU16(0x0028, 0x0103, [0]), implicitU16(0x0028, 0x0120, [0xfc00])])
  );
  const signedBytes = Buffer.concat([
    fileMeta('1.2.840.10008.1.2'),
    implicitU16(0x0018, 0x9810, [-50]),
    implicitU16(0x0028, 0x0103, [1]),
    implicitU16(0x0028, 0x0120, [-1024]),
    implicitU16(0x0028, 0x0121, [-100]),
    implicitU16(0x0028, 0x1101, [0x9c40, 0xffff, 0x0010]),
    implicitSq(0x0028, 0x3010, [itemInherit, itemOverrideUnsigned]),
  ]);

  const doc = await parse(signedBytes);
  const zeroVel = doc.datasetNodes.find((n) => n.tag === '00189810');
  const padVal = doc.datasetNodes.find((n) => n.tag === '00280120');
  const padLimit = doc.datasetNodes.find((n) => n.tag === '00280121');
  const redLutDesc = doc.datasetNodes.find((n) => n.tag === '00281101');
  const lutSq = doc.datasetNodes.find((n) => n.tag === '00283010');
  const nestedLutDesc = lutSq.items[0].children.find((n) => n.tag === '00283002');
  const nestedUnsignedPad = lutSq.items[1].children.find((n) => n.tag === '00280120');

  assert.equal(zeroVel.vr, 'SS');
  assert.equal(zeroVel.value, '-50');
  assert.equal(padVal.vr, 'SS');
  assert.equal(padVal.value, '-1024');
  assert.equal(padLimit.vr, 'SS');
  assert.equal(padLimit.value, '-100');
  assert.equal(redLutDesc.vr, 'SS');
  assert.equal(redLutDesc.value, '40000\\-1\\16');
  assert.equal(redLutDesc.validation.valid, true);
  assert.equal(nestedLutDesc.vr, 'SS');
  assert.equal(nestedLutDesc.value, '40000\\-1\\16');
  assert.equal(nestedLutDesc.validation.valid, true);
  assert.equal(nestedUnsignedPad.vr, 'US');
  assert.equal(nestedUnsignedPad.value, '64512');

  // Validation enforces unsigned #1/#3 and signed #2 for signed LUT Descriptors
  assert.equal(validateVrValue('SS', '40000\\-1\\16', '00283002').valid, true);
  assert.equal(validateVrValue('SS', '-1\\-1\\16', '00283002').valid, false);
  assert.equal(validateVrValue('SS', '40000\\40000\\16', '00283002').valid, false);

  const json = JSON.parse(formatDicomJson(doc));
  assert.equal(json.dataset['00280120'].vr, 'SS');
  assert.deepEqual(json.dataset['00280120'].Value, ['-1024']);
  assert.deepEqual(json.dataset['00281101'].Value, ['40000', '-1', '16']);
  assert.deepEqual(json.dataset['00283010'].Value[0]['00283002'].Value, ['40000', '-1', '16']);

  // Edit & round-trip save preserves unsigned #1/#3 (no 32767 clamp) and signed #2
  const store = new AppStore();
  store.loadDocument(doc);
  store.updateNodeValue(padVal.id, '-2048');
  store.updateNodeValue(nestedLutDesc.id, '40000\\-2\\16');
  store.updateNodeValue(redLutDesc.id, '40000\\-3\\16');
  assert.equal(padVal.validation.valid, true);
  assert.equal(nestedLutDesc.validation.valid, true);
  assert.equal(redLutDesc.validation.valid, true);
  const reopened = await parse(await writeDicomDocument(doc));
  assert.equal(reopened.datasetNodes.find((n) => n.tag === '00280120').vr, 'SS');
  assert.equal(reopened.datasetNodes.find((n) => n.tag === '00280120').value, '-2048');
  assert.equal(reopened.datasetNodes.find((n) => n.tag === '00281101').value, '40000\\-3\\16');
  assert.equal(
    reopened.datasetNodes.find((n) => n.tag === '00283010').items[0].children.find((n) => n.tag === '00283002').value,
    '40000\\-2\\16'
  );

  // Explicit VR keeps encoded US on (0028,0120) and applies PS3.3 C.11.1 on explicit SS (0028,3002)
  const explicitDocBytes = Buffer.concat([
    fileMeta(explicitLittleEndian),
    hex('28 00 03 01 55 53 02 00 01 00'), // (0028,0103) US 1
    hex('28 00 20 01 55 53 02 00 00 fc'), // (0028,0120) US 64512
    hex('28 00 02 30 53 53 06 00 40 9c ff ff 10 00'), // (0028,3002) SS 40000\-1\16
  ]);
  const expDoc = await parse(explicitDocBytes);
  assert.equal(expDoc.datasetNodes.find((n) => n.tag === '00280120').vr, 'US');
  assert.equal(expDoc.datasetNodes.find((n) => n.tag === '00280120').value, '64512');
  assert.equal(expDoc.datasetNodes.find((n) => n.tag === '00283002').vr, 'SS');
  assert.equal(expDoc.datasetNodes.find((n) => n.tag === '00283002').value, '40000\\-1\\16');
});

test('AppStore handles compare exit transitions, async switch races, and corrupt-only cleanup cleanly', async () => {
  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');
  const c = await parseDicomBuffer(bytes, 'c.dcm');

  const store = new AppStore();
  store.loadDocument(a);
  store.loadDocument(b, null, { append: true });
  store.enterCompareMode();
  assert.equal(store.compareMode, true);

  // Appending a new document exits Compare mode
  store.loadDocument(c, null, { append: true });
  assert.equal(store.compareMode, false);
  assert.equal(store.doc, c);

  // Switching to the already-active file while in Compare exits Compare mode
  store.enterCompareMode();
  await store.switchToFile(store.activeFileId);
  assert.equal(store.compareMode, false);

  // Replacing workspace (append: false) clears Compare mode & bumps workspaceVersion
  store.enterCompareMode();
  const prevWsVer = store.workspaceVersion;
  store.loadDocument(await parseDicomBuffer(bytes, 'fresh.dcm'), null, { append: false });
  assert.equal(store.compareMode, false);
  assert.equal(store.compareFileAId, null);
  assert.equal(store.compareFileBId, null);
  assert.ok(store.workspaceVersion > prevWsVer);

  // Async race: slow switch closed mid-flight must not reactivate, and fast re-switch must win
  const raceStore = new AppStore();
  let resolveSlow;
  const slowSource = {
    size: bytes.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveSlow = () => r(bytes.slice(0)); }),
  };
  await raceStore.loadFileItems([
    { name: 'first.dcm', arrayBuffer: bytes.slice(0) },
    { name: 'slow.dcm', size: bytes.byteLength, sourceFile: slowSource },
    { name: 'fast.dcm', arrayBuffer: bytes.slice(0) },
  ]);
  const [firstId, slowId, fastId] = raceStore.files.map((f) => f.id);
  const slowSwitch = raceStore.switchToFile(slowId);
  await raceStore.switchToFile(fastId);
  assert.equal(raceStore.activeFileId, fastId);
  resolveSlow();
  await slowSwitch;
  assert.equal(raceStore.activeFileId, fastId);

  // Closing an entry while switching to it must not resurrect it
  const raceStore2 = new AppStore();
  let resolveSlow2;
  const slowSource2 = {
    size: bytes.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveSlow2 = () => r(bytes.slice(0)); }),
  };
  await raceStore2.loadFileItems([
    { name: 'keep.dcm', arrayBuffer: bytes.slice(0) },
    { name: 'closing.dcm', size: bytes.byteLength, sourceFile: slowSource2 },
  ]);
  const [keepId, closingId] = raceStore2.files.map((f) => f.id);
  const pCloseRace = raceStore2.switchToFile(closingId);
  await raceStore2.removeFile(closingId);
  resolveSlow2();
  await pCloseRace;
  assert.equal(raceStore2.activeFileId, keepId);
  assert.equal(raceStore2.files.length, 1);

  // Closing the only valid file when only a corrupt entry remains resets cleanly to empty workspace
  const badStore = new AppStore();
  const corruptBuf = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).buffer;
  await badStore.loadFileItems([
    { name: 'good.dcm', arrayBuffer: bytes.slice(0) },
    { name: 'corrupt.dcm', arrayBuffer: corruptBuf },
  ]);
  assert.equal(badStore.files.length, 2);
  await badStore.removeFile(badStore.files[0].id);
  assert.equal(badStore.files.length, 0);
  assert.equal(badStore.doc, null);
  assert.equal(badStore.activeFileId, null);
  assert.equal(badStore.compareMode, false);

  // Stale slow corrupt load on empty workspace must NOT wipe a synchronously loaded newer document Y
  const staleFailStore = new AppStore();
  let resolveCorruptX;
  const slowCorruptX = {
    size: corruptBuf.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveCorruptX = () => r(corruptBuf.slice(0)); }),
  };
  const pendingCorrupt = staleFailStore.loadFileItems([{ name: 'slow_bad.dcm', size: corruptBuf.byteLength, sourceFile: slowCorruptX }]);
  const docY = await parseDicomBuffer(bytes, 'y.dcm');
  staleFailStore.loadDocument(docY);
  resolveCorruptX();
  await assert.rejects(pendingCorrupt, (err) => err?.stale === true);
  assert.equal(staleFailStore.doc, docY);
  assert.equal(staleFailStore.files.length, 1);
  assert.equal(staleFailStore.files[0].doc, docY);

  // Stale appended valid load that remains in workspace emits 'files' so tabs/list stay synced
  const staleEmitStore = new AppStore();
  await staleEmitStore.loadFileItems([
    { name: 'base.dcm', arrayBuffer: bytes.slice(0) },
    { name: 'other_base.dcm', arrayBuffer: bytes.slice(0) },
  ]);
  const [, otherBaseId] = staleEmitStore.files.map((f) => f.id);
  let resolveAppended;
  const slowAppended = {
    size: bytes.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveAppended = () => r(bytes.slice(0)); }),
  };
  const emittedReasons = [];
  staleEmitStore.subscribe((reason) => emittedReasons.push(reason));
  const pendingAppend = staleEmitStore.loadFileItems(
    [{ name: 'late_valid.dcm', size: bytes.byteLength, sourceFile: slowAppended }],
    { append: true }
  );
  await staleEmitStore.switchToFile(otherBaseId);
  emittedReasons.length = 0;
  resolveAppended();
  const lateRes = await pendingAppend;
  assert.equal(lateRes.stale, true);
  assert.equal(staleEmitStore.files.length, 3);
  assert.equal(staleEmitStore.activeFileId, otherBaseId);
  assert.ok(emittedReasons.includes('files'));

  // Stale slow duplicate check must NOT switch away from a newer active file
  const staleDupStore = new AppStore();
  const fileA = new File([bytes], 'dup.dcm');
  const fileB = new File([bytes], 'other.dcm');
  await staleDupStore.loadFileItems([{ name: 'dup.dcm', size: fileA.size, sourceFile: fileA }]);
  await staleDupStore.loadFileItems([{ name: 'other.dcm', size: fileB.size, sourceFile: fileB }]);
  const [dupAId, otherBId] = staleDupStore.files.map((f) => f.id);
  let resolveDupSlice;
  const slowDupSource = {
    size: fileA.size,
    slice: () => ({ arrayBuffer: () => new Promise((r) => { resolveDupSlice = () => r(bytes.slice(0)); }) }),
  };
  const pendingDup = staleDupStore.loadFileItems([{ name: 'dup.dcm', size: fileA.size, sourceFile: slowDupSource }]);
  await staleDupStore.switchToFile(otherBId);
  resolveDupSlice();
  const dupRes = await pendingDup;
  assert.equal(dupRes.stale, true);
  assert.equal(staleDupStore.activeFileId, otherBId);
  assert.notEqual(staleDupStore.activeFileId, dupAId);

  // Symmetric recovery: slow valid A on empty workspace -> append corrupt B fails -> A finishes and recovers cleanly
  const recoverStore = new AppStore();
  let resolveSlowA;
  const slowValidA = {
    size: bytes.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveSlowA = () => r(bytes.slice(0)); }),
  };
  const pendingA = recoverStore.loadFileItems([{ name: 'slow_valid_a.dcm', size: bytes.byteLength, sourceFile: slowValidA }]);
  await assert.rejects(
    recoverStore.loadFileItems([{ name: 'bad_b.dcm', arrayBuffer: corruptBuf.slice(0) }], { append: true })
  );
  assert.equal(recoverStore.files.length, 1);
  assert.equal(recoverStore.doc, null);
  resolveSlowA();
  const resA = await pendingA;
  assert.equal(Boolean(resA.stale), false);
  assert.equal(recoverStore.files.length, 1);
  assert.equal(recoverStore.doc?.fileName, 'slow_valid_a.dcm');
  assert.equal(recoverStore.activeFileId, recoverStore.files[0].id);

  // Negative guard: recovery MUST NOT fire after closeAll() (new workspaceVersion) or when another doc is already active
  const noRecoverStore = new AppStore();
  let resolveClosedA;
  const slowClosedA = {
    size: bytes.byteLength,
    arrayBuffer: () => new Promise((r) => { resolveClosedA = () => r(bytes.slice(0)); }),
  };
  const pendingClosedA = noRecoverStore.loadFileItems([{ name: 'closed_a.dcm', size: bytes.byteLength, sourceFile: slowClosedA }]);
  noRecoverStore.closeAll();
  resolveClosedA();
  const closedRes = await pendingClosedA;
  assert.equal(closedRes.stale, true);
  assert.equal(noRecoverStore.files.length, 0);
  assert.equal(noRecoverStore.doc, null);
});

test('buildCompareRows detects binary VR differences and preserves SQ parent context under diffOnly', async () => {
  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');

  // Same rawBytes on (0009,1002), different binary VR (OB vs OW)
  const privB = b.datasetNodes.find((n) => n.tag === '00091002');
  privB.vr = 'OW';

  // Different nested leaf inside (0008,1115) -> (0008,114A) -> (0008,1155) with same SQ item counts
  const leafB = b.datasetNodes
    .find((n) => n.tag === '00081115').items[0].children
    .find((n) => n.tag === '0008114A').items[0].children
    .find((n) => n.tag === '00081155');
  leafB.value = '2.25.999999999';

  const res = buildCompareRows(a, b, { diffOnly: true });
  assert.equal(res.diffs, 2);
  assert.equal(res.changed, 2);
  assert.ok(res.rows.some((r) => r.a?.tag === '(0009,1002)' && r.kind === 'changed'));

  const sqParentIdx = res.rows.findIndex((r) => r.a?.tag === '(0008,1115)');
  const sqChildIdx = res.rows.findIndex((r) => r.a?.tag === '(0008,114A)');
  const leafIdx = res.rows.findIndex((r) => r.a?.tag === '(0008,1155)');
  assert.ok(sqParentIdx >= 0 && res.rows[sqParentIdx].isContext === true);
  assert.equal(sqChildIdx, sqParentIdx + 1);
  assert.equal(res.rows[sqChildIdx].isContext, true);
  assert.equal(leafIdx, sqChildIdx + 1);
  assert.equal(res.rows[leafIdx].kind, 'changed');
});

test('AppStore viewMode switches Tree/Raw/Compare cleanly and RawView locates serialized Hex landmarks', async () => {
  const sampleBytes = new Uint8Array(await generateSampleDicomBuffer());
  const a = await parseDicomBuffer(sampleBytes.buffer, 'a.dcm');
  const b = await parseDicomBuffer(sampleBytes.buffer, 'b.dcm');
  const store = new AppStore();

  store.loadDocument(a);
  assert.equal(store.viewMode, 'tree');
  store.setViewMode('raw');
  assert.equal(store.viewMode, 'raw');
  assert.equal(store.compareMode, false);

  // Appending and switching tabs preserves Raw mode while Compare exits on tab switch
  store.loadDocument(b, null, { append: true });
  assert.equal(store.viewMode, 'raw');
  await store.switchToFile(store.files[0].id);
  assert.equal(store.viewMode, 'raw');

  store.setViewMode('compare');
  assert.equal(store.viewMode, 'compare');
  assert.equal(store.compareMode, true);
  await store.switchToFile(store.files[1].id);
  assert.equal(store.viewMode, 'tree');
  assert.equal(store.compareMode, false);

  // Serialized Hex landmarks & formatting on sample Part 10 DICOM
  const serialized = await writeDicomDocument(a);
  const landmarks = findSerializedLandmarks(serialized, a);
  assert.equal(landmarks.preambleOffset, 0);
  assert.equal(landmarks.dicmOffset, 128);
  assert.ok(landmarks.mainOffset > 144);
  assert.ok(landmarks.pixelOffset !== null && landmarks.pixelOffset > landmarks.mainOffset);
  assert.equal(serialized[landmarks.pixelOffset], 0xe0);
  assert.equal(serialized[landmarks.pixelOffset + 1], 0x7f);
  assert.equal(serialized[landmarks.pixelOffset + 2], 0x10);
  assert.equal(serialized[landmarks.pixelOffset + 3], 0x00);

  const slice = formatHexSlice(serialized, 128, 32);
  assert.equal(slice.startOffset, 128);
  assert.equal(slice.lines.length, 2);
  assert.ok(slice.lines[0].text.startsWith('00000080  44 49 43 4D'));
  assert.ok(slice.lines[0].text.includes('|DICM'));

  // Configurable bytes-per-row (8 / 24 / 32 / 64) & column ruler alignment
  const slice32 = formatHexSlice(serialized, 128, 64, 32);
  assert.equal(slice32.lines.length, 2);
  assert.equal(slice32.lines[0].offset, 128);
  assert.equal(slice32.lines[1].offset, 160);
  const slice8 = formatHexSlice(serialized, 128, 16, 8);
  assert.equal(slice8.lines.length, 2);
  assert.equal(slice8.lines[1].offset, 136);
  const ruler32 = formatHexRuler(32);
  assert.ok(ruler32.includes('00 01 02 03 04 05 06 07') && ruler32.includes('18 19 1A 1B 1C 1D 1E 1F'));

  // Unique relative path sanitization for batch folder export
  const used = new Set();
  assert.equal(buildUniqueRelativePath('../study\\img:01.dcm', used), 'study/img_01.dcm');
  assert.equal(buildUniqueRelativePath('study/IMG_01.dcm', used), 'study/IMG_01_2.dcm');
  assert.equal(buildUniqueRelativePath('', used), 'file.dcm');
});

test('Audit regressions: binary numeric encoding, Group 0002 placement guards, Compare auto-swap, sidebar flag reset & ZIP dotted folders', async () => {
  // 1) encodeBinaryNumeric matches actual DICOM binary encoding (US/AT)
  const usBytes = encodeBinaryNumeric('512', 'US', true);
  assert.deepEqual(Array.from(usBytes), [0x00, 0x02]);
  const atBytes = encodeBinaryNumeric('(0010,0020)', 'AT', true);
  assert.deepEqual(Array.from(atBytes), [0x10, 0x00, 0x20, 0x00]);

  // 2) Group 0002 placement guards: blocked in SQ item and on raw non-Part-10 DICOM
  const sampleBytes = new Uint8Array(await generateSampleDicomBuffer());
  const part10Doc = await parseDicomBuffer(sampleBytes.buffer, 'part10.dcm');
  const rawDoc = await parse(hex(
    '10 00 10 00 50 4e 04 00 54 45 53 54' + // (0010,0010) PN "TEST"
    '28 00 10 00 55 53 02 00 04 00'        // (0028,0010) US 4
  ));
  assert.equal(rawDoc.hasPart10Header, false);

  const store = new AppStore();
  store.loadDocument(rawDoc);
  const rawMetaRes = store.addTag({ group: 0x0002, element: 0x0016, vr: 'AE', value: 'PACS' });
  assert.equal(rawMetaRes?.invalidLocation, 'metaTagNoPart10Err');
  assert.equal(countDocChanges(rawDoc), 0);

  store.loadDocument(part10Doc, null, { append: true });
  const seqNode = part10Doc.datasetNodes.find((n) => n.tag === '00081115');
  assert.ok(seqNode?.isSequence && seqNode.items.length > 0);
  const seqItem = seqNode.items[0];
  const prevChildCount = seqItem.children.length;
  const sqMetaRes = store.addTag({
    group: 0x0002,
    element: 0x0016,
    vr: 'AE',
    value: 'PACS',
    targetList: seqItem.children,
    targetSection: 'main',
  });
  assert.equal(sqMetaRes?.invalidLocation, 'metaTagInSequenceErr');
  assert.equal(seqItem.children.length, prevChildCount);

  // Batch edit for Group 0002 applies only to Part 10 docs and skips raw non-Part-10 docs
  const batchMeta = await store.batchEditAcrossFiles({
    group: 0x0002,
    element: 0x0016,
    vr: 'AE',
    value: 'BATCH_AE',
    mode: 'set',
  });
  assert.equal(batchMeta.affectedFiles, 1);
  assert.equal(rawDoc.metaNodes.length, 0);
  assert.ok(part10Doc.metaNodes.some((n) => n.tag === '00020016' && n.value === 'BATCH_AE'));

  // 3) Compare mode auto-swaps A and B when selecting the opposite side's file
  const idA = store.files[0].id;
  const idB = store.files[1].id;
  store.enterCompareMode(idA, idB);
  assert.equal(store.compareFileAId, idA);
  assert.equal(store.compareFileBId, idB);
  store.setCompareFiles(idB, idB); // selecting B into slot A swaps A into slot B
  assert.equal(store.compareFileAId, idB);
  assert.equal(store.compareFileBId, idA);

  // 4) Closing down to 1 file resets _userToggledFileList so reopening multiple files shows sidebar again
  store.toggleFileList();
  assert.equal(store._userToggledFileList, true);
  await store.removeFile(idB);
  assert.equal(store.files.length, 1);
  assert.equal(store._userToggledFileList, false);
  const part10Doc2 = await parseDicomBuffer(sampleBytes.buffer, 'part10_2.dcm');
  store.loadDocument(part10Doc2, null, { append: true });
  assert.equal(store.showFileList, true);

  // 5) buildZipArchive keeps dotted directory names intact when deduplicating extensionless files
  const zipBytes = buildZipArchive([
    { name: 'study.1/IM0001', data: new Uint8Array([1, 2, 3]) },
    { name: 'study.1/IM0001', data: new Uint8Array([4, 5, 6]) },
  ]);
  const zipAscii = Buffer.from(zipBytes).toString('latin1');
  assert.ok(zipAscii.includes('study.1/IM0001_2'));
  assert.ok(!zipAscii.includes('study_2.1/IM0001'));
});

test('SR parser decodes CONTAINER/TEXT/CODE/NUM/PNAME/IMAGE/SCOORD and AppStore manages SR view mode', async () => {
  const mkNode = (tag, vr, value, opts = {}) => ({
    id: `sr_${tag}_${Math.random().toString(36).slice(2, 7)}`,
    tag,
    formattedTag: `(${tag.slice(0, 4)},${tag.slice(4, 8)})`,
    vr,
    value,
    isSequence: Boolean(opts.isSequence),
    isBinary: Boolean(opts.isBinary),
    items: opts.items || [],
    status: 'unchanged',
  });
  const mkItem = (children) => ({ id: `item_${Math.random().toString(36).slice(2, 7)}`, children });
  const codeSeq = (tag, value, scheme, meaning) =>
    mkNode(tag, 'SQ', '', {
      isSequence: true,
      items: [mkItem([
        mkNode('00080100', 'SH', value),
        mkNode('00080102', 'SH', scheme),
        mkNode('00080104', 'LO', meaning),
      ])],
    });

  const srDoc = {
    fileName: 'report_sr.dcm',
    hasPart10Header: true,
    metaNodes: [
      mkNode('00020002', 'UI', '1.2.840.10008.5.1.4.1.1.88.22'),
      mkNode('00020003', 'UI', '2.25.8801'),
      mkNode('00020010', 'UI', explicitLittleEndian),
    ],
    datasetNodes: [
      mkNode('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.88.22'),
      mkNode('00080018', 'UI', '2.25.8801'),
      mkNode('00080023', 'DA', '20261125'),
      mkNode('00080033', 'TM', '101500'),
      mkNode('00080060', 'CS', 'SR'),
      mkNode('00100010', 'PN', 'DOE^JANE'),
      mkNode('00100020', 'LO', 'SR-001'),
      mkNode('0020000D', 'UI', '2.25.8800'),
      mkNode('0020000E', 'UI', '2.25.8800.1'),
      mkNode('0040A491', 'CS', 'COMPLETE'),
      mkNode('0040A493', 'CS', 'VERIFIED'),
      codeSeq('0040A043', '18748-4', 'LN', 'Diagnostic Imaging Report'),
      mkNode('0040A730', 'SQ', '', {
        isSequence: true,
        items: [
          mkItem([
            mkNode('0040A010', 'CS', 'CONTAINS'),
            mkNode('0040A040', 'CS', 'CONTAINER'),
            codeSeq('0040A043', '121070', 'DCM', 'Findings'),
            mkNode('0040A730', 'SQ', '', {
              isSequence: true,
              items: [
                mkItem([
                  mkNode('0040A010', 'CS', 'CONTAINS'),
                  mkNode('0040A040', 'CS', 'TEXT'),
                  codeSeq('0040A043', '121071', 'DCM', 'Finding'),
                  mkNode('0040A160', 'UT', 'No acute intracranial hemorrhage.'),
                ]),
                mkItem([
                  mkNode('0040A010', 'CS', 'CONTAINS'),
                  mkNode('0040A040', 'CS', 'CODE'),
                  codeSeq('0040A043', 'G-C171', 'SRT', 'Laterality'),
                  codeSeq('0040A168', 'G-A100', 'SRT', 'Right'),
                ]),
                mkItem([
                  mkNode('0040A010', 'CS', 'CONTAINS'),
                  mkNode('0040A040', 'CS', 'NUM'),
                  codeSeq('0040A043', '410668003', 'SCT', 'Diameter'),
                  mkNode('0040A300', 'SQ', '', {
                    isSequence: true,
                    items: [mkItem([
                      mkNode('0040A30A', 'DS', '14.5'),
                      codeSeq('004008EA', 'mm', 'UCUM', 'millimeter'),
                    ])],
                  }),
                ]),
                mkItem([
                  mkNode('0040A010', 'CS', 'HAS OBS CONTEXT'),
                  mkNode('0040A040', 'CS', 'PNAME'),
                  codeSeq('0040A043', '121008', 'DCM', 'Person Observer Name'),
                  mkNode('0040A123', 'PN', 'KIM^MIN'),
                ]),
                mkItem([
                  mkNode('0040A010', 'CS', 'INFERRED FROM'),
                  mkNode('0040A040', 'CS', 'IMAGE'),
                  mkNode('00081199', 'SQ', '', {
                    isSequence: true,
                    items: [mkItem([
                      mkNode('00081150', 'UI', '1.2.840.10008.5.1.4.1.1.2'),
                      mkNode('00081155', 'UI', '2.25.99999'),
                    ])],
                  }),
                ]),
                mkItem([
                  mkNode('0040A010', 'CS', 'INFERRED FROM'),
                  mkNode('0040A040', 'CS', 'SCOORD'),
                  mkNode('00700023', 'CS', 'POLYLINE'),
                  mkNode('00700022', 'FL', '10\\20\\30\\40'),
                ]),
              ],
            }),
          ]),
        ],
      }),
    ],
  };

  assert.equal(isSrDocument(srDoc), true);
  const parsedSr = extractSrDocument(srDoc);
  assert.equal(parsedSr.title, 'Diagnostic Imaging Report');
  assert.equal(parsedSr.completionFlag, 'COMPLETE');
  assert.equal(parsedSr.verificationFlag, 'VERIFIED');
  assert.equal(parsedSr.totalCount, 7);

  const children = parsedSr.items[0].children;
  assert.equal(children[0].valueText, 'No acute intracranial hemorrhage.');
  assert.equal(children[1].valueText, 'Right');
  assert.equal(children[2].valueText, '14.5 mm');
  assert.equal(children[3].valueText, 'KIM^MIN');
  assert.equal(children[4].valueText, '2.25.99999');
  assert.equal(children[5].valueText, 'POLYLINE');
  assert.equal(children[5].valueDetail, '2 pt(s) [10.0, 20.0, 30.0, 40.0]');

  const md = formatSrMarkdown(parsedSr, srDoc.fileName);
  assert.ok(md.includes('# Diagnostic Imaging Report'));
  assert.ok(md.includes('14.5 mm'));
  assert.ok(md.includes('No acute intracranial hemorrhage.'));

  // Store SR view mode switches on SR doc and falls back to Tree on non-SR CT doc
  const ctDoc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'ct.dcm');
  assert.equal(isSrDocument(ctDoc), false);
  const store = new AppStore();
  store.loadDocument(srDoc);
  store.setViewMode('sr');
  assert.equal(store.viewMode, 'sr');
  store.loadDocument(ctDoc, null, { append: true });
  assert.equal(store.viewMode, 'tree');
  await store.switchToFile(store.files[0].id);
  store.setViewMode('sr');
  assert.equal(store.viewMode, 'sr');
  await store.switchToFile(store.files[1].id);
  assert.equal(store.viewMode, 'tree');
});

test('PHI spec, Date Shifting, upgraded Anonymizer, QA check, and transparent .dcm.gz open work end-to-end', async () => {
  // 1) Date shifting & PHI tag metadata
  assert.equal(shiftDicomDateValue('20261125', 'DA', -365), '20251125');
  assert.equal(shiftDicomDateValue('20240229', 'DA', 1), '20240301');
  assert.equal(shiftDicomDateValue('20261125103000.123+0900', 'DT', -10), '20261115103000.123+0900');
  assert.equal(shiftDicomDateValue('20260101\\20260110', 'DA', 5), '20260106\\20260115');
  assert.equal(getPhiTagInfo('00100010')?.action, 'Z');
  assert.equal(isPhiNode({ tag: '00100020', isSequence: false }), true);
  assert.equal(isPhiNode({ tag: '00280010', isSequence: false }), false);

  // 2) Transparent .dcm.gz decompression + fileHandle cleared on gzipped source
  const sampleBuf = await generateSampleDicomBuffer();
  const gzBytes = gzipSync(Buffer.from(sampleBuf));
  const gzDoc = await parseDicomBuffer(gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength), 'brain_ct.dcm.gz');
  assert.equal(gzDoc.wasGzipped, true);
  assert.equal(gzDoc.fileName, 'brain_ct.dcm');
  assert.equal(gzDoc.datasetNodes.find((n) => n.tag === '00080060')?.value, 'CT');

  const gzStore = new AppStore();
  await gzStore.loadFileItems([{
    name: 'brain_ct.dcm.gz',
    size: gzBytes.byteLength,
    arrayBuffer: gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength),
    fileHandle: { kind: 'file', name: 'brain_ct.dcm.gz' },
  }]);
  assert.equal(gzStore.files[0].fileHandle, null);

  // 3) QA conformance checker: clean sample has 0 errors / 0 warnings / phiCount > 0
  const cleanDoc = await parseDicomBuffer(sampleBuf, 'clean.dcm');
  const cleanQa = runDicomQaCheck(cleanDoc);
  assert.equal(cleanQa.errors.length, 0);
  assert.equal(cleanQa.warnings.length, 0);
  assert.ok(cleanQa.phiCount > 0);

  // Introducing VR error & Meta/Main UID mismatch triggers deterministic QA errors
  const store = new AppStore();
  store.loadDocument(cleanDoc);
  const studyDate = cleanDoc.datasetNodes.find((n) => n.tag === '00080020');
  const origDate = studyDate.value;
  store.updateNodeValue(studyDate.id, 'NOT_A_DATE');
  cleanDoc.metaNodes.find((n) => n.tag === '00020003').value = '2.25.0000';
  const badQa = runDicomQaCheck(cleanDoc);
  assert.ok(badQa.errors.some((e) => e.code === 'qaVrError'));
  assert.ok(badQa.errors.some((e) => e.code === 'qaMetaSopInstMismatch'));
  store.undo();
  cleanDoc.metaNodes.find((n) => n.tag === '00020003').value = cleanDoc.datasetNodes.find((n) => n.tag === '00080018').value;

  // 4) Anonymize preview + Date Shifting + (0012,0063) DeidentificationMethod + full Undo
  const preview = store.previewAnonymization(ANONYMIZE_PRESET_TAGS.slice(0, 3), {
    markDeidentified: true,
    methodText: 'Basic Application Level Confidentiality Profile',
    shiftDates: true,
    dateShiftDays: -365,
    stripPrivate: true,
    regenerateUids: true,
  });
  assert.ok(preview.tagChanges > 0);
  assert.ok(preview.dateShifts > 0);
  assert.ok(preview.privateDeletes > 0);
  assert.ok(preview.uidChanges > 0);

  const count = store.applyAnonymization(ANONYMIZE_PRESET_TAGS.slice(0, 3), {
    markDeidentified: true,
    methodText: 'Basic Application Level Confidentiality Profile',
    shiftDates: true,
    dateShiftDays: -365,
  });
  assert.ok(count > 0);
  assert.equal(studyDate.value, shiftDicomDateValue(origDate, 'DA', -365));
  assert.equal(cleanDoc.datasetNodes.find((n) => n.tag === '00120062')?.value, 'YES');
  assert.equal(
    cleanDoc.datasetNodes.find((n) => n.tag === '00120063')?.value,
    'Basic Application Level Confidentiality Profile'
  );

  store.undo();
  assert.equal(studyDate.value, origDate);
  assert.equal(cleanDoc.datasetNodes.find((n) => n.tag === '00120062'), undefined);
  assert.equal(cleanDoc.datasetNodes.find((n) => n.tag === '00120063'), undefined);
});

test('Post-feature audit fixes: .dcm.gz markSaved handle retention, SR viewMode reconcile, QA empty-pixel/DICOMDIR/VerificationFlag', async () => {
  const sampleBuf = await generateSampleDicomBuffer();
  const gzBytes = gzipSync(Buffer.from(sampleBuf));
  const gzArrBuf = gzBytes.buffer.slice(gzBytes.byteOffset, gzBytes.byteOffset + gzBytes.byteLength);

  // 1) Inactive .dcm.gz clears fileHandle on lazy parse, and markSaved clears wasGzipped so new handle survives tab switch
  const store = new AppStore();
  await store.loadFileItems([
    { name: 'plain.dcm', size: sampleBuf.byteLength, arrayBuffer: sampleBuf.slice(0) },
    { name: 'lazy.dcm.gz', size: gzBytes.byteLength, arrayBuffer: gzArrBuf, fileHandle: { name: 'lazy.dcm.gz' } },
  ]);
  const [plainEntry, gzEntry] = store.files;
  await store.ensureEntryParsed(gzEntry);
  assert.equal(gzEntry.fileHandle, null);
  assert.equal(gzEntry.doc.wasGzipped, true);

  await store.switchToFile(gzEntry.id);
  const newHandle = { name: 'saved_plain.dcm' };
  store.markSaved(gzEntry.doc, store.getDocumentRevision(gzEntry.doc), {
    handle: newHandle,
    name: 'saved_plain.dcm',
    size: sampleBuf.byteLength,
  });
  assert.equal(gzEntry.doc.wasGzipped, false);
  await store.switchToFile(plainEntry.id);
  await store.switchToFile(gzEntry.id);
  assert.equal(store.fileHandle, newHandle);

  // 2) Removing SR markers while in 'sr' viewMode reconciles viewMode back to 'tree'
  const mkNode = (tag, vr, value, opts = {}) => ({
    id: `aud_${tag}_${Math.random().toString(36).slice(2, 7)}`,
    tag,
    formattedTag: `(${tag.slice(0, 4)},${tag.slice(4, 8)})`,
    vr,
    value,
    originalValue: value,
    isSequence: Boolean(opts.isSequence),
    isBinary: Boolean(opts.isBinary),
    items: opts.items || [],
    status: 'unchanged',
  });
  const srDoc = {
    fileName: 'mini_sr.dcm',
    hasPart10Header: true,
    metaNodes: [mkNode('00020010', 'UI', explicitLittleEndian)],
    datasetNodes: [
      mkNode('00080060', 'CS', 'SR'),
      mkNode('0040A493', 'CS', 'BOGUS_FLAG'),
    ],
  };
  const srStore = new AppStore();
  srStore.loadDocument(srDoc);
  srStore.setViewMode('sr');
  assert.equal(srStore.viewMode, 'sr');
  srStore.updateNodeValue(srDoc.datasetNodes[0].id, 'OT');
  assert.equal(srStore.viewMode, 'tree');

  // 3) QA checker flags invalid VerificationFlag, avoids Number('')===0 false positives on missing pixel tags, and skips DICOMDIR
  srDoc.datasetNodes[0].value = 'SR';
  const srQa = runDicomQaCheck(srDoc);
  assert.ok(srQa.warnings.some((w) => w.code === 'qaSrFlagInvalid' && w.tag === '(0040,A493)'));

  const missingBitsDoc = {
    hasPart10Header: false,
    metaNodes: [],
    datasetNodes: [
      mkNode('00080016', 'UI', '1.2.840.10008.5.1.4.1.1.2'),
      mkNode('00080018', 'UI', '2.25.1'),
      mkNode('0020000D', 'UI', '2.25.2'),
      mkNode('0020000E', 'UI', '2.25.3'),
      mkNode('00080060', 'CS', 'CT'),
      mkNode('00280010', 'US', '64'),
      mkNode('00280011', 'US', '64'),
      mkNode('7FE00010', 'OW', '[Binary]', { isBinary: true }),
    ],
  };
  const missingBitsQa = runDicomQaCheck(missingBitsDoc);
  assert.equal(missingBitsQa.errors.length, 0);

  const dicomDirDoc = {
    hasPart10Header: true,
    metaNodes: [
      mkNode('00020002', 'UI', '1.2.840.10008.1.3.10'),
      mkNode('00020010', 'UI', explicitLittleEndian),
    ],
    datasetNodes: [mkNode('00041220', 'SQ', '', { isSequence: true, items: [] })],
  };
  const dirQa = runDicomQaCheck(dicomDirDoc);
  assert.equal(dirQa.errors.length, 0);
  assert.equal(dirQa.warnings.length, 0);

  // 4) SR SCOORD handles non-numeric coordinate tokens without emitting NaN
  const nanSr = {
    fileName: 'coord.dcm',
    hasPart10Header: false,
    metaNodes: [],
    datasetNodes: [
      mkNode('00080060', 'CS', 'SR'),
      mkNode('0040A730', 'SQ', '', {
        isSequence: true,
        items: [{
          id: 'c_item',
          children: [
            mkNode('0040A040', 'CS', 'SCOORD'),
            mkNode('00700023', 'CS', 'POINT'),
            mkNode('00700022', 'FL', 'abc\\12.5'),
          ],
        }],
      }),
    ],
  };
  const parsedNan = extractSrDocument(nanSr);
  assert.equal(parsedNan.items[0].valueDetail.includes('NaN'), false);
  assert.ok(parsedNan.items[0].valueDetail.includes('abc, 12.5'));

  // 5) Compare multi-token search tracks hiddenEqualMatches when diffOnly hides matching identical tags
  const cmpA = await parseDicomBuffer(sampleBuf, 'cmp_a.dcm');
  const cmpB = await parseDicomBuffer(sampleBuf, 'cmp_b.dcm');
  const hiddenRes = buildCompareRows(cmpA, cmpB, { diffOnly: true, searchQuery: 'study uid' });
  assert.equal(hiddenRes.rows.length, 0);
  assert.equal(hiddenRes.hiddenEqualMatches, 1);
  const shownRes = buildCompareRows(cmpA, cmpB, { diffOnly: false, searchQuery: 'study uid' });
  assert.equal(shownRes.hiddenEqualMatches, 0);
  assert.equal(shownRes.rows.length, 1);
  assert.equal(shownRes.rows[0].a?.tag, '(0020,000D)');
  assert.equal(shownRes.rows[0].b?.tag, '(0020,000D)');

  // 6) Full-pane Pixel viewMode activates on PixelData docs, persists across CT slices, and falls back on non-pixel/deleted PixelData
  assert.equal(hasPixelData(cmpA), true);
  assert.equal(hasPixelData(srDoc), false);
  const pxStore = new AppStore();
  pxStore.loadDocument(cmpA);
  pxStore.loadDocument(cmpB, null, { append: true });
  pxStore.loadDocument(srDoc, null, { append: true });
  await pxStore.switchToFile(pxStore.files[0].id);
  pxStore.setViewMode('pixel');
  assert.equal(pxStore.viewMode, 'pixel');
  await pxStore.switchToFile(pxStore.files[1].id);
  assert.equal(pxStore.viewMode, 'pixel');
  await pxStore.switchToFile(pxStore.files[2].id);
  assert.equal(pxStore.viewMode, 'tree');
  await pxStore.switchToFile(pxStore.files[0].id);
  pxStore.setViewMode('pixel');
  const pxTag = cmpA.datasetNodes.find((n) => n.tag === '7FE00010');
  pxStore.toggleDeleteNode(pxTag.id);
  assert.equal(pxStore.viewMode, 'tree');
});
