import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDicomBuffer } from '../src/dicom/parser.js';
import { generateSampleDicomBuffer } from '../src/dicom/sampleGenerator.js';
import { writeDicomDocument } from '../src/dicom/writer.js';
import { AppStore, canEditNodeValue, countDocChanges } from '../src/state/store.js';
import { buildCompareRows } from '../src/ui/compareView.js';
import { PixelPanel } from '../src/ui/pixelPanel.js';
import { createFileIoController } from '../src/io/fileIo.js';
import { stripDicomBaseName } from '../src/utils/uiHelpers.js';
import { setLang, t } from '../src/i18n.js';

globalThis.localStorage = { getItem: () => null, setItem() {} };

const patientName = (doc) => doc.datasetNodes.find((n) => n.tag === '00100010');

test('markSaved preserves undo/redo history for edits, deletes, and added tags', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'sample.dcm');
  const store = new AppStore();
  store.loadDocument(doc);

  const pn = patientName(doc);
  const origPn = pn.value;
  store.updateNodeValue(pn.id, 'EDITED^ONE');
  store.toggleDeleteNode(doc.datasetNodes.find((n) => n.tag === '00104000').id);
  const addedRes = store.addTag({ group: 0x0010, element: 0x21b0, vr: 'LT', value: 'NOTE' });
  assert.equal(addedRes.duplicate, false);

  assert.equal(store.markSaved(doc, store.getDocumentRevision(doc)), true);
  assert.equal(countDocChanges(doc), 0);
  assert.equal(store.canUndo(), true);

  // Undo added tag -> marked deleted (file dirty again)
  store.undo();
  assert.equal(addedRes.node.status, 'deleted');
  assert.equal(countDocChanges(doc), 1);

  // Undo deleted tag -> re-inserted into datasetNodes as added
  store.undo();
  const restoredComment = doc.datasetNodes.find((n) => n.tag === '00104000');
  assert.ok(restoredComment);
  assert.equal(restoredComment.status, 'added');

  // Undo edited tag -> value reverted and marked modified against saved baseline
  store.undo();
  assert.equal(pn.value, origPn);
  assert.equal(pn.status, 'modified');

  // Redo all three -> back to clean saved state
  store.redo();
  store.redo();
  store.redo();
  assert.equal(pn.value, 'EDITED^ONE');
  assert.equal(doc.datasetNodes.find((n) => n.tag === '00104000'), undefined);
  assert.equal(addedRes.node.status, 'unchanged');
  assert.equal(countDocChanges(doc), 0);
});

test('undoing an added or cleared SOPInstanceUID restores read-only MediaStorageSOPInstanceUID', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'sop_undo.dcm');
  // Remove (0008,0018) before loading so we start with Part 10 (0002,0003) and absent (0008,0018)
  const metaSop = doc.metaNodes.find((n) => n.tag === '00020003');
  const origMetaUid = metaSop.value;
  doc.datasetNodes = doc.datasetNodes.filter((n) => n.tag !== '00080018');

  const store = new AppStore();
  store.loadDocument(doc);
  store.addTag({ group: 0x0008, element: 0x0018, vr: 'UI', value: '2.25.7777' });
  assert.equal(metaSop.value, '2.25.7777');
  assert.equal(metaSop.status, 'modified');

  store.undo();
  assert.equal(metaSop.value, origMetaUid);
  assert.equal(metaSop.status, 'unchanged');
  assert.equal(countDocChanges(doc), 0);
});

test('pending-delete Sequence blocks child edits/additions and excludes children from counts', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'del_sq.dcm');
  const store = new AppStore();
  store.loadDocument(doc);

  const sq = doc.datasetNodes.find((n) => n.tag === '00081115');
  const childSq = sq.items[0].children.find((n) => n.tag === '0008114A');
  const leaf = childSq.items[0].children.find((n) => n.tag === '00081155');
  const origLeaf = leaf.value;

  // Introduce a VR error on leaf, then mark parent SQ for deletion
  store.updateNodeValue(leaf.id, 'BAD_UID_CHARS!');
  assert.equal(store.getStatsAndDiff().invalid, 1);

  store.toggleDeleteNode(sq.id);
  assert.equal(sq.status, 'deleted');

  const leafInfo = store.findNodeInfo(leaf.id);
  assert.equal(leafInfo.ancestorDeleted, true);
  assert.equal(canEditNodeValue(leaf, leafInfo), false);
  assert.equal(store.updateNodeValue(leaf.id, '2.25.1'), false);
  assert.equal(leaf.value, 'BAD_UID_CHARS!');

  const addRes = store.addTag({
    group: 0x0010,
    element: 0x4000,
    vr: 'LT',
    value: 'blocked',
    targetList: sq.items[0].children,
    targetSection: 'main',
  });
  assert.equal(addRes.invalidLocation, 'deletedSeqEditErr');

  // Deleted SQ's children are excluded from change/invalid/diff counts
  assert.equal(countDocChanges(doc), 1);
  const stats = store.getStatsAndDiff();
  assert.equal(stats.invalid, 0);
  assert.equal(stats.diffs.length, 1);
  assert.equal(stats.diffs[0].node, sq);

  // Restoring SQ re-enables editing
  store.toggleDeleteNode(sq.id);
  assert.equal(store.findNodeInfo(leaf.id).ancestorDeleted, false);
  assert.equal(store.updateNodeValue(leaf.id, origLeaf), true);
});

test('undo coalescing merges rapid typing and default SQ expansion is capped', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'coalesce.dcm');
  // Add a large 60-item sequence to verify default expansion cap
  const bigItems = Array.from({ length: 60 }, (_, i) => ({ id: `big_item_${i}`, children: [] }));
  doc.datasetNodes.push({
    id: 'big_sq',
    group: 0x5200,
    element: 0x9230,
    tag: '52009230',
    formattedTag: '(5200,9230)',
    keyword: 'PerFrameFunctionalGroupsSequence',
    name: 'Per-Frame Functional Groups Sequence',
    vr: 'SQ',
    isSequence: true,
    isBinary: false,
    items: bigItems,
    status: 'unchanged',
    value: '',
    originalValue: '',
  });

  const store = new AppStore();
  store.loadDocument(doc);
  assert.equal(store.expandedIds.has('big_sq'), false);
  assert.equal(store.expandedIds.has('big_item_0'), false);

  const pn = patientName(doc);
  const orig = pn.value;
  store.updateNodeValue(pn.id, 'A', { coalesce: true });
  store.updateNodeValue(pn.id, 'AB', { coalesce: true });
  store.updateNodeValue(pn.id, 'ABC', { coalesce: true });
  assert.equal(store.undoStack.length, 1);
  assert.equal(pn.value, 'ABC');

  store.undo();
  assert.equal(pn.value, orig);
  store.redo();
  assert.equal(pn.value, 'ABC');
});

test('anonymization contracts: doc.deidentified, recursive action replace/empty/remove, shared UID map, word-boundary methodText, deleted root reuse', async () => {
  const bytes = await generateSampleDicomBuffer();
  const docA = await parseDicomBuffer(bytes, 'a.dcm');
  const docB = await parseDicomBuffer(bytes, 'b.dcm');

  // Nest a PatientName inside SQ on docA to verify recursive preset application
  const sqItem = docA.datasetNodes.find((n) => n.tag === '00081115').items[0];
  const nestedPn = {
    id: 'nested_pn',
    group: 0x0010,
    element: 0x0010,
    tag: '00100010',
    formattedTag: '(0010,0010)',
    keyword: 'PatientName',
    name: 'Patient Name',
    vr: 'PN',
    isSequence: false,
    isBinary: false,
    value: 'NESTED^PATIENT',
    originalValue: 'NESTED^PATIENT',
    status: 'unchanged',
  };
  sqItem.children.push(nestedPn);

  const store = new AppStore();
  store.loadDocument(docA);
  // Add & delete (0012,0062) + add a private tag to verify Finding 18
  store.addTag({ group: 0x0012, element: 0x0062, vr: 'CS', value: 'NO' });
  const existingDeid = docA.datasetNodes.find((n) => n.tag === '00120062');
  assert.equal(store.markSaved(docA, store.getDocumentRevision(docA)), true);
  store.toggleDeleteNode(existingDeid.id);
  store.addTag({ group: 0x0009, element: 0x1099, vr: 'LO', value: 'ADDED_PRIV' });

  store.loadDocument(docB, null, { append: true });
  const refUidB = docB.datasetNodes
    .find((n) => n.tag === '00081115').items[0].children
    .find((n) => n.tag === '0008114A').items[0].children
    .find((n) => n.tag === '00081155');
  const origExternalRef = refUidB.value;
  const origSopClass = docA.datasetNodes.find((n) => n.tag === '00080016').value;
  assert.ok(origSopClass.startsWith('1.2.840.10008.'));

  const longMethod = 'PS3.15 Partial De-identification Profile With Extended Options Exceeding Sixty Four Characters';
  const rules = [
    { tag: '00100010', action: 'replace', replacement: 'ANON' },
    { tag: '00100020', action: 'empty', replacement: 'IGNORED' },
    { tag: '00104000', action: 'remove', replacement: '' },
  ];

  const res = await store.applyAnonymizationAllFiles(rules, {
    markDeidentified: true,
    methodText: longMethod,
    stripPrivate: true,
    regenerateUids: true,
  });
  assert.equal(res.affectedFiles, 2);

  // Contract 1: doc.deidentified set to true
  assert.equal(docA.deidentified, true);
  assert.equal(docB.deidentified, true);

  // Contract 2: recursive replace/empty/remove
  assert.equal(patientName(docA).value, 'ANON');
  assert.equal(nestedPn.value, 'ANON');
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00100020').value, '');
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00104000').status, 'deleted');

  // Contract 3: word-boundary truncation <= 64 chars (no mid-word cut)
  const methodVal = docA.datasetNodes.find((n) => n.tag === '00120063').value;
  assert.ok(methodVal.length <= 64);
  assert.equal(methodVal, 'PS3.15 Partial De-identification Profile With Extended Options');

  // Contract 4: all non-well-known UI tags remapped via one shared map; 1.2.840.10008.* untouched
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00080016').value, origSopClass);
  assert.equal(docA.metaNodes.find((n) => n.tag === '00020002').value, origSopClass);
  assert.notEqual(refUidB.value, origExternalRef);
  assert.equal(
    docA.datasetNodes.find((n) => n.tag === '0020000D').value,
    docB.datasetNodes.find((n) => n.tag === '0020000D').value
  );

  // Finding 18: no duplicate (0012,0062) and added private tag spliced out (not left 'deleted')
  assert.equal(docA.datasetNodes.filter((n) => n.tag === '00120062').length, 1);
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00120062').value, 'YES');
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00091099'), undefined);

  // Undo restores doc.deidentified and nested/removed tags
  await store.switchToFile(store.files[0].id);
  store.undo();
  assert.equal(docA.deidentified, false);
  assert.equal(nestedPn.value, 'NESTED^PATIENT');
  assert.equal(docA.datasetNodes.find((n) => n.tag === '00104000').status, 'unchanged');
  assert.ok(docA.datasetNodes.find((n) => n.tag === '00091099'));
});

test('ensureUtf8Charset restores deleted (0008,0005) and sets ISO_IR 192 in one atomic undo step', async () => {
  const doc = await parseDicomBuffer(await generateSampleDicomBuffer(), 'utf8.dcm');
  const store = new AppStore();
  store.loadDocument(doc);
  const cs = doc.datasetNodes.find((n) => n.tag === '00080005');
  store.updateNodeValue(cs.id, 'ISO_IR 100');
  store.markSaved(doc, store.getDocumentRevision(doc));
  store.toggleDeleteNode(cs.id);
  const stackBefore = store.undoStack.length;

  store.ensureUtf8Charset();
  assert.equal(store.undoStack.length, stackBefore + 1);
  assert.equal(cs.status, 'modified');
  assert.equal(cs.value, 'ISO_IR 192');

  store.undo();
  assert.equal(cs.status, 'deleted');
  assert.equal(cs.value, 'ISO_IR 100');
});

test('removeFile returns fallbackErrors when remaining lazy files fail to parse', async () => {
  const goodBuf = await generateSampleDicomBuffer();
  const corruptBuf = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]).buffer;
  const store = new AppStore();
  await store.loadFileItems([
    { name: 'good.dcm', arrayBuffer: goodBuf.slice(0) },
    { name: 'bad.dcm', arrayBuffer: corruptBuf },
  ]);

  const res = await store.removeFile(store.files[0].id);
  assert.equal(res.fallbackErrors.length, 1);
  assert.equal(res.fallbackErrors[0].fileName, 'bad.dcm');
  assert.equal(store.doc, null);
});

test('buildCompareRows preserves duplicate tags and does not double-count ancestor context in hiddenEqualMatches', async () => {
  const bytes = await generateSampleDicomBuffer();
  const a = await parseDicomBuffer(bytes, 'a.dcm');
  const b = await parseDicomBuffer(bytes, 'b.dcm');

  // 1) Ancestor SQ (0008,1115) matches search query '(0008,1115)', while a nested leaf differs
  const leafB = b.datasetNodes
    .find((n) => n.tag === '00081115').items[0].children
    .find((n) => n.tag === '0008114A').items[0].children
    .find((n) => n.tag === '00081155');
  leafB.value = '2.25.123456789';

  const res = buildCompareRows(a, b, { diffOnly: true, searchQuery: '(0008,1115)' });
  assert.ok(res.rows.some((r) => r.a?.tag === '(0008,1115)' && r.isContext === true));
  // Equal ancestor SQs (0008,1115) & (0008,114A) are shown as context, so hiddenEqualMatches counts only hidden equal leaves
  assert.equal(res.rows.filter((r) => r.isContext).length, 2);
  assert.equal(res.hiddenEqualMatches, 2);

  // 2) Duplicate private tags at same level are both preserved
  const mkDup = (val) => ({
    id: `dup_${val}`,
    group: 0x0009,
    element: 0x1055,
    tag: '00091055',
    formattedTag: '(0009,1055)',
    keyword: 'PrivateTag',
    name: 'Private Tag',
    vr: 'LO',
    isSequence: false,
    isBinary: false,
    value: val,
    status: 'unchanged',
  });
  a.datasetNodes.push(mkDup('FIRST'), mkDup('SECOND'));
  b.datasetNodes.push(mkDup('FIRST'), mkDup('CHANGED_SECOND'));
  const dupRes = buildCompareRows(a, b, { diffOnly: true });
  const dupRows = dupRes.rows.filter((r) => r.a?.tag === '(0009,1055)');
  assert.equal(dupRows.length, 1);
  assert.equal(dupRows[0].a.value, 'SECOND');
  assert.equal(dupRows[0].b.value, 'CHANGED_SECOND');
});

test('PixelPanel releases decoded bitmap on collapse/pruneStaleDoc and preserves DOM across frame steps', async (t) => {
  let closedCount = 0;
  let innerHtmlWrites = 0;
  const mockCanvas = {
    style: {},
    clientWidth: 100,
    clientHeight: 100,
    addEventListener() {},
    getContext: () => ({
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {},
      save() {},
      restore() {},
      drawImage() {},
    }),
  };
  const mockFrameSlider = { value: '0', max: '1', addEventListener() {} };
  const container = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { innerHtmlWrites++; this._html = v; },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector(sel) {
      if (sel === '#pixel-canvas') return innerHtmlWrites > 0 ? mockCanvas : null;
      if (sel === '#pixel-frame') return mockFrameSlider;
      return null;
    },
    querySelectorAll: () => [],
  };

  const prevWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevCreateBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { innerWidth: 1200 } });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    writable: true,
    value: async () => ({ width: 2, height: 2, close() { closedCount++; } }),
  });
  t.after(() => {
    if (prevWindow) Object.defineProperty(globalThis, 'window', prevWindow);
    else delete globalThis.window;
    if (prevCreateBitmap) Object.defineProperty(globalThis, 'createImageBitmap', prevCreateBitmap);
    else delete globalThis.createImageBitmap;
  });

  const makeMultiFrameDoc = (name) => ({
    fileName: name,
    transferSyntaxInfo: { compressed: true, codec: 'jpeg-baseline' },
    datasetNodes: [
      { tag: '00280002', value: '3', status: 'unchanged' },
      { tag: '00280004', value: 'RGB', status: 'unchanged' },
      { tag: '00280008', value: '2', status: 'unchanged' },
      { tag: '00280010', value: '2', status: 'unchanged' },
      { tag: '00280011', value: '2', status: 'unchanged' },
      {
        tag: '7FE00010',
        encapsulated: true,
        fragments: [Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)],
        status: 'unchanged',
      },
    ],
  });

  const doc1 = makeMultiFrameDoc('f1.dcm');
  const doc2 = makeMultiFrameDoc('f2.dcm');
  const store = {
    viewMode: 'tree',
    showPixelPanel: true,
    doc: doc1,
    files: [{ doc: doc1 }, { doc: doc2 }],
    pixelVersion: 1,
  };
  const panel = new PixelPanel(container, store);
  await panel.sync(true);
  const writesAfterFirst = innerHtmlWrites;

  // Frame step must update in place without rebuilding innerHTML (keeps frame slider intact!)
  panel._frameIndex = 1;
  await panel._loadAndDrawFrame(false);
  assert.equal(innerHtmlWrites, writesAfterFirst);
  assert.equal(closedCount, 1);

  // Switching to doc2 resets _frameIndex to 0 and _invert to false
  panel._invert = true;
  store.doc = doc2;
  store.pixelVersion++;
  await panel.sync();
  assert.equal(panel._frameIndex, 0);
  assert.equal(panel._invert, false);

  // Closing doc2 and pruning releases bitmap and doc reference
  store.files = [{ doc: doc1 }];
  store.doc = doc1;
  panel.pruneStaleDoc();
  assert.equal(panel._decoded, null);
  assert.equal(panel._previewDoc, null);
  assert.ok(closedCount >= 3);

  // Collapsing panel also releases decoded buffer
  await panel.sync(true);
  assert.ok(panel._decoded);
  store.showPixelPanel = false;
  await panel.sync();
  assert.equal(panel._decoded, null);
  assert.equal(panel._previewDoc, null);
});

test('saveAllToFolder avoids silent overwrite on existing files, saveAllAsZip preserves dirty/undo, and saveFileEntry serializes before picker', async (t) => {
  const bytes = await generateSampleDicomBuffer();
  const doc1 = await parseDicomBuffer(bytes, 'slice.dcm');
  const store = new AppStore();
  store.loadDocument(doc1);
  store.updateNodeValue(patientName(doc1).id, 'EDITED^PATIENT');

  const writtenFiles = new Map();
  // Pre-populate destination directory with an existing slice.dcm
  writtenFiles.set('slice.dcm', new Uint8Array([9, 9, 9]));

  let confirmCalls = 0;
  let confirmAnswer = false;
  let pickerCalls = 0;
  const mockDirHandle = {
    name: 'out_dir',
    async getDirectoryHandle() { return mockDirHandle; },
    async getFileHandle(name, opts = {}) {
      if (!opts.create && !writtenFiles.has(name)) {
        const err = new Error('Not found');
        err.name = 'NotFoundError';
        throw err;
      }
      return {
        name,
        async createWritable() {
          let buf = null;
          return {
            async write(data) { buf = data; },
            async close() { writtenFiles.set(name, buf); },
            async abort() {},
          };
        },
      };
    },
  };

  const fakeWin = {
    isSecureContext: true,
    confirm: () => { confirmCalls++; return confirmAnswer; },
    showDirectoryPicker: async () => mockDirHandle,
    showSaveFilePicker: async () => { pickerCalls++; return null; },
    addEventListener() {},
  };
  const fakeDoc = {
    body: { appendChild() {} },
    createElement: () => ({ click() {}, remove() {} }),
  };

  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWin });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDoc });
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.after(() => {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  });

  const fileIo = createFileIoController({
    store,
    modals: { openFileError() {} },
    fileInput: { addEventListener() {} },
    dragOverlay: { classList: { add() {}, remove() {} } },
    showToast() {},
  });

  // 1) saveAllAsZip must NOT clear dirty state or undo stack
  await fileIo.saveAllAsZip();
  assert.equal(countDocChanges(doc1), 1);
  assert.equal(store.canUndo(), true);

  // 2) saveAllToFolder when user cancels overwrite -> writes unused slice_2.dcm, preserves original slice.dcm
  confirmAnswer = false;
  await fileIo.saveAllToFolder();
  assert.equal(confirmCalls, 1);
  assert.deepEqual(Array.from(writtenFiles.get('slice.dcm')), [9, 9, 9]);
  assert.ok(writtenFiles.has('slice_2.dcm'));

  // 3) saveAllToFolder when user confirms overwrite -> overwrites existing slice.dcm
  confirmCalls = 0;
  confirmAnswer = true;
  await fileIo.saveAllToFolder();
  assert.equal(confirmCalls, 1);
  assert.ok(writtenFiles.get('slice.dcm').length > 100);

  // 4) saveFileEntry serializes before opening showSaveFilePicker
  const docBad = await parseDicomBuffer(bytes, 'bad_charset.dcm');
  store.loadDocument(docBad);
  // Remove SpecificCharacterSet (0008,0005) and put non-ASCII value so writeDicomDocument rejects
  docBad.datasetNodes = docBad.datasetNodes.filter((n) => n.tag !== '00080005');
  store.updateNodeValue(patientName(docBad).id, '한글');
  pickerCalls = 0;
  await fileIo.saveDocumentAs();
  assert.equal(pickerCalls, 0);
});

test('stripDicomBaseName handles .dcm, .dicom, .dcm.gz, Windows/POSIX paths, and i18n removes HIPAA Safe Harbor claim', () => {
  assert.equal(stripDicomBaseName('folder/study.dcm'), 'study');
  assert.equal(stripDicomBaseName('folder\\study.dicom'), 'study');
  assert.equal(stripDicomBaseName('a/b/brain.dcm.gz'), 'brain');
  assert.equal(stripDicomBaseName('a/b/brain.dicom.gz'), 'brain');
  assert.equal(stripDicomBaseName('a/b/plain.gz'), 'plain');

  setLang('en');
  assert.equal(t('modalAnonProfHipaa').includes('HIPAA Safe Harbor'), false);
  assert.ok(t('deletedSeqEditErr') !== 'deletedSeqEditErr');
  setLang('ko');
  assert.equal(t('modalAnonProfHipaa').includes('HIPAA Safe Harbor'), false);
  assert.ok(t('deletedSeqEditErr') !== 'deletedSeqEditErr');
});
