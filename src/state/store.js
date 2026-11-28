/**
 * Central application state store with:
 *  - Multi-file workspace (lazy parsing, per-file Undo/Redo & selection state)
 *  - Command-based Undo/Redo, recursive tree lookup, search/filter matching
 *  - Diff extraction, single/batch anonymization, and batch tag editing
 *  - Mobile tab navigation & theme/language state
 */

import { validateVrValue, BINARY_VRS } from '../dicom/vrSpec.js';
import { formatTag, tagHex, lookupTag } from '../dicom/dictionary.js';
import { genNodeId, parseDicomBuffer } from '../dicom/parser.js';
import { generateDicomUid, getSopInstanceUid, isWellKnownDicomUid } from '../dicom/uid.js';
import { ANONYMIZE_PRESET_TAGS, getPhiTagInfo, isPhiNode, shiftDicomDateValue } from '../dicom/phiSpec.js';
import { isSrDocument } from '../dicom/srParser.js';
import { getLang, setLang as setI18nLang } from '../i18n.js';

export { ANONYMIZE_PRESET_TAGS };

export function hasPixelData(doc) {
  return Boolean(doc?.datasetNodes?.some((n) => n.tag === '7FE00010' && n.status !== 'deleted'));
}

let _fileIdSeq = 1;
function nextFileId() {
  return `file_${_fileIdSeq++}`;
}

async function isSameFile(entry, item) {
  try {
    if (entry.fileHandle && item.fileHandle) {
      return await entry.fileHandle.isSameEntry(item.fileHandle);
    }
    if (!entry.sourceFile || !item.sourceFile) {
      return Boolean(entry.arrayBuffer && entry.arrayBuffer === item.arrayBuffer);
    }
    if (entry.sourceFile === item.sourceFile) return true;
    const size = item.sourceFile.size;
    if (entry.sourceFile.size !== size) return false;
    const chunkSize = 1024 * 1024;
    for (let start = 0; start < size; start += chunkSize) {
      const end = start + chunkSize;
      const [a, b] = await Promise.all([
        entry.sourceFile.slice(start, end).arrayBuffer(),
        item.sourceFile.slice(start, end).arrayBuffer(),
      ]);
      const other = new Uint8Array(b);
      if (!new Uint8Array(a).every((byte, index) => byte === other[index])) return false;
    }
    return true;
  } catch {
    // If we cannot compare the original files, keep both entries.
    return false;
  }
}

const MAX_AUTO_EXPAND_ITEMS = 40;
const MAX_AUTO_EXPAND_PER_SEQ = 20;
const UNDO_COALESCE_MS = 800;

function truncateAtWordBoundary(str, maxLen = 64) {
  const clean = String(str || '').trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

function insertSorted(list, node) {
  if (!list.includes(node)) {
    list.push(node);
    list.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
  }
}

function buildDefaultExpandedIds(doc) {
  const expanded = new Set(['__meta__', '__main__']);
  let autoCount = 0;
  for (const n of doc.datasetNodes || []) {
    if (n.isSequence) {
      const items = n.items || [];
      if (items.length <= MAX_AUTO_EXPAND_PER_SEQ && autoCount + items.length <= MAX_AUTO_EXPAND_ITEMS) {
        expanded.add(n.id);
        for (const item of items) {
          expanded.add(item.id);
          autoCount++;
        }
      }
    }
  }
  return expanded;
}

export function countDocChanges(doc) {
  if (!doc) return 0;
  let count = 0;
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.status !== 'unchanged') count++;
      if (n.status === 'deleted') continue;
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children);
      }
    }
  };
  walk(doc.metaNodes);
  walk(doc.datasetNodes);
  return count || Number(Boolean(doc.needsResave || doc.deidentificationChanged));
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore restricted storage environments
  }
}

export function getReadOnlyTagMessage(tag) {
  if (tag === '00020000') return 'fileMetaGroupLengthReadOnly';
  if (tag === '00020010') return 'transferSyntaxReadOnly';
  if (tag === '00020003') return 'mediaStorageSopReadOnly';
  if (String(tag || '').toUpperCase().startsWith('FFFE')) return 'delimiterTagReadOnly';
  return null;
}

export function canEditNodeValue(node, info = null) {
  return (
    !node.isSequence &&
    !node.isBinary &&
    node.status !== 'deleted' &&
    !info?.ancestorDeleted &&
    !getReadOnlyTagMessage(node.tag)
  );
}

export class AppStore {
  constructor() {
    /** @type {Array<{
     *   id: string,
     *   name: string,
     *   size: number,
     *   sourceFile: File|null,
     *   arrayBuffer: ArrayBuffer|null,
     *   fileHandle: any,
     *   doc: any,
     *   error: string|null,
     *   undoStack: any[],
     *   redoStack: any[],
     *   selectedId: string|null,
     *   expandedIds: Set<string>,
     * }>} */
    this.files = [];
    this.activeFileId = null;

    this.doc = null;
    this.fileHandle = null;
    this.selectedId = null;
    this.expandedIds = new Set(['__meta__', '__main__']);
    this.searchQuery = '';
    this.filterMode = 'all'; // 'all' | 'modified' | 'invalid' | 'sequence' | 'private' | 'meta'
    this.showPixelPanel = true;
    this._userPrefPixelOpen = true;
    this.showFileList = false;
    this._userToggledFileList = false;
    this.viewMode = 'tree'; // 'tree' | 'sr' | 'raw' | 'compare'
    this.compareFileAId = null;
    this.compareFileBId = null;
    this.mobileTab = 'tree'; // 'files' | 'tree' | 'inspector' | 'pixel'
    this.theme = safeStorageGet('dcm_editor_theme') || 'dark';
    this.uiStyle = safeStorageGet('dcm_editor_ui') === 'raw' ? 'raw' : 'modern';
    this.lang = getLang();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.pixelVersion = 0;
    this.workspaceVersion = 0;
    this._activeOpToken = 0;
    this._revisions = new WeakMap();
    this._sequenceBaselines = new WeakMap();
    this._savedDeidentified = new WeakMap();
    this._pendingParses = new WeakMap();
    this.anonymizing = false;
    this.lastAnonymizeDateSkips = 0;
    this._batchEditing = false;
    this.lastEditedNodeId = null;
  }

  get isBusy() {
    return Boolean(this.anonymizing || this._batchEditing);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason = 'state') {
    if (this.viewMode === 'sr' && (!this.doc || !isSrDocument(this.doc))) {
      this.viewMode = 'tree';
    }
    if (this.viewMode === 'pixel' && (!this.doc || !hasPixelData(this.doc))) {
      this.viewMode = 'tree';
    }
    for (const fn of this.listeners) fn(reason);
  }

  setTheme(theme) {
    this.theme = theme;
    safeStorageSet('dcm_editor_theme', theme);
    this.emit('theme');
  }

  setUiStyle(style) {
    const next = style === 'raw' ? 'raw' : 'modern';
    this.uiStyle = next;
    safeStorageSet('dcm_editor_ui', next);
    this.emit('uiStyle');
  }

  setLang(lang) {
    setI18nLang(lang);
    this.lang = getLang();
    const revalidate = (nodes) => {
      for (const n of nodes || []) {
        if (!n.isBinary && !n.isSequence) {
          n.validation = validateVrValue(n.vr, n.value, n.tag);
        }
        if (n.isSequence && n.items) {
          for (const item of n.items) revalidate(item.children);
        }
      }
    };
    for (const entry of this.files) {
      if (entry.doc) {
        revalidate(entry.doc.metaNodes);
        revalidate(entry.doc.datasetNodes);
      }
    }
    this.emit('lang');
  }

  togglePixelPanel() {
    this.showPixelPanel = !this.showPixelPanel;
    const hasPixel = Boolean(
      this.doc?.datasetNodes?.some((n) => n.tag === '7FE00010' && n.status !== 'deleted')
    );
    if (hasPixel) {
      this._userPrefPixelOpen = this.showPixelPanel;
    }
    this.emit('layout');
  }

  toggleFileList() {
    this._userToggledFileList = true;
    this.showFileList = !this.showFileList;
    this.emit('layout');
  }

  get compareMode() {
    return this.viewMode === 'compare';
  }

  set compareMode(val) {
    if (val) {
      this.viewMode = 'compare';
    } else if (this.viewMode === 'compare') {
      this.viewMode = 'tree';
    }
  }

  setViewMode(mode) {
    if (mode === 'compare') {
      this.enterCompareMode();
      return;
    }
    if (mode === 'pixel') {
      if (!this.doc || !hasPixelData(this.doc)) return;
      if (this.viewMode === 'pixel' && this.mobileTab === 'tree') return;
      this.viewMode = 'pixel';
      this.mobileTab = 'tree';
      this.emit('view');
      return;
    }
    if (mode === 'sr') {
      if (!this.doc || !isSrDocument(this.doc)) return;
      if (this.viewMode === 'sr' && this.mobileTab === 'tree') return;
      this.viewMode = 'sr';
      this.mobileTab = 'tree';
      this.emit('view');
      return;
    }
    if (mode === 'raw') {
      if (!this.doc) return;
      if (this.viewMode === 'raw' && this.mobileTab === 'tree') return;
      this.viewMode = 'raw';
      this.mobileTab = 'tree';
      this.emit('view');
      return;
    }
    if (this.viewMode !== 'tree') {
      this.viewMode = 'tree';
      this.emit('view');
    }
  }

  enterCompareMode(fileAId = null, fileBId = null) {
    if (this.files.length < 2) return;
    const validIds = new Set(this.files.map((f) => f.id));
    let a = fileAId && validIds.has(fileAId)
      ? fileAId
      : this.compareFileAId && validIds.has(this.compareFileAId)
        ? this.compareFileAId
        : this.activeFileId || this.files[0].id;
    let b = fileBId && validIds.has(fileBId)
      ? fileBId
      : this.compareFileBId && validIds.has(this.compareFileBId) && this.compareFileBId !== a
        ? this.compareFileBId
        : (this.files.find((f) => f.id !== a) || this.files[1]).id;
    this.compareFileAId = a;
    this.compareFileBId = b;
    this.compareMode = true;
    this.mobileTab = 'tree';
    this.emit('compare');
  }

  exitCompareMode() {
    if (!this.compareMode) return;
    this.compareMode = false;
    this.emit('compare');
  }

  setCompareFiles(fileAId, fileBId) {
    if (this.files.length < 2) return;
    const validIds = new Set(this.files.map((f) => f.id));
    const prevA = this.compareFileAId;
    const prevB = this.compareFileBId;
    let nextA = fileAId && validIds.has(fileAId) ? fileAId : prevA;
    let nextB = fileBId && validIds.has(fileBId) ? fileBId : prevB;

    if (nextA && nextA === nextB) {
      if (nextA !== prevA && prevA && validIds.has(prevA)) {
        nextB = prevA;
      } else if (nextB !== prevB && prevB && validIds.has(prevB)) {
        nextA = prevB;
      } else {
        const other = this.files.find((f) => f.id !== nextA);
        if (other) nextB = other.id;
      }
    }

    this.compareFileAId = nextA;
    this.compareFileBId = nextB;
    this.emit('compare');
  }

  setMobileTab(tab) {
    if (this.mobileTab === tab) return;
    this.mobileTab = tab;
    this.emit('layout');
  }

  getActiveEntry() {
    return this.files.find((f) => f.id === this.activeFileId) || null;
  }

  _saveActiveSnapshot() {
    const cur = this.getActiveEntry();
    if (!cur) return;
    cur.doc = this.doc;
    cur.fileHandle = this.fileHandle;
    cur.selectedId = this.selectedId;
    cur.expandedIds = this.expandedIds;
    cur.undoStack = this.undoStack;
    cur.redoStack = this.redoStack;
  }

  _bindEntryToActive(entry) {
    if (entry?.doc?.wasGzipped) {
      entry.fileHandle = null; // Prevent overwriting a .dcm.gz source with uncompressed .dcm bytes
    }
    this.activeFileId = entry ? entry.id : null;
    this.doc = entry ? entry.doc : null;
    this.fileHandle = entry ? entry.fileHandle : null;
    this.selectedId = entry ? entry.selectedId : null;
    this.expandedIds = entry ? entry.expandedIds : new Set(['__meta__', '__main__']);
    this.undoStack = entry ? entry.undoStack : [];
    this.redoStack = entry ? entry.redoStack : [];

    if (this.viewMode === 'sr' && (!this.doc || !isSrDocument(this.doc))) {
      this.viewMode = 'tree';
    }
    if (this.viewMode === 'pixel' && (!this.doc || !hasPixelData(this.doc))) {
      this.viewMode = 'tree';
    }

    // Auto-collapse Pixel Preview when opening non-image DICOMs (e.g. SR, RT Plan)
    if (this.doc) {
      this.showPixelPanel = hasPixelData(this.doc) ? this._userPrefPixelOpen : false;
    }
  }

  /**
   * Ensure a file entry has been parsed into a live DICOM document (lazy parsing).
   */
  async ensureEntryParsed(entry) {
    if (!entry) return null;
    if (entry.doc) return entry.doc;
    if (this._pendingParses.has(entry)) return this._pendingParses.get(entry);
    const pending = this._parseEntry(entry);
    this._pendingParses.set(entry, pending);
    try {
      return await pending;
    } finally {
      this._pendingParses.delete(entry);
    }
  }

  async _parseEntry(entry) {
    try {
      const buf = entry.arrayBuffer || (entry.sourceFile ? await entry.sourceFile.arrayBuffer() : null);
      if (!buf) throw new Error('No file data available');
      const doc = await parseDicomBuffer(buf, entry.name);
      entry.doc = doc;
      if (doc.wasGzipped) entry.fileHandle = null;
      entry.error = null;
      entry.errorCode = null;
      entry.errorDetails = null;
      entry.arrayBuffer = null; // free duplicate raw buffer once parsed
      if (!entry.selectedId) {
        entry.selectedId = doc.datasetNodes[0]?.id || doc.metaNodes[0]?.id || null;
      }
      if (!entry.expandedIds || entry.expandedIds.size === 0) {
        entry.expandedIds = buildDefaultExpandedIds(doc);
      }
      return doc;
    } catch (err) {
      entry.error = err.message || 'Parse error';
      entry.errorCode = err.code || null;
      entry.errorDetails = err.details || null;
      throw err;
    }
  }

  /**
   * Load a single pre-parsed document (e.g. sample DICOM). Replaces current list unless append=true.
   */
  loadDocument(doc, fileHandle = null, { append = false } = {}) {
    this._activeOpToken++;
    this._saveActiveSnapshot();
    const entry = {
      id: nextFileId(),
      name: doc.fileName,
      size: doc.fileSize || 0,
      sourceFile: null,
      arrayBuffer: null,
      fileHandle,
      doc,
      error: null,
      undoStack: [],
      redoStack: [],
      selectedId: doc.datasetNodes[0]?.id || doc.metaNodes[0]?.id || null,
      expandedIds: buildDefaultExpandedIds(doc),
    };

    if (append && this.files.length > 0) {
      this.files.push(entry);
      if (!this._userToggledFileList && this.files.length > 1) this.showFileList = true;
    } else {
      this.files = [entry];
      this.showFileList = false;
      this._userToggledFileList = false;
      this.viewMode = 'tree';
      this.compareFileAId = null;
      this.compareFileBId = null;
      this.workspaceVersion++;
    }

    this.compareMode = false;
    this._bindEntryToActive(entry);
    this.searchQuery = '';
    this.filterMode = 'all';
    this.mobileTab = 'tree';
    this.pixelVersion++;
    this.emit('document');
  }

  /**
   * Register one or multiple files (File / ArrayBuffer / FileSystemFileHandle) with lazy parsing.
   * Defaults to appending to existing open files, checking candidate duplicates by identity or contents,
   * and activating the first newly added file (or switching to the existing duplicate).
   * @param {Array<{ name: string, size?: number, sourceFile?: File, arrayBuffer?: ArrayBuffer, fileHandle?: any }>} items
   * @param {{ append?: boolean }} [opts]
   */
  async loadFileItems(items, { append = true } = {}) {
    if (!items || items.length === 0) return { loadedCount: 0, addedCount: 0, totalCount: this.files.length };
    const opToken = ++this._activeOpToken;
    const startWorkspaceVersion = this.workspaceVersion;
    this._saveActiveSnapshot();

    const hadExisting = append && this.files.length > 0;
    const newEntries = [];
    let firstExistingMatch = null;

    for (const it of items) {
      const size = it.size ?? it.sourceFile?.size ?? it.arrayBuffer?.byteLength ?? 0;
      let duplicate = null;
      for (const entry of hadExisting ? this.files.slice() : []) {
        if (entry.name === it.name && entry.size === size && await isSameFile(entry, it)) {
          duplicate = entry;
          break;
        }
      }
      if (opToken !== this._activeOpToken || startWorkspaceVersion !== this.workspaceVersion) {
        return { loadedCount: 0, addedCount: 0, totalCount: this.files.length, stale: true };
      }
      if (duplicate) {
        firstExistingMatch ??= duplicate;
        continue;
      }
      newEntries.push({
        id: nextFileId(),
        name: it.name,
        size,
        sourceFile: it.sourceFile || null,
        arrayBuffer: it.arrayBuffer || null,
        fileHandle: it.fileHandle || null,
        doc: null,
        error: null,
        undoStack: [],
        redoStack: [],
        selectedId: null,
        expandedIds: new Set(),
      });
    }

    if (opToken !== this._activeOpToken || startWorkspaceVersion !== this.workspaceVersion) {
      return { loadedCount: 0, addedCount: 0, totalCount: this.files.length, stale: true };
    }

    // All dropped/selected files were already open -> switch to the existing entry
    if (hadExisting && newEntries.length === 0 && firstExistingMatch) {
      if (!this.files.includes(firstExistingMatch)) {
        return { loadedCount: 0, addedCount: 0, totalCount: this.files.length, stale: true };
      }
      await this.switchToFile(firstExistingMatch.id);
      if (this.activeFileId !== firstExistingMatch.id) {
        return { loadedCount: 0, addedCount: 0, totalCount: this.files.length, stale: true };
      }
      return {
        loadedCount: 0,
        addedCount: 0,
        totalCount: this.files.length,
        alreadyOpenEntry: firstExistingMatch,
      };
    }

    if (hadExisting) {
      this.files.push(...newEntries);
    } else {
      this.files = newEntries;
      this.viewMode = 'tree';
      this.compareFileAId = null;
      this.compareFileBId = null;
      this.workspaceVersion++;
    }
    const loadWorkspaceVersion = this.workspaceVersion;

    if (!this._userToggledFileList && this.files.length > 1) {
      this.showFileList = true;
    } else if (!hadExisting) {
      this.showFileList = false;
      this._userToggledFileList = false;
    }

    // Parse and activate the first newly added valid file
    let activated = null;
    let firstError = null;
    const failedEntries = [];
    for (const entry of newEntries) {
      try {
        await this.ensureEntryParsed(entry);
        activated = entry;
        break;
      } catch (err) {
        if (!firstError) firstError = err;
        failedEntries.push({ fileName: entry.name, size: entry.size, error: err });
      }
    }

    const isStale = opToken !== this._activeOpToken || loadWorkspaceVersion !== this.workspaceVersion;

    if (!activated) {
      const failedSet = new Set(newEntries);
      if (isStale) {
        const hadFailedInCurrent = this.files.some((f) => failedSet.has(f));
        if (hadFailedInCurrent) {
          this.files = this.files.filter((f) => !failedSet.has(f));
          if (this.files.length <= 1) {
            this.showFileList = false;
            this.compareMode = false;
            this.compareFileAId = null;
            this.compareFileBId = null;
          }
          this.emit('files');
        }
      } else if (!hadExisting) {
        this._resetEmptyWorkspace();
      } else {
        this.files = this.files.filter((f) => !failedSet.has(f));
        if (this.files.length <= 1) {
          this.showFileList = false;
          this.compareMode = false;
          this.compareFileAId = null;
          this.compareFileBId = null;
        }
        this.emit('files');
      }
      const finalErr = firstError || new Error('Failed to parse DICOM file(s).');
      finalErr.failures = failedEntries;
      if (isStale) finalErr.stale = true;
      throw finalErr;
    }

    const canRecoverSameWorkspace =
      loadWorkspaceVersion === this.workspaceVersion &&
      !this.doc &&
      !this.activeFileId &&
      this.files.includes(activated);

    if ((isStale && !canRecoverSameWorkspace) || !this.files.includes(activated)) {
      if (this.files.includes(activated)) {
        this.emit('files');
      }
      return {
        loadedCount: newEntries.length,
        addedCount: newEntries.length,
        wasAppended: hadExisting,
        totalCount: this.files.length,
        activeEntry: this.getActiveEntry(),
        failedEntries,
        stale: true,
      };
    }

    this.compareMode = false;
    this._bindEntryToActive(activated);
    this.searchQuery = '';
    this.filterMode = 'all';
    this.mobileTab = 'tree';
    this.pixelVersion++;
    this.emit('document');
    return {
      loadedCount: newEntries.length,
      addedCount: newEntries.length,
      wasAppended: hadExisting,
      totalCount: this.files.length,
      activeEntry: activated,
      failedEntries,
    };
  }

  /**
   * Switch active file in the multi-file list (lazy-parsing if needed).
   * Cancels stale in-flight switches and exits Compare mode cleanly.
   */
  async switchToFile(fileId) {
    const target = this.files.find((f) => f.id === fileId);
    if (!target) return;

    const opToken = ++this._activeOpToken;
    if (this.activeFileId === fileId) {
      if (this.compareMode) {
        this.compareMode = false;
        this.emit('compare');
      }
      return;
    }

    this._saveActiveSnapshot();
    await this.ensureEntryParsed(target);
    if (opToken !== this._activeOpToken || !this.files.includes(target)) return;
    this._saveActiveSnapshot();
    this.compareMode = false;
    this._bindEntryToActive(target);
    this.pixelVersion++;
    this.emit('document');
  }

  _resetEmptyWorkspace() {
    this.files = [];
    this.showFileList = false;
    this._userToggledFileList = false;
    this.viewMode = 'tree'; // 'tree' | 'sr' | 'raw' | 'compare'
    this.compareFileAId = null;
    this.compareFileBId = null;
    this.searchQuery = '';
    this.filterMode = 'all';
    this.mobileTab = 'tree';
    this.workspaceVersion++;
    this._bindEntryToActive(null);
    this.pixelVersion++;
    this.emit('document');
  }

  /**
   * Remove a file from the open files list.
   */
  async removeFile(fileId) {
    const idx = this.files.findIndex((f) => f.id === fileId);
    if (idx < 0) return;

    const wasActive = this.activeFileId === fileId;
    this.files.splice(idx, 1);

    if (this.files.length <= 1) {
      this.showFileList = false;
      this._userToggledFileList = false;
      this.compareMode = false;
      this.compareFileAId = null;
      this.compareFileBId = null;
    } else if (this.compareMode) {
      if (this.compareFileAId === fileId) {
        this.compareFileAId = (this.files.find((f) => f.id !== this.compareFileBId) || this.files[0]).id;
      }
      if (this.compareFileBId === fileId) {
        this.compareFileBId = (this.files.find((f) => f.id !== this.compareFileAId) || this.files[0]).id;
      }
    }

    if (this.files.length === 0) {
      this._activeOpToken++;
      this._resetEmptyWorkspace();
      return;
    }

    if (wasActive) {
      const opToken = ++this._activeOpToken;
      // Unbind removed file immediately so no edits hit a detached zombie document during async parse.
      this._bindEntryToActive(null);
      // Prefer a nearby file and continue past entries that cannot be parsed.
      const next = this.files.slice(idx).concat(this.files.slice(0, idx).reverse());
      let active = null;
      const fallbackErrors = [];
      for (const entry of next) {
        try {
          await this.ensureEntryParsed(entry);
          if (opToken !== this._activeOpToken) return { fallbackErrors };
          if (this.files.includes(entry)) {
            active = entry;
            break;
          }
        } catch (err) {
          if (opToken !== this._activeOpToken) return { fallbackErrors };
          fallbackErrors.push({ fileName: entry.name, size: entry.size, error: err });
          continue;
        }
      }
      if (opToken !== this._activeOpToken) return { fallbackErrors };
      if (!active) {
        this._resetEmptyWorkspace();
        return { fallbackErrors };
      }
      this._bindEntryToActive(active);
      this.pixelVersion++;
      this.emit('document');
      return { fallbackErrors };
    } else {
      this.emit('files');
      return { fallbackErrors: [] };
    }
  }

  /**
   * Reorder an open file tab/entry relative to another entry.
   */
  reorderFile(fromId, toId, insertAfter = false) {
    if (!fromId || !toId || fromId === toId) return;
    const fromIdx = this.files.findIndex((f) => f.id === fromId);
    const toIdx = this.files.findIndex((f) => f.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = this.files.splice(fromIdx, 1);
    let targetIdx = this.files.findIndex((f) => f.id === toId);
    if (targetIdx < 0) {
      this.files.push(moved);
    } else {
      if (insertAfter) targetIdx += 1;
      this.files.splice(targetIdx, 0, moved);
    }
    this.emit('files');
  }

  /**
   * Remove multiple files at once (e.g. "Close Others" or "Close to the Right").
   */
  async removeFiles(fileIds) {
    const idSet = new Set(fileIds || []);
    if (idSet.size === 0) return;

    const wasActive = idSet.has(this.activeFileId);
    const firstRemovedIdx = this.files.findIndex((f) => idSet.has(f.id));
    this.files = this.files.filter((f) => !idSet.has(f.id));

    if (this.files.length <= 1) {
      this.showFileList = false;
      this._userToggledFileList = false;
      this.compareMode = false;
      this.compareFileAId = null;
      this.compareFileBId = null;
    } else if (this.compareMode) {
      const validIds = new Set(this.files.map((f) => f.id));
      if (!validIds.has(this.compareFileAId)) {
        this.compareFileAId = (this.files.find((f) => f.id !== this.compareFileBId) || this.files[0]).id;
      }
      if (!validIds.has(this.compareFileBId)) {
        this.compareFileBId = (this.files.find((f) => f.id !== this.compareFileAId) || this.files[0]).id;
      }
    }

    if (this.files.length === 0) {
      this._activeOpToken++;
      this._resetEmptyWorkspace();
      return;
    }

    if (wasActive) {
      const opToken = ++this._activeOpToken;
      this._bindEntryToActive(null);
      const idx = Math.max(0, Math.min(firstRemovedIdx, this.files.length - 1));
      const next = this.files.slice(idx).concat(this.files.slice(0, idx).reverse());
      let active = null;
      const fallbackErrors = [];
      for (const entry of next) {
        try {
          await this.ensureEntryParsed(entry);
          if (opToken !== this._activeOpToken) return { fallbackErrors };
          if (this.files.includes(entry)) {
            active = entry;
            break;
          }
        } catch (err) {
          if (opToken !== this._activeOpToken) return { fallbackErrors };
          fallbackErrors.push({ fileName: entry.name, size: entry.size, error: err });
          continue;
        }
      }
      if (opToken !== this._activeOpToken) return { fallbackErrors };
      if (!active) {
        this._resetEmptyWorkspace();
        return { fallbackErrors };
      }
      this._bindEntryToActive(active);
      this.pixelVersion++;
      this.emit('document');
      return { fallbackErrors };
    } else {
      this.emit('files');
      return { fallbackErrors: [] };
    }
  }

  /**
   * Count total unsaved tag modifications across all open files.
   */
  getTotalUnsavedChanges() {
    this._saveActiveSnapshot();
    let total = 0;
    for (const entry of this.files) {
      if (entry.doc) total += countDocChanges(entry.doc);
    }
    return total;
  }

  /**
   * Reset all loaded files and return to the initial welcome screen.
   */
  closeAll() {
    this._activeOpToken++;
    this._resetEmptyWorkspace();
  }

  selectNode(id) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit('selection');
  }

  toggleExpand(id) {
    if (this.expandedIds.has(id)) this.expandedIds.delete(id);
    else this.expandedIds.add(id);
    this.emit('tree');
  }

  expandAll() {
    if (!this.doc) return;
    this.expandedIds.add('__meta__');
    this.expandedIds.add('__main__');
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.isSequence) {
          this.expandedIds.add(n.id);
          for (const item of n.items || []) {
            this.expandedIds.add(item.id);
            walk(item.children);
          }
        }
      }
    };
    walk(this.doc.metaNodes);
    walk(this.doc.datasetNodes);
    this.emit('tree');
  }

  collapseAll() {
    this.expandedIds = new Set(['__main__']);
    this.emit('tree');
  }

  setSearchQuery(q) {
    this.searchQuery = q;
    this.emit('filter');
  }

  setFilterMode(mode) {
    this.filterMode = mode;
    this.emit('filter');
  }

  /**
   * Find a node by ID across Meta and Main Dataset (recursively in SQ items).
   * Returns node info along with clickable breadcrumb objects.
   */
  findNodeInfo(targetId) {
    if (!this.doc || !targetId) return null;

    const searchList = (list, path, crumbs, section, inheritedCharsetNode = null, ancestorDeleted = false) => {
      const charsetNode = list.find((n) => n.tag === '00080005' && n.status !== 'deleted') || inheritedCharsetNode;
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.id === targetId) {
          return {
            node,
            parentList: list,
            index: i,
            path: [...path, node.formattedTag],
            breadcrumbs: [...crumbs, { id: node.id, label: node.formattedTag }],
            section,
            charsetNode,
            ancestorDeleted,
          };
        }
        if (node.isSequence && node.items) {
          const nextAncestorDeleted = ancestorDeleted || node.status === 'deleted';
          for (let j = 0; j < node.items.length; j++) {
            const item = node.items[j];
            const seqCrumb = { id: node.id, label: `${node.formattedTag} ${node.keyword}` };
            const itemCrumb = { id: item.id, label: `Item #${j}` };
            if (item.id === targetId) {
              return {
                isSeqItem: true,
                item,
                parentSeq: node,
                itemIndex: j,
                path: [...path, node.formattedTag, `Item #${j}`],
                breadcrumbs: [...crumbs, seqCrumb, itemCrumb],
                section,
                ancestorDeleted: nextAncestorDeleted,
              };
            }
            const found = searchList(
              item.children || [],
              [...path, `${node.formattedTag} ${node.keyword}`, `Item #${j}`],
              [...crumbs, seqCrumb, itemCrumb],
              section,
              charsetNode,
              nextAncestorDeleted
            );
            if (found) return found;
          }
        }
      }
      return null;
    };

    return (
      searchList(this.doc.metaNodes, ['File Meta (0002)'], [{ id: null, label: 'File Meta (0002)' }], 'meta') ||
      searchList(this.doc.datasetNodes, ['Main Dataset'], [{ id: null, label: 'Main Dataset' }], 'main')
    );
  }

  _isListUnderDeletedSeq(targetList) {
    if (!this.doc || !targetList) return false;
    const walk = (nodes, deleted) => {
      for (const n of nodes || []) {
        if (n.isSequence && n.items) {
          const nextDeleted = deleted || n.status === 'deleted';
          for (const item of n.items) {
            if (item.children === targetList) return nextDeleted;
            if (walk(item.children, nextDeleted)) return true;
          }
        }
      }
      return false;
    };
    return walk(this.doc.metaNodes, false) || walk(this.doc.datasetNodes, false);
  }

  getSpecificCharacterSet() {
    const info = this.findNodeInfo(this.selectedId);
    return info?.charsetNode?.value ?? '';
  }

  _isPixelDisplayTag(hex) {
    return hex.startsWith('0028') || hex === '7FE00010' || hex === '00020010' ||
      hex === '52009229' || hex === '52009230' || /^60[01][02468ACE]/i.test(hex);
  }

  getDocumentRevision(doc) {
    return this._revisions.get(doc) ?? 0;
  }

  _noteEdit(doc) {
    if (doc.hasPart10Header) {
      const sop = doc.datasetNodes.find((n) => n.tag === '00080018' && n.status !== 'deleted');
      const uid = sop && sop.status !== 'unchanged' ? sop.value.trim() : '';
      if (uid) {
        this._syncMediaStorageSopInstanceUid(doc, uid);
      } else {
        const metaNode = doc.metaNodes.find((n) => n.tag === '00020003');
        if (metaNode && metaNode.value !== metaNode.originalValue) {
          metaNode.value = metaNode.originalValue;
          metaNode.status = 'unchanged';
          metaNode.validation = validateVrValue('UI', metaNode.originalValue);
        }
      }
      this._syncMediaStorageSopClassUid(doc);
    }
    this._revisions.set(doc, this.getDocumentRevision(doc) + 1);
  }

  // Mirror an edited SOP Class UID (0008,0016) into (0002,0002) like the writer does on save, so the
  // editor and QA don't show a stale mismatch. A direct edit of (0002,0002) is left alone.
  _syncMediaStorageSopClassUid(doc) {
    const metaNode = doc.metaNodes.find((n) => n.tag === '00020002');
    if (!metaNode) return;
    const cls = doc.datasetNodes.find((n) => n.tag === '00080016' && n.status !== 'deleted');
    const uid = cls && cls.status !== 'unchanged' ? String(cls.value || '').trim() : '';
    const isDicomDir = metaNode.originalValue?.trim() === '1.2.840.10008.1.3.10';
    if (uid && !isDicomDir) {
      if (metaNode.value === uid) return;
      metaNode.value = uid;
      metaNode.status = uid === metaNode.originalValue ? 'unchanged' : 'modified';
      metaNode.validation = validateVrValue('UI', uid);
      metaNode._syncedFromMain = true;
    } else if (metaNode._syncedFromMain) {
      metaNode.value = metaNode.originalValue;
      metaNode.status = 'unchanged';
      metaNode.validation = validateVrValue('UI', metaNode.originalValue);
      metaNode._syncedFromMain = false;
    }
  }

  _syncMediaStorageSopInstanceUid(doc, uid) {
    const node = doc.metaNodes.find((n) => n.tag === '00020003');
    if (!node || node.value === uid) return;
    node.value = uid;
    node.status = uid === node.originalValue ? 'unchanged' : 'modified';
    node.validation = validateVrValue('UI', uid);
  }

  _executeCommand(cmd) {
    cmd.redo();
    this._noteEdit(this.doc);
    this.undoStack.push(cmd);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastEditedNodeId = cmd.editedNodeId || null;
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  endUndoCoalescing(doc = this.doc) {
    const stack = doc === this.doc
      ? this.undoStack
      : this.files.find((entry) => entry.doc === doc)?.undoStack;
    const top = stack?.at(-1);
    if (top) top.coalesceKey = null;
  }

  undo() {
    if (this.isBusy) return;
    this.endUndoCoalescing();
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.endUndoCoalescing();
    cmd.undo();
    this._noteEdit(this.doc);
    this.redoStack.push(cmd);
    this.lastEditedNodeId = null;
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  redo() {
    if (this.isBusy) return;
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.endUndoCoalescing();
    cmd.redo();
    this._noteEdit(this.doc);
    this.undoStack.push(cmd);
    this.lastEditedNodeId = null;
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  updateNodeValue(nodeId, newValue, { coalesce = false } = {}) {
    if (this.isBusy) return false;
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || !canEditNodeValue(info.node, info)) return false;

    const node = info.node;
    if (node.value === newValue) return false;

    const applyVal = (val, keepAdded) => {
      node.value = val;
      node.status = keepAdded && node.status === 'added'
        ? 'added'
        : val === node.originalValue
          ? 'unchanged'
          : 'modified';
      node.validation = validateVrValue(node.vr, val, node.tag);
    };

    const affectsPixel = this._isPixelDisplayTag(node.tag);
    const now = Date.now();
    const top = coalesce ? this.undoStack[this.undoStack.length - 1] : null;
    const coalesceKey = `edit:${node.id}`;
    if (top && top.coalesceKey === coalesceKey && now - top.timestamp < UNDO_COALESCE_MS) {
      top.nextValue = newValue;
      top.timestamp = now;
      applyVal(newValue, true);
      this._noteEdit(this.doc);
      this.redoStack = [];
      this.lastEditedNodeId = node.id;
      if (affectsPixel) this.pixelVersion++;
      this._saveActiveSnapshot();
      this.emit('edit');
      return true;
    }

    const prevValue = node.value;
    const cmd = {
      label: `Edit ${node.formattedTag}`,
      affectsPixel,
      editedNodeId: node.id,
      coalesceKey: coalesce ? coalesceKey : null,
      timestamp: now,
      nextValue: newValue,
      redo: () => applyVal(cmd.nextValue, true),
      undo: () => applyVal(prevValue, true),
    };
    this._executeCommand(cmd);
    return true;
  }

  revertNode(nodeId) {
    if (this.isBusy) return;
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || info.ancestorDeleted || getReadOnlyTagMessage(info.node.tag)) return;
    const node = info.node;

    if (node.status === 'added') {
      const { parentList } = info;
      this._executeCommand({
        label: `Remove added ${node.formattedTag}`,
        affectsPixel: this._isPixelDisplayTag(node.tag),
        redo: () => {
          this._deleteNode(node, parentList);
          if (this.selectedId === node.id) this.selectedId = null;
        },
        undo: () => {
          this._restoreNode(node, parentList);
          this.selectedId = node.id;
        },
      });
      return;
    }

    const prevValue = node.value;
    const prevStatus = node.status;
    const prevItems = node.items;
    const originalValue = node.originalValue;
    const originalItems = this._sequenceBaselines.get(node);
    if (prevValue === originalValue && prevStatus === 'unchanged') return;

    const { parentList } = info;
    const apply = (value, items) => {
      node.value = value;
      if (originalItems) node.items = items;
      this._restoreNode(node, parentList);
      node.validation = node.isBinary || node.isSequence
        ? { valid: true, severity: 'ok', messages: [] }
        : validateVrValue(node.vr, value, node.tag);
    };

    this._executeCommand({
      label: `Revert ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: () => apply(originalValue, originalItems),
      undo: () => {
        apply(prevValue, prevItems);
        if (prevStatus === 'deleted') this._deleteNode(node, parentList);
      },
    });
  }

  _restoreNode(node, list) {
    if (!list.includes(node)) {
      node.status = 'added';
      insertSorted(list, node);
    } else if (node.status !== 'added') {
      node.status = node.value === node.originalValue ? this._sequenceStatus(node) : 'modified';
    }
  }

  _deleteNode(node, list) {
    if (node.status === 'added') {
      const idx = list.indexOf(node);
      if (idx >= 0) list.splice(idx, 1);
    } else {
      node.status = 'deleted';
    }
  }

  toggleDeleteNode(nodeId) {
    if (this.isBusy) return;
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || info.ancestorDeleted) return;
    const node = info.node;
    if (getReadOnlyTagMessage(node.tag)) return;

    if (node.status === 'added') {
      this.revertNode(nodeId);
      return;
    }

    const { parentList } = info;
    const prevStatus = node.status;
    if (
      prevStatus === 'deleted' &&
      parentList.some((n) => n !== node && n.tag === node.tag && n.status !== 'deleted')
    ) {
      return;
    }
    const deleting = prevStatus !== 'deleted';
    const restoreNode = () => this._restoreNode(node, parentList);
    const deleteNode = () => this._deleteNode(node, parentList);

    this._executeCommand({
      label: `${deleting ? 'Delete' : 'Restore'} ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: deleting ? deleteNode : restoreNode,
      undo: deleting ? restoreNode : deleteNode,
    });
  }

  addTag({ group, element, vr, value, targetList = null, targetSection = null }) {
    if (!this.doc || this.isBusy) return null;
    const hex = tagHex(group, element);
    if (getReadOnlyTagMessage(hex)) return { locked: true };
    if (targetList && group === 0x0002) {
      return { invalidLocation: 'metaTagInSequenceErr' };
    }
    if (!targetList && group === 0x0002 && !this.doc.hasPart10Header) {
      return { invalidLocation: 'metaTagNoPart10Err' };
    }
    if (targetList && this._isListUnderDeletedSeq(targetList)) {
      return { invalidLocation: 'deletedSeqEditErr' };
    }
    const dict = lookupTag(group, element);
    const isMeta = targetList ? targetSection === 'meta' : group === 0x0002;
    const list = targetList || (isMeta ? this.doc.metaNodes : this.doc.datasetNodes);

    const existing = list.find((n) => n.tag === hex && n.status !== 'deleted');
    if (existing) {
      this.selectedId = existing.id;
      this.emit('selection');
      return { duplicate: true, node: existing };
    }

    const deletedExisting = list.find(
      (n) => n.tag === hex && n.status === 'deleted' && !n.isSequence && !n.isBinary && n.vr === vr
    );
    if (deletedExisting) {
      const prevValue = deletedExisting.value;
      const nextVal = value ?? '';
      this._executeCommand({
        label: `Restore & Edit ${deletedExisting.formattedTag}`,
        affectsPixel: this._isPixelDisplayTag(hex),
        redo: () => {
          deletedExisting.value = nextVal;
          if (!list.includes(deletedExisting)) {
            deletedExisting.status = 'added';
            insertSorted(list, deletedExisting);
          } else {
            deletedExisting.status = nextVal === deletedExisting.originalValue ? 'unchanged' : 'modified';
          }
          deletedExisting.validation = validateVrValue(deletedExisting.vr, nextVal, deletedExisting.tag);
          this.selectedId = deletedExisting.id;
        },
        undo: () => {
          deletedExisting.value = prevValue;
          if (deletedExisting.status === 'added') {
            const idx = list.indexOf(deletedExisting);
            if (idx >= 0) list.splice(idx, 1);
          } else {
            deletedExisting.status = 'deleted';
          }
          deletedExisting.validation = validateVrValue(deletedExisting.vr, prevValue, deletedExisting.tag);
        },
      });
      return { duplicate: false, node: deletedExisting };
    }

    const isSeq = vr === 'SQ';
    const isBin = BINARY_VRS.has(vr);
    const newNode = {
      id: genNodeId(),
      group,
      element,
      tag: hex,
      formattedTag: formatTag(group, element),
      keyword: dict.keyword,
      name: dict.name,
      vr,
      vrSource: 'explicit',
      vmSpec: dict.vm,
      isMeta,
      isPrivate: (group & 1) === 1,
      isSequence: isSeq,
      isBinary: isBin,
      encapsulated: false,
      undefinedLength: false,
      rawLength: 0,
      rawBytes: isBin ? new Uint8Array(0) : null,
      originalValue: '',
      value: isSeq ? '' : (value ?? ''),
      items: isSeq ? [{ id: genNodeId(), undefinedLength: false, children: [] }] : undefined,
      status: 'added',
      validation: isSeq || isBin
        ? { valid: true, severity: 'ok', messages: [] }
        : validateVrValue(vr, value ?? '', hex),
    };

    this._executeCommand({
      label: `Add ${newNode.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(hex),
      redo: () => {
        if (!list.includes(newNode)) {
          newNode.status = 'added';
          insertSorted(list, newNode);
        } else if (newNode.status === 'deleted') {
          newNode.status = newNode.value === newNode.originalValue ? 'unchanged' : 'modified';
        }
        this.selectedId = newNode.id;
        if (isSeq) {
          this.expandedIds.add(newNode.id);
          this.expandedIds.add(newNode.items[0].id);
        }
      },
      undo: () => {
        if (newNode.status === 'added') {
          const idx = list.indexOf(newNode);
          if (idx >= 0) list.splice(idx, 1);
          if (this.selectedId === newNode.id) this.selectedId = null;
        } else {
          newNode.status = 'deleted';
        }
      },
    });

    return { duplicate: false, node: newNode };
  }

  _sequenceStatus(node) {
    const baseline = this._sequenceBaselines.get(node);
    if (!baseline) return 'unchanged';
    return node.items.length === baseline.length && node.items.every((item, index) => item === baseline[index])
      ? 'unchanged'
      : 'modified';
  }

  getOriginalSequenceItemCount(node) {
    const baseline = this._sequenceBaselines.get(node);
    return baseline ? baseline.length : (node.items || []).length;
  }

  addSequenceItem(seqNodeId) {
    if (this.isBusy) return;
    const info = this.findNodeInfo(seqNodeId);
    if (!info || info.isSeqItem || info.ancestorDeleted || !info.node.isSequence || info.node.status === 'deleted') return;
    const seqNode = info.node;
    const newItem = { id: genNodeId(), undefinedLength: false, children: [] };
    const prevItems = seqNode.items || [];
    if (!this._sequenceBaselines.has(seqNode)) this._sequenceBaselines.set(seqNode, prevItems);

    this._executeCommand({
      label: `Add Item to ${seqNode.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(seqNode.tag),
      redo: () => {
        if (!this._sequenceBaselines.has(seqNode)) this._sequenceBaselines.set(seqNode, seqNode.items || []);
        seqNode.items = [...prevItems, newItem];
        seqNode.status = seqNode.status === 'added' ? 'added' : this._sequenceStatus(seqNode);
        this.expandedIds.add(seqNode.id);
        this.expandedIds.add(newItem.id);
        this.selectedId = newItem.id;
      },
      undo: () => {
        if (!this._sequenceBaselines.has(seqNode)) this._sequenceBaselines.set(seqNode, seqNode.items || []);
        seqNode.items = prevItems;
        seqNode.status = seqNode.status === 'added' ? 'added' : this._sequenceStatus(seqNode);
        if (this.selectedId === newItem.id) this.selectedId = seqNode.id;
      },
    });
  }

  removeSequenceItem(itemId) {
    if (this.isBusy) return;
    const info = this.findNodeInfo(itemId);
    if (!info || !info.isSeqItem || info.ancestorDeleted) return;
    const { parentSeq, item, itemIndex } = info;
    if (parentSeq.status === 'deleted') return;
    const prevItems = parentSeq.items;
    if (!this._sequenceBaselines.has(parentSeq)) this._sequenceBaselines.set(parentSeq, prevItems);
    const nextItems = prevItems.filter((entry) => entry !== item);

    this._executeCommand({
      label: `Remove Item #${itemIndex} from ${parentSeq.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(parentSeq.tag),
      redo: () => {
        if (!this._sequenceBaselines.has(parentSeq)) this._sequenceBaselines.set(parentSeq, parentSeq.items || []);
        parentSeq.items = nextItems;
        parentSeq.status = parentSeq.status === 'added' ? 'added' : this._sequenceStatus(parentSeq);
        if (this.selectedId === item.id) this.selectedId = parentSeq.id;
      },
      undo: () => {
        if (!this._sequenceBaselines.has(parentSeq)) this._sequenceBaselines.set(parentSeq, parentSeq.items || []);
        parentSeq.items = prevItems;
        parentSeq.status = parentSeq.status === 'added' ? 'added' : this._sequenceStatus(parentSeq);
        this.expandedIds.add(parentSeq.id);
        this.selectedId = item.id;
      },
    });
  }

  ensureUtf8Charset() {
    if (!this.doc || this.isBusy) return;
    const info = this.findNodeInfo(this.selectedId);
    const existing = info?.charsetNode || this.doc.datasetNodes.find((n) => n.tag === '00080005');
    if (existing) {
      if (existing.status === 'deleted') {
        const list = this.doc.datasetNodes;
        const prevValue = existing.value;
        this._executeCommand({
          label: 'Set UTF-8 SpecificCharacterSet',
          affectsPixel: false,
          redo: () => {
            existing.value = 'ISO_IR 192';
            if (!list.includes(existing)) {
              existing.status = 'added';
              insertSorted(list, existing);
            } else {
              existing.status = existing.value === existing.originalValue ? 'unchanged' : 'modified';
            }
            existing.validation = validateVrValue(existing.vr, 'ISO_IR 192', existing.tag);
          },
          undo: () => {
            existing.value = prevValue;
            if (existing.status === 'added') {
              const idx = list.indexOf(existing);
              if (idx >= 0) list.splice(idx, 1);
            } else {
              existing.status = 'deleted';
            }
            existing.validation = validateVrValue(existing.vr, prevValue, existing.tag);
          },
        });
      } else {
        this.updateNodeValue(existing.id, 'ISO_IR 192');
      }
    } else {
      this.addTag({ group: 0x0008, element: 0x0005, vr: 'CS', value: 'ISO_IR 192' });
    }
  }

  /**
   * Internal helper: build an undoable anonymization command for any given doc.
   * Supports recursive PHI presets (replace/empty/remove), Private tag stripping,
   * consistent UID regeneration while preserving class and encoding identifiers, and deidentified flag.
   */
  _buildAnonymizeCommandForDoc(doc, rules, opts = {}) {
    const {
      markDeidentified = false,
      methodText = '',
      stripPrivate = false,
      regenerateUids = false,
      shiftDates = false,
      dateShiftDays = 0,
      sharedUidMap = new Map(),
      onDateSkipped,
    } = opts;

    const ruleMap = new Map(
      (rules || []).map((r) => [
        r.tag,
        {
          action: r.action || 'replace',
          replacement: r.replacement ?? '',
        },
      ])
    );
    const snapshots = [];
    const removedNodes = [];
    const restoredDeletes = [];
    const scrubFileMeta = doc.hasPart10Header && (
      ruleMap.size > 0 || markDeidentified || stripPrivate || regenerateUids || (shiftDates && dateShiftDays)
    );
    let dateShiftCount = 0;
    let uidChangeCount = 0;
    let privateDeleteCount = 0;

    const mapSingleUid = (raw) => {
      const trimmed = String(raw || '').trim();
      if (!trimmed || isWellKnownDicomUid(trimmed)) return raw;
      if (sharedUidMap.has(trimmed)) return sharedUidMap.get(trimmed);
      const next = generateDicomUid();
      sharedUidMap.set(trimmed, next);
      return next;
    };

    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.status === 'deleted') continue;

        if (stripPrivate && n.isPrivate) {
          removedNodes.push({ node: n, parentList: nodes });
          privateDeleteCount++;
          continue;
        }

        if (scrubFileMeta && nodes === doc.metaNodes && getPhiTagInfo(n.tag)?.action === 'X') {
          removedNodes.push({ node: n, parentList: nodes });
          continue;
        }

        const rule = ruleMap.get(n.tag);
        if (rule && rule.action === 'remove' && !getReadOnlyTagMessage(n.tag)) {
          removedNodes.push({ node: n, parentList: nodes });
          continue;
        }

        if (n.isSequence) {
          for (const item of n.items || []) walk(item.children);
          continue;
        }
        if (n.isBinary || getReadOnlyTagMessage(n.tag)) continue;

        let nextVal = rule
          ? rule.action === 'empty'
            ? ''
            : rule.replacement
          : undefined;
        let isDateShift = false;
        let isUidChange = false;

        const isClassUid = n.keyword?.includes('SOPClass') || n.tag === '00020012';
        if (regenerateUids && !rule && !isClassUid && n.vr === 'UI' && n.value) {
          const remapped = String(n.value)
            .split('\\')
            .map(mapSingleUid)
            .join('\\');
          if (remapped !== n.value) {
            nextVal = remapped;
            isUidChange = true;
          }
        }

        if (
          nextVal === undefined &&
          shiftDates &&
          dateShiftDays &&
          (n.vr === 'DA' || n.vr === 'DT') &&
          n.value
        ) {
          const shifted = shiftDicomDateValue(n.value, n.vr, dateShiftDays, onDateSkipped);
          if (shifted !== n.value) {
            nextVal = shifted;
            isDateShift = true;
          }
        }

        if (nextVal !== undefined && n.value !== nextVal) {
          if (isDateShift) dateShiftCount++;
          if (isUidChange) uidChangeCount++;
          snapshots.push({
            node: n,
            prevValue: n.value,
            nextValue: nextVal,
          });
        }
      }
    };
    walk(doc.metaNodes);
    walk(doc.datasetNodes);

    const addedNodes = [];
    const upsertRootTag = (group, element, hex, vr, targetVal) => {
      const existing = doc.datasetNodes.find((n) => n.tag === hex && n.status !== 'deleted');
      if (existing) {
        if (existing.value !== targetVal) {
          snapshots.push({
            node: existing,
            prevValue: existing.value,
            nextValue: targetVal,
          });
        }
        return;
      }
      const deletedExisting = doc.datasetNodes.find(
        (n) => n.tag === hex && n.status === 'deleted' && !n.isSequence && !n.isBinary
      );
      if (deletedExisting) {
        restoredDeletes.push({
          node: deletedExisting,
          parentList: doc.datasetNodes,
          prevValue: deletedExisting.value,
          nextValue: targetVal,
        });
        return;
      }
      const dict = lookupTag(group, element);
      addedNodes.push({
        id: genNodeId(),
        group,
        element,
        tag: hex,
        formattedTag: formatTag(group, element),
        keyword: dict.keyword,
        name: dict.name,
        vr,
        vrSource: 'explicit',
        vmSpec: dict.vm || '1',
        isMeta: false,
        isPrivate: false,
        isSequence: false,
        isBinary: false,
        encapsulated: false,
        undefinedLength: false,
        rawLength: 0,
        rawBytes: null,
        originalValue: '',
        value: targetVal,
        status: 'added',
        validation: validateVrValue(vr, targetVal, hex),
      });
    };

    if (markDeidentified) {
      upsertRootTag(0x0012, 0x0062, '00120062', 'CS', 'YES');
      const cleanMethod = truncateAtWordBoundary(methodText, 64);
      if (cleanMethod) {
        upsertRootTag(0x0012, 0x0063, '00120063', 'LO', cleanMethod);
      }
    }

    const tagChanges = snapshots.length + removedNodes.length + restoredDeletes.length + addedNodes.length;
    const prevDeidentified = Boolean(doc.deidentified);
    const changeCount = tagChanges || Number(markDeidentified && doc.hasPart10Header && !prevDeidentified);
    if (changeCount === 0) return null;
    const setDeidentified = (value) => {
      if (!this._savedDeidentified.has(doc)) this._savedDeidentified.set(doc, prevDeidentified);
      doc.deidentified = value;
      doc.deidentificationChanged = doc.hasPart10Header && value !== this._savedDeidentified.get(doc);
    };

    return {
      changeCount,
      breakdown: {
        tagChanges: tagChanges - dateShiftCount - uidChangeCount - privateDeleteCount,
        dateShifts: dateShiftCount,
        privateDeletes: privateDeleteCount,
        uidChanges: uidChangeCount,
        totalChanges: changeCount,
      },
      cmd: {
        label: 'Batch Anonymize',
        affectsPixel: snapshots.some(({ node }) => this._isPixelDisplayTag(node.tag)) ||
          removedNodes.some(({ node }) => this._isPixelDisplayTag(node.tag)),
        redo: () => {
          for (const s of snapshots) {
            s.node.value = s.nextValue;
            s.node.status = s.node.status === 'added'
              ? 'added'
              : s.nextValue === s.node.originalValue
                ? 'unchanged'
                : 'modified';
            s.node.validation = validateVrValue(s.node.vr, s.nextValue, s.node.tag);
          }
          for (const r of restoredDeletes) {
            r.node.value = r.nextValue;
            if (!r.parentList.includes(r.node)) {
              r.node.status = 'added';
              insertSorted(r.parentList, r.node);
            } else {
              r.node.status = r.nextValue === r.node.originalValue ? 'unchanged' : 'modified';
            }
            r.node.validation = validateVrValue(r.node.vr, r.nextValue, r.node.tag);
          }
          for (const d of removedNodes) {
            this._deleteNode(d.node, d.parentList);
          }
          for (const added of addedNodes) {
            if (!doc.datasetNodes.includes(added)) {
              added.status = 'added';
              insertSorted(doc.datasetNodes, added);
            } else if (added.status === 'deleted') {
              added.status = added.value === added.originalValue ? 'unchanged' : 'modified';
            }
          }
          setDeidentified(true);
        },
        undo: () => {
          for (const s of snapshots) {
            s.node.value = s.prevValue;
            s.node.status = s.node.status === 'added'
              ? 'added'
              : s.prevValue === s.node.originalValue
                ? 'unchanged'
                : 'modified';
            s.node.validation = validateVrValue(s.node.vr, s.prevValue, s.node.tag);
          }
          for (const r of restoredDeletes) {
            r.node.value = r.prevValue;
            if (r.node.status === 'added') {
              const idx = r.parentList.indexOf(r.node);
              if (idx >= 0) r.parentList.splice(idx, 1);
            } else {
              r.node.status = 'deleted';
            }
            r.node.validation = validateVrValue(r.node.vr, r.prevValue, r.node.tag);
          }
          for (const d of removedNodes) {
            this._restoreNode(d.node, d.parentList);
          }
          for (const added of addedNodes) {
            if (added.status === 'added') {
              const idx = doc.datasetNodes.indexOf(added);
              if (idx >= 0) doc.datasetNodes.splice(idx, 1);
            } else {
              added.status = 'deleted';
            }
          }
          setDeidentified(prevDeidentified);
        },
      },
    };
  }

  previewAnonymization(rules, opts = {}) {
    if (!this.doc) {
      return { tagChanges: 0, dateShifts: 0, privateDeletes: 0, uidChanges: 0, totalChanges: 0 };
    }
    const built = this._buildAnonymizeCommandForDoc(this.doc, rules, opts);
    return built?.breakdown || { tagChanges: 0, dateShifts: 0, privateDeletes: 0, uidChanges: 0, totalChanges: 0 };
  }

  applyAnonymization(rules, opts = {}) {
    this.lastAnonymizeDateSkips = 0;
    if (!this.doc || this.isBusy) return 0;
    let dateSkips = 0;
    const built = this._buildAnonymizeCommandForDoc(this.doc, rules, { ...opts, onDateSkipped: () => dateSkips++ });
    this.lastAnonymizeDateSkips = dateSkips;
    if (!built) return 0;
    this._executeCommand(built.cmd);
    return built.changeCount;
  }

  /**
   * Apply anonymization across ALL open files (preserving Study/Series/Reference UID consistency).
   */
  async applyAnonymizationAllFiles(rules, opts = {}) {
    if (this.isBusy) return { affectedFiles: 0, totalChanges: 0, skippedFiles: 0, dateSkips: 0 };
    this._saveActiveSnapshot();
    this.anonymizing = true;
    try {
      this.emit('files');
      const entries = [];
      let skippedFiles = 0;
      for (const entry of this.files.slice()) {
        try {
          await this.ensureEntryParsed(entry);
          entries.push(entry);
        } catch {
          skippedFiles++;
        }
      }

      const openEntries = entries.filter((entry) => this.files.includes(entry));
      const sharedUidMap = new Map();
      let dateSkips = 0;
      const onDateSkipped = () => dateSkips++;
      const edits = openEntries.map((entry) => ({
        entry,
        built: this._buildAnonymizeCommandForDoc(entry.doc, rules, { ...opts, sharedUidMap, onDateSkipped }),
      }));
      let affectedFiles = 0;
      let totalChanges = 0;
      for (const { entry, built } of edits) {
        if (!built) continue;
        built.cmd.redo();
        this._noteEdit(entry.doc);
        entry.undoStack.push(built.cmd);
        if (entry.undoStack.length > 200) entry.undoStack.shift();
        entry.redoStack = [];
        if (entry.id === this.activeFileId) {
          this.redoStack = entry.redoStack;
          if (built.cmd.affectsPixel) this.pixelVersion++;
        }
        affectedFiles++;
        totalChanges += built.changeCount;
      }
      this._saveActiveSnapshot();
      const active = this.getActiveEntry();
      if (active) this._bindEntryToActive(active);
      this.lastEditedNodeId = null;
      return { affectedFiles, totalChanges, skippedFiles, dateSkips };
    } finally {
      this.anonymizing = false;
      this.emit('edit');
    }
  }

  /**
   * Batch set/update/delete a single tag across ALL open files.
   * @param {{ group: number, element: number, vr: string, value: string, mode: 'set'|'update'|'delete' }} params
   */
  async batchEditAcrossFiles({ group, element, vr, value, mode }) {
    const hex = tagHex(group, element);
    if (getReadOnlyTagMessage(hex)) return { affectedFiles: 0, locked: true };
    if (this.isBusy) return { affectedFiles: 0 };
    this._saveActiveSnapshot();
    const dict = lookupTag(group, element);
    const isMeta = group === 0x0002;
    let affectedFiles = 0;
    let activePixelChanged = false;

    this._batchEditing = true;
    try {
      this.emit('files');
      for (const entry of this.files.slice()) {
        try {
          const doc = await this.ensureEntryParsed(entry);
          if (!this.files.includes(entry)) continue;
          if (isMeta && !doc.hasPart10Header) continue;
          const list = isMeta ? doc.metaNodes : doc.datasetNodes;
          const existing = list.find((n) => n.tag === hex && n.status !== 'deleted');
          const deletedExisting = !existing && mode === 'set'
            ? list.find((n) => n.tag === hex && n.status === 'deleted' && !n.isSequence && !n.isBinary)
            : null;
          let cmd = null;

          if (mode === 'delete') {
            if (existing) {
              cmd = {
                label: `Batch delete ${existing.formattedTag}`,
                affectsPixel: this._isPixelDisplayTag(hex),
                redo: () => this._deleteNode(existing, list),
                undo: () => this._restoreNode(existing, list),
              };
            }
          } else if ((existing && !existing.isSequence && !existing.isBinary) || deletedExisting) {
            const target = existing || deletedExisting;
            if (deletedExisting || target.value !== value) {
              const prevValue = target.value;
              const wasDeleted = Boolean(deletedExisting);
              cmd = {
                label: `Batch edit ${target.formattedTag}`,
                affectsPixel: this._isPixelDisplayTag(hex),
                redo: () => {
                  target.value = value;
                  if (!list.includes(target)) {
                    target.status = 'added';
                    insertSorted(list, target);
                  } else {
                    target.status =
                      target.status === 'added'
                        ? 'added'
                        : value === target.originalValue
                          ? 'unchanged'
                          : 'modified';
                  }
                  target.validation = validateVrValue(target.vr, value, target.tag);
                },
                undo: () => {
                  target.value = prevValue;
                  if (wasDeleted) {
                    if (target.status === 'added') {
                      const idx = list.indexOf(target);
                      if (idx >= 0) list.splice(idx, 1);
                    } else {
                      target.status = 'deleted';
                    }
                  } else {
                    target.status =
                      target.status === 'added'
                        ? 'added'
                        : prevValue === target.originalValue
                          ? 'unchanged'
                          : 'modified';
                  }
                  target.validation = validateVrValue(target.vr, prevValue, target.tag);
                },
              };
            }
          } else if (!existing && mode === 'set' && !BINARY_VRS.has(vr) && vr !== 'SQ') {
            const newNode = {
              id: genNodeId(),
              group,
              element,
              tag: hex,
              formattedTag: formatTag(group, element),
              keyword: dict.keyword,
              name: dict.name,
              vr,
              vrSource: 'explicit',
              vmSpec: dict.vm,
              isMeta,
              isPrivate: (group & 1) === 1,
              isSequence: false,
              isBinary: false,
              encapsulated: false,
              undefinedLength: false,
              rawLength: 0,
              rawBytes: null,
              originalValue: '',
              value: value ?? '',
              status: 'added',
              validation: validateVrValue(vr, value ?? '', hex),
            };
            cmd = {
              label: `Batch add ${newNode.formattedTag}`,
              affectsPixel: this._isPixelDisplayTag(hex),
              redo: () => {
                if (!list.includes(newNode)) {
                  newNode.status = 'added';
                  insertSorted(list, newNode);
                } else if (newNode.status === 'deleted') {
                  newNode.status = newNode.value === newNode.originalValue ? 'unchanged' : 'modified';
                }
              },
              undo: () => {
                if (newNode.status === 'added') {
                  const idx = list.indexOf(newNode);
                  if (idx >= 0) list.splice(idx, 1);
                } else {
                  newNode.status = 'deleted';
                }
              },
            };
          }

          if (cmd) {
            cmd.redo();
            this._noteEdit(doc);
            entry.undoStack.push(cmd);
            if (entry.undoStack.length > 200) entry.undoStack.shift();
            entry.redoStack = [];
            if (entry.id === this.activeFileId) this.redoStack = entry.redoStack;
            affectedFiles++;
            if (entry.id === this.activeFileId && cmd.affectsPixel) {
              activePixelChanged = true;
            }
          }
        } catch {
          // skip unparseable entries
        }
      }
    } finally {
      this._batchEditing = false;
      this._saveActiveSnapshot();
      const active = this.getActiveEntry();
      if (active) this._bindEntryToActive(active);
      this.lastEditedNodeId = null;
      if (activePixelChanged) this.pixelVersion++;
      this.emit('edit');
    }
    return { affectedFiles };
  }

  getStatsAndDiff() {
    const stats = {
      total: 0,
      modified: 0,
      added: 0,
      deleted: 0,
      invalid: 0,
      phiCount: 0,
      privateCount: 0,
      sequenceCount: 0,
      diffs: [],
    };
    if (!this.doc) return stats;

    const walk = (nodes, pathPrefix) => {
      for (const n of nodes || []) {
        stats.total++;
        if (n.status === 'modified') stats.modified++;
        if (n.status === 'added') stats.added++;
        if (n.status === 'deleted') stats.deleted++;
        if (n.status !== 'deleted' && n.validation && !n.validation.valid) stats.invalid++;
        if (isPhiNode(n) && (n.isBinary || String(n.value || '').trim() !== '')) stats.phiCount++;
        if (n.isPrivate) stats.privateCount++;
        if (n.isSequence) stats.sequenceCount++;

        if (n.status !== 'unchanged') {
          stats.diffs.push({
            node: n,
            path: pathPrefix ? `${pathPrefix} › ${n.formattedTag}` : n.formattedTag,
          });
        }

        if (n.status === 'deleted') continue;

        if (n.isSequence && n.items) {
          n.items.forEach((item, idx) => {
            const p = pathPrefix
              ? `${pathPrefix} › ${n.formattedTag}[#${idx}]`
              : `${n.formattedTag}[#${idx}]`;
            walk(item.children, p);
          });
        }
      }
    };

    walk(this.doc.metaNodes, 'Meta');
    walk(this.doc.datasetNodes, '');
    return stats;
  }

  markSaved(doc, revision, file = null) {
    const entry = this.files.find((item) => item.doc === doc);
    if (!entry) return true;
    this.endUndoCoalescing(doc);
    if (file) {
      entry.fileHandle = file.handle;
      entry.sourceFile = null;
      entry.name = doc.fileName = file.name;
      entry.size = doc.fileSize = file.size;
      doc.wasGzipped = false;
      if (doc === this.doc) this.fileHandle = file.handle;
    }
    if (this.getDocumentRevision(doc) !== revision) {
      // The written snapshot is older than the editor, even if undo restored the prior baseline.
      doc.needsResave = true;
      return false;
    }
    doc.needsResave = false;
    doc.deidentificationChanged = false;
    this._savedDeidentified.set(doc, Boolean(doc.deidentified));
    const uid = getSopInstanceUid(doc);
    if (doc.hasPart10Header && uid) this._syncMediaStorageSopInstanceUid(doc, uid);
    if (doc.hasPart10Header) {
      this._syncMediaStorageSopClassUid(doc);
      const classMeta = doc.metaNodes.find((n) => n.tag === '00020002');
      if (classMeta) classMeta._syncedFromMain = false;
    }
    const clean = (list, inheritedCharset = '') => {
      const csNode = list.find((item) => item.tag === '00080005' && item.status !== 'deleted');
      const charset = csNode ? csNode.value : inheritedCharset;
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (n.status === 'deleted') {
          list.splice(i, 1);
          continue;
        }
        // Clear stale original rawBytes on modified/added/re-encoded non-binary tags so subsequent saves & Hex stay accurate
        const charsetChanged = n.rawCharset !== undefined && n.rawCharset !== charset;
        if ((n.status !== 'unchanged' || charsetChanged) && !n.isBinary && !n.isSequence) {
          n.rawBytes = null;
          if (n.rawCharset !== undefined) n.rawCharset = charset;
        }
        n.originalValue = n.value;
        n.status = 'unchanged';
        if (n.isSequence && n.items) {
          if (this._sequenceBaselines.has(n)) this._sequenceBaselines.set(n, n.items);
          for (const item of n.items) clean(item.children, charset);
        }
      }
    };
    clean(doc.metaNodes, '');
    clean(doc.datasetNodes, '');

    const hasNodeId = (nodes, targetId) => {
      if (!targetId) return false;
      for (const n of nodes || []) {
        if (n.id === targetId) return true;
        if (n.isSequence && n.items) {
          for (const item of n.items) {
            if (item.id === targetId || hasNodeId(item.children, targetId)) return true;
          }
        }
      }
      return false;
    };
    const activeSel = doc === this.doc ? this.selectedId : entry.selectedId;
    if (activeSel && !hasNodeId(doc.metaNodes, activeSel) && !hasNodeId(doc.datasetNodes, activeSel)) {
      const fallback = doc.datasetNodes[0]?.id || doc.metaNodes[0]?.id || null;
      entry.selectedId = fallback;
      if (doc === this.doc) this.selectedId = fallback;
    }

    if (doc === this.doc) {
      this._saveActiveSnapshot();
    }
    return true;
  }
}
