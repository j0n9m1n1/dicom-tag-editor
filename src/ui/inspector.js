/**
 * Right-side Tag Inspector Panel.
 * Shows DICOM VR standards (type, max length, padding, VM, format hint),
 * live validation, multi-value editor, date/time helpers, UTF-8 charset guard,
 * hex dump preview for binary tags, and revert/delete actions.
 */

import { getVrSpec, validateVrValue } from '../dicom/vrSpec.js';
import { hasNonAscii, isUtf8Charset } from '../dicom/charset.js';
import { computeVm, formatByteSize } from '../dicom/parser.js';
import { icons, escapeHtml } from './icons.js';

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

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('input', (e) => this._onInput(e));
    this.container.addEventListener('change', (e) => this._onChange(e));
  }

  render(reason = 'state') {
    if (!this.store.doc) {
      this._renderedNodeId = null;
      this.container.innerHTML = `
        <div class="inspector-empty">
          <p>DICOM 파일을 열면 선택한 태그의<br/>VR 표준 스펙과 편집기가 표시됩니다.</p>
        </div>
      `;
      return;
    }

    const info = this.store.findNodeInfo(this.store.selectedId);
    if (!info) {
      this._renderedNodeId = null;
      this.container.innerHTML = `
        <div class="inspector-empty">
          <p>왼쪽 트리에서 태그를 선택하세요.</p>
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
          <span class="insp-title">${escapeHtml(parentSeq.keyword)} 항목</span>
        </div>
        <p class="insp-desc">
          상위 시퀀스 <code>${parentSeq.formattedTag}</code>에 속한 데이터셋 항목입니다.
          현재 하위 태그 <strong>${childCount}개</strong>를 포함하고 있습니다.
        </p>
        <div class="insp-actions">
          <button class="btn btn-primary btn-sm" data-action="add-tag-in-item">
            ${icons.plus(14)} 이 Item 안에 태그 추가
          </button>
        </div>
      </div>
    `;
  }

  _renderNode(info) {
    const { node, path } = info;
    const spec = getVrSpec(node.vr);
    const isDeleted = node.status === 'deleted';
    const charset = this.store.getSpecificCharacterSet();
    const needsUtf8Warn =
      !node.isBinary &&
      !node.isSequence &&
      hasNonAscii(node.value) &&
      !isUtf8Charset(charset);

    const statusBadgeMap = {
      unchanged: '<span class="status-pill st-unchanged">원본</span>',
      modified: '<span class="status-pill st-modified">수정됨</span>',
      added: '<span class="status-pill st-added">추가됨</span>',
      deleted: '<span class="status-pill st-deleted">삭제 예정</span>',
    };

    const maxLenText = spec.fixedLength
      ? `${spec.fixedLength} bytes (고정)`
      : spec.maxLength
        ? `최대 ${spec.maxLength} ${spec.lengthUnit}`
        : '제한 없음';

    const padText =
      spec.padding === 'null'
        ? '0x00 (NULL)'
        : spec.padding === 'space'
          ? '0x20 (Space)'
          : '없음 (짝수 고정)';

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
        <div class="insp-keyword">Keyword: <code>${escapeHtml(node.keyword)}</code> · 표준 VM: <code>${escapeHtml(node.vmSpec || '1')}</code></div>
      </div>

      <div class="insp-section">
        <div class="insp-section-title">VR 표준 스펙</div>
        <div class="vr-spec-card">
          <div class="vr-spec-head">
            <span class="vr-pill vr-cat-${spec.category}">${escapeHtml(node.vr)}</span>
            <strong>${escapeHtml(spec.name)}</strong>
          </div>
          <div class="vr-spec-grid">
            <div><span class="lbl">분류</span><span>${escapeHtml(spec.category)}</span></div>
            <div><span class="lbl">표준 길이</span><span>${escapeHtml(maxLenText)}</span></div>
            <div><span class="lbl">다중값(VM)</span><span>${spec.allowMultiValue ? '허용 (\\ 구분)' : '단일값 고정'}</span></div>
            <div><span class="lbl">짝수 패딩</span><span>${escapeHtml(padText)}</span></div>
          </div>
          <div class="vr-spec-hint"><strong>형식:</strong> ${escapeHtml(spec.formatHint)}</div>
          <div class="vr-spec-desc">${escapeHtml(spec.description)}</div>
        </div>
      </div>

      <div class="insp-section">
        <div class="insp-section-header">
          <div class="insp-section-title">값 편집</div>
          ${this._renderEditorModeToggle(node, spec)}
        </div>
        ${this._renderValueEditor(node, spec, isDeleted)}
        <div id="insp-live-metrics">${this._renderLiveMetricsHtml(node, spec, needsUtf8Warn)}</div>
      </div>

      ${node.status === 'modified' && !node.isBinary && !node.isSequence ? `
        <div class="insp-section insp-diff-box">
          <div class="insp-section-title">원본 값 비교</div>
          <div class="diff-orig"><code>${escapeHtml(node.originalValue || '(empty)')}</code></div>
        </div>
      ` : ''}

      <div class="insp-section insp-footer-actions">
        ${node.status === 'modified' || node.status === 'added' ? `
          <button class="btn btn-sm" data-action="revert-node">
            ${icons.rotateCcw(14)} ${node.status === 'added' ? '추가 취소' : '원본 복원'}
          </button>
        ` : ''}
        ${node.tag !== '00020010' ? `
          <button class="btn btn-sm ${isDeleted ? 'btn-primary' : 'btn-danger-ghost'}" data-action="toggle-delete">
            ${isDeleted ? `${icons.rotateCcw(14)} 삭제 취소` : `${icons.trash(14)} 태그 삭제`}
          </button>
        ` : `<span class="muted small">TransferSyntaxUID는 삭제할 수 없습니다.</span>`}
      </div>
    `;
  }

  _renderEditorModeToggle(node, spec) {
    if (node.isBinary || node.isSequence || !spec.allowMultiValue) return '';
    return `
      <button class="btn-link small" data-action="toggle-mv-mode">
        ${this._multiValueMode ? '원문(\\) 편집으로 전환' : '다중값 리스트 편집'}
      </button>
    `;
  }

  _renderValueEditor(node, spec, isDeleted) {
    if (node.isSequence) {
      const count = (node.items || []).length;
      return `
        <div class="seq-editor-box">
          <p class="muted small">하위 Item <strong>${count}개</strong>가 포함되어 있습니다. 트리에서 펼쳐 개별 태그를 수정하세요.</p>
          <button class="btn btn-sm btn-primary" data-action="add-seq-item" ${isDeleted ? 'disabled' : ''}>
            ${icons.plus(14)} 새 Sequence Item 추가
          </button>
        </div>
      `;
    }

    if (node.isBinary) {
      const dump = buildHexDump(node.rawBytes, 256);
      return `
        <div class="binary-editor-box">
          <div class="binary-meta">
            <span>크기: <strong>${formatByteSize(node.rawLength)}</strong></span>
            <span>${node.encapsulated ? `압축 프래그먼트 ${(node.fragments || []).length}개` : 'Raw Binary'}</span>
          </div>
          <p class="muted small">바이너리 무결성 보호를 위해 읽기 전용 Hex 프리뷰로 표시됩니다. 저장 시 원본 바이트가 그대로 보존됩니다.</p>
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
            <button class="btn-icon" data-action="mv-remove" data-mv-idx="${i}" title="항목 제거" ${isDeleted || parts.length <= 1 ? 'disabled' : ''}>${icons.x(14)}</button>
          </div>
        `
        )
        .join('');
      return `
        <div class="mv-editor">
          ${rows}
          <button class="btn btn-sm" data-action="mv-add" ${isDeleted ? 'disabled' : ''}>${icons.plus(14)} 값 항목 추가</button>
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
          <input type="date" class="input input-sm" data-action="pick-date" value="${isoVal}" title="달력에서 날짜 선택" />
          <button class="btn btn-sm" data-action="fill-today">오늘 (${getTodayDicomDate()})</button>
        </div>
      `;
    } else if (node.vr === 'TM' && !isDeleted) {
      helperHtml = `
        <div class="quick-helpers">
          <button class="btn btn-sm" data-action="fill-now">현재 시각 (${getNowDicomTime()})</button>
        </div>
      `;
    }

    return `
      <input class="input insp-input" type="text" data-inspector-input="true" value="${escapeHtml(node.value)}" placeholder="(비어 있음)" ${isDeleted ? 'disabled' : ''} />
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
          <span>VR 표준 규칙 통과 (${escapeHtml(node.vr)})</span>
        </div>
      `;
    }

    const charsetWarn = needsUtf8Warn
      ? `
        <div class="val-feedback val-warn charset-warn">
          ${icons.alertCircle(14)}
          <div>
            <div>비-ASCII 문자(한글 등)가 포함되어 있으나 <code>SpecificCharacterSet</code>이 UTF-8(<code>ISO_IR 192</code>)이 아닙니다.</div>
            <button class="btn btn-sm btn-primary" data-action="set-utf8" style="margin-top:6px">ISO_IR 192 (UTF-8) 자동 설정</button>
          </div>
        </div>
      `
      : '';

    return `
      <div class="insp-metrics-bar">
        <span>길이: <strong>${escapeHtml(limitInfo)}</strong></span>
        <span>바이트: <strong>${byteLen} B</strong>${(byteLen & 1) === 1 ? ' (저장 시 +1B 패딩)' : ''}</span>
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
      case 'set-utf8':
        this.store.ensureUtf8Charset();
        break;
      default:
        break;
    }
  }
}
