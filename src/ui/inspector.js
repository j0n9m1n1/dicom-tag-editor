/**
 * Right-side Tag Inspector Panel.
 * Features:
 *  1. Top-first Value Editor with header-level quick actions (Copy Tag, Copy Value, Revert, Delete)
 *  2. Clickable Breadcrumb navigation for nested Sequences & Items
 *  3. Automatic human-readable name resolution for known Transfer Syntax & SOP Class UIDs
 *  4. One-click Quick Preset chips for common CS tags (Modality, PatientSex, Photometric, Position, Charset)
 *  5. Structured Person Name (PN) component editor (Family^Given^Middle^Prefix^Suffix & = Ideographic group)
 *  6. Multi-value list editor, DA/TM/UI helpers, UTF-8 charset guard, VR Standard Spec card, and Raw Hex dump
 */

import { getVrSpec, validateVrValue, NUMERIC_VRS } from '../dicom/vrSpec.js';
import { lookupUidName } from '../dicom/dictionary.js';
import { hasNonAscii, isUtf8Charset, usesSpecificCharacterSet } from '../dicom/charset.js';
import { computeVm, formatByteSize } from '../dicom/parser.js';
import { encodeBinaryNumeric } from '../dicom/writer.js';
import { generateDicomUid } from '../dicom/uid.js';
import { getPhiTagInfo } from '../dicom/phiSpec.js';
import { getReadOnlyTagMessage } from '../state/store.js';
import { copyTextToClipboard } from '../utils/uiHelpers.js';
import { icons, escapeHtml } from './icons.js';
import { t, getLocalizedVrText } from '../i18n.js';

const TAG_QUICK_PRESETS = {
  '00100040': ['M', 'F', 'O'],
  '00080060': ['CT', 'MR', 'US', 'DX', 'CR', 'PT', 'NM', 'XA', 'MG', 'SR', 'OT'],
  '00280004': ['MONOCHROME2', 'MONOCHROME1', 'RGB', 'YBR_FULL_422'],
  '00185100': ['HFS', 'HFP', 'FFS', 'FFP', 'HFDR', 'HFDL'],
  '00080005': ['ISO_IR 192', 'ISO_IR 100', 'ISO 2022 IR 149'],
  '00120062': ['YES', 'NO'],
  '00400252': ['IN PROGRESS', 'DISCONTINUED', 'COMPLETED'],
};

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

/**
 * Parse a DICOM PN string (first value if multi-valued) into Alphabetic and Ideographic 5-component arrays.
 */
function parsePnComponents(val) {
  const firstVal = String(val || '').split('\\')[0];
  const groups = firstVal.split('=');
  const parseGroup = (g) => {
    const parts = (g || '').split('^');
    return [parts[0] || '', parts[1] || '', parts[2] || '', parts[3] || '', parts[4] || ''];
  };
  return {
    alpha: parseGroup(groups[0]),
    ideo: parseGroup(groups[1]),
    phonetic: groups[2] || '',
  };
}

function composePnComponents(alpha, ideo, phonetic = '') {
  const trimComponents = (arr) => {
    const copy = arr.slice();
    while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
    return copy.join('^');
  };
  const g1 = trimComponents(alpha);
  const g2 = trimComponents(ideo);
  const g3 = (phonetic || '').trim();
  if (g3) return `${g1}=${g2}=${g3}`;
  if (g2) return `${g1}=${g2}`;
  return g1;
}

export class InspectorPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{
   *   onOpenAddTagForItem?: (item: any, seqNode: any, section: string) => void,
   *   onToast?: (msg: string, type?: string) => void,
   * }} callbacks
   */
  constructor(container, store, callbacks) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks || {};
    this._renderedNodeId = null;
    this._multiValueMode = false;
    this._pnStructuredMode = false;
    this._showRawHex = false;
    this._showVrSpec = true;

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('input', (e) => this._onInput(e));
    this.container.addEventListener('change', (e) => this._onChange(e));
  }

  async _copyText(str) {
    if (await copyTextToClipboard(str)) {
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    }
  }

  _renderBreadcrumbs(info) {
    const crumbs = info.breadcrumbs || (info.path || []).map((label) => ({ id: null, label }));
    return crumbs
      .map((c, idx) => {
        const isLast = idx === crumbs.length - 1;
        if (c.id && !isLast) {
          return `<button type="button" class="crumb-link" data-jump-crumb="${c.id}">${escapeHtml(c.label)}</button>`;
        }
        return `<span class="crumb-item ${isLast ? 'crumb-current' : ''}">${escapeHtml(c.label)}</span>`;
      })
      .join('<span class="crumb-sep">›</span>');
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

    if (info.isSeqItem) {
      this._renderedNodeId = info.item.id;
      this._renderSeqItem(info);
      return;
    }

    const node = info.node;

    // Preserve focus during live typing in the same node (only when still editable)
    const activeEl = document.activeElement;
    const isEffectivelyDeleted = node.status === 'deleted' || Boolean(info.ancestorDeleted);
    const isTypingInside =
      (reason === 'edit' || reason === 'save') &&
      !isEffectivelyDeleted &&
      this._renderedNodeId === node.id &&
      activeEl &&
      this.container.contains(activeEl) &&
      (activeEl.matches('[data-inspector-input]') ||
        activeEl.matches('[data-mv-input]') ||
        activeEl.matches('[data-pn-input]'));

    if (isTypingInside) {
      this._syncLiveInputsAndMetrics(node, info);
      return;
    }

    if (this._renderedNodeId !== node.id) {
      this._renderedNodeId = node.id;
      const spec = getVrSpec(node.vr);
      this._multiValueMode = Boolean(
        spec.allowMultiValue && !node.isBinary && !node.isSequence && (node.value || '').includes('\\')
      );
      this._pnStructuredMode = Boolean(
        node.vr === 'PN' && ((node.value || '').includes('^') || (node.value || '').includes('='))
      );
    }

    this._renderNode(info);
  }

  _renderSeqItem(info) {
    const { item, parentSeq, itemIndex } = info;
    const childCount = (item.children || []).filter((c) => c.status !== 'deleted').length;
    const isDisabled = parentSeq.status === 'deleted' || Boolean(info.ancestorDeleted);
    this.container.innerHTML = `
      <div class="insp-section">
        <div class="insp-breadcrumb">${this._renderBreadcrumbs(info)}</div>
        <div class="insp-header">
          <span class="item-badge">Item #${itemIndex}</span>
          <span class="insp-title">${escapeHtml(t('inspSeqItemTitle', { keyword: parentSeq.keyword }))}</span>
        </div>
        <p class="insp-desc">
          ${t('inspSeqItemDesc', { tag: escapeHtml(parentSeq.formattedTag), count: childCount })}
        </p>
        <div class="insp-actions">
          <button class="btn btn-primary btn-sm" data-action="add-tag-in-item" ${isDisabled ? 'disabled' : ''}>
            ${icons.plus(14)} ${escapeHtml(t('inspAddTagInItem'))}
          </button>
          <button class="btn btn-danger-ghost btn-sm" data-action="delete-seq-item" ${isDisabled ? 'disabled' : ''}>
            ${icons.trash(14)} ${escapeHtml(t('inspDeleteSeqItem'))}
          </button>
        </div>
      </div>
    `;
  }

  _renderStatusBadge(status) {
    const statusBadgeMap = {
      unchanged: `<span class="status-pill st-unchanged">${escapeHtml(t('stUnchanged'))}</span>`,
      modified: `<span class="status-pill st-modified">${escapeHtml(t('stModified'))}</span>`,
      added: `<span class="status-pill st-added">${escapeHtml(t('stAdded'))}</span>`,
      deleted: `<span class="status-pill st-deleted">${escapeHtml(t('stDeleted'))}</span>`,
    };
    return statusBadgeMap[status] || '';
  }

  _renderTopActionsHtml(node, info) {
    const isDeleted = node.status === 'deleted';
    const canDelete = !info.ancestorDeleted && !getReadOnlyTagMessage(node.tag);
    const canRevert = canDelete && (node.status === 'modified' || node.status === 'added');
    return `
      ${canRevert ? `
        <button class="btn btn-xs" data-action="revert-node" title="${escapeHtml(node.status === 'added' ? t('inspCancelAdd') : t('inspRevertOrig'))}">
          ${icons.rotateCcw(12)} ${escapeHtml(node.status === 'added' ? t('inspCancelAdd') : t('inspRevertOrig'))}
        </button>
      ` : ''}
      ${canDelete ? `
        <button class="btn btn-xs ${isDeleted ? 'btn-primary' : 'btn-danger-ghost'}" data-action="toggle-delete">
          ${isDeleted ? `${icons.rotateCcw(12)} ${escapeHtml(t('inspRestoreDel'))}` : `${icons.trash(12)} ${escapeHtml(t('inspDeleteTag'))}`}
        </button>
      ` : ''}
    `;
  }

  _renderOrigInlineHtml(node) {
    if (node.status !== 'modified' || node.isBinary || node.isSequence) return '';
    return `
      <div class="insp-orig-inline">
        <span class="muted">${escapeHtml(t('inspOrigCompareTitle'))}:</span>
        <code>${escapeHtml(node.originalValue || '(empty)')}</code>
      </div>
    `;
  }

  _renderNode(info) {
    const { node } = info;
    const spec = getVrSpec(node.vr);
    const vrText = getLocalizedVrText(spec);
    const isDeleted = node.status === 'deleted' || Boolean(info.ancestorDeleted);
    const charset = this.store.getSpecificCharacterSet();
    const needsUtf8Warn =
      info.section === 'main' &&
      usesSpecificCharacterSet(node.vr) &&
      hasNonAscii(node.value) &&
      !isUtf8Charset(charset);

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

    const phiInfo = getPhiTagInfo(node.tag);

    this.container.innerHTML = `
      <!-- 1. Compact Header with Breadcrumbs, Copy & Revert/Delete Actions -->
      <div class="insp-section insp-top">
        <div class="insp-breadcrumb">${this._renderBreadcrumbs(info)}</div>
        <div class="insp-header-row">
          <div class="insp-header">
            <code class="insp-tag-code">${node.formattedTag}</code>
            <button class="btn-icon insp-copy-btn" data-action="copy-tag" title="${escapeHtml(t('inspCopyTagTitle'))}">${icons.copy(13)}</button>
            ${!node.isBinary && !node.isSequence ? `<button class="btn-icon insp-copy-btn" data-action="copy-val" title="${escapeHtml(t('inspCopyValTitle'))}">${icons.code(13)}</button>` : ''}
            <span id="insp-status-slot">${this._renderStatusBadge(node.status)}</span>
            ${phiInfo ? `<span class="mini-badge badge-phi" title="${escapeHtml(t('inspPhiActionTitle', { action: phiInfo.action }))}">PHI · ${escapeHtml(phiInfo.action)}</span>` : ''}
            ${node.isPrivate ? '<span class="mini-badge badge-private">Private</span>' : ''}
            ${node.isMeta ? '<span class="mini-badge badge-meta">Meta 0002</span>' : ''}
          </div>
          <div class="insp-top-actions" id="insp-top-actions">
            ${this._renderTopActionsHtml(node, info)}
          </div>
        </div>
        <div class="insp-title">${escapeHtml(node.name)}</div>
        <div class="insp-keyword">${t('inspKeywordLine', { keyword: escapeHtml(node.keyword), vm: escapeHtml(node.vmSpec || '1') })}</div>
      </div>

      <!-- 2. Value Editor (Top Priority) -->
      <div class="insp-section">
        <div class="insp-section-header">
          <div class="insp-section-title">${escapeHtml(t('inspEditTitle'))}</div>
          ${this._renderEditorModeToggle(node, spec)}
        </div>
        ${this._renderValueEditor(node, spec, isDeleted)}
        <div id="insp-live-metrics">${this._renderLiveMetricsHtml(node, spec, needsUtf8Warn)}</div>
        <div id="insp-orig-slot">${this._renderOrigInlineHtml(node)}</div>
      </div>

      <!-- 3. Raw Bytes (Hex) Accordion (above VR Spec) -->
      ${!node.isBinary && !node.isSequence ? `
        <div class="insp-section insp-accordion ${this._showRawHex ? 'open' : ''}" id="insp-sec-rawhex">
          <button type="button" class="insp-acc-header" data-action="toggle-raw-hex" aria-expanded="${this._showRawHex}">
            <span class="insp-acc-left">
              ${this._showRawHex ? icons.chevronDown(14) : icons.chevronRight(14)}
              <span class="insp-section-title">${escapeHtml(t('inspRawHexTitle'))}</span>
            </span>
            <span class="insp-acc-meta mono" id="insp-rawhex-len">${this._getEncodedPreviewBytes(node).length} B</span>
          </button>
          ${this._showRawHex ? `<div class="insp-acc-body" id="insp-rawhex-body">${this._renderRawHexBody(node)}</div>` : ''}
        </div>
      ` : ''}

      <!-- 4. VR Standard Spec Accordion -->
      <div class="insp-section insp-accordion ${this._showVrSpec ? 'open' : ''}" id="insp-sec-vrspec">
        <button type="button" class="insp-acc-header" data-action="toggle-vr-spec" aria-expanded="${this._showVrSpec}">
          <span class="insp-acc-left">
            ${this._showVrSpec ? icons.chevronDown(14) : icons.chevronRight(14)}
            <span class="insp-section-title">${escapeHtml(t('inspVrSpecTitle'))}</span>
          </span>
          <span class="insp-acc-meta">
            <span class="vr-pill vr-cat-${spec.category}">${escapeHtml(node.vr)}</span>
            <span class="muted small">${escapeHtml(spec.name)}</span>
          </span>
        </button>
        ${this._showVrSpec ? `
          <div class="insp-acc-body">
            <div class="vr-spec-card">
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
        ` : ''}
      </div>
    `;
  }

  _getEncodedPreviewBytes(node) {
    if (node.status === 'unchanged' && node.rawBytes instanceof Uint8Array) {
      return node.rawBytes;
    }
    if (NUMERIC_VRS.has(node.vr) || node.vr === 'AT') {
      return encodeBinaryNumeric(node.value, node.vr, this.store.doc?.littleEndian !== false, node.tag);
    }
    return new TextEncoder().encode(node.value || '');
  }

  _renderRawHexBody(node) {
    if (node.status === 'unchanged' && node.rawBytes && node.rawBytes.length > 0) {
      return `<pre class="hex-dump">${escapeHtml(buildHexDump(node.rawBytes, 256))}</pre>`;
    }
    const encoded = this._getEncodedPreviewBytes(node);
    return `
      <pre class="hex-dump">${escapeHtml(buildHexDump(encoded, 256))}</pre>
      <p class="muted small" style="margin:6px 0 0">${escapeHtml(t('inspRawHexNewNote'))}</p>
    `;
  }

  _renderEditorModeToggle(node, spec) {
    if (node.isBinary || node.isSequence || getReadOnlyTagMessage(node.tag)) return '';
    if (node.vr === 'PN') {
      return `
        <button class="btn-link small" data-action="toggle-pn-mode">
          ${escapeHtml(this._pnStructuredMode ? t('inspPnRawToggle') : t('inspPnToggle'))}
        </button>
      `;
    }
    if (!spec.allowMultiValue) return '';
    return `
      <button class="btn-link small" data-action="toggle-mv-mode">
        ${escapeHtml(this._multiValueMode ? t('inspSwitchRaw') : t('inspSwitchMv'))}
      </button>
    `;
  }

  _renderQuickPresets(node, isDeleted) {
    if (isDeleted) return '';
    const presets = TAG_QUICK_PRESETS[node.tag];
    if (!presets) return '';
    const cur = (node.value || '').trim();
    const chips = presets
      .map(
        (val) => `
        <button type="button" class="preset-chip ${cur === val ? 'active' : ''}" data-preset-val="${escapeHtml(val)}">${escapeHtml(val)}</button>
      `
      )
      .join('');
    return `
      <div class="insp-presets-row">
        <span class="preset-lbl">${escapeHtml(t('inspQuickPresetLabel'))}</span>
        <div class="preset-chips">${chips}</div>
      </div>
    `;
  }

  _renderPnStructuredEditor(node, isDeleted) {
    const parsed = parsePnComponents(node.value);
    const dis = isDeleted ? 'disabled' : '';
    return `
      <div class="pn-struct-box">
        <input class="input insp-input" type="text" data-inspector-input="true" value="${escapeHtml(node.value)}" placeholder="${escapeHtml(t('inspPlaceholderEmpty'))}" ${dis} style="margin-bottom:8px" />
        <div class="pn-group-label">${escapeHtml(t('inspPnAlphaGroup'))}</div>
        <div class="pn-grid-2">
          <input class="input input-sm" data-pn-input="a0" value="${escapeHtml(parsed.alpha[0])}" placeholder="${escapeHtml(t('inspPnFamily'))}" ${dis} />
          <input class="input input-sm" data-pn-input="a1" value="${escapeHtml(parsed.alpha[1])}" placeholder="${escapeHtml(t('inspPnGiven'))}" ${dis} />
        </div>
        <div class="pn-grid-3" style="margin-top:5px">
          <input class="input input-sm" data-pn-input="a2" value="${escapeHtml(parsed.alpha[2])}" placeholder="${escapeHtml(t('inspPnMiddle'))}" ${dis} />
          <input class="input input-sm" data-pn-input="a3" value="${escapeHtml(parsed.alpha[3])}" placeholder="${escapeHtml(t('inspPnPrefix'))}" ${dis} />
          <input class="input input-sm" data-pn-input="a4" value="${escapeHtml(parsed.alpha[4])}" placeholder="${escapeHtml(t('inspPnSuffix'))}" ${dis} />
        </div>
        <div class="pn-group-label" style="margin-top:8px">${escapeHtml(t('inspPnIdeoGroup'))}</div>
        <div class="pn-grid-2">
          <input class="input input-sm" data-pn-input="i0" value="${escapeHtml(parsed.ideo[0])}" placeholder="${escapeHtml(t('inspPnFamily'))}" ${dis} />
          <input class="input input-sm" data-pn-input="i1" value="${escapeHtml(parsed.ideo[1])}" placeholder="${escapeHtml(t('inspPnGiven'))}" ${dis} />
        </div>
      </div>
    `;
  }

  _renderValueEditor(node, spec, isDeleted) {
    const readOnlyMessage = getReadOnlyTagMessage(node.tag);
    if (readOnlyMessage) {
      return `
        <input class="input insp-input mono" value="${escapeHtml(node.value)}" readonly aria-label="${escapeHtml(node.name)}" />
        <p class="muted small">${escapeHtml(t(readOnlyMessage))}</p>
      `;
    }

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

    // Structured PN mode
    if (node.vr === 'PN' && this._pnStructuredMode) {
      return this._renderPnStructuredEditor(node, isDeleted);
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
        <textarea class="input insp-textarea" rows="4" data-inspector-input="true" ${isDeleted ? 'disabled' : ''}>${escapeHtml(node.value)}</textarea>
      `;
    }

    // Quick helpers for DA / TM / UI
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
    } else if (node.vr === 'UI' && !isDeleted && node.tag !== '00020002' && node.tag !== '00080016') {
      helperHtml = `
        <div class="quick-helpers">
          <button class="btn btn-sm" data-action="gen-uid">${icons.sparkles(13)} ${escapeHtml(t('inspGenUid'))}</button>
        </div>
      `;
    }

    return `
      <input class="input insp-input" type="text" data-inspector-input="true" value="${escapeHtml(node.value)}" placeholder="${escapeHtml(t('inspPlaceholderEmpty'))}" ${isDeleted ? 'disabled' : ''} />
      ${this._renderQuickPresets(node, isDeleted)}
      ${helperHtml}
    `;
  }

  _renderLiveMetricsHtml(node, spec, needsUtf8Warn) {
    if (node.isBinary || node.isSequence) return '';
    const val = node.value || '';
    const byteLen = this._getEncodedPreviewBytes(node).length;
    const charLen = val.length;
    const vm = computeVm(node);
    const v = node.validation || validateVrValue(node.vr, val, node.tag);
    const needsPadNote = spec.padding !== 'none' && (byteLen & 1) === 1;

    const limitInfo = spec.maxLength
      ? `${spec.lengthUnit === 'chars' ? charLen : byteLen} / ${spec.maxLength} ${spec.lengthUnit}`
      : `${byteLen} bytes`;

    // Resolve human-readable name for known UIDs
    const uidName = node.vr === 'UI' ? lookupUidName(val) : null;
    const uidNameHtml = uidName
      ? `<div class="uid-resolved-banner">↳ <span>${escapeHtml(t('inspKnownUidLabel'))}</span> <strong>${escapeHtml(uidName)}</strong></div>`
      : '';

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
      ${uidNameHtml}
      <div class="insp-metrics-bar">
        <span>${escapeHtml(t('inspMetricLen'))} <strong>${escapeHtml(limitInfo)}</strong></span>
        <span>${escapeHtml(t('inspMetricBytes'))} <strong>${byteLen} B</strong>${needsPadNote ? escapeHtml(t('inspMetricPadNote')) : ''}</span>
        <span>VM: <strong>${vm}</strong></span>
      </div>
      ${statusBox}
      ${charsetWarn}
    `;
  }

  _syncLiveInputsAndMetrics(node, info) {
    const val = node.value || '';
    const mainInp = this.container.querySelector('[data-inspector-input]');
    if (mainInp && mainInp.value !== val) {
      mainInp.value = val;
    }
    if (node.vr === 'PN' && this._pnStructuredMode) {
      const parsed = parsePnComponents(val);
      ['0', '1', '2', '3', '4'].forEach((idx) => {
        const aEl = this.container.querySelector(`[data-pn-input="a${idx}"]`);
        if (aEl && aEl !== document.activeElement && aEl.value !== parsed.alpha[Number(idx)]) {
          aEl.value = parsed.alpha[Number(idx)];
        }
      });
      ['0', '1'].forEach((idx) => {
        const iEl = this.container.querySelector(`[data-pn-input="i${idx}"]`);
        if (iEl && iEl !== document.activeElement && iEl.value !== parsed.ideo[Number(idx)]) {
          iEl.value = parsed.ideo[Number(idx)];
        }
      });
    } else if (this._multiValueMode) {
      const mvInputs = [...this.container.querySelectorAll('[data-mv-input]')];
      const parts = val.split('\\');
      if (mvInputs.length !== parts.length) {
        this._renderNode(info);
        return;
      }
      mvInputs.forEach((inp, idx) => {
        if (inp.value !== parts[idx]) inp.value = parts[idx];
      });
    }

    const statusSlot = this.container.querySelector('#insp-status-slot');
    if (statusSlot) statusSlot.innerHTML = this._renderStatusBadge(node.status);
    const actionsSlot = this.container.querySelector('#insp-top-actions');
    if (actionsSlot) actionsSlot.innerHTML = this._renderTopActionsHtml(node, info);
    const origSlot = this.container.querySelector('#insp-orig-slot');
    if (origSlot) origSlot.innerHTML = this._renderOrigInlineHtml(node);

    const trimmed = val.trim();
    this.container.querySelectorAll('[data-preset-val]').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.presetVal === trimmed);
    });

    this._updateLiveMetrics(node);
  }

  _updateLiveMetrics(node) {
    const el = this.container.querySelector('#insp-live-metrics');
    if (el) {
      const spec = getVrSpec(node.vr);
      const charset = this.store.getSpecificCharacterSet();
      const needsUtf8Warn =
        !node.isMeta &&
        usesSpecificCharacterSet(node.vr) &&
        hasNonAscii(node.value) &&
        !isUtf8Charset(charset);
      el.innerHTML = this._renderLiveMetricsHtml(node, spec, needsUtf8Warn);
    }
    const rawLenEl = this.container.querySelector('#insp-rawhex-len');
    if (rawLenEl) {
      rawLenEl.textContent = `${this._getEncodedPreviewBytes(node).length} B`;
    }
    if (this._showRawHex) {
      const rawBodyEl = this.container.querySelector('#insp-rawhex-body');
      if (rawBodyEl) rawBodyEl.innerHTML = this._renderRawHexBody(node);
    }
  }

  _onInput(e) {
    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info || info.isSeqItem || info.ancestorDeleted) return;

    if (e.target.matches('[data-inspector-input]')) {
      this.store.updateNodeValue(info.node.id, e.target.value, { coalesce: true });
      if (info.node.vr === 'PN' && this._pnStructuredMode) {
        const parsed = parsePnComponents(e.target.value);
        ['0', '1', '2', '3', '4'].forEach((idx) => {
          const aEl = this.container.querySelector(`[data-pn-input="a${idx}"]`);
          if (aEl) aEl.value = parsed.alpha[Number(idx)];
        });
        ['0', '1'].forEach((idx) => {
          const iEl = this.container.querySelector(`[data-pn-input="i${idx}"]`);
          if (iEl) iEl.value = parsed.ideo[Number(idx)];
        });
      }
      return;
    }

    if (e.target.matches('[data-pn-input]')) {
      const existingParts = String(info.node.value || '').split('\\');
      const existingParsed = parsePnComponents(existingParts[0]);
      const alpha = ['0', '1', '2', '3', '4'].map(
        (idx) => this.container.querySelector(`[data-pn-input="a${idx}"]`)?.value || ''
      );
      const ideo = [
        this.container.querySelector('[data-pn-input="i0"]')?.value || '',
        this.container.querySelector('[data-pn-input="i1"]')?.value || '',
        existingParsed.ideo[2],
        existingParsed.ideo[3],
        existingParsed.ideo[4],
      ];
      existingParts[0] = composePnComponents(alpha, ideo, existingParsed.phonetic);
      const composed = existingParts.join('\\');
      const rawInp = this.container.querySelector('[data-inspector-input]');
      if (rawInp) rawInp.value = composed;
      this.store.updateNodeValue(info.node.id, composed, { coalesce: true });
      return;
    }

    if (e.target.matches('[data-mv-input]')) {
      const inputs = [...this.container.querySelectorAll('[data-mv-input]')];
      const joined = inputs.map((i) => i.value).join('\\');
      this.store.updateNodeValue(info.node.id, joined, { coalesce: true });
    }
  }

  _onChange(e) {
    if (e.target.matches('[data-action="pick-date"]')) {
      const iso = e.target.value;
      if (iso) {
        const dcmDate = iso.replace(/-/g, '');
        this.store.updateNodeValue(this.store.selectedId, dcmDate);
      }
    }
  }

  _onClick(e) {
    const crumbBtn = e.target.closest('[data-jump-crumb]');
    if (crumbBtn) {
      this.store.selectNode(crumbBtn.dataset.jumpCrumb);
      return;
    }

    const presetBtn = e.target.closest('[data-preset-val]');
    if (presetBtn && this.store.selectedId) {
      this.store.updateNodeValue(this.store.selectedId, presetBtn.dataset.presetVal);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info) return;

    switch (action) {
      case 'copy-tag':
        if (!info.isSeqItem) this._copyText(info.node.formattedTag);
        break;
      case 'copy-val':
        if (!info.isSeqItem) this._copyText(info.node.value || '');
        break;
      case 'add-tag-in-item':
        if (info.isSeqItem && this.callbacks.onOpenAddTagForItem) {
          this.callbacks.onOpenAddTagForItem(info.item, info.parentSeq, info.section);
        }
        break;
      case 'delete-seq-item':
        if (info.isSeqItem) {
          this.store.removeSequenceItem(info.item.id);
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
      case 'toggle-pn-mode':
        this._pnStructuredMode = !this._pnStructuredMode;
        this._renderNode(info);
        break;
      case 'toggle-raw-hex':
        this._showRawHex = !this._showRawHex;
        this._renderNode(info);
        if (this._showRawHex) {
          requestAnimationFrame(() => {
            this.container.querySelector('#insp-sec-rawhex')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        }
        break;
      case 'toggle-vr-spec':
        this._showVrSpec = !this._showVrSpec;
        this._renderNode(info);
        if (this._showVrSpec) {
          requestAnimationFrame(() => {
            this.container.querySelector('#insp-sec-vrspec')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          });
        }
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
