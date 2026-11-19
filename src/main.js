/**
 * Main entry point for DICOM Tag Editor web app.
 * Coordinates file I/O (Drag & Drop, File System Access API, Download),
 * Store, TreeView, InspectorPanel, PixelPanel, Modals, and Keyboard Shortcuts.
 */

import { parseDicomBuffer } from './dicom/parser.js';
import { writeDicomDocument } from './dicom/writer.js';
import { generateSampleDicomBuffer } from './dicom/sampleGenerator.js';
import { AppStore } from './state/store.js';
import { TreeView } from './ui/treeView.js';
import { InspectorPanel } from './ui/inspector.js';
import { PixelPanel } from './ui/pixelPanel.js';
import { ModalManager } from './ui/modals.js';
import { icons } from './ui/icons.js';

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
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnAddTag = document.getElementById('btn-add-tag');
const btnAnonymize = document.getElementById('btn-anonymize');
const btnDiff = document.getElementById('btn-diff');
const btnSaveDirect = document.getElementById('btn-save-direct');
const btnSaveAs = document.getElementById('btn-save-as');
const btnTogglePixel = document.getElementById('btn-toggle-pixel');
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

const treeBody = document.getElementById('tree-body');
const inspectorContainer = document.getElementById('inspector-container');
const pixelContainer = document.getElementById('pixel-container');
const modalRoot = document.getElementById('modal-root');
const dragOverlay = document.getElementById('drag-overlay');
const toastContainer = document.getElementById('toast-container');

// Populate static icons
btnOpen.innerHTML = `${icons.folderOpen(15)}<span>열기</span>`;
btnSample.innerHTML = `${icons.sparkles(15)}<span>샘플</span>`;
btnUndo.innerHTML = `${icons.undo(15)}`;
btnRedo.innerHTML = `${icons.redo(15)}`;
btnAddTag.innerHTML = `${icons.plus(15)}<span>태그 추가</span>`;
btnAnonymize.innerHTML = `${icons.shield(15)}<span>익명화</span>`;
btnDiff.innerHTML = `${icons.diff(15)}<span>Diff</span>`;
btnSaveDirect.innerHTML = `${icons.save(15)}<span>덮어쓰기</span>`;
btnSaveAs.innerHTML = `${icons.download(15)}<span>저장</span>`;
btnTogglePixel.innerHTML = `${icons.image(15)}<span>Pixel</span>`;
document.getElementById('search-icon-slot').innerHTML = icons.search(14);

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

// Instantiate UI controllers
const treeView = new TreeView(treeBody, store);

const modals = new ModalManager(modalRoot, store, {
  onSaveAs: () => saveDocumentAs(),
  onJumpToNode: (id) => {
    store.setSearchQuery('');
    store.setFilterMode('all');
    store.expandAll();
    store.selectNode(id);
    treeView.scrollToNode(id);
  },
  onToast: showToast,
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
  welcomeView.classList.toggle('hidden', hasDoc);
  editorView.classList.toggle('hidden', !hasDoc);
  fileMetaBar.classList.toggle('hidden', !hasDoc);

  btnUndo.disabled = !store.canUndo();
  btnRedo.disabled = !store.canRedo();
  btnAddTag.disabled = !hasDoc;
  btnAnonymize.disabled = !hasDoc;
  btnDiff.disabled = !hasDoc;
  btnSaveAs.disabled = !hasDoc;

  const canDirectSave = hasDoc && Boolean(store.fileHandle);
  btnSaveDirect.classList.toggle('hidden', !canDirectSave);
  btnSaveDirect.disabled = !canDirectSave;

  btnTogglePixel.classList.toggle('btn-primary', store.showPixelPanel && hasDoc);

  if (!hasDoc) return;

  const doc = store.doc;
  fileNameLabel.textContent = doc.fileName;
  fileNameLabel.title = doc.fileName;
  tsBadge.textContent = doc.transferSyntaxInfo?.name || doc.transferSyntaxUid;
  tsBadge.title = `Transfer Syntax UID: ${doc.transferSyntaxUid}`;

  const stats = store.getStatsAndDiff();
  const totalChanges = stats.modified + stats.added + stats.deleted;

  if (totalChanges > 0) {
    const parts = [];
    if (stats.modified) parts.push(`수정 ${stats.modified}`);
    if (stats.added) parts.push(`추가 ${stats.added}`);
    if (stats.deleted) parts.push(`삭제 ${stats.deleted}`);
    changeSummary.textContent = parts.join(' · ');
    changeSummary.classList.remove('hidden');
  } else {
    changeSummary.classList.add('hidden');
  }

  cntModified.textContent = String(totalChanges);
  cntInvalid.textContent = String(stats.invalid);

  statusCounts.textContent =
    `전체 ${stats.total}개 태그 · SQ ${stats.sequenceCount} · Private ${stats.privateCount}` +
    (stats.invalid > 0 ? ` · VR 오류 ${stats.invalid}` : '');

  // Sync filter chips active state & search input
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
  updateToolbarAndHeader();
  treeView.render();
  inspector.render(reason);
  pixelPanel.sync(reason === 'document' || reason === 'layout');
});

// ============================================================================
// File Open / Sample / Save
// ============================================================================
async function openArrayBuffer(arrayBuffer, fileName, fileHandle = null) {
  try {
    const doc = await parseDicomBuffer(arrayBuffer, fileName);
    store.loadDocument(doc, fileHandle);
    showToast(`"${fileName}" 로드 완료 (${doc.datasetNodes.length + doc.metaNodes.length}개 최상위 태그)`, 'ok');
  } catch (err) {
    console.error(err);
    showToast(`DICOM 파싱 오류: ${err.message}`, 'error');
  }
}

async function openFileDialog() {
  // Prefer File System Access API (Chrome/Edge) for direct overwrite support
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'DICOM Files',
            accept: { 'application/dicom': ['.dcm', '.dicom'] },
          },
        ],
        excludeAcceptAllOption: false,
      });
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      await openArrayBuffer(buf, file.name, handle);
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fallback to standard file input on unsupported/blocked picker
    }
  }
  fileInput.value = '';
  fileInput.click();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openArrayBuffer(buf, file.name, null);
});

async function loadSampleDicom() {
  try {
    const buf = await generateSampleDicomBuffer();
    await openArrayBuffer(buf, 'sample_brain_ct.dcm', null);
  } catch (err) {
    console.error(err);
    showToast(`샘플 생성 오류: ${err.message}`, 'error');
  }
}

function confirmInvalidBeforeSave() {
  const stats = store.getStatsAndDiff();
  if (stats.invalid > 0) {
    return window.confirm(
      `VR 규칙 위반 오류가 ${stats.invalid}건 있습니다.\n그래도 DICOM 파일로 저장하시겠습니까?`
    );
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
    showToast(`"${store.doc.fileName}" 원본 파일에 저장 완료 (${bytes.length.toLocaleString()} bytes)`, 'ok');
  } catch (err) {
    console.error(err);
    showToast(`직접 저장 실패 — 다운로드로 전환합니다: ${err.message}`, 'warn');
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

    // Try native Save As picker if available
    if (typeof window.showSaveFilePicker === 'function') {
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
        store.markSaved();
        showToast(`"${store.doc.fileName}" 저장 완료 (${bytes.length.toLocaleString()} bytes)`, 'ok');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Fallback to Blob download
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
    showToast(`"${suggestedName}" 다운로드 시작 (${bytes.length.toLocaleString()} bytes)`, 'ok');
  } catch (err) {
    console.error(err);
    showToast(`저장 중 오류 발생: ${err.message}`, 'error');
  }
}

// ============================================================================
// Drag & Drop
// ============================================================================
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dragOverlay.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragOverlay.classList.add('hidden');
});

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dragOverlay.classList.add('hidden');

  const item = e.dataTransfer?.items?.[0];
  let handle = null;
  if (item && typeof item.getAsFileSystemHandle === 'function') {
    try {
      const h = await item.getAsFileSystemHandle();
      if (h && h.kind === 'file') handle = h;
    } catch {
      handle = null;
    }
  }

  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openArrayBuffer(buf, file.name, handle);
});

// ============================================================================
// UI Event Bindings
// ============================================================================
btnOpen.addEventListener('click', openFileDialog);
btnWelcomeOpen.addEventListener('click', openFileDialog);
btnSample.addEventListener('click', loadSampleDicom);
btnWelcomeSample.addEventListener('click', loadSampleDicom);

btnUndo.addEventListener('click', () => store.undo());
btnRedo.addEventListener('click', () => store.redo());
btnAddTag.addEventListener('click', () => modals.openAddTag(null));
btnAnonymize.addEventListener('click', () => modals.openAnonymize());
btnDiff.addEventListener('click', () => modals.openDiff());
btnSaveDirect.addEventListener('click', saveDocumentDirect);
btnSaveAs.addEventListener('click', saveDocumentAs);
btnTogglePixel.addEventListener('click', () => store.togglePixelPanel());
btnTheme.addEventListener('click', () => {
  store.setTheme(store.theme === 'dark' ? 'light' : 'dark');
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
    openFileDialog();
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
updateToolbarAndHeader();
inspector.render();
pixelPanel.sync(true);
