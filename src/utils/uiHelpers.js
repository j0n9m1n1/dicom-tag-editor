/**
 * Shared browser UI utilities (clipboard, blob download, dirty-file close confirmations).
 */

import { countDocChanges } from '../state/store.js';
import { t } from '../i18n.js';

/**
 * Copy plain text to the system clipboard with a textarea fallback for non-secure contexts.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
  const str = String(text ?? '');
  try {
    await navigator.clipboard.writeText(str);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }
}

/**
 * Trigger a browser file download from bytes or string content.
 * @param {Uint8Array | ArrayBuffer | string} data
 * @param {string} mimeType
 * @param {string} fileName
 */
export function downloadBlobBytes(data, mimeType, fileName) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Prompt before closing a single modified file entry, then remove it from the store.
 * @param {import('../state/store.js').AppStore} store
 * @param {string} fileId
 */
export async function confirmAndCloseFile(store, fileId) {
  const entry = store.files.find((f) => f.id === fileId);
  if (!entry) return;
  if (countDocChanges(entry.doc) && !window.confirm(t('confirmCloseFileDirty', { name: entry.name }))) {
    return;
  }
  await store.removeFile(entry.id);
}

/**
 * Prompt before closing multiple entries if any contain unsaved edits, then remove them.
 * @param {import('../state/store.js').AppStore} store
 * @param {Array<any>} entries
 */
export async function confirmAndCloseFiles(store, entries) {
  if (!entries || entries.length === 0) return;
  const dirtyCount = entries.filter((entry) => entry.doc && countDocChanges(entry.doc) > 0).length;
  if (dirtyCount > 0 && !window.confirm(t('confirmCloseMultiDirty', { count: dirtyCount }))) {
    return;
  }
  await store.removeFiles(entries.map((e) => e.id));
}
