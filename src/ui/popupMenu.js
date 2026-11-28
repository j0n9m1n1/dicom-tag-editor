/**
 * Singleton popup & context menu manager shared across:
 *  - Topbar dropdowns (Edit, Save split button)
 *  - Open Files sidebar context menu
 *  - Editor File Tabs context menu
 *  - DICOM Tag Tree context menu
 *
 * Guarantees only one menu is open at a time, clamps cleanly inside the viewport,
 * supports pointer (x, y) or element-anchored positioning, and handles Escape /
 * ArrowUp / ArrowDown / Home / End keyboard navigation.
 */

import { escapeHtml } from './icons.js';

let activeMenu = null;

export function isPopupMenuOpenFor(triggerEl) {
  return Boolean(triggerEl && activeMenu && activeMenu.triggerEl === triggerEl);
}

export function closePopupMenu() {
  if (!activeMenu) return;
  const { el, triggerEl, focusBack, scrollEl, timer, onDismiss, onKeyDown } = activeMenu;
  const hadFocus = el.contains(document.activeElement);
  activeMenu = null;
  if (timer !== null) clearTimeout(timer);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('click', onDismiss);
  window.removeEventListener('contextmenu', onDismiss);
  window.removeEventListener('resize', onDismiss);
  if (scrollEl) scrollEl.removeEventListener('scroll', onDismiss);
  if (triggerEl) {
    triggerEl.setAttribute('aria-expanded', 'false');
    triggerEl.classList.remove('menu-open');
  }
  el.remove();
  if (hadFocus && focusBack?.isConnected) focusBack.focus({ preventScroll: true });
}

/**
 * Open a singleton popup/context menu.
 * @param {{
 *   items: Array<{
 *     sep?: boolean,
 *     icon?: string,
 *     label?: string,
 *     labelHtml?: string,
 *     shortcut?: string,
 *     title?: string,
 *     danger?: boolean,
 *     disabled?: boolean,
 *     action?: () => void,
 *   }>,
 *   x?: number,
 *   y?: number,
 *   anchorEl?: HTMLElement | null,
 *   triggerEl?: HTMLElement | null,
 *   scrollEl?: HTMLElement | null,
 *   className?: string,
 * }} opts
 */
export function openPopupMenu({
  items = [],
  x = 0,
  y = 0,
  anchorEl = null,
  triggerEl = null,
  scrollEl = null,
  className = '',
}) {
  if (triggerEl && isPopupMenuOpenFor(triggerEl)) {
    closePopupMenu();
    return;
  }
  closePopupMenu();
  const focusBack = triggerEl || document.activeElement;

  const menu = document.createElement('div');
  menu.className = className ? `ctx-menu ${className}` : 'ctx-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (!item) continue;
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.danger ? 'ctx-item ctx-danger' : 'ctx-item';
    btn.setAttribute('role', 'menuitem');
    btn.disabled = Boolean(item.disabled);
    if (item.title) btn.title = item.title;

    const labelMarkup = item.labelHtml ?? escapeHtml(item.label || '');
    btn.innerHTML = `
      ${item.icon || ''}
      <span class="ctx-item-label">${labelMarkup}</span>
      ${item.shortcut ? `<span class="ctx-shortcut">${escapeHtml(item.shortcut)}</span>` : ''}
    `;

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closePopupMenu();
      if (!item.disabled) item.action?.();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const menuRect = menu.getBoundingClientRect();

  let left;
  let top;
  if (anchorEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    left = Math.max(8, Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
    top = Math.min(anchorRect.bottom + 4, Math.max(8, window.innerHeight - menuRect.height - 8));
  } else {
    left = Math.max(8, Math.min(x, window.innerWidth - menuRect.width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - menuRect.height - 8));
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  if (triggerEl) {
    triggerEl.setAttribute('aria-expanded', 'true');
    triggerEl.classList.add('menu-open');
  }

  const onDismiss = () => closePopupMenu();
  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closePopupMenu();
      return;
    }
    if (e.key === 'Tab') {
      closePopupMenu();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const enabled = Array.from(menu.querySelectorAll('.ctx-item:not(:disabled)'));
      if (enabled.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const curIdx = enabled.indexOf(document.activeElement);
      let nextIdx = 0;
      if (e.key === 'ArrowDown') {
        nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % enabled.length;
      } else if (e.key === 'ArrowUp') {
        nextIdx = curIdx <= 0 ? enabled.length - 1 : curIdx - 1;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = enabled.length - 1;
      }
      enabled[nextIdx]?.focus();
    }
  };

  const state = { el: menu, triggerEl, focusBack, scrollEl, timer: null, onDismiss, onKeyDown };
  activeMenu = state;

  menu.querySelector('.ctx-item:not(:disabled)')?.focus?.({ preventScroll: true });

  window.addEventListener('keydown', onKeyDown, true);
  scrollEl?.addEventListener('scroll', onDismiss, { passive: true });
  state.timer = setTimeout(() => {
    state.timer = null;
    if (activeMenu !== state) return;
    window.addEventListener('click', onDismiss);
    window.addEventListener('contextmenu', onDismiss);
    window.addEventListener('resize', onDismiss);
  }, 0);
}
