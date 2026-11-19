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
import { generateDicomUid } from '../dicom/uid.js';
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
  return count;
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
    this.mobileTab = 'tree'; // 'files' | 'tree' | 'inspector' | 'pixel'
    this.theme = localStorage.getItem('dcm_editor_theme') || 'dark';
    this.lang = getLang();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.pixelVersion = 0;
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
    localStorage.setItem('dcm_editor_theme', theme);
    this.emit('theme');
  }

  setLang(lang) {
    setI18nLang(lang);
    this.lang = getLang();
    const revalidate = (nodes) => {
      for (const n of nodes || []) {
        if (!n.isBinary && !n.isSequence) {
          n.validation = validateVrValue(n.vr, n.value);
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
    this.showFileList = !this.showFileList;
    this.emit('layout');
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
    try {
      const buf = entry.arrayBuffer || (entry.sourceFile ? await entry.sourceFile.arrayBuffer() : null);
      if (!buf) throw new Error('No file data available');
      const doc = await parseDicomBuffer(buf, entry.name);
      entry.doc = doc;
      entry.error = null;
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
      throw err;
    }
  }

  /**
   * Load a single pre-parsed document (e.g. sample DICOM). Replaces current list unless append=true.
   */
  loadDocument(doc, fileHandle = null, { append = false } = {}) {
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
      if (this.files.length > 1) this.showFileList = true;
    } else {
      this.files = [entry];
      this.showFileList = false;
    }

    this._bindEntryToActive(entry);
    this.searchQuery = '';
    this.filterMode = 'all';
    this.mobileTab = 'tree';
    this.pixelVersion++;
    this.emit('document');
  }

  /**
   * Register one or multiple files (File / ArrayBuffer / FileSystemFileHandle) with lazy parsing.
   * Defaults to appending to existing open files, deduplicating exact (name + size) matches,
   * and activating the first newly added file (or switching to the existing duplicate).
   * @param {Array<{ name: string, size?: number, sourceFile?: File, arrayBuffer?: ArrayBuffer, fileHandle?: any }>} items
   * @param {{ append?: boolean }} [opts]
   */
  async loadFileItems(items, { append = true } = {}) {
    if (!items || items.length === 0) return { loadedCount: 0, addedCount: 0, totalCount: this.files.length };
    this._saveActiveSnapshot();

    const hadExisting = append && this.files.length > 0;
    const newEntries = [];
    let firstExistingMatch = null;

    for (const it of items) {
      const size = it.size ?? it.sourceFile?.size ?? it.arrayBuffer?.byteLength ?? 0;
      if (hadExisting) {
        const dup = this.files.find((f) => f.name === it.name && f.size === size);
        if (dup) {
          if (!firstExistingMatch) firstExistingMatch = dup;
          continue;
        }
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

    // All dropped/selected files were already open -> switch to the existing entry
    if (hadExisting && newEntries.length === 0 && firstExistingMatch) {
      await this.switchToFile(firstExistingMatch.id);
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
    }

    if (this.files.length > 1) {
      this.showFileList = true;
    } else if (!hadExisting) {
      this.showFileList = false;
    }

    // Parse and activate the first newly added valid file
    let activated = null;
    let firstError = null;
    for (const entry of newEntries) {
      try {
        await this.ensureEntryParsed(entry);
        activated = entry;
        break;
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }

    if (!activated) {
      if (!hadExisting) {
        this.files = [];
        this._bindEntryToActive(null);
        this.emit('document');
      } else {
        this.emit('files');
      }
      throw firstError || new Error('Failed to parse DICOM file(s).');
    }

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
    };
  }

  /**
   * Switch active file in the multi-file list (lazy-parsing if needed).
   */
  async switchToFile(fileId) {
    if (this.activeFileId === fileId) return;
    const target = this.files.find((f) => f.id === fileId);
    if (!target) return;

    this._saveActiveSnapshot();
    await this.ensureEntryParsed(target);
    this._bindEntryToActive(target);
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
    }

    if (this.files.length === 0) {
      this._bindEntryToActive(null);
      this.pixelVersion++;
      this.emit('document');
      return;
    }

    if (wasActive) {
      const next = this.files[Math.min(idx, this.files.length - 1)];
      try {
        await this.ensureEntryParsed(next);
        this._bindEntryToActive(next);
      } catch {
        this._bindEntryToActive(null);
      }
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
    this.files = [];
    this._bindEntryToActive(null);
    this.showFileList = false;
    this.searchQuery = '';
    this.filterMode = 'all';
    this.mobileTab = 'tree';
    this.pixelVersion++;
    this.emit('document');
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

    const searchList = (list, path, crumbs, section) => {
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
              section
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
    if (!this.doc) return '';
    const cs = this.doc.datasetNodes.find((n) => n.tag === '00080005' && n.status !== 'deleted');
    return cs ? cs.value : '';
  }

  _isPixelDisplayTag(hex) {
    return hex.startsWith('0028') || hex === '7FE00010' || hex === '00020010';
  }

  _executeCommand(cmd) {
    cmd.redo();
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
    this.redoStack.push(cmd);
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    if (cmd.affectsPixel) this.pixelVersion++;
    this._saveActiveSnapshot();
    this.emit('edit');
  }

  updateNodeValue(nodeId, newValue) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || info.node.isSequence || info.node.isBinary) return;

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
        node.validation = validateVrValue(node.vr, newValue);
      },
      undo: () => {
        node.value = prevValue;
        node.status = prevStatus;
        node.validation = validateVrValue(node.vr, prevValue);
      },
    });
  }

  revertNode(nodeId) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem) return;
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
    if (prevValue === node.originalValue && prevStatus === 'unchanged') return;

    this._executeCommand({
      label: `Revert ${node.formattedTag}`,
      affectsPixel: this._isPixelDisplayTag(node.tag),
      redo: () => {
        node.value = node.originalValue;
        node.status = 'unchanged';
        node.validation = node.isBinary || node.isSequence
          ? { valid: true, severity: 'ok', messages: [] }
          : validateVrValue(node.vr, node.originalValue);
      },
      undo: () => {
        node.value = prevValue;
        node.status = prevStatus;
        node.validation = node.isBinary || node.isSequence
          ? { valid: true, severity: 'ok', messages: [] }
          : validateVrValue(node.vr, prevValue);
      },
    });
  }

  toggleDeleteNode(nodeId) {
    const info = this.findNodeInfo(nodeId);
    if (!info || info.isSeqItem) return;
    const node = info.node;
    if (node.tag === '00020010') return; // TransferSyntaxUID cannot be deleted

    if (node.status === 'added') {
      this.revertNode(nodeId);
      return;
    }

    const prevStatus = node.status;
    const nextStatus =
      prevStatus === 'deleted'
        ? node.value === node.originalValue
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
    const dict = lookupTag(group, element);
    const isMeta = targetList ? targetSection === 'meta' : group === 0x0002;
    const list = targetList || (isMeta ? this.doc.metaNodes : this.doc.datasetNodes);

    const existing = list.find((n) => n.tag === hex && n.status !== 'deleted');
    if (existing) {
      this.selectedId = existing.id;
      this.emit('selection');
      return { duplicate: true, node: existing };
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
        : validateVrValue(vr, value ?? ''),
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

  addSequenceItem(seqNodeId) {
    const info = this.findNodeInfo(seqNodeId);
    if (!info || info.isSeqItem || !info.node.isSequence) return;
    const seqNode = info.node;
    const newItem = { id: genNodeId(), undefinedLength: false, children: [] };
    const prevStatus = seqNode.status;
    const nextStatus = prevStatus === 'added' ? 'added' : 'modified';

    this._executeCommand({
      label: `Add Item to ${seqNode.formattedTag}`,
      affectsPixel: false,
      redo: () => {
        if (!seqNode.items) seqNode.items = [];
        seqNode.items.push(newItem);
        seqNode.status = nextStatus;
        this.expandedIds.add(seqNode.id);
        this.expandedIds.add(newItem.id);
        this.selectedId = newItem.id;
      },
      undo: () => {
        const idx = seqNode.items.indexOf(newItem);
        if (idx >= 0) seqNode.items.splice(idx, 1);
        seqNode.status = prevStatus;
        if (this.selectedId === newItem.id) this.selectedId = seqNode.id;
      },
    });
  }

  removeSequenceItem(itemId) {
    const info = this.findNodeInfo(itemId);
    if (!info || !info.isSeqItem) return;
    const { parentSeq, item, itemIndex } = info;
    const prevStatus = parentSeq.status;
    const nextStatus = prevStatus === 'added' ? 'added' : 'modified';

    this._executeCommand({
      label: `Remove Item #${itemIndex} from ${parentSeq.formattedTag}`,
      affectsPixel: false,
      redo: () => {
        const idx = parentSeq.items.indexOf(item);
        if (idx >= 0) parentSeq.items.splice(idx, 1);
        parentSeq.status = nextStatus;
        if (this.selectedId === item.id) this.selectedId = parentSeq.id;
      },
      undo: () => {
        parentSeq.items.splice(itemIndex, 0, item);
        parentSeq.status = prevStatus;
        this.expandedIds.add(parentSeq.id);
        this.selectedId = item.id;
      },
    });
  }

  ensureUtf8Charset() {
    if (!this.doc) return;
    const clearNonAsciiRaw = (nodes) => {
      for (const n of nodes || []) {
        if (!n.isBinary && !n.isSequence && /[^\x00-\x7F]/.test(n.value || '')) {
          n.rawBytes = null;
        }
        if (n.isSequence && n.items) {
          for (const item of n.items) clearNonAsciiRaw(item.children);
        }
      }
    };
    clearNonAsciiRaw(this.doc.datasetNodes);

    const existing = this.doc.datasetNodes.find((n) => n.tag === '00080005');
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
      markDeidentified = true,
      stripPrivate = false,
      regenerateUids = false,
      sharedUidMap = new Map(),
    } = opts;

    const ruleMap = new Map(rules.map((r) => [r.tag, r.replacement]));
    const snapshots = [];
    const privateDeletes = [];

    const mapUid = (origUid, forceUnique = false) => {
      if (!forceUnique && origUid && sharedUidMap.has(origUid)) {
        return sharedUidMap.get(origUid);
      }
      const next = generateDicomUid();
      if (!forceUnique && origUid) sharedUidMap.set(origUid, next);
      return next;
    };

    // Determine consistent new SOPInstanceUID for this file so (0008,0018) and (0002,0003) stay synced
    let newSopUid = null;
    if (regenerateUids) {
      newSopUid = generateDicomUid();
    }

    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.status === 'deleted') continue;

        if (stripPrivate && n.isPrivate) {
          privateDeletes.push({ node: n, prevStatus: n.status });
          continue;
        }

        if (regenerateUids && !n.isSequence && !n.isBinary) {
          if (n.tag === '0020000D' || n.tag === '0020000E') {
            const nextVal = mapUid(n.value, false);
            snapshots.push({
              node: n,
              prevValue: n.value,
              prevStatus: n.status,
              nextValue: nextVal,
              nextStatus: n.status === 'added' ? 'added' : 'modified',
            });
            continue;
          }
          if (n.tag === '00080018' || n.tag === '00020003') {
            snapshots.push({
              node: n,
              prevValue: n.value,
              prevStatus: n.status,
              nextValue: newSopUid,
              nextStatus: n.status === 'added' ? 'added' : 'modified',
            });
            continue;
          }
        }

        if (ruleMap.has(n.tag) && !n.isSequence && !n.isBinary) {
          const nextVal = ruleMap.get(n.tag);
          if (n.value !== nextVal) {
            snapshots.push({
              node: n,
              prevValue: n.value,
              prevStatus: n.status,
              nextValue: nextVal,
              nextStatus: n.status === 'added' ? 'added' : nextVal === n.originalValue ? 'unchanged' : 'modified',
            });
          }
        }
        if (n.isSequence && n.items) {
          for (const item of n.items) walk(item.children);
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
            s.node.validation = validateVrValue(s.node.vr, s.nextValue);
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
            s.node.validation = validateVrValue(s.node.vr, s.prevValue);
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
    this._saveActiveSnapshot();
    let affectedFiles = 0;
    let totalChanges = 0;
    const sharedUidMap = new Map();

    for (const entry of this.files) {
      try {
        const doc = await this.ensureEntryParsed(entry);
        const built = this._buildAnonymizeCommandForDoc(doc, rules, { ...opts, sharedUidMap });
        if (!built) continue;
        built.cmd.redo();
        entry.undoStack.push(built.cmd);
        entry.redoStack = [];
        affectedFiles++;
        totalChanges += built.changeCount;
      } catch {
        // skip unparseable entries
      }
    }

    const active = this.getActiveEntry();
    if (active) this._bindEntryToActive(active);
    this.emit('edit');
    return { affectedFiles, totalChanges };
  }

  /**
   * Batch set/update/delete a single tag across ALL open files.
   * @param {{ group: number, element: number, vr: string, value: string, mode: 'set'|'update'|'delete' }} params
   */
  async batchEditAcrossFiles({ group, element, vr, value, mode }) {
    this._saveActiveSnapshot();
    const hex = tagHex(group, element);
    const dict = lookupTag(group, element);
    const isMeta = group === 0x0002;
    let affectedFiles = 0;
    let activePixelChanged = false;

    for (const entry of this.files) {
      try {
        const doc = await this.ensureEntryParsed(entry);
        const list = isMeta ? doc.metaNodes : doc.datasetNodes;
        const existing = list.find((n) => n.tag === hex && n.status !== 'deleted');
        let cmd = null;

        if (mode === 'delete') {
          if (existing && hex !== '00020010') {
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
        } else if (existing && !existing.isSequence && !existing.isBinary) {
          if (existing.value !== value) {
            const prevValue = existing.value;
            const prevStatus = existing.status;
            const nextStatus =
              prevStatus === 'added'
                ? 'added'
                : value === existing.originalValue
                  ? 'unchanged'
                  : 'modified';
            cmd = {
              label: `Batch edit ${existing.formattedTag}`,
              affectsPixel: this._isPixelDisplayTag(hex),
              redo: () => {
                existing.value = value;
                existing.status = nextStatus;
                existing.validation = validateVrValue(existing.vr, value);
              },
              undo: () => {
                existing.value = prevValue;
                existing.status = prevStatus;
                existing.validation = validateVrValue(existing.vr, prevValue);
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
            validation: validateVrValue(vr, value ?? ''),
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
          entry.undoStack.push(cmd);
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

    const active = this.getActiveEntry();
    if (active) this._bindEntryToActive(active);
    if (activePixelChanged) this.pixelVersion++;
    this.emit('edit');
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

  markSaved(targetDoc = null) {
    const doc = targetDoc || this.doc;
    if (!doc) return;
    const clean = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (n.status === 'deleted') {
          list.splice(i, 1);
          continue;
        }
        // Clear stale original rawBytes on modified/added non-binary tags so subsequent saves encode the new value
        if (n.status !== 'unchanged' && !n.isBinary && !n.isSequence) {
          n.rawBytes = null;
        }
        n.originalValue = n.value;
        n.status = 'unchanged';
        if (n.isSequence && n.items) {
          for (const item of n.items) clean(item.children);
        }
      }
    };
    clean(doc.metaNodes);
    clean(doc.datasetNodes);

    if (!targetDoc || targetDoc === this.doc) {
      this.undoStack = [];
      this.redoStack = [];
      this._saveActiveSnapshot();
      this.emit('edit');
    } else {
      const entry = this.files.find((f) => f.doc === doc);
      if (entry) {
        entry.undoStack = [];
        entry.redoStack = [];
      }
    }
  }
}
