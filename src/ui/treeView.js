/**
 * Hierarchical DICOM Tag Tree Table with inline editing,
 * recursive search/filter preservation, status/VR color coding, and keyboard navigation.
 */

import { getVrSpec, NUMERIC_VRS } from '../dicom/vrSpec.js';
import { computeVm } from '../dicom/parser.js';
import { canEditNodeValue, getReadOnlyTagMessage } from '../state/store.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

export class TreeView {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{
   *   onToast?: (msg: string, type?: string) => void,
   *   onOpenAddTagForItem?: (item: any, parentSeq: any, section: string) => void,
   * }} [callbacks]
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;
    this.visibleRows = [];
    this.filterExpansion = new Map();
    this.inlineEditId = null;
    this._ctxMenu = null;

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('dblclick', (e) => this._onDblClick(e));
    this.container.addEventListener('keydown', (e) => this._onKeyDown(e));
    this.container.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    window.addEventListener('click', () => this._closeContextMenu());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this._closeContextMenu();
    });
    this.container.addEventListener('scroll', () => this._closeContextMenu());
  }

  _closeContextMenu() {
    if (this._ctxMenu) {
      this._ctxMenu.remove();
      this._ctxMenu = null;
    }
  }

  async _copyText(str) {
    try {
      await navigator.clipboard.writeText(str);
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = str;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    }
  }

  _onContextMenu(e) {
    const rowEl = e.target.closest('.tree-row[data-kind="tag"], .tree-row[data-kind="item"]');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId;
    const info = this.store.findNodeInfo(id);
    if (!info) return;
    e.preventDefault();
    this._closeContextMenu();
    this._selectRow(id);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = info.isSeqItem
      ? this._itemContextMenu(info, this.visibleRows.find((row) => row.id === id))
      : this._tagContextMenu(info.node);

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    menu.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.target.closest('[data-ctx]');
      if (!btn || btn.disabled) return;
      this._closeContextMenu();
      const current = this.store.findNodeInfo(id);
      if (!current) return;
      if (current.isSeqItem) {
        this._runItemContextAction(current, btn.dataset.ctx);
      } else {
        this._runTagContextAction(current.node, btn.dataset.ctx);
      }
    });

    this._ctxMenu = menu;
  }

  _itemContextMenu(info, row) {
    const disabled = info.parentSeq.status === 'deleted' ? 'disabled' : '';
    return `
      ${row?.hasChildren ? `<button class="ctx-item" data-ctx="toggle-item">${row.isExpanded ? icons.chevronDown(13) : icons.chevronRight(13)} ${escapeHtml(t(row.isExpanded ? 'treeCollapseBranch' : 'treeExpandBranch'))}</button>` : ''}
      <button class="ctx-item" data-ctx="add-tag-in-item" ${disabled}>${icons.plus(13)} ${escapeHtml(t('inspAddTagInItem'))}</button>
      <button class="ctx-item ctx-danger" data-ctx="delete-item" ${disabled}>${icons.trash(13)} ${escapeHtml(t('inspDeleteSeqItem'))}</button>
    `;
  }

  _runItemContextAction(info, action) {
    if (action === 'toggle-item') {
      this._toggleRow(this.visibleRows.find((row) => row.id === info.item.id));
      return;
    }
    if (info.parentSeq.status === 'deleted') return;
    if (action === 'add-tag-in-item') {
      this.callbacks.onOpenAddTagForItem?.(info.item, info.parentSeq, info.section);
    } else if (action === 'delete-item') {
      this.store.removeSequenceItem(info.item.id);
    }
  }

  _tagContextMenu(node) {
    const canEdit = canEditNodeValue(node);
    const isDeleted = node.status === 'deleted';
    const canDelete = !getReadOnlyTagMessage(node.tag);
    const canRevert = canDelete && (node.status === 'modified' || node.status === 'added');

    return `
      <button class="ctx-item" data-ctx="copy-tag">${icons.copy(13)} ${escapeHtml(t('ctxCopyTag'))} <span class="muted mono">${node.formattedTag}</span></button>
      ${!node.isSequence && !node.isBinary ? `<button class="ctx-item" data-ctx="copy-val">${icons.copy(13)} ${escapeHtml(t('ctxCopyValue'))}</button>` : ''}
      <button class="ctx-item" data-ctx="copy-line">${icons.code(13)} ${escapeHtml(t('ctxCopyLine'))}</button>
      <div class="ctx-sep"></div>
      ${canEdit ? `<button class="ctx-item" data-ctx="edit">${escapeHtml(t('ctxEditInline'))}</button>` : ''}
      ${canRevert ? `<button class="ctx-item" data-ctx="revert">${icons.rotateCcw(13)} ${escapeHtml(t('ctxRevert'))}</button>` : ''}
      ${canDelete ? `<button class="ctx-item ${isDeleted ? '' : 'ctx-danger'}" data-ctx="delete">${isDeleted ? icons.rotateCcw(13) : icons.trash(13)} ${escapeHtml(isDeleted ? t('ctxRestore') : t('ctxDelete'))}</button>` : ''}
    `;
  }

  _runTagContextAction(node, action) {
    if (action === 'copy-tag') {
      this._copyText(node.formattedTag);
    } else if (action === 'copy-val') {
      this._copyText(node.value || '');
    } else if (action === 'copy-line') {
      const vm = computeVm(node);
      const val = node.isBinary || node.isSequence ? node.value || `(${node.vr})` : `[${node.value || ''}]`;
      this._copyText(`${node.formattedTag.toLowerCase()} ${node.vr} ${val} # ${vm} ${node.keyword}`);
    } else if (action === 'edit') {
      this.startInlineEdit(node.id);
    } else if (action === 'revert') {
      this.store.revertNode(node.id);
    } else if (action === 'delete') {
      this.store.toggleDeleteNode(node.id);
    }
  }

  _matchesQuery(node, q, qHex) {
    if (!q) return true;
    return (
      (qHex !== '' && node.tag.toLowerCase().includes(qHex)) ||
      node.formattedTag.toLowerCase().includes(q) ||
      (node.keyword && node.keyword.toLowerCase().includes(q)) ||
      (node.name && node.name.toLowerCase().includes(q)) ||
      (node.vr && node.vr.toLowerCase() === q) ||
      (!node.isBinary && !node.isSequence && (node.value || '').toLowerCase().includes(q))
    );
  }

  _matchesFilterMode(node, mode) {
    switch (mode) {
      case 'modified':
        return node.status !== 'unchanged';
      case 'invalid':
        return node.status !== 'deleted' && node.validation && !node.validation.valid;
      case 'sequence':
        return node.isSequence;
      case 'private':
        return node.isPrivate;
      case 'meta':
        return node.isMeta;
      default:
        return true;
    }
  }

  /**
   * Recursively filter nodes; keep parent SQ if any descendant matches.
   */
  _filterTree(nodes, q, qHex, mode) {
    const out = [];
    for (const node of nodes || []) {
      const selfMatches = this._matchesQuery(node, q, qHex) && this._matchesFilterMode(node, mode);
      if (node.isSequence) {
        const filteredItems = [];
        let descendantMatch = false;
        for (let i = 0; i < (node.items || []).length; i++) {
          const item = node.items[i];
          const children = this._filterTree(item.children, q, qHex, mode);
          if (children.length > 0) {
            descendantMatch = true;
            filteredItems.push({ item, index: i, children });
          } else if (selfMatches && !q && (mode === 'all' || mode === 'sequence')) {
            filteredItems.push({ item, index: i, children: [] });
          }
        }
        if (selfMatches || descendantMatch) {
          out.push({ node, filteredItems, forceExpand: Boolean((q || mode !== 'all') && descendantMatch) });
        }
      } else if (selfMatches) {
        out.push({ node, filteredItems: null, forceExpand: false });
      }
    }
    return out;
  }

  _buildVisibleRows() {
    const doc = this.store.doc;
    if (!doc) return [];

    const q = this.store.searchQuery.trim().toLowerCase();
    const isTagLike = /^[0-9a-f(),\s]+$/.test(q);
    const qHex = isTagLike ? q.replace(/[^0-9a-f]/g, '') : '';
    const mode = this.store.filterMode;
    const filtering = Boolean(q || mode !== 'all');
    const rows = [];
    const expanded = (id, hasChildren, autoExpand) => hasChildren && (
      (filtering ? this.filterExpansion.get(id) : undefined) ?? (autoExpand || this.store.expandedIds.has(id))
    );

    const pushNodes = (entries, depth, parentId) => {
      for (const { node, filteredItems, forceExpand } of entries) {
        const hasChildren = Boolean(filteredItems?.length);
        const isExpanded = expanded(node.id, hasChildren, forceExpand);
        rows.push({ kind: 'tag', id: node.id, node, depth, parentId, hasChildren, isExpanded });
        if (isExpanded) {
          for (const { item, index, children } of filteredItems) {
            const itemHasChildren = children.length > 0;
            const itemExpanded = expanded(item.id, itemHasChildren, forceExpand);
            rows.push({
              kind: 'item',
              id: item.id,
              item,
              parentSeq: node,
              itemIndex: index,
              childCount: (item.children || []).length,
              depth: depth + 1,
              parentId: node.id,
              hasChildren: itemHasChildren,
              isExpanded: itemExpanded,
            });
            if (itemExpanded) {
              pushNodes(children, depth + 2, item.id);
            }
          }
        }
      }
    };

    const metaEntries = this._filterTree(doc.metaNodes, q, qHex, mode);
    const mainEntries = this._filterTree(doc.datasetNodes, q, qHex, mode);

    if (doc.hasPart10Header && (metaEntries.length > 0 || (!q && (mode === 'all' || mode === 'meta')))) {
      pushSection('meta', t('sectionMeta'), metaEntries);
    }

    if (mainEntries.length > 0 || (!q && mode !== 'meta')) {
      pushSection('main', t('sectionMain'), mainEntries);
    }

    return rows;

    function pushSection(sectionType, label, entries) {
      const id = `__${sectionType}__`;
      const hasChildren = entries.length > 0;
      const isExpanded = expanded(id, hasChildren, filtering);
      rows.push({
        kind: 'section', id, label, count: entries.length, depth: 0, hasChildren, isExpanded, sectionType,
      });
      if (isExpanded) pushNodes(entries, 1, id);
    }
  }

  render(reason) {
    if (reason === 'selection') {
      this._syncSelection();
      return;
    }
    if (reason === 'document' || reason === 'filter' || reason === 'tree') {
      this.filterExpansion.clear();
    }
    this._closeContextMenu();
    this.container.setAttribute('aria-label', t('treeLabel'));
    if (!this.store.doc) {
      this.visibleRows = [];
      this.container.innerHTML = '';
      this.container.removeAttribute('aria-activedescendant');
      return;
    }

    const prevScroll = this.container.scrollTop;
    this.visibleRows = this._buildVisibleRows();

    if (this.visibleRows.length === 0) {
      this.container.removeAttribute('aria-activedescendant');
      this.container.innerHTML = `
        <div class="tree-empty">
          <p>${escapeHtml(t('treeEmptyMsg'))}</p>
          <button class="btn btn-sm" data-action="clear-filter">${escapeHtml(t('treeClearFilter'))}</button>
        </div>
      `;
      return;
    }

    const htmlParts = [];
    for (const row of this.visibleRows) {
      const attrs = `id="tree-row-${row.id}" data-row-id="${row.id}" data-kind="${row.kind}" role="treeitem" aria-level="${row.depth + 1}" aria-selected="false"${row.hasChildren ? ` aria-expanded="${row.isExpanded}"` : ''}`;
      const chevron = row.hasChildren
        ? `<button type="button" class="tree-chevron" data-toggle="${row.id}" tabindex="-1" aria-label="${escapeHtml(t(row.isExpanded ? 'treeCollapseBranch' : 'treeExpandBranch'))}">${row.isExpanded ? icons.chevronDown(14) : icons.chevronRight(14)}</button>`
        : '<span class="tree-chevron-spacer"></span>';
      if (row.kind === 'section') {
        htmlParts.push(`
          <div class="tree-row tree-section-row section-${row.sectionType}" ${attrs}>
            <div class="col-tag-group">
              ${chevron}
              <span class="section-label">${escapeHtml(row.label)}</span>
              <span class="section-count">${row.count}</span>
            </div>
          </div>
        `);
        continue;
      }

      if (row.kind === 'item') {
        const indent = Math.max(0, row.depth - 1) * 16 + 4;
        htmlParts.push(`
          <div class="tree-row tree-item-row" ${attrs}>
            <div class="col-tag" style="padding-left:${indent}px">
              ${chevron}
              <span class="item-badge">Item #${row.itemIndex}</span>
            </div>
            <div class="col-name muted"><span class="tag-name">${escapeHtml(t('seqItemDesc', { n: row.childCount }))}</span></div>
            <div class="col-vr"></div>
            <div class="col-vm"></div>
            <div class="col-len"></div>
            <div class="col-val muted"></div>
          </div>
        `);
        continue;
      }

      // Standard / Private / SQ tag row
      const n = row.node;
      const spec = getVrSpec(n.vr);
      const invalid = n.status !== 'deleted' && n.validation && !n.validation.valid;
      const statusCls = `status-${n.status}`;
      const invalidCls = invalid ? 'has-error' : '';
      const privateCls = n.isPrivate ? 'is-private' : '';
      const seqCls = n.isSequence ? 'is-sequence' : '';
      const metaCls = n.isMeta ? 'is-meta' : '';
      const indent = Math.max(0, row.depth - 1) * 16 + 4;

      const vm = computeVm(n);
      const byteLen = n.isSequence
        ? `${(n.items || []).length} itm`
        : n.isBinary
          ? n.rawLength
          : n.status === 'unchanged' && n.rawBytes
            ? n.rawBytes.length
            : spec.fixedLength && (NUMERIC_VRS.has(n.vr) || n.vr === 'AT')
              ? vm * spec.fixedLength
              : new TextEncoder().encode(n.value || '').length;

      let valueHtml;
      if (this.inlineEditId === n.id && canEditNodeValue(n)) {
        valueHtml = `<input class="inline-edit-input" data-inline-id="${n.id}" value="${escapeHtml(n.value)}" />`;
      } else if (n.isSequence) {
        valueHtml = `<span class="val-seq">${(n.items || []).length} item(s)</span>`;
      } else if (n.isBinary) {
        valueHtml = `<span class="val-binary">${escapeHtml(n.value)}</span>`;
      } else if (n.value === '') {
        valueHtml = `<span class="val-empty">(empty)</span>`;
      } else {
        valueHtml = `<span class="val-text" title="${escapeHtml(n.value)}">${escapeHtml(n.value)}</span>`;
      }

      htmlParts.push(`
        <div class="tree-row ${statusCls} ${invalidCls} ${privateCls} ${seqCls} ${metaCls}" ${attrs}>
          <div class="col-tag" style="padding-left:${indent}px" title="${n.formattedTag}">
            ${chevron}
            <span class="tag-code">${n.formattedTag}</span>
          </div>
          <div class="col-name" title="${escapeHtml(n.name)} (${escapeHtml(n.keyword)})">
            <span class="tag-name">${escapeHtml(n.keyword !== 'UnknownTag' ? n.keyword : n.name)}</span>
            ${n.isPrivate ? '<span class="mini-badge badge-private">PRIV</span>' : ''}
            ${invalid ? `<span class="mini-badge badge-err" title="${escapeHtml(n.validation.messages.join(' / '))}">${icons.alertCircle(12)}</span>` : ''}
          </div>
          <div class="col-vr">
            <span class="vr-pill vr-cat-${spec.category}" title="${escapeHtml(spec.name)}">${escapeHtml(n.vr)}</span>
          </div>
          <div class="col-vm">${vm}</div>
          <div class="col-len">${byteLen}</div>
          <div class="col-val">
            ${valueHtml}
          </div>
        </div>
      `);
    }

    this.container.innerHTML = htmlParts.join('');
    this.container.scrollTop = prevScroll;
    this._syncSelection();

    if (this.inlineEditId) {
      const inp = this.container.querySelector(`input[data-inline-id="${this.inlineEditId}"]`);
      if (inp) {
        inp.focus();
        inp.select();
        inp.addEventListener('blur', () => this._commitInlineEdit(inp));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            this._commitInlineEdit(inp);
            this.container.focus({ preventScroll: true });
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.inlineEditId = null;
            this.render();
            this.container.focus({ preventScroll: true });
          }
        });
      }
    }
  }

  _getRowElement(id) {
    return this.container.querySelector(`.tree-row[data-row-id="${id}"]`);
  }

  _syncSelection() {
    if (this.visibleRows.length === 0) return;
    const previous = this.container.querySelector('.tree-row.selected');
    const selected = this._getRowElement(this.store.selectedId);
    if (previous !== selected) {
      previous?.classList.remove('selected');
      previous?.setAttribute('aria-selected', 'false');
      previous?.querySelector('[data-mob-inspect]')?.remove();
      if (selected) {
        selected.classList.add('selected');
        selected.setAttribute('aria-selected', 'true');
        if (selected.dataset.kind === 'tag') {
          selected.querySelector('.col-val').insertAdjacentHTML('beforeend',
            `<button class="btn btn-xs btn-primary mob-edit-pill" data-mob-inspect="${selected.dataset.rowId}">${escapeHtml(t('mobEditTagBtn'))}</button>`);
        }
      }
    }

    const active = selected || this._getRowElement(this.visibleRows[0].id);
    this.container.querySelector('.tree-row.is-active')?.classList.remove('is-active');
    active.classList.add('is-active');
    this.container.setAttribute('aria-activedescendant', active.id);
  }

  _commitInlineEdit(inputEl) {
    if (!this.inlineEditId) return;
    const id = this.inlineEditId;
    const val = inputEl.value;
    this.inlineEditId = null;
    this.store.updateNodeValue(id, val);
    // Ensure re-render even if value didn't change
    this.render();
  }

  startInlineEdit(nodeId) {
    const info = this.store.findNodeInfo(nodeId);
    if (!info || info.isSeqItem || !canEditNodeValue(info.node)) {
      return;
    }
    this.inlineEditId = nodeId;
    this.render();
  }

  _selectRow(id) {
    this.store.selectNode(id);
    this.container.focus({ preventScroll: true });
  }

  _toggleRow(row) {
    if (!row?.hasChildren) return;
    if (this.store.searchQuery.trim() || this.store.filterMode !== 'all') {
      this.filterExpansion.set(row.id, !row.isExpanded);
      this.render();
    } else {
      this.store.toggleExpand(row.id);
    }
  }

  _onClick(e) {
    const mobBtn = e.target.closest('[data-mob-inspect]');
    if (mobBtn) {
      e.stopPropagation();
      this.store.selectNode(mobBtn.dataset.mobInspect);
      this.store.setMobileTab('inspector');
      return;
    }

    const clearBtn = e.target.closest('[data-action="clear-filter"]');
    if (clearBtn) {
      this.store.setSearchQuery('');
      this.store.setFilterMode('all');
      return;
    }

    if (e.target.closest('.inline-edit-input')) return;

    const rowEl = e.target.closest('.tree-row');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId;
    this._selectRow(id);
    if (rowEl.dataset.kind === 'section' || e.target.closest('[data-toggle]')) {
      this._toggleRow(this.visibleRows.find((row) => row.id === id));
    }
  }

  _onDblClick(e) {
    if (e.target.closest('button, .inline-edit-input')) return;
    const rowEl = e.target.closest('.tree-row');
    if (!rowEl) return;
    const row = this.visibleRows.find((item) => item.id === rowEl.dataset.rowId);
    if (row?.kind === 'item' || row?.node?.isSequence) {
      this._toggleRow(row);
    } else if (row?.kind === 'tag') {
      this.startInlineEdit(row.id);
    }
  }

  _getPageStep() {
    const viewportHeight = this.container.clientHeight;
    if (!viewportHeight) return 10;
    const rowEl = this._getRowElement(this.store.selectedId) || this.container.querySelector('.tree-row');
    const rowHeight = rowEl?.getBoundingClientRect().height || 28;
    return Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
  }

  _onKeyDown(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
        e.target.closest('button, input, textarea, select, [contenteditable]')) return;
    if (this.visibleRows.length === 0) return;

    const selectedIndex = this.visibleRows.findIndex((row) => row.id === this.store.selectedId);
    const index = Math.max(0, selectedIndex);
    const current = this.visibleRows[index];
    let targetId;

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = selectedIndex < 0 ? 0 : e.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = Math.max(0, Math.min(this.visibleRows.length - 1, index + step));
        targetId = this.visibleRows[nextIndex].id;
        break;
      }
      case 'PageDown':
      case 'PageUp': {
        const delta = this._getPageStep() * (e.key === 'PageDown' ? 1 : -1);
        const nextIndex = Math.max(0, Math.min(this.visibleRows.length - 1, index + delta));
        targetId = this.visibleRows[nextIndex].id;
        break;
      }
      case 'Home':
        targetId = this.visibleRows[0].id;
        break;
      case 'End':
        targetId = this.visibleRows[this.visibleRows.length - 1].id;
        break;
      case 'ArrowRight': {
        if (current.hasChildren && !current.isExpanded) {
          e.preventDefault();
          this.store.selectNode(current.id);
          this._toggleRow(current);
          return;
        }
        const next = this.visibleRows[index + 1];
        if (next?.parentId === current.id) targetId = next.id;
        break;
      }
      case 'ArrowLeft':
        if (current.isExpanded) {
          e.preventDefault();
          this.store.selectNode(current.id);
          this._toggleRow(current);
          return;
        }
        targetId = current.parentId;
        break;
      case 'F2':
        if (selectedIndex < 0 || current.kind !== 'tag' || !canEditNodeValue(current.node)) return;
        e.preventDefault();
        this.startInlineEdit(current.id);
        return;
      case 'Delete':
        if (selectedIndex < 0 || current.kind !== 'tag') return;
        e.preventDefault();
        this.store.toggleDeleteNode(current.id);
        return;
      default:
        return;
    }

    e.preventDefault();
    if (targetId) {
      this.store.selectNode(targetId);
      this.scrollToNode(targetId);
    }
  }

  scrollToNode(id) {
    requestAnimationFrame(() => {
      this._getRowElement(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
}
