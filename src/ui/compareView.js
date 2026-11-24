/**
 * WinMerge-style inline Side-by-Side DICOM Compare View.
 * Features:
 *  - Split Left (File A) | Draggable Center Resizer | Right (File B) workspace
 *  - Content-sized 4-column tag table (Tag | Keyword | VR | Value) decoupled from filename width
 *  - File selection via top combo boxes AND drag-and-drop from the Open Files sidebar
 *  - Synchronized vertical scrolling, aligned rows with empty placeholders, synchronized hover/selection
 *  - Show differences only filter, real-time tag search, and Prev/Next diff jump controls
 */

import { getVrSpec } from '../dicom/vrSpec.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

export const INTERNAL_FILE_DRAG_MIME = 'application/x-dcm-file-id';

function flattenDoc(doc) {
  const map = new Map();
  const walk = (nodes, section, sortPrefix, displayPrefix, depth) => {
    for (const n of nodes || []) {
      if (n.status === 'deleted') continue;
      const key = `${sortPrefix}/${n.tag}`;
      const displayPath = displayPrefix ? `${displayPrefix} › ${n.formattedTag}` : n.formattedTag;
      if (n.isSequence) {
        map.set(key, {
          key,
          section,
          tag: n.formattedTag,
          path: displayPath,
          depth,
          keyword: n.keyword,
          name: n.name,
          vr: n.vr,
          value: `${(n.items || []).length} item(s)`,
          isBinary: false,
          isSequence: true,
        });
        (n.items || []).forEach((item, idx) => {
          const idxPad = String(idx).padStart(6, '0');
          const nextSort = `${key}/${idxPad}`;
          const nextDisp = displayPrefix
            ? `${displayPrefix} › ${n.formattedTag}[#${idx}]`
            : `${n.formattedTag}[#${idx}]`;
          walk(item.children, section, nextSort, nextDisp, depth + 1);
        });
      } else {
        map.set(key, {
          key,
          section,
          tag: n.formattedTag,
          path: displayPath,
          depth,
          keyword: n.keyword,
          name: n.name,
          vr: n.vr,
          value: n.isBinary ? n.value : (n.value || ''),
          isBinary: n.isBinary,
          isSequence: false,
          rawBytes: n.rawBytes,
        });
      }
    }
  };
  walk(doc.metaNodes, 'meta', '0', 'Meta', 0);
  walk(doc.datasetNodes, 'main', '1', '', 0);
  return map;
}

function bytesEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build aligned, DICOM-ordered compare rows (File Meta 0002 -> Main Dataset, with SQ children under their parent).
 */
export function buildCompareRows(docA, docB, { diffOnly = true, searchQuery = '' } = {}) {
  const mapA = flattenDoc(docA);
  const mapB = flattenDoc(docB);
  const allKeys = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort();

  const q = (searchQuery || '').trim().toLowerCase();
  const isTagLike = /^[0-9a-f(),\s]+$/.test(q);
  const qHex = isTagLike ? q.replace(/[^0-9a-f]/g, '') : '';

  let changed = 0;
  let onlyA = 0;
  let onlyB = 0;
  const rows = [];

  const matchesSearch = (a, b) => {
    if (!q) return true;
    const items = [a, b].filter(Boolean);
    return items.some((it) => {
      const tagHexStr = it.tag.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      return (
        (qHex !== '' && tagHexStr.includes(qHex)) ||
        it.tag.toLowerCase().includes(q) ||
        it.path.toLowerCase().includes(q) ||
        (it.keyword && it.keyword.toLowerCase().includes(q)) ||
        (it.name && it.name.toLowerCase().includes(q)) ||
        (it.vr && it.vr.toLowerCase() === q) ||
        (!it.isBinary && (it.value || '').toLowerCase().includes(q))
      );
    });
  };

  const entryByKey = new Map();
  const includedKeys = new Set();

  for (const k of allKeys) {
    const a = mapA.get(k) || null;
    const b = mapB.get(k) || null;
    const section = (a || b).section;
    let kind = 'equal';
    if (a && !b) {
      kind = 'onlyA';
      onlyA++;
    } else if (!a && b) {
      kind = 'onlyB';
      onlyB++;
    } else if (a.isBinary && b.isBinary) {
      if (a.vr !== b.vr || !bytesEqual(a.rawBytes, b.rawBytes)) {
        kind = 'changed';
        changed++;
      }
    } else if (a.value !== b.value || a.vr !== b.vr) {
      kind = 'changed';
      changed++;
    }

    const rowObj = { kind, section, a, b };
    entryByKey.set(k, rowObj);

    if (diffOnly && kind === 'equal') continue;
    if (!matchesSearch(a, b)) continue;

    // Include ancestor SQ rows as structural context when nested children match under diffOnly/search
    const parts = k.split('/');
    for (let len = 2; len < parts.length; len += 2) {
      const ancKey = parts.slice(0, len).join('/');
      if (!includedKeys.has(ancKey) && entryByKey.has(ancKey)) {
        const anc = entryByKey.get(ancKey);
        includedKeys.add(ancKey);
        rows.push(anc.kind === 'equal' ? { ...anc, isContext: true } : anc);
      }
    }

    if (!includedKeys.has(k)) {
      includedKeys.add(k);
      rows.push(rowObj);
    }
  }

  return {
    rows,
    total: allKeys.length,
    changed,
    onlyA,
    onlyB,
    diffs: changed + onlyA + onlyB,
  };
}

export class CompareView {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   */
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this.diffOnly = true;
    this.searchQuery = '';
    this.leftPct = 50;
    this.rows = [];
    this.diffIndices = [];
    this.activeRowIdx = -1;
    this._renderToken = 0;
    this._syncingScroll = false;
    this._shellBuilt = false;
  }

  focusSearch() {
    const inp = this.container.querySelector('#cmp-search-input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  reset() {
    this._renderToken++;
    this.diffOnly = true;
    this.searchQuery = '';
    this.rows = [];
    this.diffIndices = [];
    this.activeRowIdx = -1;
    if (this._shellBuilt) {
      const searchInp = this.container.querySelector('#cmp-search-input');
      const clearBtn = this.container.querySelector('#btn-cmp-search-clear');
      const diffCb = this.container.querySelector('#cmp-diff-only');
      const bodyA = this.container.querySelector('#cmp-body-a');
      const bodyB = this.container.querySelector('#cmp-body-b');
      const summaryEl = this.container.querySelector('#cmp-summary');
      if (searchInp) searchInp.value = '';
      if (clearBtn) clearBtn.classList.add('hidden');
      if (diffCb) diffCb.checked = true;
      if (bodyA) bodyA.innerHTML = '';
      if (bodyB) bodyB.innerHTML = '';
      if (summaryEl) summaryEl.innerHTML = '';
      this._updateNavStatus();
    }
  }

  _buildShell() {
    this.container.innerHTML = `
      <div class="compare-topbar">
        <div class="search-box compare-search-box">
          <span class="search-icon">${icons.search(14)}</span>
          <input type="text" id="cmp-search-input" autocomplete="off" />
          <button type="button" class="search-clear hidden" id="btn-cmp-search-clear">×</button>
        </div>
        <label class="checkbox-row small compare-diff-toggle">
          <input type="checkbox" id="cmp-diff-only" checked />
          <span id="cmp-diff-only-lbl"></span>
        </label>
        <div class="toolbar-sep compare-sep"></div>
        <div class="compare-nav-group">
          <button type="button" class="btn btn-xs" id="cmp-prev-diff" disabled>▲</button>
          <span class="compare-nav-pos mono" id="cmp-nav-pos">0 / 0</span>
          <button type="button" class="btn btn-xs" id="cmp-next-diff" disabled>▼</button>
        </div>
        <div class="toolbar-sep compare-sep"></div>
        <div class="compare-stats" id="cmp-summary"></div>
        <button type="button" class="btn btn-sm compare-close-btn" id="btn-cmp-close"></button>
      </div>

      <div class="compare-split" id="compare-split" tabindex="0">
        <div class="compare-side" data-side="a">
          <div class="compare-side-header">
            <span class="compare-side-badge badge-a">A</span>
            <select class="input input-sm compare-select" id="cmp-sel-a"></select>
          </div>
          <div class="compare-col-header">
            <div class="cmp-th col-cmp-tag">Tag</div>
            <div class="cmp-th col-cmp-kw">Keyword</div>
            <div class="cmp-th col-cmp-vr">VR</div>
            <div class="cmp-th col-cmp-val">Value</div>
          </div>
          <div class="compare-side-body" id="cmp-body-a" data-cmp-scroll="a"></div>
        </div>

        <div class="compare-resizer" id="compare-resizer"></div>

        <div class="compare-side" data-side="b">
          <div class="compare-side-header">
            <span class="compare-side-badge badge-b">B</span>
            <select class="input input-sm compare-select" id="cmp-sel-b"></select>
          </div>
          <div class="compare-col-header">
            <div class="cmp-th col-cmp-tag">Tag</div>
            <div class="cmp-th col-cmp-kw">Keyword</div>
            <div class="cmp-th col-cmp-vr">VR</div>
            <div class="cmp-th col-cmp-val">Value</div>
          </div>
          <div class="compare-side-body" id="cmp-body-b" data-cmp-scroll="b"></div>
        </div>
      </div>
    `;

    this._shellBuilt = true;
    this._bindShellEvents();
  }

  _bindShellEvents() {
    const searchInp = this.container.querySelector('#cmp-search-input');
    const clearBtn = this.container.querySelector('#btn-cmp-search-clear');
    const diffCb = this.container.querySelector('#cmp-diff-only');
    const prevBtn = this.container.querySelector('#cmp-prev-diff');
    const nextBtn = this.container.querySelector('#cmp-next-diff');
    const closeBtn = this.container.querySelector('#btn-cmp-close');
    const selA = this.container.querySelector('#cmp-sel-a');
    const selB = this.container.querySelector('#cmp-sel-b');
    const bodyA = this.container.querySelector('#cmp-body-a');
    const bodyB = this.container.querySelector('#cmp-body-b');
    const resizer = this.container.querySelector('#compare-resizer');
    const splitEl = this.container.querySelector('#compare-split');

    searchInp.addEventListener('input', () => {
      this.searchQuery = searchInp.value;
      clearBtn.classList.toggle('hidden', !this.searchQuery);
      this._renderComparison();
    });
    clearBtn.addEventListener('click', () => {
      this.searchQuery = '';
      searchInp.value = '';
      clearBtn.classList.add('hidden');
      searchInp.focus();
      this._renderComparison();
    });

    diffCb.addEventListener('change', () => {
      this.diffOnly = diffCb.checked;
      this._renderComparison();
    });

    prevBtn.addEventListener('click', () => this._stepDiff(-1));
    nextBtn.addEventListener('click', () => this._stepDiff(1));
    closeBtn.addEventListener('click', () => this.store.exitCompareMode());

    selA.addEventListener('change', () => {
      this.store.setCompareFiles(selA.value, this.store.compareFileBId);
    });
    selB.addEventListener('change', () => {
      this.store.setCompareFiles(this.store.compareFileAId, selB.value);
    });

    // Synchronized vertical scroll
    const syncScroll = (src, dst) => {
      if (this._syncingScroll) return;
      this._syncingScroll = true;
      dst.scrollTop = src.scrollTop;
      requestAnimationFrame(() => {
        this._syncingScroll = false;
      });
    };
    bodyA.addEventListener('scroll', () => syncScroll(bodyA, bodyB));
    bodyB.addEventListener('scroll', () => syncScroll(bodyB, bodyA));

    // Synchronized row hover & click selection
    const bindRowSync = (bodyEl) => {
      bodyEl.addEventListener('mouseover', (e) => {
        const row = e.target.closest('.cmp-row[data-row-idx]');
        this._setHoveredIdx(row ? Number(row.dataset.rowIdx) : -1);
      });
      bodyEl.addEventListener('mouseleave', () => this._setHoveredIdx(-1));
      bodyEl.addEventListener('click', (e) => {
        const row = e.target.closest('.cmp-row[data-row-idx]');
        if (!row) return;
        this._setActiveRow(Number(row.dataset.rowIdx), false);
        splitEl.focus({ preventScroll: true });
      });
    };
    bindRowSync(bodyA);
    bindRowSync(bodyB);

    // Keyboard navigation (ArrowUp/Down, PageUp/Down, Home/End) across the whole Compare pane
    this.container.addEventListener('keydown', (e) => this._onKeyDown(e));

    // Center draggable splitter
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizer.classList.add('active');
      const rect = splitEl.getBoundingClientRect();
      const onMove = (ev) => {
        if (rect.width <= 0) return;
        const pct = ((ev.clientX - rect.left) / rect.width) * 100;
        this.leftPct = Math.max(20, Math.min(80, Number(pct.toFixed(2))));
        splitEl.style.setProperty('--cmp-left-pct', `${this.leftPct}%`);
      };
      const onUp = () => {
        resizer.classList.remove('active');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    resizer.addEventListener('dblclick', () => {
      this.leftPct = 50;
      splitEl.style.setProperty('--cmp-left-pct', '50%');
    });

    // Drag-and-drop from Open Files sidebar onto Left (A) or Right (B) pane
    this.container.querySelectorAll('.compare-side').forEach((sideEl) => {
      const side = sideEl.dataset.side;
      let dragCount = 0;

      const isInternalFileDrag = (e) =>
        Array.from(e.dataTransfer?.types || []).includes(INTERNAL_FILE_DRAG_MIME);

      sideEl.addEventListener('dragenter', (e) => {
        if (!isInternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dragCount++;
        sideEl.classList.add('cmp-drop-active');
      });

      sideEl.addEventListener('dragover', (e) => {
        if (!isInternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
      });

      sideEl.addEventListener('dragleave', (e) => {
        if (!isInternalFileDrag(e)) return;
        e.stopPropagation();
        dragCount = Math.max(0, dragCount - 1);
        if (dragCount === 0) sideEl.classList.remove('cmp-drop-active');
      });

      sideEl.addEventListener('drop', (e) => {
        if (!isInternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        dragCount = 0;
        sideEl.classList.remove('cmp-drop-active');
        const fileId = e.dataTransfer.getData(INTERNAL_FILE_DRAG_MIME);
        if (!fileId) return;
        if (side === 'a') {
          this.store.setCompareFiles(fileId, this.store.compareFileBId);
        } else {
          this.store.setCompareFiles(this.store.compareFileAId, fileId);
        }
      });
    });
  }

  _setHoveredIdx(idx) {
    this.container.querySelectorAll('.cmp-row.cmp-hover').forEach((el) => el.classList.remove('cmp-hover'));
    if (idx < 0) return;
    this.container.querySelectorAll(`.cmp-row[data-row-idx="${idx}"]`).forEach((el) => el.classList.add('cmp-hover'));
  }

  _getPageStep() {
    const bodyA = this.container.querySelector('#cmp-body-a');
    const viewportHeight = bodyA?.clientHeight || 0;
    if (!viewportHeight) return 10;
    const rowEl = bodyA.querySelector('.cmp-row');
    const rowHeight = rowEl?.getBoundingClientRect().height || 28;
    return Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
  }

  _onKeyDown(e) {
    if (
      e.defaultPrevented ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.shiftKey ||
      e.target?.closest?.('input:not([type="checkbox"]):not([type="button"]), textarea, select, [contenteditable]')
    ) {
      return;
    }
    if (this.rows.length === 0) return;

    const lastIdx = this.rows.length - 1;
    const cur = this.activeRowIdx;
    let nextIdx = -1;

    switch (e.key) {
      case 'ArrowDown':
        nextIdx = cur < 0 ? 0 : Math.min(lastIdx, cur + 1);
        break;
      case 'ArrowUp':
        nextIdx = cur < 0 ? lastIdx : Math.max(0, cur - 1);
        break;
      case 'PageDown': {
        const base = cur < 0 ? 0 : cur;
        nextIdx = Math.min(lastIdx, base + this._getPageStep());
        break;
      }
      case 'PageUp': {
        const base = cur < 0 ? lastIdx : cur;
        nextIdx = Math.max(0, base - this._getPageStep());
        break;
      }
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = lastIdx;
        break;
      default:
        return;
    }

    e.preventDefault();
    this._setActiveRow(nextIdx, true, 'nearest');
  }

  _setActiveRow(idx, scrollIntoView = true, block = 'nearest') {
    this.activeRowIdx = idx;
    this.container.querySelectorAll('.cmp-row.cmp-active').forEach((el) => el.classList.remove('cmp-active'));
    if (idx >= 0) {
      this.container.querySelectorAll(`.cmp-row[data-row-idx="${idx}"]`).forEach((el) => el.classList.add('cmp-active'));
      if (scrollIntoView) {
        const rowA = this.container.querySelector(`#cmp-body-a .cmp-row[data-row-idx="${idx}"]`);
        const bodyA = this.container.querySelector('#cmp-body-a');
        const bodyB = this.container.querySelector('#cmp-body-b');
        if (rowA && bodyA && bodyB) {
          rowA.scrollIntoView({ block, inline: 'nearest' });
          bodyB.scrollTop = bodyA.scrollTop;
        }
      }
    }
    this._updateNavStatus();
  }

  _stepDiff(direction) {
    if (this.diffIndices.length === 0) return;
    let nextDiffPos;
    const curPos = this.diffIndices.indexOf(this.activeRowIdx);
    if (curPos >= 0) {
      nextDiffPos = (curPos + direction + this.diffIndices.length) % this.diffIndices.length;
    } else if (direction > 0) {
      const found = this.diffIndices.findIndex((rowIdx) => rowIdx > this.activeRowIdx);
      nextDiffPos = found >= 0 ? found : 0;
    } else {
      let found = -1;
      for (let i = this.diffIndices.length - 1; i >= 0; i--) {
        if (this.diffIndices[i] < this.activeRowIdx) {
          found = i;
          break;
        }
      }
      nextDiffPos = found >= 0 ? found : this.diffIndices.length - 1;
    }
    this._setActiveRow(this.diffIndices[nextDiffPos], true, 'center');
  }

  _updateNavStatus() {
    const posEl = this.container.querySelector('#cmp-nav-pos');
    const prevBtn = this.container.querySelector('#cmp-prev-diff');
    const nextBtn = this.container.querySelector('#cmp-next-diff');
    if (!posEl || !prevBtn || !nextBtn) return;

    const totalDiffs = this.diffIndices.length;
    const curPos = this.diffIndices.indexOf(this.activeRowIdx);
    posEl.textContent = totalDiffs === 0 ? '0 / 0' : `${curPos >= 0 ? curPos + 1 : 0} / ${totalDiffs}`;
    prevBtn.disabled = totalDiffs === 0;
    nextBtn.disabled = totalDiffs === 0;
  }

  _syncLabels() {
    const searchInp = this.container.querySelector('#cmp-search-input');
    const clearBtn = this.container.querySelector('#btn-cmp-search-clear');
    const diffLbl = this.container.querySelector('#cmp-diff-only-lbl');
    const prevBtn = this.container.querySelector('#cmp-prev-diff');
    const nextBtn = this.container.querySelector('#cmp-next-diff');
    const closeBtn = this.container.querySelector('#btn-cmp-close');
    const resizer = this.container.querySelector('#compare-resizer');

    if (searchInp) searchInp.placeholder = t('compareSearchPh');
    if (clearBtn) clearBtn.title = t('searchClearTitle');
    if (diffLbl) diffLbl.textContent = t('modalCompareDiffOnly');
    if (prevBtn) prevBtn.title = t('comparePrevDiff');
    if (nextBtn) nextBtn.title = t('compareNextDiff');
    if (closeBtn) closeBtn.innerHTML = `${icons.x(14)}<span>${escapeHtml(t('compareExitBtn'))}</span>`;
    if (resizer) resizer.title = t('compareResizerHint');
  }

  async render(reason = 'state') {
    if (!this.store.compareMode || this.store.files.length < 2) {
      return;
    }
    if (reason === 'layout' && this._shellBuilt) {
      return;
    }
    if (!this._shellBuilt) {
      this._buildShell();
    }
    this._syncLabels();

    const files = this.store.files;
    const selA = this.container.querySelector('#cmp-sel-a');
    const selB = this.container.querySelector('#cmp-sel-b');
    const splitEl = this.container.querySelector('#compare-split');
    splitEl.style.setProperty('--cmp-left-pct', `${this.leftPct}%`);

    const buildOpts = (selectedId) =>
      files
        .map(
          (f, i) =>
            `<option value="${f.id}" ${f.id === selectedId ? 'selected' : ''}>#${i + 1} ${escapeHtml(f.name)}</option>`
        )
        .join('');

    selA.innerHTML = buildOpts(this.store.compareFileAId);
    selB.innerHTML = buildOpts(this.store.compareFileBId);
    const entryA = files.find((f) => f.id === this.store.compareFileAId);
    const entryB = files.find((f) => f.id === this.store.compareFileBId);
    selA.title = entryA ? `${entryA.name} — ${t('compareDropHint')}` : '';
    selB.title = entryB ? `${entryB.name} — ${t('compareDropHint')}` : '';

    await this._renderComparison({ preserveScroll: reason === 'lang' || reason === 'edit' });
  }

  async _renderComparison({ preserveScroll = false } = {}) {
    const token = ++this._renderToken;
    const files = this.store.files;
    const entryA = files.find((f) => f.id === this.store.compareFileAId);
    const entryB = files.find((f) => f.id === this.store.compareFileBId);
    const bodyA = this.container.querySelector('#cmp-body-a');
    const bodyB = this.container.querySelector('#cmp-body-b');
    const summaryEl = this.container.querySelector('#cmp-summary');
    if (!entryA || !entryB || !bodyA || !bodyB) return;

    const prevScrollTop = preserveScroll ? bodyA.scrollTop : 0;

    let docA, docB;
    try {
      docA = await this.store.ensureEntryParsed(entryA);
      docB = await this.store.ensureEntryParsed(entryB);
    } catch (err) {
      if (token !== this._renderToken || !this.store.compareMode || this.store.files.length < 2) return;
      const errHtml = `<div class="compare-empty text-danger">${escapeHtml(err.message)}</div>`;
      bodyA.innerHTML = errHtml;
      bodyB.innerHTML = errHtml;
      this.rows = [];
      this.diffIndices = [];
      this._updateNavStatus();
      return;
    }
    if (token !== this._renderToken || !this.store.compareMode || this.store.files.length < 2) return;

    const result = buildCompareRows(docA, docB, {
      diffOnly: this.diffOnly,
      searchQuery: this.searchQuery,
    });
    const { rows, total, changed, onlyA, onlyB, diffs: totalDiffs } = result;
    const q = this.searchQuery.trim();

    if (summaryEl) {
      summaryEl.title = t('modalCompareSummary', {
        total,
        diffs: totalDiffs,
        changed,
        onlyA,
        onlyB,
      });
      summaryEl.innerHTML = `
        <span class="cmp-stat cmp-stat-total mono">${totalDiffs}/${total}</span>
        <span class="cmp-stat cmp-stat-mod">${escapeHtml(t('modalCompareStChanged'))} ${changed}</span>
        <span class="cmp-stat cmp-stat-a">A ${onlyA}</span>
        <span class="cmp-stat cmp-stat-b">B ${onlyB}</span>
      `;
    }

    this.rows = rows;
    this.diffIndices = [];
    rows.forEach((r, idx) => {
      if (r.kind !== 'equal') this.diffIndices.push(idx);
    });
    this.activeRowIdx = -1;

    if (rows.length === 0) {
      const emptyMsg = totalDiffs === 0 && this.diffOnly && !q ? t('modalCompareSame') : t('treeEmptyMsg');
      const emptyHtml = `<div class="compare-empty">${escapeHtml(emptyMsg)}</div>`;
      bodyA.innerHTML = emptyHtml;
      bodyB.innerHTML = emptyHtml;
      this._updateNavStatus();
      return;
    }

    const renderSectionHeader = (section, count) => {
      const label = section === 'meta' ? t('sectionMeta') : t('sectionMain');
      return `<div class="cmp-section-row section-${section}">
        <span class="section-label">${escapeHtml(label)}</span>
        <span class="section-count">${count}</span>
      </div>`;
    };

    const renderCellRow = (item, kind, side, idx, isContext = false) => {
      if (!item) {
        return `<div class="cmp-row cmp-placeholder cmp-kind-${kind}" data-row-idx="${idx}">
          <div class="cmp-cell col-cmp-tag"></div>
          <div class="cmp-cell col-cmp-kw"></div>
          <div class="cmp-cell col-cmp-vr"></div>
          <div class="cmp-cell col-cmp-val muted">—</div>
        </div>`;
      }
      const spec = getVrSpec(item.vr);
      const indentPx = Math.min(item.depth, 5) * 12;
      const depthPrefix = item.depth > 0 ? '<span class="cmp-depth-mark">↳</span>' : '';
      const valCls = item.isSequence ? 'val-seq' : item.isBinary ? 'val-binary' : item.value === '' ? 'val-empty' : 'val-text';
      const valText = item.value === '' ? '(empty)' : item.value;
      const sideCls =
        kind === 'changed'
          ? 'cmp-changed'
          : kind === 'onlyA' && side === 'a'
            ? 'cmp-only-a'
            : kind === 'onlyB' && side === 'b'
              ? 'cmp-only-b'
              : isContext
                ? 'cmp-equal cmp-context'
                : 'cmp-equal';
      const label = item.keyword !== 'UnknownTag' ? item.keyword : item.name;

      return `<div class="cmp-row ${sideCls}" data-row-idx="${idx}">
        <div class="cmp-cell col-cmp-tag" style="padding-left:${6 + indentPx}px" title="${escapeHtml(item.path)}">${depthPrefix}<span class="tag-code">${escapeHtml(item.tag)}</span></div>
        <div class="cmp-cell col-cmp-kw" title="${escapeHtml(item.name)} (${escapeHtml(item.keyword)})"><span class="tag-name">${escapeHtml(label)}</span></div>
        <div class="cmp-cell col-cmp-vr"><span class="vr-pill vr-cat-${spec.category}" title="${escapeHtml(spec.name)}">${escapeHtml(item.vr)}</span></div>
        <div class="cmp-cell col-cmp-val" title="${escapeHtml(valText)}"><span class="${valCls}">${escapeHtml(valText)}</span></div>
      </div>`;
    };

    const sectionCounts = {
      meta: rows.filter((r) => r.section === 'meta').length,
      main: rows.filter((r) => r.section === 'main').length,
    };

    const htmlA = [];
    const htmlB = [];
    let lastSection = null;
    for (let i = 0; i < rows.length; i++) {
      const { kind, section, a, b, isContext } = rows[i];
      if (section !== lastSection) {
        const secHtml = renderSectionHeader(section, sectionCounts[section]);
        htmlA.push(secHtml);
        htmlB.push(secHtml);
        lastSection = section;
      }
      htmlA.push(renderCellRow(a, kind, 'a', i, isContext));
      htmlB.push(renderCellRow(b, kind, 'b', i, isContext));
    }

    bodyA.innerHTML = htmlA.join('');
    bodyB.innerHTML = htmlB.join('');
    bodyA.scrollTop = prevScrollTop;
    bodyB.scrollTop = prevScrollTop;
    this._updateNavStatus();

    const splitEl = this.container.querySelector('#compare-split');
    const active = document.activeElement;
    if (!preserveScroll && splitEl && (!active || !this.container.contains(active) || !active.closest('input, select'))) {
      splitEl.focus({ preventScroll: true });
    }
  }
}
