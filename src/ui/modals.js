/**
 * Modal dialogs:
 *  - Add Tag modal (with DICOM dictionary autocomplete & VR auto-fill)
 *  - Diff Summary modal (before saving, with per-tag revert)
 *  - Anonymize Preset modal
 */

import { ALL_VR_CODES, getVrSpec, validateVrValue } from '../dicom/vrSpec.js';
import { parseTagString, searchDictionary, lookupTag } from '../dicom/dictionary.js';
import { ANONYMIZE_PRESET_TAGS } from '../state/store.js';
import { icons, escapeHtml } from './icons.js';

export class ModalManager {
  /**
   * @param {HTMLElement} root
   * @param {import('../state/store.js').AppStore} store
   * @param {{ onSaveAs: () => void, onJumpToNode: (id: string) => void, onToast: (msg: string, type?: string) => void }} callbacks
   */
  constructor(root, store, callbacks) {
    this.root = root;
    this.store = store;
    this.callbacks = callbacks || {};

    this.root.addEventListener('click', (e) => {
      if (e.target === this.root || e.target.closest('[data-modal-close]')) {
        this.close();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.root.classList.contains('hidden')) {
        this.close();
      }
    });
  }

  close() {
    this.root.classList.add('hidden');
    this.root.innerHTML = '';
  }

  /**
   * Open Add Tag modal. Optionally targets a specific Sequence Item.
   */
  openAddTag(target = null) {
    if (!this.store.doc) return;
    const targetLabel = target
      ? `${target.parentSeq.formattedTag} › Item 안에 추가`
      : 'Main Dataset (0002 그룹 입력 시 File Meta에 추가)';

    const vrOptions = ALL_VR_CODES.map((c) => {
      const s = getVrSpec(c);
      return `<option value="${c}">${c} — ${escapeHtml(s.name)}</option>`;
    }).join('');

    this.root.innerHTML = `
      <div class="modal-card modal-md" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>새 DICOM 태그 추가</h3>
            <div class="muted small">${escapeHtml(targetLabel)}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>표준 태그 빠른 검색</label>
            <input type="text" class="input" id="add-dict-search" placeholder="예: PatientComments, 0010,0020, WindowCenter..." autocomplete="off" />
            <div class="dict-suggestions" id="add-dict-list"></div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label>Tag (GGGG,EEEE) *</label>
              <input type="text" class="input mono" id="add-tag-input" placeholder="(0010,4000)" />
            </div>
            <div class="form-group">
              <label>VR (Value Representation) *</label>
              <select class="input" id="add-vr-select">${vrOptions}</select>
            </div>
          </div>

          <div class="vr-mini-hint" id="add-vr-hint"></div>

          <div class="form-group">
            <label>초기 값 (Value)</label>
            <input type="text" class="input" id="add-val-input" placeholder="값 입력 (SQ / 바이너리는 비워두세요)" />
            <div id="add-val-feedback" class="small" style="margin-top:6px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>취소</button>
          <button class="btn btn-primary" id="btn-confirm-add">${icons.plus(15)} 태그 추가</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    const searchInp = this.root.querySelector('#add-dict-search');
    const listEl = this.root.querySelector('#add-dict-list');
    const tagInp = this.root.querySelector('#add-tag-input');
    const vrSel = this.root.querySelector('#add-vr-select');
    const vrHint = this.root.querySelector('#add-vr-hint');
    const valInp = this.root.querySelector('#add-val-input');
    const feedbackEl = this.root.querySelector('#add-val-feedback');
    const confirmBtn = this.root.querySelector('#btn-confirm-add');

    vrSel.value = 'LO';

    const updateVrHint = () => {
      const spec = getVrSpec(vrSel.value);
      vrHint.innerHTML = `<strong>${spec.code} (${escapeHtml(spec.name)}):</strong> ${escapeHtml(spec.formatHint)}`;
      valInp.disabled = spec.category === 'sequence' || spec.category === 'binary';
      const v = validateVrValue(vrSel.value, valInp.value);
      if (!v.valid) {
        feedbackEl.innerHTML = `<span class="text-danger">${escapeHtml(v.messages.join(' / '))}</span>`;
      } else {
        feedbackEl.innerHTML = '';
      }
    };

    const renderSuggestions = (q) => {
      const hits = searchDictionary(q, 8);
      if (hits.length === 0) {
        listEl.innerHTML = '<div class="dict-empty">일치하는 표준 태그 없음 — 아래에 직접 (GGGG,EEEE) 입력 가능</div>';
        return;
      }
      listEl.innerHTML = hits
        .map(
          (h) => `
        <button type="button" class="dict-item" data-tag="${h.formattedTag}" data-vr="${h.vr}">
          <span class="mono">${h.formattedTag}</span>
          <span class="dict-kw">${escapeHtml(h.keyword)}</span>
          <span class="vr-pill vr-cat-${getVrSpec(h.vr).category}">${h.vr}</span>
        </button>
      `
        )
        .join('');
    };

    renderSuggestions('');
    updateVrHint();

    searchInp.addEventListener('input', () => renderSuggestions(searchInp.value));
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dict-item');
      if (!item) return;
      tagInp.value = item.dataset.tag;
      vrSel.value = item.dataset.vr;
      updateVrHint();
      valInp.focus();
    });

    tagInp.addEventListener('input', () => {
      const parsed = parseTagString(tagInp.value);
      if (parsed) {
        const info = lookupTag(parsed.group, parsed.element);
        if (info.keyword !== 'UnknownTag' && info.vr && ALL_VR_CODES.includes(info.vr)) {
          vrSel.value = info.vr;
          updateVrHint();
        }
      }
    });

    vrSel.addEventListener('change', updateVrHint);
    valInp.addEventListener('input', updateVrHint);

    confirmBtn.addEventListener('click', () => {
      const parsed = parseTagString(tagInp.value);
      if (!parsed) {
        feedbackEl.innerHTML = '<span class="text-danger">유효한 8자리 16진수 태그를 입력하세요 (예: (0010,4000)).</span>';
        tagInp.focus();
        return;
      }
      const res = this.store.addTag({
        group: parsed.group,
        element: parsed.element,
        vr: vrSel.value,
        value: valInp.disabled ? '' : valInp.value,
        targetList: target ? target.item.children : null,
        targetSection: target ? target.section : null,
      });
      this.close();
      if (res?.duplicate) {
        this.callbacks.onToast?.(`이미 존재하는 태그 ${parsed.formatted}로 이동했습니다.`, 'warn');
      } else {
        this.callbacks.onToast?.(`태그 ${parsed.formatted} (${vrSel.value}) 추가됨`, 'ok');
      }
    });

    searchInp.focus();
  }

  /**
   * Open Diff modal showing all modified/added/deleted tags.
   */
  openDiff() {
    if (!this.store.doc) return;
    const stats = this.store.getStatsAndDiff();

    const rowsHtml =
      stats.diffs.length === 0
        ? '<div class="modal-empty">아직 변경된 태그가 없습니다.</div>'
        : `
        <table class="diff-table">
          <thead>
            <tr>
              <th>상태</th>
              <th>태그 경로</th>
              <th>이름 / VR</th>
              <th>원본 값</th>
              <th>현재 값</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${stats.diffs
              .map(({ node, path }) => {
                const badge =
                  node.status === 'modified'
                    ? '<span class="status-pill st-modified">수정</span>'
                    : node.status === 'added'
                      ? '<span class="status-pill st-added">추가</span>'
                      : '<span class="status-pill st-deleted">삭제</span>';
                return `
                <tr>
                  <td>${badge}</td>
                  <td><button class="btn-link mono" data-jump="${node.id}">${escapeHtml(path)}</button></td>
                  <td>${escapeHtml(node.keyword)} <span class="muted">(${node.vr})</span></td>
                  <td class="mono diff-cell-old">${escapeHtml(node.status === 'added' ? '—' : node.originalValue || '(empty)')}</td>
                  <td class="mono diff-cell-new">${escapeHtml(node.status === 'deleted' ? '(삭제 예정)' : node.value || '(empty)')}</td>
                  <td><button class="btn btn-xs" data-diff-revert="${node.id}" title="되돌리기">${icons.rotateCcw(13)}</button></td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      `;

    this.root.innerHTML = `
      <div class="modal-card modal-lg" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>변경 내역 (Diff Summary)</h3>
            <div class="muted small">수정 ${stats.modified} · 추가 ${stats.added} · 삭제 ${stats.deleted}${stats.invalid > 0 ? ` · <span class="text-danger">VR 오류 ${stats.invalid}</span>` : ''}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body modal-scroll">
          ${rowsHtml}
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>닫기</button>
          ${stats.diffs.length > 0 ? `<button class="btn btn-primary" id="btn-diff-save">${icons.download(15)} 수정본 저장 (.dcm)</button>` : ''}
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    this.root.querySelectorAll('[data-jump]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.jump;
        this.close();
        this.callbacks.onJumpToNode?.(id);
      });
    });

    this.root.querySelectorAll('[data-diff-revert]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.revertNode(btn.dataset.diffRevert);
        this.openDiff(); // refresh table
      });
    });

    const saveBtn = this.root.querySelector('#btn-diff-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        this.close();
        this.callbacks.onSaveAs?.();
      });
    }
  }

  /**
   * Open Anonymize preset modal.
   */
  openAnonymize() {
    if (!this.store.doc) return;

    // Inspect current values in main dataset
    const currentMap = new Map();
    for (const n of this.store.doc.datasetNodes) {
      if (n.status !== 'deleted') currentMap.set(n.tag, n.value);
    }

    const rowsHtml = ANONYMIZE_PRESET_TAGS.map((p) => {
      const exists = currentMap.has(p.tag);
      const curVal = exists ? currentMap.get(p.tag) : null;
      const formatted = `(${p.tag.slice(0, 4)},${p.tag.slice(4, 8)})`;
      return `
        <tr class="${exists ? '' : 'muted'}">
          <td><input type="checkbox" data-anon-check="${p.tag}" ${exists ? 'checked' : ''} /></td>
          <td class="mono">${formatted}</td>
          <td>${escapeHtml(p.label)}</td>
          <td class="mono small">${exists ? escapeHtml(curVal || '(empty)') : '<span class="muted">없음</span>'}</td>
          <td><input type="text" class="input input-sm" data-anon-val="${p.tag}" value="${escapeHtml(p.replacement)}" placeholder="(비우기)" /></td>
        </tr>
      `;
    }).join('');

    this.root.innerHTML = `
      <div class="modal-card modal-lg" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>익명화 (Anonymize) 프리셋</h3>
            <div class="muted small">선택한 환자/기관 식별 태그를 일괄 치환합니다. (Ctrl+Z로 전체 되돌리기 가능)</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body modal-scroll">
          <table class="diff-table">
            <thead>
              <tr>
                <th style="width:32px"></th>
                <th>Tag</th>
                <th>Keyword</th>
                <th>현재 값</th>
                <th>치환 값</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <label class="checkbox-row" style="margin-top:12px">
            <input type="checkbox" id="anon-mark-deid" checked />
            <span><code>(0012,0062) PatientIdentityRemoved = YES</code> 태그 자동 기록</span>
          </label>
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>취소</button>
          <button class="btn btn-primary" id="btn-apply-anon">${icons.shield(15)} 익명화 적용</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    this.root.querySelector('#btn-apply-anon').addEventListener('click', () => {
      const rules = [];
      this.root.querySelectorAll('[data-anon-check]').forEach((cb) => {
        if (cb.checked) {
          const tag = cb.dataset.anonCheck;
          const valInp = this.root.querySelector(`[data-anon-val="${tag}"]`);
          rules.push({ tag, replacement: valInp ? valInp.value : '' });
        }
      });
      const markDeid = this.root.querySelector('#anon-mark-deid').checked;
      const count = this.store.applyAnonymization(rules, markDeid);
      this.close();
      this.callbacks.onToast?.(
        count > 0 ? `${count}개 태그가 익명화되었습니다. (Ctrl+Z로 복구 가능)` : '변경할 대상 태그가 없습니다.',
        count > 0 ? 'ok' : 'info'
      );
    });
  }
}
