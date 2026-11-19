/**
 * Modal dialogs:
 *  - Add Tag modal (with DICOM dictionary autocomplete & VR auto-fill)
 *  - Diff Summary modal (before saving, with per-tag revert)
 *  - Anonymize Preset modal
 */

import { ALL_VR_CODES, getVrSpec, validateVrValue } from '../dicom/vrSpec.js';
import { parseTagString, searchDictionary, lookupTag } from '../dicom/dictionary.js';
import { formatDcmDump, formatDicomJson } from '../dicom/dcmdump.js';
import { ANONYMIZE_PRESET_TAGS } from '../state/store.js';
import { icons, escapeHtml } from './icons.js';
import { t, getLocalizedVrText } from '../i18n.js';

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
      ? t('modalAddTargetItem', { tag: target.parentSeq.formattedTag })
      : t('modalAddTargetMain');

    const vrOptions = ALL_VR_CODES.map((c) => {
      const s = getVrSpec(c);
      return `<option value="${c}">${c} — ${escapeHtml(s.name)}</option>`;
    }).join('');

    this.root.innerHTML = `
      <div class="modal-card modal-md" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalAddTitle'))}</h3>
            <div class="muted small">${escapeHtml(targetLabel)}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>${escapeHtml(t('modalAddSearchLabel'))}</label>
            <input type="text" class="input" id="add-dict-search" placeholder="${escapeHtml(t('modalAddSearchPh'))}" autocomplete="off" />
            <div class="dict-suggestions" id="add-dict-list"></div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label>${escapeHtml(t('modalAddTagLabel'))}</label>
              <input type="text" class="input mono" id="add-tag-input" placeholder="(0010,4000)" />
            </div>
            <div class="form-group">
              <label>${escapeHtml(t('modalAddVrLabel'))}</label>
              <select class="input" id="add-vr-select">${vrOptions}</select>
            </div>
          </div>

          <div class="vr-mini-hint" id="add-vr-hint"></div>

          <div class="form-group">
            <label>${escapeHtml(t('modalAddValLabel'))}</label>
            <input type="text" class="input" id="add-val-input" placeholder="${escapeHtml(t('modalAddValPh'))}" />
            <div id="add-val-feedback" class="small" style="margin-top:6px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>${escapeHtml(t('modalCancel'))}</button>
          <button class="btn btn-primary" id="btn-confirm-add">${icons.plus(15)} ${escapeHtml(t('modalConfirmAdd'))}</button>
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
      const vrText = getLocalizedVrText(spec);
      vrHint.innerHTML = `<strong>${spec.code} (${escapeHtml(spec.name)}):</strong> ${escapeHtml(vrText.formatHint)}`;
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
        listEl.innerHTML = `<div class="dict-empty">${escapeHtml(t('modalAddNoDict'))}</div>`;
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
        feedbackEl.innerHTML = `<span class="text-danger">${escapeHtml(t('modalAddInvalidTag'))}</span>`;
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
        this.callbacks.onToast?.(t('toastDupTag', { tag: parsed.formatted }), 'warn');
      } else {
        this.callbacks.onToast?.(t('toastAddedTag', { tag: parsed.formatted, vr: vrSel.value }), 'ok');
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
        ? `<div class="modal-empty">${escapeHtml(t('modalDiffEmpty'))}</div>`
        : `
        <table class="diff-table">
          <thead>
            <tr>
              <th>${escapeHtml(t('modalDiffColStatus'))}</th>
              <th>${escapeHtml(t('modalDiffColPath'))}</th>
              <th>${escapeHtml(t('modalDiffColName'))}</th>
              <th>${escapeHtml(t('modalDiffColOld'))}</th>
              <th>${escapeHtml(t('modalDiffColNew'))}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${stats.diffs
              .map(({ node, path }) => {
                const badge =
                  node.status === 'modified'
                    ? `<span class="status-pill st-modified">${escapeHtml(t('modalDiffStMod'))}</span>`
                    : node.status === 'added'
                      ? `<span class="status-pill st-added">${escapeHtml(t('modalDiffStAdd'))}</span>`
                      : `<span class="status-pill st-deleted">${escapeHtml(t('modalDiffStDel'))}</span>`;
                return `
                <tr>
                  <td>${badge}</td>
                  <td><button class="btn-link mono" data-jump="${node.id}">${escapeHtml(path)}</button></td>
                  <td>${escapeHtml(node.keyword)} <span class="muted">(${node.vr})</span></td>
                  <td class="mono diff-cell-old">${escapeHtml(node.status === 'added' ? '—' : node.originalValue || '(empty)')}</td>
                  <td class="mono diff-cell-new">${escapeHtml(node.status === 'deleted' ? t('modalDiffWillDelete') : node.value || '(empty)')}</td>
                  <td><button class="btn btn-xs" data-diff-revert="${node.id}" title="${escapeHtml(t('modalDiffRevertTitle'))}">${icons.rotateCcw(13)}</button></td>
                </tr>
              `;
              })
              .join('')}
          </tbody>
        </table>
      `;

    const summaryLine =
      `${escapeHtml(t('changeMod', { n: stats.modified }))} · ${escapeHtml(t('changeAdd', { n: stats.added }))} · ${escapeHtml(t('changeDel', { n: stats.deleted }))}` +
      (stats.invalid > 0 ? ` · <span class="text-danger">${escapeHtml(t('filterInvalid'))} ${stats.invalid}</span>` : '');

    this.root.innerHTML = `
      <div class="modal-card modal-lg" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalDiffTitle'))}</h3>
            <div class="muted small">${summaryLine}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body modal-scroll">
          ${rowsHtml}
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>${escapeHtml(t('modalClose'))}</button>
          ${stats.diffs.length > 0 ? `<button class="btn btn-primary" id="btn-diff-save">${icons.download(15)} ${escapeHtml(t('modalDiffSaveBtn'))}</button>` : ''}
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
          <td class="mono small">${exists ? escapeHtml(curVal || '(empty)') : `<span class="muted">${escapeHtml(t('modalAnonMissing'))}</span>`}</td>
          <td><input type="text" class="input input-sm" data-anon-val="${p.tag}" value="${escapeHtml(p.replacement)}" placeholder="${escapeHtml(t('modalAnonClearPh'))}" /></td>
        </tr>
      `;
    }).join('');

    this.root.innerHTML = `
      <div class="modal-card modal-lg" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalAnonTitle'))}</h3>
            <div class="muted small">${escapeHtml(t('modalAnonSubtitle'))}</div>
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
                <th>${escapeHtml(t('modalAnonColCur'))}</th>
                <th>${escapeHtml(t('modalAnonColRep'))}</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          <label class="checkbox-row" style="margin-top:12px">
            <input type="checkbox" id="anon-mark-deid" checked />
            <span>${t('modalAnonMarkDeid')}</span>
          </label>
          ${this.store.files.length > 1 ? `
            <label class="checkbox-row" style="margin-top:8px">
              <input type="checkbox" id="anon-all-files" checked />
              <strong>${escapeHtml(t('modalAnonScopeAll', { n: this.store.files.length }))}</strong>
            </label>
          ` : ''}
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>${escapeHtml(t('modalCancel'))}</button>
          <button class="btn btn-primary" id="btn-apply-anon">${icons.shield(15)} ${escapeHtml(t('modalAnonApplyBtn'))}</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    this.root.querySelector('#btn-apply-anon').addEventListener('click', async () => {
      const rules = [];
      this.root.querySelectorAll('[data-anon-check]').forEach((cb) => {
        if (cb.checked) {
          const tag = cb.dataset.anonCheck;
          const valInp = this.root.querySelector(`[data-anon-val="${tag}"]`);
          rules.push({ tag, replacement: valInp ? valInp.value : '' });
        }
      });
      const markDeid = this.root.querySelector('#anon-mark-deid').checked;
      const allFilesCb = this.root.querySelector('#anon-all-files');
      const applyAll = Boolean(allFilesCb && allFilesCb.checked && this.store.files.length > 1);
      this.close();

      if (applyAll) {
        const res = await this.store.applyAnonymizationAllFiles(rules, markDeid);
        this.callbacks.onToast?.(
          res.affectedFiles > 0
            ? t('toastBatchDone', { files: res.affectedFiles })
            : t('toastAnonNone'),
          res.affectedFiles > 0 ? 'ok' : 'info'
        );
      } else {
        const count = this.store.applyAnonymization(rules, markDeid);
        this.callbacks.onToast?.(
          count > 0 ? t('toastAnonDone', { count }) : t('toastAnonNone'),
          count > 0 ? 'ok' : 'info'
        );
      }
    });
  }

  /**
   * Open Raw DICOM View modal (DCMTK dcmdump text & structured JSON).
   */
  openRawView() {
    if (!this.store.doc) return;
    let mode = 'dcmdump';
    let includeDeleted = false;

    const getText = () =>
      mode === 'dcmdump'
        ? formatDcmDump(this.store.doc, { includeDeleted })
        : formatDicomJson(this.store.doc, { includeDeleted });

    this.root.innerHTML = `
      <div class="modal-card modal-xl" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalRawTitle'))}</h3>
            <div class="muted small">${escapeHtml(t('modalRawSubtitle'))}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="raw-toolbar">
          <div class="raw-tabs">
            <button class="chip active" data-raw-mode="dcmdump">dcmdump (Text)</button>
            <button class="chip" data-raw-mode="json">DICOM JSON</button>
          </div>
          <label class="checkbox-row small">
            <input type="checkbox" id="raw-inc-del" />
            <span>${escapeHtml(t('modalRawIncludeDeleted'))}</span>
          </label>
        </div>
        <div class="modal-body modal-scroll raw-body">
          <pre class="raw-pre" id="raw-output-pre"></pre>
        </div>
        <div class="modal-footer">
          <button class="btn" id="btn-raw-copy">${icons.copy(14)} ${escapeHtml(t('modalRawCopy'))}</button>
          <button class="btn btn-primary" id="btn-raw-download">${icons.download(14)} ${escapeHtml(t('modalRawExport'))}</button>
          <button class="btn" data-modal-close>${escapeHtml(t('modalClose'))}</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    const preEl = this.root.querySelector('#raw-output-pre');
    const delCb = this.root.querySelector('#raw-inc-del');
    const renderRaw = () => {
      preEl.textContent = getText();
    };
    renderRaw();

    this.root.querySelectorAll('[data-raw-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        mode = btn.dataset.rawMode;
        this.root.querySelectorAll('[data-raw-mode]').forEach((b) =>
          b.classList.toggle('active', b.dataset.rawMode === mode)
        );
        renderRaw();
      });
    });

    delCb.addEventListener('change', () => {
      includeDeleted = delCb.checked;
      renderRaw();
    });

    this.root.querySelector('#btn-raw-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        this.callbacks.onToast?.(t('toastCopied'), 'ok');
      } catch {
        const range = document.createRange();
        range.selectNodeContents(preEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        sel.removeAllRanges();
        this.callbacks.onToast?.(t('toastCopied'), 'ok');
      }
    });

    this.root.querySelector('#btn-raw-download').addEventListener('click', () => {
      const ext = mode === 'dcmdump' ? 'txt' : 'json';
      const mime = mode === 'dcmdump' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8';
      const base = this.store.doc.fileName.replace(/\.dcm$/i, '');
      const blob = new Blob([getText()], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}_${mode}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  /**
   * Open Batch Edit modal to modify/add/delete a tag across all open files.
   */
  openBatchEdit() {
    const fileCount = this.store.files.length;
    if (fileCount === 0) return;

    const editableVrs = ALL_VR_CODES.filter((c) => {
      const cat = getVrSpec(c).category;
      return cat !== 'sequence' && cat !== 'binary';
    });
    const vrOptions = editableVrs
      .map((c) => `<option value="${c}">${c} — ${escapeHtml(getVrSpec(c).name)}</option>`)
      .join('');

    this.root.innerHTML = `
      <div class="modal-card modal-md" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalBatchTitle'))}</h3>
            <div class="muted small">${escapeHtml(t('modalBatchSubtitle', { n: fileCount }))}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>${escapeHtml(t('modalAddSearchLabel'))}</label>
            <input type="text" class="input" id="batch-dict-search" placeholder="${escapeHtml(t('modalAddSearchPh'))}" autocomplete="off" />
            <div class="dict-suggestions" id="batch-dict-list"></div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label>${escapeHtml(t('modalAddTagLabel'))}</label>
              <input type="text" class="input mono" id="batch-tag-input" placeholder="(0008,1030)" />
            </div>
            <div class="form-group">
              <label>${escapeHtml(t('modalAddVrLabel'))}</label>
              <select class="input" id="batch-vr-select">${vrOptions}</select>
            </div>
          </div>

          <div class="form-group">
            <label>${escapeHtml(t('modalBatchActionLabel'))}</label>
            <select class="input" id="batch-mode-select">
              <option value="set">${escapeHtml(t('modalBatchActSet'))}</option>
              <option value="update">${escapeHtml(t('modalBatchActUpdateOnly'))}</option>
              <option value="delete">${escapeHtml(t('modalBatchActDelete'))}</option>
            </select>
          </div>

          <div class="form-group" id="batch-val-group">
            <label>${escapeHtml(t('modalAddValLabel'))}</label>
            <input type="text" class="input" id="batch-val-input" placeholder="${escapeHtml(t('inspPlaceholderEmpty'))}" />
            <div id="batch-val-feedback" class="small" style="margin-top:6px"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-modal-close>${escapeHtml(t('modalCancel'))}</button>
          <button class="btn btn-primary" id="btn-confirm-batch">${icons.sliders(15)} ${escapeHtml(t('modalBatchApplyBtn', { n: fileCount }))}</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    const searchInp = this.root.querySelector('#batch-dict-search');
    const listEl = this.root.querySelector('#batch-dict-list');
    const tagInp = this.root.querySelector('#batch-tag-input');
    const vrSel = this.root.querySelector('#batch-vr-select');
    const modeSel = this.root.querySelector('#batch-mode-select');
    const valGroup = this.root.querySelector('#batch-val-group');
    const valInp = this.root.querySelector('#batch-val-input');
    const feedbackEl = this.root.querySelector('#batch-val-feedback');

    vrSel.value = 'LO';

    const updateState = () => {
      const isDel = modeSel.value === 'delete';
      valGroup.classList.toggle('hidden', isDel);
      if (!isDel) {
        const v = validateVrValue(vrSel.value, valInp.value);
        feedbackEl.innerHTML = v.valid
          ? ''
          : `<span class="text-danger">${escapeHtml(v.messages.join(' / '))}</span>`;
      }
    };

    const renderSuggestions = (q) => {
      const hits = searchDictionary(q, 8).filter((h) => editableVrs.includes(h.vr));
      if (hits.length === 0) {
        listEl.innerHTML = `<div class="dict-empty">${escapeHtml(t('modalAddNoDict'))}</div>`;
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
    updateState();

    searchInp.addEventListener('input', () => renderSuggestions(searchInp.value));
    listEl.addEventListener('click', (e) => {
      const item = e.target.closest('.dict-item');
      if (!item) return;
      tagInp.value = item.dataset.tag;
      if (editableVrs.includes(item.dataset.vr)) vrSel.value = item.dataset.vr;
      updateState();
      valInp.focus();
    });

    tagInp.addEventListener('input', () => {
      const parsed = parseTagString(tagInp.value);
      if (parsed) {
        const info = lookupTag(parsed.group, parsed.element);
        if (info.keyword !== 'UnknownTag' && editableVrs.includes(info.vr)) {
          vrSel.value = info.vr;
          updateState();
        }
      }
    });

    modeSel.addEventListener('change', updateState);
    vrSel.addEventListener('change', updateState);
    valInp.addEventListener('input', updateState);

    this.root.querySelector('#btn-confirm-batch').addEventListener('click', async () => {
      const parsed = parseTagString(tagInp.value);
      if (!parsed) {
        feedbackEl.innerHTML = `<span class="text-danger">${escapeHtml(t('modalAddInvalidTag'))}</span>`;
        valGroup.classList.remove('hidden');
        tagInp.focus();
        return;
      }
      const res = await this.store.batchEditAcrossFiles({
        group: parsed.group,
        element: parsed.element,
        vr: vrSel.value,
        value: valInp.value,
        mode: modeSel.value,
      });
      this.close();
      this.callbacks.onToast?.(
        res.affectedFiles > 0 ? t('toastBatchDone', { files: res.affectedFiles }) : t('toastAnonNone'),
        res.affectedFiles > 0 ? 'ok' : 'info'
      );
    });

    searchInp.focus();
  }
}
