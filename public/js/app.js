/**
 * tvclone application shell.
 *
 * Wires together the datafeed, the chart engine, the Pine Script engine,
 * the alert manager and all of the surrounding UI.
 */
import { feed, INTERVALS, RANGES, intervalInfo, rangeForBars, formatCompact, formatTime, formatDateMedium, parseCustomTimeframe } from './datafeed.js';
import { Chart } from './chart/chart.js';
import { THEME } from './chart/scale.js';
import { createPineIndicator, clearSecurityCache } from './chart/pine-bridge.js';
import { resolveSourceBars, listAvailableSources } from './chart/source-resolver.js'; // __source_resolver__
import { DEFAULT_INDICATOR_SOURCE, DEFAULT_INDICATOR_NAME } from './pine/default-scripts.js';
import { AlertManager, openAlertDialog, renderAlertsPanel } from './alerts.js';
import { PineEditor, renderScriptLibrary, openTemplatesModal, TEMPLATES } from './editor2.js';
import { computeStats, renderStrategyPane } from './strategy-tester.js';
import { $, $$, el, icon, toast, store, openModal, showContextMenu, hideContextMenu, debounce, throttle, beep, download, escapeHtml } from './ui.js';

/* ================================================================== *
 * Chart types & built-in indicators
 * ================================================================== */

const CHART_TYPES = [
  { id: 'candles', label: 'Candles', icon: 'candle' },
  { id: 'hollow', label: 'Hollow candles', icon: 'hollow' },
  { id: 'bars', label: 'Bars', icon: 'bars' },
  { id: 'line', label: 'Line', icon: 'line' },
  { id: 'area', label: 'Area', icon: 'area' },
  { id: 'baseline', label: 'Baseline', icon: 'line' },
];

/**
 * Available multichart layouts. Each `id` selects one CSS grid configuration
 * for `chartArea[data-layout='<id>']`. The MTF wizard lets the user pick a
 * pane count and then choose between orientations of that count.
 *
 *   - 2 panes: side-by-side (horizontal) or stacked (vertical)
 *   - 3 panes: 1 big top + 2 small bottom, or 2 small top + 1 big bottom
 *   - 4 panes: 2x2 grid
 *   - 6 panes: 3 columns x 2 rows, or 2 columns x 3 rows
 *   - 8 panes: 4 columns x 2 rows, or 2 columns x 4 rows
 */
const LAYOUTS = [
  { id: '1', label: 'Single chart', count: 1 },
  // 2-pane orientations
  { id: '2h', label: '2 horizontal (side by side)', count: 2, group: '2 pane' },
  { id: '2v', label: '2 vertical (stacked)', count: 2, group: '2 pane' },
  // 3-pane orientations
  { id: '3-1t2b', label: '3 panes — 1 top + 2 bottom', count: 3, group: '3 pane' },
  { id: '3-2t1b', label: '3 panes — 2 top + 1 bottom', count: 3, group: '3 pane' },
  // 4-pane orientation
  { id: '4', label: '4 panes — 2 up + 2 down (2x2 grid)', count: 4, group: '4 pane' },
  // 6-pane orientations
  { id: '6-3x2', label: '6 panes — 3 columns x 2 rows', count: 6, group: '6 pane' },
  { id: '6-2x3', label: '6 panes — 2 columns x 3 rows', count: 6, group: '6 pane' },
  // 8-pane orientations
  { id: '8-4x2', label: '8 panes — 4 columns x 2 rows', count: 8, group: '8 pane' },
  { id: '8-2x4', label: '8 panes — 2 columns x 4 rows', count: 8, group: '8 pane' },
];

/** Indicator sources available to built-in indicators. */
const SOURCES = {
  close: (b) => b.c,
  open: (b) => b.o,
  high: (b) => b.h,
  low: (b) => b.l,
  hl2: (b) => (b.h + b.l) / 2,
  hlc3: (b) => (b.h + b.l + b.c) / 3,
  ohlc4: (b) => (b.o + b.h + b.l + b.c) / 4,
};

const BUILTIN_INDICATORS = [
  { key: 'sma', name: 'Simple Moving Average', overlay: true, params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 1 }] },
  { key: 'ema', name: 'Exponential Moving Average', overlay: true, params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 1 }] },
  { key: 'wma', name: 'Weighted Moving Average', overlay: true, params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 1 }] },
  { key: 'bb', name: 'Bollinger Bands', overlay: true, params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 2 }, { key: 'mult', label: 'StdDev', type: 'float', def: 2, min: 0.1, step: 0.1 }] },
  { key: 'vwap', name: 'VWAP (session)', overlay: true, params: [] },
  { key: 'rsi', name: 'Relative Strength Index', overlay: false, params: [{ key: 'length', label: 'Length', type: 'int', def: 14, min: 2 }] },
  { key: 'macd', name: 'MACD', overlay: false, params: [{ key: 'fast', label: 'Fast', type: 'int', def: 12, min: 1 }, { key: 'slow', label: 'Slow', type: 'int', def: 26, min: 2 }, { key: 'signal', label: 'Signal', type: 'int', def: 9, min: 1 }] },
  { key: 'stoch', name: 'Stochastic', overlay: false, params: [{ key: 'k', label: '%K', type: 'int', def: 14, min: 1 }, { key: 'd', label: '%D', type: 'int', def: 3, min: 1 }] },
  { key: 'atr', name: 'Average True Range', overlay: false, params: [{ key: 'length', label: 'Length', type: 'int', def: 14, min: 1 }] },
  { key: 'obv', name: 'On Balance Volume', overlay: false, params: [] },
  { key: 'cci', name: 'Commodity Channel Index', overlay: false, params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 2 }] },
  { key: 'mfi', name: 'Money Flow Index', overlay: false, params: [{ key: 'length', label: 'Length', type: 'int', def: 14, min: 2 }] },
];

/* ================================================================== *
 * Workspace
 * ================================================================== */

class Pane {
  constructor(app, index) {
    this.app = app;
    this.index = index;
    this.wrap = el('div', { class: 'pane-wrap' });
    this.wrap.addEventListener('pointerdown', () => app.setActivePane(this), true);
    app.chartArea.appendChild(this.wrap);
    this.chart = new Chart(this.wrap, {
      id: `pane${index}`,
      symbol: app.state.panes[index]?.symbol || 'AAPL',
      interval: app.state.panes[index]?.interval || '1d',
      chartType: app.state.chartType || 'candles',
      showVolume: app.state.showVolume,
      showGrid: app.state.showGrid,
      onCrosshairMove: (info) => app.onCrosshairMove(this, info),
      onLegendClick: (info) => app.onLegendClick(this, info),
      onViewChange: (info) => app.onPaneViewChange(this, info),
      onDrawingChange: (drawings) => app.persistPaneState(),
      onContextMenu: (e, hit) => app.onChartContextMenu(this, e, hit),
    });
    if (app.state.panes[index]?.drawings) this.chart.setDrawings(app.state.panes[index].drawings);
    this.chart.setActiveTool(app.state.activeTool || null);
    this.loading = false;
    this._buildPaneHeader();
  }

  /**
   * Build a TradingView-style per-pane header with the symbol and a
   * timeframe dropdown. The header floats over the chart's top-right corner
   * so it doesn't take vertical space from the price axis.
   */
  _buildPaneHeader() {
    const app = this.app;
    const header = el('div', { class: 'pane-header' });
    const sym = el('input', {
      class: 'pane-sym-input',
      type: 'text',
      value: this.chart.symbol,
      spellcheck: 'false',
      title: 'Symbol for this pane',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          const v = e.target.value.trim().toUpperCase();
          if (v) app.setPaneSymbol(this, v);
          e.target.blur();
        }
      },
    });
    const tf = el('select', {
      class: 'pane-tf-select',
      onchange: (e) => app.setPaneInterval(this, e.target.value),
    }, INTERVALS.map((i) =>
      el('option', { value: i.id, text: i.id, selected: i.id === this.chart.interval })
    ));
    // Fullscreen toggle: click to expand this pane to fill the entire chart
    // area; click again to restore the multi-pane grid.
    const fs = el('button', {
      class: 'pane-header-btn pane-fs-btn',
      title: 'Expand this pane to full screen (click again to restore)',
      onclick: () => app.togglePaneFullscreen(this),
    }, [icon('fullscreen', 13)]);
    header.append(sym, tf, fs);
    // Update the header when the chart's symbol/interval changes from elsewhere.
    this._updatePaneHeader = () => {
      if (sym.value !== this.chart.symbol) sym.value = this.chart.symbol;
      if (tf.value !== this.chart.interval) tf.value = this.chart.interval;
      // Reflect the fullscreen state on the button so the user knows which
      // pane is currently expanded (and where to click to restore).
      const isFs = app.state.fullscreenPane === this.index;
      fs.classList.toggle('active', isFs);
      fs.title = isFs
        ? 'Restore multi-pane layout'
        : 'Expand this pane to full screen (click again to restore)';
    };
    this.wrap.appendChild(header);
  }

  get symbol() {
    return this.chart.symbol;
  }
  get interval() {
    return this.chart.interval;
  }

  async load({ keepView = false } = {}) {
    const { symbol, interval } = this.chart;
    const range = this.range || this.chart.range || rangeForBars(interval, 600);
    this.wrap.classList.add('loading');
    this.loading = true;
    try {
      const { bars, meta } = await feed.getBars(symbol, interval, range);
      this.range = range;
      this.chart.pendingScrollToRight = !keepView;
      this.chart.setSymbol(symbol, interval, range);
      this.chart.setData(bars, meta);
      this.wrap.classList.remove('loading');
      this.loading = false;
      this.app.updateStatus(`loaded ${bars.length} bars of ${symbol}`);
      // Persist the symbol for this pane.
      this.app.state.panes[this.index] = { ...(this.app.state.panes[this.index] || {}), symbol, interval, range };
      this.app.persistPaneState();
      this.app.refreshLegendExtras();
      this._watchForRealtime();
      return true;
    } catch (err) {
      this.wrap.classList.remove('loading');
      this.loading = false;
      this.chart.errorMessage = `Could not load ${symbol}: ${err.message}`;
      this.chart.bars = [];
      this.chart.render();
      this.app.updateStatus(`error loading ${symbol}: ${err.message}`);
      toast('Data error', `${symbol}: ${err.message}`, 'error');
      return false;
    }
  }

  _watchForRealtime() {
    // Re-fetch the tail periodically while the market is likely open.
    clearInterval(this._rtTimer);
    const seconds = intervalInfo(this.chart.interval).seconds;
    const period = Math.max(15000, Math.min(60000, seconds * 1000 * 0.5));
    this._rtTimer = setInterval(async () => {
      if (document.hidden || this.app.replay.active) return;
      if (this.app.activePane !== this) return;
      try {
        const { bars, meta } = await feed.getBars(this.chart.symbol, this.chart.interval, this.range, { force: true });
        const last = this.chart.bars[this.chart.bars.length - 1];
        const newLast = bars[bars.length - 1];
        if (!last || !newLast || newLast.t !== last.t || newLast.c !== last.c || bars.length !== this.chart.bars.length) {
          this.chart.setData(bars, meta);
          this.app.refreshLegendExtras();
        }
      } catch {
        /* transient */
      }
    }, period);
  }

  destroy() {
    clearInterval(this._rtTimer);
    this.chart.destroy();
    this.wrap.remove();
  }

  setSymbol(symbol) {
    this.chart.symbol = symbol.toUpperCase();
    return this.load();
  }

  setInterval(interval) {
    this.chart.interval = interval;
    this.range = rangeForBars(interval, 600);
    return this.load();
  }
}

class App {
  constructor() {
    this.state = this.loadState();
    this.panes = [];
    this.activePane = null;
    this.replay = { active: false, count: 0, playing: false, speed: 1000, timer: null };
    this.quoteCache = new Map();
    this.scriptAlertCache = new Map();
    this.logs = [];
    this.statusText = 'ready';
    this._quoteRefresh = throttle(() => this.refreshQuotes(), 2500);
  }

  /* ---------------- state ---------------- */

  loadState() {
    const defaults = {
      panes: [{ symbol: 'AAPL', interval: '1d' }],
      layout: '1',
      chartType: 'candles',
      watchlist: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'SPY', 'QQQ', 'BTC-USD'],
      activeTool: null,
      sidebarTab: 'watchlist',
      showVolume: false,
      showGrid: true,
      sidebarOpen: true,
      logScale: false,
      percentScale: false,
      // Pine v6 multi-pane sync settings. Each pane is independent by default,
      // matching TradingView's behaviour: the user can opt in to sync the
      // crosshair, symbol, and/or time range across all panes in a grid.
      sync: { crosshair: true, symbol: false, timeRange: false },
      // Manual price/time axis scaling is on by default so click-and-drag
      // behaves the same way TradingView does out of the box.
      axisManualMode: false,
      // When the user clicks a pane's "fullscreen" button, only that pane
      // fills the chart area; clicking again restores the multi-pane grid.
      // Stored as the pane index, or null when not in fullscreen.
      fullscreenPane: null,
      // Master fullscreen hides the header, sidebars, bottom panel, and
      // makes the chart area fill the entire window.
      masterFullscreen: false,
    };
    const saved = store.get('state', {}) || {};
    const merged = { ...defaults, ...saved };
    merged.panes = Array.isArray(merged.panes) && merged.panes.length ? merged.panes : defaults.panes;
    merged.watchlist = Array.isArray(merged.watchlist) && merged.watchlist.length ? merged.watchlist : defaults.watchlist;
    merged.sync = { ...defaults.sync, ...(saved.sync || {}) };
    // Always start without volume — the user can toggle it on with the
    // Vol toolbar button. This overrides any stale saved state that had
    // showVolume=true from an older session.
    merged.showVolume = false;
    return merged;
  }

  persistState() {
    const panes = this.panes.map((p, i) => ({
      symbol: p.chart.symbol,
      interval: p.chart.interval,
      range: p.range,
      drawings: p.chart.getDrawings(),
      indicators: this.serializeIndicators(p),
    }));
    this.state.panes = panes;
    store.set('state', this.state);
  }

  persistPaneState() {
    this.persistState();
  }

  serializeIndicators(pane) {
    return pane.chart.indicators.map((ind) => ({
      kind: ind.builtinKey ? 'builtin' : 'pine',
      key: ind.builtinKey || null,
      name: ind.name,
      params: ind.builtinParams || null,
      source: ind.source || null,
      inputs: ind.inputs || null,
      overlay: ind.overlay,
      id: ind.id,
      scriptId: ind.scriptId || null,
    }));
  }

  /* ---------------- boot ---------------- */

  async boot() {
    this.bindHeader();
    this.buildLeftRail();
    this.buildToolbar();
    this.buildSidebar();
    this.buildBottomPanel();
    this.buildReplayBar();
    this.bindShortcuts();
    // Wire the floating fullscreen exit button.
    $('#masterFsExit')?.addEventListener('click', () => this.toggleFullscreen());

    this.alertManager = new AlertManager({
      onLog: (level, msg) => this.log(level, msg),
      onFire: () => this.renderAlerts(),
    });
    this.alertManager.start(() => this.alertContext(), 5000);
    window.addEventListener('alerts:changed', () => this.renderAlerts());

    this.applyLayout(this.state.layout, { restore: true });
    // Restore the master fullscreen state if it was saved.
    if (this.state.masterFullscreen) {
      document.body.classList.add('master-fullscreen');
    }
    // If a previous session was saved with a pane in fullscreen, re-apply it.
    if (this.state.fullscreenPane != null) this.applyFullscreenState();
    await this.loadAllPanes();

    feed.subscribeQuotes((quotes) => {
      for (const q of quotes) this.quoteCache.set(q.symbol, q);
      this.renderWatchlist();
      this.renderDataWindow();
    });
    this.refreshQuotes();

    window.addEventListener('feed:status', (e) => this.setFeedStatus(e.detail.online));
    window.addEventListener('pine:log', (e) => this.log(e.detail.level, e.detail.message));
    window.addEventListener('resize', () => this.renderWatchlist());

    this.renderWatchlist();
    this.renderAlerts();
    this.loadNews();
    this.updateStatus('ready');
    this.log('info', 'tvclone ready. Data: Yahoo Finance via local proxy.');
  }

  /* ---------------- panes & layout ---------------- */

  applyLayout(layoutId, { restore = false } = {}) {
    const layout = LAYOUTS.find((l) => l.id === layoutId) || LAYOUTS[0];
    this.state.layout = layout.id;
    // Switching to a new layout invalidates any fullscreen state — the pane
    // index that was fullscreen may no longer exist or may be at a different
    // position in the grid.
    this.state.fullscreenPane = null;
    this.chartArea = $('#chartArea');
    this.chartArea.dataset.layout = layout.id;

    // Reuse or create panes
    while (this.panes.length < layout.count) {
      const pane = new Pane(this, this.panes.length);
      this.panes.push(pane);
      // Copy the active pane's symbol to new panes for convenience.
      if (this.panes.length > 1 && this.activePane) {
        pane.chart.symbol = this.activePane.chart.symbol;
        pane.chart.interval = this.activePane.chart.interval;
      }
    }
    while (this.panes.length > layout.count) {
      const pane = this.panes.pop();
      pane.destroy();
    }
    this.panes.forEach((p, i) => {
      p.wrap.classList.toggle('hidden', false);
      p.index = i;
      p.wrap.dataset.index = String(i);
    });
    for (let i = layout.count; i < LAYOUTS[LAYOUTS.length - 1].count; i++) {
      void i;
    }
    this.setActivePane(this.panes[Math.min(this.activePane ? this.panes.indexOf(this.activePane) : 0, this.panes.length - 1)]);
    store.set('state', this.state);
    if (!restore) {
      this.loadAllPanes();
    }
    setTimeout(() => this.panes.forEach((p) => p.chart.resize()), 30);
  }

  async loadAllPanes() {
    await Promise.all(
      this.panes.map(async (p) => {
        // Restore saved indicators & drawings for the pane on first load only.
        if (!p._restored) {
          p._restored = true;
        }
        await p.load({ keepView: false });
        // After bars are loaded, add the default indicator if the pane has
        // no saved indicators. (Must be after p.load() so bars exist for
        // the indicator's compute() call.)
        if (p._restored && !p._defaultChecked) {
          p._defaultChecked = true;
          const saved = this.state.panes[p.index];
          if (saved?.indicators?.length) this.restoreIndicators(p, saved.indicators);
          else if (p.index === 0) this.addDefaultIndicator(p);
        }
      })
    );
    this.renderToolbarState();
    this.renderDataWindow();
  }

  /**
   * Auto-attach the "Normalised T3 Oscillator" Pine indicator to a pane that
   * has no saved indicators. This runs on first load (or when the user
   * clears all indicators from a pane and reloads). The indicator has
   * overlay=false so it renders in its own pane below the price chart.
   */
  addDefaultIndicator(pane) {
    if (!pane || !pane.chart || !pane.chart.bars.length) return;
    try {
      const ind = createPineIndicator({
        id: `default_indicator_${Date.now()}`,
        name: DEFAULT_INDICATOR_NAME,
        source: DEFAULT_INDICATOR_SOURCE,
        inputs: {},
        feed,
        onUpdate: () => {
          pane.chart.recomputeIndicators();
          pane.chart._layoutPanes();
          pane.chart.render();
          this.renderStrategy();
          this.refreshScriptAlerts(pane);
        },
      });
      pane.chart.addIndicator(ind);
      pane.chart.recomputeIndicators();
      pane.chart._layoutPanes();
      pane.chart.render();
      this.renderIndicatorSettings();
      this.renderStrategy();
      this.refreshScriptAlerts(pane);
      this.persistState();
    } catch (err) {
      console.warn('Default indicator failed to load:', err.message);
    }
  }

  setActivePane(pane) {
    if (!pane) return;
    this.activePane = pane;
    for (const p of this.panes) {
      p.wrap.classList.toggle('active', p === pane);
      if (p._updatePaneHeader) p._updatePaneHeader();
    }
    this.renderToolbarState();
    this.renderSidebarState();
    this.renderStrategy();
    this.renderDataWindow();
  }

  get activeIndex() {
    return this.activePane ? this.panes.indexOf(this.activePane) : 0;
  }

  /* ---------------- header ---------------- */

  bindHeader() {
    const input = $('#symbolInput');
    const results = $('#searchResults');
    let items = [];
    let activeIdx = -1;

    const closeResults = () => {
      results.classList.remove('open');
      activeIdx = -1;
    };

    const render = () => {
      results.innerHTML = '';
      if (!items.length) {
        closeResults();
        return;
      }
      items.forEach((q, i) => {
        const node = el('div', { class: `search-item ${i === activeIdx ? 'active' : ''}` }, [
          el('span', { class: 'sym', text: q.symbol }),
          el('span', { class: 'nm', text: q.name || '' }),
          el('span', { class: 'ex', text: q.exchange || q.type || '' }),
        ]);
        node.addEventListener('mousedown', (e) => {
          e.preventDefault();
          choose(q.symbol);
        });
        results.appendChild(node);
      });
      results.classList.add('open');
    };

    const choose = (symbol) => {
      input.value = '';
      closeResults();
      this.setSymbol(symbol);
      input.blur();
    };

    const search = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 1) {
        items = [];
        closeResults();
        return;
      }
      items = await feed.search(q);
      // Let an exact ticker match float to the top.
      items.sort((a, b) => (a.symbol === q.toUpperCase() ? -1 : b.symbol === q.toUpperCase() ? 1 : 0));
      activeIdx = items.length ? 0 : -1;
      render();
    }, 180);

    input.addEventListener('input', search);
    input.addEventListener('focus', () => {
      if (items.length) render();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(items.length - 1, activeIdx + 1);
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(0, activeIdx - 1);
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIdx >= 0 && items[activeIdx]) choose(items[activeIdx].symbol);
        else if (input.value.trim()) choose(input.value.trim().toUpperCase());
      } else if (e.key === 'Escape') {
        closeResults();
        input.blur();
      }
    });
    document.addEventListener('click', (e) => {
      if (!$('#symbolSearch').contains(e.target)) closeResults();
    });

    // Interval buttons
    const group = $('#intervalGroup');
    for (const iv of INTERVALS) {
      group.appendChild(
        el('button', {
          class: 'btn',
          dataset: { interval: iv.id },
          text: iv.label,
          onclick: () => this.setInterval(iv.id),
        })
      );
    }

    $('#btnChartType').addEventListener('click', (e) => this.openChartTypeMenu(e));
    $('#btnIndicators').addEventListener('click', () => this.openIndicatorDialog());
    $('#btnPine').addEventListener('click', () => this.openBottom('editor'));
    $('#btnAlert').addEventListener('click', () => this.createAlert());
    $('#btnReplay').addEventListener('click', () => this.toggleReplay());
  }

  setSymbol(symbol) {
    if (!this.activePane) return;
    this.activePane.chart.symbol = symbol.toUpperCase();
    clearSecurityCache();
    this.activePane.chart.indicators = this.activePane.chart.indicators.map((ind) => ({ ...ind, result: null }));
    this.activePane.load().then(() => {
      this.renderToolbarState();
      this.loadingNews = false;
    });
    // Pine v6 multi-pane sync: push the new symbol to every other pane when
    // sync.symbol is on, so an MTF layout stays on the same symbol.
    if (this.state.sync.symbol) this._broadcastSymbol(this.activePane);
    this.renderWatchlist();
  }

  setInterval(interval) {
    if (!this.activePane) return;
    if (interval === '__custom__') {
      const current = this.activePane.chart.interval || '1d';
      const input = prompt('Enter timeframe (e.g. 15m, 90m, 1h, 1d, 1w, 1mo, 3mo):', current);
      if (!input) return;
      const parsed = parseCustomTimeframe(input);
      if (!parsed.ok) { alert(parsed.error); return; }
      interval = parsed.id;
    }
    this.activePane.setInterval(interval).then(() => this.renderToolbarState());
    this.renderToolbarState();
  }

  openChartTypeMenu(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      CHART_TYPES.map((t) => ({
        label: t.label,
        icon: t.icon,
        onClick: () => {
          this.state.chartType = t.id;
          for (const p of this.panes) p.chart.setChartType(t.id);
          store.set('state', this.state);
          this.renderToolbarState();
        },
      }))
    );
  }

  /* ---------------- left rail ---------------- */

  buildLeftRail() {
    const rail = $('#leftRail');
    rail.innerHTML = '';

    const tools = [
      { id: 'cursor', icon: 'eye', title: 'Crosshair (Esc)' },
      { sep: true },
      { id: 'trendline', icon: 'trend', title: 'Trend line' },
      { id: 'hline', icon: 'hline', title: 'Horizontal line' },
      { id: 'ray', icon: 'trend', title: 'Ray' },
      { id: 'rect', icon: 'rect', title: 'Rectangle' },
      { id: 'fib', icon: 'fib', title: 'Fib retracement' },
      { id: 'text', icon: 'text', title: 'Text' },
      { id: 'measure', icon: 'measure', title: 'Measure' },
      { sep: true },
      { id: '__erase', icon: 'eraser', title: 'Remove last drawing' },
      { id: '__clear', icon: 'trash', title: 'Clear all drawings' },
      { sep: true },
      { id: '__hideDraw', icon: 'eye-off', title: 'Hide / show drawings' },
    ];

    this.railButtons = {};
    // __rail_extra_tools__ add arrow/extended/vline to the rail
    const _extraTools = [
      { id: 'arrow',    icon: 'trendline', title: 'Arrow',            sep: false },
      { id: 'extended', icon: 'trendline', title: 'Extended trendline', sep: false },
      { id: 'vline',    icon: 'trendline', title: 'Vertical line',    sep: false },
    ];
    for (const t of tools.concat(_extraTools)) {
      if (t.sep) {
        rail.appendChild(el('div', { style: { width: '24px', height: '1px', background: 'var(--border)', margin: '3px 0' } }));
        continue;
      }
      const btn = el('div', { class: 'rail-btn', title: t.title }, [icon(t.icon, 18)]);
      btn.addEventListener('click', () => this.onRailClick(t.id, btn));
      rail.appendChild(btn);
      this.railButtons[t.id] = btn;
    }
    this.updateRailState();
  }

  onRailClick(id, btn) {
    const chart = this.activePane?.chart;
    if (!chart) return;
    if (id === '__erase') {
      const last = chart.drawings[chart.drawings.length - 1];
      if (last) chart.removeDrawing(last.id);
      else toast('Nothing to remove', 'No drawings on this chart.', 'info', 2200);
      return;
    }
    if (id === '__clear') {
      if (chart.drawings.length && window.confirm(`Remove all ${chart.drawings.length} drawings?`)) chart.clearDrawings();
      return;
    }
    if (id === '__hideDraw') {
      chart.hideDrawings = !chart.hideDrawings;
      chart.render();
      this.updateRailState();
      return;
    }
    if (id === 'cursor') {
      this.state.activeTool = null;
      for (const p of this.panes) p.chart.setActiveTool(null);
    } else {
      const next = this.state.activeTool === id ? null : id;
      this.state.activeTool = next;
      for (const p of this.panes) p.chart.setActiveTool(next);
    }
    void btn;
    store.set('state', this.state);
    this.updateRailState();
  }

  updateRailState() {
    if (!this.railButtons) return;
    for (const [id, btn] of Object.entries(this.railButtons)) {
      if (id.startsWith('__')) continue;
      btn.classList.toggle('active', (this.state.activeTool || null) === id || (id === 'cursor' && !this.state.activeTool));
    }
    const chart = this.activePane?.chart;
    if (this.railButtons['__hideDraw']) {
      this.railButtons['__hideDraw'].classList.toggle('active', !!chart?.hideDrawings);
    }
  }

  /* ---------------- chart toolbar ---------------- */

  buildToolbar() {
    const bar = $('#chartToolbar');
    bar.innerHTML = '';

    const group = (children) => el('div', { class: 'btn-group' }, children);

    // Range buttons
    for (const r of RANGES) {
      bar.appendChild(
        el('button', {
          class: 'btn',
          dataset: { range: r.id },
          text: r.label,
          onclick: () => this.setRange(r.id),
        })
      );
    }

    bar.append(
      el('div', { class: 'sep' }),
      el('button', { class: 'btn icon', title: 'Zoom in', html: '', onclick: () => this.activePane?.chart.zoomIn() }, [icon('plus', 15)]),
      el('button', {
        class: 'btn sm',
        title: 'Zoom out',
        text: '−',
        style: { fontSize: '16px', padding: '0 7px' },
        onclick: () => this.activePane?.chart.zoomOut(),
      }),
      el('button', { class: 'btn sm', title: 'Fit content', text: 'Fit', onclick: () => this.activePane?.chart.fitContent() }),
      el('div', { class: 'sep' }),
      group([
        el('button', { class: 'btn', id: 'tbLog', text: 'log', title: 'Logarithmic scale', onclick: () => this.toggleScale('log') }),
        el('button', { class: 'btn', id: 'tbPct', text: '%', title: 'Percent scale', onclick: () => this.toggleScale('percent') }),
        el('button', { class: 'btn', id: 'tbAuto', text: 'auto', title: 'Auto scale', onclick: () => this.toggleScale('auto') }),
      ]),
      el('div', { class: 'sep' }),
      group([
        el('button', { class: 'btn', id: 'tbVolume', text: 'Vol', title: 'Toggle volume', onclick: () => this.toggleVolume() }),
        el('button', { class: 'btn', id: 'tbGrid', text: 'Grid', title: 'Toggle grid', onclick: () => this.toggleGrid() }),
      ]),
      el('div', { class: 'sep' }),
      el('button', { class: 'btn', id: 'tbMTF', title: 'Multi-timeframe layout (click again to return to single chart)', onclick: () => this.toggleMTF() }, [icon('layout', 14), el('span', { text: 'MTF' })]),
      el('div', { class: 'sep' }),
      group([
        el('button', { class: 'btn', id: 'tbSyncCross', text: '↔', title: 'Sync crosshair across panes', onclick: () => this.toggleSync('crosshair') }),
        el('button', { class: 'btn', id: 'tbSyncSym', text: 'SYM', title: 'Sync symbol across panes', onclick: () => this.toggleSync('symbol') }),
        el('button', { class: 'btn', id: 'tbSyncTime', text: 'T', title: 'Sync time range across panes', onclick: () => this.toggleSync('timeRange') }),
        el('button', { class: 'btn', id: 'tbAxisManual', text: 'M/A', title: 'Toggle manual / auto axis scale (drag the price or time axis to scale)', onclick: () => this.toggleAxisManual() }),
      ]),
      el('div', { class: 'sep' }),
      el('button', { class: 'btn', title: 'Indicators', onclick: () => this.openIndicatorDialog() }, [icon('indicator', 15), el('span', { text: 'fx' })]),
      el('button', { class: 'btn icon', title: 'Screenshot', onclick: () => this.screenshot() }, [icon('camera', 16)]),
      el('button', { class: 'btn icon', title: 'Export bars as CSV', onclick: () => this.exportCsv() }, [icon('download', 16)]),
      el('button', { class: 'btn icon', title: 'Chart settings', onclick: () => this.openSettingsDialog() }, [icon('settings', 16)]),
      el('button', { class: 'btn', id: 'tbFullscreen', title: 'Fullscreen — hide all panels and fill the screen with charts (press F)', onclick: () => this.toggleFullscreen() }, [icon('fullscreen', 14)])
    );
    this.renderToolbarState();
  }

  renderToolbarState() {
    const pane = this.activePane;
    if (!pane) return;
    const chart = pane.chart;
    const set = (sel, active) => {
      const node = $(sel);
      if (node) node.classList.toggle('active', !!active);
    };
    $$('#intervalGroup .btn').forEach((b) => b.classList.toggle('active', b.dataset.interval === chart.interval));
    $$('#chartToolbar [data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === pane.range));
    set('#tbLog', chart.logScale);
    set('#tbPct', chart.percentScale);
    set('#tbAuto', chart.autoScale);
    set('#tbVolume', chart.showVolume);
    set('#tbGrid', chart.showGrid);
    // Highlight the MTF button when a multi-pane layout is active.
    set('#tbMTF', this.state.layout !== '1');
    // Highlight the fullscreen button when master fullscreen is active.
    set('#tbFullscreen', this.state.masterFullscreen);
    // Pine v6 multi-pane sync toggles reflect the saved sync settings.
    set('#tbSyncCross', this.state.sync.crosshair);
    set('#tbSyncSym', this.state.sync.symbol);
    set('#tbSyncTime', this.state.sync.timeRange);
    // Manual / auto axis mode toggle.
    set('#tbAxisManual', !!this.state.axisManualMode);
  }

  setRange(range) {
    const pane = this.activePane;
    if (!pane) return;
    pane.range = range;
    pane.load({ keepView: false }).then(() => this.renderToolbarState());
    this.renderToolbarState();
  }

  toggleScale(kind) {
    const chart = this.activePane?.chart;
    if (!chart) return;
    if (kind === 'log') chart.setLogScale(!chart.logScale);
    else if (kind === 'percent') chart.setPercentScale(!chart.percentScale);
    else chart.autoScale = !chart.autoScale;
    if (kind !== 'auto') {
      this.state.logScale = chart.logScale;
      this.state.percentScale = chart.percentScale;
    }
    chart.render();
    this.renderToolbarState();
    store.set('state', this.state);
  }

  toggleVolume() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    chart.showVolume = !chart.showVolume;
    this.state.showVolume = chart.showVolume;
    chart._layoutPanes();
    chart.render();
    this.renderToolbarState();
    store.set('state', this.state);
  }

  toggleGrid() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    chart.showGrid = !chart.showGrid;
    this.state.showGrid = chart.showGrid;
    chart.render();
    this.renderToolbarState();
    store.set('state', this.state);
  }

  /* ---------------- Pine v6 multi-pane sync ---------------- */

  /**
   * Toggle one of the cross-pane sync settings (crosshair / symbol / timeRange).
   * Each is independent; the crosshair sync is on by default to match
   * TradingView's behaviour where moving the cursor on one pane shows the
   * same-time crosshair on every other pane.
   */
  toggleSync(kind) {
    this.state.sync[kind] = !this.state.sync[kind];
    store.set('state', this.state);
    this.renderToolbarState();
    if (kind === 'symbol' && this.state.sync.symbol) {
      // Pull every pane to the active pane's symbol immediately.
      const sym = this.activePane?.chart.symbol;
      if (sym) for (const p of this.panes) if (p !== this.activePane) p.setSymbol(sym);
    }
    if (kind === 'timeRange' && this.state.sync.timeRange) {
      // Mirror the active pane's view onto every other pane.
      this._broadcastView(this.activePane);
    }
    if (kind === 'crosshair' && !this.state.sync.crosshair) {
      // Clear every other pane's crosshair when sync is turned off.
      for (const p of this.panes) if (p !== this.activePane) {
        p.chart.crosshair.visible = false;
        p.chart.render();
      }
    }
  }

  /**
   * Toggle manual / auto axis scale. In manual mode, dragging the right price
   * axis vertically scales the price range and dragging the bottom time axis
   * horizontally compresses/expands the time scale — TradingView style. In
   * auto mode, the price scale auto-fits every render (current behaviour).
   */
  toggleAxisManual() {
    this.state.axisManualMode = !this.state.axisManualMode;
    store.set('state', this.state);
    for (const p of this.panes) {
      p.chart.autoScale = !this.state.axisManualMode;
      p.chart.render();
    }
    this.renderToolbarState();
  }

  /* ---------------- master fullscreen ---------------- */

  /**
   * Toggle "master fullscreen" — hides the app header, left rail, right
   * sidebar, bottom panel, and replay bar, making the chart area fill the
   * entire window. Click again (or press F / Esc) to restore the normal
   * layout. The toolbar button stays visible as a floating overlay so you
   * can exit fullscreen without a keyboard shortcut.
   */
  toggleFullscreen() {
    this.state.masterFullscreen = !this.state.masterFullscreen;
    store.set('state', this.state);
    document.body.classList.toggle('master-fullscreen', this.state.masterFullscreen);
    this.renderToolbarState();
    // Force a DOM reflow so the CSS changes take effect before we measure
    // the chart containers.
    void document.body.offsetHeight;
    // Resize all charts after the layout settles. We use multiple delays
    // because the CSS transition + reflow timing varies across browsers.
    requestAnimationFrame(() => {
      this.panes.forEach((p) => p.chart.resize());
      requestAnimationFrame(() => {
        this.panes.forEach((p) => p.chart.resize());
      });
    });
    setTimeout(() => this.panes.forEach((p) => p.chart.resize()), 300);
  }

  /* ---------------- per-pane fullscreen ---------------- */

  /**
   * Expand a single pane to fill the entire chart area, or restore the
   * multi-pane grid if the same pane is clicked again. The previous layout
   * (e.g. 2x2) is preserved on `state.layout`; only the *visible* panes and
   * the chartArea's grid template are toggled.
   */
  togglePaneFullscreen(pane) {
    if (!pane) return;
    if (this.state.fullscreenPane === pane.index) {
      this.state.fullscreenPane = null;
    } else {
      this.state.fullscreenPane = pane.index;
    }
    store.set('state', this.state);
    this.applyFullscreenState();
  }

  /**
   * Apply the current fullscreen state to the DOM:
   * - When `fullscreenPane` is set, hide every other pane and switch the
   *   chartArea's grid to 1x1 so the fullscreen pane fills it.
   * - When it's null, restore every pane to visible and re-apply `state.layout`
   *   so the multi-pane grid returns.
   * Charts are then resized so the new sizes propagate to each canvas.
   */
  applyFullscreenState() {
    const fs = this.state.fullscreenPane;
    this.chartArea = this.chartArea || $('#chartArea');
    if (fs == null) {
      // Restore
      this.chartArea.dataset.layout = this.state.layout;
      for (const p of this.panes) p.wrap.classList.remove('hidden');
    } else {
      // Fullscreen
      this.chartArea.dataset.layout = '1';
      for (let i = 0; i < this.panes.length; i++) {
        this.panes[i].wrap.classList.toggle('hidden', i !== fs);
      }
    }
    // Refresh each pane header (toggles the .active state on the fs button).
    for (const p of this.panes) p._updatePaneHeader?.();
    // Resize every visible chart after the layout settles.
    setTimeout(() => {
      for (const p of this.panes) {
        if (!p.wrap.classList.contains('hidden')) p.chart.resize();
      }
    }, 60);
  }

  /**
   * Toggle the multi-timeframe layout. If the chart is in single-pane mode,
   * opens the MTF wizard. If it's already in a multi-pane layout, clicking
   * MF returns to a single chart. The button is highlighted (active class)
   * whenever a multi-pane layout is active.
   */
  toggleMTF() {
    if (this.state.layout !== '1') {
      // Already multi-pane → return to single chart.
      this.applyLayout('1');
      this.renderToolbarState();
      toast('Single chart', 'Returned to single-chart layout', 'info', 2000);
    } else {
      // Single chart → open the wizard.
      this.openMTFDialog();
    }
  }

  /**
   * Open the Multi-Timeframe wizard: the user picks pane count, an
   * orientation for that count, and which timeframes go in each pane. The
   * wizard then applies a TradingView-style grid preloaded with the active
   * symbol at the chosen timeframes.
   *
   * Orientation options:
   *   2 panes: 2h (horizontal / side-by-side) | 2v (vertical / stacked)
   *   3 panes: 3-1t2b (1 big top + 2 small bottom) | 3-2t1b (2 small top + 1 big bottom)
   *   4 panes: 4 (2x2 grid — 2 up + 2 down)
   *   6 panes: 6-3x2 | 6-2x3
   *   8 panes: 8-4x2 | 8-2x4
   */
  openMTFDialog() {
    const symbol = this.activePane?.chart.symbol || 'AAPL';
    const presets = [
      { label: 'Intraday', tfs: ['1m', '5m', '15m', '1h'], count: 4 },
      { label: 'Day trader', tfs: ['5m', '15m', '1h', '1d'], count: 4 },
      { label: 'Swing trader', tfs: ['1h', '1d', '1wk', '1mo'], count: 4 },
      { label: 'Trend', tfs: ['1d', '1wk', '1mo'], count: 3 },
      { label: 'Two panes', tfs: ['15m', '1d'], count: 2 },
    ];
    const tfOptions = INTERVALS.map((i) => i.id);
    let count = 4;
    // Default orientation per pane count — kept in sync with the LAYOUTS table.
    const defaultOrientFor = (n) =>
      n === 1 ? '1' :
      n === 2 ? '2h' :
      n === 3 ? '3-1t2b' :
      n === 4 ? '4' :
      n === 6 ? '6-3x2' :
      '8-4x2';
    let orientation = defaultOrientFor(count);
    let tfs = ['5m', '15m', '1h', '1d'];

    const body = el('div', { class: 'mtf-wizard' });
    const presetRow = el('div', { class: 'mtf-presets' },
      presets.map((p) =>
        el('button', {
          class: 'btn sm',
          text: p.label,
          onclick: () => {
            count = p.count;
            orientation = defaultOrientFor(count);
            tfs = p.tfs.slice();
            while (tfs.length < count) tfs.push('1d');
            rebuildAll();
          },
        })
      )
    );

    // Orientation picker — shows the layouts available for the chosen pane
    // count. Each button has a tiny ASCII layout preview so the user can see
    // the orientation at a glance.
    const orientRow = el('div', { class: 'mtf-orient-row' });
    const orientPreview = (l) => {
      if (l === '1') return '▭';
      if (l === '2h') return '▭ ▭';
      if (l === '2v') return '▭ / ▭';
      if (l === '3-1t2b') return '▭▭\n▭ ▭';
      if (l === '3-2t1b') return '▭ ▭\n▭▭';
      if (l === '4') return '▭ ▭\n▭ ▭';
      if (l === '6-3x2') return '▭ ▭ ▭\n▭ ▭ ▭';
      if (l === '6-2x3') return '▭ ▭\n▭ ▭\n▭ ▭';
      if (l === '8-4x2') return '▭ ▭ ▭ ▭\n▭ ▭ ▭ ▭';
      if (l === '8-2x4') return '▭ ▭\n▭ ▭\n▭ ▭\n▭ ▭';
      return '';
    };
    const orientLabelFor = (l) => {
      const found = LAYOUTS.find((x) => x.id === l);
      return found ? found.label : l;
    };
    function rebuildOrient() {
      orientRow.innerHTML = '';
      const available = LAYOUTS.filter((l) => l.count === count);
      orientRow.appendChild(el('div', { class: 'mtf-orient-label', text: 'Orientation:' }));
      if (available.length === 1) {
        orientRow.appendChild(el('div', { class: 'mtf-orient-only', text: available[0].label }));
      } else {
        for (const l of available) {
          const isOn = l.id === orientation;
          const btn = el('button', {
            class: `btn sm mtf-orient-btn ${isOn ? 'active' : ''}`,
            title: l.label,
            onclick: () => { orientation = l.id; rebuildOrient(); },
          }, [
            el('span', { class: 'mtf-orient-preview', text: orientPreview(l.id) }),
            el('span', { class: 'mtf-orient-text', text: l.label }),
          ]);
          orientRow.appendChild(btn);
        }
      }
    }

    const rowsEl = el('div', { class: 'mtf-rows' });
    body.append(presetRow, orientRow, rowsEl);

    function rebuildRows() {
      rowsEl.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const idx = i;
        const row = el('div', { class: 'mtf-row' }, [
          el('span', { class: 'mtf-row-label', text: `Pane ${i + 1}` }),
          el('select', {
            class: 'mtf-select',
            value: tfs[idx] || '1d',
            onchange: (e) => { tfs[idx] = e.target.value; },
          }, tfOptions.map((tf) =>
            el('option', { value: tf, text: tf, selected: tf === (tfs[idx] || '1d') })
          )),
        ]);
        rowsEl.appendChild(row);
      }
      // Pane-count selector appended after the rows.
      rowsEl.appendChild(el('div', { class: 'mtf-row' }, [
        el('span', { class: 'mtf-row-label', text: 'Panes' }),
        el('select', {
          class: 'mtf-select',
          value: String(count),
          onchange: (e) => {
            count = Number(e.target.value);
            orientation = defaultOrientFor(count);
            // Pad tfs so every pane has a timeframe.
            while (tfs.length < count) tfs.push('1d');
            rebuildAll();
          },
        }, [1, 2, 3, 4, 6, 8].map((n) =>
          el('option', { value: String(n), text: n === 1 ? '1 pane (back to single)' : `${n} panes`, selected: n === count })
        )),
      ]));
    }

    function rebuildAll() {
      rebuildOrient();
      rebuildRows();
    }
    rebuildAll();

    // Build the modal using the actions API (openModal does NOT accept
    // `okLabel`/`onOk` — only `actions: [{label, onClick, primary}]`).
    // The apply callback reads the current `count`, `orientation`, and
    // `tfs` from the closure.
    const applyMTF = (close) => {
      // Trim/pad the tf list to the chosen count.
      tfs = tfs.slice(0, count);
      while (tfs.length < count) tfs.push('1d');
      // Use the user's chosen orientation directly as the layout id.
      // If no orientation was picked (shouldn't happen), fall back to the
      // default for the count.
      const layoutId = orientation || defaultOrientFor(count);
      // Each pane in an MTF layout is on its own timeframe, so the time range
      // must be independent per pane — dragging one pane's time axis should
      // NOT move every other pane. Auto-disable sync.timeRange on apply so
      // the user gets independent panes out of the box. Crosshair sync stays
      // on (the cursor still tracks the same bar time across panes), and
      // symbol sync is left untouched (user choice).
      if (count > 1) {
        this.state.sync.timeRange = false;
      }
      this.applyLayout(layoutId);
      // Apply each timeframe to its pane.
      for (let i = 0; i < this.panes.length; i++) {
        const pane = this.panes[i];
        pane.chart.symbol = symbol;
        pane.chart.interval = tfs[i] || '1d';
        pane.range = rangeForBars(pane.chart.interval, 600);
      }
      this.loadAllPanes();
      this.renderToolbarState();
      store.set('state', this.state);
      toast('Multi-timeframe layout', `${symbol} on ${tfs.join(' / ')} (${orientLabelFor(layoutId)})`, 'success');
      close();
    };

    openModal({
      title: `Multi-timeframe layout — ${symbol}`,
      body,
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        { label: 'Open', primary: true, onClick: applyMTF },
      ],
    });
  }

  /**
   * Apply a single timeframe to a single pane (used by per-pane dropdown).
   */
  setPaneInterval(pane, interval) {
    pane.setInterval(interval);
    if (this.state.sync.symbol) this._broadcastSymbol(pane);
    if (this.state.sync.timeRange) this._broadcastView(pane);
    this.renderToolbarState();
  }

  /**
   * Apply a single symbol to a single pane (used by per-pane symbol search).
   */
  setPaneSymbol(pane, symbol) {
    pane.setSymbol(symbol);
    if (this.state.sync.symbol) this._broadcastSymbol(pane);
    if (this.state.sync.timeRange) this._broadcastView(pane);
    this.renderToolbarState();
  }

  /** Push the active pane's symbol to every other pane when sync.symbol is on. */
  _broadcastSymbol(sourcePane) {
    const sym = sourcePane.chart.symbol;
    for (const p of this.panes) {
      if (p === sourcePane) continue;
      if (p.chart.symbol !== sym) p.setSymbol(sym);
    }
  }

  /** Push the active pane's view (leftIndex, barSpacing) onto every other pane. */
  _broadcastView(sourcePane) {
    const src = sourcePane.chart.viewport;
    for (const p of this.panes) {
      if (p === sourcePane) continue;
      const vp = p.chart.viewport;
      vp.leftIndex = src.leftIndex;
      vp.barSpacing = src.barSpacing;
      p.chart.autoScale = !this.state.axisManualMode;
      p.chart.render();
    }
  }

  screenshot() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    const canvas = document.createElement('canvas');
    canvas.width = chart.width;
    canvas.height = chart.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(chart.canvas, 0, 0, chart.width, chart.height);
    ctx.drawImage(chart.overlay, 0, 0, chart.width, chart.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      download(`${chart.symbol}-${chart.interval}-${Date.now()}.png`, blob, 'image/png');
      toast('Screenshot saved', `${chart.symbol} ${chart.interval}`, 'success', 2600);
    });
  }

  exportCsv() {
    const chart = this.activePane?.chart;
    if (!chart?.bars?.length) return;
    const rows = ["Date,Open,High,Low,Close,Volume"];
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (t) => {
      const d = new Date(t);
      return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate())
        + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
    };
    for (const b of chart.bars) {
      rows.push(fmt(b.t) + "," + b.o + "," + b.h + "," + b.l + "," + b.c + "," + b.v);
    }
    const safeSym = String(chart.symbol || "chart").replace(/[^A-Za-z0-9_-]+/g, "_");
    const safeIv = String(chart.interval || "1d").replace(/[^A-Za-z0-9_-]+/g, "_");
    const filename = safeSym + "_" + safeIv + "_" + new Date().toISOString().slice(0, 10) + ".csv";
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    download(filename, blob, "text/csv");
    toast("CSV exported", chart.bars.length + " bars", "success", 2600);
  }

  /* ---------------- indicators ---------------- */

  openIndicatorDialog() {
    const pane = this.activePane;
    if (!pane) return;
    const search = el('input', { type: 'text', placeholder: 'Search indicators…' });
    const list = el('div', { style: { maxHeight: '34vh', overflowY: 'auto', marginTop: '10px' } });

    // Helper: create a row with Add, Add to all, and a gear (configure before adding).
    const makeRow = (name, badge, onAdd, onAddAll, onConfigure) => {
      const btnAdd = el('button', {
        class: 'btn sm',
        text: 'Add',
        onclick: () => { onAdd(); modal.close(); },
      });
      const btnAll = el('button', {
        class: 'btn sm',
        text: 'Add to all',
        title: 'Add this indicator to every pane in the layout',
        onclick: () => { onAddAll(); modal.close(); },
      });
      const btnGear = el('button', {
        class: 'btn sm',
        text: '⚙',
        title: `Configure ${name} before adding`,
        onclick: () => { onConfigure(); },
      });
      return el('div', { class: 'ind-row', style: { cursor: 'pointer' } }, [
        el('span', { class: 'i-name', text: name }),
        el('span', { class: 'badge', text: badge }),
        el('div', { style: { display: 'flex', gap: '4px' } }, [btnGear, btnAdd, btnAll]),
      ]);
    };

    // Helper: create a row for an already-attached indicator with a gear.
    const makeAttachedRow = (ind) => {
      const btnGear = el('button', {
        class: 'btn sm',
        text: '⚙',
        title: `Settings for ${ind.name}`,
        onclick: () => { this.openIndicatorInputs(pane, ind); },
      });
      const btnRemove = el('button', {
        class: 'btn sm',
        text: '✕',
        title: `Remove ${ind.name}`,
        onclick: () => {
          pane.chart.removeIndicator(ind.id);
          renderList(search.value);
        },
      });
      const btnHide = el('button', {
        class: 'btn sm',
        text: ind.visible === false ? '◌' : '◉',
        title: ind.visible === false ? 'Show' : 'Hide',
        onclick: () => {
          ind.visible = ind.visible === false;
          pane.chart._layoutPanes();
          pane.chart.render();
          renderList(search.value);
        },
      });
      return el('div', { class: 'ind-row' }, [
        el('span', { class: 'i-name', text: ind.name, title: ind.name }),
        el('span', { class: 'badge', text: ind.visible === false ? 'hidden' : 'active' }),
        el('div', { style: { display: 'flex', gap: '4px' } }, [btnHide, btnGear, btnRemove]),
      ]);
    };

    /**
     * Open a "configure before adding" dialog for a builtin indicator.
     * Lets the user set parameter values AND line colors, then adds to
     * the active pane or all panes with those settings.
     */
    const configureBuiltin = (def) => {
      const params = Object.fromEntries(def.params.map((p) => [p.key, p.def]));
      const style = { colors: {}, widths: {} }; // per-plot overrides
      const body = el('div', { class: 'inputs-list' });

      // Parameters section
      body.appendChild(el('div', { class: 'input-group-title', text: 'Parameters' }));
      for (const p of def.params) {
        const control = el('input', {
          type: 'number',
          value: p.def,
          step: 1,
          min: p.min ?? undefined,
          title: p.label,
          oninput: (e) => { params[p.key] = Number(e.target.value); },
        });
        body.appendChild(el('div', { class: 'field' }, [
          el('label', { text: p.label }),
          control,
        ]));
      }

      // Colors section (the indicator name determines how many plots)
      body.appendChild(el('div', { class: 'input-group-title', text: 'Colors' }));
      // Builtin indicators typically have 1-3 plots depending on the type
      const plotNames = this._builtinPlotNames(def.key);
      for (let i = 0; i < plotNames.length; i++) {
        const defaultColors = ['#2962ff', '#ff9800', '#e040fb'];
        const c = defaultColors[i] || '#2962ff';
        const colorInput = el('input', {
          type: 'color',
          value: c,
          oninput: (e) => { style.colors[i] = e.target.value.replace('#', ''); },
        });
        style.colors[i] = c.replace('#', '');
        const widthInput = el('input', {
          type: 'number', min: 1, max: 10, value: 1, style: { width: '50px' },
          oninput: (e) => { style.widths[i] = Math.max(1, Number(e.target.value) || 1); },
        });
        style.widths[i] = 1;
        body.appendChild(el('div', { class: 'field', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          el('label', { text: plotNames[i], style: { flex: 1 } }),
          colorInput,
          el('span', { text: 'W:', style: { fontSize: '11px', color: 'var(--text-dim)' } }),
          widthInput,
        ]));
      }

      const cfgModal = openModal({
        title: `Configure — ${def.name}`,
        body,
        width: 380,
        actions: [
          { label: 'Cancel', onClick: (close) => close() },
          { label: 'Add to all', onClick: (close) => {
            this.addAllPanes((p) => this.addBuiltinIndicator(p, def, { ...params, __style: style }));
            close(); modal.close();
          }},
          { label: 'Add', primary: true, onClick: (close) => {
            this.addBuiltinIndicator(pane, def, { ...params, __style: style });
            close(); modal.close();
          }},
        ],
      });
    };

    /**
     * Open a "configure before adding" dialog for a Pine script.
     * Runs the script once to discover its plots, then lets the user
     * set input values AND line colors, then adds to the active pane
     * or all panes with those settings.
     */
    const configurePine = (script) => {
      // First compile to discover inputs and plots
      const tempInd = createPineIndicator({
        id: `preview_${Date.now()}`,
        name: script.name,
        source: script.source,
        inputs: {},
        feed,
        onUpdate: () => {},
      });
      const result = tempInd.compute(pane.chart.bars, pane.chart);
      const manifest = result.inputs || [];
      const plots = result.outputs?.plots || [];
      const values = { ...result.inputValues };
      const style = { colors: {}, widths: {} };

      const body = el('div', { class: 'inputs-list' });

      // Colors section
      if (plots.length) {
        body.appendChild(el('div', { class: 'input-group-title', text: 'Colors' }));
        for (let i = 0; i < plots.length; i++) {
          const title = plots[i].title || `Plot ${i + 1}`;
          const curColor = plots[i].colors?.find((c) => c);
          const hexColor = curColor?.value ? '#' + curColor.value.slice(0, 6) : '#2962ff';
          style.colors[i] = (curColor?.value || '2962ff').slice(0, 6);
          style.widths[i] = plots[i].linewidth || 1;

          const colorInput = el('input', {
            type: 'color', value: hexColor,
            oninput: (e) => { style.colors[i] = e.target.value.replace('#', ''); },
          });
          const widthInput = el('input', {
            type: 'number', min: 1, max: 10, value: style.widths[i], style: { width: '50px' },
            oninput: (e) => { style.widths[i] = Math.max(1, Number(e.target.value) || 1); },
          });
          body.appendChild(el('div', { class: 'field', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            el('label', { text: title, style: { flex: 1 } }),
            colorInput,
            el('span', { text: 'W:', style: { fontSize: '11px', color: 'var(--text-dim)' } }),
            widthInput,
          ]));
        }
      }

      // Inputs section
      if (manifest.length) {
        body.appendChild(el('div', { class: 'input-group-title', text: 'Inputs' }));
        const groups = new Map();
        for (const inp of manifest) {
          const g = inp.group || '';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(inp);
        }
        for (const [groupName, items] of groups) {
          if (groupName) body.appendChild(el('div', { class: 'input-group-title', text: groupName }));
          for (const inp of items) {
            const current = values[inp.id] ?? inp.defval;
            let control;
            if (inp.kind === 'bool') {
              control = el('input', { type: 'checkbox', checked: current, onchange: (e) => (values[inp.id] = e.target.checked) });
            } else if (inp.kind === 'color') {
              control = el('input', { type: 'color', value: current || '#2962ff', oninput: (e) => (values[inp.id] = e.target.value) });
            } else if (inp.kind === 'string' || inp.kind === 'timeframe' || inp.kind === 'symbol' || inp.kind === 'session') {
              control = el('input', { type: 'text', value: current ?? '', oninput: (e) => (values[inp.id] = e.target.value) });
            } else {
              control = el('input', {
                type: 'number', value: current ?? 0,
                step: inp.step ?? (inp.kind === 'int' ? 1 : 'any'),
                oninput: (e) => (values[inp.id] = inp.kind === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value)),
              });
            }
            body.appendChild(el('div', { class: 'field' }, [el('label', { text: inp.title }), control]));
          }
        }
      }

      const cfgModal = openModal({
        title: `Configure — ${script.name}`,
        body,
        width: 380,
        actions: [
          { label: 'Cancel', onClick: (close) => close() },
          { label: 'Add to all', onClick: (close) => {
            this.addAllPanes((p) => this.addPineScript(p, script, values, style));
            close(); modal.close();
          }},
          { label: 'Add', primary: true, onClick: (close) => {
            this.addPineScript(pane, script, values, style);
            close(); modal.close();
          }},
        ],
      });
    };

    const renderList = (filter = '') => {
      list.innerHTML = '';
      const f = filter.toLowerCase();

      // ── Currently attached indicators ──
      const attached = pane.chart.indicators.filter((ind) => !ind._isDefault);
      if (attached.length) {
        list.appendChild(el('div', { class: 'input-group-title', text: 'On this chart' }));
        for (const ind of attached) {
          if (f && !ind.name.toLowerCase().includes(f)) continue;
          list.appendChild(makeAttachedRow(ind));
        }
        list.appendChild(el('div', { style: { height: '4px' } }));
      }

      for (const def of BUILTIN_INDICATORS) {
        if (f && !`${def.name} ${def.key}`.toLowerCase().includes(f)) continue;
        list.appendChild(makeRow(
          def.name,
          def.overlay ? 'overlay' : 'pane',
          () => this.addBuiltinIndicator(pane, def),
          () => this.addAllPanes((p) => this.addBuiltinIndicator(p, def)),
          () => configureBuiltin(def),
        ));
      }
      const scripts = store.get('scripts', []);
      if (scripts.length) {
        list.appendChild(el('div', { class: 'input-group-title', text: 'Your Pine scripts' }));
        for (const s of scripts) {
          if (f && !`${s.name}`.toLowerCase().includes(f)) continue;
          list.appendChild(makeRow(
            s.name, 'pine',
            () => this.addPineScript(pane, s),
            () => this.addAllPanes((p) => this.addPineScript(p, s)),
            () => configurePine(s),
          ));
        }
      }
      list.appendChild(el('div', { class: 'input-group-title', text: 'Templates' }));
      for (const t of TEMPLATES) {
        if (f && !t.name.toLowerCase().includes(f)) continue;
        list.appendChild(makeRow(
          t.name, 'pine',
          () => this.addPineScript(pane, { name: t.name, source: t.source }),
          () => this.addAllPanes((p) => this.addPineScript(p, { name: t.name, source: t.source })),
          () => configurePine({ name: t.name, source: t.source }),
        ));
      }
    };

    search.addEventListener('input', () => renderList(search.value));
    renderList();

    const body = el('div', {}, [search, list]);
    const modal = openModal({ title: 'Indicators & scripts', body, width: 500 });
  }

  /**
   * Return plot display names for a builtin indicator type.
   * Used by the configure-before-adding dialog to show color pickers.
   */
  _builtinPlotNames(key) {
    const names = {
      sma: ['SMA'], ema: ['EMA'], wma: ['WMA'], bb: ['Upper', 'Basis', 'Lower'],
      vwap: ['VWAP'], rsi: ['RSI'], macd: ['MACD', 'Signal', 'Histogram'],
      stoch: ['%K', '%D'], atr: ['ATR'], obv: ['OBV'], cci: ['CCI'], mfi: ['MFI'],
    };
    return names[key] || ['Line'];
  }

  /**
   * Apply a function to every pane in the layout. Used by the "Add to all"
   * button in the indicator dialog to add an indicator to every pane at
   * once. In a single-pane layout, this is equivalent to "Add" (the
   * function runs on the one pane).
   */
  addAllPanes(fn) {
    for (const p of this.panes) {
      fn(p);
    }
    this.renderIndicatorSettings();
    this.persistState();
  }

  addBuiltinIndicator(pane, def, params = null) {
    const resolved = params || Object.fromEntries(def.params.map((p) => [p.key, p.def]));
    const _baseCompute = makeBuiltinCompute(def.key, resolved);
  // __source_resolver__: allow this indicator to consume another indicator's plot
  let _sourceSpec = resolved.__source;
  if (!_sourceSpec && !params && pane && pane.chart && Array.isArray(pane.chart.indicators) && pane.chart.indicators.length > 0) {
    const _avail = listAvailableSources(pane.chart).filter((s) => s.value !== 'close');
    if (_avail.length > 0 && typeof prompt === 'function') {
      const _pick = prompt(
        'Source for ' + (def.name || def.key) + ':\n0 = close (default)\n' +
          _avail.map((s, i) => (i + 1) + '. ' + s.label).join('\n'),
        '0'
      );
      if (_pick && _pick !== '0') {
        const _idx = parseInt(_pick, 10) - 1;
        if (_idx >= 0 && _idx < _avail.length) _sourceSpec = _avail[_idx].value;
      }
    }
  }
  const compute = (bars, chart) => _baseCompute(resolveSourceBars(chart, bars, _sourceSpec), chart);
    const ind = pane.chart.addIndicator({
      key: `${def.key}:${JSON.stringify(resolved)}`,
      name: `${def.name.replace(/ \(.*\)/, '')}${def.params.length ? `(${Object.values(resolved).join(',')})` : ''}`,
      overlay: def.overlay,
      compute,
      builtinKey: def.key,
      builtinParams: resolved,
      def,
    });
    if (ind) {
      this.setActivePane(pane);
      this.renderIndicatorSettings();
      this.persistState();
      toast('Indicator added', ind.name, 'success', 2200);
    }
    return ind;
  }

  addPineScript(pane, script, inputOverrides, styleOverrides) {
    const id = script.id || `tmp_${Date.now()}`;
    const ind = createPineIndicator({
      id,
      name: script.name || 'Pine Script',
      source: script.source,
      inputs: inputOverrides || {},
      feed,
      overlay: undefined,
      onUpdate: () => {
        pane.chart.recomputeIndicators();
        pane.chart._layoutPanes();
        pane.chart.render();
        this.renderStrategy();
        this.refreshScriptAlerts(pane);
      },
    });
    ind.scriptId = script.id || null;
    pane.chart.addIndicator(ind);
    pane.chart.recomputeIndicators();
    // Apply style overrides (colors, widths) after compute.
    const result = pane.chart.indicators[pane.chart.indicators.length - 1]?.result;
    if (result?.ok && styleOverrides && result.outputs?.plots) {
      for (let i = 0; i < result.outputs.plots.length; i++) {
        if (styleOverrides.colors && styleOverrides.colors[i] != null) {
          const hex = styleOverrides.colors[i];
          const colors = new Array(result.outputs.plots[i].values?.length || 0).fill(null);
          for (let j = 0; j < colors.length; j++) colors[j] = { __color: true, value: hex, transparency: 0 };
          result.outputs.plots[i].colors = colors;
        }
        if (styleOverrides.widths && styleOverrides.widths[i] != null) {
          result.outputs.plots[i].linewidth = styleOverrides.widths[i];
        }
      }
    }
    if (result && !result.ok) {
      toast('Script error', result.error?.message || 'unknown error', 'error', 6000);
      this.log('error', `${ind.name}: ${result.error?.message}`);
    } else {
      toast('Script added', ind.name, 'success', 2200);
    }
    this.setActivePane(pane);
    this.renderIndicatorSettings();
    this.renderStrategy();
    this.refreshScriptAlerts(pane);
    this.persistState();
    return ind;
  }

  restoreIndicators(pane, saved) {
    for (const s of saved) {
      try {
        if (s.kind === 'builtin' && s.key) {
          const def = BUILTIN_INDICATORS.find((d) => d.key === s.key);
          if (!def) continue;
          const params = s.params || Object.fromEntries(def.params.map((p) => [p.key, p.def]));
          pane.chart.addIndicator({
            key: `${def.key}:${JSON.stringify(params)}`,
            name: `${def.name.replace(/ \(.*\)/, '')}(${Object.values(params).join(',')})`,
            overlay: def.overlay,
            compute: makeBuiltinCompute(def.key, params),
            builtinKey: def.key,
            builtinParams: params,
            def,
          });
        } else if (s.kind === 'pine' && s.source) {
          const ind = createPineIndicator({
            id: s.id || `restored_${Math.random().toString(36).slice(2, 6)}`,
            name: s.name || 'Pine Script',
            source: s.source,
            inputs: s.inputs || {},
            feed,
            overlay: s.overlay,
            onUpdate: () => {
              pane.chart.recomputeIndicators();
              pane.chart.render();
              this.renderStrategy();
            },
          });
          pane.chart.addIndicator(ind);
        }
      } catch (err) {
        this.log('warn', `Could not restore indicator: ${err.message}`);
      }
    }
    pane.chart.recomputeIndicators();
    pane.chart._layoutPanes();
    pane.chart.render();
  }

  renderIndicatorSettings() {
    const panel = $('#panel-data');
    if (!panel) return;
    const pane = this.activePane;
    if (!pane) return;
    const rows = pane.chart.indicators.map((ind) => {
      const def = ind.def;
      const inputs = [];
      if (def) {
        for (const p of def.params) {
          inputs.push(
            el('input', {
              type: 'number',
              value: String(ind.builtinParams?.[p.key] ?? p.def),
              title: p.label,
              onchange: (e) => {
                ind.builtinParams = { ...ind.builtinParams, [p.key]: Number(e.target.value) };
                ind.compute = makeBuiltinCompute(ind.builtinKey, ind.builtinParams);
                ind.name = `${def.name.replace(/ \(.*\)/, '')}(${Object.values(ind.builtinParams).join(',')})`;
                pane.chart.recomputeIndicators();
                pane.chart._layoutPanes();
                pane.chart.render();
                this.persistState();
              },
            })
          );
        }
      }
      return el('div', { class: 'ind-row' }, [
        el('span', {
          class: 'i-name',
          text: ind.name,
          title: ind.name,
        }),
        ...inputs,
        el('span', {
          class: 'i-act',
          title: ind.visible === false ? 'Show' : 'Hide',
          text: ind.visible === false ? '◌' : '◉',
          onclick: () => {
            ind.visible = ind.visible === false;
            pane.chart._layoutPanes();
            pane.chart.render();
            this.renderIndicatorSettings();
          },
        }),
        el('span', {
          class: 'i-act',
          title: 'Settings',
          text: '⚙',
          onclick: () => this.openIndicatorInputs(pane, ind),
        }),
        el('span', {
          class: 'i-act danger',
          title: 'Remove',
          text: '✕',
          onclick: () => {
            pane.chart.removeIndicator(ind.id);
            this.renderIndicatorSettings();
            this.persistState();
          },
        }),
      ]);
    });
    return rows;
  }

  openIndicatorInputs(pane, ind) {
    const manifest = ind.result?.inputs || ind.inputsManifest || [];
    const body = el('div', { class: 'inputs-list' });

    // ── Style section: plot colors and line widths ──
    const plots = ind.result?.outputs?.plots || [];
    if (plots.length) {
      body.appendChild(el('div', { class: 'input-group-title', text: 'Style' }));
      for (let i = 0; i < plots.length; i++) {
        const plot = plots[i];
        const title = plot.title || `Plot ${i + 1}`;
        // Current color (first non-null color in the series, or default blue)
        const curColor = plot.colors?.find((c) => c) || '#2962ff';
        const hexColor = typeof curColor === 'string' ? curColor : (curColor?.value ? '#' + curColor.value.slice(0, 6) : '#2962ff');
        const curWidth = plot.linewidth || 1;

        const colorInput = el('input', {
          type: 'color',
          value: hexColor,
          title: `Color for ${title}`,
          oninput: (e) => {
            // Update the plot's color array
            const hex = e.target.value.replace('#', '');
            if (!plot.colors) plot.colors = [];
            for (let j = 0; j < (plot.values?.length || 0); j++) {
              plot.colors[j] = { __color: true, value: hex, transparency: 0 };
            }
            pane.chart.render();
          },
        });

        const widthInput = el('input', {
          type: 'number',
          min: 1,
          max: 10,
          step: 1,
          value: curWidth,
          title: `Line width for ${title}`,
          style: { width: '50px' },
          oninput: (e) => {
            plot.linewidth = Math.max(1, Math.min(10, Number(e.target.value) || 1));
            pane.chart.render();
          },
        });

        body.appendChild(
          el('div', { class: 'field', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            el('label', { text: title, style: { flex: 1 } }),
            colorInput,
            el('span', { text: 'Width:', style: { fontSize: '11px', color: 'var(--text-dim)' } }),
            widthInput,
          ])
        );
      }
      body.appendChild(el('div', { style: { height: '8px' } }));
    }

    // ── Inputs section: the script's input.* declarations ──
    if (!manifest.length) {
      body.appendChild(el('div', { class: 'empty-note', text: 'This indicator has no configurable inputs.' }));
    } else {
      const groups = new Map();
      for (const inp of manifest) {
        const g = inp.group || '';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(inp);
      }
      const values = { ...(ind.inputs || {}) };
      for (const [groupName, items] of groups) {
        if (groupName) body.appendChild(el('div', { class: 'input-group-title', text: groupName }));
        for (const inp of items) {
          const current = values[inp.id] ?? inp.defval;
          let control;
          if (inp.kind === 'bool') {
            control = el('input', {
              type: 'checkbox',
              checked: current ? true : false,
              onchange: (e) => (values[inp.id] = e.target.checked),
            });
          } else if (inp.kind === 'color') {
            control = el('input', { type: 'color', value: current || '#2962ff', oninput: (e) => (values[inp.id] = e.target.value) });
          } else if (inp.kind === 'string' || inp.kind === 'timeframe' || inp.kind === 'symbol' || inp.kind === 'session') {
            control = el('input', { type: 'text', value: current ?? '', oninput: (e) => (values[inp.id] = e.target.value) });
          } else {
            control = el('input', {
              type: 'number',
              value: current ?? 0,
              step: inp.step ?? (inp.kind === 'int' ? 1 : 'any'),
              min: inp.minval ?? undefined,
              max: inp.maxval ?? undefined,
              oninput: (e) => (values[inp.id] = inp.kind === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value)),
            });
          }
          body.appendChild(
            el('div', { class: 'field' }, [
              el('label', { text: inp.title + (inp.tooltip ? ` — ${inp.tooltip}` : '') }),
              control,
            ])
          );
        }
      }
    }

    // Build a list of other panes that have the same indicator (by name)
    // so we can offer "Apply to all charts".
    const sameIndicators = this.panes
      .filter((p) => p !== pane)
      .flatMap((p) => p.chart.indicators.filter((i) => i.name === ind.name));

    const actions = [
      { label: 'Cancel', onClick: (close) => close() },
    ];
    // Add "Apply to all" if there are other panes with the same indicator.
    if (sameIndicators.length) {
      actions.push({
        label: 'Apply to all',
        onClick: (close) => {
          // Apply to the current pane first.
          if (ind.builtinKey) {
            ind.compute = makeBuiltinCompute(ind.builtinKey, { ...ind.builtinParams, ...values });
            ind.builtinParams = { ...ind.builtinParams, ...values };
          } else {
            ind.inputs = { ...ind.inputs, ...values };
            ind.markDirty?.();
          }
          // Copy the same style (plot colors/widths) to matching indicators.
          const stylePlots = ind.result?.outputs?.plots;
          for (const other of sameIndicators) {
            if (other.builtinKey) {
              other.compute = makeBuiltinCompute(other.builtinKey, { ...other.builtinParams, ...values });
              other.builtinParams = { ...other.builtinParams, ...values };
            } else {
              other.inputs = { ...other.inputs, ...values };
              other.markDirty?.();
            }
            // Copy plot colors/widths.
            if (stylePlots && other.result?.outputs?.plots) {
              for (let i = 0; i < stylePlots.length && i < other.result.outputs.plots.length; i++) {
                if (stylePlots[i].colors) other.result.outputs.plots[i].colors = [...stylePlots[i].colors];
                if (stylePlots[i].linewidth) other.result.outputs.plots[i].linewidth = stylePlots[i].linewidth;
              }
            }
            const otherPane = this.panes.find((p) => p.chart.indicators.includes(other));
            if (otherPane) {
              otherPane.chart.recomputeIndicators();
              otherPane.chart._layoutPanes();
              otherPane.chart.render();
            }
          }
          pane.chart.recomputeIndicators();
          pane.chart._layoutPanes();
          pane.chart.render();
          this.renderIndicatorSettings();
          this.persistState();
          toast('Applied to all', `${ind.name} settings applied to ${sameIndicators.length + 1} charts`, 'success', 2600);
          close();
        },
      });
    }
    actions.push({
      label: 'Apply',
      primary: true,
      onClick: (close) => {
        if (ind.builtinKey) {
          ind.compute = makeBuiltinCompute(ind.builtinKey, { ...ind.builtinParams, ...values });
          ind.builtinParams = { ...ind.builtinParams, ...values };
        } else {
          ind.inputs = { ...ind.inputs, ...values };
          ind.markDirty?.();
        }
        pane.chart.recomputeIndicators();
        pane.chart._layoutPanes();
        pane.chart.render();
        this.renderIndicatorSettings();
        this.persistState();
        close();
      },
    });

    const modal = openModal({
      title: `Settings — ${ind.name}`,
      body,
      width: 380,
      actions,
    });
    return modal;
  }

  openSettingsDialog() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    const state = {
      showGrid: chart.showGrid,
      showVolume: chart.showVolume,
      logScale: chart.logScale,
      percentScale: chart.percentScale,
      upColor: chart.upColor || THEME.up,
      downColor: chart.downColor || THEME.down,
      lineColor: chart.lineColor || THEME.accent,
      lineWidth: chart.lineWidth || 2,
      obsidian: true,
    };
    const body = el('div');
    const check = (label, value, onChange) =>
      el('label', { class: 'checkbox', style: { marginBottom: '8px' } }, [
        el('input', { type: 'checkbox', checked: value, onchange: (e) => onChange(e.target.checked) }),
        el('span', { text: label }),
      ]);
    body.append(
      check('Show grid', state.showGrid, (v) => (state.showGrid = v)),
      check('Show volume', state.showVolume, (v) => (state.showVolume = v)),
      check('Logarithmic scale', state.logScale, (v) => (state.logScale = v)),
      check('Percent scale', state.percentScale, (v) => (state.percentScale = v)),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Up colour' }),
          el('input', { type: 'color', value: state.upColor, oninput: (e) => (state.upColor = e.target.value) }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Down colour' }),
          el('input', { type: 'color', value: state.downColor, oninput: (e) => (state.downColor = e.target.value) }),
        ]),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Line colour' }),
          el('input', { type: 'color', value: state.lineColor, oninput: (e) => (state.lineColor = e.target.value) }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { text: 'Line width' }),
          el('input', { type: 'number', min: '1', max: '6', value: String(state.lineWidth), oninput: (e) => (state.lineWidth = Number(e.target.value)) }),
        ]),
      ])
    );
    openModal({
      title: 'Chart settings',
      body,
      width: 380,
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: 'Apply',
          primary: true,
          onClick: (close) => {
            chart.showGrid = state.showGrid;
            chart.showVolume = state.showVolume;
            chart.upColor = state.upColor;
            chart.downColor = state.downColor;
            chart.lineColor = state.lineColor;
            chart.lineWidth = state.lineWidth;
            chart.setLogScale(state.logScale);
            chart.setPercentScale(state.percentScale);
            chart._layoutPanes();
            chart.render();
            this.state.showGrid = state.showGrid;
            this.state.showVolume = state.showVolume;
            store.set('state', this.state);
            this.renderToolbarState();
            close();
          },
        },
      ],
    });
  }

  /* ---------------- sidebar ---------------- */

  buildSidebar() {
    const tabs = $('#sidebarTabs');
    const defs = [
      { id: 'watchlist', label: 'Watchlist', icon: 'watch' },
      { id: 'alerts', label: 'Alerts', icon: 'alert' },
      { id: 'news', label: 'News', icon: 'news' },
      { id: 'data', label: 'Object tree', icon: 'data' },
    ];
    tabs.innerHTML = '';
    // A "collapse" button sits at the top of the sidebar; clicking it hides
    // the panel area but keeps a thin icon strip so the user can re-open.
    const collapseBtn = el('div', { class: 'sidebar-tab sidebar-collapse', title: 'Collapse sidebar (\\)' }, [
      icon('chevron', 13),
    ]);
    collapseBtn.addEventListener('click', () => this.toggleSidebar(false));
    tabs.appendChild(collapseBtn);
    for (const d of defs) {
      const tab = el('div', { class: `sidebar-tab ${this.state.sidebarTab === d.id ? 'active' : ''}`, dataset: { tab: d.id }, title: d.label }, [icon(d.icon, 13), el('span', { text: d.label })]);
      tab.addEventListener('click', () => {
        // If the sidebar is collapsed, clicking a tab icon re-expands it and
        // selects that panel in one go — same as TradingView.
        if (!this.state.sidebarOpen) {
          this.state.sidebarOpen = true;
          this.state.sidebarTab = d.id;
          this.renderSidebarState();
          store.set('state', this.state);
          return;
        }
        this.state.sidebarTab = d.id;
        this.renderSidebarState();
        store.set('state', this.state);
      });
      tabs.appendChild(tab);
    }
    this.renderSidebarState();
  }

  /**
   * Expand or collapse the right sidebar. Pass `true` to expand, `false` to
   * collapse, or omit to toggle. The collapsed state keeps a thin icon strip
   * visible so the user can re-open the sidebar by clicking any icon.
   */
  toggleSidebar(open) {
    if (open === undefined) open = !this.state.sidebarOpen;
    this.state.sidebarOpen = open;
    store.set('state', this.state);
    this.renderSidebarState();
    // Resize charts after the layout settles so they fill the new width.
    setTimeout(() => this.panes?.forEach((p) => p.chart.resize()), 60);
  }

  renderSidebarState() {
    $$('#sidebarTabs .sidebar-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === this.state.sidebarTab));
    $$('.sidebar-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === this.state.sidebarTab));
    $('#rightSidebar').classList.toggle('collapsed', !this.state.sidebarOpen);
    if (this.state.sidebarTab === 'data') this.renderDataWindow();
    if (this.state.sidebarTab === 'alerts') this.renderAlerts();
    if (this.state.sidebarTab === 'news') this.renderNews();
  }

  renderWatchlist() {
    const panel = $('#panel-watchlist');
    if (!panel) return;
    panel.innerHTML = '';
    const head = el('div', { class: 'watchlist-head' }, [
      el('span', { text: 'Symbol' }),
      el('span', { style: { flex: '1' } }),
      el('span', { text: 'Last' }),
      el('span', { text: 'Chg%' }),
      el('button', {
        class: 'btn sm',
        text: '+',
        title: 'Add symbol',
        onclick: () => this.promptAddWatchSymbol(),
      }),
    ]);
    panel.appendChild(head);

    const counts = { up: 0, down: 0 };
    for (const symbol of this.state.watchlist) {
      const q = this.quoteCache.get(symbol);
      const price = q && !q.error && Number.isFinite(q.price) ? q.price : null;
      const chg = q && Number.isFinite(q.changePercent) ? q.changePercent : null;
      if (chg !== null) {
        if (chg >= 0) counts.up++;
        else counts.down++;
      }
      const active = this.activePane?.chart.symbol === symbol;
      const row = el('div', { class: `watch-row ${active ? 'active' : ''}` }, [
        el('div', { class: 'w-sym' }, [el('span', { text: symbol }), el('small', { text: q?.name ? truncate(q.name, 22) : q?.exchange || '' })]),
        el('div', { class: 'w-price', text: price !== null ? price.toFixed(price >= 100 ? 2 : price >= 1 ? 3 : 5) : '—' }),
        el('div', {
          class: 'w-chg',
          style: { color: chg === null ? 'var(--text-dim)' : chg >= 0 ? 'var(--up)' : 'var(--down)' },
          text: chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
        }),
        el('div', { class: 'w-spark', html: sparklineSvg(this.sparks?.get(symbol)) }),
      ]);
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('w-del')) return;
        this.setSymbol(symbol);
      });
      const del = el('div', { class: 'w-del', text: '✕', title: 'Remove' });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.state.watchlist = this.state.watchlist.filter((s) => s !== symbol);
        store.set('state', this.state);
        this.renderWatchlist();
      });
      row.appendChild(del);
      panel.appendChild(row);
    }
    const footer = el('div', { style: { padding: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px', color: 'var(--text-dim)' } }, [
      el('span', { style: { color: 'var(--up)' }, text: `${counts.up} up` }),
      el('span', { style: { color: 'var(--down)' }, text: `${counts.down} down` }),
      el('span', { style: { flex: '1' } }),
      el('span', { text: `${this.state.watchlist.length} symbols` }),
    ]);
    panel.appendChild(footer);
  }

  promptAddWatchSymbol() {
    const input = el('input', { type: 'text', placeholder: 'e.g. NVDA, BTC-USD, EURUSD=X' });
    const modal = openModal({
      title: 'Add symbol to watchlist',
      body: el('div', { class: 'field' }, [el('label', { text: 'Symbol' }), input]),
      width: 340,
      actions: [
        { label: 'Cancel', onClick: (close) => close() },
        {
          label: 'Add',
          primary: true,
          onClick: (close) => {
            const sym = input.value.trim().toUpperCase();
            if (sym && !this.state.watchlist.includes(sym)) {
              this.state.watchlist.push(sym);
              store.set('state', this.state);
              this.refreshQuotes();
              this.loadSparks();
              this.renderWatchlist();
            }
            close();
          },
        },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const sym = input.value.trim().toUpperCase();
        if (sym && !this.state.watchlist.includes(sym)) {
          this.state.watchlist.push(sym);
          store.set('state', this.state);
          this.refreshQuotes();
          this.renderWatchlist();
        }
        modal.close();
      }
    });
    void modal;
  }

  async refreshQuotes() {
    const symbols = this.state.watchlist;
    if (!symbols.length) return;
    const quotes = await feed.getQuotes(symbols);
    for (const q of quotes) if (!q.error) this.quoteCache.set(q.symbol, q);
    this.renderWatchlist();
    this.renderDataWindow();
    this.loadSparks();
  }

  async loadSparks() {
    this.sparks = this.sparks || new Map();
    const symbols = this.state.watchlist;
    // Fetch a few at a time to avoid hammering the proxy.
    const queue = [...symbols];
    const worker = async () => {
      while (queue.length) {
        const sym = queue.shift();
        if (this.sparks.has(sym)) continue;
        const data = await feed.getSpark(sym, '1d');
        this.sparks.set(sym, data.closes || []);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    this.renderWatchlist();
  }

  renderAlerts() {
    const panel = $('#panel-alerts');
    if (!panel) return;
    renderAlertsPanel(panel, this.alertManager, {
      onSelect: (a) => this.setSymbol(a.symbol),
      onCreate: () => this.createAlert(),
    });
  }

  async loadNews() {
    this.newsItems = await feed.getNews(this.activePane?.chart.symbol || '');
    this.renderNews();
  }

  renderNews() {
    const panel = $('#panel-news');
    if (!panel) return;
    panel.innerHTML = '';
    const items = this.newsItems || [];
    if (!items.length) {
      panel.appendChild(el('div', { class: 'empty-note', text: 'No news for this symbol.' }));
      return;
    }
    for (const n of items) {
      const node = el('div', { class: 'news-item' }, [
        el('div', { class: 'n-title', text: n.title }),
        el('div', { class: 'n-meta', text: `${n.publisher || ''} · ${n.providerPublishTime ? formatDateMedium(n.providerPublishTime, this.activePane?.chart.timezone) : ''}` }),
      ]);
      node.addEventListener('click', () => window.open(n.link, '_blank', 'noopener'));
      panel.appendChild(node);
    }
  }

  renderDataWindow() {
    const panel = $('#panel-data');
    if (!panel) return;
    panel.innerHTML = '';
    const pane = this.activePane;
    if (!pane) return;
    const chart = pane.chart;
    const idx = chart.crosshair.snappedIndex ?? chart.lastBarIndex();
    const b = chart.bars[idx];

    const rows = [];
    rows.push(['Symbol', chart.symbol]);
    rows.push(['Interval', chart.interval]);
    if (b) {
      const d = chart.decimals ?? 2;
      rows.push(['Time', formatDateMedium(b.t, chart.timezone) + ' ' + formatTime(b.t, chart.timezone)]);
      rows.push(['Open', b.o.toFixed(d)]);
      rows.push(['High', b.h.toFixed(d)]);
      rows.push(['Low', b.l.toFixed(d)]);
      rows.push(['Close', b.c.toFixed(d)]);
      rows.push(['Volume', formatCompact(b.v)]);
      if (chart.meta.previousClose) rows.push(['Prev close', Number(chart.meta.previousClose).toFixed(d)]);
    }
    rows.push(['Bars loaded', String(chart.bars.length)]);

    const table = el('table', { class: 'dw-table' });
    for (const [k, v] of rows) {
      table.appendChild(el('tr', {}, [el('td', { text: k }), el('td', { text: v })]));
    }
    panel.appendChild(el('div', { class: 'input-group-title', style: { margin: '8px 10px 4px' }, text: 'Data window' }));
    panel.appendChild(table);

    // Indicators section
    const sec = el('div');
    sec.appendChild(el('div', { class: 'input-group-title', style: { margin: '14px 10px 4px' }, text: 'Indicators on this chart' }));
    const settings = this.renderIndicatorSettings();
    if (!settings || !settings.length) {
      sec.appendChild(el('div', { class: 'empty-note', text: 'No indicators. Press Ctrl+I to add one.' }));
    } else {
      for (const r of settings) sec.appendChild(r);
    }
    panel.appendChild(sec);

    // Objects / drawings
    sec.appendChild(el('div', { class: 'input-group-title', style: { margin: '14px 10px 4px' }, text: `Drawings (${chart.drawings.length})` }));
    for (const d of chart.drawings) {
      sec.appendChild(
        el('div', { class: 'ind-row' }, [
          el('span', { class: 'i-name', text: `${d.type}${d.text ? `: ${d.text}` : ''}` }),
          el('span', {
            class: 'i-act',
            title: 'Focus',
            text: '◎',
            onclick: () => {
              chart.selectedDrawingId = d.id;
              chart.render();
            },
          }),
          el('span', { class: 'i-act danger', title: 'Delete', text: '✕', onclick: () => chart.removeDrawing(d.id) }),
        ])
      );
    }
  }

  /* ---------------- bottom panel ---------------- */

  buildBottomPanel() {
    const tabs = $('#bottomTabs');
    tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.bottom-tab');
      if (!tab) return;
      this.openBottom(tab.dataset.tab);
    });
    $('#bottomClose').addEventListener('click', () => this.closeBottom());
    $('#bottomExpand').addEventListener('click', () => {
      const panel = $('#bottomPanel');
      panel.classList.toggle('tall');
    });
    $('#editorRun').addEventListener('click', () => this.runEditor());
    $('#editorSave').addEventListener('click', () => this.saveEditor());
    $('#editorNew').addEventListener('click', () => this.newEditor());
    $('#editorTemplates').addEventListener('click', () => openTemplatesModal((t) => this.editor.setValue(t.source, { name: t.name, id: null })));

    this.editor = new PineEditor({
      onRun: (source, meta) => this.runEditorSource(source, meta),
      onSave: (source, meta) => this.saveEditorSource(source, meta),
    });

    const autosaved = store.get('pine:autosave', null);
    const firstScript = store.get('scripts', [])[0];
    if (firstScript) this.editor.setValue(firstScript.source, { name: firstScript.name, id: firstScript.id });
    else if (autosaved) this.editor.setValue(autosaved, { name: 'Untitled' });
    else this.editor.setValue(TEMPLATES[0].source, { name: TEMPLATES[0].name, id: null });

    this.renderScriptLibrary();
  }

  openBottom(tab, { tall = false } = {}) {
    const panel = $('#bottomPanel');
    panel.classList.add('open');
    if (tall) panel.classList.add('tall');
    $$('#bottomTabs .bottom-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    $$('.bottom-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
    if (tab === 'editor') this.editor?._refresh();
    if (tab === 'scripts') this.renderScriptLibrary();
    if (tab === 'strategy') this.renderStrategy();
    setTimeout(() => this.panes.forEach((p) => p.chart.resize()), 180);
  }

  closeBottom() {
    $('#bottomPanel').classList.remove('open', 'tall');
    setTimeout(() => this.panes.forEach((p) => p.chart.resize()), 200);
  }

  runEditorSource(source, meta) {
    // Compile against the active pane's bars so errors surface immediately.
    const pane = this.activePane;
    if (!pane || !pane.chart.bars.length) {
      return { ok: false, error: { message: 'No bars loaded on the active chart yet.' } };
    }
    const ind = createPineIndicator({
      id: `editor_${Date.now()}`,
      name: meta?.name || 'Editor script',
      source,
      inputs: {},
      feed,
      onUpdate: () => {
        pane.chart.recomputeIndicators();
        pane.chart.render();
        this.renderStrategy();
      },
    });
    const result = ind.compute(pane.chart.bars, pane.chart);
    this.lastEditorResult = result;
    this.editor.setErrors(result);
    if (result.ok) {
      this.log('info', `Script "${meta?.name}" compiled: ${result.outputs.plots.length} plots, ${result.inputs.length} inputs`);
    } else {
      this.log('error', `Script error: ${result.error.message}${result.error.line ? ` (line ${result.error.line})` : ''}`);
    }
    return result;
  }

  runEditor() {
    const pane = this.activePane;
    if (!pane) return;
    const result = this.runEditorSource(this.editor.value, { name: this.editor.currentName });
    if (!result.ok) {
      toast('Compile error', result.error.message, 'error', 6000);
      return;
    }
    // Add the compiled script as a chart indicator.
    const ind = createPineIndicator({
      id: `editor_${Date.now()}`,
      name: this.editor.currentName === 'Untitled' ? 'Editor script' : this.editor.currentName,
      source: this.editor.value,
      inputs: result.inputValues || {},
      feed,
      onUpdate: () => {
        pane.chart.recomputeIndicators();
        pane.chart._layoutPanes();
        pane.chart.render();
        this.renderStrategy();
        this.refreshScriptAlerts(pane);
      },
    });
    pane.chart.addIndicator(ind);
    pane.chart.recomputeIndicators();
    pane.chart._layoutPanes();
    pane.chart.render();
    this.renderIndicatorSettings();
    this.renderStrategy();
    this.refreshScriptAlerts(pane);
    this.persistState();
    toast('Added to chart', ind.name, 'success', 2600);
    this.openBottom('strategy');
  }

  saveEditorSource(source, meta) {
    const scripts = store.get('scripts', []);
    const name = meta.name && meta.name !== 'Untitled' ? meta.name : `Script ${scripts.length + 1}`;
    let id = meta.id;
    if (id) {
      const existing = scripts.find((s) => s.id === id);
      if (existing) {
        existing.source = source;
        existing.name = name;
        existing.savedAt = Date.now();
      } else {
        id = null;
      }
    }
    if (!id) {
      id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      scripts.push({ id, name, source, savedAt: Date.now() });
    }
    store.set('scripts', scripts);
    toast('Script saved', name, 'success', 2400);
    this.renderScriptLibrary();
    return id;
  }

  saveEditor() {
    const id = this.editor.save();
    if (id) this.editor.currentId = id;
  }

  newEditor() {
    this.editor.setValue(TEMPLATES[0].source, { name: 'Untitled', id: null });
    toast('New script', 'Loaded the default template.', 'info', 2200);
  }

  renderScriptLibrary() {
    const pane = $('#scriptsPane');
    if (!pane) return;
    const scripts = store.get('scripts', []);
    renderScriptLibrary(pane, {
      scripts,
      onLoad: (s, addToChart) => {
        this.editor.setValue(s.source, { name: s.name, id: s.id });
        if (addToChart && this.activePane) this.addPineScript(this.activePane, s);
      },
      onDelete: (s) => {
        const next = store.get('scripts', []).filter((x) => x.id !== s.id);
        store.set('scripts', next);
        this.renderScriptLibrary();
        toast('Deleted', s.name, 'info', 2000);
      },
      onRename: (s) => {
        const input = el('input', { type: 'text', value: s.name });
        openModal({
          title: 'Rename script',
          body: el('div', { class: 'field' }, [el('label', { text: 'Name' }), input]),
          width: 320,
          actions: [
            { label: 'Cancel', onClick: (close) => close() },
            {
              label: 'Rename',
              primary: true,
              onClick: (close) => {
                const scripts2 = store.get('scripts', []);
                const found = scripts2.find((x) => x.id === s.id);
                if (found) found.name = input.value.trim() || found.name;
                store.set('scripts', scripts2);
                this.renderScriptLibrary();
                close();
              },
            },
          ],
        });
      },
      onExport: (s) => download(`${s.name.replace(/\W+/g, '_')}.pine`, s.source, 'text/plain'),
    });
  }

  /* ---------------- strategy ---------------- */

  renderStrategy() {
    const pane = $('#strategyPane');
    if (!pane) return;
    const chart = this.activePane?.chart;
    if (!chart) return;
    const stratInd = chart.indicators.find((i) => i.result?.ok && i.result.outputs?.strategy && (i.result.outputs.strategy.orders?.length || i.result.outputs.strategy.trades?.length));
    if (!stratInd) {
      pane.innerHTML = '';
      pane.appendChild(
        el('div', {
          class: 'empty-note',
          text:
            'No strategy running on this chart.\n\nOpen the Pine Editor, load the "Bollinger Breakout Strategy" template and press Add to chart.',
        })
      );
      return;
    }
    const strategy = stratInd.result.outputs.strategy;
    const stats = computeStats(strategy, chart.bars);
    renderStrategyPane(pane, {
      stats,
      strategy,
      symbol: chart.symbol,
      timezone: chart.timezone,
      onGoToBar: (barIndex) => {
        if (!Number.isFinite(barIndex)) return;
        const target = Math.max(0, barIndex - 20);
        chart.viewport.leftIndex = target;
        chart.autoScale = true;
        chart.render();
      },
    });
  }

  /* ---------------- alerts ---------------- */

  refreshScriptAlerts(pane) {
    const chart = pane?.chart;
    if (!chart) return;
    const out = [];
    for (const ind of chart.indicators) {
      if (!ind.result?.ok) continue;
      for (const cond of ind.result.outputs.alertConditions || []) {
        const lastIdx = chart.bars.length - 1;
        const firing = !!cond.flags[lastIdx];
        out.push({
          conditionId: `${ind.id}:${cond.id}`,
          title: `${ind.name} — ${cond.title}`,
          message: cond.message || cond.title,
          firing,
          time: chart.bars[lastIdx]?.t ?? null,
          barIndex: lastIdx,
        });
      }
      for (const a of ind.result.outputs.alerts || []) {
        if (a.bar === chart.bars.length - 1) {
          out.push({
            conditionId: `${ind.id}:alert`,
            title: `${ind.name} — alert()`,
            message: a.message,
            firing: true,
            time: a.time,
            barIndex: a.bar,
          });
        }
      }
    }
    this.scriptAlertCache.set(chart.symbol, out);
    // Fire script alerts through the manager if matching alerts exist.
    const management = this.alertManager?.alerts || [];
    for (const item of out) {
      if (!item.firing) continue;
      for (const a of management) {
        if (a.kind !== 'script' || a.symbol !== chart.symbol || !a.enabled) continue;
        if (a.conditionId && a.conditionId !== item.conditionId) continue;
        const key = `${a.id}:${chart.bars.length - 1}`;
        if (this._firedKeys?.has(key)) continue;
        this._firedKeys = this._firedKeys || new Set();
        this._firedKeys.add(key);
        this.alertManager.fire(a, item.message || a.message || item.title, { source: 'script' });
      }
    }
  }

  alertContext() {
    const chart = this.activePane?.chart;
    return {
      getQuote: (symbol) => {
        if (chart && symbol === chart.symbol) {
          const last = chart.bars[chart.lastBarIndex()];
          const prev = chart.bars[chart.lastBarIndex() - 1];
          return { price: last?.c, previousClose: prev?.c };
        }
        return this.quoteCache.get(symbol);
      },
      getScriptAlerts: (symbol) => this.scriptAlertCache.get(symbol) || [],
    };
  }

  createAlert() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    const last = chart.bars[chart.lastBarIndex()];
    const scriptConditions = [];
    for (const ind of chart.indicators) {
      if (!ind.result?.ok) continue;
      for (const cond of ind.result.outputs.alertConditions || []) {
        scriptConditions.push({
          conditionId: `${ind.id}:${cond.id}`,
          title: `${ind.name} — ${cond.title}`,
          message: cond.message || cond.title,
        });
      }
    }
    openAlertDialog({
      symbol: chart.symbol,
      price: last?.c,
      scriptConditions,
      onSubmit: (alert) => {
        this.alertManager.add(alert);
        this.renderAlerts();
        toast('Alert created', `${alert.name} (${alert.kind === 'script' ? 'script' : alert.condition})`, 'success', 3000);
        this.openBottom('console');
      },
    });
  }

  /* ---------------- replay ---------------- */

  buildReplayBar() {
    $('#rpPlay').addEventListener('click', () => this.toggleReplayPlay());
    $('#rpStep').addEventListener('click', () => this.replayStep(1));
    $('#rpStepBack').addEventListener('click', () => this.replayStep(-1));
    $('#rpClose').addEventListener('click', () => this.exitReplay());
    $('#rpRealtime').addEventListener('click', () => this.replayToRealtime());
    $('#rpSlider').addEventListener('input', (e) => {
      const chart = this.activePane?.chart;
      if (!chart) return;
      const total = chart.bars.length;
      const count = Math.max(2, Math.round((Number(e.target.value) / 100) * total));
      this.setReplayCount(count);
    });
    $$('#rpSpeed .btn').forEach((b) =>
      b.addEventListener('click', () => {
        $$('#rpSpeed .btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.replay.speed = Number(b.dataset.speed);
        if (this.replay.playing) {
          this.stopReplayTimer();
          this.startReplayTimer();
        }
      })
    );
  }

  toggleReplay() {
    if (this.replay.active) this.exitReplay();
    else this.enterReplay();
  }

  enterReplay() {
    const chart = this.activePane?.chart;
    if (!chart?.bars.length) {
      toast('Nothing to replay', 'Load a chart first.', 'error');
      return;
    }
    this.replay.active = true;
    const start = Math.max(10, Math.floor(chart.bars.length * 0.6));
    this.setReplayCount(start);
    $('#replayBar').classList.add('open');
    $('#btnReplay').classList.add('active');
    this.openBottom('console');
    this.log('info', `Replay started at bar ${start} of ${chart.bars.length}. Use ▶ to play or → to step.`);
    toast('Bar Replay', `Starting at bar ${start}. Adjust with the slider.`, 'info', 4000);
  }

  setReplayCount(count) {
    const chart = this.activePane?.chart;
    if (!chart) return;
    const total = chart.bars.length;
    const clamped = Math.max(2, Math.min(total, count));
    this.replay.count = clamped;
    chart.setReplay(clamped);
    const visible = Math.min(clamped, Math.max(30, Math.ceil(chart.viewport.barsVisible(chart.plotWidth))));
    chart.viewport.leftIndex = Math.max(0, clamped - visible + 5);
    chart.autoScale = true;
    chart.render();
    const slider = $('#rpSlider');
    if (slider) slider.value = String(Math.round((clamped / total) * 100));
    const bar = chart.bars[clamped - 1];
    $('#rpPosition').textContent = bar ? `${clamped}/${total} · ${formatDateMedium(bar.t, chart.timezone)}` : '—';
    this.refreshLegendExtras();
  }

  replayStep(delta) {
    const chart = this.activePane?.chart;
    if (!chart) return;
    if (!this.replay.active) this.enterReplay();
    this.setReplayCount((this.replay.count || chart.bars.length) + delta);
    this.refreshLegendExtras();
  }

  replayToRealtime() {
    const chart = this.activePane?.chart;
    if (!chart) return;
    this.setReplayCount(chart.bars.length);
    this.stopReplayTimer();
    this.replay.playing = false;
    $('#rpPlay').innerHTML = '';
    $('#rpPlay').appendChild(icon('play', 16));
  }

  toggleReplayPlay() {
    if (this.replay.playing) {
      this.stopReplayTimer();
      this.replay.playing = false;
      $('#rpPlay').innerHTML = '';
      $('#rpPlay').appendChild(icon('play', 16));
    } else {
      this.replay.playing = true;
      $('#rpPlay').innerHTML = '';
      $('#rpPlay').appendChild(icon('pause', 16));
      this.startReplayTimer();
    }
  }

  startReplayTimer() {
    this.stopReplayTimer();
    this.replay.timer = setInterval(() => {
      const chart = this.activePane?.chart;
      if (!chart) return;
      if (this.replay.count >= chart.bars.length) {
        this.stopReplayTimer();
        this.replay.playing = false;
        $('#rpPlay').innerHTML = '';
        $('#rpPlay').appendChild(icon('play', 16));
        toast('Replay finished', 'Reached the last bar.', 'info', 3000);
        return;
      }
      this.setReplayCount(this.replay.count + 1);
    }, this.replay.speed);
  }

  stopReplayTimer() {
    if (this.replay.timer) clearInterval(this.replay.timer);
    this.replay.timer = null;
  }

  exitReplay() {
    this.stopReplayTimer();
    this.replay.active = false;
    this.replay.playing = false;
    $('#replayBar').classList.remove('open');
    $('#btnReplay').classList.remove('active');
    $('#rpPlay').innerHTML = '';
    $('#rpPlay').appendChild(icon('play', 16));
    for (const p of this.panes) {
      p.chart.setReplay(null);
      p.chart.scrollToRealtime();
    }
    this.refreshLegendExtras();
    this.log('info', 'Replay ended.');
  }

  /* ---------------- legend click (gear settings / remove) ---------------- */

  onLegendClick(pane, info) {
    if (info.kind === 'remove') {
      pane.chart.removeIndicator(info.id);
      this.renderIndicatorSettings();
      this.persistState();
    } else if (info.kind === 'settings') {
      const ind = pane.chart.indicators.find((i) => i.id === info.id);
      if (ind) this.openIndicatorInputs(pane, ind);
    }
  }

  /* ---------------- crosshair sync ---------------- */

  onCrosshairMove(sourcePane, info) {
    this.refreshLegendExtras();
    if (!this.state.sync.crosshair) return;
    if (info.index === null || info.index === undefined) {
      // Source pane left the chart area; clear every other pane's crosshair.
      for (const p of this.panes) if (p !== sourcePane) {
        p.chart.crosshair.visible = false;
        p.chart.render();
      }
      return;
    }
    // TradingView-style: snap the crosshair to the same bar *time* on every
    // other pane. We translate the source's bar index to a timestamp first so
    // each pane can find its own bar that contains that timestamp — this is
    // what makes multi-timeframe layouts usable.
    const sourceBar = sourcePane.chart.bars[info.index];
    const sourceTime = sourceBar ? sourceBar.t : null;
    for (const p of this.panes) {
      if (p === sourcePane) continue;
      const chart = p.chart;
      if (!chart.bars.length) continue;
      // Find the index of the last bar whose time <= sourceTime.
      let targetIdx = sourceTime == null
        ? Math.min(info.index, chart.bars.length - 1)
        : 0;
      if (sourceTime != null) {
        let lo = 0, hi = chart.bars.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (chart.bars[mid].t <= sourceTime) { found = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        targetIdx = found >= 0 ? found : Math.min(info.index, chart.bars.length - 1);
      }
      chart.crosshair.visible = true;
      chart.crosshair.x = chart.xAtIndex(targetIdx);
      chart.crosshair.snappedIndex = targetIdx;
      chart.crosshair.y = chart.yAtPrice(chart.bars[targetIdx]?.c ?? 0);
      chart._renderCrosshair();
    }
  }

  refreshLegendExtras() {
    for (const p of this.panes) p.chart._renderLegend();
  }

  /**
   * Pine v6 multi-pane sync: when one pane pans/zooms, propagate the new view
   * to every other pane if sync.timeRange is on.
   */
  onPaneViewChange(sourcePane, info) {
    if (!this.state.sync.timeRange) return;
    for (const p of this.panes) {
      if (p === sourcePane) continue;
      const vp = p.chart.viewport;
      vp.leftIndex = info.from;
      vp.barSpacing = info.spacing;
      p.chart.render();
    }
  }

  /* ---------------- context menu ---------------- */

  onChartContextMenu(pane, e, hit) {
    this.setActivePane(pane);
    const chart = pane.chart;
    const items = [];
    if (hit?.kind === 'drawing') {
      items.push(
        { label: 'Bring to front', icon: 'eye', onClick: () => moveToEnd(chart.drawings, hit.drawing) },
        { label: 'Duplicate', icon: 'plus', onClick: () => chart.addDrawing({ ...hit.drawing, id: undefined, x1: hit.drawing.x1 + 5, x2: (hit.drawing.x2 ?? hit.drawing.x1) + 5 }) },
        { separator: true },
        { label: 'Remove drawing', icon: 'trash', danger: true, onClick: () => chart.removeDrawing(hit.drawing.id) }
      );
    } else {
      items.push(
        { label: 'Add indicator…', icon: 'indicator', kbd: 'Ctrl+I', onClick: () => this.openIndicatorDialog() },
        { label: 'Add alert on ' + chart.symbol, icon: 'alert', kbd: 'Ctrl+A', onClick: () => this.createAlert() },
        { separator: true },
        { label: 'Reset view', icon: 'chart', onClick: () => chart.resetView() },
        { label: 'Fit content', onClick: () => chart.fitContent() },
        { label: 'Go to realtime', onClick: () => chart.scrollToRealtime() },
        { separator: true },
        { label: chart.logScale ? 'Linear scale' : 'Logarithmic scale', onClick: () => this.toggleScale('log') },
        { label: chart.percentScale ? 'Price scale' : 'Percent scale', onClick: () => this.toggleScale('percent') },
        { label: chart.showVolume ? 'Hide volume' : 'Show volume', onClick: () => this.toggleVolume() },
        { separator: true },
        { label: 'Screenshot', icon: 'camera', onClick: () => this.screenshot() },
        { label: 'Export bars (CSV)', icon: 'download', onClick: () => this.exportCsv() }
      );
    }
    showContextMenu(e.clientX, e.clientY, items);
    void hideContextMenu;
  }

  /* ---------------- console log ---------------- */

  log(level, message) {
    const entry = { time: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    window.dispatchEvent(new CustomEvent('log:append', { detail: entry }));
    if (level === 'error') console.error('[pine]', message);
    const list = $('#logList');
    if (!list) return;
    const node = el('div', { class: `log-line ${level}` }, [
      el('span', { class: 'l-time', text: formatTime(entry.time, this.activePane?.chart.timezone, { withSeconds: true }) }),
      el('span', { class: 'l-msg', text: message }),
    ]);
    list.appendChild(node);
    while (list.children.length > 400) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  updateStatus(text) {
    this.statusText = text;
    const node = this.activePane?.chart?.statusEl;
    if (node) node.textContent = text;
  }

  setFeedStatus(online) {
    const dot = $('#feedDot');
    const txt = $('#feedText');
    if (dot) dot.classList.toggle('offline', !online);
    if (txt) txt.textContent = online ? 'live' : 'offline';
  }

  /* ---------------- keyboard ---------------- */

  bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        this.openIndicatorDialog();
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        this.openBottom('editor', { tall: true });
        this.editor.focus();
        return;
      }
      if (mod && e.key.toLowerCase() === 'a' && !typing) {
        e.preventDefault();
        this.createAlert();
        return;
      }
      if (typing) return;

      switch (e.key) {
        case 'Escape':
          if (this.state.masterFullscreen) this.toggleFullscreen();
          else if (this.state.activeTool) this.onRailClick('cursor');
          else if (this.replay.active) this.exitReplay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (this.replay.active) this.replayStep(-1);
          else this.activePane?.chart.scrollByBars(-Math.max(1, Math.round(3)));
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (this.replay.active) this.replayStep(1);
          else this.activePane?.chart.scrollByBars(Math.max(1, Math.round(3)));
          break;
        case '+':
        case '=':
          this.activePane?.chart.zoomIn();
          break;
        case '-':
        case '_':
          this.activePane?.chart.zoomOut();
          break;
        case ' ':
          e.preventDefault();
          if (this.replay.active) this.toggleReplayPlay();
          break;
        case 'r':
        case 'R':
          this.toggleReplay();
          break;
        case 'f':
        case 'F':
          // Don't trigger fullscreen when typing in an input.
          if (!typing) this.toggleFullscreen();
          break;
        case 'Delete':
        case 'Backspace': {
          const chart = this.activePane?.chart;
          if (chart?.selectedDrawingId) chart.removeDrawing(chart.selectedDrawingId);
          break;
        }
        case '\\':
          // TradingView uses backslash to toggle the right sidebar.
          e.preventDefault();
          this.toggleSidebar();
          break;
        default: {
          // Drawing tool shortcuts
          const map = { t: 'trendline', a: 'arrow', e: 'extended', v: 'vline', h: 'hline', r2: 'rect', f: 'fib', x: 'text', m: 'measure' };
          const key = e.key.toLowerCase();
          if (map[key] && key !== 'r') this.onRailClick(map[key]);
          break;
        }
      }
    });
  }
}

/* ================================================================== *
 * Built-in indicator maths
 * ================================================================== */

function makeBuiltinCompute(key, params) {
  return (bars) => {
    const closes = bars.map((b) => b.c);
    const out = emptyOutputs(bars.length);
    const pushPlot = (title, values, color, linewidth = 1.4, style = 0, colors = null) => {
      out.plots.push({
        id: `p_${out.plots.length}`,
        title,
        values,
        colors: colors || values.map(() => (color ? { __color: true, value: stripHash(color), transparency: 0 } : null)),
        linewidth,
        style,
        offset: 0,
        display: 1,
        histbase: 0,
      });
    };

    switch (key) {
      case 'sma':
      case 'ema':
      case 'wma': {
        const n = params.length;
        const vals = key === 'sma' ? sma(closes, n) : key === 'ema' ? ema(closes, n) : wma(closes, n);
        pushPlot(`${key.toUpperCase()} ${n}`, vals, '#2962ff', 1.8);
        break;
      }
      case 'bb': {
        const n = params.length;
        const mult = params.mult;
        const basis = sma(closes, n);
        const upper = new Array(bars.length).fill(null);
        const lower = new Array(bars.length).fill(null);
        for (let i = n - 1; i < bars.length; i++) {
          if (basis[i] === null) continue;
          let sum = 0;
          for (let k = 0; k < n; k++) sum += (closes[i - k] - basis[i]) ** 2;
          const sd = Math.sqrt(sum / n);
          upper[i] = basis[i] + mult * sd;
          lower[i] = basis[i] - mult * sd;
        }
        pushPlot(`Upper ${n}`, upper, '#787b86', 1.2);
        pushPlot(`Basis ${n}`, basis, '#ff9800', 1.4);
        pushPlot(`Lower ${n}`, lower, '#787b86', 1.2);
        out.fills.push({
          id: 'fill_bb',
          a: out.plots[0],
          b: out.plots[2],
          color: { __color: true, value: '2962ff', transparency: 92 },
          transp: 92,
          title: 'BB',
        });
        break;
      }
      case 'vwap': {
        const vals = new Array(bars.length).fill(null);
        let pv = 0;
        let vol = 0;
        let lastDay = null;
        for (let i = 0; i < bars.length; i++) {
          const d = new Date(bars[i].t).toISOString().slice(0, 10);
          if (d !== lastDay) {
            pv = 0;
            vol = 0;
            lastDay = d;
          }
          const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
          pv += tp * bars[i].v;
          vol += bars[i].v;
          vals[i] = vol ? pv / vol : null;
        }
        pushPlot('VWAP', vals, '#9c27b0', 1.6);
        break;
      }
      case 'rsi': {
        const n = params.length;
        const vals = rsi(closes, n);
        pushPlot(`RSI ${n}`, vals, '#9c27b0', 1.6);
        out.hlines.push(
          { id: 'h70', price: 70, title: '70', color: { __color: true, value: 'f23645', transparency: 40 }, linestyle: 'dashed', linewidth: 1, display: 1 },
          { id: 'h50', price: 50, title: '50', color: { __color: true, value: '787b86', transparency: 50 }, linestyle: 'dotted', linewidth: 1, display: 1 },
          { id: 'h30', price: 30, title: '30', color: { __color: true, value: '089981', transparency: 40 }, linestyle: 'dashed', linewidth: 1, display: 1 }
        );
        break;
      }
      case 'macd': {
        const { macdLine, signalLine, hist } = macd(closes, params.fast, params.slow, params.signal);
        pushPlot('MACD', macdLine, '#2962ff', 1.6);
        pushPlot('Signal', signalLine, '#ff9800', 1.6);
        const colors = hist.map((v) => (v === null ? null : { __color: true, value: v >= 0 ? '089981' : 'f23645', transparency: 30 }));
        pushPlot('Histogram', hist, null, 1, 5, colors);
        out.hlines.push({ id: 'h0', price: 0, title: '', color: { __color: true, value: '787b86', transparency: 50 }, linestyle: 'solid', linewidth: 1, display: 1 });
        break;
      }
      case 'stoch': {
        const k = stoch(bars, params.k);
        const d = sma(k.map((v) => (v === null ? NaN : v)), params.d).map((v) => (Number.isNaN(v) ? null : v));
        pushPlot(`%K ${params.k}`, k, '#2962ff', 1.5);
        pushPlot(`%D ${params.d}`, d, '#ff9800', 1.5);
        out.hlines.push(
          { id: 'h80', price: 80, title: '80', color: { __color: true, value: 'f23645', transparency: 50 }, linestyle: 'dashed', linewidth: 1, display: 1 },
          { id: 'h20', price: 20, title: '20', color: { __color: true, value: '089981', transparency: 50 }, linestyle: 'dashed', linewidth: 1, display: 1 }
        );
        break;
      }
      case 'atr': {
        const vals = atr(bars, params.length);
        pushPlot(`ATR ${params.length}`, vals, '#ff9800', 1.5);
        break;
      }
      case 'obv': {
        const vals = new Array(bars.length).fill(null);
        let acc = 0;
        for (let i = 0; i < bars.length; i++) {
          if (i > 0) {
            if (bars[i].c > bars[i - 1].c) acc += bars[i].v;
            else if (bars[i].c < bars[i - 1].c) acc -= bars[i].v;
          }
          vals[i] = acc;
        }
        pushPlot('OBV', vals, '#00bcd4', 1.5);
        break;
      }
      case 'cci': {
        const n = params.length;
        const tp = bars.map((b) => (b.h + b.l + b.c) / 3);
        const m = sma(tp, n);
        const vals = new Array(bars.length).fill(null);
        for (let i = n - 1; i < bars.length; i++) {
          if (m[i] === null) continue;
          let dev = 0;
          for (let k = 0; k < n; k++) dev += Math.abs(tp[i - k] - m[i]);
          const md = dev / n;
          vals[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
        }
        pushPlot(`CCI ${n}`, vals, '#e040fb', 1.5);
        out.hlines.push(
          { id: 'h100', price: 100, title: '', color: { __color: true, value: '787b86', transparency: 60 }, linestyle: 'dashed', linewidth: 1, display: 1 },
          { id: 'h_100', price: -100, title: '', color: { __color: true, value: '787b86', transparency: 60 }, linestyle: 'dashed', linewidth: 1, display: 1 }
        );
        break;
      }
      case 'mfi': {
        const n = params.length;
        const vals = new Array(bars.length).fill(null);
        const pos = new Array(bars.length).fill(0);
        const neg = new Array(bars.length).fill(0);
        for (let i = 1; i < bars.length; i++) {
          const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
          const prevTp = (bars[i - 1].h + bars[i - 1].l + bars[i - 1].c) / 3;
          const flow = tp * bars[i].v;
          if (tp > prevTp) pos[i] = flow;
          else if (tp < prevTp) neg[i] = flow;
        }
        for (let i = n; i < bars.length; i++) {
          let sp = 0;
          let sn = 0;
          for (let k = 0; k < n; k++) {
            sp += pos[i - k];
            sn += neg[i - k];
          }
          vals[i] = sn === 0 ? 100 : 100 - 100 / (1 + sp / sn);
        }
        pushPlot(`MFI ${n}`, vals, '#00bcd4', 1.5);
        break;
      }
      default:
        break;
    }
    out.scale = 'auto';
    return { ok: true, outputs: out, inputs: [], inputValues: {}, warnings: [], bars: bars.length };
  };
}

function emptyOutputs(n) {
  return {
    plots: [],
    hlines: [],
    fills: [],
    shapes: [],
    charShapes: [],
    candles: [],
    bgcolors: [],
    barcolors: [],
    plotcandles: [],
    lines: [],
    labels: [],
    boxes: [],
    tables: [],
    alertConditions: [],
    alerts: [],
    strategy: null,
    logs: [],
    warnings: [],
    n,
  };
}

function stripHash(color) {
  return String(color).replace('#', '').toLowerCase();
}

/* --- indicator maths ------------------------------------------------- */

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = null;
      continue;
    }
    sum += v;
    count++;
    if (i >= n) {
      const old = values[i - n];
      if (Number.isFinite(old)) {
        sum -= old;
        count--;
      }
    }
    out[i] = count >= n ? sum / n : null;
  }
  return out;
}

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (n + 1);
  let prev = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    if (prev === null) {
      sum += v;
      count++;
      if (count >= n) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function wma(values, n) {
  const out = new Array(values.length).fill(null);
  const denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const v = values[i - k];
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v * (n - k);
    }
    out[i] = ok ? sum / denom : null;
  }
  return out;
}

function rma(values, n) {
  const out = new Array(values.length).fill(null);
  const alpha = 1 / n;
  let prev = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    if (prev === null) {
      sum += v;
      count++;
      if (count >= n) {
        prev = sum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function rsi(values, n) {
  const ups = new Array(values.length).fill(NaN);
  const downs = new Array(values.length).fill(NaN);
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    ups[i] = diff > 0 ? diff : 0;
    downs[i] = diff < 0 ? -diff : 0;
  }
  const upAvg = rma(ups, n);
  const downAvg = rma(downs, n);
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (upAvg[i] === null || downAvg[i] === null) continue;
    out[i] = downAvg[i] === 0 ? 100 : 100 - 100 / (1 + upAvg[i] / downAvg[i]);
  }
  return out;
}

function macd(values, fast, slow, signal) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const macdLine = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null));
  const signalLine = ema(macdLine.map((v) => (v === null ? NaN : v)), signal).map((v) => (Number.isNaN(v) ? null : v));
  const hist = macdLine.map((v, i) => (v !== null && signalLine[i] !== null ? v - signalLine[i] : null));
  return { macdLine, signalLine, hist };
}

function stoch(bars, n) {
  const out = new Array(bars.length).fill(null);
  for (let i = n - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let k = 0; k < n; k++) {
      hh = Math.max(hh, bars[i - k].h);
      ll = Math.min(ll, bars[i - k].l);
    }
    out[i] = hh === ll ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100;
  }
  return out;
}

function atr(bars, n) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
  return rma(tr, n);
}

/* ================================================================== *
 * Small helpers
 * ================================================================== */

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function moveToEnd(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) {
    arr.splice(i, 1);
    arr.push(item);
  }
}

function sparklineSvg(closes) {
  if (!closes || closes.length < 2) return '';
  const w = 44;
  const h = 18;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((c, i) => `${((i / (closes.length - 1)) * w).toFixed(1)},${(h - ((c - min) / span) * (h - 2) - 1).toFixed(1)}`);
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? '#089981' : '#f23645';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.2"/></svg>`;
}

/* ================================================================== *
 * Start
 * ================================================================== */

const app = new App();
window.app = app;
app.boot().catch((err) => {
  console.error('boot failed', err);
  toast('Startup problem', err.message, 'error', 9000);
});

export { app };
void escapeHtml;
