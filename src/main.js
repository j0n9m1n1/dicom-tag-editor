/**
 * Main entry point for DICOM Tag Editor web app.
 * Coordinates multi-file & folder I/O (Drag & Drop, File System Access API, ZIP batch export),
 * Store, FileListPanel, TreeView, InspectorPanel, PixelPanel, Modals, Mobile Tabs, and Shortcuts.
 */

import { parseDicomBuffer } from './dicom/parser.js';
import { writeDicomDocument } from './dicom/writer.js';
import { generateSampleDicomBuffer } from './dicom/sampleGenerator.js';
import { buildZipArchive } from './utils/zipWriter.js';
import { AppStore } from './state/store.js';
import { FileListPanel } from './ui/fileList.js';
import { TreeView } from './ui/treeView.js';
import { InspectorPanel } from './ui/inspector.js';
import { PixelPanel } from './ui/pixelPanel.js';
import { ModalManager } from './ui/modals.js';
import { icons, escapeHtml } from './ui/icons.js';
import { t, getLang } from './i18n.js';

const store = new AppStore();

// DOM references
const welcomeView = document.getElementById('welcome-view');
const editorView = document.getElementById('editor-view');
const fileMetaBar = document.getElementById('file-meta-bar');
const fileNameLabel = document.getElementById('file-name-label');
const tsBadge = document.getElementById('ts-badge');
const changeSummary = document.getElementById('change-summary');

const btnOpen = document.getElementById('btn-open');
const btnSample = document.getElementById('btn-sample');
const btnFiles = document.getElementById('btn-files');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnAddTag = document.getElementById('btn-add-tag');
const btnAnonymize = document.getElementById('btn-anonymize');
const btnDiff = document.getElementById('btn-diff');
const btnCompare = document.getElementById('btn-compare');
const btnRaw = document.getElementById('btn-raw');
const btnSaveDirect = document.getElementById('btn-save-direct');
const btnSaveAs = document.getElementById('btn-save-as');
const btnTogglePixel = document.getElementById('btn-toggle-pixel');
const btnLang = document.getElementById('btn-lang');
const btnTheme = document.getElementById('btn-theme');

const btnWelcomeOpen = document.getElementById('btn-welcome-open');
const btnWelcomeSample = document.getElementById('btn-welcome-sample');
const fileInput = document.getElementById('file-input');

const searchInput = document.getElementById('search-input');
const btnSearchClear = document.getElementById('btn-search-clear');
const filterChips = document.getElementById('filter-chips');
const cntModified = document.getElementById('cnt-modified');
const cntInvalid = document.getElementById('cnt-invalid');
const btnExpandAll = document.getElementById('btn-expand-all');
const btnCollapseAll = document.getElementById('btn-collapse-all');
const statusCounts = document.getElementById('status-counts');

const fileListPane = document.getElementById('filelist-pane');
const summaryStrip = document.getElementById('summary-strip');
const treeBody = document.getElementById('tree-body');
const inspectorContainer = document.getElementById('inspector-container');
const pixelContainer = document.getElementById('pixel-container');
const mobileNav = document.getElementById('mobile-nav');
const mobFilesCount = document.getElementById('mob-files-count');
const modalRoot = document.getElementById('modal-root');
const dragOverlay = document.getElementById('drag-overlay');
const toastContainer = document.getElementById('toast-container');

// Populate search icon once
document.getElementById('search-icon-slot').innerHTML = icons.search(14);

let _fileInputAppendMode = false;

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s';
    setTimeout(() => el.remove(), 260);
  }, 3200);
}

function applyLanguage() {
  const lang = getLang();
  document.documentElement.lang = lang;

  btnOpen.innerHTML = `${icons.folderOpen(15)}<span>${t('btnOpen')}</span>`;
  btnOpen.title = t('btnOpenTitle');
  btnSample.innerHTML = `${icons.sparkles(15)}<span>${t('btnSample')}</span>`;
  btnSample.title = t('btnSampleTitle');
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${store.files.length})</span>`;
  btnFiles.title = t('btnFilesTitle');
  btnUndo.innerHTML = `${icons.undo(15)}`;
  btnUndo.title = t('btnUndoTitle');
  btnRedo.innerHTML = `${icons.redo(15)}`;
  btnRedo.title = t('btnRedoTitle');
  btnAddTag.innerHTML = `${icons.plus(15)}<span>${t('btnAddTag')}</span>`;
  btnAddTag.title = t('btnAddTagTitle');
  btnAnonymize.innerHTML = `${icons.shield(15)}<span>${t('btnAnonymize')}</span>`;
  btnAnonymize.title = t('btnAnonymizeTitle');
  btnDiff.innerHTML = `${icons.diff(15)}<span>${t('btnDiff')}</span>`;
  btnDiff.title = t('btnDiffTitle');
  btnCompare.innerHTML = `${icons.layers(15)}<span>${t('btnCompare')}</span>`;
  btnCompare.title = t('btnCompareTitle');
  btnRaw.innerHTML = `${icons.code(15)}<span>${t('btnRaw')}</span>`;
  btnRaw.title = t('btnRawTitle');
  btnSaveDirect.innerHTML = `${icons.save(15)}<span>${t('btnSaveDirect')}</span>`;
  btnSaveDirect.title = t('btnSaveDirectTitle');
  btnSaveAs.innerHTML = `${icons.download(15)}<span>${t('btnSaveAs')}</span>`;
  btnSaveAs.title = t('btnSaveAsTitle');
  btnTogglePixel.innerHTML = `${icons.image(15)}<span>${t('btnPixel')}</span>`;
  btnTogglePixel.title = t('btnPixelTitle');
  btnTheme.title = t('btnThemeTitle');
  btnLang.title = t('btnLangTitle');
  btnLang.innerHTML =
    lang === 'ko'
      ? '<span class="lang-act">KO</span><span class="lang-dim">/EN</span>'
      : '<span class="lang-dim">KO/</span><span class="lang-act">EN</span>';

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (val !== key) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.dataset.i18nHtml;
    const val = t(key);
    if (val !== key) el.innerHTML = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder;
    const val = t(key);
    if (val !== key) el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.dataset.i18nTitle;
    const val = t(key);
    if (val !== key) el.title = val;
  });
}

// Instantiate UI controllers
const treeView = new TreeView(treeBody, store, {
  onToast: showToast,
});

const modals = new ModalManager(modalRoot, store, {
  onSaveAs: () => saveDocumentAs(),
  onJumpToNode: (id) => {
    store.setSearchQuery('');
    store.setFilterMode('all');
    store.expandAll();
    store.selectNode(id);
    store.setMobileTab('tree');
    treeView.scrollToNode(id);
  },
  onToast: showToast,
});

const fileListPanel = new FileListPanel(fileListPane, store, {
  onAddFiles: () => openFileDialog({ append: true }),
  onCompare: () => modals.openCompare(),
  onBatchEdit: () => modals.openBatchEdit(),
  onSaveZip: () => saveAllAsZip(),
  onSwitchError: (err) => showToast(t('toastParseErr', { msg: err.message }), 'error'),
});

const inspector = new InspectorPanel(inspectorContainer, store, {
  onOpenAddTagForItem: (item, parentSeq, section) => {
    modals.openAddTag({ item, parentSeq, section });
  },
});

const pixelPanel = new PixelPanel(pixelContainer, store);

// ============================================================================
// Render Synchronization
// ============================================================================
function applyTheme() {
  document.documentElement.setAttribute('data-theme', store.theme);
  btnTheme.innerHTML = store.theme === 'dark' ? icons.sun(16) : icons.moon(16);
}

function updateToolbarAndHeader() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;

  welcomeView.classList.toggle('hidden', hasDoc);
  editorView.classList.toggle('hidden', !hasDoc);
  fileMetaBar.classList.toggle('hidden', !hasDoc);
  mobileNav.classList.toggle('hidden', !hasDoc);

  // Sync mobile tab state on editor view & bottom nav
  editorView.setAttribute('data-mobile-tab', store.mobileTab);
  mobFilesCount.textContent = String(fileCount);
  mobileNav.querySelectorAll('.mob-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mobTab === store.mobileTab);
  });

  // Files toggle button on desktop
  btnFiles.classList.toggle('hidden', !hasDoc);
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${fileCount})</span>`;
  btnFiles.classList.toggle('btn-primary', store.showFileList && hasDoc);

  btnUndo.disabled = !store.canUndo();
  btnRedo.disabled = !store.canRedo();
  btnAddTag.disabled = !hasDoc;
  btnAnonymize.disabled = !hasDoc;
  btnDiff.disabled = !hasDoc;
  btnCompare.classList.toggle('hidden', fileCount < 2);
  btnCompare.disabled = fileCount < 2;
  btnRaw.disabled = !hasDoc;
  btnSaveAs.disabled = !hasDoc;

  const canDirectSave = hasDoc && Boolean(store.fileHandle);
  btnSaveDirect.classList.toggle('hidden', !canDirectSave);
  btnSaveDirect.disabled = !canDirectSave;

  btnTogglePixel.classList.toggle('btn-primary', store.showPixelPanel && hasDoc);

  if (!hasDoc) {
    summaryStrip.classList.add('hidden');
    summaryStrip.innerHTML = '';
    return;
  }

  const doc = store.doc;
  fileNameLabel.textContent = doc.fileName;
  fileNameLabel.title = doc.fileName;
  tsBadge.textContent = doc.transferSyntaxInfo?.name || doc.transferSyntaxUid;
  tsBadge.title = `Transfer Syntax UID: ${doc.transferSyntaxUid}`;

  // Update top key metadata summary strip
  const getVal = (hex) => {
    const node = doc.datasetNodes.find((n) => n.tag === hex && n.status !== 'deleted');
    return node && !node.isBinary && !node.isSequence ? (node.value || '').trim() : '';
  };
  const summaryItems = [];
  const modality = getVal('00080060');
  const pName = getVal('00100010');
  const pId = getVal('00100020');
  const studyDate = getVal('00080020');
  const rows = getVal('00280010');
  const cols = getVal('00280011');
  const bits = getVal('00280100');
  const frames = getVal('00280008');
  const studyDesc = getVal('00081030');

  if (modality) summaryItems.push(`<span class="sum-chip sum-mod">${escapeHtml(modality)}</span>`);
  if (pName) summaryItems.push(`<span class="sum-item"><em>Patient</em> <strong>${escapeHtml(pName)}</strong></span>`);
  if (pId) summaryItems.push(`<span class="sum-item"><em>ID</em> <code>${escapeHtml(pId)}</code></span>`);
  if (studyDate) {
    const fmtDate = /^\d{8}$/.test(studyDate)
      ? `${studyDate.slice(0, 4)}-${studyDate.slice(4, 6)}-${studyDate.slice(6, 8)}`
      : studyDate;
    summaryItems.push(`<span class="sum-item"><em>Date</em> <code>${escapeHtml(fmtDate)}</code></span>`);
  }
  if (rows && cols) {
    const dim = `${cols}×${rows}${bits ? ` · ${bits}b` : ''}${frames && Number(frames) > 1 ? ` · ${frames}f` : ''}`;
    summaryItems.push(`<span class="sum-item"><em>Image</em> <code>${escapeHtml(dim)}</code></span>`);
  }
  if (studyDesc) summaryItems.push(`<span class="sum-item sum-desc" title="${escapeHtml(studyDesc)}">${escapeHtml(studyDesc)}</span>`);

  if (summaryItems.length > 0) {
    summaryStrip.innerHTML = summaryItems.join('<span class="sum-dot">·</span>');
    summaryStrip.classList.remove('hidden');
  } else {
    summaryStrip.classList.add('hidden');
  }

  const stats = store.getStatsAndDiff();
  const totalChanges = stats.modified + stats.added + stats.deleted;

  if (totalChanges > 0) {
    const parts = [];
    if (stats.modified) parts.push(t('changeMod', { n: stats.modified }));
    if (stats.added) parts.push(t('changeAdd', { n: stats.added }));
    if (stats.deleted) parts.push(t('changeDel', { n: stats.deleted }));
    changeSummary.textContent = parts.join(' · ');
    changeSummary.classList.remove('hidden');
  } else {
    changeSummary.classList.add('hidden');
  }

  cntModified.textContent = String(totalChanges);
  cntInvalid.textContent = String(stats.invalid);

  statusCounts.textContent =
    t('statusCounts', { total: stats.total, sq: stats.sequenceCount, priv: stats.privateCount }) +
    (stats.invalid > 0 ? t('statusInvalidSuffix', { invalid: stats.invalid }) : '');

  filterChips.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.filter === store.filterMode);
  });
  if (searchInput.value !== store.searchQuery) {
    searchInput.value = store.searchQuery;
  }
  btnSearchClear.classList.toggle('hidden', !store.searchQuery);
}

store.subscribe((reason) => {
  if (reason === 'theme') {
    applyTheme();
    return;
  }
  if (reason === 'lang') {
    applyLanguage();
  }
  updateToolbarAndHeader();
  fileListPanel.render();
  treeView.render();
  inspector.render(reason);
  pixelPanel.sync(reason === 'document' || reason === 'layout' || reason === 'lang');
});

window.addEventListener('resize', () => {
  pixelPanel.sync(false);
});

// ============================================================================
// Multi-File & Folder Open / Sample / Save / ZIP Export
// ============================================================================
async function loadSelectedFileItems(items, { append = false } = {}) {
  if (!items || items.length === 0) {
    showToast(t('toastNoDcmInDrop'), 'warn');
    return;
  }
  // Natural sort by filename (so slice_2.dcm comes before slice_10.dcm)
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  try {
    const res = await store.loadFileItems(items, { append });
    if (append) {
      showToast(t('toastFilesAdded', { count: res.loadedCount }), 'ok');
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
  } catch (err) {
    console.error(err);
    showToast(t('toastParseErr', { msg: err.message }), 'error');
  }
}

async function openFileDialog({ append = false } = {}) {
  if (window.isSecureContext && typeof window.showOpenFilePicker === 'function') {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'DICOM Files',
            accept: { 'application/dicom': ['.dcm', '.dicom'] },
          },
        ],
        excludeAcceptAllOption: false,
      });
      const items = [];
      for (const handle of handles) {
        const file = await handle.getFile();
        items.push({
          name: file.name,
          size: file.size,
          sourceFile: file,
          fileHandle: handle,
        });
      }
      await loadSelectedFileItems(items, { append });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  _fileInputAppendMode = append;
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  if (files.length === 0) return;
  const items = files.map((f) => ({ name: f.name, size: f.size, sourceFile: f, fileHandle: null }));
  await loadSelectedFileItems(items, { append: _fileInputAppendMode });
});

async function loadSampleDicom() {
  try {
    const buf = await generateSampleDicomBuffer();
    const doc = await parseDicomBuffer(buf, 'sample_brain_ct.dcm');
    store.loadDocument(doc, null, { append: false });
    showToast(
      t('toastLoaded', {
        name: doc.fileName,
        count: doc.datasetNodes.length + doc.metaNodes.length,
      }),
      'ok'
    );
  } catch (err) {
    console.error(err);
    showToast(t('toastSampleErr', { msg: err.message }), 'error');
  }
}

function confirmInvalidBeforeSave() {
  const stats = store.getStatsAndDiff();
  if (stats.invalid > 0) {
    return window.confirm(t('confirmInvalidSave', { count: stats.invalid }));
  }
  return true;
}

async function saveDocumentDirect() {
  if (!store.doc || !store.fileHandle) {
    return saveDocumentAs();
  }
  if (!confirmInvalidBeforeSave()) return;
  try {
    const bytes = await writeDicomDocument(store.doc);
    const writable = await store.fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
    store.markSaved();
    showToast(t('toastSavedDirect', { name: store.doc.fileName, bytes: bytes.length.toLocaleString() }), 'ok');
  } catch (err) {
    console.error(err);
    showToast(t('toastDirectFail', { msg: err.message }), 'warn');
    await saveDocumentAs();
  }
}

async function saveDocumentAs() {
  if (!store.doc) return;
  if (!confirmInvalidBeforeSave()) return;
  try {
    const bytes = await writeDicomDocument(store.doc);
    const suggestedName = store.doc.fileName.toLowerCase().endsWith('.dcm')
      ? store.doc.fileName.replace(/\.dcm$/i, '_edited.dcm')
      : `${store.doc.fileName}_edited.dcm`;

    if (window.isSecureContext && typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'DICOM File', accept: { 'application/dicom': ['.dcm'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        store.fileHandle = handle;
        store.doc.fileName = handle.name || suggestedName;
        const active = store.getActiveEntry();
        if (active) {
          active.name = store.doc.fileName;
          active.fileHandle = handle;
        }
        store.markSaved();
        showToast(t('toastSavedAs', { name: store.doc.fileName, bytes: bytes.length.toLocaleString() }), 'ok');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    const blob = new Blob([bytes], { type: 'application/dicom' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    store.markSaved();
    showToast(t('toastDownloadStart', { name: suggestedName, bytes: bytes.length.toLocaleString() }), 'ok');
  } catch (err) {
    console.error(err);
    showToast(t('toastSaveErr', { msg: err.message }), 'error');
  }
}

async function saveAllAsZip() {
  const files = store.files;
  if (files.length === 0) return;

  try {
    const zipEntries = [];
    for (let i = 0; i < files.length; i++) {
      const entry = files[i];
      if (entry.error) continue;

      let dataBytes;
      if (entry.doc) {
        dataBytes = await writeDicomDocument(entry.doc);
        store.markSaved(entry.doc);
      } else if (entry.sourceFile) {
        dataBytes = new Uint8Array(await entry.sourceFile.arrayBuffer());
      } else if (entry.arrayBuffer) {
        dataBytes = new Uint8Array(entry.arrayBuffer);
      } else {
        continue;
      }

      zipEntries.push({ name: entry.name, data: dataBytes });
    }

    if (zipEntries.length === 0) return;

    const zipBytes = buildZipArchive(zipEntries);
    const zipName = 'dicom_edited_batch.zip';
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    store.emit('edit');
    showToast(t('toastZipDone', { count: zipEntries.length, name: zipName }), 'ok');
  } catch (err) {
    console.error(err);
    showToast(t('toastSaveErr', { msg: err.message }), 'error');
  }
}

// ============================================================================
// Multi-File & Folder Drag & Drop (Safe, Zero getAsFileSystemHandle)
// ============================================================================
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

let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dragOverlay.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOverlay.classList.add('hidden');
});

window.addEventListener('drop', (e) => {
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

    // If multiple files are already open, append when Shift is held or replace cleanly
    const append = Boolean(e.shiftKey && store.files.length > 0);
    await loadSelectedFileItems(items, { append });
  })();
});

// ============================================================================
// UI Event Bindings
// ============================================================================
btnOpen.addEventListener('click', () => openFileDialog({ append: false }));
btnWelcomeOpen.addEventListener('click', () => openFileDialog({ append: false }));
btnSample.addEventListener('click', loadSampleDicom);
btnWelcomeSample.addEventListener('click', loadSampleDicom);
btnFiles.addEventListener('click', () => store.toggleFileList());

btnUndo.addEventListener('click', () => store.undo());
btnRedo.addEventListener('click', () => store.redo());
btnAddTag.addEventListener('click', () => modals.openAddTag(null));
btnAnonymize.addEventListener('click', () => modals.openAnonymize());
btnDiff.addEventListener('click', () => modals.openDiff());
btnCompare.addEventListener('click', () => modals.openCompare());
btnRaw.addEventListener('click', () => modals.openRawView());
btnSaveDirect.addEventListener('click', saveDocumentDirect);
btnSaveAs.addEventListener('click', saveDocumentAs);
btnTogglePixel.addEventListener('click', () => store.togglePixelPanel());
btnLang.addEventListener('click', () => {
  store.setLang(getLang() === 'ko' ? 'en' : 'ko');
});
btnTheme.addEventListener('click', () => {
  store.setTheme(store.theme === 'dark' ? 'light' : 'dark');
});

mobileNav.addEventListener('click', (e) => {
  const tab = e.target.closest('.mob-tab');
  if (!tab) return;
  store.setMobileTab(tab.dataset.mobTab);
});

searchInput.addEventListener('input', () => store.setSearchQuery(searchInput.value));
btnSearchClear.addEventListener('click', () => {
  store.setSearchQuery('');
  searchInput.focus();
});

filterChips.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  store.setFilterMode(chip.dataset.filter);
});

btnExpandAll.addEventListener('click', () => store.expandAll());
btnCollapseAll.addEventListener('click', () => store.collapseAll());

// Global keyboard shortcuts
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();

  if (key === 'o') {
    e.preventDefault();
    openFileDialog({ append: false });
  } else if (key === 's' && store.doc) {
    e.preventDefault();
    if (e.shiftKey || !store.fileHandle) saveDocumentAs();
    else saveDocumentDirect();
  } else if (key === 'f' && store.doc) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (key === 'z' && store.doc) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (key === 'y' && store.doc) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    store.redo();
  }
});

// Resizer between tree pane and side pane
const resizer = document.getElementById('pane-resizer');
const sidePane = document.getElementById('side-pane');

resizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizer.classList.add('active');
  const startX = e.clientX;
  const startWidth = sidePane.getBoundingClientRect().width;

  const onMove = (ev) => {
    const delta = startX - ev.clientX;
    const next = Math.max(300, Math.min(640, startWidth + delta));
    sidePane.style.width = `${next}px`;
  };
  const onUp = () => {
    resizer.classList.remove('active');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

// Initial render
applyTheme();
applyLanguage();
updateToolbarAndHeader();
fileListPanel.render();
inspector.render();
pixelPanel.sync(true);
