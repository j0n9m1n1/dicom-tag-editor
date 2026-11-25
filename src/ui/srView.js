/**
 * Inline DICOM Structured Report (SR) Workspace View.
 * Renders (0040,A730) Content Sequence as a human-readable hierarchical clinical report
 * with full decoding of CONTAINER, TEXT, CODE, NUM (+ units), PNAME, DATE/TIME, UIDREF,
 * IMAGE/COMPOSITE references, and SCOORD/TCOORD, plus live search, Markdown copy/export,
 * and 1-click jump to the underlying tag in Tree view.
 */

import { extractSrDocument, formatSrMarkdown } from '../dicom/srParser.js';
import { copyTextToClipboard, downloadBlobBytes } from '../utils/uiHelpers.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

const SR_BADGE_CLASS = {
  CONTAINER: 'sr-vt-container',
  CODE: 'sr-vt-code',
  TEXT: 'sr-vt-text',
  NUM: 'sr-vt-num',
  PNAME: 'sr-vt-pname',
  DATE: 'sr-vt-date',
  TIME: 'sr-vt-date',
  DATETIME: 'sr-vt-date',
  UIDREF: 'sr-vt-ref',
  IMAGE: 'sr-vt-ref',
  COMPOSITE: 'sr-vt-ref',
  WAVEFORM: 'sr-vt-ref',
  SCOORD: 'sr-vt-coord',
  SCOORD3D: 'sr-vt-coord',
  TCOORD: 'sr-vt-coord',
};

export class SrView {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{ onJumpToNode?: (id: string) => void, onToast?: (msg: string, type?: string) => void }} [callbacks]
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;

    this.searchQuery = '';
    this.collapsedIds = new Set();
    this._lastDocRef = null;
    this._lastSr = null;
    this._shellBuilt = false;
  }

  reset() {
    this.searchQuery = '';
    this.collapsedIds.clear();
    this._lastDocRef = null;
    this._lastSr = null;
    if (this._shellBuilt) {
      const inp = this.container.querySelector('#sr-search-input');
      const clearBtn = this.container.querySelector('#btn-sr-search-clear');
      const bodyEl = this.container.querySelector('#sr-body');
      if (inp) inp.value = '';
      if (clearBtn) clearBtn.classList.add('hidden');
      if (bodyEl) bodyEl.innerHTML = '';
    }
  }

  focusSearch() {
    const inp = this.container.querySelector('#sr-search-input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  _buildShell() {
    this.container.innerHTML = `
      <div class="sr-topbar">
        <div class="search-box sr-search-box">
          <span class="search-icon">${icons.search(14)}</span>
          <input type="text" id="sr-search-input" autocomplete="off" />
          <button type="button" class="search-clear hidden" id="btn-sr-search-clear">×</button>
        </div>
        <div class="sr-util-btns">
          <button type="button" class="btn btn-xs" id="btn-sr-expand"></button>
          <button type="button" class="btn btn-xs" id="btn-sr-collapse"></button>
        </div>
        <span class="cmp-stat cmp-stat-total mono" id="sr-item-count"></span>
        <div class="raw-inline-actions">
          <button type="button" class="btn btn-xs" id="btn-sr-copy"></button>
          <button type="button" class="btn btn-xs" id="btn-sr-export"></button>
          <button type="button" class="btn btn-xs" id="btn-sr-close"></button>
        </div>
      </div>
      <div class="sr-body" id="sr-body"></div>
    `;
    this._shellBuilt = true;
    this._bindEvents();
  }

  _bindEvents() {
    const searchInp = this.container.querySelector('#sr-search-input');
    const clearBtn = this.container.querySelector('#btn-sr-search-clear');
    const expandBtn = this.container.querySelector('#btn-sr-expand');
    const collapseBtn = this.container.querySelector('#btn-sr-collapse');
    const copyBtn = this.container.querySelector('#btn-sr-copy');
    const exportBtn = this.container.querySelector('#btn-sr-export');
    const closeBtn = this.container.querySelector('#btn-sr-close');
    const bodyEl = this.container.querySelector('#sr-body');

    searchInp.addEventListener('input', () => {
      this.searchQuery = searchInp.value;
      clearBtn.classList.toggle('hidden', !this.searchQuery);
      this._renderBody(false);
    });
    clearBtn.addEventListener('click', () => {
      this.searchQuery = '';
      searchInp.value = '';
      clearBtn.classList.add('hidden');
      searchInp.focus();
      this._renderBody(false);
    });
    expandBtn.addEventListener('click', () => {
      this.collapsedIds.clear();
      this._renderBody(true);
    });
    collapseBtn.addEventListener('click', () => {
      this._collectParentIds(this._lastSr?.items || [], this.collapsedIds);
      this._renderBody(true);
    });
    copyBtn.addEventListener('click', () => this._copyMarkdown());
    exportBtn.addEventListener('click', () => this.exportMarkdown());
    closeBtn.addEventListener('click', () => this.store.setViewMode('tree'));

    bodyEl.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-sr-toggle]');
      if (toggleBtn) {
        const id = toggleBtn.dataset.srToggle;
        if (this.collapsedIds.has(id)) this.collapsedIds.delete(id);
        else this.collapsedIds.add(id);
        this._renderBody(true);
        return;
      }
      const jumpBtn = e.target.closest('[data-sr-jump]');
      if (jumpBtn) {
        const nodeId = jumpBtn.dataset.srJump;
        if (nodeId) this.callbacks.onJumpToNode?.(nodeId);
      }
    });
  }

  _collectParentIds(items, targetSet) {
    for (const it of items) {
      if (it.children.length > 0) {
        targetSet.add(it.id);
        this._collectParentIds(it.children, targetSet);
      }
    }
  }

  _syncLabels() {
    const searchInp = this.container.querySelector('#sr-search-input');
    const clearBtn = this.container.querySelector('#btn-sr-search-clear');
    const expandBtn = this.container.querySelector('#btn-sr-expand');
    const collapseBtn = this.container.querySelector('#btn-sr-collapse');
    const copyBtn = this.container.querySelector('#btn-sr-copy');
    const exportBtn = this.container.querySelector('#btn-sr-export');
    const closeBtn = this.container.querySelector('#btn-sr-close');

    if (searchInp) searchInp.placeholder = t('srSearchPh');
    if (clearBtn) clearBtn.title = t('searchClearTitle');
    if (expandBtn) expandBtn.textContent = t('btnExpandAll');
    if (collapseBtn) collapseBtn.textContent = t('btnCollapseAll');
    if (copyBtn) copyBtn.innerHTML = `${icons.copy(13)}<span>${escapeHtml(t('modalRawCopy'))}</span>`;
    if (exportBtn) exportBtn.innerHTML = `${icons.download(13)}<span>${escapeHtml(t('modalRawExport'))}</span>`;
    if (closeBtn) closeBtn.innerHTML = `${icons.x(13)}<span>${escapeHtml(t('rawExitBtn'))}</span>`;
  }

  render(reason = 'state') {
    if (this.store.viewMode !== 'sr' || !this.store.doc) {
      return;
    }
    if (reason === 'layout' && this._shellBuilt) {
      return;
    }
    if (!this._shellBuilt) {
      this._buildShell();
    }
    this._syncLabels();

    const docChanged = this._lastDocRef !== this.store.doc;
    if (docChanged) {
      this._lastDocRef = this.store.doc;
      this.collapsedIds.clear();
    }

    this._lastSr = extractSrDocument(this.store.doc);
    this._renderBody(!docChanged && (reason === 'edit' || reason === 'lang'));
  }

  _filterItems(items, q) {
    if (!q) return items;
    const out = [];
    for (const item of items) {
      const hay = `${item.valueType} ${item.relationship} ${item.conceptName} ${item.conceptCode} ${item.valueText} ${item.valueDetail}`.toLowerCase();
      const selfMatch = hay.includes(q);
      const filteredChildren = this._filterItems(item.children, q);
      if (selfMatch || filteredChildren.length > 0) {
        out.push({
          ...item,
          children: selfMatch && filteredChildren.length === 0 ? item.children : filteredChildren,
          forceExpand: filteredChildren.length > 0,
        });
      }
    }
    return out;
  }

  _renderItem(item, filtering) {
    const hasChildren = item.children.length > 0;
    const isCollapsed = hasChildren && !filtering && this.collapsedIds.has(item.id);
    const vtCls = SR_BADGE_CLASS[item.valueType] || 'sr-vt-other';
    const chevron = hasChildren
      ? `<button type="button" class="sr-toggle" data-sr-toggle="${escapeHtml(item.id)}" aria-expanded="${!isCollapsed}">${isCollapsed ? icons.chevronRight(14) : icons.chevronDown(14)}</button>`
      : '<span class="sr-toggle-spacer"></span>';

    const relHtml = item.relationship
      ? `<span class="sr-rel">${escapeHtml(item.relationship)}</span>`
      : '';
    const conceptHtml = item.conceptName
      ? `<span class="sr-concept">${escapeHtml(item.conceptName)}</span>${item.conceptCode ? `<span class="sr-code mono">(${escapeHtml(item.conceptCode)})</span>` : ''}`
      : item.conceptCode
        ? `<span class="sr-code mono">(${escapeHtml(item.conceptCode)})</span>`
        : '';

    const valHtml = item.valueText
      ? `<div class="sr-val-wrap">
           <span class="sr-val ${item.valueType === 'NUM' ? 'sr-val-num mono' : item.valueType === 'UIDREF' || item.valueType === 'IMAGE' || item.valueType === 'COMPOSITE' ? 'mono' : ''}">${escapeHtml(item.valueText)}</span>
           ${item.valueDetail ? `<span class="sr-val-detail">${escapeHtml(item.valueDetail)}</span>` : ''}
         </div>`
      : item.valueDetail
        ? `<div class="sr-val-wrap"><span class="sr-val-detail">${escapeHtml(item.valueDetail)}</span></div>`
        : '';

    const jumpHtml = item.jumpNodeId
      ? `<button type="button" class="btn btn-xs sr-jump-btn" data-sr-jump="${escapeHtml(item.jumpNodeId)}" title="${escapeHtml(t('srJumpTreeTitle'))}">${icons.tree(12)}<span>${escapeHtml(t('srJumpTreeBtn'))}</span></button>`
      : '';

    const childrenHtml = hasChildren && !isCollapsed
      ? `<div class="sr-children">${item.children.map((ch) => this._renderItem(ch, filtering)).join('')}</div>`
      : '';

    return `
      <div class="sr-node ${item.valueType === 'CONTAINER' ? 'sr-node-container' : ''}">
        <div class="sr-node-row">
          ${chevron}
          <span class="sr-vt-badge ${vtCls}">${escapeHtml(item.valueType)}</span>
          <div class="sr-node-content">
            <div class="sr-node-head">
              ${relHtml}
              ${conceptHtml}
              ${hasChildren && isCollapsed ? `<span class="sr-child-pill">${item.children.length}</span>` : ''}
            </div>
            ${valHtml}
          </div>
          ${jumpHtml}
        </div>
        ${childrenHtml}
      </div>
    `;
  }

  _renderBody(preserveScroll = false) {
    const bodyEl = this.container.querySelector('#sr-body');
    const countEl = this.container.querySelector('#sr-item-count');
    const sr = this._lastSr;
    if (!bodyEl || !sr) return;

    const prevScroll = preserveScroll ? bodyEl.scrollTop : 0;
    const q = this.searchQuery.trim().toLowerCase();
    const filtered = this._filterItems(sr.items, q);

    if (countEl) {
      countEl.textContent = t('srItemsCount', { n: sr.totalCount });
    }

    const statusBadges = [];
    if (sr.completionFlag) {
      const ok = sr.completionFlag === 'COMPLETE';
      statusBadges.push(`<span class="status-pill ${ok ? 'st-added' : 'st-modified'}">${escapeHtml(sr.completionFlag)}</span>`);
    }
    if (sr.verificationFlag) {
      const ok = sr.verificationFlag === 'VERIFIED';
      statusBadges.push(`<span class="status-pill ${ok ? 'st-added' : 'st-unchanged'}">${escapeHtml(sr.verificationFlag)}</span>`);
    }

    const metaParts = [];
    if (sr.sopClassName) metaParts.push(`<span>${escapeHtml(sr.sopClassName)}</span>`);
    if (sr.contentDate || sr.contentTime) {
      metaParts.push(`<span class="mono">${escapeHtml([sr.contentDate, sr.contentTime].filter(Boolean).join(' '))}</span>`);
    }
    if (sr.patientName || sr.patientId) {
      metaParts.push(`<span>${escapeHtml([sr.patientName, sr.patientId ? `(${sr.patientId})` : ''].filter(Boolean).join(' '))}</span>`);
    }

    const headerHtml = `
      <div class="sr-doc-header">
        <div class="sr-doc-title-row">
          <h2 class="sr-doc-title">${escapeHtml(sr.title)}</h2>
          <div class="sr-doc-badges">${statusBadges.join('')}</div>
        </div>
        ${sr.titleCode ? `<div class="sr-doc-code mono">${escapeHtml(sr.titleCode)}</div>` : ''}
        ${metaParts.length > 0 ? `<div class="sr-doc-meta">${metaParts.join('<span class="sum-dot">·</span>')}</div>` : ''}
      </div>
    `;

    const treeHtml = filtered.length > 0
      ? `<div class="sr-tree">${filtered.map((it) => this._renderItem(it, Boolean(q))).join('')}</div>`
      : `<div class="sr-empty">${escapeHtml(q ? t('treeEmptyMsg') : t('srEmptyContent'))}</div>`;

    bodyEl.innerHTML = headerHtml + treeHtml;
    bodyEl.scrollTop = preserveScroll ? prevScroll : 0;
  }

  async _copyMarkdown() {
    if (!this._lastSr) return;
    const md = formatSrMarkdown(this._lastSr, this.store.doc?.fileName || '');
    if (await copyTextToClipboard(md)) {
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    }
  }

  exportMarkdown() {
    if (!this._lastSr || !this.store.doc) return;
    const base = this.store.doc.fileName.split('/').at(-1).replace(/\.(dcm|dicom)$/i, '');
    const md = formatSrMarkdown(this._lastSr, this.store.doc.fileName);
    downloadBlobBytes(md, 'text/markdown;charset=utf-8', `${base}_report.md`);
  }
}
