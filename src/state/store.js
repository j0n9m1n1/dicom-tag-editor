/**
 * Central application state store with command-based Undo/Redo,
 * recursive tree lookup, search/filter matching, diff extraction, and batch anonymization.
 */

import { validateVrValue, BINARY_VRS } from '../dicom/vrSpec.js';
import { formatTag, tagHex, lookupTag } from '../dicom/dictionary.js';
import { genNodeId } from '../dicom/parser.js';
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

export class AppStore {
  constructor() {
    this.doc = null;
    this.fileHandle = null;
    this.selectedId = null;
    this.expandedIds = new Set(['__meta__', '__main__']);
    this.searchQuery = '';
    this.filterMode = 'all'; // 'all' | 'modified' | 'invalid' | 'sequence' | 'private' | 'meta'
    this.showPixelPanel = true;
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
    if (this.doc) {
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
      revalidate(this.doc.metaNodes);
      revalidate(this.doc.datasetNodes);
    }
    this.emit('lang');
  }

  togglePixelPanel() {
    this.showPixelPanel = !this.showPixelPanel;
    this.emit('layout');
  }

  loadDocument(doc, fileHandle = null) {
    this.doc = doc;
    this.fileHandle = fileHandle;
    this.selectedId = doc.datasetNodes[0]?.id || doc.metaNodes[0]?.id || null;
    this.expandedIds = new Set(['__meta__', '__main__']);
    // Auto-expand first-level SQ nodes for immediate discoverability
    for (const n of doc.datasetNodes) {
      if (n.isSequence) {
        this.expandedIds.add(n.id);
        for (const item of n.items || []) this.expandedIds.add(item.id);
      }
    }
    this.searchQuery = '';
    this.filterMode = 'all';
    this.undoStack = [];
    this.redoStack = [];
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
   * Also returns breadcrumb path and parent list.
   */
  findNodeInfo(targetId) {
    if (!this.doc || !targetId) return null;

    const searchList = (list, path, section) => {
      for (let i = 0; i < list.length; i++) {
        const node = list[i];
        if (node.id === targetId) {
          return { node, parentList: list, index: i, path: [...path, node.formattedTag], section };
        }
        if (node.isSequence && node.items) {
          for (let j = 0; j < node.items.length; j++) {
            const item = node.items[j];
            if (item.id === targetId) {
              return {
                isSeqItem: true,
                item,
                parentSeq: node,
                itemIndex: j,
                path: [...path, node.formattedTag, `Item #${j}`],
                section,
              };
            }
            const found = searchList(
              item.children || [],
              [...path, `${node.formattedTag} ${node.keyword}`, `Item #${j}`],
              section
            );
            if (found) return found;
          }
        }
      }
      return null;
    };

    return (
      searchList(this.doc.metaNodes, ['File Meta (0002)'], 'meta') ||
      searchList(this.doc.datasetNodes, ['Main Dataset'], 'main')
    );
  }

  getSpecificCharacterSet() {
    if (!this.doc) return '';
    const cs = this.doc.datasetNodes.find((n) => n.tag === '00080005' && n.status !== 'deleted');
    return cs ? cs.value : '';
  }

  /**
   * Check whether modifying a tag affects live pixel rendering.
   */
  _isPixelDisplayTag(hex) {
    return (
      hex.startsWith('0028') ||
      hex === '7FE00010' ||
      hex === '00020010'
    );
  }

  _executeCommand(cmd) {
    cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    if (cmd.affectsPixel) this.pixelVersion++;
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
    this.emit('edit');
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    if (cmd.affectsPixel) this.pixelVersion++;
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
      // Remove added node
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

  /**
   * Add a new tag to Meta (if group === 0x0002), Main Dataset, or selected SQ Item.
   */
  addTag({ group, element, vr, value, targetList = null, targetSection = null }) {
    if (!this.doc) return null;
    const hex = tagHex(group, element);
    const dict = lookupTag(group, element);
    const isMeta = targetList ? targetSection === 'meta' : group === 0x0002;
    const list = targetList || (isMeta ? this.doc.metaNodes : this.doc.datasetNodes);

    // Check duplicate in same list
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

    this._executeCommand({
      label: `Add Item to ${seqNode.formattedTag}`,
      affectsPixel: false,
      redo: () => {
        if (!seqNode.items) seqNode.items = [];
        seqNode.items.push(newItem);
        this.expandedIds.add(seqNode.id);
        this.expandedIds.add(newItem.id);
        this.selectedId = newItem.id;
      },
      undo: () => {
        const idx = seqNode.items.indexOf(newItem);
        if (idx >= 0) seqNode.items.splice(idx, 1);
        if (this.selectedId === newItem.id) this.selectedId = seqNode.id;
      },
    });
  }

  /**
   * Ensure (0008,0005) SpecificCharacterSet is set to ISO_IR 192 (UTF-8).
   * Also clears cached rawBytes on existing non-ASCII string tags so they re-encode consistently as UTF-8.
   */
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
   * Batch anonymize selected tags as a single Undo-able transaction.
   * @param {Array<{ tag: string, replacement: string }>} rules
   * @param {boolean} markDeidentified
   */
  applyAnonymization(rules, markDeidentified = true) {
    if (!this.doc) return 0;
    const ruleMap = new Map(rules.map((r) => [r.tag, r.replacement]));
    const snapshots = [];

    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.status === 'deleted') continue;
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
    walk(this.doc.datasetNodes);

    // Optionally add (0012,0062) PatientIdentityRemoved = YES
    let addedDeidNode = null;
    if (markDeidentified) {
      const existing = this.doc.datasetNodes.find((n) => n.tag === '00120062' && n.status !== 'deleted');
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

    if (snapshots.length === 0 && !addedDeidNode) return 0;

    this._executeCommand({
      label: 'Batch Anonymize',
      affectsPixel: false,
      redo: () => {
        for (const s of snapshots) {
          s.node.value = s.nextValue;
          s.node.status = s.nextStatus;
          s.node.validation = validateVrValue(s.node.vr, s.nextValue);
        }
        if (addedDeidNode) {
          this.doc.datasetNodes.push(addedDeidNode);
          this.doc.datasetNodes.sort((a, b) => (a.group !== b.group ? a.group - b.group : a.element - b.element));
        }
      },
      undo: () => {
        for (const s of snapshots) {
          s.node.value = s.prevValue;
          s.node.status = s.prevStatus;
          s.node.validation = validateVrValue(s.node.vr, s.prevValue);
        }
        if (addedDeidNode) {
          const idx = this.doc.datasetNodes.indexOf(addedDeidNode);
          if (idx >= 0) this.doc.datasetNodes.splice(idx, 1);
        }
      },
    });

    return snapshots.length + (addedDeidNode ? 1 : 0);
  }

  /**
   * Collect statistics and all changed nodes (Diff) across the entire document.
   */
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

  /**
   * Mark all current edits as saved baseline (after writing file).
   */
  markSaved() {
    if (!this.doc) return;
    const clean = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (n.status === 'deleted') {
          list.splice(i, 1);
          continue;
        }
        n.originalValue = n.value;
        n.status = 'unchanged';
        if (n.isSequence && n.items) {
          for (const item of n.items) clean(item.children);
        }
      }
    };
    clean(this.doc.metaNodes);
    clean(this.doc.datasetNodes);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('edit');
  }
}
