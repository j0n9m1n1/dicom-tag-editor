/**
 * Collapsible Pixel Preview Dock Panel.
 * Supports interactive mouse-drag Window/Level, sliders, Invert, Auto W/L,
 * multi-frame navigation, and live sync when 0028 tags are edited.
 */

import {
  extractPixelMeta,
  decodePixelFrame,
  renderFrameToCanvas,
} from '../dicom/pixelRenderer.js';
import { icons, escapeHtml } from './icons.js';

export class PixelPanel {
  /**
   * @param {HTMLElement} container
   * @param {import('../state/store.js').AppStore} store
   */
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this._lastPixelVersion = -1;
    this._meta = null;
    this._decoded = null;
    this._frameIndex = 0;
    this._wc = 40;
    this._ww = 400;
    this._invert = false;
    this._dragging = false;
    this._dragStart = null;
    this._renderToken = 0;
  }

  async sync(force = false) {
    if (!this.store.showPixelPanel) {
      this.container.classList.add('hidden');
      return;
    }
    this.container.classList.remove('hidden');

    if (!this.store.doc) {
      this._lastPixelVersion = -1;
      this._decoded = null;
      this.container.innerHTML = `
        <div class="pixel-header">
          <span class="pixel-title">${icons.image(15)} Pixel Preview</span>
        </div>
        <div class="pixel-empty">DICOM 파일을 열면 영상 프리뷰가 표시됩니다.</div>
      `;
      return;
    }

    if (!force && this._lastPixelVersion === this.store.pixelVersion && this._decoded) {
      return;
    }
    this._lastPixelVersion = this.store.pixelVersion;

    const meta = extractPixelMeta(this.store.doc);
    this._meta = meta;
    this._frameIndex = Math.min(this._frameIndex, Math.max(0, (meta?.numberOfFrames || 1) - 1));

    await this._loadAndDrawFrame(true);
  }

  async _loadAndDrawFrame(resetWindowFromMeta = false) {
    const token = ++this._renderToken;
    const meta = this._meta;

    if (!meta) {
      this._decoded = null;
      this.container.innerHTML = `
        <div class="pixel-header">
          <span class="pixel-title">${icons.image(15)} Pixel Preview</span>
        </div>
        <div class="pixel-empty">이 파일에는 PixelData (7FE0,0010)가 없습니다.</div>
      `;
      return;
    }

    const decoded = await decodePixelFrame(meta, this._frameIndex);
    if (token !== this._renderToken) return;
    this._decoded = decoded;

    if (decoded.kind === 'unsupported') {
      this.container.innerHTML = `
        <div class="pixel-header">
          <span class="pixel-title">${icons.image(15)} Pixel Preview</span>
          <span class="pixel-meta-pill">${meta.cols}×${meta.rows} · ${meta.bitsAllocated}bit</span>
        </div>
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
  }

  _renderUi(meta, decoded) {
    const isScalar = decoded.kind === 'scalar';
    const minVal = isScalar ? Math.floor(decoded.min) : 0;
    const maxVal = isScalar ? Math.ceil(decoded.max) : 255;
    const maxW = isScalar ? Math.max(10, Math.ceil((decoded.max - decoded.min) * 2)) : 512;

    this.container.innerHTML = `
      <div class="pixel-header">
        <span class="pixel-title">${icons.image(15)} Pixel Preview</span>
        <span class="pixel-meta-pill">${meta.cols}×${meta.rows} · ${meta.bitsStored}/${meta.bitsAllocated}b · ${escapeHtml(meta.photometric)}</span>
      </div>
      <div class="pixel-canvas-wrap" title="드래그하여 Window Center/Width 조절">
        <canvas id="pixel-canvas"></canvas>
        ${isScalar ? `<div class="pixel-hud" id="pixel-hud">WC: ${Math.round(this._wc)} / WW: ${Math.round(this._ww)}</div>` : ''}
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
        <div class="pixel-btn-row">
          <button class="btn btn-xs ${this._invert ? 'btn-primary' : ''}" id="btn-pixel-invert">${icons.contrast(13)} 반전</button>
          ${isScalar ? `<button class="btn btn-xs" id="btn-pixel-auto">Auto W/L</button>` : ''}
          ${isScalar && meta.windowCenter !== null ? `<button class="btn btn-xs" id="btn-pixel-tag-wl">태그 W/L</button>` : ''}
        </div>
      </div>
    `;

    this._bindControls(meta, decoded);
  }

  _bindControls(meta, decoded) {
    const canvas = this.container.querySelector('#pixel-canvas');
    const wcSlider = this.container.querySelector('#wl-wc');
    const wwSlider = this.container.querySelector('#wl-ww');
    const frameSlider = this.container.querySelector('#pixel-frame');
    const invertBtn = this.container.querySelector('#btn-pixel-invert');
    const autoBtn = this.container.querySelector('#btn-pixel-auto');
    const tagWlBtn = this.container.querySelector('#btn-pixel-tag-wl');

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
    if (invertBtn) {
      invertBtn.addEventListener('click', () => {
        this._invert = !this._invert;
        invertBtn.classList.toggle('btn-primary', this._invert);
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

    // Interactive mouse drag W/L adjustment on canvas
    if (canvas && decoded.kind === 'scalar') {
      const onMove = (e) => {
        if (!this._dragging || !this._dragStart) return;
        const dx = e.clientX - this._dragStart.x;
        const dy = e.clientY - this._dragStart.y;
        const scale = Math.max(1, (decoded.max - decoded.min) / 250);
        this._ww = Math.max(1, Math.round(this._dragStart.ww + dx * scale));
        this._wc = Math.round(this._dragStart.wc + dy * scale);
        this._updateWlReadout();
        this._redrawCanvas();
      };
      const onUp = () => {
        this._dragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      canvas.addEventListener('mousedown', (e) => {
        this._dragging = true;
        this._dragStart = { x: e.clientX, y: e.clientY, wc: this._wc, ww: this._ww };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
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

  _redrawCanvas() {
    const canvas = this.container.querySelector('#pixel-canvas');
    if (!canvas || !this._decoded || !this._meta) return;
    renderFrameToCanvas(canvas, this._decoded, this._meta, {
      wc: this._wc,
      ww: this._ww,
      invert: this._invert,
    });
  }
}
