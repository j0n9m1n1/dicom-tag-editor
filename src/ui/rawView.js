/**
 * Inline Raw DICOM Workspace View (dcmdump text, DICOM JSON, and Binary Hex dump).
 * Occupies the main workspace pane (like CompareView) and stays live-synced with
 * active tab switches, edits, Undo/Redo, and language changes.
 */

import { formatDcmDump, formatDicomJson } from '../dicom/dcmdump.js';
import { writeDicomDocument } from '../dicom/writer.js';
import { formatByteSize } from '../dicom/parser.js';
import { VR_32BIT_LENGTH } from '../dicom/vrSpec.js';
import { copyTextToClipboard, downloadBlobBytes, stripDicomBaseName } from '../utils/uiHelpers.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const HEX_PAGE_SIZE = 16384; // ~16 KB per page for smooth rendering of large DICOMs
export const HEX_BYTES_PER_ROW_OPTIONS = [8, 16, 24, 32, 64];
const HEX_BPR_STORAGE_KEY = 'dcm_editor_hex_bpr';
const MAX_SEARCH_HIGHLIGHTS = 2000;
const MAX_FULL_HEX_EXPORT_BYTES = 2 * 1024 * 1024; // 2 MB binary -> ~10 MB hex text

function normalizeBytesPerRow(val) {
  const n = Number(val);
  return HEX_BYTES_PER_ROW_OPTIONS.includes(n) ? n : 16;
}

function loadSavedBytesPerRow() {
  try {
    return normalizeBytesPerRow(localStorage.getItem(HEX_BPR_STORAGE_KEY));
  } catch {
    return 16;
  }
}

function saveBytesPerRow(bpr) {
  try {
    localStorage.setItem(HEX_BPR_STORAGE_KEY, String(bpr));
  } catch {
    // ignore restricted storage
  }
}

/**
 * Format the column header ruler matching formatHexSlice() for a given bytesPerRow width.
 * @param {number} [bytesPerRow]
 */
export function formatHexRuler(bytesPerRow = 16) {
  const bpr = normalizeBytesPerRow(bytesPerRow);
  const groups = [];
  for (let start = 0; start < bpr; start += 8) {
    const chunk = [];
    for (let j = 0; j < 8 && start + j < bpr; j++) {
      chunk.push((start + j).toString(16).toUpperCase().padStart(2, '0'));
    }
    groups.push(chunk.join(' '));
  }
  return `${'Offset'.padEnd(8, ' ')}  ${groups.join('  ')}  |ASCII`;
}

/**
 * Format a slice of bytes into hex + ASCII dump lines (8/16/24/32/64 bytes per row).
 * @param {Uint8Array} bytes
 * @param {number} [startOffset]
 * @param {number} [length]
 * @param {number} [bytesPerRow]
 */
export function formatHexSlice(bytes, startOffset = 0, length = HEX_PAGE_SIZE, bytesPerRow = 16) {
  if (!bytes || bytes.length === 0) {
    return { lines: [], text: '(0 bytes)', startOffset: 0, endOffset: 0 };
  }
  const bpr = normalizeBytesPerRow(bytesPerRow);
  const alignedStart = Math.max(0, Math.min(bytes.length, startOffset - (startOffset % bpr)));
  const endOffset = Math.min(bytes.length, alignedStart + Math.max(bpr, length));
  const lines = [];

  for (let off = alignedStart; off < endOffset; off += bpr) {
    const addr = off.toString(16).toUpperCase().padStart(8, '0');
    const groups = [];
    let ascii = '';

    for (let gStart = 0; gStart < bpr; gStart += 8) {
      const chunk = [];
      for (let j = 0; j < 8 && gStart + j < bpr; j++) {
        const idx = off + gStart + j;
        if (idx < endOffset) {
          const b = bytes[idx];
          chunk.push(b.toString(16).toUpperCase().padStart(2, '0'));
          ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
        } else {
          chunk.push('  ');
          ascii += ' ';
        }
      }
      groups.push(chunk.join(' '));
    }

    lines.push({
      offset: off,
      text: `${addr}  ${groups.join('  ')}  |${ascii}|`,
    });
  }

  return {
    lines,
    text: lines.map((l) => l.text).join('\n'),
    startOffset: alignedStart,
    endOffset,
  };
}

function skipUndefinedSequence(bytes, view, startPos, explicit, littleEndian) {
  let pos = startPos;
  while (pos + 8 <= bytes.length) {
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    const len = view.getUint32(pos + 4, littleEndian);
    pos += 8;

    if (g === 0xfffe && e === 0xe0dd && len === 0) {
      return pos;
    }
    if (g !== 0xfffe || e !== 0xe000) {
      return bytes.length;
    }
    if (len !== 0xffffffff) {
      pos += len;
      continue;
    }
    // Undefined-length item: walk elements until (FFFE,E00D)
    while (pos + 8 <= bytes.length) {
      const ig = view.getUint16(pos, littleEndian);
      const ie = view.getUint16(pos + 2, littleEndian);
      if (ig === 0xfffe && ie === 0xe00d && view.getUint32(pos + 4, littleEndian) === 0) {
        pos += 8;
        break;
      }
      if (ig === 0xfffe) return bytes.length;
      const step = readElementSpan(bytes, view, pos, explicit, littleEndian);
      if (!step || step.nextPos <= pos) return bytes.length;
      pos = step.nextPos;
    }
  }
  return bytes.length;
}

function readElementSpan(bytes, view, pos, explicit, littleEndian) {
  if (pos + 8 > bytes.length) return null;
  let hdrLen = 8;
  let len = 0;
  let vr = '';
  let isUnSq = false;

  if (explicit) {
    vr = String.fromCharCode(bytes[pos + 4], bytes[pos + 5]);
    if (VR_32BIT_LENGTH.has(vr)) {
      if (pos + 12 > bytes.length) return null;
      hdrLen = 12;
      len = view.getUint32(pos + 8, littleEndian);
      isUnSq = vr === 'UN' && len === 0xffffffff;
    } else {
      hdrLen = 8;
      len = view.getUint16(pos + 6, littleEndian);
    }
  } else {
    hdrLen = 8;
    len = view.getUint32(pos + 4, littleEndian);
  }

  if (len !== 0xffffffff) {
    return { nextPos: pos + hdrLen + len };
  }
  const itemExplicit = explicit && !isUnSq;
  const itemLittleEndian = isUnSq || littleEndian;
  return { nextPos: skipUndefinedSequence(bytes, view, pos + hdrLen, itemExplicit, itemLittleEndian) };
}

/**
 * Locate structural byte offsets (Preamble, DICM, Main Dataset, PixelData) in a serialized DICOM buffer.
 * @param {Uint8Array} bytes
 * @param {any} doc
 */
export function findSerializedLandmarks(bytes, doc) {
  const landmarks = {
    preambleOffset: null,
    dicmOffset: null,
    mainOffset: 0,
    pixelOffset: null,
  };
  if (!bytes || bytes.length === 0) return landmarks;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hasDicm =
    bytes.length >= 132 &&
    bytes[128] === 0x44 &&
    bytes[129] === 0x49 &&
    bytes[130] === 0x43 &&
    bytes[131] === 0x4d;

  if (hasDicm) {
    landmarks.preambleOffset = 0;
    landmarks.dicmOffset = 128;
    if (
      bytes.length >= 144 &&
      view.getUint16(132, true) === 0x0002 &&
      view.getUint16(134, true) === 0x0000
    ) {
      const metaLen = view.getUint32(140, true);
      landmarks.mainOffset = Math.min(bytes.length, 144 + metaLen);
    } else {
      landmarks.mainOffset = 132;
    }
  }

  if (doc?.wasDeflated) return landmarks;

  const explicit = doc?.explicit !== false;
  const littleEndian = doc?.littleEndian !== false;
  let pos = landmarks.mainOffset;

  while (pos + 8 <= bytes.length) {
    const g = view.getUint16(pos, littleEndian);
    const e = view.getUint16(pos + 2, littleEndian);
    if (g === 0x7fe0 && e === 0x0010) {
      landmarks.pixelOffset = pos;
      break;
    }
    if (g === 0xfffe) break;
    const step = readElementSpan(bytes, view, pos, explicit, littleEndian);
    if (!step || step.nextPos <= pos) break;
    pos = step.nextPos;
  }

  return landmarks;
}

export class RawView {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{ onToast?: (msg: string, type?: string) => void }} [callbacks]
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;

    this.mode = 'dcmdump'; // 'dcmdump' | 'json' | 'hex'
    this.includeDeleted = false;
    this.searchQuery = '';
    this.matchCount = 0;
    this.activeMatchIdx = -1;

    this.hexPage = 0;
    this.hexBytesPerRow = loadSavedBytesPerRow();
    this.hexHighlightOffset = -1;
    this._hexCache = null; // { doc, rev, needsResave, bytes, landmarks }
    this._lastDocRef = null;
    this._renderToken = 0;
    this._searchTimer = null;
    this._shellBuilt = false;
  }

  reset() {
    this._renderToken++;
    this.searchQuery = '';
    this.matchCount = 0;
    this.activeMatchIdx = -1;
    this.hexPage = 0;
    this.hexHighlightOffset = -1;
    this._hexCache = null;
    this._lastDocRef = null;
    if (this._shellBuilt) {
      const searchInp = this.container.querySelector('#raw-search-input');
      const clearBtn = this.container.querySelector('#btn-raw-search-clear');
      const jumpInp = this.container.querySelector('#raw-hex-jump-input');
      const rulerEl = this.container.querySelector('#raw-hex-ruler');
      const preEl = this.container.querySelector('#raw-inline-pre');
      if (searchInp) searchInp.value = '';
      if (clearBtn) clearBtn.classList.add('hidden');
      if (jumpInp) jumpInp.value = '';
      if (rulerEl) {
        rulerEl.textContent = '';
        rulerEl.classList.add('hidden');
      }
      if (preEl) preEl.innerHTML = '';
      this._updateMatchNav();
    }
  }

  focusSearch() {
    const sel = this.mode === 'hex' ? '#raw-hex-jump-input' : '#raw-search-input';
    const inp = this.container.querySelector(sel);
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  getExportExtension() {
    if (this.mode === 'json') return '.json';
    if (this.mode === 'hex') return '.hex.txt';
    return '.txt';
  }

  _buildShell() {
    this.container.innerHTML = `
      <div class="raw-inline-topbar">
        <div class="raw-fmt-group" role="tablist" aria-label="Raw format">
          <button type="button" class="chip active" data-raw-fmt="dcmdump">dcmdump</button>
          <button type="button" class="chip" data-raw-fmt="json">DICOM JSON</button>
          <button type="button" class="chip" data-raw-fmt="hex">Hex</button>
        </div>

        <div class="toolbar-sep raw-inline-sep"></div>

        <!-- Text controls (dcmdump / JSON) -->
        <div class="raw-text-controls" id="raw-text-controls">
          <div class="search-box raw-search-box">
            <span class="search-icon">${icons.search(14)}</span>
            <input type="text" id="raw-search-input" autocomplete="off" />
            <button type="button" class="search-clear hidden" id="btn-raw-search-clear">×</button>
          </div>
          <div class="compare-nav-group">
            <button type="button" class="btn btn-xs" id="raw-prev-match" disabled>▲</button>
            <span class="compare-nav-pos mono" id="raw-match-pos">0 / 0</span>
            <button type="button" class="btn btn-xs" id="raw-next-match" disabled>▼</button>
          </div>
          <label class="checkbox-row small raw-del-toggle">
            <input type="checkbox" id="raw-inc-del" />
            <span id="raw-inc-del-lbl"></span>
          </label>
        </div>

        <!-- Hex controls -->
        <div class="raw-hex-controls hidden" id="raw-hex-controls">
          <div class="raw-hex-jump-box">
            <input type="text" class="input input-sm mono raw-hex-jump-input" id="raw-hex-jump-input" placeholder="0x0080" autocomplete="off" />
            <button type="button" class="btn btn-xs" id="btn-raw-hex-go">Go</button>
          </div>
          <select class="input input-sm mono raw-hex-bpr-select" id="raw-hex-bpr-select">
            ${HEX_BYTES_PER_ROW_OPTIONS.map((n) => `<option value="${n}" ${n === this.hexBytesPerRow ? 'selected' : ''}>${n} B</option>`).join('')}
          </select>
          <div class="raw-hex-landmarks" id="raw-hex-landmarks"></div>
          <div class="compare-nav-group">
            <button type="button" class="btn btn-xs" id="raw-hex-prev" disabled>◀</button>
            <span class="compare-nav-pos mono" id="raw-hex-page-pos">1 / 1</span>
            <button type="button" class="btn btn-xs" id="raw-hex-next" disabled>▶</button>
          </div>
          <span class="cmp-stat cmp-stat-total mono" id="raw-hex-size"></span>
        </div>

        <div class="raw-inline-actions">
          <button type="button" class="btn btn-xs" id="btn-raw-copy"></button>
          <button type="button" class="btn btn-xs" id="btn-raw-export"></button>
          <button type="button" class="btn btn-xs" id="btn-raw-close"></button>
        </div>
      </div>

      <p class="raw-readonly-hint" id="raw-readonly-hint"></p>
      <div class="raw-inline-body" id="raw-inline-body" aria-describedby="raw-readonly-hint">
        <div class="raw-hex-ruler hidden" id="raw-hex-ruler" aria-hidden="true"></div>
        <pre class="raw-inline-pre" id="raw-inline-pre"></pre>
      </div>
    `;
    this._shellBuilt = true;
    this._bindEvents();
  }

  _bindEvents() {
    const searchInp = this.container.querySelector('#raw-search-input');
    const clearBtn = this.container.querySelector('#btn-raw-search-clear');
    const prevMatchBtn = this.container.querySelector('#raw-prev-match');
    const nextMatchBtn = this.container.querySelector('#raw-next-match');
    const delCb = this.container.querySelector('#raw-inc-del');
    const jumpInp = this.container.querySelector('#raw-hex-jump-input');
    const jumpBtn = this.container.querySelector('#btn-raw-hex-go');
    const bprSel = this.container.querySelector('#raw-hex-bpr-select');
    const landmarksEl = this.container.querySelector('#raw-hex-landmarks');
    const prevPageBtn = this.container.querySelector('#raw-hex-prev');
    const nextPageBtn = this.container.querySelector('#raw-hex-next');
    const copyBtn = this.container.querySelector('#btn-raw-copy');
    const exportBtn = this.container.querySelector('#btn-raw-export');
    const closeBtn = this.container.querySelector('#btn-raw-close');

    this.container.querySelectorAll('[data-raw-fmt]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.rawFmt;
        if (this.mode === nextMode) return;
        this.mode = nextMode;
        const bodyEl = this.container.querySelector('#raw-inline-body');
        if (bodyEl) {
          bodyEl.scrollTop = 0;
          bodyEl.scrollLeft = 0;
        }
        this._renderContent();
      });
    });

    searchInp.addEventListener('input', () => {
      this.searchQuery = searchInp.value;
      clearBtn.classList.toggle('hidden', !this.searchQuery);
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this._renderTextContent(), 120);
    });
    searchInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.matchCount > 0) {
        e.preventDefault();
        this._stepMatch(e.shiftKey ? -1 : 1);
      }
    });
    clearBtn.addEventListener('click', () => {
      clearTimeout(this._searchTimer);
      this.searchQuery = '';
      searchInp.value = '';
      clearBtn.classList.add('hidden');
      searchInp.focus();
      this._renderTextContent();
    });
    prevMatchBtn.addEventListener('click', () => this._stepMatch(-1));
    nextMatchBtn.addEventListener('click', () => this._stepMatch(1));

    delCb.addEventListener('change', () => {
      this.includeDeleted = delCb.checked;
      this._renderTextContent();
    });

    const handleHexJump = () => {
      const raw = (jumpInp.value || '').trim();
      if (!raw) return;
      const parsed = /^0x/i.test(raw)
        ? parseInt(raw.slice(2), 16)
        : /^[0-9a-f]+$/i.test(raw)
          ? parseInt(raw, 16)
          : NaN;
      if (Number.isFinite(parsed) && parsed >= 0) {
        this._jumpToHexOffset(parsed);
      }
    };
    jumpBtn.addEventListener('click', handleHexJump);
    jumpInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleHexJump();
      }
    });

    bprSel.addEventListener('change', () => {
      const nextBpr = normalizeBytesPerRow(bprSel.value);
      if (nextBpr === this.hexBytesPerRow) return;
      const anchorOffset = this.hexHighlightOffset >= 0
        ? this.hexHighlightOffset
        : this.hexPage * this._getHexPageSize();
      this.hexBytesPerRow = nextBpr;
      saveBytesPerRow(nextBpr);
      const nextPageSize = this._getHexPageSize();
      this.hexPage = Math.floor(anchorOffset / nextPageSize);
      if (this.hexHighlightOffset >= 0) {
        this.hexHighlightOffset = anchorOffset - (anchorOffset % nextBpr);
      }
      this._renderHexPage(this.hexHighlightOffset >= 0);
    });

    landmarksEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-hex-offset]');
      if (!btn) return;
      this._jumpToHexOffset(Number(btn.dataset.hexOffset));
    });

    prevPageBtn.addEventListener('click', () => {
      if (this.hexPage > 0) {
        this.hexPage--;
        this.hexHighlightOffset = -1;
        this._renderHexPage();
      }
    });
    nextPageBtn.addEventListener('click', () => {
      const totalPages = this._getHexTotalPages();
      if (this.hexPage + 1 < totalPages) {
        this.hexPage++;
        this.hexHighlightOffset = -1;
        this._renderHexPage();
      }
    });

    copyBtn.addEventListener('click', () => this._copyCurrent());
    exportBtn.addEventListener('click', () => this.exportCurrent());
    closeBtn.addEventListener('click', () => this.store.setViewMode('tree'));
  }

  _syncLabels() {
    const readOnlyHint = this.container.querySelector('#raw-readonly-hint');
    const searchInp = this.container.querySelector('#raw-search-input');
    const clearBtn = this.container.querySelector('#btn-raw-search-clear');
    const delLbl = this.container.querySelector('#raw-inc-del-lbl');
    const jumpInp = this.container.querySelector('#raw-hex-jump-input');
    const jumpBtn = this.container.querySelector('#btn-raw-hex-go');
    const bprSel = this.container.querySelector('#raw-hex-bpr-select');
    const copyBtn = this.container.querySelector('#btn-raw-copy');
    const exportBtn = this.container.querySelector('#btn-raw-export');
    const closeBtn = this.container.querySelector('#btn-raw-close');

    if (readOnlyHint) readOnlyHint.textContent = t('rawReadOnlyHint');
    if (searchInp) searchInp.placeholder = t('rawSearchPh');
    if (clearBtn) clearBtn.title = t('searchClearTitle');
    if (delLbl) delLbl.textContent = t('modalRawIncludeDeleted');
    if (jumpInp) jumpInp.title = t('rawHexJumpTitle');
    if (jumpBtn) jumpBtn.textContent = t('rawHexJumpBtn');
    if (bprSel) {
      bprSel.title = t('rawHexBprTitle');
      bprSel.setAttribute('aria-label', t('rawHexBprTitle'));
    }
    if (copyBtn) copyBtn.innerHTML = `${icons.copy(13)}<span>${escapeHtml(t('modalRawCopy'))}</span>`;
    if (exportBtn) exportBtn.innerHTML = `${icons.download(13)}<span>${escapeHtml(t('modalRawExport'))}</span>`;
    if (closeBtn) closeBtn.innerHTML = `${icons.x(13)}<span>${escapeHtml(t('rawExitBtn'))}</span>`;
  }

  async render(reason = 'state') {
    if (this.store.viewMode !== 'raw' || !this.store.doc) {
      return;
    }
    if (reason === 'layout' && this._shellBuilt) {
      return;
    }
    if (!this._shellBuilt) {
      this._buildShell();
    }
    this._syncLabels();
    if (reason === 'lang') {
      return;
    }

    const docChanged = this._lastDocRef !== this.store.doc;
    if (docChanged) {
      this._lastDocRef = this.store.doc;
      this.hexPage = 0;
      this.hexHighlightOffset = -1;
    }

    await this._renderContent({ preserveScroll: !docChanged && reason === 'edit' });
  }

  async _renderContent({ preserveScroll = false } = {}) {
    const isHex = this.mode === 'hex';
    this.container.querySelectorAll('[data-raw-fmt]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.rawFmt === this.mode);
    });
    this.container.querySelector('#raw-text-controls')?.classList.toggle('hidden', isHex);
    this.container.querySelector('#raw-hex-controls')?.classList.toggle('hidden', !isHex);
    this.container.querySelector('#raw-hex-ruler')?.classList.toggle('hidden', !isHex);

    if (isHex) {
      await this._renderHexContent({ preserveScroll });
    } else {
      this._renderTextContent({ preserveScroll });
    }
  }

  _getCurrentText() {
    const doc = this.store.doc;
    if (!doc) return '';
    return this.mode === 'json'
      ? formatDicomJson(doc, { includeDeleted: this.includeDeleted })
      : formatDcmDump(doc, { includeDeleted: this.includeDeleted });
  }

  _renderTextContent({ preserveScroll = false } = {}) {
    const preEl = this.container.querySelector('#raw-inline-pre');
    const bodyEl = this.container.querySelector('#raw-inline-body');
    if (!preEl || !this.store.doc) return;
    const prevScrollTop = preserveScroll && bodyEl ? bodyEl.scrollTop : 0;
    const prevActiveIdx = preserveScroll ? this.activeMatchIdx : -1;
    preEl.classList.remove('raw-hex-pre');

    let text;
    try {
      text = this._getCurrentText();
    } catch (err) {
      preEl.textContent = t('rawTextFormatErr', { msg: err.message });
      this.matchCount = 0;
      this.activeMatchIdx = -1;
      if (bodyEl) bodyEl.scrollTop = 0;
      this._updateMatchNav();
      return;
    }
    const q = this.searchQuery.trim();
    this.matchCount = 0;
    this.activeMatchIdx = -1;

    if (!q) {
      preEl.textContent = text;
      if (bodyEl) bodyEl.scrollTop = prevScrollTop;
      this._updateMatchNav();
      return;
    }

    const re = new RegExp(escapeRegExp(q), 'gi');
    const parts = [];
    let pos = 0;
    let count = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) break;
      const idx = m.index;
      if (idx > pos) {
        parts.push(escapeHtml(text.slice(pos, idx)));
      }
      if (count < MAX_SEARCH_HIGHLIGHTS) {
        parts.push(`<mark class="raw-hl" data-hl-idx="${count}">${escapeHtml(m[0])}</mark>`);
        count++;
      } else {
        parts.push(escapeHtml(text.slice(idx)));
        pos = text.length;
        break;
      }
      pos = idx + m[0].length;
    }
    if (pos < text.length) {
      parts.push(escapeHtml(text.slice(pos)));
    }

    this.matchCount = count;
    preEl.innerHTML = parts.join('');
    if (bodyEl) bodyEl.scrollTop = prevScrollTop;
    if (count > 0) {
      const nextIdx = prevActiveIdx >= 0 ? Math.min(prevActiveIdx, count - 1) : 0;
      this._setActiveMatch(nextIdx, false);
    } else {
      this._updateMatchNav();
    }
  }

  _setActiveMatch(idx, scroll = true) {
    const preEl = this.container.querySelector('#raw-inline-pre');
    if (!preEl) return;
    preEl.querySelector('.raw-hl.active')?.classList.remove('active');
    this.activeMatchIdx = idx;
    if (idx >= 0) {
      const mark = preEl.querySelector(`.raw-hl[data-hl-idx="${idx}"]`);
      if (mark) {
        mark.classList.add('active');
        if (scroll) mark.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    }
    this._updateMatchNav();
  }

  _stepMatch(dir) {
    if (this.matchCount === 0) return;
    const next =
      this.activeMatchIdx < 0
        ? dir > 0 ? 0 : this.matchCount - 1
        : (this.activeMatchIdx + dir + this.matchCount) % this.matchCount;
    this._setActiveMatch(next, true);
  }

  _updateMatchNav() {
    const posEl = this.container.querySelector('#raw-match-pos');
    const prevBtn = this.container.querySelector('#raw-prev-match');
    const nextBtn = this.container.querySelector('#raw-next-match');
    if (!posEl || !prevBtn || !nextBtn) return;

    const suffix = this.matchCount >= MAX_SEARCH_HIGHLIGHTS ? '+' : '';
    posEl.textContent =
      this.matchCount === 0
        ? '0 / 0'
        : `${this.activeMatchIdx >= 0 ? this.activeMatchIdx + 1 : 0} / ${this.matchCount}${suffix}`;
    prevBtn.disabled = this.matchCount === 0;
    nextBtn.disabled = this.matchCount === 0;
  }

  async _ensureHexSerialized() {
    const doc = this.store.doc;
    if (!doc) return null;
    const rev = this.store.getDocumentRevision(doc);
    const needsResave = Boolean(doc.needsResave);
    if (
      this._hexCache &&
      this._hexCache.doc === doc &&
      this._hexCache.rev === rev &&
      this._hexCache.needsResave === needsResave
    ) {
      return this._hexCache;
    }

    const bytes = await writeDicomDocument(doc);
    const landmarks = findSerializedLandmarks(bytes, doc);
    this._hexCache = { doc, rev, needsResave, bytes, landmarks };
    return this._hexCache;
  }

  _getHexPageSize() {
    const bpr = normalizeBytesPerRow(this.hexBytesPerRow);
    return Math.max(bpr, Math.floor(HEX_PAGE_SIZE / bpr) * bpr);
  }

  _getHexTotalPages() {
    const len = this._hexCache?.bytes?.length || 0;
    return Math.max(1, Math.ceil(len / this._getHexPageSize()));
  }

  async _renderHexContent({ preserveScroll = false } = {}) {
    const token = ++this._renderToken;
    const preEl = this.container.querySelector('#raw-inline-pre');
    if (!preEl) return;

    try {
      const cache = await this._ensureHexSerialized();
      if (token !== this._renderToken || this.store.viewMode !== 'raw' || this.mode !== 'hex' || !cache) {
        return;
      }
      const totalPages = this._getHexTotalPages();
      if (this.hexPage >= totalPages) this.hexPage = totalPages - 1;
      this._renderHexLandmarks(cache.landmarks);
      this._renderHexPage(false, preserveScroll);
    } catch (err) {
      if (token !== this._renderToken || this.store.viewMode !== 'raw' || this.mode !== 'hex') return;
      preEl.classList.remove('raw-hex-pre');
      preEl.innerHTML = `<span class="text-danger">${escapeHtml(t('rawHexSerializeErr', { msg: err.message }))}</span>`;
    }
  }

  _renderHexLandmarks(landmarks) {
    const el = this.container.querySelector('#raw-hex-landmarks');
    if (!el || !landmarks) return;
    const btns = [];
    if (landmarks.preambleOffset !== null) {
      btns.push(`<button type="button" class="btn btn-xs" data-hex-offset="${landmarks.preambleOffset}">0x0000 Preamble</button>`);
    }
    if (landmarks.dicmOffset !== null) {
      btns.push(`<button type="button" class="btn btn-xs" data-hex-offset="${landmarks.dicmOffset}">0x0080 DICM</button>`);
    }
    btns.push(`<button type="button" class="btn btn-xs" data-hex-offset="${landmarks.mainOffset}">Main</button>`);
    if (landmarks.pixelOffset !== null) {
      btns.push(`<button type="button" class="btn btn-xs" data-hex-offset="${landmarks.pixelOffset}">PixelData</button>`);
    }
    el.innerHTML = btns.join('');
  }

  _jumpToHexOffset(offset) {
    const bytes = this._hexCache?.bytes;
    if (!bytes || bytes.length === 0) return;
    const bpr = normalizeBytesPerRow(this.hexBytesPerRow);
    const pageSize = this._getHexPageSize();
    const clamped = Math.max(0, Math.min(bytes.length - 1, Math.floor(offset)));
    this.hexPage = Math.floor(clamped / pageSize);
    this.hexHighlightOffset = clamped - (clamped % bpr);
    this._renderHexPage(true);
  }

  _renderHexPage(scrollToHighlight = false, preserveScroll = false) {
    const cache = this._hexCache;
    const preEl = this.container.querySelector('#raw-inline-pre');
    const rulerEl = this.container.querySelector('#raw-hex-ruler');
    const bodyEl = this.container.querySelector('#raw-inline-body');
    const pagePos = this.container.querySelector('#raw-hex-page-pos');
    const prevBtn = this.container.querySelector('#raw-hex-prev');
    const nextBtn = this.container.querySelector('#raw-hex-next');
    const sizeEl = this.container.querySelector('#raw-hex-size');
    if (!cache || !preEl) return;

    const prevScrollTop = preserveScroll && bodyEl ? bodyEl.scrollTop : 0;
    const { bytes } = cache;
    const bpr = normalizeBytesPerRow(this.hexBytesPerRow);
    const pageSize = this._getHexPageSize();
    const totalPages = this._getHexTotalPages();
    if (this.hexPage >= totalPages) this.hexPage = totalPages - 1;
    const startOffset = this.hexPage * pageSize;
    const slice = formatHexSlice(bytes, startOffset, pageSize, bpr);

    if (rulerEl) {
      rulerEl.textContent = formatHexRuler(bpr);
      rulerEl.classList.remove('hidden');
    }

    preEl.classList.add('raw-hex-pre');
    const dicmOff = cache.landmarks.dicmOffset;
    const html = slice.lines
      .map((line) => {
        const isTarget = line.offset === this.hexHighlightOffset;
        const isDicm = dicmOff !== null && line.offset <= dicmOff && dicmOff < line.offset + bpr;
        const cls = isTarget ? 'hex-line hex-line-target' : isDicm ? 'hex-line hex-line-dicm' : 'hex-line';
        return `<span class="${cls}" data-hex-row="${line.offset}">${escapeHtml(line.text)}</span>`;
      })
      .join('\n');
    preEl.innerHTML = html;

    if (pagePos) pagePos.textContent = `${this.hexPage + 1} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = this.hexPage <= 0;
    if (nextBtn) nextBtn.disabled = this.hexPage + 1 >= totalPages;
    if (sizeEl) sizeEl.textContent = `${formatByteSize(bytes.length)} (${bytes.length.toLocaleString()} B)`;

    if (scrollToHighlight && this.hexHighlightOffset >= 0) {
      const row = preEl.querySelector(`[data-hex-row="${this.hexHighlightOffset}"]`);
      row?.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else if (bodyEl) {
      bodyEl.scrollTop = preserveScroll ? prevScrollTop : 0;
    }
  }

  async _copyCurrent() {
    if (!this.store.doc) return;
    let text = '';
    let isHexPageOnly = false;
    if (this.mode === 'hex') {
      const cache = await this._ensureHexSerialized().catch(() => null);
      if (!cache) return;
      const bpr = normalizeBytesPerRow(this.hexBytesPerRow);
      const pageSize = this._getHexPageSize();
      const startOffset = this.hexPage * pageSize;
      text = formatHexSlice(cache.bytes, startOffset, pageSize, bpr).text;
      isHexPageOnly = cache.bytes.length > pageSize;
    } else {
      try {
        text = this._getCurrentText();
      } catch (err) {
        this.callbacks.onToast?.(t('rawTextFormatErr', { msg: err.message }), 'error');
        return;
      }
    }

    if (await copyTextToClipboard(text)) {
      this.callbacks.onToast?.(
        isHexPageOnly
          ? t('toastHexPageCopied', { page: this.hexPage + 1, total: this._getHexTotalPages() })
          : t('toastCopied'),
        'ok'
      );
    }
  }

  async exportCurrent() {
    const doc = this.store.doc;
    if (!doc) return;
    const base = stripDicomBaseName(doc.fileName);

    let content = '';
    let ext = 'txt';
    let suffix = this.mode;
    let mime = 'text/plain;charset=utf-8';
    let isPartialHex = false;

    if (this.mode === 'hex') {
      const cache = await this._ensureHexSerialized().catch((err) => {
        this.callbacks.onToast?.(t('rawHexSerializeErr', { msg: err.message }), 'error');
        return null;
      });
      if (!cache) return;
      const bpr = normalizeBytesPerRow(this.hexBytesPerRow);
      const pageSize = this._getHexPageSize();
      isPartialHex = cache.bytes.length > MAX_FULL_HEX_EXPORT_BYTES;
      const slice = isPartialHex
        ? formatHexSlice(cache.bytes, this.hexPage * pageSize, pageSize, bpr)
        : formatHexSlice(cache.bytes, 0, cache.bytes.length, bpr);
      const header = `# DICOM Hex Dump: ${doc.fileName} (${cache.bytes.length.toLocaleString()} bytes, ${bpr} B/row)` +
        (isPartialHex ? ` [Page ${this.hexPage + 1}/${this._getHexTotalPages()}: 0x${slice.startOffset.toString(16).toUpperCase()} - 0x${slice.endOffset.toString(16).toUpperCase()}]` : '');
      content = `${header}\n\n${formatHexRuler(bpr)}\n${slice.text}\n`;
      ext = 'txt';
      suffix = 'hex';
    } else {
      try {
        content = this._getCurrentText();
      } catch (err) {
        this.callbacks.onToast?.(t('rawTextFormatErr', { msg: err.message }), 'error');
        return;
      }
      if (this.mode === 'json') {
        ext = 'json';
        suffix = 'json';
        mime = 'application/json;charset=utf-8';
      } else {
        ext = 'txt';
        suffix = 'dcmdump';
      }
    }

    downloadBlobBytes(content, mime, `${base}_${suffix}.${ext}`);
    if (isPartialHex) {
      this.callbacks.onToast?.(
        t('toastHexPageExported', { page: this.hexPage + 1, total: this._getHexTotalPages() }),
        'info'
      );
    }
  }
}
