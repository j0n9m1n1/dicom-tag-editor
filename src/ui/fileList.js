/**
 * Left multi-file workspace sidebar.
 * Displays loaded DICOM files, per-file modification counts,
 * and batch actions (Add more files, Batch Edit, Save All as ZIP).
 */

import { countDocChanges } from '../state/store.js';
import { formatByteSize } from '../dicom/parser.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

export class FileListPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{
   *   onAddFiles: () => void,
   *   onBatchEdit: () => void,
   *   onSaveZip: () => void,
   *   onSwitchError: (err: Error) => void,
   * }} callbacks
   */
  constructor(container, store, callbacks) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks || {};

    this.container.addEventListener('click', (e) => this._onClick(e));
  }

  render() {
    const files = this.store.files || [];
    const show = this.store.showFileList && files.length > 0;
    this.container.classList.toggle('desktop-hidden', !show);

    if (files.length === 0) {
      this.container.innerHTML = '';
      return;
    }

    const itemsHtml = files
      .map((entry, idx) => {
        const active = entry.id === this.store.activeFileId ? 'active' : '';
        const changes = entry.doc ? countDocChanges(entry.doc) : 0;
        const sizeLabel = entry.size ? formatByteSize(entry.size) : '';
        const badgeHtml = entry.error
          ? `<span class="mini-badge badge-err" title="${escapeHtml(entry.error)}">${escapeHtml(t('fileListErrorTag'))}</span>`
          : changes > 0
            ? `<span class="file-mod-badge">${escapeHtml(t('fileListModifiedTag', { n: changes }))}</span>`
            : '';

        return `
          <div class="file-row ${active} ${entry.error ? 'has-error' : ''}" data-file-id="${entry.id}" title="${escapeHtml(entry.name)}">
            <div class="file-row-main">
              <span class="file-idx">${idx + 1}</span>
              <div class="file-row-info">
                <div class="file-row-name">${escapeHtml(entry.name)}</div>
                <div class="file-row-meta">
                  <span>${escapeHtml(sizeLabel)}</span>
                  ${badgeHtml}
                </div>
              </div>
            </div>
            <button class="btn-icon file-close-btn" data-remove-file="${entry.id}" title="${escapeHtml(t('fileListRemoveTitle'))}">${icons.x(13)}</button>
          </div>
        `;
      })
      .join('');

    this.container.innerHTML = `
      <div class="filelist-header">
        <span class="filelist-title">${icons.files(14)} ${escapeHtml(t('fileListTitle', { n: files.length }))}</span>
        <button class="btn btn-xs" data-fl-action="add" title="${escapeHtml(t('fileListAddTitle'))}">${icons.plus(12)} ${escapeHtml(t('fileListAdd'))}</button>
      </div>
      <div class="filelist-actions">
        <button class="btn btn-xs" data-fl-action="batch-edit" title="${escapeHtml(t('fileListBatchEditTitle'))}" ${files.length < 1 ? 'disabled' : ''}>${icons.sliders(12)} ${escapeHtml(t('fileListBatchEdit'))}</button>
        <button class="btn btn-xs btn-primary" data-fl-action="save-zip" title="${escapeHtml(t('fileListSaveZipTitle'))}" ${files.length < 1 ? 'disabled' : ''}>${icons.archive(12)} ${escapeHtml(t('fileListSaveZip'))}</button>
      </div>
      <div class="filelist-scroll">${itemsHtml}</div>
    `;
  }

  async _onClick(e) {
    const actBtn = e.target.closest('[data-fl-action]');
    if (actBtn) {
      const act = actBtn.dataset.flAction;
      if (act === 'add') this.callbacks.onAddFiles?.();
      else if (act === 'batch-edit') this.callbacks.onBatchEdit?.();
      else if (act === 'save-zip') this.callbacks.onSaveZip?.();
      return;
    }

    const removeBtn = e.target.closest('[data-remove-file]');
    if (removeBtn) {
      e.stopPropagation();
      await this.store.removeFile(removeBtn.dataset.removeFile);
      return;
    }

    const row = e.target.closest('.file-row');
    if (!row) return;
    const fileId = row.dataset.fileId;
    try {
      await this.store.switchToFile(fileId);
      if (window.innerWidth <= 820) {
        this.store.setMobileTab('tree');
      }
    } catch (err) {
      this.callbacks.onSwitchError?.(err);
      this.render();
    }
  }
}
