/**
 * Collapsible Pixel Preview Dock Panel.
 * Supports interactive mouse/touch drag Window/Level, CT W/L presets,
 * cursor (X, Y) + pixel/HU value HUD, wheel Zoom & Shift+drag Pan,
 * Invert, Auto W/L, multi-frame navigation, and live sync when 0028 tags change.
 */

import {
  extractPixelMeta,
  decodePixelFrame,
  renderFrameToCanvas,
} from '../dicom/pixelRenderer.js';
import { icons, escapeHtml } from './icons.js';
import { t, getLang } from '../i18n.js';
import { downloadBlobBytes } from '../utils/uiHelpers.js';

const CT_PRESETS = [
  { key: 'pixelPresetBrain', wc: 40, ww: 80 },
  { key: 'pixelPresetSoft', wc: 40, ww: 400 },
  { key: 'pixelPresetLung', wc: -600, ww: 1500 },
  { key: 'pixelPresetBone', wc: 300, ww: 1500 },
];

export class PixelPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   * @param {(message: string) => void} [onExportError]
   */
  constructor(container, store, onExportError) {
    this.container = container;
    this.store = store;
    this.onExportError = onExportError;
    this._lastPixelVersion = -1;
    this._lastLang = null;
    this._lastFullMode = false;
    this._previewDoc = null;
    this._renderedFrame = null;
    this._meta = null;
    this._decoded = null;
    this._frameIndex = 0;
    this._wc = 40;
    this._ww = 400;
    this._invert = false;
    this._showOverlays = true;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._dragMode = null; // 'wl' | 'pan'
    this._dragStart = null;
    this._renderToken = 0;

    this.container.addEventListener('click', (e) => {
      if (e.target.closest('[data-pixel-expand]')) {
        e.stopPropagation();
        this.store.setViewMode('pixel');
        return;
      }
      if (e.target.closest('[data-pixel-exit]')) {
        e.stopPropagation();
        this.store.setViewMode('tree');
        return;
      }
      if (e.target.closest('[data-pixel-toggle]')) {
        if (window.innerWidth > 820 && this.store.viewMode !== 'pixel') {
          this.store.togglePixelPanel();
        }
      }
    });

    this.container.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-pixel-toggle]')) {
        if (window.innerWidth > 820 && this.store.viewMode !== 'pixel' && !e.target.closest('button')) {
          e.preventDefault();
          this.store.togglePixelPanel();
        }
      }
    });
  }

  _releaseDecoded() {
    if (this._decoded?.kind === 'bitmap') {
      try {
        this._decoded.bitmap.close?.();
      } catch {
        // ignore already-closed bitmap
      }
    }
    this._decoded = null;
    this._renderedFrame = null;
  }

  _headerHtml(meta, isCollapsed) {
    const isFull = this.store.viewMode === 'pixel';
    const isMobile = window.innerWidth <= 820;
    const canToggle = !isMobile && !isFull;
    const chev = canToggle ? (isCollapsed ? icons.chevronRight(14) : icons.chevronDown(14)) : '';
    const metaPill = meta
      ? `<span class="pixel-meta-pill">${meta.cols}×${meta.rows} · ${meta.bitsStored}/${meta.bitsAllocated}b${isCollapsed ? '' : ` · ${escapeHtml(meta.photometric)}`}</span>`
      : '';
    const actionBtn = isFull
      ? `<button type="button" class="btn btn-xs" data-pixel-exit="true">${icons.x(13)}<span>${escapeHtml(t('rawExitBtn'))}</span></button>`
      : meta
        ? `<button type="button" class="btn-icon pixel-expand-btn" data-pixel-expand="true" title="${escapeHtml(t('pixelExpandTitle'))}">${icons.maximize(13)}</button>`
        : '';
    return `
      <div class="pixel-header ${canToggle ? 'pixel-header-toggle' : ''}" ${canToggle ? `data-pixel-toggle="true" role="button" tabindex="0" title="${escapeHtml(t('pixelToggleHint'))}"` : ''}>
        <span class="pixel-title">${chev}${icons.image(15)} ${escapeHtml(t('pixelTitle'))}</span>
        <div class="pixel-header-right">
          ${metaPill}
          ${actionBtn}
        </div>
      </div>
    `;
  }

  fitCanvas() {
    const wrap = this.container.querySelector('#pixel-canvas-wrap');
    const canvas = this.container.querySelector('#pixel-canvas');
    if (!wrap || !canvas || !this._decoded || this._decoded.kind === 'unsupported') return;

    if (this.store.viewMode !== 'pixel') {
      canvas.style.width = '';
      canvas.style.height = '';
      return;
    }

    const availW = wrap.clientWidth;
    const availH = wrap.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const scale = Math.min(availW / this._decoded.width, availH / this._decoded.height);
    canvas.style.width = `${Math.max(1, Math.floor(this._decoded.width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(this._decoded.height * scale))}px`;
  }

  async sync(force = false) {
    const isFull = this.store.viewMode === 'pixel';
    const isMobile = window.innerWidth <= 820;
    if (isMobile) {
      const shouldHide = !isFull && this.store.mobileTab !== 'pixel';
      this.container.classList.toggle('hidden', shouldHide);
      this.container.classList.remove('collapsed');
      if (shouldHide) return;
    } else {
      this.container.classList.remove('hidden');
      const collapsed = !isFull && !this.store.showPixelPanel;
      this.container.classList.toggle('collapsed', collapsed);

      if (collapsed) {
        this._lastFullMode = false;
        const meta = this.store.doc ? extractPixelMeta(this.store.doc) : null;
        this.container.innerHTML = this._headerHtml(meta, true);
        return;
      }
    }

    if (!this.store.doc) {
      this._lastPixelVersion = -1;
      this._lastLang = null;
      this._lastFullMode = isFull;
      this._previewDoc = null;
      this._releaseDecoded();
      this.container.innerHTML = `
        ${this._headerHtml(null, false)}
        <div class="pixel-empty">${escapeHtml(t('pixelEmptyNoDoc'))}</div>
      `;
      return;
    }

    const curLang = getLang();
    if (
      !force &&
      this._lastPixelVersion === this.store.pixelVersion &&
      this._lastLang === curLang &&
      this._decoded &&
      this.container.querySelector('#pixel-canvas, .pixel-unsupported, .pixel-empty')
    ) {
      if (this._lastFullMode !== isFull) {
        this._lastFullMode = isFull;
        const oldHeader = this.container.querySelector('.pixel-header');
        if (oldHeader) oldHeader.outerHTML = this._headerHtml(this._meta, false);
        requestAnimationFrame(() => this.fitCanvas());
      } else if (isFull) {
        requestAnimationFrame(() => this.fitCanvas());
      }
      return;
    }
    this._lastPixelVersion = this.store.pixelVersion;
    this._lastLang = curLang;
    this._lastFullMode = isFull;

    const meta = extractPixelMeta(this.store.doc);
    this._previewDoc = this.store.doc;
    this._meta = meta;
    this._frameIndex = Math.min(this._frameIndex, Math.max(0, (meta?.numberOfFrames || 1) - 1));
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;

    await this._loadAndDrawFrame(true);
  }

  async _loadAndDrawFrame(resetWindowFromMeta = false) {
    const token = ++this._renderToken;
    const meta = this._meta;
    const doc = this._previewDoc;
    const pixelVersion = this._lastPixelVersion;
    const frameIndex = this._frameIndex;

    if (!meta) {
      this._releaseDecoded();
      this.container.innerHTML = `
        ${this._headerHtml(null, false)}
        <div class="pixel-empty">${escapeHtml(t('pixelEmptyNoTag'))}</div>
      `;
      return;
    }

    const decoded = await decodePixelFrame(meta, frameIndex);
    if (token !== this._renderToken || doc !== this.store.doc || pixelVersion !== this.store.pixelVersion) {
      if (decoded?.kind === 'bitmap') {
        try { decoded.bitmap.close?.(); } catch {}
      }
      return;
    }
    this._releaseDecoded();
    this._decoded = decoded;

    if (decoded.kind === 'unsupported') {
      this.container.innerHTML = `
        ${this._headerHtml(meta, false)}
        <div class="pixel-unsupported">
          <div class="pixel-ts-badge">${escapeHtml(meta.transferSyntaxName)}</div>
          <p>${escapeHtml(decoded.reason)}</p>
        </div>
      `;
      return;
    }

    if (resetWindowFromMeta && decoded.kind === 'scalar') {
      this._wc = meta.windowCenter !== null ? meta.windowCenter : decoded.autoWC;
      this._ww = meta.windowWidth !== null && meta.windowWidth > 0 ? meta.windowWidth : decoded.autoWW;
    }

    this._renderUi(meta, decoded);
    this._redrawCanvas();
    this._renderedFrame = { doc, pixelVersion, frameIndex };
    this.fitCanvas();
    this._applyCanvasTransform();
  }

  _renderUi(meta, decoded) {
    const isScalar = decoded.kind === 'scalar';
    const minVal = isScalar ? Math.min(-1024, Math.floor(decoded.min), Math.floor(this._wc)) : 0;
    const maxVal = isScalar ? Math.max(1500, Math.ceil(decoded.max), Math.ceil(this._wc)) : 255;
    const maxW = isScalar ? Math.max(2000, Math.ceil((decoded.max - decoded.min) * 2), Math.ceil(this._ww)) : 512;

    const presetBtns = isScalar
      ? `<div class="pixel-presets">
          ${CT_PRESETS.map(
            (p) => `<button class="btn btn-xs" data-wl-preset="${p.wc},${p.ww}" title="WC ${p.wc} / WW ${p.ww}">${escapeHtml(t(p.key))}</button>`
          ).join('')}
        </div>`
      : '';

    this.container.innerHTML = `
      ${this._headerHtml(meta, false)}
      <div class="pixel-canvas-wrap" id="pixel-canvas-wrap" title="${escapeHtml(t('pixelCanvasHintV3'))}">
        <canvas id="pixel-canvas"></canvas>
        ${isScalar ? `<div class="pixel-hud" id="pixel-hud">WC: ${Math.round(this._wc)} / WW: ${Math.round(this._ww)}</div>` : ''}
        <div class="pixel-hud pixel-hud-tr hidden" id="pixel-probe"></div>
      </div>
      <div class="pixel-controls">
        ${isScalar ? `
          <label class="wl-row">
            <span>WC</span>
            <input type="range" id="wl-wc" min="${minVal}" max="${maxVal}" step="1" value="${Math.round(this._wc)}" />
            <span class="wl-num" id="wl-wc-num">${Math.round(this._wc)}</span>
          </label>
          <label class="wl-row">
            <span>WW</span>
            <input type="range" id="wl-ww" min="1" max="${maxW}" step="1" value="${Math.round(this._ww)}" />
            <span class="wl-num" id="wl-ww-num">${Math.round(this._ww)}</span>
          </label>
        ` : ''}
        ${meta.numberOfFrames > 1 ? `
          <label class="wl-row">
            <span>Frame</span>
            <input type="range" id="pixel-frame" min="0" max="${meta.numberOfFrames - 1}" step="1" value="${this._frameIndex}" />
            <span class="wl-num" id="pixel-frame-num">${this._frameIndex + 1}/${meta.numberOfFrames}</span>
          </label>
        ` : ''}
        ${presetBtns}
        <div class="pixel-btn-row">
          <button class="btn btn-xs ${this._invert ? 'btn-primary' : ''}" id="btn-pixel-invert">${icons.contrast(13)} ${escapeHtml(t('pixelInvert'))}</button>
          ${(meta.overlays?.length || 0) > 0 ? `<button class="btn btn-xs ${this._showOverlays ? 'btn-primary' : ''}" id="btn-pixel-overlay" title="${escapeHtml(t('pixelOverlayTitle', { n: meta.overlays.length }))}">${icons.layers(12)} ${escapeHtml(t('pixelOverlay'))}${meta.overlays.length > 1 ? ` (${meta.overlays.length})` : ''}</button>` : ''}
          ${isScalar ? `<button class="btn btn-xs" id="btn-pixel-auto">${escapeHtml(t('pixelAutoWl'))}</button>` : ''}
          ${isScalar && meta.windowCenter !== null ? `<button class="btn btn-xs" id="btn-pixel-tag-wl">${escapeHtml(t('pixelTagWl'))}</button>` : ''}
          <button class="btn btn-xs" id="btn-pixel-png" title="${escapeHtml(t('pixelExportPngTitle'))}">${icons.download(12)} PNG</button>
          <span class="pixel-zoom-group">
            <button class="btn btn-xs" id="btn-zoom-out" title="Zoom Out">-</button>
            <button class="btn btn-xs" id="btn-zoom-reset" title="Reset Zoom">${escapeHtml(t('pixelZoomReset'))}</button>
            <button class="btn btn-xs" id="btn-zoom-in" title="Zoom In">+</button>
          </span>
        </div>
      </div>
    `;

    this._bindControls(meta, decoded);
  }

  _applyCanvasTransform() {
    const canvas = this.container.querySelector('#pixel-canvas');
    if (!canvas) return;
    canvas.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
  }

  _bindControls(meta, decoded) {
    const wrap = this.container.querySelector('#pixel-canvas-wrap');
    const canvas = this.container.querySelector('#pixel-canvas');
    const probeEl = this.container.querySelector('#pixel-probe');
    const wcSlider = this.container.querySelector('#wl-wc');
    const wwSlider = this.container.querySelector('#wl-ww');
    const frameSlider = this.container.querySelector('#pixel-frame');
    const invertBtn = this.container.querySelector('#btn-pixel-invert');
    const overlayBtn = this.container.querySelector('#btn-pixel-overlay');
    const autoBtn = this.container.querySelector('#btn-pixel-auto');
    const tagWlBtn = this.container.querySelector('#btn-pixel-tag-wl');
    const pngBtn = this.container.querySelector('#btn-pixel-png');
    const zoomInBtn = this.container.querySelector('#btn-zoom-in');
    const zoomOutBtn = this.container.querySelector('#btn-zoom-out');
    const zoomResetBtn = this.container.querySelector('#btn-zoom-reset');

    if (wcSlider) {
      wcSlider.addEventListener('input', () => {
        this._wc = Number(wcSlider.value);
        this._updateWlReadout();
        this._redrawCanvas();
      });
    }
    if (wwSlider) {
      wwSlider.addEventListener('input', () => {
        this._ww = Math.max(1, Number(wwSlider.value));
        this._updateWlReadout();
        this._redrawCanvas();
      });
    }
    if (frameSlider) {
      frameSlider.addEventListener('input', async () => {
        this._frameIndex = Number(frameSlider.value);
        const lbl = this.container.querySelector('#pixel-frame-num');
        if (lbl) lbl.textContent = `${this._frameIndex + 1}/${meta.numberOfFrames}`;
        await this._loadAndDrawFrame(false);
      });
    }

    this.container.querySelectorAll('[data-wl-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const [wc, ww] = btn.dataset.wlPreset.split(',').map(Number);
        this._wc = wc;
        this._ww = ww;
        this._updateWlReadout();
        this._redrawCanvas();
      });
    });

    if (invertBtn) {
      invertBtn.addEventListener('click', () => {
        this._invert = !this._invert;
        invertBtn.classList.toggle('btn-primary', this._invert);
        this._redrawCanvas();
      });
    }
    if (overlayBtn) {
      overlayBtn.addEventListener('click', () => {
        this._showOverlays = !this._showOverlays;
        overlayBtn.classList.toggle('btn-primary', this._showOverlays);
        this._redrawCanvas();
      });
    }
    if (autoBtn && decoded.kind === 'scalar') {
      autoBtn.addEventListener('click', () => {
        this._wc = decoded.autoWC;
        this._ww = decoded.autoWW;
        this._updateWlReadout();
        this._redrawCanvas();
      });
    }
    if (tagWlBtn && meta.windowCenter !== null) {
      tagWlBtn.addEventListener('click', () => {
        this._wc = meta.windowCenter;
        this._ww = meta.windowWidth > 0 ? meta.windowWidth : decoded.autoWW;
        this._updateWlReadout();
        this._redrawCanvas();
      });
    }
    if (pngBtn) {
      pngBtn.addEventListener('click', () => this.exportPng());
    }

    const setZoom = (next) => {
      this._zoom = Math.max(1, Math.min(5, Number(next.toFixed(2))));
      if (this._zoom === 1) {
        this._panX = 0;
        this._panY = 0;
      }
      this._applyCanvasTransform();
    };
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => setZoom(this._zoom + 0.5));
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => setZoom(this._zoom - 0.5));
    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', () => {
        this._zoom = 1;
        this._panX = 0;
        this._panY = 0;
        this._applyCanvasTransform();
      });
    }

    if (wrap && canvas) {
      // Wheel zoom
      wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.25 : -0.25;
        setZoom(this._zoom + delta);
      }, { passive: false });

      // Cursor (X, Y) + Pixel/HU probe HUD
      canvas.addEventListener('mousemove', (e) => {
        if (!probeEl || this._dragMode) return;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = Math.floor(((e.clientX - rect.left) / rect.width) * decoded.width);
        const y = Math.floor(((e.clientY - rect.top) / rect.height) * decoded.height);
        if (x < 0 || y < 0 || x >= decoded.width || y >= decoded.height) {
          probeEl.classList.add('hidden');
          return;
        }
        const idx = y * decoded.width + x;
        let valText = '';
        if (decoded.kind === 'scalar') {
          const v = decoded.values[idx];
          const unit = meta.rescaleIntercept !== 0 || meta.rescaleSlope !== 1 ? ' HU' : '';
          valText = ` · ${Number.isInteger(v) ? v : v.toFixed(1)}${unit}`;
        } else if (decoded.kind === 'rgb') {
          const p = idx * 4;
          valText = ` · RGB(${decoded.rgba[p]},${decoded.rgba[p + 1]},${decoded.rgba[p + 2]})`;
        }
        probeEl.textContent = `(${x}, ${y})${valText}`;
        probeEl.classList.remove('hidden');
      });

      canvas.addEventListener('mouseleave', () => {
        if (probeEl) probeEl.classList.add('hidden');
      });

      // Mouse drag: Shift+Drag = Pan, Normal Drag = W/L
      const onMove = (e) => {
        if (!this._dragMode || !this._dragStart) return;
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        if (this._dragMode === 'pan') {
          this._panX = this._dragStart.panX + dx;
          this._panY = this._dragStart.panY + dy;
          this._applyCanvasTransform();
        } else if (this._dragMode === 'wl' && decoded.kind === 'scalar') {
          const scale = Math.max(1, (decoded.max - decoded.min) / 250);
          this._ww = Math.max(1, Math.round(this._dragStart.ww + dx * scale));
          this._wc = Math.round(this._dragStart.wc + dy * scale);
          this._updateWlReadout();
          this._redrawCanvas();
        }
      };
      const onUp = () => {
        this._dragMode = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      wrap.addEventListener('mousedown', (e) => {
        if (e.shiftKey || e.button === 1) {
          e.preventDefault();
          this._dragMode = 'pan';
          this._dragStart = { x: e.clientX, y: e.clientY, panX: this._panX, panY: this._panY };
        } else if (decoded.kind === 'scalar') {
          this._dragMode = 'wl';
          this._dragStart = { x: e.clientX, y: e.clientY, wc: this._wc, ww: this._ww };
        } else {
          return;
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      // Touch drag W/L adjustment for mobile devices
      if (decoded.kind === 'scalar') {
        canvas.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          e.preventDefault();
          const pt = e.touches[0];
          this._dragMode = 'wl';
          this._dragStart = { x: pt.clientX, y: pt.clientY, wc: this._wc, ww: this._ww };
        }, { passive: false });

        canvas.addEventListener('touchmove', (e) => {
          if (this._dragMode !== 'wl' || !this._dragStart || e.touches.length !== 1) return;
          e.preventDefault();
          const pt = e.touches[0];
          const dx = pt.clientX - this._dragStart.x;
          const dy = pt.clientY - this._dragStart.y;
          const scale = Math.max(1, (decoded.max - decoded.min) / 220);
          this._ww = Math.max(1, Math.round(this._dragStart.ww + dx * scale));
          this._wc = Math.round(this._dragStart.wc + dy * scale);
          this._updateWlReadout();
          this._redrawCanvas();
        }, { passive: false });

        canvas.addEventListener('touchend', () => {
          this._dragMode = null;
        });
      }
    }
  }

  _updateWlReadout() {
    const wcSlider = this.container.querySelector('#wl-wc');
    const wwSlider = this.container.querySelector('#wl-ww');
    const wcNum = this.container.querySelector('#wl-wc-num');
    const wwNum = this.container.querySelector('#wl-ww-num');
    const hud = this.container.querySelector('#pixel-hud');
    if (wcSlider) wcSlider.value = String(Math.round(this._wc));
    if (wwSlider) wwSlider.value = String(Math.round(this._ww));
    if (wcNum) wcNum.textContent = String(Math.round(this._wc));
    if (wwNum) wwNum.textContent = String(Math.round(this._ww));
    if (hud) hud.textContent = `WC: ${Math.round(this._wc)} / WW: ${Math.round(this._ww)}`;
  }

  async exportPng() {
    const { doc, pixelVersion } = this.store;
    const meta = extractPixelMeta(doc);
    if (!meta) return false;

    const selectedFrame = this._previewDoc === doc ? this._frameIndex : 0;
    const frameIndex = Math.min(selectedFrame, meta.numberOfFrames - 1);
    const rendered = this._renderedFrame;
    const samePixels = rendered?.doc === doc && rendered.pixelVersion === pixelVersion;
    const settings = {
      wc: samePixels ? this._wc : meta.windowCenter,
      ww: samePixels ? this._ww : meta.windowWidth,
      invert: this._invert,
      showOverlays: this._showOverlays,
    };
    const base = doc.fileName.split('/').at(-1).replace(/\.(dcm|dicom)(\.gz)?$/i, '');
    const frameSuffix = meta.numberOfFrames > 1 ? `_f${frameIndex + 1}` : '';
    let canvas = samePixels && rendered.frameIndex === frameIndex
      ? this.container.querySelector('#pixel-canvas') : null;

    try {
      if (!canvas) {
        const decoded = await decodePixelFrame(meta, frameIndex);
        if (decoded.kind === 'unsupported') throw new Error(decoded.reason);

        // A hidden preview or a pending frame can still show an older canvas.
        canvas = document.createElement('canvas');
        try {
          renderFrameToCanvas(canvas, decoded, meta, {
            ...settings,
            wc: settings.wc ?? decoded.autoWC,
            ww: settings.ww > 0 ? settings.ww : decoded.autoWW,
          });
        } finally {
          if (decoded.kind === 'bitmap') decoded.bitmap.close();
        }
      }

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(t('pixelErrPng'));
      downloadBlobBytes(blob, 'image/png', `${base}${frameSuffix}.png`);
      return true;
    } catch (err) {
      this.onExportError?.(err.message);
      return false;
    }
  }

  _redrawCanvas() {
    const canvas = this.container.querySelector('#pixel-canvas');
    if (!canvas || !this._decoded || !this._meta) return;
    renderFrameToCanvas(canvas, this._decoded, this._meta, {
      wc: this._wc,
      ww: this._ww,
      invert: this._invert,
      showOverlays: this._showOverlays,
    });
  }
}
