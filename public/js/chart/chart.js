import { rangeBars, renko, lineBreak, kagi, pointFigure, autoSize } from './bar-transforms.js'; // __bar_transforms_integration__
/**
 * Chart: a TradingView-style canvas chart with panes, crosshair, drawing tools
 * and Pine Script overlays.
 */
import {
  THEME,
  PriceScale,
  Viewport,
  niceTicks,
  niceLogTicks,
  timeTicks,
  tickLabelWithTime,
  MONTHS,
} from './scale.js';
import {
  decimalsForBars,
  formatCompact,
  formatDateMedium,
  formatTime,
  tzParts,
} from '../datafeed.js';

const AXIS_W = 66; // right price axis
const TIME_H = 24; // bottom time axis
const PAD_TOP = 8;

let uidCounter = 0;
const uid = (p = 'id') => `${p}_${++uidCounter}_${Math.random().toString(36).slice(2, 6)}`;

export class Chart {
  constructor(container, opts = {}) {
    this.container = container;
    this.id = opts.id || uid('chart');
    this.symbol = opts.symbol || 'AAPL';
    this.interval = opts.interval || '1d';
    this.range = opts.range || '3mo';
    this.bars = [];
    this.meta = {};
    this.timezone = 'America/New_York';

    this.viewport = new Viewport();
    this.priceScale = new PriceScale(opts.scaleMode || 'linear');
    this.chartType = opts.chartType || 'candles';
    this.showVolume = opts.showVolume !== false;
    this.showGrid = opts.showGrid !== false;
    this.logScale = false;
    this.percentScale = false;
    this.autoScale = true;
    this.axisOnLeft = false;

    this.indicators = []; // { id, name, source, result, inputs, paneIndex, style }
    this.drawings = []; // user drawings
    this.alerts = [];
    this.hideDrawings = false;
    this.hideIndicators = false;

    this.crosshair = { x: -1, y: -1, visible: false, index: null, value: null, snappedIndex: null };
    this.pointer = { down: false, mode: null, startX: 0, startY: 0, startLeftIndex: 0, startTop: 0, startBottom: 0 };

    this.activeTool = null;
    this.pendingDrawing = null;
    this.selectedDrawingId = null;
    this.hoverDrawing = null;
    this.dragState = null;

    this.replayMode = false;
    this.replayBarCount = 0;

    this.callbacks = {
      onCrosshairMove: opts.onCrosshairMove || null,
      onViewChange: opts.onViewChange || null,
      onDrawingChange: opts.onDrawingChange || null,
      onContextMenu: opts.onContextMenu || null,
      onLegendClick: opts.onLegendClick || null,
    };

    this._buildDom();
    this._bindEvents();
    this.resize();
  }

  /* ---------------- DOM ---------------- */

  _buildDom() {
    /**
     * The container is the host element provided by the app — typically a
     * `.pane-wrap` div that is itself a CSS grid item. We must NOT put the
     * `.chart-root` class on it because `.chart-root { position: absolute;
     * inset: 0 }` would yank it out of the grid flow and stack every pane
     * on top of every other pane (the multichart layout bug).
     *
     * Instead we build an inner `.chart-root` div that fills its grid cell
     * (`.pane-wrap` has `position: relative` already). All chart surfaces
     * live inside this inner div.
     */
    this.container.classList.remove('chart-root');
    this.container.innerHTML = '';

    this.inner = document.createElement('div');
    this.inner.className = 'chart-root';
    this.container.appendChild(this.inner);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'chart-overlay';
    this.inner.append(this.canvas, this.overlay);

    this.legendEl = document.createElement('div');
    this.legendEl.className = 'chart-legend';
    this.inner.appendChild(this.legendEl);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'chart-status';
    this.inner.appendChild(this.statusEl);

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'chart-tooltip';
    this.tooltipEl.style.display = 'none';
    this.inner.appendChild(this.tooltipEl);

    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
  }

  _bindEvents() {
    const el = this.overlay;

    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    el.addEventListener('pointerleave', () => this._onPointerLeave());
    el.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.callbacks.onContextMenu) {
        this.callbacks.onContextMenu(e, this.hitTest(e.offsetX, e.offsetY));
      }
    });
    el.addEventListener('dblclick', (e) => this._onDoubleClick(e));

    this._onResize = () => this.resize();
    this._ro = new ResizeObserver(this._onResize);
    this._ro.observe(this.container);
  }

  destroy() {
    this._ro?.disconnect();
    this.container.innerHTML = '';
  }

  /* ---------------- geometry ---------------- */

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(10, Math.floor(rect.width));
    this.height = Math.max(10, Math.floor(rect.height));
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.floor(this.width * dpr);
      c.height = Math.floor(this.height * dpr);
      c.style.width = `${this.width}px`;
      c.style.height = `${this.height}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layoutPanes();
    this.render();
  }

  get plotWidth() {
    return Math.max(10, this.width - AXIS_W);
  }

  get plotHeight() {
    return Math.max(10, this.height - TIME_H);
  }

  /** Compute pane rectangles: price, volume, then one per non-overlay indicator. */
  _layoutPanes() {
    const total = this.plotHeight - PAD_TOP;
    const visibleIndicators = this.hideIndicators
      ? []
      : this.indicators.filter((i) => !this._isOverlay(i) && i.visible !== false && (i.pane === undefined || i.pane === null || i.pane > 0));

    const volumeShare = this.showVolume && !this._volumeIsOverlay() ? 0.18 : 0;
    const indShare = visibleIndicators.length ? Math.min(0.55, 0.16 * visibleIndicators.length) : 0;
    const priceShare = Math.max(0.2, 1 - volumeShare - indShare);

    const panes = [];
    let y = PAD_TOP;
    const priceH = Math.max(40, total * priceShare);
    panes.push({ type: 'price', y, h: priceH, top: y, bottom: y + priceH });
    y += priceH + 1;

    if (volumeShare > 0) {
      const h = Math.max(28, total * volumeShare);
      panes.push({ type: 'volume', y, h, top: y, bottom: y + h });
      y += h + 1;
    }

    if (visibleIndicators.length) {
      const each = Math.max(40, (total * indShare) / visibleIndicators.length);
      for (const ind of visibleIndicators) {
        panes.push({ type: 'indicator', y, h: each, top: y, bottom: y + each, indicator: ind });
        y += each + 1;
      }
    }
    this.panes = panes;
    this.pricePane = panes[0];
    this.volumePane = panes.find((p) => p.type === 'volume') || null;
  }

  _volumeIsOverlay() {
    return this.volumeOverlay === true;
  }

  _isOverlay(ind) {
    if (ind.overlay !== undefined) return ind.overlay;
    // A script that failed to compile gets its own pane so the error is visible.
    if (ind.result && ind.result.ok === false) return false;
    // Auto: an indicator that plots in "price-like" units overlays the main pane.
    const result = ind.result;
    if (!result) return true;
    const scale = result.outputs?.scale;
    if (scale === 'left' || scale === 'right') return false;
    const stats = indicatorRange(result);
    if (!stats) return true;
    const priceRange = this._priceRangeOfVisible();
    if (!priceRange || priceRange.max === priceRange.min) return true;
    const tol = (priceRange.max - priceRange.min) * 1.5;
    const inside =
      stats.min >= priceRange.min - tol &&
      stats.max <= priceRange.max + tol &&
      stats.max - stats.min <= (priceRange.max - priceRange.min) * 3;
    return inside;
  }

  /** True when the indicator should render in the main pane. */
  isOverlay(ind) {
    return this._isOverlay(ind);
  }

  _priceRangeOfVisible() {
    const { from, to } = this.visibleRange();
    if (!this.bars.length) return null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = Math.max(0, from); i <= Math.min(this.bars.length - 1, to); i++) {
      const b = this.bars[i];
      if (!b) continue;
      min = Math.min(min, b.l);
      max = Math.max(max, b.h);
    }
    if (min === Infinity) return null;
    return { min, max };
  }

  /* ---------------- data ---------------- */

  // __bar_transforms_integration__ dispatch to the right transform per chartType
  _applyBarTransform(type, rawBars) {
    if (!Array.isArray(rawBars) || rawBars.length === 0) return rawBars || [];
    switch (type) {
      case 'renko':
        return renko(rawBars, this._renkoBrickSize || autoSize(rawBars), { reversal: this._renkoReversal || 2 });
      case 'range':
        return rangeBars(rawBars, this._rangeSize || autoSize(rawBars));
      case 'linebreak':
        return lineBreak(rawBars, this._lineBreakPeriod || 3);
      case 'kagi':
        return kagi(rawBars, this._kagiReversal || autoSize(rawBars));
      case 'pnf':
        return pointFigure(rawBars, this._pnfBoxSize || autoSize(rawBars), this._pnfReversal || 3);
      default:
        return rawBars;
    }
  }

  setData(bars, meta = {}) {
    const previousCount = this.bars.length;
    this._rawBars = bars || [];
    this.bars = this._applyBarTransform(this.chartType, this._rawBars);
    const oldSymbol = this.symbol;
    const newSymbol = meta.symbol || this.symbol || 'UNKNOWN';
    const symbolChanged = newSymbol !== oldSymbol;
    // Instrument descriptors must never leak across a symbol change. The chart's
    // `symbol` field is often updated before new bars arrive, so the merge cannot
    // rely on `symbolChanged` alone - identity fields always come from `meta`.
    const merged = symbolChanged ? { ...meta } : { ...this.meta, ...meta };
    if (meta.symbol) {
      merged.symbol = newSymbol;
      if (meta.description) merged.description = meta.description;
      if (meta.exchange) merged.exchange = meta.exchange;
      if (meta.currency) merged.currency = meta.currency;
      if (meta.instrumentType) merged.instrumentType = meta.instrumentType;
    }
    this.meta = merged;
    this.symbol = newSymbol;
    if (symbolChanged) {
      for (const ind of this.indicators) ind.markDirty?.();
    }
    this.timezone = meta.timezone || this.timezone;
    this.decimals = decimalsForBars(this.bars);
    this.mintick = meta.mintick || Math.pow(10, -this.decimals);
    if (this.priceScale.mode === 'percent' || this.priceScale.mode === 'indexed') {
      this.priceScale.baseValue = this.bars[0]?.c ?? 1;
    }
    if (previousCount === 0 || this.pendingScrollToRight) {
      this.viewport.scrollToRight(this.plotWidth, this.bars.length);
      this.pendingScrollToRight = false;
    }
    this.recomputeIndicators();
    this.render();
  }

  setSymbol(symbol, interval, range) {
    this.symbol = symbol;
    if (interval) this.interval = interval;
    if (range) this.range = range;
  }

  setChartType(type) {
    this.chartType = type;
    if (Array.isArray(this._rawBars) && this._rawBars.length > 0) {
      this.bars = this._applyBarTransform(type, this._rawBars);
    }
    this.render();
  }

  addIndicator(ind) {
    const existing = this.indicators.find((i) => i.key && i.key === ind.key);
    if (existing) return existing;
    const entry = { id: uid('ind'), visible: true, ...ind };
    // Compute once up-front so `result` is available immediately (and so the
    // overlay/pane decision below can rely on it).
    if (!entry.result && typeof entry.compute === 'function') {
      try {
        entry.result = entry.compute(this.bars, this);
      } catch (err) {
        entry.result = { ok: false, error: { message: err.message } };
      }
    }
    // Pine v6: if the indicator's overlay wasn't explicitly set by the
    // caller, read it from the script's declared `indicator(..., overlay=...)`
    // flag, which is stored on the interpreter's scriptFlags after compute().
    if (entry.overlay === undefined && entry.result?.interpreter?.scriptFlags) {
      const sf = entry.result.interpreter.scriptFlags;
      if (sf.overlay !== null && sf.overlay !== undefined) entry.overlay = sf.overlay;
    }
    this.indicators.push(entry);
    this._layoutPanes();
    this.render();
    return entry;
  }

  removeIndicator(idOrKey) {
    const idx = this.indicators.findIndex((i) => i.id === idOrKey || i.key === idOrKey);
    if (idx >= 0) {
      this.indicators.splice(idx, 1);
      this._layoutPanes();
      this.render();
    }
  }

  clearIndicators() {
    this.indicators = [];
    this._layoutPanes();
    this.render();
  }

  getIndicator(id) {
    return this.indicators.find((i) => i.id === id) || null;
  }

  /** Re-run every indicator's compute function against the current bars. */
  recomputeIndicators() {
    for (const ind of this.indicators) {
      if (typeof ind.compute === 'function') {
        try {
          ind.result = ind.compute(this.bars, this);
        } catch (err) {
          ind.result = { ok: false, error: { message: err.message } };
        }
      }
      // Pine v6: keep the overlay flag in sync with the script's declared
      // overlay setting (in case the script changes between runs).
      if (ind.overlay === undefined && ind.result?.interpreter?.scriptFlags) {
        const sf = ind.result.interpreter.scriptFlags;
        if (sf.overlay !== null && sf.overlay !== undefined) ind.overlay = sf.overlay;
      }
    }
  }

  /** Mark an indicator (or all of them) as needing recomputation. */
  markIndicatorDirty(indicator = null) {
    if (indicator) indicator.markDirty?.();
    else for (const ind of this.indicators) ind.markDirty?.();
    this.recomputeIndicators();
    this._layoutPanes();
    this.render();
  }

  visibleRange() {
    const from = Math.max(0, Math.floor(this.viewport.leftIndex) - 1);
    const to = Math.min(this.bars.length - 1, Math.ceil(this.viewport.leftIndex + this.viewport.barsVisible(this.plotWidth)) + 1);
    return { from, to };
  }

  /* ---------------- view control ---------------- */

  resetView() {
    this.viewport.barSpacing = 8;
    this.autoScale = true;
    this.priceScale.mode = this.logScale ? 'log' : this.percentScale ? 'percent' : 'linear';
    this.viewport.scrollToRight(this.plotWidth, this.bars.length);
    this.render();
  }

  /**
   * Pine v6: a context-aware double-click.
   * - On the price axis: re-enable auto-fit just for the price range.
   * - On the time axis: fit content (compresses/expands time so every bar shows).
   * - On the plot area: full reset (price + time).
   * This matches TradingView, where each axis can be reset independently.
   */
  _onDoubleClick(e) {
    const x = e.offsetX;
    const y = e.offsetY;
    const onPriceAxis = x > this.plotWidth && x <= this.width && y <= this.plotHeight && this.pricePane;
    const onTimeAxis = y > this.plotHeight && y <= this.height && x <= this.plotWidth;
    if (onPriceAxis) {
      this.autoScale = true;
      this.render();
      return;
    }
    if (onTimeAxis) {
      this.fitContent();
      return;
    }
    this.resetView();
  }

  fitContent() {
    if (!this.bars.length) return;
    this.viewport.barSpacing = Math.max(this.viewport.minSpacing, this.plotWidth / (this.bars.length + 10));
    this.viewport.scrollToRight(this.plotWidth, this.bars.length);
    this.render();
  }

  zoomIn() {
    const center = this.viewport.leftIndex + this.viewport.barsVisible(this.plotWidth) / 2;
    this.viewport.zoomAt(center, 1.25);
    this.render();
  }

  zoomOut() {
    const center = this.viewport.leftIndex + this.viewport.barsVisible(this.plotWidth) / 2;
    this.viewport.zoomAt(center, 0.8);
    this.render();
  }

  scrollByBars(n) {
    this.viewport.leftIndex += n;
    this.viewport.clamp(this.plotWidth, this.bars.length);
    this.render();
  }

  setLogScale(on) {
    this.logScale = on;
    this.priceScale.mode = on ? 'log' : this.percentScale ? 'percent' : 'linear';
    this.autoScale = true;
    this.render();
  }

  setPercentScale(on) {
    this.percentScale = on;
    this.priceScale.baseValue = this.bars[0]?.c ?? 1;
    this.priceScale.mode = on ? 'percent' : this.logScale ? 'log' : 'linear';
    this.autoScale = true;
    this.render();
  }

  /** Price at a given y pixel inside the price pane. */
  priceAtY(y) {
    const pane = this.pricePane;
    if (!pane) return NaN;
    const ratio = 1 - (y - pane.top) / pane.h;
    return this.priceScale.fromRatio(ratio);
  }

  yAtPrice(price) {
    const pane = this.pricePane;
    if (!pane) return NaN;
    const ratio = this.priceScale.toRatio(price);
    return pane.top + (1 - ratio) * pane.h;
  }

  indexAtX(x) {
    return this.viewport.indexAtX(x, this.plotWidth);
  }

  xAtIndex(i) {
    return this.viewport.xAtIndex(i, this.plotWidth);
  }

  /* ---------------- autoscale ---------------- */

  _autoscale() {
    if (!this.autoScale) return;
    const { from, to } = this.visibleRange();
    if (!this.bars.length) return;
    let min = Infinity;
    let max = -Infinity;
    let hasData = false;
    for (let i = Math.max(0, from); i <= Math.min(this.bars.length - 1, to); i++) {
      const b = this.bars[i];
      if (!b) continue;
      hasData = true;
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
    }
    // Include overlay indicator values so nothing is clipped.
    for (const ind of this.indicators) {
      if (!this._isOverlay(ind) || ind.visible === false || !ind.result?.ok) continue;
      const r = indicatorRange(ind.result, from, to);
      if (!r) continue;
      hasData = true;
      min = Math.min(min, r.min);
      max = Math.max(max, r.max);
    }
    // Include overlay drawings.
    for (const d of this.drawings) {
      if (d.hidden) continue;
      const vals = drawingValues(d);
      for (const v of vals) {
        if (!Number.isFinite(v)) continue;
        hasData = true;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (!hasData) return;
    this.priceScale.fit(min, max, 0.08);
  }

  _autoscalePane(ind, pane) {
    const { from, to } = this.visibleRange();
    const r = indicatorRange(ind.result, from, to, ind.paneScaleMode);
    if (!r) {
      ind._scale = { min: 0, max: 1 };
      return;
    }
    let min = r.min;
    let max = r.max;
    for (const h of ind.result?.outputs?.hlines || []) {
      if (Number.isFinite(h.price)) {
        min = Math.min(min, h.price);
        max = Math.max(max, h.price);
      }
    }
    if (min === max) {
      min -= Math.abs(min) * 0.05 || 1;
      max += Math.abs(max) * 0.05 || 1;
    }
    const pad = (max - min) * 0.12;
    ind._scale = { min: min - pad, max: max + pad };
    void pane;
  }

  /* ---------------- rendering ---------------- */

  render() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    this._layoutPanes();
    this._autoscale();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.bars.length) {
      ctx.fillStyle = THEME.textDim;
      ctx.font = THEME.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.errorMessage || 'No data', this.plotWidth / 2, this.plotHeight / 2);
      this._renderTimeAxis();
      this._renderLegend();
      return;
    }

    // Indicator pane scales must exist before the grid/axis renderers run.
    for (const pane of this.panes) {
      if (pane.type === 'indicator' && pane.indicator) this._autoscalePane(pane.indicator, pane);
    }

    for (const pane of this.panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, pane.y, this.plotWidth, pane.h);
      ctx.clip();
      this._renderGrid(pane);
      ctx.restore();
    }

    this._renderSeasonSeparators();
    this.renderBgColors();

    this._renderPriceSeries(this.pricePane);

    for (const pane of this.panes) {
      if (pane.type === 'volume') this._renderVolume(pane);
      if (pane.type === 'indicator') this._renderIndicatorPane(pane);
    }

    if (!this.hideDrawings) this._renderDrawings();
    this._renderPriceAxis();
    this._renderTimeAxis();
    this._renderWatermark();
    this._renderLegend();
    if (!this.hideIndicators) this._renderOverlayIndicators();

    if (this.crosshair.visible) this._renderCrosshair();
    else this.octx.clearRect(0, 0, this.width, this.height);
  }

  _renderWatermark() {
    const ctx = this.ctx;
    const pane = this.pricePane;
    if (!pane) return;
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.min(64, Math.max(28, pane.h * 0.22))}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.symbol, this.plotWidth / 2, pane.top + pane.h / 2);
    ctx.restore();
  }

  _renderGrid(pane) {
    const ctx = this.ctx;
    if (!this.showGrid) return;
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;

    // Horizontal price lines
    const ticks = this._priceTicks(pane);
    ctx.beginPath();
    for (const t of ticks) {
      const y = Math.round(t.y) + 0.5;
      if (y < pane.top || y > pane.bottom) continue;
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotWidth, y);
    }
    ctx.stroke();

    // Vertical time lines
    const tt = this._timeTicks();
    ctx.beginPath();
    for (const t of tt) {
      const x = Math.round(t.x) + 0.5;
      if (x < 0 || x > this.plotWidth) continue;
      ctx.moveTo(x, pane.top);
      ctx.lineTo(x, pane.bottom);
    }
    ctx.stroke();
  }

  /** Faint separators on day boundaries for intraday charts. */
  _renderSeasonSeparators() {
    const ctx = this.ctx;
    if (!this.bars.length) return;
    const span = this._visibleSpanMs();
    if (span > 20 * 86400000) return;
    const { from, to } = this.visibleRange();
    const pane = this.pricePane;
    if (!pane) return;
    ctx.save();
    ctx.strokeStyle = THEME.gridStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let lastDay = null;
    for (let i = Math.max(0, from); i <= Math.min(this.bars.length - 1, to); i++) {
      const b = this.bars[i];
      if (!b) continue;
      const p = tzParts(b.t, this.timezone);
      const day = `${p.year}-${p.month}-${p.day}`;
      if (lastDay !== null && day !== lastDay) {
        const x = Math.round(this.xAtIndex(i)) + 0.5;
        ctx.moveTo(x, pane.top);
        ctx.lineTo(x, pane.bottom);
      }
      lastDay = day;
    }
    ctx.stroke();
    ctx.restore();
  }

  _priceTicks(pane) {
    const out = [];
    if (!pane) return out;
    const scale = pane.type === 'price' ? this.priceScale : pane._scale;
    if (!scale) return out;
    if (pane.type === 'price') {
      const vals =
        this.priceScale.mode === 'log'
          ? niceLogTicks(this.priceScale.bottom, this.priceScale.top, Math.max(2, Math.floor(pane.h / 60)))
          : niceTicks(this.priceScale.bottom, this.priceScale.top, Math.max(2, Math.floor(pane.h / 60)));
      for (const v of vals) {
        out.push({ value: v, y: pane.top + (1 - this.priceScale.toRatio(v)) * pane.h });
      }
      return out;
    }
    const vals = niceTicks(scale.min, scale.max, Math.max(2, Math.floor(pane.h / 50)));
    for (const v of vals) {
      const ratio = (v - scale.min) / (scale.max - scale.min);
      out.push({ value: v, y: pane.top + (1 - ratio) * pane.h });
    }
    return out;
  }

  _timeTicks() {
    if (!this.bars.length) return [];
    const approx = Math.max(2, Math.floor(this.plotWidth / 90));
    const { from, to } = this.visibleRange();
    const ticks = timeTicks(this.bars, from, to, approx, this.timezone);
    return ticks.map((t) => ({ ...t, x: this.xAtIndex(t.index) }));
  }

  _visibleSpanMs() {
    const { from, to } = this.visibleRange();
    if (!this.bars.length || to <= from) return 86400000;
    return (this.bars[Math.min(to, this.bars.length - 1)].t ?? 0) - (this.bars[Math.max(0, from)].t ?? 0);
  }

  /* ---------------- price series ---------------- */

  _renderPriceSeries(pane) {
    switch (this.chartType) {
      case 'line':
        this._renderLine(pane, false);
        break;
      case 'area':
        this._renderLine(pane, true);
        break;
      case 'bars':
        this._renderBars(pane);
        break;
      case 'hollow':
        this._renderCandles(pane, true);
        break;
      case 'baseline':
        this._renderBaseline(pane);
        break;
      case 'candles':
      default:
        this._renderCandles(pane, false);
        break;
    }
  }

  _visibleIndices(pane) {
    const { from, to } = this.visibleRange();
    return { from: Math.max(0, from), to: Math.min(this.bars.length - 1, to) };
  }

  _renderCandles(pane, hollow) {
    const ctx = this.ctx;
    const { from, to } = this._visibleIndices(pane);
    const spacing = this.viewport.barSpacing;
    const bodyW = Math.max(1, Math.min(spacing * 0.7, 24));
    const wickW = Math.max(1, Math.min(1.5, spacing * 0.12));
    const barColors = this._barColorOverrides();

    for (let i = from; i <= to; i++) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xAtIndex(i);
      if (x < -bodyW || x > this.plotWidth + bodyW) continue;
      const up = b.c >= b.o;
      let color = barColors[i] || (up ? THEME.up : THEME.down);
      const yO = this._y(b.o, pane);
      const yC = this._y(b.c, pane);
      const yH = this._y(b.h, pane);
      const yL = this._y(b.l, pane);
      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));

      if (spacing < 2.2) {
        // Too dense for wicks: draw a single coloured column.
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, h));
        continue;
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = wickW;
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();

      if (hollow) {
        ctx.fillStyle = up ? THEME.bg : color;
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x - bodyW / 2) + 0.5, Math.round(top) + 0.5, Math.max(1, Math.round(bodyW) - 1), Math.max(1, Math.round(h) - 1));
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      }
    }
  }

  _renderBars(pane) {
    const ctx = this.ctx;
    const { from, to } = this._visibleIndices(pane);
    const spacing = this.viewport.barSpacing;
    const color = THEME.text;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const tick = Math.max(2, Math.min(spacing * 0.4, 8));
    for (let i = from; i <= to; i++) {
      const b = this.bars[i];
      if (!b) continue;
      const x = Math.round(this.xAtIndex(i)) + 0.5;
      if (x < -tick || x > this.plotWidth + tick) continue;
      const yH = this._y(b.h, pane);
      const yL = this._y(b.l, pane);
      const yO = this._y(b.o, pane);
      const yC = this._y(b.c, pane);
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.moveTo(x - tick, yO);
      ctx.lineTo(x, yO);
      ctx.moveTo(x, yC);
      ctx.lineTo(x + tick, yC);
    }
    ctx.stroke();
  }

  _renderLine(pane, area) {
    const ctx = this.ctx;
    const { from, to } = this._visibleIndices(pane);
    const color = this.lineColor || THEME.accent;
    ctx.lineWidth = this.lineWidth || 2;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    const pts = [];
    for (let i = from; i <= to; i++) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xAtIndex(i);
      const y = this._y(b.c, pane);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      pts.push([x, y]);
    }
    if (area && pts.length > 1) {
      const grad = ctx.createLinearGradient(0, pane.top, 0, pane.bottom);
      grad.addColorStop(0, hexA(color, 0.35));
      grad.addColorStop(1, hexA(color, 0.02));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pane.bottom);
      for (const [x, y] of pts) ctx.lineTo(x, y);
      ctx.lineTo(pts[pts.length - 1][0], pane.bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      started = false;
      for (const [x, y] of pts) {
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  _renderBaseline(pane) {
    // Split-colour line around the first visible close.
    const { from } = this._visibleIndices(pane);
    const base = this.bars[from]?.c ?? 0;
    this.ctx.save();
    this.ctx.lineWidth = 2;
    for (const [color, test] of [
      [THEME.up, (v) => v >= base],
      [THEME.down, (v) => v < base],
    ]) {
      this.ctx.strokeStyle = color;
      this.ctx.beginPath();
      let started = false;
      for (let i = from; i <= this.bars.length - 1; i++) {
        const b = this.bars[i];
        if (!b) continue;
        const x = this.xAtIndex(i);
        if (x < -10 || x > this.plotWidth + 10) {
          started = false;
          continue;
        }
        const y = this._y(b.c, pane);
        if (!test(b.c)) {
          started = false;
          continue;
        }
        if (!started) {
          this.ctx.moveTo(x, y);
          started = true;
        } else this.ctx.lineTo(x, y);
      }
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  _y(price, pane) {
    const p = pane || this.pricePane;
    const ratio = this.priceScale.toRatio(price);
    return p.top + (1 - ratio) * p.h;
  }

  _barColorOverrides() {
    const out = {};
    for (const ind of this.indicators) {
      if (!ind.result?.ok) continue;
      const bc = ind.result.outputs?.barcolors || [];
      for (const entry of bc) {
        for (let i = 0; i < entry.colors.length; i++) {
          const c = entry.colors[i];
          if (c) out[i] = colorCss(c);
        }
      }
    }
    return out;
  }

  _bgColorOverrides() {
    const out = {};
    for (const ind of this.indicators) {
      if (!ind.result?.ok) continue;
      for (const entry of ind.result.outputs?.bgcolors || []) {
        for (let i = 0; i < entry.colors.length; i++) {
          if (entry.colors[i]) out[i] = entry.colors[i];
        }
      }
    }
    return out;
  }

  _renderVolume(pane) {
    const ctx = this.ctx;
    const { from, to } = this._visibleIndices(pane);
    let maxV = 0;
    for (let i = from; i <= to; i++) {
      maxV = Math.max(maxV, this.bars[i]?.v ?? 0);
    }
    if (!maxV) return;
    const spacing = this.viewport.barSpacing;
    const bodyW = Math.max(1, Math.min(spacing * 0.7, 24));
    for (let i = from; i <= to; i++) {
      const b = this.bars[i];
      if (!b) continue;
      const x = this.xAtIndex(i);
      if (x < -bodyW || x > this.plotWidth + bodyW) continue;
      const h = Math.max(1, (b.v / maxV) * (pane.h - 6));
      const up = b.c >= b.o;
      ctx.fillStyle = hexA(up ? THEME.up : THEME.down, 0.5);
      ctx.fillRect(x - bodyW / 2, pane.bottom - h, bodyW, h);
    }
    // Volume moving average
    const maPeriod = 20;
    if (this.bars.length > maPeriod) {
      ctx.strokeStyle = 'rgba(255,152,0,0.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let sum = 0;
      let started = false;
      for (let i = Math.max(0, from - maPeriod); i <= to; i++) {
        sum += this.bars[i]?.v ?? 0;
        if (i >= maPeriod) sum -= this.bars[i - maPeriod]?.v ?? 0;
        if (i < maPeriod) continue;
        const x = this.xAtIndex(i);
        if (x < -10 || x > this.plotWidth + 10) continue;
        const y = pane.bottom - (sum / maPeriod / maxV) * (pane.h - 6);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  /* ---------------- indicator panes ---------------- */

  _renderIndicatorPane(pane) {
    const ind = pane.indicator;
    if (!ind || !ind.result?.ok) {
      if (ind?.result && !ind.result.ok) {
        this._paneMessage(pane, `⚠ ${ind.result.error?.message || 'script error'}`);
      }
      return;
    }
    this._renderPlots(ind.result, pane, ind);
    this._renderHlines(ind.result, pane);
    this._paneLabel(pane, ind);
  }

  _paneMessage(pane, text) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = THEME.textDim;
    ctx.font = THEME.fontSmall;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text, 8, pane.top + 6);
    ctx.restore();
  }

  _paneLabel(pane, ind) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = THEME.textDim;
    ctx.font = THEME.fontBold;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(ind.name || 'Indicator', 8, pane.top + 5);
    ctx.restore();
  }

  _renderOverlayIndicators() {
    const pane = this.pricePane;
    if (!pane) return;
    for (const ind of this.indicators) {
      if (!ind.visible || !ind.result?.ok) continue;
      if (!this._isOverlay(ind)) continue;
      this._renderPlots(ind.result, pane, ind);
      this._renderHlines(ind.result, pane);
      this._renderDrawingsFromResult(ind.result, pane);
    }
  }

  _renderPlots(result, pane, ind) {
    const ctx = this.ctx;
    const scale = pane.type === 'price' ? this.priceScale : ind._scale;
    const yOf = (v) => {
      if (pane.type === 'price') return this._y(v, pane);
      if (!scale) return pane.bottom;
      const ratio = (v - scale.min) / (scale.max - scale.min || 1);
      return pane.top + (1 - ratio) * pane.h;
    };

    for (const plot of result.outputs.plots || []) {
      if (plot.display === 0) continue;
      const style = plot.style;
      const baseColor = plot.colors.find(Boolean) || defaultPlotColor(plot);
      ctx.lineWidth = Math.max(1, plot.linewidth || 1);
      ctx.strokeStyle = fitColor(baseColor);
      ctx.fillStyle = fitColor(baseColor);

      if (style === 2 || style === 5) {
        // histogram / columns
        const spacing = this.viewport.barSpacing;
        const w = Math.max(1, Math.min(spacing * 0.7, 24));
        const base = Number.isFinite(plot.histbase) ? plot.histbase : 0;
        const yBase = yOf(base);
        for (let i = 0; i < plot.values.length; i++) {
          const v = plot.values[i];
          if (v === null || v === undefined || Number.isNaN(v)) continue;
          const x = this.xAtIndex(i);
          if (x < -w || x > this.plotWidth + w) continue;
          const y = yOf(v);
          const c = plot.colors[i] ? fitColor(plot.colors[i]) : fitColor(baseColor);
          ctx.fillStyle = c;
          ctx.fillRect(x - w / 2, Math.min(y, yBase), w, Math.max(1, Math.abs(y - yBase)));
        }
        continue;
      }

      if (style === 6) {
        // circles
        for (let i = 0; i < plot.values.length; i++) {
          const v = plot.values[i];
          if (v === null || v === undefined || Number.isNaN(v)) continue;
          const x = this.xAtIndex(i);
          if (x < -6 || x > this.plotWidth + 6) continue;
          ctx.beginPath();
          ctx.arc(x, yOf(v), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        continue;
      }

      if (style === 3) {
        // cross marks
        for (let i = 0; i < plot.values.length; i++) {
          const v = plot.values[i];
          if (v === null || v === undefined || Number.isNaN(v)) continue;
          const x = this.xAtIndex(i);
          if (x < -6 || x > this.plotWidth + 6) continue;
          const y = yOf(v);
          ctx.beginPath();
          ctx.moveTo(x - 3, y - 3);
          ctx.lineTo(x + 3, y + 3);
          ctx.moveTo(x + 3, y - 3);
          ctx.lineTo(x - 3, y + 3);
          ctx.stroke();
        }
        continue;
      }

      if (style === 4) {
        // area
        this._strokeSeries(plot, yOf, pane);
        const grad = ctx.createLinearGradient(0, pane.top, 0, pane.bottom);
        grad.addColorStop(0, hexA(fitColor(baseColor), 0.3));
        grad.addColorStop(1, hexA(fitColor(baseColor), 0.02));
        ctx.save();
        ctx.beginPath();
        let started = false;
        let firstX = null;
        let lastX = null;
        for (let i = 0; i < plot.values.length; i++) {
          const v = plot.values[i];
          if (v === null || v === undefined || Number.isNaN(v)) {
            started = false;
            continue;
          }
          const x = this.xAtIndex(i);
          if (x < -20 || x > this.plotWidth + 20) continue;
          const y = yOf(v);
          if (!started) {
            ctx.moveTo(x, pane.bottom);
            ctx.lineTo(x, y);
            firstX = firstX ?? x;
            started = true;
          } else ctx.lineTo(x, y);
          lastX = x;
        }
        if (firstX !== null && lastX !== null) {
          ctx.lineTo(lastX, pane.bottom);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
        ctx.restore();
        continue;
      }

      if (style === 1 || style === 9 || style === 10) {
        // stepline
        this._strokeStepSeries(plot, yOf, style === 9);
        continue;
      }

      if (style === 7 || style === 8) {
        // linebr / areabr (line with breaks) - same as line, breaks are natural
        this._strokeSeries(plot, yOf, pane);
        continue;
      }

      this._strokeSeries(plot, yOf, pane, plot.colors);
    }
  }

  _strokeSeries(plot, yOf, pane, perPointColors) {
    const ctx = this.ctx;
    ctx.beginPath();
    let started = false;
    let lastColor = null;
    const segments = [];
    let current = null;
    for (let i = 0; i < plot.values.length; i++) {
      const v = plot.values[i];
      const x = this.xAtIndex(i);
      if (v === null || v === undefined || Number.isNaN(v)) {
        if (current) {
          segments.push(current);
          current = null;
        }
        started = false;
        continue;
      }
      if (x < -40 || x > this.plotWidth + 40) {
        if (x > this.plotWidth + 40) break;
        started = false;
        continue;
      }
      const y = yOf(v);
      if (!started) {
        current = [[x, y]];
        started = true;
      } else {
        current.push([x, y]);
      }
    }
    if (current) segments.push(current);

    for (const seg of segments) {
      if (seg.length === 1) continue;
      ctx.beginPath();
      ctx.moveTo(seg[0][0], seg[0][1]);
      for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i][0], seg[i][1]);
      ctx.stroke();
    }
    void lastColor;
    void perPointColors;
    void pane;
  }

  _strokeStepSeries(plot, yOf, diamonds) {
    const ctx = this.ctx;
    ctx.beginPath();
    let started = false;
    let prevY = null;
    for (let i = 0; i < plot.values.length; i++) {
      const v = plot.values[i];
      const x = this.xAtIndex(i);
      if (x < -40) continue;
      if (x > this.plotWidth + 40) break;
      if (v === null || v === undefined || Number.isNaN(v)) {
        started = false;
        continue;
      }
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
      prevY = y;
      if (diamonds) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, y - 3);
        ctx.lineTo(x + 3, y);
        ctx.lineTo(x, y + 3);
        ctx.lineTo(x - 3, y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.stroke();
  }

  _renderHlines(result, pane) {
    const ctx = this.ctx;
    const scale = pane.type === 'price' ? this.priceScale : null;
    for (const h of result.outputs.hlines || []) {
      if (!Number.isFinite(h.price)) continue;
      let y;
      if (pane.type === 'price') y = this._y(h.price, pane);
      else {
        const ind = pane.indicator;
        if (!ind?._scale) continue;
        const s = ind._scale;
        y = pane.top + (1 - (h.price - s.min) / (s.max - s.min || 1)) * pane.h;
      }
      if (y < pane.top - 2 || y > pane.bottom + 2) continue;
      ctx.save();
      ctx.strokeStyle = fitColor(h.color);
      ctx.lineWidth = h.linewidth || 1;
      ctx.setLineDash(lineDash(h.linestyle));
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.plotWidth, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();
      if (h.title) {
        ctx.save();
        ctx.fillStyle = fitColor(h.color);
        ctx.font = THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(h.title, 6, y - 2);
        ctx.restore();
      }
    }
    void scale;
  }

  /** Plot shapes / labels / boxes emitted by a Pine script. */
  _renderDrawingsFromResult(result, pane) {
    const ctx = this.ctx;
    const o = result.outputs;

    /**
     * Convert an x coordinate (bar index OR timestamp) to a pixel.
     * Pine v6 drawing objects store their x as either a bar index (when
     * xloc=xloc.bar_index) or a timestamp (when xloc=xloc.bar_time). We
     * detect which by checking the magnitude — timestamps are > 1e12 (ms
     * since epoch) while bar indices are < 1e7. When the x is a timestamp
     * we find the bar whose time is closest to (but <=) it and use that
     * bar's pixel position.
     */
    const xToPixel = (x, xloc) => {
      if (x === null || x === undefined || !Number.isFinite(x)) return NaN;
      if (xloc === 'bar_time' || x > 1e12) {
        // Timestamp — find the bar index whose time is closest to (but <=) x.
        const bars = this.bars;
        if (!bars.length) return NaN;
        let lo = 0, hi = bars.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (bars[mid].t <= x) { found = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        if (found < 0) return NaN;
        // Linear interpolate between the found bar and the next one for
        // sub-bar precision.
        const bar = bars[found];
        const next = bars[found + 1];
        const frac = next ? (x - bar.t) / (next.t - bar.t || 1) : 0;
        return this.xAtIndex(found + frac);
      }
      return this.xAtIndex(x);
    };

    for (const shape of o.shapes || []) {
      const isArrow = shape.style === 'arrow';
      for (let i = 0; i < shape.series.length; i++) {
        if (!shape.series[i]) continue;
        const x = this.xAtIndex(i);
        if (x < -20 || x > this.plotWidth + 20) continue;
        const b = this.bars[i];
        if (!b) continue;
        let y;
        const loc = shape.location || 'abovebar';
        if (isArrow) {
          const v = shape.series[i];
          y = this._y(b.c + (v / 100) * (b.h - b.l || 1), pane);
        } else if (loc === 'belowbar' || loc === 'bottom') {
          y = this._y(b.l, pane) + 12;
        } else if (loc === 'abovebar' || loc === 'top') {
          y = this._y(b.h, pane) - 12;
        } else {
          y = this._y(b.c, pane);
        }
        const color = isArrow
          ? shape.series[i] >= 0
            ? fitColor(shape.colorup)
            : fitColor(shape.colordown)
          : fitColor(shape.color);
        drawMarker(ctx, x, y, isArrow ? (shape.series[i] >= 0 ? 'arrowup' : 'arrowdown') : shape.style, color, shape.size);
        if (shape.text) {
          ctx.fillStyle = fitColor(shape.textcolor);
          ctx.font = THEME.fontSmall;
          ctx.textAlign = 'center';
          ctx.textBaseline = loc === 'belowbar' ? 'top' : 'bottom';
          ctx.fillText(shape.text, x, loc === 'belowbar' ? y + 10 : y - 10);
        }
        if (shape.char) {
          ctx.fillStyle = fitColor(shape.textcolor);
          ctx.font = `bold 12px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(shape.char, x, y);
        }
      }
    }

    // Pine label objects
    for (const label of o.labels || []) {
      const x = xToPixel(label.x, label.xloc);
      if (!Number.isFinite(x)) continue;
      if (x < -200 || x > this.plotWidth + 200) continue;
      const y = Number.isFinite(label.y) ? this._y(label.y, pane) : pane.top + 20;
      drawPineLabel(ctx, x, y, label);
    }

    // Pine line objects
    for (const line of o.lines || []) {
      const x1 = xToPixel(line.x1, line.xloc);
      const x2 = xToPixel(line.x2, line.xloc);
      const y1 = this._y(line.y1, pane);
      const y2 = this._y(line.y2, pane);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      ctx.save();
      ctx.strokeStyle = fitColor(line.color);
      ctx.lineWidth = line.width || 1;
      ctx.setLineDash(lineDash(line.style));
      const [ax, ay, bx, by] = extendLine(x1, y1, x2, y2, line.extend, this.plotWidth, pane);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }

    // Pine box objects
    for (const box of o.boxes || []) {
      const x1 = xToPixel(box.left, box.xloc);
      const x2 = xToPixel(box.right, box.xloc);
      const y1 = this._y(box.top, pane);
      const y2 = this._y(box.bottom, pane);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      const [ax, , bx] = extendRange(x1, x2, box.extend, this.plotWidth);
      ctx.save();
      if (box.bgcolor) {
        ctx.fillStyle = fitColor(box.bgcolor);
        ctx.fillRect(Math.min(ax, bx), Math.min(y1, y2), Math.abs(bx - ax), Math.abs(y2 - y1));
      }
      if (box.border_color && (box.border_width ?? 1) > 0) {
        ctx.strokeStyle = fitColor(box.border_color);
        ctx.lineWidth = box.border_width;
        ctx.setLineDash(lineDash(box.border_style));
        ctx.strokeRect(Math.min(ax, bx), Math.min(y1, y2), Math.abs(bx - ax), Math.abs(y2 - y1));
      }
      ctx.restore();
    }

    // Pine v6 table objects — render on the chart overlay.
    for (const table of o.tables || []) {
      this._renderTable(table, pane);
    }

    // Fills between two plots / hlines
    this._renderFills(result, pane);
  }

  /** Render a Pine v6 table on the chart overlay. */
  _renderTable(table, pane) {
    const ctx = this.ctx;
    const cells = table.cells;
    if (!cells || !cells.size) return;

    // Determine the number of columns and rows.
    let maxCol = 0, maxRow = 0;
    for (const key of cells.keys()) {
      const [c, r] = key.split(',').map(Number);
      maxCol = Math.max(maxCol, c);
      maxRow = Math.max(maxRow, r);
    }
    const cols = maxCol + 1;
    const rows = maxRow + 1;

    // Calculate cell dimensions based on the table's position.
    const fontSize = 11;
    ctx.save();
    ctx.font = `${fontSize}px -apple-system, sans-serif`;

    // Measure each column's max width.
    const colWidths = new Array(cols).fill(0);
    const cellTexts = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = cells.get(`${c},${r}`);
        const text = cell ? String(cell.text ?? '') : '';
        cellTexts.push(text);
        const w = ctx.measureText(text).width + 12;
        colWidths[c] = Math.max(colWidths[c], w);
      }
    }
    const totalW = colWidths.reduce((a, b) => a + b, 0);
    const rowH = fontSize + 8;
    const totalH = rows * rowH;

    // Position the table (default: top-right).
    const pos = table.position || 'top_right';
    let tx, ty;
    if (pos.includes('right')) tx = this.plotWidth - totalW - 10;
    else if (pos.includes('left')) tx = 10;
    else tx = (this.plotWidth - totalW) / 2;
    if (pos.includes('top')) ty = pane.top + 10;
    else if (pos.includes('bottom')) ty = pane.bottom - totalH - 10;
    else ty = (pane.top + pane.bottom - totalH) / 2;

    // Draw table background.
    if (table.bgcolor) {
      ctx.fillStyle = colorCss(table.bgcolor);
      roundRect(ctx, tx - 2, ty - 2, totalW + 4, totalH + 4, 4);
      ctx.fill();
    }

    // Draw cells.
    let cx = tx;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cell = cells.get(`${c},${r}`);
        const text = cell ? String(cell.text ?? '') : '';
        const x = cx;
        const y = ty + r * rowH;
        const w = colWidths[c];
        const h = rowH;

        // Cell background.
        if (cell && cell.bgcolor) {
          ctx.fillStyle = colorCss(cell.bgcolor);
          ctx.fillRect(x, y, w, h);
        }

        // Cell border.
        ctx.strokeStyle = THEME.border;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Cell text.
        if (text) {
          const align = cell?.text_halign || 'center';
          ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = cell ? colorCss(cell.text_color) : THEME.text;
          const textX = align === 'left' ? x + 6 : align === 'right' ? x + w - 6 : x + w / 2;
          ctx.fillText(text, textX, y + h / 2);
        }
      }
      cx += colWidths[c];
    }
    ctx.restore();
  }

  _renderFills(result, pane) {
    const ctx = this.ctx;
    const o = result.outputs;
    const resolvePlot = (ref) => {
      if (!ref) return null;
      if (ref.id) return (o.plots || []).find((p) => p.id === ref.id) || (o.hlines || []).find((h) => h.id === ref.id) || ref;
      return ref;
    };
    for (const fill of o.fills || []) {
      const a = resolvePlot(fill.a);
      const b = resolvePlot(fill.b);
      if (!a) continue;
      const color = fitColor(fill.color);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - (fill.transp || 0) / 100);
      ctx.fillStyle = color;

      if (pane.type === 'price' && a.price !== undefined) {
        // fill between two hlines
        const y1 = this._y(a.price, pane);
        const y2 = b && b.price !== undefined ? this._y(b.price, pane) : pane.bottom;
        ctx.fillRect(0, Math.min(y1, y2), this.plotWidth, Math.abs(y2 - y1));
        ctx.restore();
        continue;
      }

      const av = a.values;
      const bv = b?.values;
      if (!av) {
        ctx.restore();
        continue;
      }
      const yOf = (v) => {
        if (pane.type === 'price') return this._y(v, pane);
        const ind = pane.indicator;
        const s = ind?._scale || { min: 0, max: 1 };
        return pane.top + (1 - (v - s.min) / (s.max - s.min || 1)) * pane.h;
      };
      ctx.beginPath();
      let started = false;
      const upper = [];
      const lower = [];
      for (let i = 0; i < av.length; i++) {
        const v1 = av[i];
        const v2 = bv ? bv[i] : b && b.price !== undefined ? b.price : null;
        if (v1 === null || v1 === undefined || v2 === null || v2 === undefined) continue;
        const x = this.xAtIndex(i);
        if (x < -20 || x > this.plotWidth + 20) continue;
        upper.push([x, yOf(v1)]);
        lower.push([x, yOf(v2)]);
      }
      if (upper.length > 1) {
        ctx.moveTo(upper[0][0], upper[0][1]);
        for (const [x, y] of upper) ctx.lineTo(x, y);
        for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i][0], lower[i][1]);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /** Background colours, drawn under everything. */
  renderBgColors() {
    const overrides = this._bgColorOverrides();
    const ctx = this.ctx;
    const pane = this.pricePane;
    if (!pane) return;
    const spacing = this.viewport.barSpacing;
    for (const key of Object.keys(overrides)) {
      const i = Number(key);
      const x = this.xAtIndex(i);
      if (x < -spacing || x > this.plotWidth + spacing) continue;
      ctx.fillStyle = fitColor(overrides[i]);
      ctx.fillRect(x - spacing / 2, pane.top, Math.max(1, spacing), pane.h);
    }
  }

  /* ---------------- user drawings ---------------- */

  _renderDrawings() {
    for (const d of this.drawings) {
      if (d.hidden) continue;
      this._renderDrawing(d);
    }
    if (this.pendingDrawing) this._renderDrawing(this.pendingDrawing, true);
  }

  _renderDrawing(d, isPending = false) {
    const ctx = this.ctx;
    const pane = this.pricePane;
    if (!pane) return;
    const selected = d.id === this.selectedDrawingId || d.id === this.hoverDrawing;
    const color = d.color || THEME.accent;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = hexA(color, 0.12);
    ctx.lineWidth = selected ? (d.lineWidth || 1) + 1 : d.lineWidth || 1;
    if (isPending) ctx.setLineDash([4, 3]);

    const X = (i) => this.xAtIndex(i);
    const Y = (p) => this._y(p, pane);

    switch (d.type) {
      // __smc_drawings__ SMC + liquidity concept drawings
      case 'order_block_bull':
      case 'order_block_bear': {
        const x1 = X(d.x1);
        const y1 = Y(d.y1);
        const y2 = Y(d.y2 ?? d.y1);
        const isBull = d.type === 'order_block_bull';
        const right = this.plotWidth;
        const top = Math.min(y1, y2);
        const h = Math.abs(y2 - y1);
        ctx.save();
        ctx.fillStyle = isBull ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)';
        ctx.strokeStyle = isBull ? '#26a69a' : '#ef5350';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x1, top, right - x1, h);
        ctx.strokeRect(x1, top, right - x1, h);
        ctx.fillStyle = isBull ? '#26a69a' : '#ef5350';
        ctx.font = 'bold ' + THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(isBull ? 'Bull OB' : 'Bear OB', x1 + 4, top + 4);
        ctx.restore();
        if (selected) { drawHandle(ctx, x1, y1, color); drawHandle(ctx, x1, y2, color); }
        break;
      }
      case 'fvg_bull':
      case 'fvg_bear': {
        const x1 = X(d.x1);
        const x2 = X(d.x2 ?? d.x1);
        const y1 = Y(d.y1);
        const y2 = Y(d.y2 ?? d.y1);
        const isBull = d.type === 'fvg_bull';
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);
        ctx.save();
        ctx.fillStyle = isBull ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';
        ctx.strokeStyle = isBull ? 'rgba(38,166,154,0.6)' : 'rgba(239,83,80,0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.fillRect(left, top, w, h);
        ctx.strokeRect(left, top, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = isBull ? '#26a69a' : '#ef5350';
        ctx.font = 'bold ' + THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(isBull ? 'Bull FVG' : 'Bear FVG', left + 4, top + 4);
        ctx.restore();
        if (selected) { drawHandle(ctx, x1, y1, color); drawHandle(ctx, x2, y2, color); }
        break;
      }
      case 'liquidity_high':
      case 'liquidity_low':
      case 'bos':
      case 'choch': {
        const x1 = X(d.x1);
        const y1 = Y(d.y1);
        const left = Math.min(x1, this.plotWidth);
        const right = this.plotWidth;
        const cfg = {
          liquidity_high: { text: '$$ high', color: '#f9c74f' },
          liquidity_low: { text: '$$ low', color: '#f9c74f' },
          bos: { text: 'BOS', color: '#d1d4dc' },
          choch: { text: 'CHoCH', color: '#d1d4dc' },
        }[d.type];
        ctx.save();
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash((d.type === 'bos' || d.type === 'choch') ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(left, y1);
        ctx.lineTo(right, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = cfg.color;
        ctx.font = 'bold ' + THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = (d.type === 'liquidity_low') ? 'top' : 'bottom';
        const labelY = (d.type === 'liquidity_low') ? y1 + 3 : y1 - 3;
        ctx.fillText(cfg.text, left + 4, labelY);
        ctx.restore();
        if (selected) { drawHandle(ctx, left, y1, color); drawHandle(ctx, right - 4, y1, color); }
        break;
      }
      case 'equal_highs':
      case 'equal_lows': {
        const x1 = X(d.x1);
        const x2 = X(d.x2 ?? d.x1);
        const y1 = Y(d.y1);
        const y2 = Y(d.y2 ?? d.y1);
        ctx.save();
        ctx.strokeStyle = '#f9c74f';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x1 - 12, y1);
        ctx.lineTo(x1 + 12, y1);
        ctx.moveTo(x2 - 12, y2);
        ctx.lineTo(x2 + 12, y2);
        ctx.stroke();
        ctx.fillStyle = '#f9c74f';
        ctx.font = 'bold ' + THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(d.type === 'equal_highs' ? 'EQH' : 'EQL', x1 + 14, y1 - 3);
        ctx.restore();
        if (selected) { drawHandle(ctx, x1, y1, color); drawHandle(ctx, x2, y2, color); }
        break;
      }
      case 'premium_zone':
      case 'discount_zone': {
        const x1 = X(d.x1);
        const x2 = X(d.x2 ?? d.x1);
        const y1 = Y(d.y1);
        const y2 = Y(d.y2 ?? d.y1);
        const isPremium = d.type === 'premium_zone';
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const w = Math.abs(x2 - x1);
        const h = Math.abs(y2 - y1);
        ctx.save();
        ctx.fillStyle = isPremium ? 'rgba(239,83,80,0.10)' : 'rgba(38,166,154,0.10)';
        ctx.strokeStyle = isPremium ? 'rgba(239,83,80,0.55)' : 'rgba(38,166,154,0.55)';
        ctx.lineWidth = 1;
        ctx.fillRect(left, top, w, h);
        ctx.strokeRect(left, top, w, h);
        ctx.fillStyle = isPremium ? '#ef5350' : '#26a69a';
        ctx.font = 'bold ' + THEME.fontSmall;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(isPremium ? 'Premium' : 'Discount', left + 4, top + 4);
        ctx.restore();
        if (selected) { drawHandle(ctx, x1, y1, color); drawHandle(ctx, x2, y2, color); }
        break;
      }

      case 'trendline':
      case 'arrow':
      case 'extended':
      case 'ray':
      case 'hline':
      case 'vline': {
        let x1 = X(d.x1);
        let y1 = Y(d.y1);
        let x2 = X(d.x2 ?? d.x1);
        let y2 = Y(d.y2 ?? d.y1);
        if (d.type === 'hline') {
          ctx.beginPath();
          ctx.moveTo(0, y1);
          ctx.lineTo(this.plotWidth, y1);
          ctx.stroke();
        } else if (d.type === 'vline') {
          // __vline_vertical__ draw vertical line from top to bottom of the plot
          const top = 0;
          const bottom = this.plotHeight || (pane && (pane.plotHeight || pane.height)) || 2000;
          ctx.beginPath();
          ctx.moveTo(x1, top);
          ctx.lineTo(x1, bottom);
          ctx.stroke();
        } else {
          const ext = (d.type === 'ray' || d.type === 'extended') ? 'both' : d.extend || 'none';
          const [ax, ay, bx, by] = extendLine(x1, y1, x2, y2, ext, this.plotWidth, pane);
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
        }
        if (selected) {
          drawHandle(ctx, x1, y1, color);
          if (d.type !== 'hline' && d.type !== 'vline') drawHandle(ctx, x2, y2, color);
        }
        
        // __new_drawing_types__ arrowhead drawing (added)
        if (d.type === 'arrow') {
          const ang = Math.atan2(by - ay, bx - ax);
          const head = 9;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang - Math.PI / 6), by - head * Math.sin(ang - Math.PI / 6));
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - head * Math.cos(ang + Math.PI / 6), by - head * Math.sin(ang + Math.PI / 6));
          ctx.stroke();
        }
      break;
      }
      case 'rect': {
        const x1 = X(d.x1);
        const y1 = Y(d.y1);
        const x2 = X(d.x2);
        const y2 = Y(d.y2);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        if (selected) {
          drawHandle(ctx, x1, y1, color);
          drawHandle(ctx, x2, y2, color);
        }
        break;
      }
      case 'fib': {
        const x1 = X(d.x1);
        const y1 = Y(d.y1);
        const x2 = X(d.x2);
        const y2 = Y(d.y2);
        const levels = d.levels || [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618];
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        ctx.font = THEME.fontSmall;
        ctx.textBaseline = 'middle';
        for (const lv of levels) {
          const y = y1 + (y2 - y1) * lv;
          const inRange = lv >= 0 && lv <= 1;
          ctx.globalAlpha = inRange ? 1 : 0.5;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          const price = d.y1 + (d.y2 - d.y1) * lv;
          const decimals = this.decimals ?? 2;
          ctx.fillStyle = color;
          ctx.textAlign = 'left';
          ctx.fillText(`${(lv * 100).toFixed(1)}%  ${price.toFixed(decimals)}`, left + 4, y - 6);
        }
        ctx.globalAlpha = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (selected) {
          drawHandle(ctx, x1, y1, color);
          drawHandle(ctx, x2, y2, color);
        }
        break;
      }
      case 'text': {
        const x = X(d.x1);
        const y = Y(d.y1);
        ctx.fillStyle = color;
        ctx.font = `${d.fontSize || 12}px -apple-system, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(d.text || 'Text', x + 4, y);
        if (selected) drawHandle(ctx, x, y, color);
        break;
      }
      case 'measure': {
        const x1 = X(d.x1);
        const y1 = Y(d.y1);
        const x2 = X(d.x2);
        const y2 = Y(d.y2);
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.setLineDash([]);
        const diff = d.y2 - d.y1;
        const pct = d.y1 ? (diff / d.y1) * 100 : 0;
        const bars = Math.round((d.x2 - d.x1) || 0);
        const decimals = this.decimals ?? 2;
        const lines = [
          `${diff >= 0 ? '+' : ''}${diff.toFixed(decimals)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
          `${bars} bars`,
        ];
        ctx.font = THEME.fontBold;
        const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
        const bx = Math.min(x1, x2);
        const by = Math.min(y1, y2);
        ctx.fillStyle = THEME.tooltipBg;
        ctx.fillRect(bx, by - 34, w, 32);
        ctx.fillStyle = diff >= 0 ? THEME.up : THEME.down;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(lines[0], bx + 6, by - 30);
        ctx.fillStyle = THEME.textDim;
        ctx.fillText(lines[1], bx + 6, by - 18);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  drawingValues(d) {
    return drawingValues(d);
  }

  /* ---------------- axes ---------------- */

  _renderPriceAxis() {
    const ctx = this.ctx;
    const x0 = this.plotWidth;
    ctx.save();
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(x0, 0, AXIS_W, this.height);
    ctx.strokeStyle = THEME.border;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, 0);
    ctx.lineTo(x0 + 0.5, this.plotHeight);
    ctx.stroke();

    ctx.font = THEME.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (const pane of this.panes) {
      const ticks = this._priceTicks(pane);
      for (const t of ticks) {
        if (t.y < pane.top + 4 || t.y > pane.bottom - 2) continue;
        ctx.fillStyle = THEME.textDim;
        let label;
        if (pane.type === 'price') label = this.priceScale.label(t.value, this.decimals);
        else if (pane.type === 'volume') label = formatCompact(t.value);
        else label = formatAxisValue(t.value, this.decimals);
        ctx.fillText(label, x0 + 8, t.y);
        ctx.strokeStyle = THEME.grid;
        ctx.beginPath();
        ctx.moveTo(x0, Math.round(t.y) + 0.5);
        ctx.lineTo(x0 + 4, Math.round(t.y) + 0.5);
        ctx.stroke();
      }
    }

    // Last price marker
    const last = this.bars[this.lastBarIndex()];
    if (last && this.pricePane) {
      const y = this._y(last.c, this.pricePane);
      const up = last.c >= last.o;
      const label = this.priceScale.label(last.c, this.decimals);
      ctx.fillStyle = up ? THEME.up : THEME.down;
      const w = AXIS_W - 6;
      ctx.fillRect(x0 + 3, y - 9, w, 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = THEME.fontBold;
      ctx.fillText(label, x0 + 8, y);
    }
    ctx.restore();
  }

  _renderTimeAxis() {
    const ctx = this.ctx;
    const y0 = this.plotHeight;
    ctx.save();
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, y0, this.width, TIME_H);
    ctx.strokeStyle = THEME.border;
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(this.width, y0 + 0.5);
    ctx.stroke();

    const span = this._visibleSpanMs();
    ctx.font = THEME.mono;
    ctx.textBaseline = 'middle';
    const ticks = this._timeTicks();
    const sunX = [];
    for (const t of ticks) {
      if (t.x < 8 || t.x > this.plotWidth - 8) continue;
      ctx.fillStyle = THEME.textDim;
      ctx.textAlign = 'left';
      ctx.fillText(tickLabelWithTime(t.time, this.timezone, span), t.x + 3, y0 + TIME_H / 2 + 1);
      sunX.push(t.x);
    }
    // Crosshair time label
    if (this.crosshair.visible && this.crosshair.snappedIndex !== null) {
      const bar = this.bars[this.crosshair.snappedIndex];
      if (bar) {
        const label = `${formatDateMedium(bar.t, this.timezone)}  ${formatTime(bar.t, this.timezone, { withSeconds: this.interval === '1m' })}`;
        ctx.font = THEME.fontBold;
        const w = ctx.measureText(label).width + 12;
        const cx = Math.min(Math.max(this.crosshair.x - w / 2, 2), this.plotWidth - w - 2);
        ctx.fillStyle = THEME.crosshair;
        roundRect(ctx, cx, y0 + 2, w, TIME_H - 4, 3);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(label, cx + 6, y0 + TIME_H / 2 + 1);
      }
    }
    ctx.restore();
    void MONTHS;
  }

  lastBarIndex() {
    if (this.replayMode) return Math.min(this.replayBarCount, this.bars.length) - 1;
    return this.bars.length - 1;
  }

  /* ---------------- legend ---------------- */

  _renderLegend() {
    if (!this.legendEl) return;
    const idx = this.crosshair.visible && this.crosshair.snappedIndex !== null ? this.crosshair.snappedIndex : this.lastBarIndex();
    const b = this.bars[idx];
    if (!b) {
      this.legendEl.innerHTML = '';
      return;
    }
    const prev = this.bars[idx - 1];
    const change = prev ? b.c - prev.c : 0;
    const changePct = prev && prev.c ? (change / prev.c) * 100 : 0;
    const up = change >= 0;
    const d = this.decimals ?? 2;
    const p = tzParts(b.t, this.timezone);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];

    const parts = [];
    parts.push(
      `<span class="lg-symbol">${escapeHtml(this.symbol)}</span>` +
        `<span class="lg-tf">${escapeHtml(intervalLabel(this.interval))}</span>` +
        `<span class="lg-exch">${escapeHtml(this.meta.exchange || '')}</span>`
    );
    const ohlc = [
      ['O', b.o],
      ['H', b.h],
      ['L', b.l],
      ['C', b.c],
    ]
      .map(([k, v]) => `<span class="lg-k">${k}</span><span class="lg-v ${up ? 'up' : 'down'}">${v.toFixed(d)}</span>`)
      .join('');
    parts.push(
      `<span class="lg-ohlc">${ohlc}<span class="lg-v ${up ? 'up' : 'down'}">${up ? '+' : ''}${change.toFixed(d)} (${up ? '+' : ''}${changePct.toFixed(2)}%)</span></span>`
    );
    parts.push(
      `<span class="lg-meta"><span class="lg-v">Vol ${formatCompact(b.v)}</span>` +
        `<span class="lg-v dim">${wd} ${p.day} ${MONTHS[p.month - 1]} '${String(p.year).slice(2)} ${formatTime(b.t, this.timezone)}</span></span>`
    );
    // Indicator rows with remove buttons — each indicator gets a small
    // line in the legend showing its name + a ✕ button that removes it
    // from the chart. The buttons call back to the chart's public
    // `removeIndicator(id)` method, which is also what the Object tree
    // panel's remove action uses.
    if (!this.hideIndicators) {
      for (const ind of this.indicators) {
        if (ind.visible === false) continue;
        const name = escapeHtml(ind.name || 'Indicator');
        // Show the current-bar value of the first plot (if any) so the
        // legend is informative for overlay indicators.
        let val = '';
        if (ind.result?.ok && ind.result.outputs?.plots?.length) {
          const p = ind.result.outputs.plots[0];
          const v = p.values?.[idx];
          if (v != null && !Number.isNaN(v)) val = ` <span class="lg-v dim">${typeof v === 'number' ? v.toFixed(2) : v}</span>`;
        }
        parts.push(
          `<span class="lg-ind" data-ind-id="${ind.id}">${name}${val} <span class="lg-ind-gear" data-gear-id="${ind.id}" title="Settings for ${name}">⚙</span> <span class="lg-ind-remove" data-remove-id="${ind.id}" title="Remove ${name}">×</span></span>`
        );
      }
    }
    this.legendEl.innerHTML = parts.join('');
    // Wire up the remove buttons.
    this.legendEl.querySelectorAll('[data-remove-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-remove-id');
        this.removeIndicator(id);
        if (this.callbacks.onLegendClick) this.callbacks.onLegendClick({ kind: 'remove', id });
      });
    });
    // Wire up the gear (settings) buttons.
    this.legendEl.querySelectorAll('[data-gear-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-gear-id');
        if (this.callbacks.onLegendClick) this.callbacks.onLegendClick({ kind: 'settings', id });
      });
    });
    void this._legendSignature;
  }

  /* ---------------- crosshair ---------------- */

  _renderCrosshair() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.width, this.height);
    const { x, y } = this.crosshair;
    if (!this.crosshair.visible) return;
    const pane = this.panes.find((p) => y >= p.top && y <= p.bottom) || this.pricePane;
    if (!pane) return;

    ctx.save();
    ctx.strokeStyle = THEME.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    if (y >= pane.top && y <= pane.bottom && x <= this.plotWidth) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.plotWidth, Math.round(y) + 0.5);
      ctx.stroke();
    }
    if (x >= 0 && x <= this.plotWidth) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pane.top);
      ctx.lineTo(Math.round(x) + 0.5, pane.bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Value badge on the axis
    if (y >= pane.top && y <= pane.bottom) {
      let label;
      if (pane.type === 'price') label = this.priceScale.label(this.priceAtY(y), this.decimals);
      else if (pane.type === 'volume') label = formatCompact(this._volumeAtY(pane, y));
      else label = formatAxisValue(paneBelowValue(pane, y), this.decimals);
      ctx.font = THEME.fontBold;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = THEME.crosshair;
      roundRect(ctx, this.plotWidth + 3, y - 9, Math.max(w, AXIS_W - 6), 18, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, this.plotWidth + 8, y);
    }

    // OHLC marker dot
    if (this.crosshair.snappedIndex !== null) {
      const b = this.bars[this.crosshair.snappedIndex];
      if (b && x <= this.plotWidth) {
        const yy = this._y(b.c, this.pricePane);
        ctx.beginPath();
        ctx.arc(this.xAtIndex(this.crosshair.snappedIndex), yy, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = THEME.crosshair;
        ctx.fill();
        ctx.strokeStyle = THEME.bg;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _volumeAtY(pane, y) {
    const { from, to } = this._visibleIndices(pane);
    let maxV = 0;
    for (let i = from; i <= to; i++) maxV = Math.max(maxV, this.bars[i]?.v ?? 0);
    return ((pane.bottom - y) / (pane.h - 6)) * maxV;
  }

  /* ---------------- interaction ---------------- */

  _onWheel(e) {
    e.preventDefault();
    const x = e.offsetX;
    const y = e.offsetY;
    if (x > this.plotWidth) {
      // Axis-scale zoom
      if (this.pricePane && y >= this.pricePane.top && y <= this.pricePane.bottom) {
        const anchor = this.priceAtY(y);
        const factor = e.deltaY < 0 ? 0.9 : 1.1;
        const { top, bottom } = this.priceScale;
        this.priceScale.top = anchor + (top - anchor) * factor;
        this.priceScale.bottom = anchor + (bottom - anchor) * factor;
        this.autoScale = false;
        this.render();
      }
      return;
    }
    const index = this.indexAtX(x);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.viewport.zoomAt(index, factor);
    this.viewport.clamp(this.plotWidth, this.bars.length);
    this.autoScale = true;
    this.render();
    this._emitViewChange();
  }

  _onPointerDown(e) {
    this.overlay.setPointerCapture?.(e.pointerId);
    const x = e.offsetX;
    const y = e.offsetY;

    if (this.activeTool && x <= this.plotWidth && y <= this.plotHeight) {
      this._startDrawing(x, y);
      return;
    }

    // Hit-test existing drawings
    const hit = this.hitTest(x, y);
    if (hit && !this.hideDrawings) {
      if (hit.kind === 'drawing') {
        this.selectedDrawingId = hit.drawing.id;
        const d = hit.drawing;
        if (hit.handle) {
          this.dragState = { type: 'handle', drawing: d, handle: hit.handle };
        } else {
          this.dragState = {
            type: 'move',
            drawing: d,
            startX: x,
            startY: y,
            orig: { ...d },
          };
        }
        this.render();
        return;
      }
    }

    /* ---------------- Pine v6 axis-resize behaviour ----------------
     * TradingView lets the user click and drag on the right price axis
     * (vertically) to scale the price range, and on the bottom time axis
     * (horizontally) to compress/expand the time scale. Dragging the very
     * top/bottom edge of the price axis extends just that side; dragging
     * anywhere in the middle scales the whole range around the cursor.
     */

    const onPriceAxis = x > this.plotWidth && x <= this.width && y <= this.plotHeight && this.pricePane;
    const onTimeAxis = y > this.plotHeight && y <= this.height && x <= this.plotWidth;

    if (onPriceAxis && this.pricePane) {
      // Within the price pane's vertical extent -> scale the price range.
      const pane = this.pricePane;
      const edgeZone = Math.max(8, Math.round(pane.h * 0.12)); // top/bottom 12% = "edge"
      const nearTop = y <= pane.top + edgeZone;
      const nearBottom = y >= pane.bottom - edgeZone;
      this.dragState = {
        type: 'price-axis',
        startY: y,
        nearTop,
        nearBottom,
        startTop: this.priceScale.top,
        startBottom: this.priceScale.bottom,
        paneH: pane.h,
        // For the "middle" mode, scale around the cursor; for edge modes,
        // move only one side.
        anchor: this.priceAtY(y),
      };
      this.autoScale = false;
      this.overlay.style.cursor = nearTop || nearBottom ? 'ns-resize' : 'ns-resize';
      return;
    }

    if (onTimeAxis) {
      // Drag on the bottom time axis -> scale the time (bar spacing).
      // Right edge of the time axis extends the right margin; left edge
      // extends the left margin; middle scales around the cursor.
      const edgeZone = Math.max(12, Math.round(this.plotWidth * 0.08));
      const nearLeft = x <= edgeZone;
      const nearRight = x >= this.plotWidth - edgeZone;
      this.dragState = {
        type: 'time-axis',
        startX: x,
        nearLeft,
        nearRight,
        startSpacing: this.viewport.barSpacing,
        startLeftIndex: this.viewport.leftIndex,
        anchorIndex: this.indexAtX(x),
      };
      this.overlay.style.cursor = nearLeft || nearRight ? 'ew-resize' : 'ew-resize';
      return;
    }

    if (y > this.plotHeight) return;
    this.pointer.down = true;
    this.pointer.mode = 'pan';
    this.pointer.startX = x;
    this.pointer.startY = y;
    this.pointer.startLeftIndex = this.viewport.leftIndex;
    // Capture the starting price range so a vertical drag can pan the chart
    // up/down (in price units). TradingView pans the price range vertically
    // when you drag the chart body up/down with the mouse.
    this.pointer.startTop = this.priceScale.top;
    this.pointer.startBottom = this.priceScale.bottom;
    this.pointer.startAutoScale = this.autoScale;
    this.overlay.style.cursor = 'grabbing';
    this.selectedDrawingId = null;
  }

  _onPointerMove(e) {
    const x = e.offsetX;
    const y = e.offsetY;
    this.crosshair.x = x;
    this.crosshair.y = y;
    this.crosshair.visible = x <= this.plotWidth && y <= this.plotHeight;
    const idx = Math.round(this.indexAtX(x));
    this.crosshair.snappedIndex = idx >= 0 && idx < this.bars.length ? idx : null;
    this.crosshair.value = y <= this.plotHeight ? this.priceAtY(y) : null;
    this._updateTooltip(x, y);

    // Pine v6: axis-resize drag in progress
    if (this.dragState && (this.dragState.type === 'price-axis' || this.dragState.type === 'time-axis')) {
      this._dragAxis(x, y);
    } else if (this.dragState) {
      this._dragDrawing(x, y);
    } else if (this.pointer.down && this.pointer.mode === 'pan') {
      const dx = x - this.pointer.startX;
      const dy = y - this.pointer.startY;
      // Horizontal drag scrolls the chart left/right.
      const barDelta = dx / this.viewport.barSpacing;
      this.viewport.leftIndex = this.pointer.startLeftIndex - barDelta;
      this.viewport.clamp(this.plotWidth, this.bars.length);
      // Vertical drag pans the visible price range up/down (TradingView
      // behavior). Drag DOWN moves the range down so higher prices scroll
      // into view at the top; drag UP moves the range up. We translate
      // pixels to price units using the pane's pixels-per-price ratio at
      // drag start, then shift both top and bottom by the same amount so
      // the range width is preserved.
      if (Math.abs(dy) > 1) {
        const pane = this.pricePane;
        if (pane && Number.isFinite(this.pointer.startTop) && Number.isFinite(this.pointer.startBottom)) {
          const rangeH = this.pointer.startTop - this.pointer.startBottom;
          if (rangeH > 0) {
            const pxPerPrice = pane.h / rangeH;
            const priceDelta = dy / pxPerPrice;
            this.priceScale.top = this.pointer.startTop - priceDelta;
            this.priceScale.bottom = this.pointer.startBottom - priceDelta;
            // A manual vertical pan means auto-fit must turn off — otherwise
            // the next render would snap the price range back to fit the
            // visible bars.
            this.autoScale = false;
          }
        }
      }
      this.render();
      this._emitViewChange();
    } else if (this.activeTool && this.pendingDrawing) {
      this._updatePendingDrawing(x, y);
    } else {
      const hit = this.hitTest(x, y);
      const newHover = hit && hit.kind === 'drawing' ? hit.drawing.id : null;
      // Cursor feedback: TradingView shows ns-resize on the price axis and
      // ew-resize on the time axis even before the user clicks, so the user
      // knows the axes are draggable.
      const onPriceAxis = x > this.plotWidth && x <= this.width && y <= this.plotHeight && this.pricePane;
      const onTimeAxis = y > this.plotHeight && y <= this.height && x <= this.plotWidth;
      let cursor = 'default';
      if (onPriceAxis) cursor = 'ns-resize';
      else if (onTimeAxis) cursor = 'ew-resize';
      else if (newHover) cursor = 'move';
      else if (this.activeTool) cursor = 'crosshair';
      if (newHover !== this.hoverDrawing || this.overlay.style.cursor !== cursor) {
        this.hoverDrawing = newHover;
        this.overlay.style.cursor = cursor;
      }
      this.render();
    }

    if (this.callbacks.onCrosshairMove) {
      const bar = this.crosshair.snappedIndex !== null ? this.bars[this.crosshair.snappedIndex] : null;
      this.callbacks.onCrosshairMove({
        chart: this,
        index: this.crosshair.snappedIndex,
        bar,
        price: this.crosshair.value,
        x,
        y,
      });
    }
  }

  /**
   * Drag the price or time axis to scale the chart. TradingView semantics:
   * - Price axis middle: ZOOM around the cursor's price. Drag DOWN zooms
   *   in (the price range shrinks — bars look taller), drag UP zooms out
   *   (the range grows). The cursor's price stays under the cursor.
   * - Price axis top edge: drag UP raises the top (zoom out at the top).
   * - Price axis bottom edge: drag DOWN lowers the bottom (zoom out at the bottom).
   * - Time axis middle: zoom around the cursor (compress/expand).
   * - Time axis left/right edge: shift the visible window left/right.
   */
  _dragAxis(x, y) {
    const st = this.dragState;
    if (st.type === 'price-axis') {
      const dy = y - st.startY;
      const rangeH = st.startTop - st.startBottom;
      if (rangeH <= 0) return;
      if (st.nearTop && !st.nearBottom) {
        // Top edge: drag UP raises the top. Pixels translate to price units
        // at the drag-start pixels-per-price ratio.
        const pxPerPrice = st.paneH / rangeH;
        this.priceScale.top = st.startTop - dy / pxPerPrice;
      } else if (st.nearBottom && !st.nearTop) {
        // Bottom edge: drag DOWN lowers the bottom.
        const pxPerPrice = st.paneH / rangeH;
        this.priceScale.bottom = st.startBottom - dy / pxPerPrice;
      } else {
        // Middle: ZOOM around the cursor's price.
        // Dragging DOWN (dy > 0) zooms in (range shrinks — bars look taller);
        // dragging UP zooms out (range grows). The anchor price stays under
        // the cursor because we scale both ends toward/away from it.
        const anchor = st.anchor;
        // Inverted exponential: dy > 0 → factor < 1 → range shrinks.
        const factor = Math.exp(-dy / 200);
        this.priceScale.top = anchor + (st.startTop - anchor) * factor;
        this.priceScale.bottom = anchor + (st.startBottom - anchor) * factor;
      }
      this.autoScale = false;
      this.render();
      return;
    }

    if (st.type === 'time-axis') {
      const dx = x - st.startX;
      if (st.nearLeft && !st.nearRight) {
        // Left edge: extend/shrink the left margin (changes leftIndex).
        const idx = st.anchorIndex + (dx / st.startSpacing);
        this.viewport.leftIndex = st.startLeftIndex + (idx - st.anchorIndex);
        this.viewport.clamp(this.plotWidth, this.bars.length);
      } else if (st.nearRight && !st.nearLeft) {
        // Right edge: pan the chart (shift the visible window).
        const barDelta = dx / st.startSpacing;
        this.viewport.leftIndex = st.startLeftIndex - barDelta;
        this.viewport.clamp(this.plotWidth, this.bars.length);
      } else {
        // Middle: zoom around the anchor — exponential scale on horizontal drag.
        const factor = Math.exp(dx / 200);
        const newSpacing = Math.max(this.viewport.minSpacing, Math.min(this.viewport.maxSpacing, st.startSpacing * factor));
        if (newSpacing > 0) {
          this.viewport.barSpacing = newSpacing;
          this.viewport.leftIndex = st.anchorIndex - (st.anchorIndex - st.startLeftIndex) * (st.startSpacing / newSpacing);
          this.viewport.clamp(this.plotWidth, this.bars.length);
        }
      }
      this.render();
      this._emitViewChange();
      return;
    }
  }

  _onPointerUp(e) {
    this.overlay.releasePointerCapture?.(e.pointerId);
    if (this.dragState) {
      // Only emit drawing-change events for actual drawing drags; axis
      // drags only affect the price/time scale and don't need to persist
      // any drawing state.
      const wasDrawing = this.dragState.type === 'move' || this.dragState.type === 'handle';
      this.dragState = null;
      if (wasDrawing) this._emitDrawingChange();
    }
    if (this.activeTool && this.pendingDrawing) {
      this._finishDrawing();
    }
    this.pointer.down = false;
    this.pointer.mode = null;
    this.overlay.style.cursor = this.activeTool ? 'crosshair' : 'default';
    this.render();
  }

  _onPointerLeave() {
    this.crosshair.visible = false;
    this.pointer.down = false;
    this.dragState = null;
    this.tooltipEl.style.display = 'none';
    this.render();
    if (this.callbacks.onCrosshairMove) this.callbacks.onCrosshairMove({ chart: this, index: null, bar: null, price: null });
  }

  _updateTooltip(x, y) {
    // Indicator value tooltips are disabled — the user requested that
    // indicator info not be shown at the cursor position.
    this.tooltipEl.style.display = 'none';
  }

  /* ---------------- drawing tools ---------------- */

  setActiveTool(tool) {
    this.activeTool = tool;
    this.pendingDrawing = null;
    this.overlay.style.cursor = tool ? 'crosshair' : 'default';
    this.render();
  }

  _startDrawing(x, y) {
    const type = this.activeTool;
    const index = this.indexAtX(x);
    const price = this.priceAtY(y);
    if (type === 'text') {
      const text = window.prompt('Text', 'Note');
      if (text) {
        this.addDrawing({ type: 'text', x1: index, y1: price, text, color: this.drawColor || THEME.accent });
        this._emitDrawingChange();
      }
      this.setActiveTool(null);
      return;
    }
    this.pendingDrawing = {
      id: uid('dwg'),
      type,
      x1: index,
      y1: price,
      x2: index,
      y2: price,
      color: this.drawColor || THEME.accent,
      lineWidth: 1.5,
    };
    this.render();
  }

  _updatePendingDrawing(x, y) {
    if (!this.pendingDrawing) return;
    const index = this.indexAtX(x);
    const price = this.priceAtY(y);
    this.pendingDrawing.x2 = index;
    this.pendingDrawing.y2 = price;
    this.render();
  }

  _finishDrawing() {
    const d = this.pendingDrawing;
    this.pendingDrawing = null;
    if (!d) return;
    // __smc_single_click__ hline + SMC horizontal types fire on single click
    const singleClickType = d.type === 'hline'
      || d.type === 'liquidity_high'
      || d.type === 'liquidity_low'
      || d.type === 'bos'
      || d.type === 'choch';
    const moved =
      Math.abs((d.x2 ?? d.x1) - d.x1) > 1e-9 || Math.abs((d.y2 ?? d.y1) - d.y1) > 1e-9 || singleClickType;
    if (!moved) {
      this.render();
      return;
    }
    this.addDrawing(d);
    if (this.keepToolActive) {
      // stay in the tool for repeated drawing
    } else {
      this.setActiveTool(null);
    }
    this._emitDrawingChange();
  }

  addDrawing(d) {
    const entry = { id: d.id || uid('dwg'), lineWidth: 1.5, color: THEME.accent, ...d };
    this.drawings.push(entry);
    this.render();
    return entry;
  }

  removeDrawing(id) {
    const i = this.drawings.findIndex((d) => d.id === id);
    if (i >= 0) {
      this.drawings.splice(i, 1);
      this._emitDrawingChange();
      this.render();
    }
  }

  clearDrawings() {
    this.drawings = [];
    this._emitDrawingChange();
    this.render();
  }

  getDrawings() {
    return this.drawings.map((d) => ({ ...d }));
  }

  setDrawings(list) {
    this.drawings = (list || []).map((d) => ({ ...d }));
    this.render();
  }

  /** Hit-test drawings and handles; returns {kind:'drawing', drawing, handle} */
  hitTest(x, y) {
    const pane = this.pricePane;
    if (!pane) return null;
    const tol = 6;
    const X = (i) => this.xAtIndex(i);
    const Y = (p) => this._y(p, pane);
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k];
      if (d.hidden) continue;
      if (d.type === 'hline') {
        if (Math.abs(Y(d.y1) - y) < tol) return { kind: 'drawing', drawing: d, handle: 'p1' };
        continue;
      }
      if (['trendline', 'arrow', 'extended', 'ray', 'rect', 'fib', 'measure', /* __smc_hit__ */ 'order_block_bull', 'order_block_bear', 'fvg_bull', 'fvg_bear', 'liquidity_high', 'liquidity_low', 'bos', 'choch', 'equal_highs', 'equal_lows', 'premium_zone', 'discount_zone'].includes(d.type)) {
        if (Math.hypot(X(d.x1) - x, Y(d.y1) - y) < tol) return { kind: 'drawing', drawing: d, handle: 'p1' };
        if (Math.hypot(X(d.x2) - x, Y(d.y2) - y) < tol) return { kind: 'drawing', drawing: d, handle: 'p2' };
      }
      if (d.type === 'text') {
        if (Math.hypot(X(d.x1) - x, Y(d.y1) - y) < 20) return { kind: 'drawing', drawing: d, handle: 'p1' };
        continue;
      }
      // Body hit test
      const x1 = X(d.x1);
      const y1 = Y(d.y1);
      const x2 = X(d.x2 ?? d.x1);
      const y2 = Y(d.y2 ?? d.y1);
      if (['rect'].includes(d.type)) {
        const inside =
          x >= Math.min(x1, x2) - tol && x <= Math.max(x1, x2) + tol && y >= Math.min(y1, y2) - tol && y <= Math.max(y1, y2) + tol;
        if (inside) return { kind: 'drawing', drawing: d, handle: null };
      } else {
        const dist = pointSegmentDistance(x, y, x1, y1, x2, y2);
        if (dist < tol) return { kind: 'drawing', drawing: d, handle: null };
      }
    }
    return null;
  }

  _dragDrawing(x, y) {
    const st = this.dragState;
    if (!st) return;
    const d = st.drawing;
    const index = this.indexAtX(x);
    const price = this.priceAtY(y);
    if (st.type === 'handle') {
      if (st.handle === 'p1') {
        d.x1 = index;
        d.y1 = price;
        if (d.type === 'hline') d.y2 = price;
      } else {
        d.x2 = index;
        d.y2 = price;
      }
    } else if (st.type === 'move') {
      const dIdx = index - this.indexAtX(st.startX);
      const dPrice = price - this.priceAtY(st.startY);
      for (const key of ['x1', 'x2']) {
        if (typeof st.orig[key] === 'number') d[key] = st.orig[key] + dIdx;
      }
      for (const key of ['y1', 'y2']) {
        if (typeof st.orig[key] === 'number') d[key] = st.orig[key] + dPrice;
      }
    }
    this.render();
  }

  _emitDrawingChange() {
    if (this.callbacks.onDrawingChange) this.callbacks.onDrawingChange(this.getDrawings());
  }

  _emitViewChange() {
    if (this.callbacks.onViewChange) {
      this.callbacks.onViewChange({ from: this.viewport.leftIndex, spacing: this.viewport.barSpacing });
    }
  }

  setReplay(count) {
    this.replayMode = count !== null && count !== undefined;
    this.replayBarCount = count ?? this.bars.length;
    this.render();
  }

  scrollToRealtime() {
    this.viewport.followRight = true;
    this.viewport.scrollToRight(this.plotWidth, this.lastBarIndex() + 1);
    this.render();
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function intervalLabel(id) {
  const map = { '1m': '1', '2m': '2', '5m': '5', '15m': '15', '30m': '30', '60m': '60', '90m': '90', '1d': 'D', '5d': '5D', '1wk': 'W', '1mo': 'M' };
  return map[id] || id;
}

function fitColor(c) {
  if (!c) return THEME.accent;
  return colorCss(c);
}

function colorCss(c) {
  if (!c) return THEME.accent;
  if (typeof c === 'string') return c.startsWith('#') ? c : `#${c}`;
  if (c.__color) {
    const v = c.value;
    const a = Math.max(0, 1 - (c.transparency || 0) / 100);
    const r = parseInt(v.slice(0, 2), 16);
    const g = parseInt(v.slice(2, 4), 16);
    const b = parseInt(v.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return THEME.accent;
}

function hexA(hex, alpha) {
  if (!hex) return `rgba(41,98,255,${alpha})`;
  if (hex.startsWith('rgba')) {
    const m = /rgba?\(([^)]+)\)/.exec(hex);
    if (m) {
      const [r, g, b, a] = m[1].split(',').map((s) => parseFloat(s.trim()));
      return `rgba(${r},${g},${b},${(a ?? 1) * alpha})`;
    }
  }
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function lineDash(style) {
  switch (style) {
    case 'dotted':
      return [1, 3];
    case 'dashed':
      return [6, 4];
    default:
      return [];
  }
}

function defaultPlotColor(plot) {
  const palette = ['#2962ff', '#f23645', '#089981', '#ff9800', '#9c27b0', '#00bcd4', '#e040fb', '#8bc34a'];
  const n = (plot.nodeId || 0) % palette.length;
  return palette[n];
}

function drawHandle(ctx, x, y, color) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = THEME.bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function extendLine(x1, y1, x2, y2, extend, plotWidth, pane) {
  if (!extend || extend === 'none') return [x1, y1, x2, y2];
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return [x1, y1, x2, y2];
  let ax = x1;
  let ay = y1;
  let bx = x2;
  let by = y2;
  const t = (xx) => (xx - x1) / dx;
  if (extend === 'left' || extend === 'both') {
    const tl = t(0);
    ax = 0;
    ay = y1 + dy * tl;
  }
  if (extend === 'right' || extend === 'both') {
    const tr = t(plotWidth);
    bx = plotWidth;
    by = y1 + dy * tr;
  }
  void pane;
  return [ax, ay, bx, by];
}

function extendRange(x1, x2, extend, plotWidth) {
  let a = Math.min(x1, x2);
  let b = Math.max(x1, x2);
  if (extend === 'left' || extend === 'both') a = 0;
  if (extend === 'right' || extend === 'both') b = plotWidth;
  return [a, 0, b];
}

function drawMarker(ctx, x, y, style, color, size) {
  const s = { tiny: 3, small: 4, normal: 6, large: 8, huge: 11, auto: 5 }[size] || 5;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  const dir = style && /down/.test(style) ? 1 : -1;
  switch (style) {
    case 'triangleup':
      ctx.beginPath();
      ctx.moveTo(x, y - s * dir);
      ctx.lineTo(x - s, y + s * dir);
      ctx.lineTo(x + s, y + s * dir);
      ctx.closePath();
      ctx.fill();
      break;
    case 'triangledown':
      ctx.beginPath();
      ctx.moveTo(x, y + s * dir);
      ctx.lineTo(x - s, y - s * dir);
      ctx.lineTo(x + s, y - s * dir);
      ctx.closePath();
      ctx.fill();
      break;
    case 'arrowup':
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.lineTo(x + s, y + s);
      ctx.closePath();
      ctx.fill();
      break;
    case 'arrowdown':
      ctx.beginPath();
      ctx.moveTo(x, y + s);
      ctx.lineTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
      ctx.closePath();
      ctx.fill();
      break;
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      break;
    case 'square':
      ctx.fillRect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
      break;
    case 'xcross':
      ctx.beginPath();
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
      break;
    case 'cross':
      ctx.beginPath();
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.stroke();
      break;
    case 'flag':
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - s * 2);
      ctx.lineTo(x + s * 1.6, y - s * 1.4);
      ctx.lineTo(x, y - s * 0.8);
      ctx.closePath();
      ctx.fill();
      break;
    case 'labelup':
    case 'labeldown': {
      const up = style === 'labelup';
      const w = s * 1.8;
      ctx.beginPath();
      ctx.moveTo(x, up ? y - s * 1.6 : y + s * 1.6);
      ctx.lineTo(x - w, up ? y - s * 0.4 : y + s * 0.4);
      ctx.lineTo(x + w, up ? y - s * 0.4 : y + s * 0.4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    default:
      ctx.beginPath();
      ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}

function drawPineLabel(ctx, x, y, label) {
  const text = String(label.text ?? '');
  const style = String(label.style || 'label_down');
  const up = /up/.test(style);
  const fontSize = { tiny: 9, small: 10, normal: 11, large: 13, huge: 16, auto: 11 }[label.size] || 11;
  ctx.save();
  ctx.font = `${fontSize}px -apple-system, sans-serif`;
  const padX = 6;
  const padY = 4;
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const h = lines.length * (fontSize + 2) + padY * 2;
  const bx = x - w / 2;
  const by = up ? y - h - 6 : y + 6;
  const bg = colorCss(label.color);
  const fg = colorCss(label.textcolor);
  ctx.beginPath();
  roundRect(ctx, bx, by, w, h, 3);
  ctx.fillStyle = bg;
  ctx.fill();
  // pointer triangle
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x - 5, by + h);
    ctx.lineTo(x + 5, by + h);
    ctx.lineTo(x, by + h + 6);
  } else {
    ctx.moveTo(x - 5, by);
    ctx.lineTo(x + 5, by);
    ctx.lineTo(x, by - 6);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, x, by + padY + i * (fontSize + 2)));
  if (label.tooltip) {
    ctx.beginPath();
    ctx.arc(bx + 4, by + 4, 2, 0, Math.PI * 2);
    ctx.fillStyle = fg;
    ctx.fill();
  }
  ctx.restore();
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function formatAxisValue(v, decimals) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  const d = a < 1 ? Math.max(decimals ?? 2, 3) : decimals ?? 2;
  return v.toFixed(d);
}

function paneBelowValue(pane, y) {
  const ind = pane.indicator;
  const s = ind?._scale;
  if (!s) return 0;
  const ratio = 1 - (y - pane.top) / pane.h;
  return s.min + (s.max - s.min) * ratio;
}

/** Numeric extent of every plot in an indicator result. */
function indicatorRange(result, from = 0, to = Infinity) {
  if (!result?.ok) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const plot of result.outputs.plots || []) {
    for (let i = Math.max(0, from); i < Math.min(plot.values.length, to + 1); i++) {
      const v = plot.values[i];
      if (v === null || v === undefined || Number.isNaN(v) || typeof v !== 'number') continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  for (const h of result.outputs.hlines || []) {
    if (Number.isFinite(h.price)) {
      min = Math.min(min, h.price);
      max = Math.max(max, h.price);
    }
  }
  if (min === Infinity) return null;
  return { min, max };
}

/** Values of an indicator's plots at one bar, for the crosshair tooltip. */
function plotValuesAt(result, index) {
  if (!result?.ok || index === null || index === undefined) return [];
  const out = [];
  for (const plot of result.outputs.plots || []) {
    if (plot.display === 0) continue;
    const v = plot.values[index];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const color = plot.colors[index] ? fitColor(plot.colors[index]) : fitColor(plot.colors.find(Boolean) || defaultPlotColor(plot));
    out.push({ title: plot.title, value: typeof v === 'number' ? trimNumber(v) : String(v), color });
  }
  return out;
}

function trimNumber(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(2);
  if (a >= 1) return v.toFixed(3);
  if (a >= 0.001) return v.toFixed(4);
  return v.toPrecision(4);
}

function drawingValues(d) {
  const out = [];
  for (const k of ['y1', 'y2']) if (Number.isFinite(d[k])) out.push(d[k]);
  return out;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export { AXIS_W, TIME_H };
