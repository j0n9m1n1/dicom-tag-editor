/**
 * Right-side Tag Inspector Panel.
 * Shows DICOM VR standards (type, max length, padding, VM, format hint),
 * live validation, multi-value editor, date/time helpers, UTF-8 charset guard,
 * hex dump preview for binary tags, and revert/delete actions.
 */

import { getVrSpec, validateVrValue } from '../dicom/vrSpec.js';
import { hasNonAscii, isUtf8Charset } from '../dicom/charset.js';
import { computeVm, formatByteSize } from '../dicom/parser.js';
import { generateDicomUid } from '../dicom/uid.js';
import { icons, escapeHtml } from './icons.js';
import { t, getLocalizedVrText } from '../i18n.js';

function buildHexDump(bytes, maxBytes = 256) {
  if (!bytes || bytes.length === 0) return '(0 bytes)';
  const len = Math.min(bytes.length, maxBytes);
  const lines = [];
  for (let i = 0; i < len; i += 16) {
    const addr = i.toString(16).toUpperCase().padStart(4, '0');
    const hexCols = [];
    let ascii = '';
    for (let j = 0; j < 16; j++) {
      if (i + j < len) {
        const b = bytes[i + j];
        hexCols.push(b.toString(16).toUpperCase().padStart(2, '0'));
        ascii += b >= 32 && b <= 126 ? String.fromCharCode(b) : '.';
      } else {
        hexCols.push('  ');
        ascii += ' ';
      }
    }
    const left = hexCols.slice(0, 8).join(' ');
    const right = hexCols.slice(8).join(' ');
    lines.push(`${addr}  ${left}  ${right}  |${ascii}|`);
  }
  if (bytes.length > maxBytes) {
    lines.push(`... (+${formatByteSize(bytes.length - maxBytes)} more)`);
  }
  return lines.join('\n');
}

function getTodayDicomDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function getNowDicomTime() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}${mm}${ss}`;
}

export class InspectorPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{ onOpenAddTagForItem: (item, seqNode, section) => void }} callbacks
   */
  constructor(container, store, callbacks) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks || {};
    this._renderedNodeId = null;
    this._multiValueMode = false;
    this._showRawHex = false;

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('input', (e) => this._onInput(e));
    this.container.addEventListener('change', (e) => this._onChange(e));
  }

  render(reason = 'state') {
    if (!this.store.doc) {
      this._renderedNodeId = null;
      this.container.innerHTML = `
        <div class="inspector-empty">
          <p>${t('inspEmptyNoDoc')}</p>
        </div>
      `;
      return;
    }

    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info) {
      this._renderedNodeId = null;
      this.container.innerHTML = `
        <div class="inspector-empty">
          <p>${escapeHtml(t('inspEmptySelect'))}</p>
        </div>
      `;
      return;
    }

    // Sequence Item selected
    if (info.isSeqItem) {
      this._renderedNodeId = info.item.id;
      this._renderSeqItem(info);
      return;
    }

    const node = info.node;

    // Preserve focus during live typing in the same node
    const activeEl = document.activeElement;
    const isTypingInside =
      reason === 'edit' &&
      this._renderedNodeId === node.id &&
      activeEl &&
      this.container.contains(activeEl) &&
      (activeEl.matches('[data-inspector-input]') || activeEl.matches('[data-mv-input]'));

    if (isTypingInside) {
      this._updateLiveMetrics(node);
      return;
    }

    if (this._renderedNodeId !== node.id) {
      this._renderedNodeId = node.id;
      const spec = getVrSpec(node.vr);
      // Auto-enable multi-value editor only if value actually contains backslash & VR supports it
      this._multiValueMode = Boolean(
        spec.allowMultiValue && !node.isBinary && !node.isSequence && (node.value || '').includes('\\')
      );
    }

    this._renderNode(info);
  }

  _renderSeqItem(info) {
    const { item, parentSeq, itemIndex, path } = info;
    const childCount = (item.children || []).filter((c) => c.status !== 'deleted').length;
    this.container.innerHTML = `
      <div class="insp-section">
        <div class="insp-breadcrumb">${escapeHtml(path.join(' › '))}</div>
        <div class="insp-header">
          <span class="item-badge">Item #${itemIndex}</span>
          <span class="insp-title">${escapeHtml(t('inspSeqItemTitle', { keyword: parentSeq.keyword }))}</span>
        </div>
        <p class="insp-desc">
          ${t('inspSeqItemDesc', { tag: escapeHtml(parentSeq.formattedTag), count: childCount })}
        </p>
        <div class="insp-actions">
          <button class="btn btn-primary btn-sm" data-action="add-tag-in-item">
            ${icons.plus(14)} ${escapeHtml(t('inspAddTagInItem'))}
          </button>
        </div>
      </div>
    `;
  }

  _renderNode(info) {
    const { node, path } = info;
    const spec = getVrSpec(node.vr);
    const vrText = getLocalizedVrText(spec);
    const isDeleted = node.status === 'deleted';
    const charset = this.store.getSpecificCharacterSet();
    const needsUtf8Warn =
      !node.isBinary &&
      !node.isSequence &&
      hasNonAscii(node.value) &&
      !isUtf8Charset(charset);

    const statusBadgeMap = {
      unchanged: `<span class="status-pill st-unchanged">${escapeHtml(t('stUnchanged'))}</span>`,
      modified: `<span class="status-pill st-modified">${escapeHtml(t('stModified'))}</span>`,
      added: `<span class="status-pill st-added">${escapeHtml(t('stAdded'))}</span>`,
      deleted: `<span class="status-pill st-deleted">${escapeHtml(t('stDeleted'))}</span>`,
    };

    const maxLenText = spec.fixedLength
      ? t('inspLenFixed', { n: spec.fixedLength })
      : spec.maxLength
        ? t('inspLenMax', { n: spec.maxLength, unit: spec.lengthUnit })
        : t('inspLenUnlimited');

    const padText =
      spec.padding === 'null'
        ? t('inspPadNull')
        : spec.padding === 'space'
          ? t('inspPadSpace')
          : t('inspPadNone');

    this.container.innerHTML = `
      <div class="insp-section insp-top">
        <div class="insp-breadcrumb" title="${escapeHtml(path.join(' › '))}">${escapeHtml(path.join(' › '))}</div>
        <div class="insp-header">
          <code class="insp-tag-code">${node.formattedTag}</code>
          ${statusBadgeMap[node.status] || ''}
          ${node.isPrivate ? '<span class="mini-badge badge-private">Private</span>' : ''}
          ${node.isMeta ? '<span class="mini-badge badge-meta">Meta 0002</span>' : ''}
        </div>
        <div class="insp-title">${escapeHtml(node.name)}</div>
        <div class="insp-keyword">${t('inspKeywordLine', { keyword: escapeHtml(node.keyword), vm: escapeHtml(node.vmSpec || '1') })}</div>
      </div>

      <div class="insp-section">
        <div class="insp-section-title">${escapeHtml(t('inspVrSpecTitle'))}</div>
        <div class="vr-spec-card">
          <div class="vr-spec-head">
            <span class="vr-pill vr-cat-${spec.category}">${escapeHtml(node.vr)}</span>
            <strong>${escapeHtml(spec.name)}</strong>
          </div>
          <div class="vr-spec-grid">
            <div><span class="lbl">${escapeHtml(t('inspSpecCategory'))}</span><span>${escapeHtml(spec.category)}</span></div>
            <div><span class="lbl">${escapeHtml(t('inspSpecLength'))}</span><span>${escapeHtml(maxLenText)}</span></div>
            <div><span class="lbl">${escapeHtml(t('inspSpecVm'))}</span><span>${escapeHtml(spec.allowMultiValue ? t('inspVmAllowed') : t('inspVmSingle'))}</span></div>
            <div><span class="lbl">${escapeHtml(t('inspSpecPadding'))}</span><span>${escapeHtml(padText)}</span></div>
          </div>
          <div class="vr-spec-hint"><strong>${escapeHtml(t('inspFormatLabel'))}</strong> ${escapeHtml(vrText.formatHint)}</div>
          <div class="vr-spec-desc">${escapeHtml(vrText.description)}</div>
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-section-header">
          <div class="insp-section-title">${escapeHtml(t('inspEditTitle'))}</div>
          ${this._renderEditorModeToggle(node, spec)}
        </div>
        ${this._renderValueEditor(node, spec, isDeleted)}
        <div id="insp-live-metrics">${this._renderLiveMetricsHtml(node, spec, needsUtf8Warn)}</div>
      </div>

      ${node.status === 'modified' && !node.isBinary && !node.isSequence ? `
        <div class="insp-section insp-diff-box">
          <div class="insp-section-title">${escapeHtml(t('inspOrigCompareTitle'))}</div>
          <div class="diff-orig"><code>${escapeHtml(node.originalValue || '(empty)')}</code></div>
        </div>
      ` : ''}

      ${!node.isBinary && !node.isSequence ? `
        <div class="insp-section">
          <div class="insp-section-header">
            <div class="insp-section-title">${escapeHtml(t('inspRawHexTitle'))}</div>
            <button class="btn-link small" data-action="toggle-raw-hex">
              ${escapeHtml(this._showRawHex ? t('inspRawHexHide') : t('inspRawHexShow'))}
            </button>
          </div>
          ${this._showRawHex ? this._renderRawHexBody(node) : ''}
        </div>
      ` : ''}

      <div class="insp-section insp-footer-actions">
        ${node.status === 'modified' || node.status === 'added' ? `
          <button class="btn btn-sm" data-action="revert-node">
            ${icons.rotateCcw(14)} ${escapeHtml(node.status === 'added' ? t('inspCancelAdd') : t('inspRevertOrig'))}
          </button>
        ` : ''}
        ${node.tag !== '00020010' ? `
          <button class="btn btn-sm ${isDeleted ? 'btn-primary' : 'btn-danger-ghost'}" data-action="toggle-delete">
            ${isDeleted ? `${icons.rotateCcw(14)} ${escapeHtml(t('inspRestoreDel'))}` : `${icons.trash(14)} ${escapeHtml(t('inspDeleteTag'))}`}
          </button>
        ` : `<span class="muted small">${escapeHtml(t('inspCannotDeleteTs'))}</span>`}
      </div>
    `;
  }

  _renderRawHexBody(node) {
    if (node.rawBytes && node.rawBytes.length > 0) {
      const note =
        node.status !== 'unchanged'
          ? `<p class="muted small" style="margin:6px 0 0">${escapeHtml(t('inspRawHexNewNote'))}</p>`
          : '';
      return `
        <pre class="hex-dump">${escapeHtml(buildHexDump(node.rawBytes, 256))}</pre>
        ${note}
      `;
    }
    const encoded = new TextEncoder().encode(node.value || '');
    return `
      <pre class="hex-dump">${escapeHtml(buildHexDump(encoded, 256))}</pre>
      <p class="muted small" style="margin:6px 0 0">${escapeHtml(t('inspRawHexNewNote'))}</p>
    `;
  }

  _renderEditorModeToggle(node, spec) {
    if (node.isBinary || node.isSequence || !spec.allowMultiValue) return '';
    return `
      <button class="btn-link small" data-action="toggle-mv-mode">
        ${escapeHtml(this._multiValueMode ? t('inspSwitchRaw') : t('inspSwitchMv'))}
      </button>
    `;
  }

  _renderValueEditor(node, spec, isDeleted) {
    if (node.isSequence) {
      const count = (node.items || []).length;
      return `
        <div class="seq-editor-box">
          <p class="muted small">${t('inspSeqBoxDesc', { count })}</p>
          <button class="btn btn-sm btn-primary" data-action="add-seq-item" ${isDeleted ? 'disabled' : ''}>
            ${icons.plus(14)} ${escapeHtml(t('inspAddSeqItem'))}
          </button>
        </div>
      `;
    }

    if (node.isBinary) {
      const dump = buildHexDump(node.rawBytes, 256);
      return `
        <div class="binary-editor-box">
          <div class="binary-meta">
            <span>${escapeHtml(t('inspBinarySize'))} <strong>${formatByteSize(node.rawLength)}</strong></span>
            <span>${node.encapsulated ? escapeHtml(t('inspBinaryEncap', { n: (node.fragments || []).length })) : 'Raw Binary'}</span>
          </div>
          <p class="muted small">${escapeHtml(t('inspBinaryNote'))}</p>
          <pre class="hex-dump">${escapeHtml(dump)}</pre>
        </div>
      `;
    }

    // Multi-value list mode
    if (this._multiValueMode && spec.allowMultiValue) {
      const parts = (node.value || '').split('\\');
      const rows = parts
        .map(
          (p, i) => `
          <div class="mv-row">
            <span class="mv-idx">#${i + 1}</span>
            <input class="input mv-input" data-mv-input="${i}" value="${escapeHtml(p)}" ${isDeleted ? 'disabled' : ''} />
            <button class="btn-icon" data-action="mv-remove" data-mv-idx="${i}" title="${escapeHtml(t('inspMvRemoveTitle'))}" ${isDeleted || parts.length <= 1 ? 'disabled' : ''}>${icons.x(14)}</button>
          </div>
        `
        )
        .join('');
      return `
        <div class="mv-editor">
          ${rows}
          <button class="btn btn-sm" data-action="mv-add" ${isDeleted ? 'disabled' : ''}>${icons.plus(14)} ${escapeHtml(t('inspMvAdd'))}</button>
        </div>
      `;
    }

    // Long text area
    if (node.vr === 'LT' || node.vr === 'ST' || node.vr === 'UT') {
      return `
        <textarea class="input insp-textarea" rows="5" data-inspector-input="true" ${isDeleted ? 'disabled' : ''}>${escapeHtml(node.value)}</textarea>
      `;
    }

    // Quick helpers for DA / TM
    let helperHtml = '';
    if (node.vr === 'DA' && !isDeleted) {
      const isoVal = /^\d{8}$/.test(node.value || '')
        ? `${node.value.slice(0, 4)}-${node.value.slice(4, 6)}-${node.value.slice(6, 8)}`
        : '';
      helperHtml = `
        <div class="quick-helpers">
          <input type="date" class="input input-sm" data-action="pick-date" value="${isoVal}" title="${escapeHtml(t('inspPickDateTitle'))}" />
          <button class="btn btn-sm" data-action="fill-today">${escapeHtml(t('inspFillToday', { date: getTodayDicomDate() }))}</button>
        </div>
      `;
    } else if (node.vr === 'TM' && !isDeleted) {
      helperHtml = `
        <div class="quick-helpers">
          <button class="btn btn-sm" data-action="fill-now">${escapeHtml(t('inspFillNow', { time: getNowDicomTime() }))}</button>
        </div>
      `;
    } else if (node.vr === 'UI' && !isDeleted && node.tag !== '00020010' && node.tag !== '00020002' && node.tag !== '00080016') {
      helperHtml = `
        <div class="quick-helpers">
          <button class="btn btn-sm" data-action="gen-uid">${icons.sparkles(13)} ${escapeHtml(t('inspGenUid'))}</button>
        </div>
      `;
    }

    return `
      <input class="input insp-input" type="text" data-inspector-input="true" value="${escapeHtml(node.value)}" placeholder="${escapeHtml(t('inspPlaceholderEmpty'))}" ${isDeleted ? 'disabled' : ''} />
      ${helperHtml}
    `;
  }

  _renderLiveMetricsHtml(node, spec, needsUtf8Warn) {
    if (node.isBinary || node.isSequence) return '';
    const val = node.value || '';
    const byteLen = new TextEncoder().encode(val).length;
    const charLen = val.length;
    const vm = computeVm(node);
    const v = node.validation || validateVrValue(node.vr, val);

    const limitInfo = spec.maxLength
      ? `${spec.lengthUnit === 'chars' ? charLen : byteLen} / ${spec.maxLength} ${spec.lengthUnit}`
      : `${byteLen} bytes`;

    let statusBox;
    if (v.severity === 'error') {
      statusBox = `
        <div class="val-feedback val-error">
          ${icons.alertCircle(14)}
          <div>${v.messages.map((m) => `<div>${escapeHtml(m)}</div>`).join('')}</div>
        </div>
      `;
    } else if (v.severity === 'warning') {
      statusBox = `
        <div class="val-feedback val-warn">
          ${icons.alertCircle(14)}
          <div>${v.messages.map((m) => `<div>${escapeHtml(m)}</div>`).join('')}</div>
        </div>
      `;
    } else {
      statusBox = `
        <div class="val-feedback val-ok">
          ${icons.checkCircle(14)}
          <span>${escapeHtml(t('inspVrValidOk', { vr: node.vr }))}</span>
        </div>
      `;
    }

    const charsetWarn = needsUtf8Warn
      ? `
        <div class="val-feedback val-warn charset-warn">
          ${icons.alertCircle(14)}
          <div>
            <div>${t('inspCharsetWarn')}</div>
            <button class="btn btn-sm btn-primary" data-action="set-utf8" style="margin-top:6px">${escapeHtml(t('inspSetUtf8Btn'))}</button>
          </div>
        </div>
      `
      : '';

    return `
      <div class="insp-metrics-bar">
        <span>${escapeHtml(t('inspMetricLen'))} <strong>${escapeHtml(limitInfo)}</strong></span>
        <span>${escapeHtml(t('inspMetricBytes'))} <strong>${byteLen} B</strong>${(byteLen & 1) === 1 ? escapeHtml(t('inspMetricPadNote')) : ''}</span>
        <span>VM: <strong>${vm}</strong></span>
      </div>
      ${statusBox}
      ${charsetWarn}
    `;
  }

  _updateLiveMetrics(node) {
    const el = this.container.querySelector('#insp-live-metrics');
    if (!el) return;
    const spec = getVrSpec(node.vr);
    const charset = this.store.getSpecificCharacterSet();
    const needsUtf8Warn = hasNonAscii(node.value) && !isUtf8Charset(charset);
    el.innerHTML = this._renderLiveMetricsHtml(node, spec, needsUtf8Warn);
  }

  _onInput(e) {
    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info || info.isSeqItem) return;

    if (e.target.matches('[data-inspector-input]')) {
      this.store.updateNodeValue(info.node.id, e.target.value);
      return;
    }

    if (e.target.matches('[data-mv-input]')) {
      const inputs = [...this.container.querySelectorAll('[data-mv-input]')];
      const joined = inputs.map((i) => i.value).join('\\');
      this.store.updateNodeValue(info.node.id, joined);
    }
  }

  _onChange(e) {
    if (e.target.matches('[data-action="pick-date"]')) {
      const iso = e.target.value; // YYYY-MM-DD
      if (iso) {
        const dcmDate = iso.replace(/-/g, '');
        this.store.updateNodeValue(this.store.selectedId, dcmDate);
      }
    }
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info) return;

    switch (action) {
      case 'add-tag-in-item':
        if (info.isSeqItem && this.callbacks.onOpenAddTagForItem) {
          this.callbacks.onOpenAddTagForItem(info.item, info.parentSeq, info.section);
        }
        break;
      case 'revert-node':
        this.store.revertNode(info.node.id);
        break;
      case 'toggle-delete':
        this.store.toggleDeleteNode(info.node.id);
        break;
      case 'add-seq-item':
        this.store.addSequenceItem(info.node.id);
        break;
      case 'toggle-mv-mode':
        this._multiValueMode = !this._multiValueMode;
        this._renderNode(info);
        break;
      case 'toggle-raw-hex':
        this._showRawHex = !this._showRawHex;
        this._renderNode(info);
        break;
      case 'mv-add': {
        const cur = info.node.value || '';
        this.store.updateNodeValue(info.node.id, `${cur}\\`);
        this._renderNode(info);
        break;
      }
      case 'mv-remove': {
        const idx = Number(btn.dataset.mvIdx);
        const parts = (info.node.value || '').split('\\');
        if (parts.length > 1) {
          parts.splice(idx, 1);
          this.store.updateNodeValue(info.node.id, parts.join('\\'));
          this._renderNode(info);
        }
        break;
      }
      case 'fill-today':
        this.store.updateNodeValue(info.node.id, getTodayDicomDate());
        break;
      case 'fill-now':
        this.store.updateNodeValue(info.node.id, getNowDicomTime());
        break;
      case 'gen-uid':
        this.store.updateNodeValue(info.node.id, generateDicomUid());
        break;
      case 'set-utf8':
        this.store.ensureUtf8Charset();
        break;
      default:
        break;
    }
  }
}
