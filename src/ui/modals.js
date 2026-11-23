/**
 * Modal dialogs:
 *  - Add Tag modal (with DICOM dictionary autocomplete & VR auto-fill)
 *  - Diff Summary modal (before saving, with per-tag revert)
 *  - Anonymize Preset modal
 */

import { ALL_VR_CODES, getVrSpec, validateVrValue } from '../dicom/vrSpec.js';
import { parseTagString, searchDictionary, lookupTag, tagHex } from '../dicom/dictionary.js';
import { formatByteSize } from '../dicom/parser.js';
import { formatDcmDump, formatDicomJson } from '../dicom/dcmdump.js';
import { ANONYMIZE_PRESET_TAGS, getReadOnlyTagMessage } from '../state/store.js';
import { icons, escapeHtml } from './icons.js';
import { t, getLang, getLocalizedVrText } from '../i18n.js';

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
      if (res?.locked) {
        feedbackEl.innerHTML = `<span class="text-danger">${escapeHtml(t(getReadOnlyTagMessage(tagHex(parsed.group, parsed.element))))}</span>`;
        return;
      }
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
                const oldText =
                  node.status === 'added'
                    ? '—'
                    : node.isSequence
                      ? `${this.store.getOriginalSequenceItemCount(node)} item(s)`
                      : node.originalValue || '(empty)';
                const newText =
                  node.status === 'deleted'
                    ? t('modalDiffWillDelete')
                    : node.isSequence
                      ? `${(node.items || []).length} item(s)`
                      : node.value || '(empty)';
                return `
                <tr>
                  <td>${badge}</td>
                  <td><button class="btn-link mono" data-jump="${node.id}">${escapeHtml(path)}</button></td>
                  <td>${escapeHtml(node.keyword)} <span class="muted">(${escapeHtml(node.vr)})</span></td>
                  <td class="mono diff-cell-old">${escapeHtml(oldText)}</td>
                  <td class="mono diff-cell-new">${escapeHtml(newText)}</td>
                  <td>${getReadOnlyTagMessage(node.tag) ? '' : `<button class="btn btn-xs" data-diff-revert="${node.id}" title="${escapeHtml(t('modalDiffRevertTitle'))}">${icons.rotateCcw(13)}</button>`}</td>
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
        const prevScroll = this.root.querySelector('.modal-scroll')?.scrollTop || 0;
        this.store.revertNode(btn.dataset.diffRevert);
        this.openDiff(); // refresh table
        const scrollEl = this.root.querySelector('.modal-scroll');
        if (scrollEl) scrollEl.scrollTop = prevScroll;
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
          <td><input type="checkbox" data-anon-check="${p.tag}" checked /></td>
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
            <input type="checkbox" id="anon-mark-deid" />
            <span>${t('modalAnonMarkDeid')}</span>
          </label>
          <label class="checkbox-row" style="margin-top:8px">
            <input type="checkbox" id="anon-strip-private" />
            <span>${escapeHtml(t('modalAnonStripPrivate'))}</span>
          </label>
          <label class="checkbox-row" style="margin-top:8px">
            <input type="checkbox" id="anon-regen-uid" />
            <span>${escapeHtml(t('modalAnonRegenUid'))}</span>
          </label>
          ${this.store.files.length > 1 ? `
            <label class="checkbox-row" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
              <input type="checkbox" id="anon-all-files" checked />
              <strong>${escapeHtml(t('modalAnonScopeAll', { n: this.store.files.length }))}</strong>
            </label>
          ` : ''}
          <div class="val-feedback val-warn" style="margin-top:12px">
            ${icons.alertCircle(15)}
            <span>${escapeHtml(t('modalAnonDisclaimer'))}</span>
          </div>
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
      const opts = {
        markDeidentified: this.root.querySelector('#anon-mark-deid').checked,
        stripPrivate: this.root.querySelector('#anon-strip-private').checked,
        regenerateUids: this.root.querySelector('#anon-regen-uid').checked,
      };
      const allFilesCb = this.root.querySelector('#anon-all-files');
      const applyAll = Boolean(allFilesCb && allFilesCb.checked && this.store.files.length > 1);
      this.close();

      if (applyAll) {
        try {
          const res = await this.store.applyAnonymizationAllFiles(rules, opts);
          this.callbacks.onToast?.(
            res.affectedFiles > 0 ? t('toastBatchDone', { files: res.affectedFiles }) : t('toastAnonNone'),
            res.affectedFiles > 0 ? 'ok' : 'info'
          );
          if (res.skippedFiles) this.callbacks.onToast?.(t('toastAnonSkipped', { count: res.skippedFiles }), 'warn');
        } catch (err) {
          this.callbacks.onToast?.(t('toastAnonErr', { msg: err.message }), 'error');
        }
      } else {
        const count = this.store.applyAnonymization(rules, opts);
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
      if (res.locked) {
        valGroup.classList.remove('hidden');
        feedbackEl.innerHTML = `<span class="text-danger">${escapeHtml(t(getReadOnlyTagMessage(tagHex(parsed.group, parsed.element))))}</span>`;
        return;
      }
      this.close();
      this.callbacks.onToast?.(
        res.affectedFiles > 0 ? t('toastBatchDone', { files: res.affectedFiles }) : t('toastAnonNone'),
        res.affectedFiles > 0 ? 'ok' : 'info'
      );
    });

    searchInp.focus();
  }

  /**
   * Open Settings dialog (Language, Theme, Keyboard Shortcuts & Disclaimer).
   */
  openSettings() {
    const lang = getLang();
    const theme = this.store.theme;
    const uiStyle = this.store.uiStyle;
    const pwa = this.callbacks.getPwaState?.() || { canInstall: false, isStandalone: false };

    let pwaBodyHtml = '';
    if (pwa.isStandalone) {
      pwaBodyHtml = `<div class="setting-pwa-badge">${icons.checkCircle(14)}<span>${escapeHtml(t('settingsInstalledBadge'))}</span></div>`;
    } else if (pwa.canInstall) {
      pwaBodyHtml = `<button type="button" class="btn btn-primary setting-pwa-btn" id="btn-install-pwa">${icons.download(15)}<span>${escapeHtml(t('settingsInstallBtn'))}</span></button>`;
    } else {
      pwaBodyHtml = `<div class="setting-pwa-hint">${escapeHtml(t('settingsInstallHint'))}</div>`;
    }

    this.root.innerHTML = `
      <div class="modal-card modal-sm" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div>
            <h3>${escapeHtml(t('modalSettingsTitle'))}</h3>
            <div class="muted small">${escapeHtml(t('modalSettingsSubtitle'))}</div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body">
          <div class="setting-row">
            <label class="setting-label">${escapeHtml(t('settingsLangLabel'))}</label>
            <div class="seg-group">
              <button type="button" class="seg-btn ${lang === 'ko' ? 'active' : ''}" data-set-lang="ko">${escapeHtml(t('settingsLangKo'))}</button>
              <button type="button" class="seg-btn ${lang === 'en' ? 'active' : ''}" data-set-lang="en">${escapeHtml(t('settingsLangEn'))}</button>
            </div>
          </div>

          <div class="setting-row">
            <label class="setting-label">${escapeHtml(t('settingsThemeLabel'))}</label>
            <div class="seg-group">
              <button type="button" class="seg-btn ${theme === 'dark' ? 'active' : ''}" data-set-theme="dark">${icons.moon(14)} ${escapeHtml(t('settingsThemeDark'))}</button>
              <button type="button" class="seg-btn ${theme === 'light' ? 'active' : ''}" data-set-theme="light">${icons.sun(14)} ${escapeHtml(t('settingsThemeLight'))}</button>
            </div>
          </div>

          <div class="setting-row">
            <label class="setting-label">${escapeHtml(t('settingsUiLabel'))}</label>
            <div class="seg-group">
              <button type="button" class="seg-btn ${uiStyle === 'modern' ? 'active' : ''}" data-set-ui="modern">${icons.layers(14)} ${escapeHtml(t('settingsUiModern'))}</button>
              <button type="button" class="seg-btn ${uiStyle === 'raw' ? 'active' : ''}" data-set-ui="raw">${icons.code(14)} ${escapeHtml(t('settingsUiRaw'))}</button>
            </div>
          </div>

          <div class="setting-row">
            <label class="setting-label">${escapeHtml(t('settingsAppLabel'))}</label>
            ${pwaBodyHtml}
            <div class="setting-pwa-note">${escapeHtml(t('settingsFileAssocNote'))}</div>
          </div>

          <div class="setting-row setting-shortcuts">
            <label class="setting-label">${escapeHtml(t('settingsShortcutsLabel'))}</label>
            <div class="shortcut-list">
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutOpen'))}</span><kbd>Ctrl + O</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutCloseTab'))}</span><kbd>Alt + W</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutSave'))}</span><kbd>Ctrl + S</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutSearch'))}</span><kbd>Ctrl + F</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutUndoRedo'))}</span><kbd>Ctrl + Z / Y</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutInline'))}</span><kbd>F2</kbd></div>
              <div class="shortcut-item"><span>${escapeHtml(t('shortcutDelete'))}</span><kbd>Delete</kbd></div>
            </div>
          </div>

          <div class="welcome-disclaimer" style="margin-top:14px;padding-top:12px">
            ${t('disclaimerFooter')}
          </div>
        </div>
        <div class="modal-footer modal-footer-between">
          <a class="gh-link" href="https://github.com/j0n9m1n1/dicom-tag-editor" target="_blank" rel="noopener noreferrer">
            ${icons.github(15)}
            <span>j0n9m1n1/dicom-tag-editor</span>
          </a>
          <button class="btn btn-primary" data-modal-close>${escapeHtml(t('modalClose'))}</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    this.root.querySelector('#btn-install-pwa')?.addEventListener('click', async () => {
      const accepted = await this.callbacks.onInstallPwa?.();
      if (accepted) this.close();
      else this.openSettings();
    });

    this.root.querySelectorAll('[data-set-lang]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextLang = btn.dataset.setLang;
        if (nextLang !== getLang()) {
          this.store.setLang(nextLang);
        }
        this.openSettings();
        this.root.querySelector(`[data-set-lang="${nextLang}"]`)?.focus();
      });
    });

    this.root.querySelectorAll('[data-set-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextTheme = btn.dataset.setTheme;
        if (nextTheme !== this.store.theme) {
          this.store.setTheme(nextTheme);
        }
        this.root.querySelectorAll('[data-set-theme]').forEach((b) =>
          b.classList.toggle('active', b.dataset.setTheme === this.store.theme)
        );
      });
    });

    this.root.querySelectorAll('[data-set-ui]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextUi = btn.dataset.setUi;
        if (nextUi !== this.store.uiStyle) {
          this.store.setUiStyle(nextUi);
        }
        this.root.querySelectorAll('[data-set-ui]').forEach((b) =>
          b.classList.toggle('active', b.dataset.setUi === this.store.uiStyle)
        );
      });
    });
  }

  /**
   * Open Detailed File Open / Parse Error Diagnosis Modal.
   * @param {Array<{ fileName?: string, size?: number, error?: any }>} failures
   */
  openFileError(failures) {
    const list = Array.isArray(failures) ? failures.filter(Boolean) : [failures].filter(Boolean);
    if (list.length === 0) return;

    const ERROR_GUIDE_MAP = {
      TOO_SMALL: ['errCauseTooSmall', 'errHintTooSmall'],
      NON_DICOM_FORMAT: ['errCauseNonDicom', 'errHintNonDicom'],
      TRUNCATED_VALUE: ['errCauseTruncated', 'errHintTruncated'],
      TRUNCATED_HEADER: ['errCauseTruncatedHeader', 'errHintTruncated'],
      INVALID_SQ_ITEM: ['errCauseInvalidSq', 'errHintCorrupt'],
      MISSING_SQ_DELIM: ['errCauseMissingDelim', 'errHintCorrupt'],
      MISSING_ITEM_DELIM: ['errCauseMissingDelim', 'errHintCorrupt'],
      UNEXPECTED_ITEM: ['errCauseUnexpectedItem', 'errHintCorrupt'],
      INVALID_ENCAP_PIXEL: ['errCauseInvalidPixel', 'errHintCorrupt'],
      UNSUPPORTED_UNDEF_LEN: ['errCauseUndefLen', 'errHintCorrupt'],
      DEFLATE_FAILED: ['errCauseDeflate', 'errHintDeflate'],
      NO_TAGS: ['errCauseNoTags', 'errHintNonDicom'],
      UNKNOWN: ['errCauseUnknown', 'errHintCorrupt'],
    };

    const formatOffset = (off) =>
      `0x${off.toString(16).toUpperCase().padStart(8, '0')} (${off.toLocaleString()} B)`;

    const reportLines = [];
    const cardsHtml = list
      .map((item) => {
        const err = item.error || {};
        const d = err.details || {};
        const code = err.code && ERROR_GUIDE_MAP[err.code] ? err.code : 'UNKNOWN';
        const [causeKey, hintKey] = ERROR_GUIDE_MAP[code];
        const fileName = item.fileName || d.fileName || 'unknown';
        const fileSize = Number.isFinite(d.fileSize) ? d.fileSize : (item.size ?? null);
        const causeText = t(causeKey, { fmt: d.detectedFormat || 'Unknown' });
        const hintText = t(hintKey);

        const rows = [];
        if (Number.isFinite(fileSize)) {
          rows.push([
            t('errLblFileSize'),
            `${formatByteSize(fileSize)} (${fileSize.toLocaleString()} bytes)`,
            true,
          ]);
        }
        if (typeof d.hasPart10Header === 'boolean') {
          rows.push([
            t('errLblPart10'),
            d.hasPart10Header ? t('errValPart10Yes') : t('errValPart10No'),
            false,
          ]);
        }
        if (d.detectedFormat) {
          rows.push([t('errLblDetectedFmt'), d.detectedFormat, true]);
        }
        if (d.transferSyntaxUid) {
          const tsLabel = d.transferSyntaxName
            ? `${d.transferSyntaxName} (${d.transferSyntaxUid})`
            : d.transferSyntaxUid;
          rows.push([t('errLblTransferSyntax'), tsLabel, true]);
        }
        if (d.tag) {
          rows.push([t('errLblTag'), d.tag, true]);
        }
        if (Number.isFinite(d.offset)) {
          rows.push([t('errLblLocation'), formatOffset(d.offset), true]);
        }
        if (Number.isFinite(d.expectedLength) && Number.isFinite(d.availableBytes)) {
          rows.push([
            t('errLblLengthMismatch'),
            t('errValLengthMismatch', {
              expected: d.expectedLength.toLocaleString(),
              avail: d.availableBytes.toLocaleString(),
            }),
            true,
          ]);
        }
        const rawMsg = d.rawMessage || err.message || String(err);
        if (rawMsg) {
          rows.push([t('errLblRawMsg'), rawMsg, true]);
        }

        let hexLines = [];
        if (d.headerPreview?.headHex) {
          hexLines.push(`0x0000: ${d.headerPreview.headHex.padEnd(47, ' ')}  |${d.headerPreview.headAscii}|`);
          if (d.headerPreview.offset128Hex) {
            hexLines.push(`0x0080: ${d.headerPreview.offset128Hex.padEnd(47, ' ')}  |${d.headerPreview.offset128Ascii}|`);
          }
        }

        // Build plain-text diagnostics block for clipboard copy
        reportLines.push(`=== ${fileName} ===`);
        reportLines.push(`Code: ${code}`);
        reportLines.push(`Cause: ${causeText}`);
        for (const [k, v] of rows) reportLines.push(`${k}: ${v}`);
        if (hexLines.length > 0) {
          reportLines.push('Header Hex:');
          reportLines.push(...hexLines);
        }
        reportLines.push('');

        return `
          <div class="err-diag-card">
            <div class="err-diag-file">
              <span class="err-diag-filename" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
              ${Number.isFinite(fileSize) ? `<span class="muted small mono">${escapeHtml(formatByteSize(fileSize))}</span>` : ''}
            </div>
            <div class="err-diag-banner">
              <div class="err-diag-cause">${escapeHtml(causeText)}</div>
              <div class="err-diag-hint">${escapeHtml(hintText)}</div>
            </div>
            <div class="err-diag-grid">
              ${rows
                .map(
                  ([k, v, isMono]) => `
                <div class="err-diag-k">${escapeHtml(k)}</div>
                <div class="err-diag-v ${isMono ? 'mono' : ''}">${escapeHtml(v)}</div>
              `
                )
                .join('')}
            </div>
            ${
              hexLines.length > 0
                ? `
              <div class="err-diag-hex-wrap">
                <div class="err-diag-hex-title">${escapeHtml(t('errLblHexPreview'))}</div>
                <pre class="err-diag-hex-pre">${escapeHtml(hexLines.join('\n'))}</pre>
              </div>
            `
                : ''
            }
          </div>
        `;
      })
      .join('');

    const subtitle =
      list.length === 1
        ? t('modalErrSubtitleSingle')
        : t('modalErrSubtitleMulti', { count: list.length });

    this.root.innerHTML = `
      <div class="modal-card modal-lg" role="dialog" aria-modal="true">
        <div class="modal-header">
          <div class="modal-err-header">
            <span class="modal-err-icon">${icons.alertCircle(18)}</span>
            <div>
              <h3>${escapeHtml(t('modalErrTitle'))}</h3>
              <div class="muted small">${escapeHtml(subtitle)}</div>
            </div>
          </div>
          <button class="btn-icon" data-modal-close>${icons.x(18)}</button>
        </div>
        <div class="modal-body modal-scroll">
          ${cardsHtml}
        </div>
        <div class="modal-footer modal-footer-between">
          <button type="button" class="btn btn-sm" id="btn-copy-err-diag">${icons.copy(14)} ${escapeHtml(t('modalErrCopyBtn'))}</button>
          <button type="button" class="btn btn-primary" data-modal-close>${escapeHtml(t('modalClose'))}</button>
        </div>
      </div>
    `;

    this.root.classList.remove('hidden');

    const reportText = reportLines.join('\n').trim();
    this.root.querySelector('#btn-copy-err-diag')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(reportText);
        this.callbacks.onToast?.(t('toastCopied'), 'ok');
      } catch {
        // ignore clipboard failure
      }
    });
  }
}
