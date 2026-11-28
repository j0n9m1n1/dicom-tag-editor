/**
 * Main entry point for DICOM Tag Editor web app.
 * Coordinates Store, FileIoController, FileListPanel, FileTabsBar, TreeView,
 * InspectorPanel, PixelPanel, RawView, CompareView, Modals, Mobile Tabs, and Shortcuts.
 */

import { AppStore, hasPixelData } from './state/store.js';
import { isSrDocument } from './dicom/srParser.js';
import { createFileIoController } from './io/fileIo.js';
import { FileListPanel } from './ui/fileList.js';
import { FileTabsBar } from './ui/fileTabs.js';
import { TreeView } from './ui/treeView.js';
import { InspectorPanel } from './ui/inspector.js';
import { PixelPanel } from './ui/pixelPanel.js';
import { CompareView } from './ui/compareView.js';
import { RawView } from './ui/rawView.js';
import { SrView } from './ui/srView.js';
import { ModalManager } from './ui/modals.js';
import { openPopupMenu, closePopupMenu } from './ui/popupMenu.js';
import { icons, escapeHtml } from './ui/icons.js';
import { t, getLang } from './i18n.js';

const store = new AppStore();

// DOM references
const brandHome = document.getElementById('brand-home');
const welcomeView = document.getElementById('welcome-view');
const editorView = document.getElementById('editor-view');

const btnOpen = document.getElementById('btn-open');
const btnFiles = document.getElementById('btn-files');
const viewModeGroup = document.getElementById('view-mode-group');
const btnViewTree = document.getElementById('btn-view-tree');
const btnViewPixel = document.getElementById('btn-view-pixel');
const btnViewSr = document.getElementById('btn-view-sr');
const btnViewRaw = document.getElementById('btn-view-raw');
const btnViewCompare = document.getElementById('btn-view-compare');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnEditMenu = document.getElementById('btn-edit-menu');
const btnDiff = document.getElementById('btn-diff');
const saveSplitBtn = document.getElementById('save-split-btn');
const btnSaveMain = document.getElementById('btn-save-main');
const btnSaveMenu = document.getElementById('btn-save-menu');
const btnSettings = document.getElementById('btn-settings');

const btnWelcomeOpen = document.getElementById('btn-welcome-open');
const btnWelcomeSample = document.getElementById('btn-welcome-sample');
const btnWelcomeScroll = document.getElementById('btn-welcome-scroll');
const welcomePwaBar = document.getElementById('welcome-pwa-bar');
const btnWelcomeInstall = document.getElementById('btn-welcome-install');
const fileInput = document.getElementById('file-input');

const searchInput = document.getElementById('search-input');
const btnSearchClear = document.getElementById('btn-search-clear');
const filterChips = document.getElementById('filter-chips');
const cntModified = document.getElementById('cnt-modified');
const cntInvalid = document.getElementById('cnt-invalid');
const cntPhi = document.getElementById('cnt-phi');
const btnExpandAll = document.getElementById('btn-expand-all');
const btnCollapseAll = document.getElementById('btn-collapse-all');
const statusCounts = document.getElementById('status-counts');

const fileListPane = document.getElementById('filelist-pane');
const fileTabsBar = document.getElementById('file-tabs-bar');
const treePane = document.getElementById('tree-pane');
const resizer = document.getElementById('pane-resizer');
const sidePane = document.getElementById('side-pane');
const srPane = document.getElementById('sr-pane');
const rawPane = document.getElementById('raw-pane');
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
  btnOpen.setAttribute('aria-label', t('btnOpen'));
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${store.files.length})</span>`;
  btnFiles.title = t('btnFilesTitle');
  btnFiles.setAttribute('aria-label', t('btnFiles'));
  btnViewTree.innerHTML = `${icons.tree(14)}<span>${t('viewModeTree')}</span>`;
  btnViewTree.title = t('viewModeTreeTitle');
  btnViewTree.setAttribute('aria-label', t('viewModeTree'));
  btnViewPixel.innerHTML = `${icons.image(14)}<span>${t('viewModePixel')}</span>`;
  btnViewPixel.title = t('viewModePixelTitle');
  btnViewPixel.setAttribute('aria-label', t('viewModePixel'));
  btnViewSr.innerHTML = `${icons.fileText(14)}<span>${t('viewModeSr')}</span>`;
  btnViewSr.title = t('viewModeSrTitle');
  btnViewSr.setAttribute('aria-label', t('viewModeSr'));
  btnViewRaw.innerHTML = `${icons.code(14)}<span>${t('viewModeRaw')}</span>`;
  btnViewRaw.title = t('viewModeRawTitle');
  btnViewRaw.setAttribute('aria-label', t('viewModeRaw'));
  btnViewCompare.innerHTML = `${icons.compare(14)}<span>${t('btnCompare')}</span>`;
  btnViewCompare.title = store.files.length >= 2 ? t('btnCompareTitle') : t('btnCompareNeedTwoTitle');
  btnViewCompare.setAttribute('aria-label', t('btnCompare'));
  btnUndo.innerHTML = `${icons.undo(15)}`;
  btnUndo.title = t('btnUndoTitle');
  btnUndo.setAttribute('aria-label', t('btnUndoTitle'));
  btnRedo.innerHTML = `${icons.redo(15)}`;
  btnRedo.title = t('btnRedoTitle');
  btnRedo.setAttribute('aria-label', t('btnRedoTitle'));
  btnEditMenu.innerHTML = `${icons.edit(15)}<span>${t('btnEdit')}</span>${icons.chevronDown(12)}`;
  btnEditMenu.title = t('btnEditTitle');
  btnEditMenu.setAttribute('aria-label', t('btnEdit'));
  btnDiff.innerHTML = `${icons.diff(15)}<span>${t('btnDiff')}</span>`;
  btnDiff.title = t('btnDiffTitle');
  btnDiff.setAttribute('aria-label', t('btnDiff'));
  btnSaveMain.innerHTML = `${icons.save(15)}<span>${t('btnSave')}</span>`;
  btnSaveMain.title = store.fileHandle ? t('btnSaveDirectTitle') : t('btnSaveAsTitle');
  btnSaveMain.setAttribute('aria-label', t('btnSave'));
  btnSaveMenu.innerHTML = icons.chevronDown(13);
  btnSaveMenu.title = t('btnSaveMenuTitle');
  btnSaveMenu.setAttribute('aria-label', t('btnSaveMenuTitle'));
  btnSettings.innerHTML = icons.settings(17);
  btnSettings.title = t('btnSettingsTitle');
  btnSettings.setAttribute('aria-label', t('btnSettingsTitle'));

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

function jumpToNode(id) {
  if (store.viewMode !== 'tree') store.setViewMode('tree');
  store.setSearchQuery('');
  store.setFilterMode('all');
  store.expandAll();
  store.selectNode(id);
  store.setMobileTab('tree');
  treeView.scrollToNode(id);
}

const modals = new ModalManager(modalRoot, store, {
  onSaveAs: () => fileIo.saveDocumentAs(),
  onJumpToNode: jumpToNode,
  onToast: showToast,
  getPwaState: () => ({
    canInstall: Boolean(deferredInstallPrompt),
    isStandalone: isStandaloneApp(),
  }),
  onInstallPwa: () => triggerPwaInstall(),
});

const fileIo = createFileIoController({
  store,
  modals,
  fileInput,
  dragOverlay,
  showToast,
  onBusyChange: () => updateToolbarAndHeader(),
});

const fileListPanel = new FileListPanel(fileListPane, store, {
  onClearAll: () => goHomeWithConfirm(),
  onSaveFile: (entry) => fileIo.saveFileEntry(entry, false),
  onToast: showToast,
  onSwitchError: (err, entry) =>
    modals.openFileError([{ fileName: entry?.name, size: entry?.size, error: err }]),
  onCloseErrors: (failures) => modals.openFileError(failures),
});

const fileTabs = new FileTabsBar(fileTabsBar, store, {
  onSwitchError: (err, entry) =>
    modals.openFileError([{ fileName: entry?.name, size: entry?.size, error: err }]),
  onCloseErrors: (failures) => modals.openFileError(failures),
});

const inspector = new InspectorPanel(inspectorContainer, store, {
  onOpenAddTagForItem: openAddTagForItem,
  onToast: showToast,
});

const pixelPanel = new PixelPanel(pixelContainer, store, (msg) => showToast(t('toastSaveErr', { msg }), 'error'));
const srView = new SrView(srPane, store, { onJumpToNode: jumpToNode, onToast: showToast });
const rawView = new RawView(rawPane, store, { onToast: showToast });
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

  const hasPixel = hasDoc && hasPixelData(store.doc);
  const isSr = hasDoc && isSrDocument(store.doc);
  const inCompare = hasDoc && store.viewMode === 'compare' && fileCount >= 2;
  const inPixel = hasPixel && store.viewMode === 'pixel';
  const inSr = isSr && store.viewMode === 'sr';
  const inRaw = hasDoc && store.viewMode === 'raw';
  const inTree = hasDoc && !inCompare && !inPixel && !inSr && !inRaw;
  editorView.classList.toggle('compare-active', inCompare);
  editorView.classList.toggle('pixel-active', inPixel);
  editorView.classList.toggle('sr-active', inSr);
  editorView.classList.toggle('raw-active', inRaw);
  treePane.classList.toggle('hidden', !inTree);
  resizer.classList.toggle('hidden', !inTree);
  sidePane.classList.toggle('hidden', !inTree && !inPixel);
  srPane.classList.toggle('hidden', !inSr);
  rawPane.classList.toggle('hidden', !inRaw);
  comparePane.classList.toggle('hidden', !inCompare);

  // Sync mobile tab state on editor view & bottom nav
  editorView.setAttribute('data-mobile-tab', store.mobileTab);
  mobFilesCount.textContent = String(fileCount);
  const isSpecialView = inCompare || inPixel || inSr || inRaw;
  mobileNav.querySelectorAll('.mob-tab').forEach((tab) => {
    const isActiveMobTab = isSpecialView
      ? store.mobileTab === 'files' && tab.dataset.mobTab === 'files'
      : tab.dataset.mobTab === store.mobileTab;
    tab.classList.toggle('active', isActiveMobTab);
  });

  // Files toggle & View Mode segmented switcher in topbar
  btnFiles.classList.toggle('hidden', !hasDoc);
  btnFiles.innerHTML = `${icons.files(15)}<span>${t('btnFiles')} (${fileCount})</span>`;
  btnFiles.classList.toggle('btn-primary', store.showFileList && hasDoc);

  viewModeGroup.classList.toggle('hidden', !hasDoc);
  btnViewTree.disabled = !hasDoc;
  btnViewPixel.classList.toggle('hidden', !hasPixel);
  btnViewPixel.disabled = !hasPixel;
  btnViewSr.classList.toggle('hidden', !isSr);
  btnViewSr.disabled = !isSr;
  btnViewRaw.disabled = !hasDoc;
  btnViewCompare.disabled = !hasDoc || fileCount < 2;
  btnViewCompare.title = fileCount >= 2 ? t('btnCompareTitle') : t('btnCompareNeedTwoTitle');
  btnViewTree.classList.toggle('active', inTree);
  btnViewPixel.classList.toggle('active', inPixel);
  btnViewSr.classList.toggle('active', inSr);
  btnViewRaw.classList.toggle('active', inRaw);
  btnViewCompare.classList.toggle('active', inCompare);
  btnViewTree.setAttribute('aria-pressed', String(inTree));
  btnViewPixel.setAttribute('aria-pressed', String(inPixel));
  btnViewSr.setAttribute('aria-pressed', String(inSr));
  btnViewRaw.setAttribute('aria-pressed', String(inRaw));
  btnViewCompare.setAttribute('aria-pressed', String(inCompare));

  const busy = fileIo.isBusy() || store.isBusy;
  btnUndo.disabled = inCompare || busy || !store.canUndo();
  btnRedo.disabled = inCompare || busy || !store.canRedo();
  btnEditMenu.disabled = !hasDoc || busy;
  btnDiff.disabled = !hasDoc || inCompare;
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
  const savePending = doc.needsResave || doc.deidentificationChanged;
  const totalChanges = (stats.modified + stats.added + stats.deleted) || Number(Boolean(savePending));

  // Build file meta + key DICOM attributes in the summary strip below the topbar
  const tsText = doc.transferSyntaxInfo?.name || doc.transferSyntaxUid || '';
  const changeParts = [];
  if (stats.modified) changeParts.push(t('changeMod', { n: stats.modified }));
  if (stats.added) changeParts.push(t('changeAdd', { n: stats.added }));
  if (stats.deleted) changeParts.push(t('changeDel', { n: stats.deleted }));
  if (savePending) changeParts.push(t('changeSavePending'));

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
  cntPhi.textContent = String(stats.phiCount);

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
let treeSearchTimer = null;

store.subscribe((reason) => {
  if (reason === 'filter' || reason === 'document') clearTimeout(treeSearchTimer);
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
  if (reason === 'layout') {
    const hasDoc = Boolean(store.doc);
    const showFiles = store.showFileList && store.files.length > 0;
    btnFiles.classList.toggle('btn-primary', showFiles && hasDoc);
    fileListPane.classList.toggle('desktop-hidden', !showFiles);
    if ((showFiles || store.mobileTab === 'files') && !fileListPane.hasChildNodes()) {
      fileListPanel.render();
    }
    editorView.setAttribute('data-mobile-tab', store.mobileTab);
    const isSpecialView = store.viewMode !== 'tree';
    mobileNav.querySelectorAll('.mob-tab').forEach((tab) => {
      const isActiveMobTab = isSpecialView
        ? store.mobileTab === 'files' && tab.dataset.mobTab === 'files'
        : tab.dataset.mobTab === store.mobileTab;
      tab.classList.toggle('active', isActiveMobTab);
    });
    if (store.viewMode === 'tree' || store.viewMode === 'pixel') {
      pixelPanel.sync(false);
    }
    return;
  }
  if (reason === 'document' || reason === 'compare' || reason === 'view' || reason === 'lang') {
    closePopupMenu();
  }
  if (reason === 'lang') {
    applyLanguage();
  }
  if (lastWorkspaceVersion !== store.workspaceVersion) {
    lastWorkspaceVersion = store.workspaceVersion;
    compareView.reset();
    rawView.reset();
    srView.reset();
  }
  updateToolbarAndHeader();
  fileListPanel.render();
  fileTabs.render();
  if (reason === 'document' || reason === 'files') {
    pixelPanel.pruneStaleDoc();
  }
  if (store.viewMode !== 'tree' && store.viewMode !== 'pixel') {
    pixelPanel.suspend();
  }
  if (store.viewMode === 'compare' && store.files.length >= 2) {
    compareView.render(reason);
    return;
  }
  if (store.viewMode === 'pixel' && store.doc && hasPixelData(store.doc)) {
    pixelPanel.sync(reason === 'document' || reason === 'lang');
    return;
  }
  if (store.viewMode === 'sr' && store.doc && isSrDocument(store.doc)) {
    srView.render(reason);
    return;
  }
  if (store.viewMode === 'raw' && store.doc) {
    rawView.render(reason);
    return;
  }
  const patched = reason === 'edit' && treeView.tryPatchEditedNode(store.lastEditedNodeId);
  if (!patched) {
    treeView.render(reason);
  }
  inspector.render(reason);
  pixelPanel.sync(reason === 'document' || reason === 'lang');
});

window.addEventListener('resize', () => {
  if (store.viewMode !== 'tree' && store.viewMode !== 'pixel') return;
  pixelPanel.sync(false);
  pixelPanel.fitCanvas();
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

btnOpen.addEventListener('click', () => fileIo.openFileDialog());
btnWelcomeOpen.addEventListener('click', () => fileIo.openFileDialog());
btnWelcomeSample.addEventListener('click', () => fileIo.loadSampleDicom());
btnWelcomeScroll?.addEventListener('click', () => {
  document.getElementById('welcome-guide-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
btnWelcomeInstall.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    await triggerPwaInstall();
  } else {
    modals.openSettings();
  }
});
btnFiles.addEventListener('click', () => store.toggleFileList());
viewModeGroup.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view-mode]');
  if (!btn || btn.disabled) return;
  store.setViewMode(btn.dataset.viewMode);
});

// ============================================================================
// Topbar Dropdown Menus (Edit & Save Split Button)
// ============================================================================
function openEditMenu() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;
  const inCompare = hasDoc && store.compareMode && fileCount >= 2;
  const busy = fileIo.isBusy() || store.isBusy;

  openPopupMenu({
    triggerEl: btnEditMenu,
    anchorEl: btnEditMenu,
    className: 'toolbar-menu',
    items: [
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
      {
        icon: icons.checkCircle(14),
        label: t('btnQaCheck'),
        disabled: !hasDoc || inCompare || busy,
        action: () => modals.openQaCheck(),
      },
    ],
  });
}

function openSaveMenu() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;
  const inCompare = hasDoc && store.compareMode && fileCount >= 2;
  const inPixel = hasDoc && store.viewMode === 'pixel' && hasPixelData(store.doc);
  const inSr = hasDoc && store.viewMode === 'sr' && isSrDocument(store.doc);
  const inRaw = hasDoc && store.viewMode === 'raw';
  const busy = fileIo.isBusy() || store.isBusy;
  const canDirectSave = hasDoc && Boolean(store.fileHandle);
  const canFolderSave = window.isSecureContext && typeof window.showDirectoryPicker === 'function';

  openPopupMenu({
    triggerEl: btnSaveMenu,
    anchorEl: saveSplitBtn,
    className: 'toolbar-menu',
    items: [
      ...(inPixel
        ? [{
            icon: icons.image(14),
            label: t('saveMenuExportPng'),
            action: () => pixelPanel.exportPng(),
          }, { sep: true }]
        : []),
      ...(inSr
        ? [{
            icon: icons.fileText(14),
            label: t('saveMenuExportSr'),
            action: () => srView.exportMarkdown(),
          }, { sep: true }]
        : []),
      ...(inRaw
        ? [{
            icon: icons.code(14),
            label: t('saveMenuExportRaw', { ext: rawView.getExportExtension() }),
            action: () => rawView.exportCurrent(),
          }, { sep: true }]
        : []),
      ...(canDirectSave
        ? [{
            icon: icons.save(14),
            label: t('saveMenuOverwrite'),
            shortcut: 'Ctrl+S',
            disabled: inCompare || busy,
            action: () => fileIo.saveDocumentDirect(),
          }]
        : []),
      {
        icon: icons.download(14),
        label: t('saveMenuSaveAs'),
        shortcut: canDirectSave ? 'Ctrl+Shift+S' : 'Ctrl+S',
        disabled: !hasDoc || inCompare || busy,
        action: () => fileIo.saveDocumentAs(),
      },
      { sep: true },
      {
        icon: icons.folderOpen(14),
        label: t('saveMenuAllFolder', { n: fileCount }),
        title: canFolderSave ? '' : t('saveMenuAllFolderUnsupported'),
        disabled: fileCount < 2 || busy || !canFolderSave,
        action: () => fileIo.saveAllToFolder(),
      },
      {
        icon: icons.archive(14),
        label: t('saveMenuAllZip', { n: fileCount }),
        disabled: fileCount < 2 || busy,
        action: () => fileIo.saveAllAsZip(),
      },
    ],
  });
}

btnUndo.addEventListener('click', () => store.undo());
btnRedo.addEventListener('click', () => store.redo());
btnEditMenu.addEventListener('click', () => openEditMenu());
btnDiff.addEventListener('click', () => modals.openDiff());
btnSaveMain.addEventListener('click', () => {
  closePopupMenu();
  if (store.fileHandle) fileIo.saveDocumentDirect();
  else fileIo.saveDocumentAs();
});
btnSaveMenu.addEventListener('click', () => openSaveMenu());
btnSettings.addEventListener('click', () => modals.openSettings());

mobileNav.addEventListener('click', (e) => {
  const tab = e.target.closest('.mob-tab');
  if (!tab) return;
  const nextTab = tab.dataset.mobTab;
  if (store.viewMode !== 'tree' && nextTab !== 'files') {
    store.setViewMode('tree');
  }
  store.setMobileTab(nextTab);
});

searchInput.addEventListener('input', () => {
  store.searchQuery = searchInput.value;
  btnSearchClear.classList.toggle('hidden', !store.searchQuery);
  clearTimeout(treeSearchTimer);
  treeSearchTimer = setTimeout(() => store.emit('filter'), 100);
});
btnSearchClear.addEventListener('click', () => {
  clearTimeout(treeSearchTimer);
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

function buildCommandPaletteItems() {
  const hasDoc = Boolean(store.doc);
  const fileCount = store.files.length;
  const hasPixel = hasDoc && hasPixelData(store.doc);
  const isSr = hasDoc && isSrDocument(store.doc);
  const inCompare = hasDoc && store.viewMode === 'compare' && fileCount >= 2;
  const busy = fileIo.isBusy() || store.isBusy;
  const items = [
    {
      id: 'open',
      icon: icons.folderOpen(14),
      label: t('btnOpen'),
      keywords: 'open file dcm load',
      shortcut: 'Ctrl+O',
      action: () => fileIo.openFileDialog(),
    },
    {
      id: 'sample',
      icon: icons.sparkles(14),
      label: t('welcomeBtnSample'),
      keywords: 'sample ct demo test',
      action: () => fileIo.loadSampleDicom(),
    },
  ];

  if (hasDoc) {
    items.push(
      {
        id: 'view-tree',
        icon: icons.tree(14),
        label: t('viewModeTree'),
        keywords: 'tree tags inspector view',
        action: () => store.setViewMode('tree'),
      },
      ...(hasPixel
        ? [{
            id: 'view-pixel',
            icon: icons.image(14),
            label: t('viewModePixel'),
            keywords: 'pixel image viewer preview full',
            action: () => store.setViewMode('pixel'),
          }]
        : []),
      ...(isSr
        ? [{
            id: 'view-sr',
            icon: icons.fileText(14),
            label: t('viewModeSr'),
            keywords: 'sr structured report clinical',
            action: () => store.setViewMode('sr'),
          }]
        : []),
      {
        id: 'view-raw',
        icon: icons.code(14),
        label: t('viewModeRaw'),
        keywords: 'raw dcmdump json hex',
        action: () => store.setViewMode('raw'),
      },
      ...(fileCount >= 2
        ? [{
            id: 'view-compare',
            icon: icons.compare(14),
            label: t('btnCompare'),
            keywords: 'compare diff side by side',
            action: () => store.setViewMode('compare'),
          }]
        : []),
      ...(!inCompare && !busy
        ? [
            {
              id: 'add-tag',
              icon: icons.plus(14),
              label: t('btnAddTag'),
              keywords: 'add new tag element',
              action: () => modals.openAddTag(null),
            },
            {
              id: 'batch-edit',
              icon: icons.sliders(14),
              label: t('fileListBatchEdit'),
              keywords: 'batch multi file edit',
              action: () => modals.openBatchEdit(),
            },
            {
              id: 'anonymize',
              icon: icons.shield(14),
              label: t('btnAnonymize'),
              keywords: 'anonymize phi hipaa deidentify strip',
              action: () => modals.openAnonymize(),
            },
            {
              id: 'qa-check',
              icon: icons.checkCircle(14),
              label: t('btnQaCheck'),
              keywords: 'qa check validate conformance integrity',
              action: () => modals.openQaCheck(),
            },
            {
              id: 'diff',
              icon: icons.diff(14),
              label: t('btnDiff'),
              keywords: 'diff changes summary',
              action: () => modals.openDiff(),
            },
          ]
        : []),
      {
        id: 'filter-phi',
        icon: icons.shield(14),
        label: t('qaFilterPhiBtn'),
        keywords: 'phi filter patient privacy',
        action: () => {
          if (store.viewMode !== 'tree') store.setViewMode('tree');
          store.setSearchQuery('');
          store.setFilterMode('phi');
        },
      },
      ...(hasPixel
        ? [{
            id: 'export-pixel-png',
            icon: icons.download(14),
            label: t('saveMenuExportPng'),
            keywords: 'pixel png image export screenshot',
            action: () => pixelPanel.exportPng(),
          }]
        : []),
      ...(isSr
        ? [{
            id: 'export-sr-md',
            icon: icons.download(14),
            label: t('saveMenuExportSr'),
            keywords: 'sr markdown export report',
            action: () => {
              if (store.viewMode !== 'sr') store.setViewMode('sr');
              srView.exportMarkdown();
            },
          }]
        : []),
      ...(!inCompare && !busy
        ? [
            ...(store.fileHandle
              ? [{
                  id: 'save-direct',
                  icon: icons.save(14),
                  label: t('saveMenuOverwrite'),
                  keywords: 'save overwrite direct dcm',
                  shortcut: 'Ctrl+S',
                  action: () => fileIo.saveDocumentDirect(),
                }]
              : []),
            {
              id: 'save-as',
              icon: icons.download(14),
              label: t('saveMenuSaveAs'),
              keywords: 'save as export download dcm',
              shortcut: store.fileHandle ? 'Ctrl+Shift+S' : 'Ctrl+S',
              action: () => fileIo.saveDocumentAs(),
            },
          ]
        : []),
    );
  }

  items.push(
    {
      id: 'toggle-theme',
      icon: store.theme === 'dark' ? icons.sun(14) : icons.moon(14),
      label: store.theme === 'dark' ? t('settingsThemeLight') : t('settingsThemeDark'),
      keywords: 'theme dark light mode',
      action: () => store.setTheme(store.theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'toggle-ui',
      icon: store.uiStyle === 'modern' ? icons.code(14) : icons.layers(14),
      label: store.uiStyle === 'modern' ? t('settingsUiRaw') : t('settingsUiModern'),
      keywords: 'ui style modern terminal raw',
      action: () => store.setUiStyle(store.uiStyle === 'modern' ? 'raw' : 'modern'),
    },
    {
      id: 'settings',
      icon: icons.settings(14),
      label: t('modalSettingsTitle'),
      keywords: 'settings preferences language shortcuts',
      shortcut: 'Ctrl+,',
      action: () => modals.openSettings(),
    }
  );
  return items;
}

// Global keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.getModifierState?.('AltGraph')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
    if (e.repeat) return;
    if (modals.isCommandPaletteOpen()) {
      e.preventDefault();
      modals.close();
      return;
    }
    if (modalRoot.classList.contains('hidden')) {
      e.preventDefault();
      closePopupMenu();
      modals.openCommandPalette(buildCommandPaletteItems());
      return;
    }
  }
  if (mod && !e.altKey && !e.shiftKey && (e.code === 'Comma' || e.key === ',')) {
    if (e.repeat) return;
    if (modals.isSettingsOpen()) {
      e.preventDefault();
      modals.close();
      return;
    }
    if (modalRoot.classList.contains('hidden')) {
      e.preventDefault();
      closePopupMenu();
      modals.openSettings();
      return;
    }
  }
  if (!modalRoot.classList.contains('hidden')) return;
  if (e.key === 'Escape' && store.viewMode !== 'tree' && !e.target?.closest?.('input, textarea, select')) {
    e.preventDefault();
    store.setViewMode('tree');
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
  if (!mod || e.altKey) return;
  const key = e.key.toLowerCase();
  const code = e.code;

  if (code === 'KeyO' || key === 'o') {
    e.preventDefault();
    fileIo.openFileDialog();
  } else if ((code === 'KeyS' || key === 's') && store.doc) {
    e.preventDefault();
    if (store.compareMode || store.isBusy || fileIo.isBusy()) return;
    const active = document.activeElement;
    if (active?.matches('.inline-edit-input') && treeBody.contains(active)) active.blur();
    if (e.shiftKey || !store.fileHandle) fileIo.saveDocumentAs();
    else fileIo.saveDocumentDirect();
  } else if ((code === 'KeyF' || key === 'f') && store.doc) {
    if (store.viewMode === 'pixel') return;
    e.preventDefault();
    if (store.compareMode) {
      compareView.focusSearch();
    } else if (store.viewMode === 'sr') {
      srView.focusSearch();
    } else if (store.viewMode === 'raw') {
      rawView.focusSearch();
    } else {
      searchInput.focus();
      searchInput.select();
    }
  } else if ((code === 'KeyZ' || key === 'z') && store.doc && !store.compareMode) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (store.isBusy || fileIo.isBusy()) return;
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if ((code === 'KeyY' || key === 'y') && store.doc && !store.compareMode) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (store.isBusy || fileIo.isBusy()) return;
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
    window.removeEventListener('blur', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('blur', onUp);
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
    window.removeEventListener('blur', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('blur', onUp);
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
// PWA: Service Worker Registration
// ============================================================================
if ('serviceWorker' in navigator && window.isSecureContext) {
  let controller = navigator.serviceWorker.controller;
  let refreshing = false;
  let reloadPending = false;
  let waitingWorker = null;

  const activateWhenIdle = () => {
    if (!waitingWorker || store.files.length > 0) return;
    if (waitingWorker.state === 'installed') waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    waitingWorker = null;
  };

  const reloadWhenIdle = () => {
    if (!reloadPending || refreshing || store.files.length > 0) return;
    refreshing = true;
    window.location.reload();
  };

  const handleWaitingWorker = (worker) => {
    if (!worker || worker === waitingWorker) return;
    waitingWorker = worker;
    if (store.files.length > 0) showToast(t('toastUpdateAvailable'), 'info');
    activateWhenIdle();
  };

  store.subscribe(() => {
    activateWhenIdle();
    reloadWhenIdle();
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const next = navigator.serviceWorker.controller;
    if (controller && next && next !== controller) reloadPending = true;
    controller = next;
    reloadWhenIdle();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then((reg) => {
        const watchInstalling = () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              handleWaitingWorker(reg.waiting || installing);
            }
          });
        };
        reg.addEventListener('updatefound', watchInstalling);
        watchInstalling();
        handleWaitingWorker(reg.waiting);
        return reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
  });
}
