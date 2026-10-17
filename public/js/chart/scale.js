/**
 * Chart scales and the viewport model (zoom / pan / autoscale).
 */

export const THEME = {
  bg: '#131722',
  paneBg: '#131722',
  grid: '#1e222d',
  gridStrong: '#2a2e39',
  border: '#2a2e39',
  text: '#d1d4dc',
  textDim: '#787b86',
  textFaint: '#5d606b',
  accent: '#2962ff',
  up: '#089981',
  down: '#f23645',
  crosshair: '#9598a1',
  tooltipBg: 'rgba(30,34,45,0.96)',
  selection: 'rgba(41,98,255,0.18)',
  mono: "11px ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  font: "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontBold: "600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  fontSmall: "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
};

/* ------------------------------------------------------------------ *
 * Price scale
 * ------------------------------------------------------------------ */

export class PriceScale {
  /**
   * @param {'linear'|'log'|'percent'|'indexed'} mode
   */
  constructor(mode = 'linear') {
    this.mode = mode;
    this.top = 0; // highest value at the top of the pane
    this.bottom = 1; // lowest value at the bottom of the pane
    this.marginTop = 0.08;
    this.marginBottom = 0.08;
    this.baseValue = null; // for percent/indexed modes
    this.inverted = false;
  }

  setRange(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min === max) {
      const pad = Math.abs(min) * 0.01 || 1;
      min -= pad;
      max += pad;
    }
    const pad = (max - min) * 0.5;
    this.rawMin = min;
    this.rawMax = max;
    void pad;
    this.top = max + (max - min) * this.marginTop;
    this.bottom = min - (max - min) * this.marginBottom;
  }

  /** Fit a range with explicit margins already applied. */
  fit(min, max, padRatio = 0.08) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    if (min === max) {
      const pad = Math.abs(min) * 0.01 || 1;
      min -= pad;
      max += pad;
    }
    const pad = (max - min) * padRatio;
    this.bottom = min - pad;
    this.top = max + pad;
  }

  /** Transform a data value into a 0..1 fraction from the bottom. */
  toRatio(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return NaN;
    const { top, bottom } = this;
    const v = this.mode === 'log' ? logify(value) : this.mode === 'percent' || this.mode === 'indexed' ? this.percentify(value) : value;
    const t = this.mode === 'log' ? logify(top) : this.mode === 'percent' || this.mode === 'indexed' ? this.percentify(top) : top;
    const b = this.mode === 'log' ? logify(bottom) : this.mode === 'percent' || this.mode === 'indexed' ? this.percentify(bottom) : bottom;
    if (t === b) return 0.5;
    const r = (v - b) / (t - b);
    return this.inverted ? 1 - r : r;
  }

  /** Transform a 0..1 fraction from the bottom back into a data value. */
  fromRatio(ratio) {
    const r = this.inverted ? 1 - ratio : ratio;
    const { top, bottom } = this;
    if (this.mode === 'log') {
      const lt = logify(top);
      const lb = logify(bottom);
      return Math.exp(lb + (lt - lb) * r);
    }
    if (this.mode === 'percent' || this.mode === 'indexed') {
      const base = this.baseValue || 1;
      const pt = (top / base - 1) * 100;
      const pb = (bottom / base - 1) * 100;
      return base * (1 + (pb + (pt - pb) * r) / 100);
    }
    return bottom + (top - bottom) * r;
  }

  percentify(v) {
    const base = this.baseValue || 1;
    return (v / base - 1) * 100;
  }

  /** Formatted axis label for a value. */
  label(value, decimals) {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    if (this.mode === 'percent' || this.mode === 'indexed') {
      const pct = this.percentify(value);
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    }
    const a = Math.abs(value);
    let d = decimals ?? 2;
    if (a !== 0 && a < 0.01) d = Math.max(d, 6);
    return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
}

function logify(v) {
  if (v === null || v === undefined) return NaN;
  const a = Math.max(1e-12, Math.abs(v));
  return Math.log(a) * Math.sign(v || 1);
}

/* ------------------------------------------------------------------ *
 * Time scale / viewport
 * ------------------------------------------------------------------ */

export class Viewport {
  constructor() {
    this.barSpacing = 8; // pixels per bar
    this.rightOffset = 8; // bars of empty space to the right of the last bar
    this.leftIndex = 0; // fractional bar index at the left edge of the plot area
    this.minSpacing = 0.02;
    this.maxSpacing = 160;
    this.followRight = true;
  }

  get rightIndex() {
    return this.leftIndex;
  }

  /** Bar index at a given x pixel. */
  indexAtX(x, plotWidth) {
    return this.leftIndex + x / this.barSpacing;
  }

  xAtIndex(index, plotWidth) {
    return (index - this.leftIndex) * this.barSpacing;
  }

  /** Number of bars that fit in `plotWidth` pixels. */
  barsVisible(plotWidth) {
    return plotWidth / this.barSpacing;
  }

  /** Scroll so that the most recent bar sits `rightOffset` bars from the right edge. */
  scrollToRight(plotWidth, barCount) {
    const visible = this.barsVisible(plotWidth);
    this.leftIndex = barCount + this.rightOffset - visible;
    this.clamp(plotWidth, barCount);
  }

  clamp(plotWidth, barCount) {
    const visible = this.barsVisible(plotWidth);
    const minLeft = -visible * 0.9;
    const maxLeft = barCount + this.rightOffset - visible * 0.1;
    if (this.leftIndex < minLeft) this.leftIndex = minLeft;
    if (this.leftIndex > maxLeft) this.leftIndex = maxLeft;
    void visible;
  }

  /**
   * Zoom by `factor` while keeping the bar at index `anchorIndex` under the
   * same pixel. Solving (anchor - left) * spacing = const gives:
   *   newLeft = anchor - (anchor - left) * (oldSpacing / newSpacing)
   */
  zoomAt(anchorIndex, factor) {
    const oldSpacing = this.barSpacing;
    const next = Math.max(this.minSpacing, Math.min(this.maxSpacing, oldSpacing * factor));
    if (next === oldSpacing) return;
    const applied = oldSpacing / next;
    this.barSpacing = next;
    this.leftIndex = anchorIndex - (anchorIndex - this.leftIndex) * applied;
  }

  panByPixels(dx, plotWidth, barCount) {
    this.leftIndex -= dx / this.barSpacing;
    this.clamp(plotWidth, barCount);
  }
}

/* ------------------------------------------------------------------ *
 * Tick generation
 * ------------------------------------------------------------------ */

const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** "Nice" tick values covering [min, max] for about `target` ticks. */
export function niceTicks(min, max, target = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const span = max - min;
  const rough = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  let step = mag;
  for (const s of NICE_STEPS) {
    if (mag * s >= rough) {
      step = mag * s;
      break;
    }
  }
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step);
    if (out.length > 200) break;
  }
  return out;
}

/** Log-scale aware ticks. */
export function niceLogTicks(min, max, target = 6) {
  const lo = Math.log10(Math.max(1e-12, min));
  const hi = Math.log10(Math.max(1e-12, max));
  const ticks = [];
  const startExp = Math.floor(lo);
  const endExp = Math.ceil(hi);
  for (let e = startExp; e <= endExp; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) ticks.push(v);
    }
  }
  if (ticks.length <= target * 4) return ticks;
  const stride = Math.ceil(ticks.length / target);
  return ticks.filter((_, i) => i % stride === 0);
}

/**
 * Choose time-axis ticks. Uses calendar-aware spacing so labels land on
 * sensible boundaries (start of day/week/month) rather than arbitrary offsets.
 */
export function timeTicks(bars, fromIndex, toIndex, approxCount, timeZone) {
  const out = [];
  if (!bars.length) return out;
  const from = Math.max(0, Math.floor(fromIndex));
  const to = Math.min(bars.length - 1, Math.ceil(toIndex));
  if (to < from) return out;
  const span = to - from;
  const stride = Math.max(1, Math.round(span / Math.max(1, approxCount)));

  let lastKey = null;
  for (let i = from; i <= to; i++) {
    const bar = bars[i];
    if (!bar) continue;
    const forced = i === from || i === to || i % stride === 0;
    if (!forced) continue;
    const key = calendarKey(bar.t, timeZone, stride, bars, from, to);
    if (key !== lastKey) {
      out.push({ index: i, time: bar.t });
      lastKey = key;
    }
  }
  return out;
}

function calendarKey(ms, timeZone, stride, bars, from, to) {
  const p = tzPartsLocal(ms, timeZone);
  // Decide the granularity from the total visible span.
  const totalMs = (bars[to]?.t ?? ms) - (bars[from]?.t ?? ms);
  if (totalMs < 2 * 86400000) return `${p.y}-${p.mo}-${p.d}-${p.h}`;
  if (totalMs < 90 * 86400000) return `${p.y}-${p.mo}-${p.d}`;
  if (totalMs < 3 * 365 * 86400000) return `${p.y}-${p.mo}`;
  void stride;
  return `${p.y}`;
}

const tzCache = new Map();
function tzPartsLocal(ms, timeZone) {
  let fmt = tzCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    });
    tzCache.set(timeZone, fmt);
  }
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24 };
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Axis label text for a tick, given the visible span. */
export function tickLabel(ms, timeZone, spanMs) {
  const p = tzPartsLocal(ms, timeZone);
  const d = new Date(ms);
  const wd = WEEKDAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  void d;
  if (spanMs < 2 * 86400000) {
    return `${String(p.h).padStart(2, '0')}:${String(tzPartsLocal(ms, timeZone).h).padStart(2, '0')}`.length
      ? `${String(p.h).padStart(2, '0')}:00`
      : `${String(p.h).padStart(2, '0')}:00`;
  }
  if (spanMs < 30 * 86400000) return `${p.d} ${MONTHS[p.mo - 1]}`;
  if (spanMs < 400 * 86400000) return `${MONTHS[p.mo - 1]} ${String(p.y).slice(2)}`;
  return String(p.y);
}

/** Full label including time, used for sub-tick labels. */
export function tickLabelWithTime(ms, timeZone, spanMs) {
  const p = tzPartsLocal(ms, timeZone);
  const minuteFmt = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC', minute: '2-digit', hour12: false });
  const minute = minuteFmt.formatToParts(new Date(ms)).find((x) => x.type === 'minute')?.value ?? '00';
  if (spanMs < 2 * 86400000) return `${String(p.h).padStart(2, '0')}:${minute}`;
  if (spanMs < 30 * 86400000) return `${p.d} ${MONTHS[p.mo - 1]}`;
  if (spanMs < 400 * 86400000) return `${MONTHS[p.mo - 1]} ${String(p.y).slice(2)}`;
  return String(p.y);
}
