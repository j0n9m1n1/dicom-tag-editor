/**
 * Visual Studio / VS Code-style Editor File Tab Bar.
 * Sits above the main workspace (Tree + Inspector or Compare view) so users can:
 *  - Switch open DICOM files in 1 click even with the left Open Files sidebar collapsed
 *  - See dirty (unsaved) dots, error indicators, and middle-truncated DICOM filenames
 *  - Close via × or middle-click, reorder via drag-and-drop, or drag directly onto Compare A/B
 *  - Right-click for context actions (Compare with Active, Close, Close Others, Close to the Right)
 */

import { countDocChanges } from '../state/store.js';
import { confirmAndCloseFile, confirmAndCloseFiles } from '../utils/uiHelpers.js';
import { openPopupMenu, closePopupMenu } from './popupMenu.js';
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
   *   onSwitchError?: (err: Error, entry: any) => void,
   * }} callbacks
   */
  constructor(container, store, callbacks = {}) {
    this.container = container;
    this.store = store;
    this.callbacks = callbacks;

    this._lastActiveKey = null;
    this._dragFileId = null;
    this._boundClearDrag = () => this._clearDragState();

    this.container.addEventListener('click', (e) => this._onClick(e));
    this.container.addEventListener('keydown', (e) => this._onKeyDown(e));
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
    this.container.addEventListener('dragend', this._boundClearDrag);
    window.addEventListener('dragend', this._boundClearDrag);
  }

  render() {
    closePopupMenu();
    this._clearDragState();

    const prevScrollLeft = this.container.querySelector('#file-tabs-scroll')?.scrollLeft || 0;
    const files = this.store.files || [];
    const hasFiles = files.length > 0 && Boolean(this.store.doc);
    this.container.classList.toggle('hidden', !hasFiles);

    if (!hasFiles) {
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
               tabindex="0"
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

    this.container.innerHTML = `<div class="file-tabs-scroll" id="file-tabs-scroll">${tabsHtml}</div>`;

    // Preserve horizontal scroll position across edits/filters before scrolling newly active tab into view
    const scrollEl = this.container.querySelector('#file-tabs-scroll');
    if (scrollEl) {
      scrollEl.scrollLeft = prevScrollLeft;
    }

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
      await confirmAndCloseFile(this.store, this.store.activeFileId, this.callbacks.onCloseErrors);
    }
  }

  async _activateFileTab(fileId) {
    const entry = this.store.files.find((f) => f.id === fileId) || null;
    try {
      await this.store.switchToFile(fileId);
    } catch (err) {
      this.callbacks.onSwitchError?.(err, entry);
      this.render();
    }
  }

  async _onKeyDown(e) {
    if (e.target.closest('button')) return;
    const tab = e.target.closest('.file-tab');
    if (!tab) return;

    const tabs = Array.from(this.container.querySelectorAll('.file-tab'));
    const curIdx = tabs.indexOf(tab);

    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      if (tabs.length === 0) return;
      e.preventDefault();
      let nextIdx = curIdx;
      if (e.key === 'ArrowRight') nextIdx = (curIdx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabs.length - 1;
      tabs[nextIdx]?.focus();
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (tab.dataset.fileId) {
        const fid = tab.dataset.fileId;
        await this._activateFileTab(fid);
        this.container.querySelector(`.file-tab[data-file-id="${fid}"]`)?.focus();
      }
      return;
    }

    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && tab.dataset.fileId) {
      e.preventDefault();
      const rect = tab.getBoundingClientRect();
      this._openFileContextMenu(tab.dataset.fileId, rect.left + 8, rect.bottom + 2);
    }
  }

  async _onClick(e) {
    const closeBtn = e.target.closest('[data-tab-close]');
    if (closeBtn) {
      e.stopPropagation();
      await confirmAndCloseFile(this.store, closeBtn.dataset.tabClose, this.callbacks.onCloseErrors);
      return;
    }

    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    await this._activateFileTab(tab.dataset.fileId);
  }

  async _onAuxClick(e) {
    if (e.button !== 1) return;
    const tab = e.target.closest('.file-tab[data-file-id]');
    if (!tab) return;
    e.preventDefault();
    await confirmAndCloseFile(this.store, tab.dataset.fileId, this.callbacks.onCloseErrors);
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
    if (e.relatedTarget && tab.contains(e.relatedTarget)) return;
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
    this._openFileContextMenu(tab.dataset.fileId, e.clientX, e.clientY);
  }

  _openFileContextMenu(fileId, x, y) {
    const files = this.store.files || [];
    const idx = files.findIndex((f) => f.id === fileId);
    if (idx < 0) return;

    const canCompareWithActive = files.length >= 2 && fileId !== this.store.activeFileId;
    const hasOthers = files.length >= 2;
    const hasRight = idx < files.length - 1;

    openPopupMenu({
      x,
      y,
      scrollEl: this.container.querySelector('#file-tabs-scroll'),
      items: [
        ...(canCompareWithActive
          ? [{
              icon: icons.compare(13),
              label: t('tabCtxCompareWithActive'),
              action: () => this.store.enterCompareMode(this.store.activeFileId, fileId),
            }, { sep: true }]
          : []),
        {
          label: t('tabCtxClose'),
          action: () => confirmAndCloseFile(this.store, fileId, this.callbacks.onCloseErrors),
        },
        {
          label: t('tabCtxCloseOthers'),
          disabled: !hasOthers,
          action: () => confirmAndCloseFiles(this.store, files.filter((f) => f.id !== fileId), this.callbacks.onCloseErrors),
        },
        {
          label: t('tabCtxCloseRight'),
          disabled: !hasRight,
          action: () => confirmAndCloseFiles(this.store, files.slice(idx + 1), this.callbacks.onCloseErrors),
        },
      ],
    });
  }
}
