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
import { FileTabsBar } from './ui/fileTabs.js';
import { TreeView } from './ui/treeView.js';
import { InspectorPanel } from './ui/inspector.js';
import { PixelPanel } from './ui/pixelPanel.js';
import { CompareView, INTERNAL_FILE_DRAG_MIME } from './ui/compareView.js';
import { ModalManager } from './ui/modals.js';
import { icons, escapeHtml } from './ui/icons.js';
import { t, getLang } from './i18n.js';

const store = new AppStore();

// DOM references
const brandHome = document.getElementById('brand-home');
const welcomeView = document.getElementById('welcome-view');
const editorView = document.getElementById('editor-view');

const btnOpen = document.getElementById('btn-open');
const btnFiles = document.getElementById('btn-files');
const btnCompare = document.getElementById('btn-compare');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnEditMenu = document.getElementById('btn-edit-menu');
const btnDiff = document.getElementById('btn-diff');
const btnRaw = document.getElementById('btn-raw');
const saveSplitBtn = document.getElementById('save-split-btn');
const btnSaveMain = document.getElementById('btn-save-main');
const btnSaveMenu = document.getElementById('btn-save-menu');
const btnSettings = document.getElementById('btn-settings');

const btnWelcomeOpen = document.getElementById('btn-welcome-open');
const btnWelcomeSample = document.getElementById('btn-welcome-sample');
const welcomePwaBar = document.getElementById('welcome-pwa-bar');
const btnWelcomeInstall = document.getElementById('btn-welcome-install');
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
const fileTabsBar = document.getElementById('file-tabs-bar');
const treePane = document.getElementById('tree-pane');
const resizer = document.getElementById('pane-resizer');
const sidePane = document.getElementById('side-pane');
const comparePane = document.getElementById('compare-pane');
const summaryStrip = document.getElementById('summary-strip');
const treeBody = document.getElementById('tree-body');
const inspectorContainer = document.getElementById('inspector-container');
const pixelContainer = document.getElementById('pixel-container');
const mobileNav = document.getElementById('mobile-nav');
const mobFilesCount = document.getElementById('mob-files-count');
const modalRoot = document.getElementById('modal-root');
const dragOverlay = document.getElementById('drag-overlay');
const toastContainer = document.getElementById('toast-container');

// Populate search icon, welcome PWA icon, and GitHub links once
document.getElementById('search-icon-slot').innerHTML = icons.search(14);
document.getElementById('welcome-pwa-icon').innerHTML = icons.download(14);
document.getElementById('welcome-gh-link').innerHTML = `${icons.github(14)}<span>GitHub</span>`;
document.getElementById('status-gh-link').innerHTML = `${icons.github(13)}<span>GitHub</span>`;

let _fileInputAppendMode = true;
let saveInProgress = false;
let deferredInstallPrompt = null;
let pwaJustInstalled = false;

function isStandaloneApp() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function updatePwaWelcomeBar() {
  if (!welcomePwaBar || !btnWelcomeInstall) return;
  if (isStandaloneApp() || pwaJustInstalled) {
    welcomePwaBar.classList.add('hidden');
    return;
  }
  welcomePwaBar.classList.remove('hidden');
  btnWelcomeInstall.textContent = deferredInstallPrompt
    ? t('welcomePwaBtn')
    : t('welcomePwaGuideBtn');
  btnWelcomeInstall.title = t('settingsFileAssocNote');
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updatePwaWelcomeBar();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  pwaJustInstalled = true;
  updatePwaWelcomeBar();
  showToast(t('toastAppInstalled'), 'ok');
});

async function triggerPwaInstall() {
  if (!deferredInstallPrompt) return false;
  const promptEvent = deferredInstallPrompt;
  promptEvent.prompt();
  try {
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === 'accepted') {
      deferredInstallPrompt = null;
      pwaJustInstalled = true;
      updatePwaWelcomeBar();
      return true;
    }
  } catch {
    // ignore cancelled prompt error
  }
  return false;
}

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
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${store.files.length})</span>`;
  btnFiles.title = t('btnFilesTitle');
  btnCompare.innerHTML = `${icons.compare(15)}<span>${t('btnCompare')}</span>`;
  btnCompare.title = store.files.length >= 2 ? t('btnCompareTitle') : t('btnCompareNeedTwoTitle');
  btnUndo.innerHTML = `${icons.undo(15)}`;
  btnUndo.title = t('btnUndoTitle');
  btnRedo.innerHTML = `${icons.redo(15)}`;
  btnRedo.title = t('btnRedoTitle');
  btnEditMenu.innerHTML = `${icons.edit(15)}<span>${t('btnEdit')}</span>${icons.chevronDown(12)}`;
  btnEditMenu.title = t('btnEditTitle');
  btnDiff.innerHTML = `${icons.diff(15)}<span>${t('btnDiff')}</span>`;
  btnDiff.title = t('btnDiffTitle');
  btnRaw.innerHTML = `${icons.code(15)}<span>${t('btnRaw')}</span>`;
  btnRaw.title = t('btnRawTitle');
  btnSaveMain.innerHTML = `${icons.save(15)}<span>${t('btnSave')}</span>`;
  btnSaveMain.title = store.fileHandle ? t('btnSaveDirectTitle') : t('btnSaveAsTitle');
  btnSaveMenu.innerHTML = icons.chevronDown(13);
  btnSaveMenu.title = t('btnSaveMenuTitle');
  btnSettings.innerHTML = icons.settings(17);
  btnSettings.title = t('btnSettingsTitle');

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

  updatePwaWelcomeBar();
}

// Instantiate UI controllers
function openAddTagForItem(item, parentSeq, section) {
  modals.openAddTag({ item, parentSeq, section });
}

const treeView = new TreeView(treeBody, store, {
  onToast: showToast,
  onOpenAddTagForItem: openAddTagForItem,
});

const modals = new ModalManager(modalRoot, store, {
  onSaveAs: () => saveDocumentAs(),
  onJumpToNode: (id) => {
    if (store.compareMode) store.exitCompareMode();
    store.setSearchQuery('');
    store.setFilterMode('all');
    store.expandAll();
    store.selectNode(id);
    store.setMobileTab('tree');
    treeView.scrollToNode(id);
  },
  onToast: showToast,
  getPwaState: () => ({
    canInstall: Boolean(deferredInstallPrompt),
    isStandalone: isStandaloneApp(),
  }),
  onInstallPwa: () => triggerPwaInstall(),
});

const fileListPanel = new FileListPanel(fileListPane, store, {
  onClearAll: () => goHomeWithConfirm(),
  onSaveFile: (entry) => saveFileEntry(entry, false),
  onToast: showToast,
  onSwitchError: (err, entry) =>
    modals.openFileError([{ fileName: entry?.name, size: entry?.size, error: err }]),
});

const fileTabs = new FileTabsBar(fileTabsBar, store, {
  onSwitchError: (err, entry) =>
    modals.openFileError([{ fileName: entry?.name, size: entry?.size, error: err }]),
});

const inspector = new InspectorPanel(inspectorContainer, store, {
  onOpenAddTagForItem: openAddTagForItem,
  onToast: showToast,
});

const pixelPanel = new PixelPanel(pixelContainer, store);
const compareView = new CompareView(comparePane, store);

// ============================================================================
// Render Synchronization
// ============================================================================
function syncThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const isRaw = store.uiStyle === 'raw';
  const isLight = store.theme === 'light';
  const color = isRaw
    ? (isLight ? '#ffffff' : '#000000')
    : (isLight ? '#f4f4f5' : '#0b0b0d');
  meta.setAttribute('content', color);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', store.theme);
  syncThemeColorMeta();
}

function applyUiStyle() {
  document.documentElement.setAttribute('data-ui', store.uiStyle);
  syncThemeColorMeta();
}

function updateToolbarAndHeader() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;

  welcomeView.classList.toggle('hidden', hasDoc);
  editorView.classList.toggle('hidden', !hasDoc);
  mobileNav.classList.toggle('hidden', !hasDoc);

  const inCompare = hasDoc && store.compareMode && fileCount >= 2;
  editorView.classList.toggle('compare-active', inCompare);
  treePane.classList.toggle('hidden', inCompare);
  resizer.classList.toggle('hidden', inCompare);
  sidePane.classList.toggle('hidden', inCompare);
  comparePane.classList.toggle('hidden', !inCompare);

  // Sync mobile tab state on editor view & bottom nav
  editorView.setAttribute('data-mobile-tab', store.mobileTab);
  mobFilesCount.textContent = String(fileCount);
  mobileNav.querySelectorAll('.mob-tab').forEach((tab) => {
    const isActiveMobTab = inCompare
      ? store.mobileTab === 'files' && tab.dataset.mobTab === 'files'
      : tab.dataset.mobTab === store.mobileTab;
    tab.classList.toggle('active', isActiveMobTab);
  });

  // Files & Compare toggle buttons in topbar
  btnFiles.classList.toggle('hidden', !hasDoc);
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${fileCount})</span>`;
  btnFiles.classList.toggle('btn-primary', store.showFileList && hasDoc);

  btnCompare.classList.toggle('hidden', !hasDoc);
  btnCompare.disabled = !hasDoc || fileCount < 2;
  btnCompare.classList.toggle('btn-primary', inCompare);
  btnCompare.setAttribute('aria-pressed', String(inCompare));
  btnCompare.title = fileCount >= 2 ? t('btnCompareTitle') : t('btnCompareNeedTwoTitle');

  const busy = saveInProgress || store.anonymizing;
  btnUndo.disabled = inCompare || !store.canUndo();
  btnRedo.disabled = inCompare || !store.canRedo();
  btnEditMenu.disabled = !hasDoc || busy;
  btnDiff.disabled = !hasDoc || inCompare;
  btnRaw.disabled = !hasDoc || inCompare;
  btnSaveMain.disabled = !hasDoc || inCompare || busy;
  btnSaveMain.title = store.fileHandle ? t('btnSaveDirectTitle') : t('btnSaveAsTitle');
  btnSaveMenu.disabled = !hasDoc || busy || (inCompare && fileCount < 2);

  if (!hasDoc) {
    summaryStrip.classList.add('hidden');
    summaryStrip.innerHTML = '';
    return;
  }

  const doc = store.doc;
  const stats = store.getStatsAndDiff();
  const totalChanges = (stats.modified + stats.added + stats.deleted) || Number(Boolean(doc.needsResave));

  // Build file meta + key DICOM attributes in the summary strip below the topbar
  const tsText = doc.transferSyntaxInfo?.name || doc.transferSyntaxUid || '';
  const changeParts = [];
  if (stats.modified) changeParts.push(t('changeMod', { n: stats.modified }));
  if (stats.added) changeParts.push(t('changeAdd', { n: stats.added }));
  if (stats.deleted) changeParts.push(t('changeDel', { n: stats.deleted }));
  if (doc.needsResave) changeParts.push(t('changeSavePending'));

  const fileLeadHtml = `
    <div class="sum-file-group">
      <span class="file-name" title="${escapeHtml(doc.fileName)}">${icons.files(13)} ${escapeHtml(doc.fileName)}</span>
      ${tsText ? `<span class="ts-badge" title="Transfer Syntax UID: ${escapeHtml(doc.transferSyntaxUid)}">${escapeHtml(tsText)}</span>` : ''}
      ${changeParts.length > 0 ? `<span class="change-summary">${escapeHtml(changeParts.join(' · '))}</span>` : ''}
    </div>
  `;

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

  summaryStrip.innerHTML =
    fileLeadHtml +
    (summaryItems.length > 0
      ? `<span class="sum-sep"></span><div class="sum-meta-group">${summaryItems.join('<span class="sum-dot">·</span>')}</div>`
      : '');
  summaryStrip.classList.remove('hidden');

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

let lastWorkspaceVersion = store.workspaceVersion;

store.subscribe((reason) => {
  if (reason === 'theme') {
    applyTheme();
    return;
  }
  if (reason === 'uiStyle') {
    applyUiStyle();
    return;
  }
  if (reason === 'selection') {
    treeView.render(reason);
    inspector.render(reason);
    return;
  }
  if (reason === 'document' || reason === 'compare' || reason === 'lang') {
    closeToolbarMenu();
  }
  if (reason === 'lang') {
    applyLanguage();
  }
  if (lastWorkspaceVersion !== store.workspaceVersion) {
    lastWorkspaceVersion = store.workspaceVersion;
    compareView.reset();
  }
  updateToolbarAndHeader();
  fileListPanel.render();
  fileTabs.render();
  if (store.compareMode && store.files.length >= 2) {
    compareView.render();
    return;
  }
  treeView.render(reason);
  inspector.render(reason);
  pixelPanel.sync(reason === 'document' || reason === 'layout' || reason === 'lang');
});

window.addEventListener('resize', () => {
  pixelPanel.sync(false);
});

// ============================================================================
// Multi-File & Folder Open / Sample / Save / ZIP Export
// ============================================================================
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

function countDocInvalid(doc) {
  if (!doc) return 0;
  let invalid = 0;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.status !== 'deleted' && n.validation && !n.validation.valid) invalid++;
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children);
      }
    }
  };
  walk(doc.metaNodes);
  walk(doc.datasetNodes);
  return invalid;
}

function confirmInvalidBeforeSave(doc) {
  const invalid = countDocInvalid(doc);
  if (invalid > 0) {
    return window.confirm(t('confirmInvalidSave', { count: invalid }));
  }
  return true;
}

async function runSave(save) {
  if (saveInProgress || store.anonymizing) return;
  saveInProgress = true;
  updateToolbarAndHeader();
  try {
    await save();
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

async function writeToFile(handle, bytes) {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

function downloadBytes(bytes, type, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function pickSaveFile(suggestedName) {
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

async function saveFileEntry(entry, direct = false) {
  if (saveInProgress || store.anonymizing || !entry) return;
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
  const suggestedName = `${name.split('/').at(-1).replace(/\.dcm$/i, '')}_edited.dcm`;

  return runSave(async () => {
    const directHandle = direct ? fileHandle : null;
    let handle = directHandle || await pickSaveFile(suggestedName);
    const revision = store.getDocumentRevision(doc);
    const bytes = await writeDicomDocument(doc);

    if (handle) {
      try {
        await writeToFile(handle, bytes);
      } catch (err) {
        showToast(t('toastDirectFail', { msg: err.message }), 'warn');
        handle = null;
      }
    }

    const savedName = handle?.name || (handle && directHandle ? name : suggestedName);
    if (!handle) downloadBytes(bytes, 'application/dicom', savedName);
    const file = handle ? { handle, name: savedName, size: bytes.length } : null;
    const isCurrent = store.markSaved(doc, revision, file);
    const message = handle ? (directHandle ? 'toastSavedDirect' : 'toastSavedAs') : 'toastDownloadStart';
    showToast(t(message, { name: savedName, bytes: bytes.length.toLocaleString() }), 'ok');
    if (!isCurrent) showToast(t('toastSavePending'), 'warn');
  });
}

function saveActiveDocument(direct = false) {
  return saveFileEntry(store.getActiveEntry(), direct);
}

function saveDocumentDirect() {
  return saveActiveDocument(true);
}

function saveDocumentAs() {
  return saveActiveDocument();
}

function buildUniqueRelativePath(rawName, usedPaths) {
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

async function saveAllToFolder() {
  if (!window.isSecureContext || typeof window.showDirectoryPicker !== 'function') return;
  const files = store.files.slice();
  if (files.length === 0) return;

  return runSave(async () => {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const usedPaths = new Set();
    const savedDocs = [];
    let writtenCount = 0;
    let skipped = 0;

    for (const entry of files) {
      let dataBytes;
      if (!entry.doc) {
        try {
          const buffer = entry.arrayBuffer || await entry.sourceFile.arrayBuffer();
          await parseDicomBuffer(buffer, entry.name);
          dataBytes = new Uint8Array(buffer);
        } catch {
          skipped++;
          continue;
        }
      }
      if (entry.doc) {
        const { doc } = entry;
        const revision = store.getDocumentRevision(doc);
        dataBytes = await writeDicomDocument(doc);
        savedDocs.push({ doc, revision });
      }

      const relPath = buildUniqueRelativePath(entry.name, usedPaths);
      const parts = relPath.split('/');
      const fileName = parts.pop();
      let targetDir = dirHandle;
      for (const dirSeg of parts) {
        targetDir = await targetDir.getDirectoryHandle(dirSeg, { create: true });
      }
      const fh = await targetDir.getFileHandle(fileName, { create: true });
      await writeToFile(fh, dataBytes);
      writtenCount++;
    }

    if (writtenCount === 0) {
      showToast(t('toastFolderNoDicom'), 'warn');
      return;
    }

    let isCurrent = true;
    for (const { doc, revision } of savedDocs) {
      if (!store.markSaved(doc, revision)) isCurrent = false;
    }
    showToast(t('toastFolderSaveDone', { count: writtenCount, dir: dirHandle.name || 'folder' }), 'ok');
    if (skipped) showToast(t('toastFolderSkipped', { count: skipped }), 'warn');
    if (!isCurrent) showToast(t('toastSavePending'), 'warn');
  });
}

async function saveAllAsZip() {
  const files = store.files.slice();
  if (files.length === 0) return;

  return runSave(async () => {
    const zipEntries = [];
    const savedDocs = [];
    let skipped = 0;
    for (const entry of files) {
      let dataBytes;
      if (!entry.doc) {
        try {
          const buffer = entry.arrayBuffer || await entry.sourceFile.arrayBuffer();
          await parseDicomBuffer(buffer, entry.name);
          dataBytes = new Uint8Array(buffer);
        } catch {
          skipped++;
          continue;
        }
      }
      // If the file was opened while validation ran, export its live document.
      if (entry.doc) {
        const { doc } = entry;
        const revision = store.getDocumentRevision(doc);
        dataBytes = await writeDicomDocument(doc);
        savedDocs.push({ doc, revision });
      }
      zipEntries.push({ name: entry.name, data: dataBytes });
    }

    if (zipEntries.length === 0) {
      showToast(t('toastZipNoDicom'), 'warn');
      return;
    }

    const zipBytes = buildZipArchive(zipEntries);
    const zipName = 'dicom_edited_batch.zip';
    downloadBytes(zipBytes, 'application/zip', zipName);
    let isCurrent = true;
    for (const { doc, revision } of savedDocs) {
      if (!store.markSaved(doc, revision)) isCurrent = false;
    }
    showToast(t('toastZipDone', { count: zipEntries.length, name: zipName }), 'ok');
    if (skipped) showToast(t('toastZipSkipped', { count: skipped }), 'warn');
    if (!isCurrent) showToast(t('toastSavePending'), 'warn');
  });
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

// ============================================================================
// UI Event Bindings
// ============================================================================
function goHomeWithConfirm() {
  if (store.files.length === 0 && !store.doc) return;
  const dirty = store.getTotalUnsavedChanges();
  const msg =
    dirty > 0
      ? t('confirmGoHomeDirty', { count: dirty })
      : t('confirmGoHomeLoaded', { files: store.files.length || 1 });
  if (!window.confirm(msg)) return;
  modals.close();
  store.closeAll();
}

brandHome.addEventListener('click', goHomeWithConfirm);
brandHome.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    goHomeWithConfirm();
  }
});

// Warn before browser refresh / tab close when file(s) are loaded
window.addEventListener('beforeunload', (e) => {
  if (store.files.length > 0 || store.doc) {
    e.preventDefault();
    e.returnValue = '';
  }
});

btnOpen.addEventListener('click', () => openFileDialog());
btnWelcomeOpen.addEventListener('click', () => openFileDialog());
btnWelcomeSample.addEventListener('click', loadSampleDicom);
btnWelcomeInstall.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    await triggerPwaInstall();
  } else {
    modals.openSettings();
  }
});
btnFiles.addEventListener('click', () => store.toggleFileList());
btnCompare.addEventListener('click', () => {
  if (store.compareMode) store.exitCompareMode();
  else store.enterCompareMode();
});

// ============================================================================
// Topbar Dropdown Menus (Edit & Save Split Button)
// ============================================================================
let activeToolbarMenu = null;

function closeToolbarMenu() {
  if (!activeToolbarMenu) return;
  const { el, trigger, timer, onDismiss, onKeyDown } = activeToolbarMenu;
  activeToolbarMenu = null;
  if (timer !== null) clearTimeout(timer);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('click', onDismiss);
  window.removeEventListener('contextmenu', onDismiss);
  window.removeEventListener('resize', onDismiss);
  trigger.setAttribute('aria-expanded', 'false');
  trigger.classList.remove('menu-open');
  el.remove();
}

function openToolbarMenu(triggerEl, anchorEl, items) {
  if (activeToolbarMenu?.trigger === triggerEl) {
    closeToolbarMenu();
    return;
  }
  closeToolbarMenu();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu toolbar-menu';
  menu.setAttribute('role', 'menu');

  items.forEach((item) => {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-item';
    btn.disabled = Boolean(item.disabled);
    if (item.title) btn.title = item.title;
    btn.innerHTML = `
      ${item.icon || ''}
      <span class="ctx-item-label">${escapeHtml(item.label)}</span>
      ${item.shortcut ? `<span class="ctx-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
    `;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeToolbarMenu();
      if (!item.disabled) item.action();
    });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const anchorRect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
  const top = Math.min(anchorRect.bottom + 4, Math.max(8, window.innerHeight - menuRect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  triggerEl.setAttribute('aria-expanded', 'true');
  triggerEl.classList.add('menu-open');

  const onDismiss = () => closeToolbarMenu();
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeToolbarMenu();
    }
  };

  const state = { el: menu, trigger: triggerEl, timer: null, onDismiss, onKeyDown };
  activeToolbarMenu = state;
  window.addEventListener('keydown', onKeyDown, true);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (activeToolbarMenu !== state) return;
    window.addEventListener('click', onDismiss);
    window.addEventListener('contextmenu', onDismiss);
    window.addEventListener('resize', onDismiss);
  }, 0);
}

function openEditMenu() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;
  const inCompare = hasDoc && store.compareMode && fileCount >= 2;
  const busy = saveInProgress || store.anonymizing;

  openToolbarMenu(btnEditMenu, btnEditMenu, [
    {
      icon: icons.plus(14),
      label: t('btnAddTag'),
      disabled: !hasDoc || inCompare,
      action: () => modals.openAddTag(null),
    },
    {
      icon: icons.sliders(14),
      label: t('fileListBatchEdit'),
      shortcut: fileCount > 1 ? String(fileCount) : '',
      disabled: fileCount < 1 || busy,
      action: () => modals.openBatchEdit(),
    },
    { sep: true },
    {
      icon: icons.shield(14),
      label: t('btnAnonymize'),
      disabled: !hasDoc || inCompare || busy,
      action: () => modals.openAnonymize(),
    },
  ]);
}

function openSaveMenu() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;
  const inCompare = hasDoc && store.compareMode && fileCount >= 2;
  const busy = saveInProgress || store.anonymizing;
  const canDirectSave = hasDoc && Boolean(store.fileHandle);
  const canFolderSave = window.isSecureContext && typeof window.showDirectoryPicker === 'function';

  openToolbarMenu(btnSaveMenu, saveSplitBtn, [
    ...(canDirectSave
      ? [{
          icon: icons.save(14),
          label: t('saveMenuOverwrite'),
          shortcut: 'Ctrl+S',
          disabled: inCompare || busy,
          action: () => saveDocumentDirect(),
        }]
      : []),
    {
      icon: icons.download(14),
      label: t('saveMenuSaveAs'),
      shortcut: canDirectSave ? 'Ctrl+Shift+S' : 'Ctrl+S',
      disabled: !hasDoc || inCompare || busy,
      action: () => saveDocumentAs(),
    },
    { sep: true },
    {
      icon: icons.folderOpen(14),
      label: t('saveMenuAllFolder', { n: fileCount }),
      title: canFolderSave ? '' : t('saveMenuAllFolderUnsupported'),
      disabled: fileCount < 2 || busy || !canFolderSave,
      action: () => saveAllToFolder(),
    },
    {
      icon: icons.archive(14),
      label: t('saveMenuAllZip', { n: fileCount }),
      disabled: fileCount < 2 || busy,
      action: () => saveAllAsZip(),
    },
  ]);
}

btnUndo.addEventListener('click', () => store.undo());
btnRedo.addEventListener('click', () => store.redo());
btnEditMenu.addEventListener('click', () => openEditMenu());
btnDiff.addEventListener('click', () => modals.openDiff());
btnRaw.addEventListener('click', () => modals.openRawView());
btnSaveMain.addEventListener('click', () => {
  closeToolbarMenu();
  if (store.fileHandle) saveDocumentDirect();
  else saveDocumentAs();
});
btnSaveMenu.addEventListener('click', () => openSaveMenu());
btnSettings.addEventListener('click', () => modals.openSettings());

mobileNav.addEventListener('click', (e) => {
  const tab = e.target.closest('.mob-tab');
  if (!tab) return;
  const nextTab = tab.dataset.mobTab;
  if (store.compareMode && nextTab !== 'files') {
    store.exitCompareMode();
  }
  store.setMobileTab(nextTab);
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
  if (e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (e.code === 'Comma' || e.key === ',')) {
    if (e.repeat) return;
    if (modals.isSettingsOpen()) {
      e.preventDefault();
      modals.close();
      return;
    }
    if (modalRoot.classList.contains('hidden')) {
      e.preventDefault();
      closeToolbarMenu();
      modals.openSettings();
      return;
    }
  }
  if (!modalRoot.classList.contains('hidden')) return;
  if (e.key === 'Escape' && store.compareMode && !e.target?.closest?.('input, textarea, select')) {
    e.preventDefault();
    store.exitCompareMode();
    return;
  }
  if (
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (e.code === 'KeyW' || e.key.toLowerCase() === 'w')
  ) {
    if (e.repeat) return;
    if (
      e.target?.closest?.(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable]'
      )
    ) {
      return;
    }
    if (store.compareMode || store.activeFileId) {
      e.preventDefault();
      fileTabs.closeActiveTab();
    }
    return;
  }
  if (!mod) return;
  const key = e.key.toLowerCase();

  if (key === 'o') {
    e.preventDefault();
    openFileDialog();
  } else if (key === 's' && store.doc) {
    e.preventDefault();
    if (store.compareMode) return;
    if (e.shiftKey || !store.fileHandle) saveDocumentAs();
    else saveDocumentDirect();
  } else if (key === 'f' && store.doc) {
    e.preventDefault();
    if (store.compareMode) {
      compareView.focusSearch();
    } else {
      searchInput.focus();
      searchInput.select();
    }
  } else if (key === 'z' && store.doc && !store.compareMode) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (key === 'y' && store.doc && !store.compareMode) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    store.redo();
  }
});

// Resizer between tree pane and side pane
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

// Resizable Tree Table Columns (Drag to resize, Double-click to reset)
const COL_SPECS = {
  tag: { cssVar: '--col-tag-w', defaultWidth: 195, min: 110, max: 520 },
  name: { cssVar: '--col-name-w', defaultWidth: 225, min: 100, max: 600 },
  vr: { cssVar: '--col-vr-w', defaultWidth: 56, min: 42, max: 140 },
  vm: { cssVar: '--col-vm-w', defaultWidth: 44, min: 34, max: 120 },
  len: { cssVar: '--col-len-w', defaultWidth: 64, min: 44, max: 160 },
};
const COL_STORAGE_KEY = 'dcm_editor_col_widths';
const colWidths = {};

try {
  const savedCols = JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || '{}');
  for (const [key, spec] of Object.entries(COL_SPECS)) {
    const w = Number(savedCols[key]);
    colWidths[key] = Number.isFinite(w)
      ? Math.max(spec.min, Math.min(spec.max, w))
      : spec.defaultWidth;
    document.documentElement.style.setProperty(spec.cssVar, `${colWidths[key]}px`);
  }
} catch {
  for (const [key, spec] of Object.entries(COL_SPECS)) {
    colWidths[key] = spec.defaultWidth;
  }
}

function saveColWidths() {
  try {
    localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(colWidths));
  } catch {
    // ignore
  }
}

const treeTableHeader = document.getElementById('tree-table-header');
treeTableHeader.addEventListener('mousedown', (e) => {
  const handle = e.target.closest('[data-resize-col]');
  if (!handle) return;
  e.preventDefault();
  const colKey = handle.dataset.resizeCol;
  const spec = COL_SPECS[colKey];
  if (!spec) return;

  handle.classList.add('active');
  const startX = e.clientX;
  const startW = colWidths[colKey] || spec.defaultWidth;

  const onMove = (ev) => {
    const nextW = Math.max(spec.min, Math.min(spec.max, Math.round(startW + (ev.clientX - startX))));
    colWidths[colKey] = nextW;
    document.documentElement.style.setProperty(spec.cssVar, `${nextW}px`);
  };
  const onUp = () => {
    handle.classList.remove('active');
    saveColWidths();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

treeTableHeader.addEventListener('dblclick', (e) => {
  const handle = e.target.closest('[data-resize-col]');
  if (!handle) return;
  e.preventDefault();
  const colKey = handle.dataset.resizeCol;
  const spec = COL_SPECS[colKey];
  if (!spec) return;
  colWidths[colKey] = spec.defaultWidth;
  document.documentElement.style.setProperty(spec.cssVar, `${spec.defaultWidth}px`);
  saveColWidths();
});

// Initial render
applyTheme();
applyUiStyle();
applyLanguage();
updateToolbarAndHeader();
fileListPanel.render();
fileTabs.render();
inspector.render();
pixelPanel.sync(true);

// ============================================================================
// PWA: Service Worker Registration & OS File Handler (launchQueue)
// ============================================================================
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

if ('launchQueue' in window && typeof window.launchQueue.setConsumer === 'function') {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams?.files?.length) return;
    const items = [];
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
      }
    }
    if (items.length > 0) {
      await loadSelectedFileItems(items, { append: true });
    }
  });
}
