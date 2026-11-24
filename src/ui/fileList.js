/**
 * Left multi-file workspace sidebar.
 * Displays loaded DICOM files, per-file modification counts,
 * an explicit Close All button, drag-to-Compare support, and a right-click file context menu.
 */

import { countDocChanges } from '../state/store.js';
import { formatByteSize } from '../dicom/parser.js';
import { INTERNAL_FILE_DRAG_MIME } from './compareView.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

export class FileListPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{
   *   onClearAll?: () => void,
   *   onSaveFile?: (entry: any) => void,
   *   onToast?: (msg: string, type?: string) => void,
   *   onSwitchError?: (err: Error, entry?: any) => void,
   * }} callbacks
   */
  constructor(container, store, callbacks) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks || {};

    this._ctxMenuEl = null;
    this._ctxTimer = null;
    this._ctxScrollEl = null;
    this._boundDismissCtx = () => this._closeContextMenu();
    this._boundKeyDownCtx = (e) => {
      if (e.key === 'Escape' && this._ctxMenuEl) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this._closeContextMenu();
      }
    };

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.container.addEventListener('dragstart', (e) => this._onDragStart(e));
  }

  _onDragStart(e) {
    const row = e.target.closest('.file-row[data-file-id]');
    if (!row || !e.dataTransfer) return;
    e.dataTransfer.setData(INTERNAL_FILE_DRAG_MIME, row.dataset.fileId);
    e.dataTransfer.effectAllowed = 'link';
  }

  render() {
    this._closeContextMenu();
    const prevScrollTop = this.container.querySelector('.filelist-scroll')?.scrollTop || 0;
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
          <div class="file-row ${active} ${entry.error ? 'has-error' : ''}" data-file-id="${entry.id}" draggable="true" title="${escapeHtml(entry.name)}">
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
        <button type="button" class="btn btn-xs filelist-close-all-btn" data-fl-action="clear-all" title="${escapeHtml(t('fileListClearAllTitle'))}">${escapeHtml(t('fileListCloseAll'))}</button>
      </div>
      <div class="filelist-scroll">${itemsHtml}</div>
    `;
    const scrollEl = this.container.querySelector('.filelist-scroll');
    if (scrollEl) {
      scrollEl.scrollTop = prevScrollTop;
    }
  }

  async _copyText(str) {
    try {
      await navigator.clipboard.writeText(str);
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = str;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      this.callbacks.onToast?.(t('toastCopied'), 'ok');
    }
  }

  async _closeFileEntry(fileId) {
    const entry = this.store.files.find((f) => f.id === fileId);
    if (!entry) return;
    if (countDocChanges(entry.doc) && !window.confirm(t('confirmCloseFileDirty', { name: entry.name }))) {
      return;
    }
    await this.store.removeFile(entry.id);
  }

  async _closeMultipleEntries(entries) {
    if (!entries || entries.length === 0) return;
    const dirtyCount = entries.filter((entry) => entry.doc && countDocChanges(entry.doc) > 0).length;
    if (dirtyCount > 0 && !window.confirm(t('confirmCloseMultiDirty', { count: dirtyCount }))) {
      return;
    }
    await this.store.removeFiles(entries.map((e) => e.id));
  }

  async _onClick(e) {
    const actBtn = e.target.closest('[data-fl-action]');
    if (actBtn) {
      if (actBtn.dataset.flAction === 'clear-all') {
        this.callbacks.onClearAll?.();
      }
      return;
    }

    const removeBtn = e.target.closest('[data-remove-file]');
    if (removeBtn) {
      e.stopPropagation();
      await this._closeFileEntry(removeBtn.dataset.removeFile);
      return;
    }

    const row = e.target.closest('.file-row');
    if (!row) return;
    const fileId = row.dataset.fileId;
    const entry = this.store.files.find((f) => f.id === fileId) || null;
    try {
      await this.store.switchToFile(fileId);
      if (window.innerWidth <= 820) {
        this.store.setMobileTab('tree');
      }
    } catch (err) {
      this.callbacks.onSwitchError?.(err, entry);
      this.render();
    }
  }

  _onContextMenu(e) {
    const row = e.target.closest('.file-row[data-file-id]');
    if (!row) return;
    e.preventDefault();
    this._openFileContextMenu(row.dataset.fileId, e.clientX, e.clientY);
  }

  _openFileContextMenu(fileId, x, y) {
    const files = this.store.files || [];
    const idx = files.findIndex((f) => f.id === fileId);
    if (idx < 0) return;
    const entry = files[idx];

    const inCompare = Boolean(this.store.compareMode && files.length >= 2);
    const canCompareWithActive = !inCompare && files.length >= 2 && fileId !== this.store.activeFileId;
    const hasOthers = files.length >= 2;
    const hasBelow = idx < files.length - 1;

    const items = [];
    if (inCompare) {
      items.push(
        {
          icon: icons.compare(13),
          label: t('fileCtxAssignA'),
          action: () => this.store.setCompareFiles(fileId, this.store.compareFileBId),
        },
        {
          icon: icons.compare(13),
          label: t('fileCtxAssignB'),
          action: () => this.store.setCompareFiles(this.store.compareFileAId, fileId),
        },
        { sep: true }
      );
    } else if (canCompareWithActive) {
      items.push(
        {
          icon: icons.compare(13),
          label: t('tabCtxCompareWithActive'),
          action: () => this.store.enterCompareMode(this.store.activeFileId, fileId),
        },
        { sep: true }
      );
    }

    items.push(
      {
        icon: icons.copy(13),
        label: t('fileCtxCopyName'),
        action: () => this._copyText(entry.name),
      },
      {
        icon: icons.download(13),
        label: t('fileCtxSaveAs'),
        disabled: Boolean(entry.error),
        action: () => this.callbacks.onSaveFile?.(entry),
      },
      { sep: true },
      {
        label: t('tabCtxClose'),
        action: () => this._closeFileEntry(fileId),
      },
      {
        label: t('tabCtxCloseOthers'),
        disabled: !hasOthers,
        action: () => this._closeMultipleEntries(files.filter((f) => f.id !== fileId)),
      },
      {
        label: t('fileCtxCloseBelow'),
        disabled: !hasBelow,
        action: () => this._closeMultipleEntries(files.slice(idx + 1)),
      }
    );

    this._openContextMenu(x, y, items);
  }

  _openContextMenu(x, y, items) {
    this._closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');

    items.forEach((item) => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item';
      btn.disabled = Boolean(item.disabled);
      btn.innerHTML = `${item.icon || ''}<span class="ctx-item-label">${escapeHtml(item.label)}</span>`;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._closeContextMenu();
        if (!item.disabled) item.action();
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._ctxMenuEl = menu;
    this._ctxScrollEl = this.container.querySelector('.filelist-scroll');
    window.addEventListener('keydown', this._boundKeyDownCtx, true);
    this._ctxScrollEl?.addEventListener('scroll', this._boundDismissCtx, { passive: true });
    this._ctxTimer = setTimeout(() => {
      this._ctxTimer = null;
      if (this._ctxMenuEl !== menu) return;
      window.addEventListener('click', this._boundDismissCtx);
      window.addEventListener('contextmenu', this._boundDismissCtx);
      window.addEventListener('resize', this._boundDismissCtx);
    }, 0);
  }

  _closeContextMenu() {
    if (this._ctxTimer !== null) {
      clearTimeout(this._ctxTimer);
      this._ctxTimer = null;
    }
    window.removeEventListener('keydown', this._boundKeyDownCtx, true);
    window.removeEventListener('click', this._boundDismissCtx);
    window.removeEventListener('contextmenu', this._boundDismissCtx);
    window.removeEventListener('resize', this._boundDismissCtx);
    if (this._ctxScrollEl) {
      this._ctxScrollEl.removeEventListener('scroll', this._boundDismissCtx);
      this._ctxScrollEl = null;
    }
    if (!this._ctxMenuEl) return;
    this._ctxMenuEl.remove();
    this._ctxMenuEl = null;
  }
}
