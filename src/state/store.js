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
import { generateDicomUid, getSopInstanceUid } from '../dicom/uid.js';
import { getLang, setLang as setI18nLang } from '../i18n.js';

export const ANONYMIZE_PRESET_TAGS = [
  { tag: '00100010', label: 'PatientName', replacement: 'ANONYMOUS' },
  { tag: '00100020', label: 'PatientID', replacement: 'ANON-0000' },
  { tag: '00100030', label: 'PatientBirthDate', replacement: '' },
  { tag: '00100040', label: 'PatientSex', replacement: '' },
  { tag: '00101010', label: 'PatientAge', replacement: '' },
  { tag: '00101040', label: 'PatientAddress', replacement: '' },
  { tag: '00104000', label: 'PatientComments', replacement: '' },
  { tag: '00080050', label: 'AccessionNumber', replacement: '' },
  { tag: '00080080', label: 'InstitutionName', replacement: 'ANONYMIZED' },
  { tag: '00080081', label: 'InstitutionAddress', replacement: '' },
  { tag: '00080090', label: 'ReferringPhysicianName', replacement: '' },
  { tag: '00081050', label: 'PerformingPhysicianName', replacement: '' },
  { tag: '00081070', label: 'OperatorsName', replacement: '' },
  { tag: '00181000', label: 'DeviceSerialNumber', replacement: '' },
];

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

function buildDefaultExpandedIds(doc) {
  const expanded = new Set(['__meta__', '__main__']);
  for (const n of doc.datasetNodes || []) {
    if (n.isSequence) {
      expanded.add(n.id);
      for (const item of n.items || []) expanded.add(item.id);
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
      if (n.isSequence && n.items) {
        for (const item of n.items) walk(item.children);
      }
    }
  };
  walk(doc.metaNodes);
  walk(doc.datasetNodes);
  return count || Number(Boolean(doc.needsResave));
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

export function canEditNodeValue(node) {
  return !node.isSequence && !node.isBinary && node.status !== 'deleted' && !getReadOnlyTagMessage(node.tag);
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
    this.compareMode = false;
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
    this._pendingParses = new WeakMap();
    this.anonymizing = false;
    this._batchEditing = false;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason = 'state') {
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
    if (fileAId && validIds.has(fileAId)) this.compareFileAId = fileAId;
    if (fileBId && validIds.has(fileBId)) this.compareFileBId = fileBId;
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
    this.activeFileId = entry ? entry.id : null;
    this.doc = entry ? entry.doc : null;
    this.fileHandle = entry ? entry.fileHandle : null;
    this.selectedId = entry ? entry.selectedId : null;
    this.expandedIds = entry ? entry.expandedIds : new Set(['__meta__', '__main__']);
    this.undoStack = entry ? entry.undoStack : [];
    this.redoStack = entry ? entry.redoStack : [];

    // Auto-collapse Pixel Preview when opening non-image DICOMs (e.g. SR, RT Plan)
    if (this.doc) {
      const hasPixel = Boolean(
        this.doc.datasetNodes?.some((n) => n.tag === '7FE00010' && n.status !== 'deleted')
      );
      this.showPixelPanel = hasPixel ? this._userPrefPixelOpen : false;
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
        expandedIds: new Set(['__meta__', '__main__']),
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
      this.compareMode = false;
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
    this.compareMode = false;
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
      // Prefer a nearby file and continue past entries that cannot be parsed.
      const next = this.files.slice(idx).concat(this.files.slice(0, idx).reverse());
      let active = null;
      for (const entry of next) {
        try {
          await this.ensureEntryParsed(entry);
          if (opToken !== this._activeOpToken) return;
          if (this.files.includes(entry)) {
            active = entry;
            break;
          }
        } catch {
          if (opToken !== this._activeOpToken) return;
          continue;
        }
      }
      if (opToken !== this._activeOpToken) return;
      if (!active) {
        this._resetEmptyWorkspace();
        return;
      }
      this._bindEntryToActive(active);
      this.pixelVersion++;
      this.emit('document');
    } else {
      this.emit('files');
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
      const idx = Math.max(0, Math.min(firstRemovedIdx, this.files.length - 1));
      const next = this.files.slice(idx).concat(this.files.slice(0, idx).reverse());
      let active = null;
      for (const entry of next) {
        try {
          await this.ensureEntryParsed(entry);
          if (opToken !== this._activeOpToken) return;
          if (this.files.includes(entry)) {
            active = entry;
            break;
          }
        } catch {
          if (opToken !== this._activeOpToken) return;
          continue;
        }
      }
      if (opToken !== this._activeOpToken) return;
      if (!active) {
        this._resetEmptyWorkspace();
        return;
      }
      this._bindEntryToActive(active);
      this.pixelVersion++;
      this.emit('document');
    } else {
      this.emit('files');
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

    const searchList = (list, path, crumbs, section, inheritedCharsetNode = null) => {
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
          };
        }
        if (node.isSequence && node.items) {
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
              };
            }
            const found = searchList(
              item.children || [],
              [...path, `${node.formattedTag} ${node.keyword}`, `Item #${j}`],
              [...crumbs, seqCrumb, itemCrumb],
              section,
              charsetNode
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

  getSpecificCharacterSet() {
    const info = this.findNodeInfo(this.selectedId);
    return info?.charsetNode?.value ?? '';
  }

  _isPixelDisplayTag(hex) {
    return hex.startsWith('0028') || hex === '7FE00010' || hex === '00020010';
  }

  getDocumentRevision(doc) {
    return this._revisions.get(doc) ?? 0;
  }

  _noteEdit(doc) {
    const uid = getSopInstanceUid(doc);
    if (doc.hasPart10Header && uid) {
      this._syncMediaStorageSopInstanceUid(doc, uid);
    }
    this._revisions.set(doc, this.getDocumentRevision(doc) + 1);
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

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this._noteEdit(this.doc);
    this.redoStack.push(cmd);
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this._noteEdit(this.doc);
    this.undoStack.push(cmd);
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  updateNodeValue(nodeId, newValue) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || !canEditNodeValue(info.node)) return;

    const node = info.node;
    if (node.value === newValue) return;

    const prevValue = node.value;
    const prevStatus = node.status;
    const nextStatus =
      prevStatus === 'added'
        ? 'added'
        : newValue === node.originalValue
          ? 'unchanged'
          : 'modified';

    this._executeCommand({
      label: `Edit ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: () => {
        node.value = newValue;
        node.status = nextStatus;
        node.validation = validateVrValue(node.vr, newValue, node.tag);
      },
      undo: () => {
        node.value = prevValue;
        node.status = prevStatus;
        node.validation = validateVrValue(node.vr, prevValue, node.tag);
      },
    });
  }

  revertNode(nodeId) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || getReadOnlyTagMessage(info.node.tag)) return;
    const node = info.node;

    if (node.status === 'added') {
      const { parentList } = info;
      this._executeCommand({
        label: `Remove added ${node.formattedTag}`,
        affectsPixel: this._isPixelDisplayTag(node.tag),
        redo: () => {
          const idx = parentList.indexOf(node);
          if (idx >= 0) parentList.splice(idx, 1);
          if (this.selectedId === node.id) this.selectedId = null;
        },
        undo: () => {
          parentList.push(node);
          parentList.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
          this.selectedId = node.id;
        },
      });
      return;
    }

    const prevValue = node.value;
    const prevStatus = node.status;
    const prevItems = node.items;
    const originalItems = this._sequenceBaselines.get(node);
    if (prevValue === node.originalValue && prevStatus === 'unchanged') return;

    this._executeCommand({
      label: `Revert ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: () => {
        node.value = node.originalValue;
        if (originalItems) node.items = originalItems;
        node.status = 'unchanged';
        node.validation = node.isBinary || node.isSequence
          ? { valid: true, severity: 'ok', messages: [] }
          : validateVrValue(node.vr, node.originalValue, node.tag);
      },
      undo: () => {
        node.value = prevValue;
        if (originalItems) node.items = prevItems;
        node.status = prevStatus;
        node.validation = node.isBinary || node.isSequence
          ? { valid: true, severity: 'ok', messages: [] }
          : validateVrValue(node.vr, prevValue, node.tag);
      },
    });
  }

  toggleDeleteNode(nodeId) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem) return;
    const node = info.node;
    if (getReadOnlyTagMessage(node.tag)) return;

    if (node.status === 'added') {
      this.revertNode(nodeId);
      return;
    }

    const prevStatus = node.status;
    if (
      prevStatus === 'deleted' &&
      info.parentList.some((n) => n !== node && n.tag === node.tag && n.status !== 'deleted')
    ) {
      return;
    }
    const nextStatus =
      prevStatus === 'deleted'
        ? node.value === node.originalValue && this._sequenceStatus(node) === 'unchanged'
          ? 'unchanged'
          : 'modified'
        : 'deleted';

    this._executeCommand({
      label: `${nextStatus === 'deleted' ? 'Delete' : 'Restore'} ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: () => {
        node.status = nextStatus;
      },
      undo: () => {
        node.status = prevStatus;
      },
    });
  }

  addTag({ group, element, vr, value, targetList = null, targetSection = null }) {
    if (!this.doc) return null;
    const hex = tagHex(group, element);
    if (getReadOnlyTagMessage(hex)) return { locked: true };
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
      const nextStatus = nextVal === deletedExisting.originalValue ? 'unchanged' : 'modified';
      this._executeCommand({
        label: `Restore & Edit ${deletedExisting.formattedTag}`,
        affectsPixel: this._isPixelDisplayTag(hex),
        redo: () => {
          deletedExisting.value = nextVal;
          deletedExisting.status = nextStatus;
          deletedExisting.validation = validateVrValue(deletedExisting.vr, nextVal, deletedExisting.tag);
          this.selectedId = deletedExisting.id;
        },
        undo: () => {
          deletedExisting.value = prevValue;
          deletedExisting.status = 'deleted';
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
        list.push(newNode);
        list.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
        this.selectedId = newNode.id;
        if (isSeq) {
          this.expandedIds.add(newNode.id);
          this.expandedIds.add(newNode.items[0].id);
        }
      },
      undo: () => {
        const idx = list.indexOf(newNode);
        if (idx >= 0) list.splice(idx, 1);
        if (this.selectedId === newNode.id) this.selectedId = null;
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
    const info = this.findNodeInfo(seqNodeId);
    if (!info || info.isSeqItem || !info.node.isSequence || info.node.status === 'deleted') return;
    const seqNode = info.node;
    const newItem = { id: genNodeId(), undefinedLength: false, children: [] };
    const prevItems = seqNode.items || [];
    if (!this._sequenceBaselines.has(seqNode)) this._sequenceBaselines.set(seqNode, prevItems);
    const prevStatus = seqNode.status;

    this._executeCommand({
      label: `Add Item to ${seqNode.formattedTag}`,
      affectsPixel: false,
      redo: () => {
        seqNode.items = [...prevItems, newItem];
        seqNode.status = prevStatus === 'added' ? 'added' : this._sequenceStatus(seqNode);
        this.expandedIds.add(seqNode.id);
        this.expandedIds.add(newItem.id);
        this.selectedId = newItem.id;
      },
      undo: () => {
        seqNode.items = prevItems;
        seqNode.status = prevStatus;
        if (this.selectedId === newItem.id) this.selectedId = seqNode.id;
      },
    });
  }

  removeSequenceItem(itemId) {
    const info = this.findNodeInfo(itemId);
    if (!info || !info.isSeqItem) return;
    const { parentSeq, item, itemIndex } = info;
    if (parentSeq.status === 'deleted') return;
    const prevItems = parentSeq.items;
    if (!this._sequenceBaselines.has(parentSeq)) this._sequenceBaselines.set(parentSeq, prevItems);
    const nextItems = prevItems.filter((entry) => entry !== item);
    const prevStatus = parentSeq.status;

    this._executeCommand({
      label: `Remove Item #${itemIndex} from ${parentSeq.formattedTag}`,
      affectsPixel: false,
      redo: () => {
        parentSeq.items = nextItems;
        parentSeq.status = prevStatus === 'added' ? 'added' : this._sequenceStatus(parentSeq);
        if (this.selectedId === item.id) this.selectedId = parentSeq.id;
      },
      undo: () => {
        parentSeq.items = prevItems;
        parentSeq.status = prevStatus;
        this.expandedIds.add(parentSeq.id);
        this.selectedId = item.id;
      },
    });
  }

  ensureUtf8Charset() {
    if (!this.doc) return;
    const info = this.findNodeInfo(this.selectedId);
    const existing = info?.charsetNode || this.doc.datasetNodes.find((n) => n.tag === '00080005');
    if (existing) {
      if (existing.status === 'deleted') {
        this.toggleDeleteNode(existing.id);
      }
      this.updateNodeValue(existing.id, 'ISO_IR 192');
    } else {
      this.addTag({ group: 0x0008, element: 0x0005, vr: 'CS', value: 'ISO_IR 192' });
    }
  }

  /**
   * Internal helper: build an undoable anonymization command for any given doc.
   * Supports PHI replacement, Private tag stripping, and consistent Study/Series/SOP UID regeneration.
   */
  _buildAnonymizeCommandForDoc(doc, rules, opts = {}) {
    const {
      markDeidentified = false,
      stripPrivate = false,
      regenerateUids = false,
      sharedUidMap = new Map(),
      sopUidMap = new Map(),
    } = opts;

    const ruleMap = new Map(rules.map((r) => [r.tag, r.replacement]));
    const snapshots = [];
    const privateDeletes = [];

    const mapUid = (origUid) => {
      if (origUid && sharedUidMap.has(origUid)) return sharedUidMap.get(origUid);
      const next = generateDicomUid();
      if (origUid) sharedUidMap.set(origUid, next);
      return next;
    };

    const originalSopUid = getSopInstanceUid(doc);
    const ownSopUid = sopUidMap.get(originalSopUid) || (regenerateUids && originalSopUid ? generateDicomUid() : null);

    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.status === 'deleted') continue;

        if (stripPrivate && n.isPrivate) {
          privateDeletes.push({ node: n, prevStatus: n.status });
          continue;
        }

        if (n.isSequence) {
          for (const item of n.items || []) walk(item.children);
          continue;
        }
        if (n.isBinary || getReadOnlyTagMessage(n.tag)) continue;

        let nextVal = ruleMap.get(n.tag);
        if (regenerateUids && n.vr === 'UI') {
          if (n.tag === '0020000D' || n.tag === '0020000E') {
            nextVal = mapUid(n.value);
          } else if (n.tag === '00080018' && ownSopUid && nodes === doc.datasetNodes) {
            nextVal = ownSopUid;
          } else if (n.tag === '00081155') {
            nextVal = n.value.split('\\').map((uid) => (
              sopUidMap.get(uid.trim()) || (uid.trim() === originalSopUid && ownSopUid) || uid
            )).join('\\');
          }
        }

        if (nextVal !== undefined && n.value !== nextVal) {
          snapshots.push({
            node: n,
            prevValue: n.value,
            prevStatus: n.status,
            nextValue: nextVal,
            nextStatus: n.status === 'added' ? 'added' : nextVal === n.originalValue ? 'unchanged' : 'modified',
          });
        }
      }
    };
    walk(doc.metaNodes);
    walk(doc.datasetNodes);

    let addedDeidNode = null;
    if (markDeidentified) {
      const existing = doc.datasetNodes.find((n) => n.tag === '00120062' && n.status !== 'deleted');
      if (existing) {
        if (existing.value !== 'YES') {
          snapshots.push({
            node: existing,
            prevValue: existing.value,
            prevStatus: existing.status,
            nextValue: 'YES',
            nextStatus: existing.status === 'added' ? 'added' : 'modified',
          });
        }
      } else {
        const dict = lookupTag(0x0012, 0x0062);
        addedDeidNode = {
          id: genNodeId(),
          group: 0x0012,
          element: 0x0062,
          tag: '00120062',
          formattedTag: '(0012,0062)',
          keyword: dict.keyword,
          name: dict.name,
          vr: 'CS',
          vrSource: 'explicit',
          vmSpec: '1',
          isMeta: false,
          isPrivate: false,
          isSequence: false,
          isBinary: false,
          encapsulated: false,
          undefinedLength: false,
          rawLength: 0,
          rawBytes: null,
          originalValue: '',
          value: 'YES',
          status: 'added',
          validation: validateVrValue('CS', 'YES'),
        };
      }
    }

    const changeCount = snapshots.length + privateDeletes.length + (addedDeidNode ? 1 : 0);
    if (changeCount === 0) return null;

    return {
      changeCount,
      cmd: {
        label: 'Batch Anonymize',
        affectsPixel: false,
        redo: () => {
          for (const s of snapshots) {
            s.node.value = s.nextValue;
            s.node.status = s.nextStatus;
            s.node.validation = validateVrValue(s.node.vr, s.nextValue, s.node.tag);
          }
          for (const d of privateDeletes) {
            d.node.status = 'deleted';
          }
          if (addedDeidNode) {
            doc.datasetNodes.push(addedDeidNode);
            doc.datasetNodes.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
          }
        },
        undo: () => {
          for (const s of snapshots) {
            s.node.value = s.prevValue;
            s.node.status = s.prevStatus;
            s.node.validation = validateVrValue(s.node.vr, s.prevValue, s.node.tag);
          }
          for (const d of privateDeletes) {
            d.node.status = d.prevStatus;
          }
          if (addedDeidNode) {
            const idx = doc.datasetNodes.indexOf(addedDeidNode);
            if (idx >= 0) doc.datasetNodes.splice(idx, 1);
          }
        },
      },
    };
  }

  applyAnonymization(rules, opts = {}) {
    if (!this.doc) return 0;
    const built = this._buildAnonymizeCommandForDoc(this.doc, rules, opts);
    if (!built) return 0;
    this._executeCommand(built.cmd);
    return built.changeCount;
  }

  /**
   * Apply anonymization across ALL open files (preserving Study/Series UID grouping across slices).
   */
  async applyAnonymizationAllFiles(rules, opts = {}) {
    if (this.anonymizing) return { affectedFiles: 0, totalChanges: 0, skippedFiles: 0 };
    this._saveActiveSnapshot();
    this.anonymizing = true;
    this.emit('files');
    try {
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
      const sopUidMap = new Map();
      if (opts.regenerateUids) {
        for (const { doc } of openEntries) {
          const uid = getSopInstanceUid(doc);
          if (uid && !sopUidMap.has(uid)) sopUidMap.set(uid, generateDicomUid());
        }
      }
      const sharedUidMap = new Map();
      const edits = openEntries.map((entry) => ({
        entry,
        built: this._buildAnonymizeCommandForDoc(entry.doc, rules, { ...opts, sharedUidMap, sopUidMap }),
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
        affectedFiles++;
        totalChanges += built.changeCount;
      }
      const active = this.getActiveEntry();
      if (active) this._bindEntryToActive(active);
      return { affectedFiles, totalChanges, skippedFiles };
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
    if (this._batchEditing || this.anonymizing) return { affectedFiles: 0 };
    this._saveActiveSnapshot();
    this._batchEditing = true;
    const dict = lookupTag(group, element);
    const isMeta = group === 0x0002;
    let affectedFiles = 0;
    let activePixelChanged = false;

    try {
      for (const entry of this.files.slice()) {
        try {
          const doc = await this.ensureEntryParsed(entry);
          if (!this.files.includes(entry)) continue;
          const list = isMeta ? doc.metaNodes : doc.datasetNodes;
          const existing = list.find((n) => n.tag === hex && n.status !== 'deleted');
          const deletedExisting = !existing && mode === 'set'
            ? list.find((n) => n.tag === hex && n.status === 'deleted' && !n.isSequence && !n.isBinary)
            : null;
          let cmd = null;

          if (mode === 'delete') {
            if (existing) {
              if (existing.status === 'added') {
                cmd = {
                  label: `Batch remove ${existing.formattedTag}`,
                  affectsPixel: this._isPixelDisplayTag(hex),
                  redo: () => {
                    const idx = list.indexOf(existing);
                    if (idx >= 0) list.splice(idx, 1);
                  },
                  undo: () => {
                    list.push(existing);
                    list.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
                  },
                };
              } else {
                const prevStatus = existing.status;
                cmd = {
                  label: `Batch delete ${existing.formattedTag}`,
                  affectsPixel: this._isPixelDisplayTag(hex),
                  redo: () => { existing.status = 'deleted'; },
                  undo: () => { existing.status = prevStatus; },
                };
              }
            }
          } else if ((existing && !existing.isSequence && !existing.isBinary) || deletedExisting) {
            const target = existing || deletedExisting;
            if (deletedExisting || target.value !== value) {
              const prevValue = target.value;
              const prevStatus = target.status;
              const nextStatus =
                prevStatus === 'added'
                  ? 'added'
                  : value === target.originalValue
                    ? 'unchanged'
                    : 'modified';
              cmd = {
                label: `Batch edit ${target.formattedTag}`,
                affectsPixel: this._isPixelDisplayTag(hex),
                redo: () => {
                  target.value = value;
                  target.status = nextStatus;
                  target.validation = validateVrValue(target.vr, value, target.tag);
                },
                undo: () => {
                  target.value = prevValue;
                  target.status = prevStatus;
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
                list.push(newNode);
                list.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
              },
              undo: () => {
                const idx = list.indexOf(newNode);
                if (idx >= 0) list.splice(idx, 1);
              },
            };
          }

          if (cmd) {
            cmd.redo();
            this._noteEdit(doc);
            entry.undoStack.push(cmd);
            if (entry.undoStack.length > 200) entry.undoStack.shift();
            entry.redoStack = [];
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
      const active = this.getActiveEntry();
      if (active) this._bindEntryToActive(active);
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
        if (n.isPrivate) stats.privateCount++;
        if (n.isSequence) stats.sequenceCount++;

        if (n.status !== 'unchanged') {
          stats.diffs.push({
            node: n,
            path: pathPrefix ? `${pathPrefix} › ${n.formattedTag}` : n.formattedTag,
          });
        }

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
    if (file) {
      entry.fileHandle = file.handle;
      entry.sourceFile = null;
      entry.name = doc.fileName = file.name;
      entry.size = doc.fileSize = file.size;
      if (doc === this.doc) this.fileHandle = file.handle;
    }
    if (this.getDocumentRevision(doc) !== revision) {
      // The written snapshot is older than the editor, even if undo restored the prior baseline.
      doc.needsResave = true;
      return false;
    }
    doc.needsResave = false;
    const uid = getSopInstanceUid(doc);
    if (doc.hasPart10Header && uid) this._syncMediaStorageSopInstanceUid(doc, uid);
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
          this._sequenceBaselines.delete(n);
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

    entry.undoStack = [];
    entry.redoStack = [];
    if (doc === this.doc) {
      this.undoStack = [];
      this.redoStack = [];
      this._saveActiveSnapshot();
    }
    return true;
  }
}
