/**
 * Visual Studio / VS Code-style Editor File Tab Bar.
 * Sits above the main workspace (Tree + Inspector or Compare view) so users can:
 *  - Switch open DICOM files in 1 click even with the left Open Files sidebar collapsed
 *  - See dirty (unsaved) dots, error indicators, and middle-truncated DICOM filenames
 *  - Close via × or middle-click, reorder via drag-and-drop, or drag directly onto Compare A/B
 *  - Right-click for context actions (Compare with Active, Close, Close Others, Close to the Right)
 *  - Toggle / return to the Compare workspace via the pinned Compare tab on the right
 */

import { countDocChanges } from '../state/store.js';
import { INTERNAL_FILE_DRAG_MIME } from './compareView.js';
import { icons, escapeHtml } from './icons.js';
import { t } from '../i18n.js';

/**
 * Middle-truncate long filenames (common for DICOM UID-based filenames like
 * `1.2.840.113619.2.55.3...0001.dcm`) so the distinguishing tail & extension remain readable.
 */
export function formatTabLabel(fullPath, maxLen = 28) {
  const base = String(fullPath || '').split('/').at(-1) || String(fullPath || '');
  if (base.length <= maxLen) return base;
  const keepEnd = Math.min(12, Math.floor((maxLen - 1) * 0.45));
  const keepStart = Math.max(4, maxLen - 1 - keepEnd);
  return `${base.slice(0, keepStart)}…${base.slice(-keepEnd)}`;
}

export class FileTabsBar {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {{
   *   onAddFiles?: () => void,
   *   onCompare?: () => void,
   *   onSwitchError?: (err: Error, entry: any) => void,
   * }} callbacks
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;

    this._lastActiveKey = null;
    this._dragFileId = null;
    this._ctxMenuEl = null;
    this._boundDismissCtx = () => this._closeContextMenu();

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('mousedown', (e) => {
      // Prevent browser middle-click autoscroll cursor on tabs
      if (e.button === 1 && e.target.closest('.file-tab')) {
        e.preventDefault();
      }
    });
    this.container.addEventListener('auxclick', (e) => this._onAuxClick(e));
    this.container.addEventListener('contextmenu', (e) => this._onContextMenu(e));
    this.container.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Drag-and-drop: reorder tabs within strip OR drag onto Compare A/B panes
    this.container.addEventListener('dragstart', (e) => this._onDragStart(e));
    this.container.addEventListener('dragover', (e) => this._onDragOver(e));
    this.container.addEventListener('dragleave', (e) => this._onDragLeave(e));
    this.container.addEventListener('drop', (e) => this._onDrop(e));
    this.container.addEventListener('dragend', () => this._clearDragState());
  }

  render() {
    const files = this.store.files || [];
    const hasFiles = files.length > 0 && Boolean(this.store.doc);
    this.container.classList.toggle('hidden', !hasFiles);

    if (!hasFiles) {
      this._closeContextMenu();
      this.container.innerHTML = '';
      this._lastActiveKey = null;
      return;
    }

    const inCompare = Boolean(this.store.compareMode && files.length >= 2);
    const tabsHtml = files
      .map((entry) => {
        const isActive = entry.id === this.store.activeFileId && !inCompare;
        const changes = entry.doc ? countDocChanges(entry.doc) : 0;
        const label = formatTabLabel(entry.name);
        const tooltipParts = [entry.name];
        if (entry.doc) {
          const modNode = entry.doc.datasetNodes?.find((n) => n.tag === '00080060' && n.status !== 'deleted');
          const mod = modNode && !modNode.isBinary && !modNode.isSequence ? (modNode.value || '').trim() : '';
          if (mod) tooltipParts.push(`Modality: ${mod}`);
        }
        if (changes > 0) tooltipParts.push(t('fileListModifiedTag', { n: changes }));
        if (entry.error) tooltipParts.push(`${t('fileListErrorTag')}: ${entry.error}`);

        const dotHtml = entry.error
          ? `<span class="file-tab-dot is-error" aria-hidden="true"></span>`
          : changes > 0
            ? `<span class="file-tab-dot is-dirty" title="${escapeHtml(t('fileListModifiedTag', { n: changes }))}"></span>`
            : '';

        return `
          <div class="file-tab ${isActive ? 'active' : ''} ${entry.error ? 'has-error' : ''}"
               role="tab"
               aria-selected="${isActive ? 'true' : 'false'}"
               data-file-id="${entry.id}"
               draggable="true"
               title="${escapeHtml(tooltipParts.join(' · '))}">
            ${dotHtml}
            <span class="file-tab-label">${escapeHtml(label)}</span>
            <button type="button"
                    class="file-tab-close"
                    data-tab-close="${entry.id}"
                    title="${escapeHtml(t('tabCloseTitle'))}"
                    aria-label="${escapeHtml(t('tabCloseTitle'))}">${icons.x(12)}</button>
          </div>
        `;
      })
      .join('');

    const compareTabHtml = files.length >= 2
      ? inCompare
        ? `
          <div class="file-tab file-tab-compare active" role="tab" aria-selected="true" data-tab-action="compare" title="${escapeHtml(t('tabCompareTitle'))}">
            ${icons.diff(13)}
            <span class="file-tab-label">${escapeHtml(t('tabCompareLabel'))}</span>
            <button type="button"
                    class="file-tab-close"
                    data-tab-action="close-compare"
                    title="${escapeHtml(t('tabCloseCompareTitle'))}"
                    aria-label="${escapeHtml(t('tabCloseCompareTitle'))}">${icons.x(12)}</button>
          </div>
        `
        : `
          <button type="button" class="file-tab-action-btn" data-tab-action="compare" title="${escapeHtml(t('tabCompareTitle'))}">
            ${icons.diff(13)}<span>${escapeHtml(t('tabCompareLabel'))}</span>
          </button>
        `
      : '';

    this.container.innerHTML = `
      <div class="file-tabs-scroll" id="file-tabs-scroll">${tabsHtml}</div>
      <div class="file-tabs-actions">
        ${compareTabHtml}
        <button type="button" class="file-tab-action-btn file-tab-add-btn" data-tab-action="add" title="${escapeHtml(t('tabAddFileTitle'))}" aria-label="${escapeHtml(t('tabAddFileTitle'))}">
          ${icons.plus(13)}
        </button>
      </div>
    `;

    // Scroll newly activated file tab into view
    const activeKey = inCompare ? '__compare__' : this.store.activeFileId;
    if (activeKey && activeKey !== this._lastActiveKey) {
      this._lastActiveKey = activeKey;
      if (!inCompare) {
        const activeEl = this.container.querySelector(`.file-tab[data-file-id="${activeKey}"]`);
        activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }

  _onWheel(e) {
    const scrollEl = e.target.closest('.file-tabs-scroll');
    if (!scrollEl) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scrollEl.scrollWidth > scrollEl.clientWidth) {
      e.preventDefault();
      scrollEl.scrollLeft += e.deltaY;
    }
  }

  async closeActiveTab() {
    if (this.store.compareMode) {
      this.store.exitCompareMode();
      return;
    }
    if (this.store.activeFileId) {
      await this._closeFileEntry(this.store.activeFileId);
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
    const closeCompareBtn = e.target.closest('[data-tab-action="close-compare"]');
    if (closeCompareBtn) {
      e.stopPropagation();
      this.store.exitCompareMode();
      return;
    }

    const actionBtn = e.target.closest('[data-tab-action]');
    if (actionBtn) {
      const act = actionBtn.dataset.tabAction;
      if (act === 'add') this.callbacks.onAddFiles?.();
      else if (act === 'compare') {
        if (!this.store.compareMode) this.callbacks.onCompare?.();
      }
      return;
    }

    const closeBtn = e.target.closest('[data-tab-close]');
    if (closeBtn) {
      e.stopPropagation();
      await this._closeFileEntry(closeBtn.dataset.tabClose);
      return;
    }

    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    const fileId = tab.dataset.fileId;
    const entry = this.store.files.find((f) => f.id === fileId) || null;
    try {
      await this.store.switchToFile(fileId);
      if (this.store.compareMode) {
        this.store.exitCompareMode();
      }
    } catch (err) {
      this.callbacks.onSwitchError?.(err, entry);
      this.render();
    }
  }

  async _onAuxClick(e) {
    if (e.button !== 1) return;
    const compareTab = e.target.closest('.file-tab-compare');
    if (compareTab) {
      e.preventDefault();
      this.store.exitCompareMode();
      return;
    }
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    e.preventDefault();
    await this._closeFileEntry(tab.dataset.fileId);
  }

  _onDragStart(e) {
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab || !e.dataTransfer) return;
    const fileId = tab.dataset.fileId;
    this._dragFileId = fileId;
    e.dataTransfer.setData(INTERNAL_FILE_DRAG_MIME, fileId);
    // Allow both tab reordering ('move') and Compare pane assignment ('link')
    e.dataTransfer.effectAllowed = 'linkMove';
    tab.classList.add('tab-dragging');
  }

  _onDragOver(e) {
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab || !this._dragFileId) return;
    const targetId = tab.dataset.fileId;
    if (targetId === this._dragFileId) return;
    if (!Array.from(e.dataTransfer?.types || []).includes(INTERNAL_FILE_DRAG_MIME)) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const rect = tab.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    this._clearDropIndicators();
    tab.classList.add(after ? 'tab-drop-after' : 'tab-drop-before');
  }

  _onDragLeave(e) {
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    tab.classList.remove('tab-drop-before', 'tab-drop-after');
  }

  _onDrop(e) {
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab || !this._dragFileId) return;
    const fromId = e.dataTransfer?.getData(INTERNAL_FILE_DRAG_MIME) || this._dragFileId;
    const targetId = tab.dataset.fileId;
    if (!fromId || fromId === targetId) {
      this._clearDragState();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = tab.getBoundingClientRect();
    const insertAfter = e.clientX > rect.left + rect.width / 2;
    this._clearDragState();
    this.store.reorderFile(fromId, targetId, insertAfter);
  }

  _clearDropIndicators() {
    this.container
      .querySelectorAll('.tab-drop-before, .tab-drop-after')
      .forEach((el) => el.classList.remove('tab-drop-before', 'tab-drop-after'));
  }

  _clearDragState() {
    this._dragFileId = null;
    this._clearDropIndicators();
    this.container.querySelectorAll('.tab-dragging').forEach((el) => el.classList.remove('tab-dragging'));
  }

  _onContextMenu(e) {
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    e.preventDefault();
    const fileId = tab.dataset.fileId;
    const files = this.store.files || [];
    const idx = files.findIndex((f) => f.id === fileId);
    if (idx < 0) return;

    const canCompareWithActive = files.length >= 2 && fileId !== this.store.activeFileId;
    const hasOthers = files.length >= 2;
    const hasRight = idx < files.length - 1;

    this._openContextMenu(e.clientX, e.clientY, [
      ...(canCompareWithActive
        ? [{
            label: t('tabCtxCompareWithActive'),
            action: () => this.store.enterCompareMode(this.store.activeFileId, fileId),
          }, { sep: true }]
        : []),
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
        label: t('tabCtxCloseRight'),
        disabled: !hasRight,
        action: () => this._closeMultipleEntries(files.slice(idx + 1)),
      },
    ]);
  }

  _openContextMenu(x, y, items) {
    this._closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');

    items.forEach((item, idx) => {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item';
      btn.textContent = item.label;
      btn.disabled = Boolean(item.disabled);
      btn.dataset.idx = String(idx);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._closeContextMenu();
        if (!item.disabled) item.action();
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this._ctxMenuEl = menu;
    setTimeout(() => {
      window.addEventListener('click', this._boundDismissCtx);
      window.addEventListener('contextmenu', this._boundDismissCtx);
      window.addEventListener('resize', this._boundDismissCtx);
    }, 0);
  }

  _closeContextMenu() {
    if (!this._ctxMenuEl) return;
    this._ctxMenuEl.remove();
    this._ctxMenuEl = null;
    window.removeEventListener('click', this._boundDismissCtx);
    window.removeEventListener('contextmenu', this._boundDismissCtx);
    window.removeEventListener('resize', this._boundDismissCtx);
  }
}
