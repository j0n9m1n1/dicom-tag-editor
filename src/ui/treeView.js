/**
 * Hierarchical DICOM Tag Tree Table with inline editing,
 * recursive search/filter preservation, status/VR color coding, and keyboard navigation.
 */

import { getVrSpec } from '../dicom/vrSpec.js';
import { computeVm } from '../dicom/parser.js';
import { canEditNodeValue, getReadOnlyTagMessage } from '../state/store.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

export class TreeView {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{ onToast?: (msg: string, type?: string) => void }} [callbacks]
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;
    this.visibleRows = [];
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
    const rowEl = e.target.closest('.tree-row[data-kind="tag"]');
    if (!rowEl) return;
    e.preventDefault();
    this._closeContextMenu();

    const id = rowEl.dataset.rowId;
    this.store.selectNode(id);
    const info = this.store.findNodeInfo(id);
    if (!info || info.isSeqItem) return;
    const node = info.node;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const canEdit = canEditNodeValue(node);
    const isDeleted = node.status === 'deleted';
    const canDelete = !getReadOnlyTagMessage(node.tag);
    const canRevert = canDelete && (node.status === 'modified' || node.status === 'added');

    menu.innerHTML = `
      <button class="ctx-item" data-ctx="copy-tag">${icons.copy(13)} ${escapeHtml(t('ctxCopyTag'))} <span class="muted mono">${node.formattedTag}</span></button>
      ${!node.isSequence && !node.isBinary ? `<button class="ctx-item" data-ctx="copy-val">${icons.copy(13)} ${escapeHtml(t('ctxCopyValue'))}</button>` : ''}
      <button class="ctx-item" data-ctx="copy-line">${icons.code(13)} ${escapeHtml(t('ctxCopyLine'))}</button>
      <div class="ctx-sep"></div>
      ${canEdit ? `<button class="ctx-item" data-ctx="edit">${escapeHtml(t('ctxEditInline'))}</button>` : ''}
      ${canRevert ? `<button class="ctx-item" data-ctx="revert">${icons.rotateCcw(13)} ${escapeHtml(t('ctxRevert'))}</button>` : ''}
      ${canDelete ? `<button class="ctx-item ${isDeleted ? '' : 'ctx-danger'}" data-ctx="delete">${isDeleted ? icons.rotateCcw(13) : icons.trash(13)} ${escapeHtml(isDeleted ? t('ctxRestore') : t('ctxDelete'))}</button>` : ''}
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;

    menu.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = ev.target.closest('[data-ctx]');
      if (!btn) return;
      const act = btn.dataset.ctx;
      this._closeContextMenu();

      if (act === 'copy-tag') {
        this._copyText(node.formattedTag);
      } else if (act === 'copy-val') {
        this._copyText(node.value || '');
      } else if (act === 'copy-line') {
        const vm = computeVm(node);
        const val = node.isBinary || node.isSequence ? node.value || `(${node.vr})` : `[${node.value || ''}]`;
        this._copyText(`${node.formattedTag.toLowerCase()} ${node.vr} ${val} # ${vm} ${node.keyword}`);
      } else if (act === 'edit') {
        this.startInlineEdit(node.id);
      } else if (act === 'revert') {
        this.store.revertNode(node.id);
      } else if (act === 'delete') {
        this.store.toggleDeleteNode(node.id);
      }
    });

    this._ctxMenu = menu;
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
    const rows = [];

    const pushNodes = (entries, depth) => {
      for (const { node, filteredItems, forceExpand } of entries) {
        const isExpanded = forceExpand || this.store.expandedIds.has(node.id);
        rows.push({ kind: 'tag', id: node.id, node, depth, isExpanded });
        if (node.isSequence && isExpanded && filteredItems) {
          for (const { item, index, children } of filteredItems) {
            const itemExpanded = forceExpand || this.store.expandedIds.has(item.id);
            rows.push({
              kind: 'item',
              id: item.id,
              item,
              parentSeq: node,
              itemIndex: index,
              childCount: (item.children || []).length,
              depth: depth + 1,
              isExpanded: itemExpanded,
            });
            if (itemExpanded) {
              pushNodes(children, depth + 2);
            }
          }
        }
      }
    };

    const metaEntries = this._filterTree(doc.metaNodes, q, qHex, mode);
    const mainEntries = this._filterTree(doc.datasetNodes, q, qHex, mode);

    if (doc.hasPart10Header && (metaEntries.length > 0 || (!q && (mode === 'all' || mode === 'meta')))) {
      const metaExp = Boolean(q || mode !== 'all') || this.store.expandedIds.has('__meta__');
      rows.push({
        kind: 'section',
        id: '__meta__',
        label: t('sectionMeta'),
        count: metaEntries.length,
        isExpanded: metaExp,
        sectionType: 'meta',
      });
      if (metaExp) pushNodes(metaEntries, 1);
    }

    if (mainEntries.length > 0 || (!q && mode !== 'meta')) {
      const mainExp = Boolean(q || mode !== 'all') || this.store.expandedIds.has('__main__');
      rows.push({
        kind: 'section',
        id: '__main__',
        label: t('sectionMain'),
        count: mainEntries.length,
        isExpanded: mainExp,
        sectionType: 'main',
      });
      if (mainExp) pushNodes(mainEntries, 1);
    }

    return rows;
  }

  render() {
    if (!this.store.doc) {
      this.visibleRows = [];
      this.container.innerHTML = '';
      return;
    }

    const prevScroll = this.container.scrollTop;
    this.visibleRows = this._buildVisibleRows();

    if (this.visibleRows.length === 0) {
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
      if (row.kind === 'section') {
        htmlParts.push(`
          <div class="tree-row tree-section-row section-${row.sectionType}" data-row-id="${row.id}" data-kind="section">
            <div class="col-tag-group">
              <button class="tree-chevron" data-toggle="${row.id}" tabindex="-1">
                ${row.isExpanded ? icons.chevronDown(14) : icons.chevronRight(14)}
              </button>
              <span class="section-label">${escapeHtml(row.label)}</span>
              <span class="section-count">${row.count}</span>
            </div>
          </div>
        `);
        continue;
      }

      if (row.kind === 'item') {
        const selected = this.store.selectedId === row.id ? 'selected' : '';
        const indent = Math.max(0, row.depth - 1) * 16 + 4;
        htmlParts.push(`
          <div class="tree-row tree-item-row ${selected}" data-row-id="${row.id}" data-kind="item" tabindex="0">
            <div class="col-tag" style="padding-left:${indent}px">
              <button class="tree-chevron" data-toggle="${row.id}" tabindex="-1">
                ${row.isExpanded ? icons.chevronDown(14) : icons.chevronRight(14)}
              </button>
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
      const selected = this.store.selectedId === n.id ? 'selected' : '';
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

      const chevronHtml = n.isSequence
        ? `<button class="tree-chevron" data-toggle="${n.id}" tabindex="-1">${row.isExpanded ? icons.chevronDown(14) : icons.chevronRight(14)}</button>`
        : `<span class="tree-chevron-spacer"></span>`;

      htmlParts.push(`
        <div class="tree-row ${selected} ${statusCls} ${invalidCls} ${privateCls} ${seqCls} ${metaCls}"
             data-row-id="${n.id}" data-kind="tag" tabindex="0">
          <div class="col-tag" style="padding-left:${indent}px" title="${n.formattedTag}">
            ${chevronHtml}
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
            ${selected ? `<button class="btn btn-xs btn-primary mob-edit-pill" data-mob-inspect="${n.id}">${escapeHtml(t('mobEditTagBtn'))}</button>` : ''}
          </div>
        </div>
      `);
    }

    this.container.innerHTML = htmlParts.join('');
    this.container.scrollTop = prevScroll;

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
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.inlineEditId = null;
            this.render();
          }
        });
      }
    }
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

    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      e.stopPropagation();
      this.store.toggleExpand(toggleBtn.dataset.toggle);
      return;
    }

    if (e.target.closest('.inline-edit-input')) return;

    const rowEl = e.target.closest('.tree-row');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId;
    const kind = rowEl.dataset.kind;

    if (kind === 'section') {
      this.store.toggleExpand(id);
      return;
    }

    this.store.selectNode(id);
  }

  _onDblClick(e) {
    if (e.target.closest('.inline-edit-input')) return;
    const rowEl = e.target.closest('.tree-row');
    if (!rowEl) return;
    const id = rowEl.dataset.rowId;
    const kind = rowEl.dataset.kind;

    if (kind === 'item') {
      this.store.toggleExpand(id);
      return;
    }
    if (kind === 'tag') {
      const info = this.store.findNodeInfo(id);
      if (info && !info.isSeqItem && info.node.isSequence) {
        this.store.toggleExpand(id);
      } else {
        this.startInlineEdit(id);
      }
    }
  }

  _onKeyDown(e) {
    if (e.target.closest('.inline-edit-input')) return;
    const selectable = this.visibleRows.filter((r) => r.kind === 'tag' || r.kind === 'item');
    if (selectable.length === 0) return;

    const idx = selectable.findIndex((r) => r.id === this.store.selectedId);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = selectable[Math.min(selectable.length - 1, idx + 1)];
      if (next) {
        this.store.selectNode(next.id);
        this.scrollToNode(next.id);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = selectable[Math.max(0, idx - 1)];
      if (prev) {
        this.store.selectNode(prev.id);
        this.scrollToNode(prev.id);
      }
    } else if (e.key === 'ArrowRight') {
      const cur = selectable[idx];
      if (cur && (cur.kind === 'item' || cur.node?.isSequence) && !cur.isExpanded) {
        e.preventDefault();
        this.store.toggleExpand(cur.id);
      }
    } else if (e.key === 'ArrowLeft') {
      const cur = selectable[idx];
      if (cur && (cur.kind === 'item' || cur.node?.isSequence) && cur.isExpanded) {
        e.preventDefault();
        this.store.toggleExpand(cur.id);
      }
    } else if (e.key === 'F2') {
      if (this.store.selectedId) {
        e.preventDefault();
        this.startInlineEdit(this.store.selectedId);
      }
    } else if (e.key === 'Delete') {
      const cur = selectable[idx];
      if (cur && cur.kind === 'tag') {
        e.preventDefault();
        this.store.toggleDeleteNode(cur.id);
      }
    }
  }

  scrollToNode(id) {
    requestAnimationFrame(() => {
      const el = this.container.querySelector(`.tree-row[data-row-id="${id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
  }
}
