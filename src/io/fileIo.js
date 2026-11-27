/**
 * Local DICOM File & Folder I/O Controller:
 *  - Multi-file open (File System Access API + <input type="file"> fallback)
 *  - Sample CT DICOM generation
 *  - Byte-preserving single-file Save / Save As
 *  - Batch Folder Save (showDirectoryPicker) & zero-dependency ZIP export
 *  - Safe recursive folder Drag & Drop (zero getAsFileSystemHandle)
 *  - OS File Handler (PWA launchQueue)
 */

import { parseDicomBuffer } from '../dicom/parser.js';
import { writeDicomDocument } from '../dicom/writer.js';
import { generateSampleDicomBuffer } from '../dicom/sampleGenerator.js';
import { buildZipArchive } from '../utils/zipWriter.js';
import { downloadBlobBytes, stripDicomBaseName } from '../utils/uiHelpers.js';
import { INTERNAL_FILE_DRAG_MIME } from '../ui/compareView.js';
import { t } from '../i18n.js';

function countDocInvalid(doc) {
  if (!doc) return 0;
  let invalid = 0;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.status === 'deleted') continue;
      if (n.validation && !n.validation.valid) invalid++;
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children);
      }
    }
  };
  walk(doc.metaNodes);
  walk(doc.datasetNodes);
  return invalid;
}

async function fileExistsInDir(dirHandle, fileName) {
  try {
    await dirHandle.getFileHandle(fileName);
    return true;
  } catch (err) {
    if (err?.name === 'NotFoundError') return false;
    throw err;
  }
}

async function resolveTargetFileName(targetDir, relPath, fileName, usedPaths, overwriteState) {
  let candidateName = fileName;
  let exists = await fileExistsInDir(targetDir, candidateName);
  if (!exists) return candidateName;

  if (overwriteState.decision === null) {
    overwriteState.decision = window.confirm(t('confirmFolderOverwrite', { name: relPath }));
  }
  if (overwriteState.decision) {
    return candidateName;
  }

  const slashIdx = relPath.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? relPath.slice(0, slashIdx + 1) : '';
  const dot = fileName.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? fileName.slice(0, dot) : fileName;
  const ext = hasExt ? fileName.slice(dot) : '';

  let idx = 2;
  while (true) {
    const nextName = `${base}_${idx}${ext}`;
    const nextRel = `${dirPrefix}${nextName}`;
    if (!usedPaths.has(nextRel.toLowerCase()) && !(await fileExistsInDir(targetDir, nextName))) {
      usedPaths.add(nextRel.toLowerCase());
      return nextName;
    }
    idx++;
  }
}

export function buildUniqueRelativePath(rawName, usedPaths) {
  const segments = String(rawName || 'file.dcm')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..');
  const clean = segments.length > 0 ? segments.join('/') : 'file.dcm';
  if (!usedPaths.has(clean.toLowerCase())) {
    usedPaths.add(clean.toLowerCase());
    return clean;
  }
  const dot = clean.lastIndexOf('.');
  const slash = clean.lastIndexOf('/');
  const hasExt = dot > slash + 1;
  const base = hasExt ? clean.slice(0, dot) : clean;
  const ext = hasExt ? clean.slice(dot) : '';
  let idx = 2;
  while (usedPaths.has(`${base}_${idx}${ext}`.toLowerCase())) idx++;
  const candidate = `${base}_${idx}${ext}`;
  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

async function writeToFileHandle(handle, bytes) {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

async function pickSaveFileHandle(suggestedName) {
  if (!window.isSecureContext || typeof window.showSaveFilePicker !== 'function') return null;
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'DICOM File', accept: { 'application/dicom': ['.dcm'] } }],
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}

function readEntryRecursive(entry, prefix = '') {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          // Skip hidden OS junk files like .DS_Store / Thumbs.db / desktop.ini
          if (/^(\.|thumbs\.db$|desktop\.ini$)/i.test(file.name)) {
            resolve([]);
            return;
          }
          resolve([{ name: prefix ? `${prefix}/${file.name}` : file.name, size: file.size, sourceFile: file, fileHandle: null }]);
        },
        () => resolve([])
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const collected = [];
      const readBatch = () => {
        reader.readEntries(
          async (entries) => {
            if (!entries || entries.length === 0) {
              resolve(collected);
              return;
            }
            for (const child of entries) {
              const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
              const sub = await readEntryRecursive(child, childPrefix);
              collected.push(...sub);
            }
            readBatch();
          },
          () => resolve(collected)
        );
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

/**
 * Create the local file I/O controller bound to the app store and DOM hooks.
 * @param {{
 *   store: import('../state/store.js').AppStore,
 *   modals: import('../ui/modals.js').ModalManager,
 *   fileInput: HTMLInputElement,
 *   dragOverlay: HTMLElement,
 *   showToast: (msg: string, type?: string) => void,
 *   onBusyChange?: () => void,
 * }} deps
 */
export function createFileIoController({ store, modals, fileInput, dragOverlay, showToast, onBusyChange }) {
  let fileInputAppendMode = true;
  let saveInProgress = false;

  function confirmInvalidBeforeSave(doc) {
    const invalid = countDocInvalid(doc);
    if (invalid > 0) {
      return window.confirm(t('confirmInvalidSave', { count: invalid }));
    }
    return true;
  }

  function confirmInvalidBeforeBatchSave(entries) {
    let totalInvalid = 0;
    let affectedFiles = 0;
    for (const entry of entries || []) {
      if (!entry?.doc) continue;
      const c = countDocInvalid(entry.doc);
      if (c > 0) {
        totalInvalid += c;
        affectedFiles++;
      }
    }
    if (totalInvalid > 0) {
      return window.confirm(t('confirmInvalidBatchSave', { count: totalInvalid, files: affectedFiles }));
    }
    return true;
  }

  async function runSave(task) {
    if (saveInProgress || store.isBusy) return;
    saveInProgress = true;
    onBusyChange?.();
    try {
      await task();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        showToast(t('toastSaveErr', { msg: err.message }), 'error');
      }
    } finally {
      saveInProgress = false;
      store.emit('edit');
    }
  }

  async function serializeEntryForBatch(entry) {
    let dataBytes = null;
    let savedDoc = null;
    let outName = entry.name;
    if (!entry.doc) {
      try {
        const buffer = entry.arrayBuffer || await entry.sourceFile.arrayBuffer();
        const parsed = await parseDicomBuffer(buffer, entry.name);
        if (parsed.wasGzipped) {
          dataBytes = await writeDicomDocument(parsed);
          outName = entry.name.replace(/\.gz$/i, '');
        } else {
          dataBytes = new Uint8Array(buffer);
        }
      } catch {
        return null;
      }
    }
    // If the file was opened while validation ran, export its live document.
    if (entry.doc) {
      const { doc } = entry;
      const revision = store.getDocumentRevision(doc);
      dataBytes = await writeDicomDocument(doc);
      if (doc.wasGzipped) outName = entry.name.replace(/\.gz$/i, '');
      savedDoc = { doc, revision };
    }
    return { dataBytes, savedDoc, outName };
  }

  function markBatchDocsSaved(savedDocs) {
    let isCurrent = true;
    for (const { doc, revision } of savedDocs) {
      if (!store.markSaved(doc, revision)) isCurrent = false;
    }
    return isCurrent;
  }

  async function loadSelectedFileItems(items, { append = true } = {}) {
    if (!items || items.length === 0) {
      showToast(t('toastNoDcmInDrop'), 'warn');
      return;
    }
    // Natural sort by filename (so slice_2.dcm comes before slice_10.dcm)
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    try {
      const res = await store.loadFileItems(items, { append });
      if (res.stale) return;
      if (res.alreadyOpenEntry) {
        showToast(t('toastFileAlreadyOpen', { name: res.alreadyOpenEntry.name }), 'info');
      } else if (res.wasAppended) {
        showToast(t('toastFilesAdded', { count: res.addedCount, total: res.totalCount }), 'ok');
      } else if (res.loadedCount > 1) {
        showToast(t('toastFilesLoaded', { count: res.loadedCount }), 'ok');
      } else if (store.doc) {
        showToast(
          t('toastLoaded', {
            name: store.doc.fileName,
            count: store.doc.datasetNodes.length + store.doc.metaNodes.length,
          }),
          'ok'
        );
      }
      if (res.failedEntries?.length > 0) {
        modals.openFileError(res.failedEntries);
      }
    } catch (err) {
      if (err?.stale) return;
      console.error(err);
      const failures =
        Array.isArray(err.failures) && err.failures.length > 0
          ? err.failures
          : [{ fileName: items[0]?.name, size: items[0]?.size, error: err }];
      modals.openFileError(failures);
    }
  }

  async function openFileDialog({ append = true } = {}) {
    if (window.isSecureContext && typeof window.showOpenFilePicker === 'function') {
      let handles = null;
      try {
        handles = await window.showOpenFilePicker({
          multiple: true,
          types: [
            {
              description: 'DICOM Files (.dcm, .dicom, .dcm.gz)',
              accept: {
                'application/dicom': ['.dcm', '.dicom'],
                'application/gzip': ['.gz'],
              },
            },
          ],
          excludeAcceptAllOption: false,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        handles = null;
      }

      if (handles) {
        const items = [];
        const failures = [];
        for (const handle of handles) {
          try {
            const file = await handle.getFile();
            items.push({
              name: file.name,
              size: file.size,
              sourceFile: file,
              fileHandle: handle,
            });
          } catch (err) {
            failures.push({ fileName: handle?.name || 'unknown', size: null, error: err });
          }
        }
        if (items.length > 0) {
          await loadSelectedFileItems(items, { append });
        }
        if (failures.length > 0) {
          modals.openFileError(failures);
        }
        return;
      }
    }
    fileInputAppendMode = append;
    fileInput.value = '';
    fileInput.click();
  }

  async function loadSampleDicom() {
    try {
      const buf = await generateSampleDicomBuffer();
      const doc = await parseDicomBuffer(buf, 'sample_brain_ct.dcm');
      const hadExisting = store.files.length > 0;
      store.loadDocument(doc, null, { append: true });
      if (hadExisting) {
        showToast(t('toastFilesAdded', { count: 1, total: store.files.length }), 'ok');
      } else {
        showToast(
          t('toastLoaded', {
            name: doc.fileName,
            count: doc.datasetNodes.length + doc.metaNodes.length,
          }),
          'ok'
        );
      }
    } catch (err) {
      console.error(err);
      showToast(t('toastSampleErr', { msg: err.message }), 'error');
    }
  }

  async function saveFileEntry(entry, direct = false) {
    if (saveInProgress || store.isBusy || !entry) return;
    if (!entry.doc) {
      try {
        await store.ensureEntryParsed(entry);
      } catch (err) {
        modals.openFileError([{ fileName: entry.name, size: entry.size, error: err }]);
        return;
      }
    }
    const { doc, name, fileHandle } = entry;
    if (!doc || !confirmInvalidBeforeSave(doc)) return;
    const baseName = stripDicomBaseName(name);
    const suggestedName = `${baseName}_edited.dcm`;

    return runSave(async () => {
      // Serialize before opening save picker so serialization failures never create/truncate a file on disk.
      const revision = store.getDocumentRevision(doc);
      const bytes = await writeDicomDocument(doc);
      const directHandle = direct ? fileHandle : null;
      let handle = directHandle || await pickSaveFileHandle(suggestedName);
      let directWriteFailed = false;

      if (handle) {
        try {
          await writeToFileHandle(handle, bytes);
        } catch (err) {
          showToast(t('toastDirectFail', { msg: err.message }), 'warn');
          directWriteFailed = Boolean(directHandle);
          handle = null;
        }
      }

      const savedName = handle?.name || (handle && directHandle ? name : suggestedName);
      if (!handle) downloadBlobBytes(bytes, 'application/dicom', savedName);
      if (handle || !directWriteFailed) {
        const file = handle ? { handle, name: savedName, size: bytes.length } : null;
        const isCurrent = store.markSaved(doc, revision, file);
        const message = handle ? (directHandle ? 'toastSavedDirect' : 'toastSavedAs') : 'toastDownloadStart';
        showToast(t(message, { name: savedName, bytes: bytes.length.toLocaleString() }), 'ok');
        if (!isCurrent) showToast(t('toastSavePending'), 'warn');
      } else {
        showToast(t('toastDownloadStart', { name: savedName, bytes: bytes.length.toLocaleString() }), 'info');
      }
    });
  }

  function saveDocumentDirect() {
    return saveFileEntry(store.getActiveEntry(), true);
  }

  function saveDocumentAs() {
    return saveFileEntry(store.getActiveEntry(), false);
  }

  async function saveAllToFolder() {
    if (!window.isSecureContext || typeof window.showDirectoryPicker !== 'function') return;
    const files = store.files.slice();
    if (files.length === 0) return;
    if (!confirmInvalidBeforeBatchSave(files)) return;

    return runSave(async () => {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const usedPaths = new Set();
      const savedDocs = [];
      const overwriteState = { decision: null };
      let writtenCount = 0;
      let skipped = 0;

      for (const entry of files) {
        const result = await serializeEntryForBatch(entry);
        if (!result) {
          skipped++;
          continue;
        }

        const relPath = buildUniqueRelativePath(result.outName, usedPaths);
        const parts = relPath.split('/');
        const baseFileName = parts.pop();
        let targetDir = dirHandle;
        for (const dirSeg of parts) {
          targetDir = await targetDir.getDirectoryHandle(dirSeg, { create: true });
        }
        const finalFileName = await resolveTargetFileName(targetDir, relPath, baseFileName, usedPaths, overwriteState);
        const fh = await targetDir.getFileHandle(finalFileName, { create: true });
        await writeToFileHandle(fh, result.dataBytes);
        // Only mark saved when the entry has no separate original fileHandle pointing elsewhere.
        if (result.savedDoc && !entry.fileHandle) {
          savedDocs.push(result.savedDoc);
        }
        writtenCount++;
      }

      if (writtenCount === 0) {
        showToast(t('toastFolderNoDicom'), 'warn');
        return;
      }

      const isCurrent = savedDocs.length > 0 ? markBatchDocsSaved(savedDocs) : true;
      showToast(t('toastFolderSaveDone', { count: writtenCount, dir: dirHandle.name || 'folder' }), 'ok');
      if (skipped) showToast(t('toastFolderSkipped', { count: skipped }), 'warn');
      if (!isCurrent) showToast(t('toastSavePending'), 'warn');
    });
  }

  async function saveAllAsZip() {
    const files = store.files.slice();
    if (files.length === 0) return;
    if (!confirmInvalidBeforeBatchSave(files)) return;

    return runSave(async () => {
      const zipEntries = [];
      let skipped = 0;

      for (const entry of files) {
        const result = await serializeEntryForBatch(entry);
        if (!result) {
          skipped++;
          continue;
        }
        zipEntries.push({ name: result.outName, data: result.dataBytes });
      }

      if (zipEntries.length === 0) {
        showToast(t('toastZipNoDicom'), 'warn');
        return;
      }

      const zipBytes = buildZipArchive(zipEntries);
      const zipName = 'dicom_edited_batch.zip';
      downloadBlobBytes(zipBytes, 'application/zip', zipName);
      showToast(t('toastZipDone', { count: zipEntries.length, name: zipName }), 'ok');
      if (skipped) showToast(t('toastZipSkipped', { count: skipped }), 'warn');
    });
  }

  // Bind hidden <input type="file"> fallback
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) return;
    const items = files.map((f) => ({ name: f.name, size: f.size, sourceFile: f, fileHandle: null }));
    await loadSelectedFileItems(items, { append: fileInputAppendMode });
  });

  // Bind window-level multi-file & folder Drag & Drop (never calls getAsFileSystemHandle)
  let dragDepth = 0;
  const isInternalFileDrag = (e) =>
    Array.from(e.dataTransfer?.types || []).includes(INTERNAL_FILE_DRAG_MIME);

  window.addEventListener('dragenter', (e) => {
    if (isInternalFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    dragOverlay.classList.remove('hidden');
  });

  window.addEventListener('dragover', (e) => {
    if (isInternalFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (isInternalFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragOverlay.classList.add('hidden');
  });

  window.addEventListener('drop', (e) => {
    if (isInternalFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dragOverlay.classList.add('hidden');

    // Synchronously capture entries/files within the drop event turn.
    // Never call getAsFileSystemHandle() to avoid Chromium RESULT_CODE_KILLED_BAD_MESSAGE.
    const dtItems = Array.from(e.dataTransfer?.items || []);
    const entries = dtItems
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    const fallbackFiles = Array.from(e.dataTransfer?.files || []);

    (async () => {
      let items = [];
      if (entries.length > 0 && entries.some((en) => en.isDirectory)) {
        for (const en of entries) {
          const found = await readEntryRecursive(en, '');
          items.push(...found);
        }
      } else if (fallbackFiles.length > 0) {
        items = fallbackFiles.map((f) => ({ name: f.name, size: f.size, sourceFile: f, fileHandle: null }));
      }

      if (items.length === 0) {
        showToast(t('toastNoDcmInDrop'), 'warn');
        return;
      }

      // Always append dropped files to the current workspace so unsaved work is preserved
      await loadSelectedFileItems(items, { append: true });
    })();
  });

  // Bind PWA OS File Handler (launchQueue)
  if ('launchQueue' in window && typeof window.launchQueue.setConsumer === 'function') {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams?.files?.length) return;
      const items = [];
      const failures = [];
      for (const handle of launchParams.files) {
        if (handle.kind !== 'file') continue;
        try {
          const file = await handle.getFile();
          items.push({
            name: file.name,
            size: file.size,
            sourceFile: file,
            fileHandle: handle,
          });
        } catch (err) {
          console.warn('Failed to read launched file handle:', err);
          failures.push({ fileName: handle?.name || 'unknown', size: null, error: err });
        }
      }
      if (items.length > 0) {
        await loadSelectedFileItems(items, { append: true });
      }
      if (failures.length > 0) {
        modals.openFileError(failures);
      }
    });
  }

  return {
    isBusy: () => saveInProgress,
    loadSelectedFileItems,
    openFileDialog,
    loadSampleDicom,
    saveFileEntry,
    saveDocumentDirect,
    saveDocumentAs,
    saveAllToFolder,
    saveAllAsZip,
  };
}
