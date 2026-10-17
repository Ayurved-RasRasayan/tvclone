/**
 * Volume Delta approximation.
 *
 * True volume delta requires tick-level bid/ask aggressor data. Without that
 * feed (Yahoo Finance, most retail data sources), delta can only be estimated
 * from the bar's OHLCV geometry.
 *
 * Two approximation methods are provided:
 *
 *   'close-position' (default, more informative)
 *     buyShare  = (close - low) / (high - low)   -> close near high = buyers
 *     sellShare = (high - close) / (high - low)  -> close near low  = sellers
 *     delta     = volume * (2 * buyShare - 1)
 *     No-range bars (h === l) split 50/50.
 *     This is the method used by KuCoin, Overcharts, and the majority of
 *     TradingView community "CVD proxy" scripts.
 *
 *   'bar-direction' (simpler, coarser)
 *     close > open  -> entire bar volume attributed to buy  (+volume)
 *     close < open  -> entire bar volume attributed to sell (-volume)
 *     close == open -> use previous close as tie-breaker (tick rule)
 *
 * Both are estimates, not measurements. Documented in the README.
 */

export const DELTA_METHODS = ['close-position', 'bar-direction'];

/**
 * Compute buy/sell volume + delta for a single bar.
 * @param {{o:number,h:number,l:number,c:number,v:number}} bar
 * @param {'close-position'|'bar-direction'} method
 * @param {number|null} prevClose  previous bar's close (used by bar-direction tie-break)
 * @returns {{buy:number, sell:number, delta:number, buyShare:number}}
 */
export function computeBarDelta(bar, method = 'close-position', prevClose = null) {
  if (!bar) return { buy: 0, sell: 0, delta: 0, buyShare: 0.5 };
  const v = Number(bar.v);
  if (!Number.isFinite(v) || v <= 0) return { buy: 0, sell: 0, delta: 0, buyShare: 0.5 };

  if (method === 'bar-direction') {
    const o = Number(bar.o);
    const c = Number(bar.c);
    let sign;
    if (c > o) sign = 1;
    else if (c < o) sign = -1;
    else if (Number.isFinite(prevClose)) sign = c > prevClose ? 1 : c < prevClose ? -1 : 0;
    else sign = 0;
    const buy = sign > 0 ? v : sign === 0 ? v / 2 : 0;
    const sell = sign < 0 ? v : sign === 0 ? v / 2 : 0;
    return { buy, sell, delta: buy - sell, buyShare: buy / v };
  }

  // close-position (default)
  const h = Number(bar.h);
  const l = Number(bar.l);
  const c = Number(bar.c);
  if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
    return { buy: 0, sell: 0, delta: 0, buyShare: 0.5 };
  }
  const range = h - l;
  if (range <= 0) {
    return { buy: v / 2, sell: v / 2, delta: 0, buyShare: 0.5 };
  }
  const buyShare = Math.max(0, Math.min(1, (c - l) / range));
  const buy = v * buyShare;
  const sell = v * (1 - buyShare);
  return { buy, sell, delta: buy - sell, buyShare };
}

/**
 * Compute per-bar delta + running cumulative delta across a series.
 * @param {Array} bars
 * @param {{method?:string}} [options]
 * @returns {{bars: Array<{delta:number,buy:number,sell:number,cvd:number}>, cvd: number[], deltas: number[], method: string}}
 */
export function computeDeltaSeries(bars, options = {}) {
  const method = DELTA_METHODS.includes(options.method) ? options.method : 'close-position';
  if (!Array.isArray(bars) || bars.length === 0) {
    return { bars: [], cvd: [], deltas: [], method };
  }
  const perBar = new Array(bars.length);
  const deltas = new Array(bars.length);
  const cvd = new Array(bars.length);
  let running = 0;
  for (let i = 0; i < bars.length; i++) {
    const prevClose = i > 0 ? bars[i - 1].c : null;
    const d = computeBarDelta(bars[i], method, prevClose);
    perBar[i] = d;
    deltas[i] = d.delta;
    running += d.delta;
    cvd[i] = running;
  }
  return { bars: perBar, cvd, deltas, method };
}

/**
 * Compute the visible-range min/max of cumulative delta (for scaling).
 * Returns nulls if the range is empty/invalid.
 */
export function cvdRange(bars, options = {}) {
  const series = computeDeltaSeries(bars, options);
  if (series.cvd.length === 0) return { min: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (const v of series.cvd) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: null, max: null };
  return { min, max };
}
