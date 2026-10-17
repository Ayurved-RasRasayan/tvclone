/**
 * Pine Script built-in library.
 *
 * Every builtin is `(ctx) => value` where ctx is provided by the interpreter:
 *   ctx.interp, ctx.positional, ctx.named, ctx.bar, ctx.node,
 *   ctx.num(v,d), ctx.bool(v,d), ctx.str(v,d)
 */
import {
  Series,
  PineArray,
  PineMatrix,
  PineMap,
  PineRuntimeError,
  NA,
  bindArgs,
} from './runtime.js';
import {
  PineColor,
  makeColor,
  colorNamespace,
  hexFromRgb,
  plotStyle,
  shapeStyle,
  lineStyle,
  sizeStyle,
  positionStyle,
  textStyle,
  extendStyle,
  xlocStyle,
  ylocStyle,
  displayStyle,
  scaleStyle,
  barmergeGaps,
  barmergeLookahead,
  currencyStyle,
  orderStyle,
  directionStyle,
  alertFreqStyle,
  mathNamespaceExtras,
} from './values.js';

export const BUILTINS = new Map();

const def = (name, fn) => BUILTINS.set(name, fn);
const defAlias = (names, fn) => names.forEach((n) => BUILTINS.set(n, fn));

/* ================================================================== *
 * helpers
 * ================================================================== */

function context(ctx, spec, defaults = {}) {
  const out = {};
  const pos = ctx.positional;
  const named = ctx.named;
  let pi = 0;
  for (const key of spec) {
    if (pi < pos.length) out[key] = pos[pi++];
    else if (key in named) out[key] = named[key];
    else out[key] = defaults[key] !== undefined ? defaults[key] : null;
  }
  out.__named = named;
  out.__extra = pos.slice(pi);
  return out;
}

const isNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

function num(ctx, v, dflt = NaN) {
  const n = ctx.interp.toNum(v);
  return Number.isNaN(n) ? dflt : n;
}
function boolv(ctx, v, dflt = false) {
  return v === null || v === undefined ? dflt : ctx.interp.toBool(v);
}
function strv(ctx, v, dflt = '') {
  return v === null || v === undefined ? dflt : ctx.interp.toStr(v);
}
function colorv(v, dflt = null) {
  if (v === null || v === undefined) return dflt;
  if (v instanceof PineColor) return v;
  // Pine color literal from the parser: {__color: "00ff00"}
  if (v && typeof v === 'object' && v.__color) return makeColor(v.__color);
  return makeColor(v);
}

/** Read the value of a series-like argument at an absolute bar index. */
function at(v, i) {
  if (v && v.__rawSeries) v = v.__rawSeries;
  if (v instanceof Series) {
    // FIX A (optimized): Ring-buffer access. Fast path: if i is within the
    // LOOKBACK window AND i < barCount, use direct indexing (no modulo).
    // Slow path: modular indexing for historical reads older than LOOKBACK.
    if (i < 0 || i >= v.barCount) return null;
    const LB = Series.LOOKBACK;
    const ri = i < LB ? i : i % LB;
    const x = v.values[ri];
    if (x !== x) {  // NaN check (faster than Number.isNaN)
      // Check non-numeric side-Map.
      if (v.__interp && v.__interp._nonNumeric) {
        const nv = v.__interp._nonNumeric.get(v.__slotIdx * LB + ri);
        if (nv !== undefined) return nv;
      }
      return null;
    }
    return x;
  }
  if (Array.isArray(v)) return i < 0 || i >= v.length ? null : v[i];
  return v;
}

function len(ctx, v, dflt = 14) {
  const n = Math.floor(num(ctx, v, NaN));
  if (!Number.isFinite(n) || n < 0) return dflt;
  return n;
}

/** Read-only access to the host bar data for an interpreter. */
function barsOf(interp) {
  return interp.bars;
}

/* ------------------------------------------------------------------ *
 * Per-call-site state (the closure mechanism)
 * ------------------------------------------------------------------ */

function withState(ctx, init, fn) {
  const interp = ctx.interp;
  const key = ctx.node.id;
  let st = interp.closures.get(key);
  if (!st || (ctx.bar === 0 && st.bar > 0)) {
    st = { bar: -1, __key: key };
    init(st, interp);
    interp.closures.set(key, st);
  }
  st.bar = ctx.bar;
  return fn(st);
}

/** Rolling-window state helper. */
function rolling(init, step) {
  return (ctx) => withState(ctx, init, (s) => step(ctx, s));
}

/* ================================================================== *
 * math namespace
 * ================================================================== */

def('math.abs', (c) => Math.abs(num(c, c.positional[0])));
def('math.max', (c) => {
  const vals = c.positional.map((v) => num(c, v)).filter((v) => !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : NaN;
});
def('math.min', (c) => {
  const vals = c.positional.map((v) => num(c, v)).filter((v) => !Number.isNaN(v));
  return vals.length ? Math.min(...vals) : NaN;
});
def('math.avg', (c) => {
  const vals = c.positional.map((v) => num(c, v)).filter((v) => !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
});
def('math.sum', (c) => {
  const vals = c.positional.map((v) => num(c, v)).filter((v) => !Number.isNaN(v));
  return vals.reduce((a, b) => a + b, 0);
});
def('math.sqrt', (c) => Math.sqrt(num(c, c.positional[0])));
def('math.pow', (c) => Math.pow(num(c, c.positional[0]), num(c, c.positional[1])));
def('math.exp', (c) => Math.exp(num(c, c.positional[0])));
def('math.log', (c) => Math.log(num(c, c.positional[0])));
def('math.log10', (c) => Math.log10(num(c, c.positional[0])));
def('math.sin', (c) => Math.sin(num(c, c.positional[0])));
def('math.cos', (c) => Math.cos(num(c, c.positional[0])));
def('math.tan', (c) => Math.tan(num(c, c.positional[0])));
def('math.asin', (c) => Math.asin(num(c, c.positional[0])));
def('math.acos', (c) => Math.acos(num(c, c.positional[0])));
def('math.atan', (c) => Math.atan(num(c, c.positional[0])));
def('math.floor', (c) => Math.floor(num(c, c.positional[0])));
def('math.ceil', (c) => Math.ceil(num(c, c.positional[0])));
def('math.round', (c) => {
  const x = num(c, c.positional[0]);
  const p = c.positional.length > 1 ? Math.floor(num(c, c.positional[1], 0)) : 0;
  const m = Math.pow(10, p);
  const r = Math.round(x * m) / m;
  // Pine rounds half away from zero for positive, ties away from zero
  return Object.is(r, -0) ? 0 : r;
});
def('math.round_to_mintick', (c) => {
  const x = num(c, c.positional[0]);
  const tick = c.interp.symbol?.mintick || 0.01;
  return Math.round(x / tick) * tick;
});
def('math.sign', (c) => Math.sign(num(c, c.positional[0])));
def('math.avg', (c) => {
  const vals = c.positional.map((v) => num(c, v)).filter((v) => !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
});
def('math.random', (c) => {
  const a = c.positional.length ? num(c, c.positional[0]) : 0;
  const b = c.positional.length > 1 ? num(c, c.positional[1]) : 1;
  return a + Math.random() * (b - a);
});
def('math.todegrees', (c) => (num(c, c.positional[0]) * 180) / Math.PI);
def('math.toradians', (c) => (num(c, c.positional[0]) * Math.PI) / 180);
def('math.isnan', (c) => Number.isNaN(num(c, c.positional[0])));
def('math.isfinite', (c) => Number.isFinite(num(c, c.positional[0])));
def('math.nan', () => NaN);

/* ================================================================== *
 * technical analysis
 * ================================================================== */

def('ta.sma', (c) => {
  const [src, length] = [c.positional[0], c.positional[1]];
  const n = Math.max(1, len(c, length, 14));
  // FIX B: Rolling sum — O(1) per bar instead of O(n).
  return withState(c, (s) => { s.sum = 0; s.queue = []; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) {
      // On na input, drain the queue to keep the window in sync.
      if (s.queue.length > 0) { s.sum -= s.queue.shift(); }
      return null;
    }
    const x = Number(v);
    s.sum += x;
    s.queue.push(x);
    if (s.queue.length > n) s.sum -= s.queue.shift();
    return s.queue.length === n ? s.sum / n : null;
  });
});

def('ta.ema', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 9));
  const alpha = 2 / (n + 1);
  return withState(c, (s) => { s.prev = null; s.sum = 0; s.count = 0; s.seeded = false; s.bar = -1; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return s.prev;
    if (!s.seeded) {
      s.sum += Number(v);
      s.count++;
      if (s.count < n) return null;
      s.prev = s.sum / n;
      s.seeded = true;
      return s.prev;
    }
    s.prev = alpha * Number(v) + (1 - alpha) * s.prev;
    return s.prev;
  });
});

def('ta.rma', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const alpha = 1 / n;
  return withState(c, (s) => { s.prev = null; s.sum = 0; s.count = 0; s.seeded = false; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return s.prev;
    if (!s.seeded) {
      s.sum += Number(v);
      s.count++;
      if (s.count < n) return null;
      s.prev = s.sum / n;
      s.seeded = true;
      return s.prev;
    }
    s.prev = alpha * Number(v) + (1 - alpha) * s.prev;
    return s.prev;
  });
});
defAlias(['ta.wma'], (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  return withState(c, () => {}, () => {
    let sum = 0;
    let wsum = 0;
    for (let k = 0; k < n; k++) {
      const v = at(src, c.bar - k);
      if (isNa(v)) return null;
      const w = n - k;
      sum += Number(v) * w;
      wsum += w;
    }
    return sum / wsum;
  });
});

def('ta.vwma', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 20));
  return withState(c, () => {}, () => {
    let sv = 0;
    let s = 0;
    for (let k = 0; k < n; k++) {
      const i = c.bar - k;
      if (i < 0) return null;
      const v = at(src, i);
      if (isNa(v)) return null;
      const vol = at(c.interp.globals.get('volume'), i) ?? 0;
      sv += Number(v) * vol;
      s += vol;
    }
    return s === 0 ? null : sv / s;
  });
});

def('ta.bb', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 20));
  const mult = num(c, c.positional[2], 2);
  const basisFn = BUILTINS.get('ta.sma');
  // ta.bb is stateless. Do NOT wrap in withState -- an empty init claims
  // the c.node.id slot, then ta.sma's withState (which inherits c.node via
  // { ...c }) finds the slot already allocated, skips its own init, and
  // crashes on s.queue.push() because s.queue was never set.
  const basis = basisFn({ ...c, positional: [src, n] });
  if (basis === null) return [null, null, null];
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return [null, null, null];
    sum += (Number(v) - basis) ** 2;
  }
  const dev = Math.sqrt(sum / n);
  return [basis + mult * dev, basis, basis - mult * dev];
});

def('ta.stdev', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 20));
  const biased = c.named.biased !== undefined ? boolv(c, c.named.biased) : c.positional[2] !== undefined ? boolv(c, c.positional[2]) : true;
  // FIX B: Rolling sum + sum-of-squares — O(1) per bar instead of O(n).
  return withState(c, (s) => { s.sum = 0; s.sumSq = 0; s.queue = []; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) {
      if (s.queue.length > 0) { const old = s.queue.shift(); s.sum -= old; s.sumSq -= old * old; }
      return null;
    }
    const x = Number(v);
    s.sum += x;
    s.sumSq += x * x;
    s.queue.push(x);
    if (s.queue.length > n) { const old = s.queue.shift(); s.sum -= old; s.sumSq -= old * old; }
    if (s.queue.length < n) return null;
    const mean = s.sum / n;
    const variance = (s.sumSq - s.sum * s.sum / n) / (biased ? n : n - 1);
    return Math.sqrt(Math.max(0, variance));
  });
});

def('ta.variance', (c) => {
  const sd = BUILTINS.get('ta.stdev')(c);
  return sd === null ? null : sd * sd;
});

def('ta.dev', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 20));
  const smaFn = BUILTINS.get('ta.sma');
  // Same slot-collision pattern as ta.bb -- nested ta.sma owns the slot.
  const m = smaFn({ ...c, positional: [src, n] });
  if (m === null) return null;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return null;
    sum += Math.abs(Number(v) - m);
  }
  return sum / n;
});

def('ta.change', (c) => {
  const src = c.positional[0];
  const n = c.positional.length > 1 ? Math.floor(num(c, c.positional[1], 1)) : 1;
  const cur = at(src, c.bar);
  const prev = at(src, c.bar - n);
  if (isNa(cur) || isNa(prev)) return null;
  if (typeof cur === 'string' || typeof prev === 'string') return cur === prev ? 0 : null;
  return Number(cur) - Number(prev);
});

def('ta.roc', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 9));
  const cur = at(src, c.bar);
  const prev = at(src, c.bar - n);
  if (isNa(cur) || isNa(prev) || prev === 0) return null;
  return ((Number(cur) - Number(prev)) / Number(prev)) * 100;
});

def('ta.mom', (c) => BUILTINS.get('ta.change')(c));

const findBarsFn = (findHigh, findLow) => (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 1));
  const v = at(src, c.bar - n);
  if (isNa(v)) return null;
  for (let k = 1; k <= n; k++) {
    const past = at(src, c.bar - n + k);
    if (isNa(past)) continue;
    if (findHigh && Number(past) > Number(v)) return null;
    if (findLow && Number(past) < Number(v)) return null;
  }
  return Number(v);
};
def('ta.highestbars', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  let best = -Infinity;
  let bestIdx = 0;
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) continue;
    if (Number(v) > best) {
      best = Number(v);
      bestIdx = -k;
    }
  }
  return best === -Infinity ? null : bestIdx;
});
def('ta.lowestbars', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  let best = Infinity;
  let bestIdx = 0;
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) continue;
    if (Number(v) < best) {
      best = Number(v);
      bestIdx = -k;
    }
  }
  return best === Infinity ? null : bestIdx;
});
def('ta.highest', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  // FIX B: Monotonic deque — O(1) amortized per bar instead of O(n).
  // Each value is pushed and popped at most once across the deque.
  return withState(c, (s) => { s.deque = []; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) {
      // Prune entries that are now out of window.
      while (s.deque.length && s.deque[0].bar <= c.bar - n) s.deque.shift();
      return s.deque.length ? s.deque[0].val : null;
    }
    const x = Number(v);
    // Remove elements smaller than current (they can never be max in window).
    while (s.deque.length && s.deque[s.deque.length - 1].val <= x) s.deque.pop();
    s.deque.push({ val: x, bar: c.bar });
    // Prune front if it's outside the window.
    while (s.deque.length && s.deque[0].bar <= c.bar - n) s.deque.shift();
    return s.deque.length ? s.deque[0].val : null;
  });
});
def('ta.lowest', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  // FIX B: Monotonic deque — O(1) amortized per bar instead of O(n).
  return withState(c, (s) => { s.deque = []; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) {
      while (s.deque.length && s.deque[0].bar <= c.bar - n) s.deque.shift();
      return s.deque.length ? s.deque[0].val : null;
    }
    const x = Number(v);
    while (s.deque.length && s.deque[s.deque.length - 1].val >= x) s.deque.pop();
    s.deque.push({ val: x, bar: c.bar });
    while (s.deque.length && s.deque[0].bar <= c.bar - n) s.deque.shift();
    return s.deque.length ? s.deque[0].val : null;
  });
});

const pivotFn = (isHigh) => (c) => {
  const src = c.positional[0];
  let left = Math.max(0, Math.floor(num(c, c.positional[1], 5)));
  let right = c.positional.length > 2 ? Math.max(0, Math.floor(num(c, c.positional[2], 5))) : left;
  if (c.named && c.named.leftbars !== undefined) left = Math.max(0, Math.floor(num(c, c.named.leftbars, 5)));
  if (c.named && c.named.rightbars !== undefined) right = Math.max(0, Math.floor(num(c, c.named.rightbars, 5)));
  // Value at the candidate bar, which is `right` bars ago.
  const v = at(src, c.bar - right);
  if (isNa(v)) return null;
  for (let k = 0; k <= left + right; k++) {
    const i = c.bar - right - left + k;
    if (i === c.bar - right) continue;
    const other = at(src, i);
    if (isNa(other)) continue;
    if (isHigh && Number(other) > Number(v)) return null;
    if (!isHigh && Number(other) < Number(v)) return null;
  }
  return Number(v);
};
def('ta.pivothigh', pivotFn(true));
def('ta.pivotlow', pivotFn(false));

def('ta.barssince', (c) => {
  const condSeries = c.positional[0];
  return withState(c, (s) => { s.since = null; }, (s) => {
    const v = at(condSeries, c.bar);
    if (!isNa(v) && ctx_bool(v)) {
      s.since = 0;
      return 0;
    }
    if (s.since === null) return null;
    s.since += 1;
    return s.since;
  });
});
function ctx_bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !!v;
}

def('ta.crossover', (c) => {
  const a = c.positional[0];
  const b = c.positional.length > 1 ? c.positional[1] : 0;
  return withState(c, (s) => { s.prevA = null; s.prevB = null; s.first = true; }, (s) => {
    const curA = num(c, at(a, c.bar), NaN);
    const curB = num(c, typeof b === 'number' ? b : at(b, c.bar), NaN);
    const prevA = s.first ? NaN : s.prevA;
    const prevB = s.first ? NaN : s.prevB;
    s.first = false;
    s.prevA = curA;
    s.prevB = curB;
    if (Number.isNaN(prevA) || Number.isNaN(prevB)) return false;
    return prevA <= prevB && curA > curB;
  });
});

def('ta.crossunder', (c) => {
  const a = c.positional[0];
  const b = c.positional.length > 1 ? c.positional[1] : 0;
  return withState(c, (s) => { s.prevA = null; s.prevB = null; s.first = true; }, (s) => {
    const curA = num(c, at(a, c.bar), NaN);
    const curB = num(c, typeof b === 'number' ? b : at(b, c.bar), NaN);
    const prevA = s.first ? NaN : s.prevA;
    const prevB = s.first ? NaN : s.prevB;
    s.first = false;
    s.prevA = curA;
    s.prevB = curB;
    if (Number.isNaN(prevA) || Number.isNaN(prevB)) return false;
    return prevA >= prevB && curA < curB;
  });
});

def('ta.cross', (c) => {
  const up = BUILTINS.get('ta.crossover')(c);
  if (up) return true;
  return BUILTINS.get('ta.crossunder')(c);
});

def('ta.rsi', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const rmaFn = BUILTINS.get('ta.rma');
  // FIX B: Use ring-buffer-backed up/down buffers instead of full-length arrays.
  return withState(
    c,
    (s, interp) => {
      // Use fixed-size Float64Arrays (ring buffers) instead of O(bars) arrays.
      const LOOKBACK = Series.LOOKBACK;
      s.upBuf = new Float64Array(LOOKBACK);
      s.dnBuf = new Float64Array(LOOKBACK);
      s.upBuf.fill(NaN);
      s.dnBuf.fill(NaN);
      s.upSeries = new Series(s.upBuf, interp.n);
      s.upSeries.__interp = interp;
      s.upSeries.__slotIdx = -1; // sentinel: no side-Map for this synthetic series
      s.dnSeries = new Series(s.dnBuf, interp.n);
      s.dnSeries.__interp = interp;
      s.dnSeries.__slotIdx = -1;
      s.prev = null;
    },
    (s) => {
      const cur = at(src, c.bar);
      if (isNa(cur)) return null;
      if (s.prev === null) {
        s.prev = Number(cur);
        return null;
      }
      const diff = Number(cur) - s.prev;
      s.prev = Number(cur);
      const LOOKBACK = Series.LOOKBACK;
      const ri = c.bar % LOOKBACK;
      s.upBuf[ri] = diff > 0 ? diff : 0;
      s.dnBuf[ri] = diff < 0 ? -diff : 0;
      const up = rmaFn(subSeriesCtx(c, 'up', s.upSeries, n));
      const down = rmaFn(subSeriesCtx(c, 'down', s.dnSeries, n));
      if (up === null || down === null) return null;
      if (down === 0) return 100;
      return 100 - 100 / (1 + up / down);
    }
  );
});

/** Build a synthetic sub-context so nested stateful calls get a stable key. */
function makeSubCtx(c, tag, value, length) {
  const node = { id: c.node.id * 1000 + (tag === 'up' ? 1 : tag === 'down' ? 2 : 3) };
  const arr = new Array(c.interp.n).fill(null);
  arr[c.bar] = value;
  return { ...c, node, positional: [new Series(arr), length] };
}

/** Stable per-tag node-id offsets. Every distinct tag MUST have its own id,
 *  otherwise the nested call would share closure state with its sibling. */
const SUB_CTX_TAGS = {
  fast: 11,
  slow: 12,
  signal: 13,
  up: 21,
  down: 22,
  atr: 31,
};

/** Like makeSubCtx but backed by a persistent buffer (no per-bar allocation). */
function subSeriesCtx(c, tag, buffer, length) {
  const offset = SUB_CTX_TAGS[tag];
  if (offset === undefined) throw new PineRuntimeError(`Internal: unknown sub-context tag '${tag}'`);
  const node = { id: c.node.id * 1000 + offset };
  // If buffer is already a Series, use it directly. Otherwise wrap it.
  // IMPORTANT: pass barCount so at(series, i) can read values. Without it,
  // Series defaults to barCount=0 and at() returns null for every bar (this
  // was the ta.atr "0 finite values" bug -- rma saw an empty Series).
  const series = buffer instanceof Series
    ? buffer
    : new Series(buffer, c.interp ? c.interp.n : buffer.length);
  if (!(buffer instanceof Series) && c.interp) {
    series.__interp = c.interp;
    series.__slotIdx = -1;
  }
  return { ...c, node, positional: [series, length] };
}

def('ta.macd', (c) => {
  const src = c.positional[0];
  const fast = Math.max(1, len(c, c.positional[1], 12));
  const slow = Math.max(1, len(c, c.positional[2], 26));
  const signal = Math.max(1, len(c, c.positional[3], 9));
  const emaFn = BUILTINS.get('ta.ema');
  // FIX B: Use fixed-size ring buffers instead of O(bars) arrays.
  return withState(
    c,
    (s, interp) => {
      const LB = Series.LOOKBACK;
      s.n = interp.n;
      s.LB = LB;
      s.fastBuf = new Float64Array(LB); s.fastBuf.fill(NaN);
      s.slowBuf = new Float64Array(LB); s.slowBuf.fill(NaN);
      s.sigBuf  = new Float64Array(LB); s.sigBuf.fill(NaN);
      s.fastSeries = new Series(s.fastBuf, interp.n); s.fastSeries.__interp = interp; s.fastSeries.__slotIdx = -1;
      s.slowSeries = new Series(s.slowBuf, interp.n); s.slowSeries.__interp = interp; s.slowSeries.__slotIdx = -1;
      s.sigSeries  = new Series(s.sigBuf,  interp.n); s.sigSeries.__interp  = interp; s.sigSeries.__slotIdx  = -1;
    },
    (s) => {
      const cur = at(src, c.bar);
      const ri = c.bar % s.LB;
      s.fastBuf[ri] = cur === null ? NaN : Number(cur);
      s.slowBuf[ri] = cur === null ? NaN : Number(cur);
      const f = emaFn(subSeriesCtx(c, 'fast', s.fastSeries, fast));
      const sl = emaFn(subSeriesCtx(c, 'slow', s.slowSeries, slow));
      if (f === null || sl === null) {
        s.sigBuf[ri] = NaN;
        return [null, null, null];
      }
      const macd = f - sl;
      s.sigBuf[ri] = macd;
      const sig = emaFn(subSeriesCtx(c, 'signal', s.sigSeries, signal));
      return [macd, sig, sig === null ? null : macd - sig];
    }
  );
});

def('ta.atr', (c) => {
  const n = Math.max(1, len(c, c.positional[0], 14));
  const rmaFn = BUILTINS.get('ta.rma');
  return withState(
    c,
    (s, interp) => {
      s.trBuf = new Array(interp.n).fill(null);
    },
    (s) => {
      const i = c.bar;
      const h = at(c.interp.globals.get('high'), i);
      const l = at(c.interp.globals.get('low'), i);
      const pc = at(c.interp.globals.get('close'), i - 1);
      if (isNa(h) || isNa(l)) return null;
      const tr = isNa(pc)
        ? Number(h) - Number(l)
        : Math.max(
            Number(h) - Number(l),
            Math.abs(Number(h) - Number(pc)),
            Math.abs(Number(l) - Number(pc))
          );
      s.trBuf[i] = tr;
      return rmaFn(subSeriesCtx(c, 'atr', s.trBuf, n));
    }
  );
});

def('ta.tr', (c) => {
  const handleNa = c.positional.length > 0 ? boolv(c, c.positional[0], true) : true;
  const i = c.bar;
  const h = at(c.interp.globals.get('high'), i);
  const l = at(c.interp.globals.get('low'), i);
  const pc = at(c.interp.globals.get('close'), i - 1);
  if (isNa(h) || isNa(l)) return null;
  if (isNa(pc)) return handleNa ? Number(h) - Number(l) : Number(h) - Number(l);
  return Math.max(Number(h) - Number(l), Math.abs(Number(h) - Number(pc)), Math.abs(Number(l) - Number(pc)));
});

def('ta.sar', (c) => {
  const start = num(c, c.positional[0], 0.02);
  const inc = num(c, c.positional[1], 0.02);
  const max = num(c, c.positional[2], 0.2);
  return withState(
    c,
    (s) => ({ init: false, af: start, ep: 0, sar: 0, long: true }),
    (s) => {
      const h = at(c.interp.globals.get('high'), c.bar);
      const l = at(c.interp.globals.get('low'), c.bar);
      if (isNa(h) || isNa(l)) return null;
      if (!s.init) {
        s.init = true;
        s.long = true;
        s.sar = Number(l);
        s.ep = Number(h);
        s.af = start;
        return s.sar;
      }
      let sar = s.sar + s.af * (s.ep - s.sar);
      if (s.long) {
        if (Number(l) < sar) {
          s.long = false;
          sar = s.ep;
          s.ep = Number(l);
          s.af = start;
        } else if (Number(h) > s.ep) {
          s.ep = Number(h);
          s.af = Math.min(max, s.af + inc);
        }
      } else {
        if (Number(h) > sar) {
          s.long = true;
          sar = s.ep;
          s.ep = Number(h);
          s.af = start;
        } else if (Number(l) < s.ep) {
          s.ep = Number(l);
          s.af = Math.min(max, s.af + inc);
        }
      }
      s.sar = sar;
      return sar;
    }
  );
});

def('ta.cmo', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const rmaFn = BUILTINS.get('ta.rma');
  return withState(
    c,
    (s, interp) => {
      s.upBuf = new Array(interp.n).fill(null);
      s.dnBuf = new Array(interp.n).fill(null);
      s.prev = null;
    },
    (s) => {
      const cur = at(src, c.bar);
      if (isNa(cur)) return null;
      if (s.prev === null) {
        s.prev = Number(cur);
        return null;
      }
      const diff = Number(cur) - s.prev;
      s.prev = Number(cur);
      s.upBuf[c.bar] = diff > 0 ? diff : 0;
      s.dnBuf[c.bar] = diff < 0 ? -diff : 0;
      const up = rmaFn(subSeriesCtx(c, 'up', s.upBuf, n));
      const down = rmaFn(subSeriesCtx(c, 'down', s.dnBuf, n));
      if (up === null || down === null || up + down === 0) return null;
      return ((up - down) / (up + down)) * 100;
    }
  );
});

def('ta.mfi', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  return withState(
    c,
    (s, interp) => {
      s.pos = new Array(interp.n).fill(0);
      s.neg = new Array(interp.n).fill(0);
      s.prev = null;
    },
    (s) => {
      const cur = at(src, c.bar);
      const vol = at(c.interp.globals.get('volume'), c.bar) ?? 0;
      if (isNa(cur)) return null;
      if (s.prev === null) {
        s.prev = Number(cur);
        return null;
      }
      const mf = Number(cur) * vol;
      const diff = Number(cur) - s.prev;
      s.prev = Number(cur);
      s.pos[c.bar] = diff > 0 ? mf : 0;
      s.neg[c.bar] = diff < 0 ? mf : 0;
      let sp = 0;
      let sn = 0;
      for (let k = 0; k < n; k++) {
        const i = c.bar - k;
        if (i < 0) return null;
        sp += s.pos[i] || 0;
        sn += s.neg[i] || 0;
      }
      if (sn === 0) return 100;
      return 100 - 100 / (1 + sp / sn);
    }
  );
});

def('ta.wpr', (c) => {
  const n = Math.max(1, len(c, c.positional[0], 14));
  const i = c.bar;
  const hh = BUILTINS.get('ta.highest')({ ...c, positional: [c.interp.globals.get('high'), n] });
  const ll = BUILTINS.get('ta.lowest')({ ...c, positional: [c.interp.globals.get('low'), n] });
  const cl = at(c.interp.globals.get('close'), i);
  if (hh === null || ll === null || isNa(cl) || hh === ll) return null;
  return ((hh - Number(cl)) / (hh - ll)) * -100;
});

def('ta.cci', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 20));
  const smaFn = BUILTINS.get('ta.sma');
  const m = smaFn({ ...c, positional: [src, n] });
  if (m === null) return null;
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return null;
    sum += Math.abs(Number(v) - m);
  }
  const md = sum / n;
  const cur = at(src, c.bar);
  if (md === 0) return 0;
  return (Number(cur) - m) / (0.015 * md);
});

def('ta.stoch', (c) => {
  const src = c.named.source ?? c.positional[0];
  const hi = c.named.high ?? c.positional[1] ?? c.interp.globals.get('high');
  const lo = c.named.low ?? c.positional[2] ?? c.interp.globals.get('low');
  const n = Math.max(1, len(c, c.named.length ?? c.positional[3], 14));
  const hh = BUILTINS.get('ta.highest')({ ...c, positional: [hi, n] });
  const ll = BUILTINS.get('ta.lowest')({ ...c, positional: [lo, n] });
  const cl = at(src, c.bar);
  if (hh === null || ll === null || isNa(cl) || hh === ll) return null;
  return ((Number(cl) - ll) / (hh - ll)) * 100;
});

def('ta.ao', (c) => {
  const fast = 5;
  const slow = 34;
  const med = (n) => {
    const h = BUILTINS.get('ta.sma')({ ...c, node: { id: c.node.id * 1000 + n }, positional: [c.interp.globals.get('hl2'), n] });
    return h;
  };
  const f = med(fast);
  const s = med(slow);
  if (f === null || s === null) return null;
  return f - s;
});

def('ta.vwap', (c) => {
  const src = c.named.source ?? c.positional[0] ?? c.interp.globals.get('hlc3');
  const anchor = strv(c, c.named.anchor ?? c.positional[1], '');
  const stash = c.named.stdev !== undefined ? boolv(c, c.named.stdev) : c.positional.length > 2 ? boolv(c, c.positional[2]) : false;
  const isNewPeriod = (bar) => {
    const t = c.interp.bars[bar]?.t;
    const tp = bar > 0 ? c.interp.bars[bar - 1]?.t : null;
    if (tp == null || t == null) return bar === 0;
    const d1 = new Date(t);
    const d2 = new Date(tp);
    switch (String(anchor).toLowerCase()) {
      case 'week':
        return d1.getUTCDay() < d2.getUTCDay() || t - tp > 3 * 86400000;
      case 'month':
        return d1.getUTCMonth() !== d2.getUTCMonth() || d1.getUTCFullYear() !== d2.getUTCFullYear();
      case 'session':
      case 'day':
      default:
        return d1.getUTCDate() !== d2.getUTCDate() || d1.getUTCMonth() !== d2.getUTCMonth();
    }
  };
  return withState(c, (s) => { s.pv = 0; s.vol = 0; s.pv2 = 0; s.lastBar = -1; }, (s) => {
    if (c.bar !== s.lastBar) {
      if (c.bar === 0 || isNewPeriod(c.bar)) {
        s.pv = 0;
        s.vol = 0;
        s.pv2 = 0;
      }
      const v = at(src, c.bar);
      const vol = at(c.interp.globals.get('volume'), c.bar) ?? 0;
      if (!isNa(v)) {
        s.pv += Number(v) * vol;
        s.pv2 += Number(v) * Number(v) * vol;
        s.vol += vol;
      }
      s.lastBar = c.bar;
    }
    if (!s.vol) return null;
    const vwap = s.pv / s.vol;
    if (!stash) return vwap;
    const variance = Math.max(0, s.pv2 / s.vol - vwap * vwap);
    return [vwap, Math.sqrt(variance)];
  });
});

def('ta.correlation', (c) => {
  const a = c.positional[0];
  const b = c.positional[1];
  const n = Math.max(1, len(c, c.positional[2], 20));
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < n; k++) {
    const va = at(a, c.bar - k);
    const vb = at(b, c.bar - k);
    if (isNa(va) || isNa(vb)) return null;
    sa += Number(va); sb += Number(vb);
    saa += Number(va) ** 2; sbb += Number(vb) ** 2;
    sab += Number(va) * Number(vb);
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const sdA = Math.sqrt(saa / n - (sa / n) ** 2);
  const sdB = Math.sqrt(sbb / n - (sb / n) ** 2);
  if (sdA === 0 || sdB === 0) return null;
  return cov / (sdA * sdB);
});

def('ta.linreg', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const offset = c.positional.length > 2 ? num(c, c.positional[2], 0) : 0;
  // FIX B: Rolling sums for linear regression — O(1) per bar instead of O(n).
  // The x values are 0..n-1 (bar index within window), so sx and sxx are
  // constants. Only sy and sxy need to be tracked incrementally.
  // sx  = sum(0..n-1) = n*(n-1)/2
  // sxx = sum(0^2..(n-1)^2) = n*(n-1)*(2n-1)/6
  const sx = n * (n - 1) / 2;
  const sxx = n * (n - 1) * (2 * n - 1) / 6;
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return withState(c, (s) => { s.sy = 0; s.sxy = 0; s.queue = []; }, (s) => {
    const y = at(src, c.bar);
    if (isNa(y)) {
      if (s.queue.length > 0) { const oldY = s.queue.shift(); const oldX = s.queue.length; s.sy -= oldY; s.sxy -= oldX * oldY; }
      return null;
    }
    const yv = Number(y);
    const xv = s.queue.length; // x = position of this bar within the window (0-indexed)
    s.sy += yv;
    s.sxy += xv * yv;
    s.queue.push(yv);
    if (s.queue.length > n) {
      const oldY = s.queue.shift();
      const oldX = 0; // the oldest element was at x=0
      s.sy -= oldY;
      s.sxy -= oldX * oldY;
      // Recompute sxy: each remaining element's x shifts down by 1.
      // Old sxy = sum(x_i * y_i) for i=1..n. New sxy = sum((x_i - 1) * y_i) = old_sxy - sy_remaining.
      // But we already subtracted oldY from sy. Let's just recompute sxy from scratch since it's cheap.
      // Actually, the rolling approach is: sxy_new = sxy_old - sy_remaining (after removing oldest).
      // sy_remaining = s.sy (already updated). So: s.sxy -= s.sy + oldY (because sy still includes oldY before subtraction).
      // This is getting complex — let's just do the subtraction correctly:
      // After shift: new_sy = old_sy - oldY, new_sxy = old_sxy - sum(x_i * y_i for remaining i) ... 
      // Simpler: recompute sxy from the queue.
      let nsxy = 0;
      for (let i = 0; i < s.queue.length; i++) nsxy += i * s.queue[i];
      s.sxy = nsxy;
    }
    if (s.queue.length < n) return null;
    const slope = (n * s.sxy - sx * s.sy) / denom;
    const intercept = (s.sy - slope * sx) / n;
    return intercept + slope * (n - 1 - offset);
  });
});

def('ta.median', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const vals = [];
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return null;
    vals.push(Number(v));
  }
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
});

/** Pine v6 `ta.hma(src, len)` — Hull Moving Average. */
def('ta.hma', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const half = Math.max(1, Math.floor(n / 2));
  const sqrtN = Math.max(1, Math.floor(Math.sqrt(n)));
  return withState(c, (s) => { s.buf = []; }, (s) => {
    // HMA = WMA(2*WMA(src, n/2) - WMA(src, n), sqrt(n))
    let wmaHalf = 0, wmaFull = 0;
    let whSum = 0, wfSum = 0;
    for (let k = 0; k < half; k++) {
      const v = at(src, c.bar - k);
      if (isNa(v)) return null;
      const w = half - k;
      wmaHalf += Number(v) * w; whSum += w;
    }
    wmaHalf /= whSum;
    for (let k = 0; k < n; k++) {
      const v = at(src, c.bar - k);
      if (isNa(v)) return null;
      const w = n - k;
      wmaFull += Number(v) * w; wfSum += w;
    }
    wmaFull /= wfSum;
    const raw = 2 * wmaHalf - wmaFull;
    // Accumulate raw values for the WMA over sqrt(n)
    s.buf.push(raw);
    if (s.buf.length > sqrtN) s.buf.shift();
    if (s.buf.length < sqrtN) return null;
    let sum = 0, wSum = 0;
    for (let k = 0; k < sqrtN; k++) {
      const w = sqrtN - k;
      sum += s.buf[k] * w; wSum += w;
    }
    return wSum > 0 ? sum / wSum : null;
  });
});

/** Pine v6 `ta.t3(src, len, vf)` — Tillson T3 moving average. */
def('ta.t3', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 5));
  const vf = num(c, c.positional[2], 0.7);
  // T3 = GD(GD(GD(src, n, vf), n, vf), n, vf)
  // where GD(src, n, vf) = EMA(src, n) * (1 + vf) - EMA(EMA(src, n), n) * vf
  return withState(c, (s) => {
    // We need 6 layers of EMA state.
    s.e = [null, null, null, null, null, null];
    s.seed = [0, 0, 0, 0, 0, 0];
    s.count = 0;
  }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return null;
    const x = Number(v);
    const alpha = 2 / (n + 1);
    const e1a = 1 + vf;
    const e2a = vf;
    // Layer 1: EMA(src, n)
    if (s.e[0] === null) { s.seed[0] += x; s.count++; if (s.count < n) return null; s.e[0] = s.seed[0] / n; }
    else s.e[0] = alpha * x + (1 - alpha) * s.e[0];
    // Layer 2: EMA(e1, n) → GD component
    if (s.e[1] === null) { s.e[1] = s.e[0]; }
    else s.e[1] = alpha * s.e[0] + (1 - alpha) * s.e[1];
    const gd1 = e1a * s.e[0] - e2a * s.e[1];
    // Layer 3: EMA(gd1, n)
    if (s.e[2] === null) { s.e[2] = gd1; }
    else s.e[2] = alpha * gd1 + (1 - alpha) * s.e[2];
    // Layer 4: EMA(e3, n)
    if (s.e[3] === null) { s.e[3] = s.e[2]; }
    else s.e[3] = alpha * s.e[2] + (1 - alpha) * s.e[3];
    const gd2 = e1a * s.e[2] - e2a * s.e[3];
    // Layer 5: EMA(gd2, n)
    if (s.e[4] === null) { s.e[4] = gd2; }
    else s.e[4] = alpha * gd2 + (1 - alpha) * s.e[4];
    // Layer 6: EMA(e5, n)
    if (s.e[5] === null) { s.e[5] = s.e[4]; }
    else s.e[5] = alpha * s.e[4] + (1 - alpha) * s.e[5];
    const gd3 = e1a * s.e[4] - e2a * s.e[5];
    return gd3;
  });
});

/** Pine v6 `ta.dema(src, len)` — Double Exponential Moving Average. */
def('ta.dema', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 9));
  return withState(c, (s) => { s.e1 = null; s.e2 = null; s.seed1 = 0; s.seed2 = 0; s.count = 0; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return s.e1 !== null ? 2 * s.e1 - s.e2 : null;
    const alpha = 2 / (n + 1);
    if (s.e1 === null) { s.seed1 += Number(v); s.count++; if (s.count < n) return null; s.e1 = s.seed1 / n; s.e2 = s.e1; }
    else { s.e1 = alpha * Number(v) + (1 - alpha) * s.e1; s.e2 = alpha * s.e1 + (1 - alpha) * s.e2; }
    return 2 * s.e1 - s.e2;
  });
});

/** Pine v6 `ta.tema(src, len)` — Triple Exponential Moving Average. */
def('ta.tema', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 9));
  return withState(c, (s) => { s.e = [null, null, null]; s.seed = [0, 0, 0]; s.count = 0; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return s.e[0] !== null ? 3 * s.e[0] - 3 * s.e[1] + s.e[2] : null;
    const alpha = 2 / (n + 1);
    if (s.e[0] === null) { s.seed[0] += Number(v); s.count++; if (s.count < n) return null; s.e[0] = s.seed[0] / n; s.e[1] = s.e[0]; s.e[2] = s.e[0]; }
    else { s.e[0] = alpha * Number(v) + (1 - alpha) * s.e[0]; s.e[1] = alpha * s.e[0] + (1 - alpha) * s.e[1]; s.e[2] = alpha * s.e[1] + (1 - alpha) * s.e[2]; }
    return 3 * s.e[0] - 3 * s.e[1] + s.e[2];
  });
});

/** Pine v6 `ta.alma(src, len, offset, sigma)` — Arnaud Legoux Moving Average. */
def('ta.alma', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 9));
  const offset = num(c, c.positional[2], 0.85 * (n - 1));
  const sigma = num(c, c.positional[3], 6);
  return withState(c, () => {}, () => {
    let sum = 0, wSum = 0;
    const m = offset;
    const s = n / sigma;
    for (let k = 0; k < n; k++) {
      const v = at(src, c.bar - (n - 1 - k));
      if (isNa(v)) return null;
      const w = Math.exp(-((k - m) * (k - m)) / (2 * s * s));
      sum += Number(v) * w;
      wSum += w;
    }
    return wSum > 0 ? sum / wSum : null;
  });
});

def('ta.mode', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const counts = new Map();
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) continue;
    counts.set(Number(v), (counts.get(Number(v)) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null;
  let bestCount = -1;
  for (const [v, cnt] of counts) {
    if (cnt > bestCount) {
      best = v;
      bestCount = cnt;
    }
  }
  return best;
});

def('ta.range', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 1));
  const a = at(src, c.bar);
  const b = at(src, c.bar - n);
  if (isNa(a) || isNa(b)) return null;
  return Number(a) - Number(b);
});

/* ---------------- Pine v6 additions to ta.* ---------------- */

/**
 * `ta.cum(src)` — cumulative sum of `src` from bar 0 onwards. Equivalent to
 * `math.cum` in some Pine docs; this is the standard "running total" used
 * for OBV-style indicators.
 */
def('ta.cum', (c) => {
  const src = c.positional[0];
  return withState(c, (s) => { s.total = 0; }, (s) => {
    const v = at(src, c.bar);
    if (isNa(v)) return s.total;
    s.total += Number(v);
    return s.total;
  });
});

/** `ta.percentile_linear_interpolation(src, n, pct)` — linear-interp percentile. */
def('ta.percentile_linear_interpolation', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const pct = Math.max(0, Math.min(100, num(c, c.positional[2], 50))) / 100;
  const vals = [];
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return null;
    vals.push(Number(v));
  }
  vals.sort((a, b) => a - b);
  const pos = (vals.length - 1) * pct;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return vals[lo];
  return vals[lo] + (vals[hi] - vals[lo]) * (pos - lo);
});

/** `ta.percentile_nearest_rank(src, n, pct)` — nearest-rank percentile. */
def('ta.percentile_nearest_rank', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  const pct = Math.max(0, Math.min(100, num(c, c.positional[2], 50)));
  const vals = [];
  for (let k = 0; k < n; k++) {
    const v = at(src, c.bar - k);
    if (isNa(v)) return null;
    vals.push(Number(v));
  }
  vals.sort((a, b) => a - b);
  const rank = Math.ceil((pct / 100) * vals.length);
  return vals[Math.max(0, Math.min(vals.length - 1, rank - 1))];
});

/** `ta.cog(src, n)` — Centre of Gravity oscillator. */
def('ta.cog', (c) => {
  const src = c.positional[0];
  const n = Math.max(1, len(c, c.positional[1], 14));
  return withState(c, () => {}, () => {
    let num = 0;
    let den = 0;
    for (let k = 0; k < n; k++) {
      const v = at(src, c.bar - k);
      if (isNa(v)) return null;
      num += Number(v) * (k + 1);
      den += Number(v);
    }
    return den === 0 ? null : -num / den;
  });
});

/** `ta.dmi(di_length, adx_smoothing)` — returns [DI+, DI-, ADX]. */
def('ta.dmi', (c) => {
  const n = Math.max(1, len(c, c.positional[0], 14));
  const adxN = Math.max(1, len(c, c.positional[1], 14));
  return withState(c, (s) => {
    s.trSm = null; s.plus = null; s.minus = null;
    s.trSmSeed = 0; s.trSmCount = 0;
    s.plusSeed = 0; s.minusSeed = 0; s.plusSm = 0; s.minusSm = 0;
    s.dx = null; s.dxSm = null; s.adx = null; s.adxSeed = 0;
  }, (s) => {
    const interp = c.interp;
    const hi = interp.globals.get('high').values[c.bar];
    const lo = interp.globals.get('low').values[c.bar];
    const cl = interp.globals.get('close').values[c.bar];
    const prevHi = c.bar > 0 ? interp.globals.get('high').values[c.bar - 1] : hi;
    const prevLo = c.bar > 0 ? interp.globals.get('low').values[c.bar - 1] : lo;
    const prevCl = c.bar > 0 ? interp.globals.get('close').values[c.bar - 1] : cl;
    const tr = Math.max(hi - lo, Math.abs(hi - prevCl), Math.abs(lo - prevCl));
    const upMove = hi - prevHi;
    const downMove = prevLo - lo;
    const plus = upMove > downMove && upMove > 0 ? upMove : 0;
    const minus = downMove > upMove && downMove > 0 ? downMove : 0;
    // Wilder smoothing for TR, plus, minus
    if (s.trSm === null) {
      s.trSmSeed += tr; s.plusSeed += plus; s.minusSeed += minus;
      s.trSmCount++;
      if (s.trSmCount < n) return [null, null, null];
      s.trSm = s.trSmSeed / n;
      s.plusSm = s.plusSeed / n;
      s.minusSm = s.minusSeed / n;
    } else {
      s.trSm = (s.trSm * (n - 1) + tr) / n;
      s.plusSm = (s.plusSm * (n - 1) + plus) / n;
      s.minusSm = (s.minusSm * (n - 1) + minus) / n;
    }
    const diPlus = s.trSm === 0 ? 0 : (100 * s.plusSm) / s.trSm;
    const diMinus = s.trSm === 0 ? 0 : (100 * s.minusSm) / s.trSm;
    const dx = diPlus + diMinus === 0 ? 0 : (100 * Math.abs(diPlus - diMinus)) / (diPlus + diMinus);
    if (s.dxSm === null) { s.dxSeed += dx; s.adxSeed++; if (s.adxSeed < adxN) return [diPlus, diMinus, null]; s.dxSm = s.dxSeed / adxN; }
    else s.dxSm = (s.dxSm * (adxN - 1) + dx) / adxN;
    return [diPlus, diMinus, s.dxSm];
  });
});

/** `ta.supertrend(factor, atrPeriod)` — single-line Supertrend indicator. */
def('ta.supertrend', (c) => {
  const factor = num(c, c.positional[0], 3);
  const atrN = Math.max(1, len(c, c.positional[1], 10));
  return withState(c, (s) => {
    s.atr = null; s.atrSeed = 0; s.atrCount = 0; s.trend = 1;
    s.upperBand = null; s.lowerBand = null; s.prevUpper = null; s.prevLower = null;
  }, (s) => {
    const interp = c.interp;
    const hi = interp.globals.get('high').values[c.bar];
    const lo = interp.globals.get('low').values[c.bar];
    const cl = interp.globals.get('close').values[c.bar];
    const prevCl = c.bar > 0 ? interp.globals.get('close').values[c.bar - 1] : cl;
    const prevHi = c.bar > 0 ? interp.globals.get('high').values[c.bar - 1] : hi;
    const prevLo = c.bar > 0 ? interp.globals.get('low').values[c.bar - 1] : lo;
    const tr = Math.max(hi - lo, Math.abs(hi - prevCl), Math.abs(lo - prevCl));
    // ATR via Wilder smoothing
    if (s.atr === null) {
      s.atrSeed += tr; s.atrCount++;
      if (s.atrCount < atrN) return null;
      s.atr = s.atrSeed / atrN;
    } else {
      s.atr = (s.atr * (atrN - 1) + tr) / atrN;
    }
    const mid = (hi + lo) / 2;
    let upper = mid + factor * s.atr;
    let lower = mid - factor * s.atr;
    if (s.prevUpper !== null) {
      upper = (upper < s.prevUpper || prevCl > s.prevUpper) ? upper : s.prevUpper;
      lower = (lower > s.prevLower || prevCl < s.prevLower) ? lower : s.prevLower;
    }
    if (s.trend === 1 && cl < lower) s.trend = -1;
    else if (s.trend === -1 && cl > upper) s.trend = 1;
    s.upperBand = upper; s.lowerBand = lower;
    s.prevUpper = upper; s.prevLower = lower;
    const value = s.trend === 1 ? lower : upper;
    return [value, s.trend];
  });
});

/** `ta.hlc3 / ta.hl2 / ta.ohlc4` — quick access to the typical-price series. */
def('ta.hlc3', (c) => {
  const interp = c.interp;
  return interp.globals.get('hlc3')?.values?.[c.bar] ?? null;
});
def('ta.hl2', (c) => {
  const interp = c.interp;
  return interp.globals.get('hl2')?.values?.[c.bar] ?? null;
});
def('ta.ohlc4', (c) => {
  const interp = c.interp;
  return interp.globals.get('ohlc4')?.values?.[c.bar] ?? null;
});


/* ================================================================== *
 * string namespace
 * ================================================================== */

def('str.tostring', (c) => {
  const v = c.positional[0];
  const fmt = c.positional.length > 1 ? c.positional[1] : c.named.format;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const n = num(c, v, NaN);
  if (Number.isNaN(n)) return 'NaN';
  if (fmt !== undefined && fmt !== null && typeof fmt === 'string' && fmt.startsWith('#')) {
    return formatNumber(n, fmt);
  }
  if (fmt === 'percent') return (n * 100).toFixed(2) + '%';
  if (fmt === 'currency') return n.toFixed(2);
  return ctx_interp_str(c, n);
});
function ctx_interp_str(c, n) {
  return c.interp.toStr(n);
}
function formatNumber(value, pattern) {
  const p = pattern.replace('#', '');
  const decimals = p.includes('.') ? p.split('.')[1].length : 0;
  const [i, d] = p.split('.');
  const minInt = (i.match(/[0,]/g) || []).length;
  const useCommas = p.includes(',');
  let s = Math.abs(value).toFixed(decimals);
  let [ip, dp] = s.split('.');
  if (useCommas) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (minInt > ip.replace(/,/g, '').length) ip = ip.padStart(minInt + (useCommas ? Math.floor((minInt - 1) / 3) : 0), '0');
  s = ip + (dp !== undefined && decimals > 0 ? '.' + dp : '');
  return (value < 0 ? '-' : '') + s;
}

def('str.length', (c) => strv(c, c.positional[0]).length);
def('str.upper', (c) => strv(c, c.positional[0]).toUpperCase());
def('str.lower', (c) => strv(c, c.positional[0]).toLowerCase());
def('str.contains', (c) => strv(c, c.positional[0]).includes(strv(c, c.positional[1])));
def('str.startswith', (c) => strv(c, c.positional[0]).startsWith(strv(c, c.positional[1])));
def('str.endswith', (c) => strv(c, c.positional[0]).endsWith(strv(c, c.positional[1])));
def('str.replace', (c) => strv(c, c.positional[0]).split(strv(c, c.positional[1])).join(strv(c, c.positional[2])));
def('str.replace_all', (c) => strv(c, c.positional[0]).split(strv(c, c.positional[1])).join(strv(c, c.positional[2])));
def('str.substring', (c) => {
  const s = strv(c, c.positional[0]);
  const from = Math.max(0, Math.floor(num(c, c.positional[1], 0)));
  const to = c.positional.length > 2 ? Math.floor(num(c, c.positional[2], s.length)) : s.length;
  return s.substring(from, to);
});
def('str.split', (c) => {
  const s = strv(c, c.positional[0]);
  const sep = strv(c, c.positional[1], '');
  return new PineArray(sep === '' ? s.split('') : s.split(sep));
});
def('str.join', (c) => {
  const arr = c.positional[0];
  const sep = strv(c, c.positional[1], '');
  const items = arr instanceof PineArray ? arr.items : [];
  return items.map((x) => c.interp.toStr(x)).join(sep);
});
def('str.match', (c) => {
  const s = strv(c, c.positional[0]);
  const re = strv(c, c.positional[1]);
  try {
    const m = new RegExp(re).exec(s);
    return m ? new PineArray([...m]) : new PineArray([]);
  } catch {
    return new PineArray([]);
  }
});
def('str.repeat', (c) => strv(c, c.positional[0]).repeat(Math.max(0, Math.floor(num(c, c.positional[1], 0)))));
def('str.reverse', (c) => strv(c, c.positional[0]).split('').reverse().join(''));
def('str.tonumber', (c) => {
  const v = c.positional[0];
  const n = Number(typeof v === 'number' ? v : String(v).trim());
  return Number.isNaN(n) ? NaN : n;
});
def('str.format', (c) => {
  const tmpl = strv(c, c.positional[0]);
  const args = c.positional.slice(1);
  let i = 0;
  return tmpl.replace(/\{(\d*)\}/g, (_, idx) => {
    const v = idx === '' ? args[i++] : args[Number(idx)];
    return c.interp.toStr(v);
  });
});
def('str.format_time', (c) => {
  const t = num(c, c.positional[0], NaN);
  const fmt = strv(c, c.positional[1], 'yyyy-MM-dd');
  const tz = strv(c, c.positional[2], 'UTC');
  if (Number.isNaN(t)) return '';
  try {
    const d = new Date(t);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: fmt.includes('HH') ? '2-digit' : undefined,
      minute: fmt.includes('mm') ? '2-digit' : undefined,
      hour12: false,
    }).format(d);
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
});

/* ================================================================== *
 * array namespace
 * ================================================================== */

const arr = (v) => (v instanceof PineArray ? v : new PineArray([]));

const ARRAY_METHODS = {
  size: (c) => arr(c.positional[0]).items.length,
  push: (c) => {
    const a = arr(c.positional[0]);
    const value = c.interp.storeValue(c.positional[1]);
    // array.push(id, value) or array.push(id, value, max_size)
    if (c.positional.length >= 3) {
      const maxSize = Math.floor(num(c, c.positional[2], a.items.length));
      a.items.push(value);
      while (a.items.length > maxSize) a.items.shift();
    } else {
      a.items.push(value);
    }
    return undefined;
  },
  pop: (c) => {
    const a = arr(c.positional[0]);
    return a.items.pop() ?? null;
  },
  shift: (c) => {
    const a = arr(c.positional[0]);
    return a.items.shift() ?? null;
  },
  unshift: (c) => {
    const a = arr(c.positional[0]);
    a.items.unshift(c.interp.storeValue(c.positional[1]));
    return undefined;
  },
  get: (c) => arr(c.positional[0]).items[Math.floor(num(c, c.positional[1], 0))] ?? null,
  set: (c) => {
    const a = arr(c.positional[0]);
    a.items[Math.floor(num(c, c.positional[1], 0))] = c.interp.storeValue(c.positional[2]);
    return undefined;
  },
  clear: (c) => {
    arr(c.positional[0]).items.length = 0;
    return undefined;
  },
  remove: (c) => {
    const a = arr(c.positional[0]);
    const i = Math.floor(num(c, c.positional[1], 0));
    return a.items.splice(i, 1)[0] ?? null;
  },
  insert: (c) => {
    const a = arr(c.positional[0]);
    a.items.splice(Math.floor(num(c, c.positional[1], 0)), 0, c.interp.storeValue(c.positional[2]));
    return undefined;
  },
  indexof: (c) => {
    const a = arr(c.positional[0]);
    const v = c.positional[1];
    return a.items.findIndex((x) => x === v || (typeof x === 'number' && x === Number(v)));
  },
  lastindexof: (c) => {
    const a = arr(c.positional[0]);
    const v = c.positional[1];
    for (let i = a.items.length - 1; i >= 0; i--) if (a.items[i] === v) return i;
    return -1;
  },
  includes: (c) => arr(c.positional[0]).items.includes(c.positional[1]),
  concat: (c) => {
    const a = arr(c.positional[0]);
    const b = c.positional[1];
    const items = Array.isArray(b) ? b : b instanceof PineArray ? b.items : [];
    return new PineArray([...a.items, ...items]);
  },
  copy: (c) => new PineArray([...arr(c.positional[0]).items]),
  slice: (c) => {
    const a = arr(c.positional[0]);
    const from = c.positional.length > 1 ? Math.floor(num(c, c.positional[1], 0)) : 0;
    const to = c.positional.length > 2 ? Math.floor(num(c, c.positional[2], a.items.length)) : a.items.length;
    return new PineArray(a.items.slice(from, to));
  },
  reverse: (c) => {
    const a = arr(c.positional[0]);
    a.items.reverse();
    return undefined;
  },
  sort: (c) => {
    const a = arr(c.positional[0]);
    a.items.sort((x, y) => Number(x) - Number(y));
    return undefined;
  },
  sort_indices: (c) => {
    const a = arr(c.positional[0]);
    const idx = a.items.map((_, i) => i);
    idx.sort((x, y) => Number(a.items[x]) - Number(a.items[y]));
    return new PineArray(idx);
  },
  sum: (c) => arr(c.positional[0]).items.reduce((s, v) => s + (Number(v) || 0), 0),
  avg: (c) => {
    const items = arr(c.positional[0]).items;
    return items.length ? items.reduce((s, v) => s + (Number(v) || 0), 0) / items.length : NaN;
  },
  min: (c) => {
    const items = arr(c.positional[0]).items.filter((v) => typeof v === 'number');
    return items.length ? Math.min(...items) : null;
  },
  max: (c) => {
    const items = arr(c.positional[0]).items.filter((v) => typeof v === 'number');
    return items.length ? Math.max(...items) : null;
  },
  range: (c) => {
    const items = arr(c.positional[0]).items.filter((v) => typeof v === 'number');
    return items.length ? Math.max(...items) - Math.min(...items) : null;
  },
  stdev: (c) => {
    const items = arr(c.positional[0]).items.filter((v) => typeof v === 'number');
    if (items.length < 2) return NaN;
    const m = items.reduce((a, b) => a + b, 0) / items.length;
    return Math.sqrt(items.reduce((a, b) => a + (b - m) ** 2, 0) / (items.length - 1));
  },
  median: (c) => {
    const items = [...arr(c.positional[0]).items].filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (!items.length) return NaN;
    const mid = Math.floor(items.length / 2);
    return items.length % 2 ? items[mid] : (items[mid - 1] + items[mid]) / 2;
  },
  abs: (c) => {
    const a = arr(c.positional[0]);
    a.items = a.items.map((v) => Math.abs(Number(v)));
    return undefined;
  },
  fill: (c) => {
    const a = arr(c.positional[0]);
    const from = Math.floor(num(c, c.positional[1], 0));
    const to = Math.floor(num(c, c.positional[2], a.items.length - 1));
    for (let i = from; i <= to && i < a.items.length; i++) a.items[i] = c.positional[3];
    return undefined;
  },
  from: (c) => new PineArray(c.positional.slice(1).map((v) => c.interp.toNum(v))),
};
for (const [name, fn] of Object.entries(ARRAY_METHODS)) {
  def(`array.${name}`, fn);
  def(`__method_${name}`, fn);
}
def('array.new_float', (c) => new PineArray());
def('array.new_int', (c) => new PineArray());
def('array.new_bool', (c) => new PineArray());
def('array.new_string', (c) => new PineArray());
def('array.new_color', (c) => new PineArray());
def('array.new_label', (c) => new PineArray());
def('array.new_line', (c) => new PineArray());
def('array.new_box', (c) => new PineArray());
def('array.new', (c) => new PineArray(new Array(Math.max(0, Math.floor(num(c, c.positional[0], 0)))).fill(c.positional[1] ?? null)));

/* ================================================================== *
 * matrix / map (essentials)
 * ================================================================== */

def('matrix.new', (c) => {
  const rows = Math.max(0, Math.floor(num(c, c.positional[0], 0)));
  const cols = Math.max(0, Math.floor(num(c, c.positional[1], 0)));
  const m = new PineMatrix([], cols);
  for (let r = 0; r < rows; r++) m.rows.push(new Array(cols).fill(c.positional[2] ?? NaN));
  return m;
});
def('matrix.rows', (c) => c.positional[0]?.rows?.length ?? 0);
def('matrix.columns', (c) => c.positional[0]?.cols ?? 0);
def('matrix.get', (c) => c.positional[0]?.rows?.[Math.floor(num(c, c.positional[1], 0))]?.[Math.floor(num(c, c.positional[2], 0))] ?? null);
def('matrix.set', (c) => {
  const m = c.positional[0];
  if (m) m.rows[Math.floor(num(c, c.positional[1], 0))][Math.floor(num(c, c.positional[2], 0))] = c.positional[3];
  return undefined;
});
def('matrix.fill', (c) => {
  const m = c.positional[0];
  if (!m) return undefined;
  for (let r = 0; r < m.rows.length; r++) for (let cc = 0; cc < m.cols; cc++) m.rows[r][cc] = c.positional[1];
  return undefined;
});

def('map.new', () => new PineMap());
def('map.put', (c) => {
  const m = c.positional[0];
  if (m instanceof PineMap) m.entries.set(c.interp.storeValue(c.positional[1]), c.interp.storeValue(c.positional[2]));
  return undefined;
});
def('map.get', (c) => {
  const m = c.positional[0];
  return m instanceof PineMap ? m.entries.get(c.positional[1]) ?? null : null;
});
def('map.contains', (c) => c.positional[0] instanceof PineMap && c.positional[0].entries.has(c.positional[1]));
def('map.remove', (c) => {
  const m = c.positional[0];
  return m instanceof PineMap ? m.entries.delete(c.positional[1]) : false;
});
def('map.size', (c) => (c.positional[0] instanceof PineMap ? c.positional[0].entries.size : 0));
def('map.keys', (c) => new PineArray(c.positional[0] instanceof PineMap ? [...c.positional[0].entries.keys()] : []));
def('map.values', (c) => new PineArray(c.positional[0] instanceof PineMap ? [...c.positional[0].entries.values()] : []));
def('map.clear', (c) => {
  if (c.positional[0] instanceof PineMap) c.positional[0].entries.clear();
  return undefined;
});

/* ================================================================== *
 * input namespace
 * ================================================================== */

function registerInput(c, kind, spec) {
  const id = `${kind}_${c.node.id}`;
  const interp = c.interp;
  // Fast path: after bar 0, inputs are cached — just return the value.
  // This avoids re-running the manifest registration (which includes an
  // O(n) linear search of inputManifest) on every bar. For a script with
  // 31 inputs × 2000 bars, this saves ~62,000 unnecessary find() calls.
  if (c.bar > 0 && interp.inputValues && id in interp.inputValues) {
    return interp.inputValues[id];
  }
  const title = strv(c, spec.title, kind);
  const defv = spec.defval;
  const override = interp.inputOverrides ? interp.inputOverrides[id] : undefined;
  const existing = interp.inputManifest.find((m) => m.id === id);
  const entry = {
    id,
    kind,
    title,
    defval: normaliseInputValue(kind, defv),
    options: spec.options || null,
    minval: spec.minval ?? null,
    maxval: spec.maxval ?? null,
    step: spec.step ?? null,
    tooltip: spec.tooltip || null,
    group: spec.group || null,
    inline: spec.inline || null,
    confirm: spec.confirm ?? false,
    multiline: spec.multiline ?? false,
  };
  if (!existing) interp.inputManifest.push(entry);
  const value = override !== undefined ? override : entry.defval;
  interp.inputValues[id] = value;
  return value;
}

function normaliseInputValue(kind, v) {
  if (v instanceof PineColor) return `#${v.value}`;
  if (kind === 'color' && typeof v === 'string') return v.startsWith('#') ? v : `#${v}`;
  return v === undefined ? null : v;
}

function inputImpl(kind) {
  return (c) => {
    const spec = context(c, ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display']);
    const named = c.named;
    const merged = {
      defval: c.positional.length ? c.positional[0] : named.defval,
      title: named.title ?? spec.title,
      options: named.options ?? null,
      minval: named.minval ?? null,
      maxval: named.maxval ?? null,
      step: named.step ?? null,
      tooltip: named.tooltip ?? null,
      group: named.group ?? null,
      inline: named.inline ?? null,
      confirm: named.confirm ?? false,
      multiline: named.multiline ?? false,
    };
    if (kind === 'source') {
      // `input.source(close)` returns the series itself, not a manifest entry.
      const raw = merged.defval ?? c.positional[0];
      if (raw && raw.__rawSeries) return raw.__rawSeries;
      return raw;
    }
    return registerInput(c, kind, merged);
  };
}
for (const kind of ['int', 'float', 'bool', 'string', 'color', 'timeframe', 'symbol', 'session', 'price', 'text_area', 'time', 'source', 'enum']) {
  def(`input.${kind}`, inputImpl(kind === 'enum' ? 'string' : kind));
}
def('input.string', inputImpl('string'));
/**
 * Pine v6 bare `input(...)` — a generic input. Pine auto-detects the type
 * from `defval` (a number → int/float, a bool → bool, a string → string,
 * a color → color, a series → source). We mirror that behaviour here so
 * scripts that use `input(false, 'Color Candles')` (without the explicit
 * `.bool` namespace) compile and run.
 */
def('input', inputImpl('bool'));

/* ================================================================== *
 * plotting & drawing
 * ================================================================== */

function styleResolve(v, ns) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (v && v.__enum) return v;
  void ns;
  return v;
}

defAlias(['plot'], (c) => {
  const series = c.positional[0];
  const named = c.named;
  const title = strv(c, named.title, 'plot');
  const id = `plot_${c.node.id}`;
  const interp = c.interp;
  const existing = interp.outputs.plots.find((p) => p.id === id);
  if (!existing) {
    interp.outputs.plots.push({
      id,
      nodeId: c.node.id,
      title,
      values: new Array(interp.n).fill(null),
      colors: new Array(interp.n).fill(null),
      linewidth: num(c, named.linewidth ?? c.positional[3], 1),
      style: named.style ?? c.positional[4] ?? plotStyle.line,
      offset: Math.floor(num(c, named.offset, 0)),
      display: named.display ?? displayStyle.all,
      forceOverlay: boolv(c, named.force_overlay, false),
      pane: strv(c, named.force_overlay === undefined ? named.pane : null, ''),
      histbase: num(c, named.histbase, 0),
      transp: num(c, named.transp, 0),
    });
  }
  const plot = interp.outputs.plots.find((p) => p.id === id);
  const target = c.bar + plot.offset;
  if (target >= 0 && target < interp.n) {
    const v = (series && series.isSeries && Array.isArray(series.values))
      ? series.values[c.bar]
      : (series instanceof Series ? series.values[c.bar] : series);
    plot.values[target] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    // Color: named arg 'color' or positional[2]
    const colorArg = named.color !== undefined ? named.color : c.positional[2];
    if (colorArg !== undefined && colorArg !== null) {
      plot.colors[target] = colorv(colorArg, null);
    }
  }
  return null;
});

defAlias(['plotshape', 'plotchar'], (c) => {
  const cond = c.positional[0];
  const named = c.named;
  const interp = c.interp;
  const isChar = c.node.callee?.property === 'plotchar' || c.node.callee?.name === 'plotchar';
  const list = isChar ? interp.outputs.charShapes : interp.outputs.shapes;
  const id = `shape_${c.node.id}`;
  let entry = list.find((p) => p.id === id);
  if (!entry) {
    entry = {
      id,
      nodeId: c.node.id,
      title: strv(c, named.title, isChar ? 'plotchar' : 'plotshape'),
      series: new Array(interp.n).fill(null),
      style: named.style ?? shapeStyle.circle,
      location: named.location ?? 'abovebar',
      color: colorv(named.color, makeColor('2962FF')),
      textcolor: colorv(named.textcolor, makeColor('000000')),
      size: named.size ?? sizeStyle.small,
      text: strv(c, named.text, ''),
      char: strv(c, named.char, ''),
      offset: Math.floor(num(c, named.offset, 0)),
      editable: named.editable ?? true,
      forceOverlay: boolv(c, named.force_overlay, false),
    };
    list.push(entry);
  }
  const on = boolv(c, cond);
  if (on) {
    const target = c.bar + entry.offset;
    if (target >= 0 && target < interp.n) entry.series[target] = true;
  }
  return null;
});

def('plotcandle', (c) => {
  const interp = c.interp;
  const id = `candle_${c.node.id}`;
  let entry = interp.outputs.plotcandles.find((p) => p.id === id);
  const named = c.named;
  if (!entry) {
    entry = {
      id,
      nodeId: c.node.id,
      title: strv(c, named.title, 'PlotCandle'),
      o: new Array(interp.n).fill(null),
      h: new Array(interp.n).fill(null),
      l: new Array(interp.n).fill(null),
      cc: new Array(interp.n).fill(null),
      colors: new Array(interp.n).fill(null),
      wickcolor: colorv(named.wickcolor, null),
      bordercolor: colorv(named.bordercolor, null),
      forceOverlay: boolv(c, named.force_overlay, false),
    };
    interp.outputs.plotcandles.push(entry);
  }
  const [o, h, l, cl] = c.positional;
  const gi = (v) => (v instanceof Series ? v.values[c.bar] : v);
  entry.o[c.bar] = gi(o);
  entry.h[c.bar] = gi(h);
  entry.l[c.bar] = gi(l);
  entry.cc[c.bar] = gi(cl);
  entry.colors[c.bar] = colorv(named.color, null);
  return null;
});

def('plotbar', (c) => {
  const interp = c.interp;
  const id = `bar_${c.node.id}`;
  let entry = interp.outputs.plotcandles.find((p) => p.id === id);
  const named = c.named;
  if (!entry) {
    entry = {
      id,
      nodeId: c.node.id,
      title: strv(c, named.title, 'PlotBar'),
      kind: 'bar',
      o: new Array(interp.n).fill(null),
      h: new Array(interp.n).fill(null),
      l: new Array(interp.n).fill(null),
      cc: new Array(interp.n).fill(null),
      colors: new Array(interp.n).fill(null),
      forceOverlay: boolv(c, named.force_overlay, false),
    };
    interp.outputs.plotcandles.push(entry);
  }
  const [o, h, l, cl] = c.positional;
  const gi = (v) => (v instanceof Series ? v.values[c.bar] : v);
  entry.o[c.bar] = gi(o);
  entry.h[c.bar] = gi(h);
  entry.l[c.bar] = gi(l);
  entry.cc[c.bar] = gi(cl);
  entry.colors[c.bar] = colorv(named.color, null);
  return null;
});

def('plotarrow', (c) => {
  const interp = c.interp;
  const id = `arrow_${c.node.id}`;
  let entry = interp.outputs.shapes.find((p) => p.id === id);
  if (!entry) {
    entry = {
      id,
      nodeId: c.node.id,
      title: strv(c, c.named.title, 'plotarrow'),
      series: new Array(interp.n).fill(null),
      style: 'arrow',
      isArrow: true,
      colorup: colorv(c.named.colorup, makeColor('089981')),
      colordown: colorv(c.named.colordown, makeColor('F23645')),
      offset: Math.floor(num(c, c.named.offset, 0)),
      minheight: num(c, c.named.minheight, 5),
      maxheight: num(c, c.named.maxheight, 100),
    };
    interp.outputs.shapes.push(entry);
  }
  const v = num(c, c.positional[0], NaN);
  if (Number.isFinite(v)) entry.series[c.bar] = v;
  return null;
});

def('hline', (c) => {
  const named = c.named;
  const interp = c.interp;
  const id = `hline_${c.node.id}`;
  if (interp.outputs.hlines.find((h) => h.id === id)) return null;
  interp.outputs.hlines.push({
    id,
    nodeId: c.node.id,
    price: num(c, c.positional[0], NaN),
    title: strv(c, named.title, ''),
    color: colorv(named.color, makeColor('787B86')),
    linestyle: named.linestyle ?? lineStyle.dashed,
    linewidth: num(c, named.linewidth, 1),
    display: named.display ?? displayStyle.all,
  });
  return null;
});

def('fill', (c) => {
  const interp = c.interp;
  const a = c.positional[0];
  const b = c.positional.length > 1 ? c.positional[1] : null;
  const named = c.named;
  // fill(hline1, hline2, color) or fill(plot1, plot2, color, title)
  const interp2 = interp;
  const id = `fill_${c.node.id}`;
  if (interp2.outputs.fills.find((f) => f.id === id)) return null;
  interp2.outputs.fills.push({
    id,
    nodeId: c.node.id,
    a,
    b,
    color: colorv(named.color ?? c.positional[2], makeColor('2962FF')),
    title: strv(c, named.title ?? c.positional[3], ''),
    transp: num(c, named.transp, 0),
  });
  return null;
});

def('bgcolor', (c) => {
  const color = c.positional[0];
  const named = c.named;
  const interp = c.interp;
  const id = `bg_${c.node.id}`;
  let entry = interp.outputs.bgcolors.find((b) => b.id === id);
  if (!entry) {
    entry = { id, nodeId: c.node.id, title: strv(c, named.title, ''), colors: new Array(interp.n).fill(null), transp: num(c, named.transp, 0), offset: Math.floor(num(c, named.offset, 0)) };
    interp.outputs.bgcolors.push(entry);
  }
  const cv = colorv(color, null);
  if (cv && c.bar + entry.offset < interp.n) entry.colors[c.bar + entry.offset] = cv;
  return null;
});

def('barcolor', (c) => {
  const color = c.positional[0];
  const named = c.named;
  const interp = c.interp;
  const id = `barcolor_${c.node.id}`;
  let entry = interp.outputs.barcolors.find((b) => b.id === id);
  if (!entry) {
    entry = { id, nodeId: c.node.id, title: strv(c, named.title, ''), colors: new Array(interp.n).fill(null), offset: Math.floor(num(c, named.offset, 0)) };
    interp.outputs.barcolors.push(entry);
  }
  const cv = colorv(color, null);
  if (cv && c.bar + entry.offset < interp.n) entry.colors[c.bar + entry.offset] = cv;
  return null;
});

def('alertcondition', (c) => {
  const cond = c.positional[0];
  const named = c.named;
  const interp = c.interp;
  const id = `alertcond_${c.node.id}`;
  let entry = interp.outputs.alertConditions.find((a) => a.id === id);
  if (!entry) {
    entry = {
      id,
      nodeId: c.node.id,
      title: strv(c, named.title, 'Alert'),
      message: strv(c, named.message, ''),
      flags: new Array(interp.n).fill(false),
    };
    interp.outputs.alertConditions.push(entry);
  }
  if (boolv(c, cond)) entry.flags[c.bar] = true;
  return null;
});

def('alert', (c) => {
  const interp = c.interp;
  const msg = strv(c, c.positional[0], '');
  const freq = c.named.freq ?? alertFreqStyle.once_per_bar_close;
  const firing = boolv(c, c.named.condition, true);
  if (!firing) return null;
  const last = interp.outputs.alerts[interp.outputs.alerts.length - 1];
  if (last && last.bar === c.bar && freq === alertFreqStyle.once_per_bar) {
    last.message = msg;
    return null;
  }
  if (last && last.bar === c.bar && freq === alertFreqStyle.once_per_bar_close) return null;
  interp.outputs.alerts.push({ bar: c.bar, message: msg, time: c.interp.bars[c.bar]?.t ?? null, freq });
  return null;
});

/* ---------------- drawing objects ---------------- */

function drawingFactory(type, ns) {
  const POSITIONAL = {
    lines: ['x1', 'y1', 'x2', 'y2', 'xloc', 'extend', 'color', 'style', 'width'],
    labels: ['x', 'y', 'text', 'xloc', 'yloc', 'color', 'style', 'textcolor', 'size', 'textalign', 'tooltip'],
    boxes: ['left', 'top', 'right', 'bottom', 'border_color', 'border_width', 'border_style', 'extend', 'xloc', 'bgcolor', 'text', 'text_size', 'text_color'],
    tables: ['position', 'columns', 'rows', 'bgcolor', 'frame_color', 'frame_width', 'border_color', 'border_width'],
  };
  return (c) => {
    const interp = c.interp;
    const named = { ...c.named };
    const order = POSITIONAL[ns] || [];
    for (let i = 0; i < c.positional.length && i < order.length; i++) {
      if (named[order[i]] === undefined) named[order[i]] = c.positional[i];
    }
    const list = interp.outputs[ns];
    const obj = { id: `${type}_${c.node.id}_${list.length}`, type, nodeId: c.node.id, created: c.bar };
    const g = (k, d) => (named[k] !== undefined ? named[k] : d);
    if (ns === 'lines') {
      Object.assign(obj, {
        x1: num(c, g('x1'), null),
        y1: num(c, g('y1'), null),
        x2: num(c, g('x2'), null),
        y2: num(c, g('y2'), null),
        xloc: g('xloc', 'bar_index'),
        color: colorv(g('color', null), makeColor('2962FF')),
        width: num(c, g('width', g('linewidth', 1)), 1),
        style: g('style', lineStyle.solid),
        extend: g('extend', extendStyle.none),
      });
    } else if (ns === 'labels') {
      Object.assign(obj, {
        x: num(c, g('x'), null),
        y: num(c, g('y'), null),
        text: strv(c, g('text', ''), ''),
        xloc: g('xloc', 'bar_index'),
        yloc: g('yloc', 'price'),
        color: colorv(g('color', null), makeColor('2962FF')),
        textcolor: colorv(g('textcolor', null), makeColor('FFFFFF')),
        style: g('style', 'label_down'),
        size: g('size', sizeStyle.normal),
        textalign: g('textalign', 'center'),
        tooltip: strv(c, g('tooltip', ''), ''),
      });
    } else if (ns === 'boxes') {
      Object.assign(obj, {
        left: num(c, g('left'), null),
        top: num(c, g('top'), null),
        right: num(c, g('right'), null),
        bottom: num(c, g('bottom'), null),
        border_color: colorv(g('border_color', null), makeColor('2962FF')),
        border_width: num(c, g('border_width', 1), 1),
        bgcolor: colorv(g('bgcolor', null), makeColor('2962FF', 90)),
        border_style: g('border_style', lineStyle.solid),
        extend: g('extend', extendStyle.none),
        text: strv(c, g('text', ''), ''),
        text_color: colorv(g('text_color', null), makeColor('000000')),
      });
    } else if (ns === 'tables') {
      Object.assign(obj, {
        position: g('position', positionStyle.top_right),
        bgcolor: colorv(g('bgcolor', null), makeColor('FFFFFF', 90)),
        border_color: colorv(g('border_color', null), makeColor('000000')),
        border_width: num(c, g('border_width', 0), 0),
        frame_color: colorv(g('frame_color', null), makeColor('000000')),
        frame_width: num(c, g('frame_width', 0), 0),
        cells: new Map(),
        columns: 0,
        rows: 0,
      });
      list.push(obj);
      return new TableHandle(obj, c);
    }
    // Enforce max drawing-object counts from the script's indicator() flags.
    // TradingView keeps only the last N drawings; we do the same to prevent
    // unbounded memory growth on long charts.
    const flags = interp.scriptFlags || {};
    const maxCounts = {
      lines: flags.max_lines_count || 50,
      labels: flags.max_labels_count || 50,
      boxes: flags.max_boxes_count || 50,
    };
    const max = maxCounts[ns];
    if (max && list.length > max) {
      list.splice(0, list.length - max);
    }
    list.push(obj);
    return obj;
  };
}

class TableHandle {
  constructor(obj, c) {
    this._obj = obj;
    this._c = c;
  }
  get __tableHandle() {
    return true;
  }
}

def('line.new', drawingFactory('line', 'lines'));
def('label.new', drawingFactory('label', 'labels'));
def('box.new', drawingFactory('box', 'boxes'));
def('table.new', drawingFactory('table', 'tables'));

function findDrawing(c, handle, list) {
  if (handle && handle.__tableHandle) return handle._obj;
  if (handle && handle.id) return handle;
  return list[list.length - 1] ?? null;
}

def('line.set_xy1', (c) => {
  const l = c.positional[0];
  if (l && l.type === 'line') {
    l.x1 = num(c, c.positional[1], l.x1);
    l.y1 = num(c, c.positional[2], l.y1);
  }
  return null;
});
def('line.set_xy2', (c) => {
  const l = c.positional[0];
  if (l && l.type === 'line') {
    l.x2 = num(c, c.positional[1], l.x2);
    l.y2 = num(c, c.positional[2], l.y2);
  }
  return null;
});
def('line.set_x1', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].x1 = num(c, c.positional[1], 0);
  return null;
});
def('line.set_x2', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].x2 = num(c, c.positional[1], 0);
  return null;
});
def('line.set_y1', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].y1 = num(c, c.positional[1], 0);
  return null;
});
def('line.set_y2', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].y2 = num(c, c.positional[1], 0);
  return null;
});
def('line.set_color', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].color = colorv(c.positional[1], c.positional[0].color);
  return null;
});
def('line.set_width', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].width = num(c, c.positional[1], 1);
  return null;
});
def('line.set_style', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].style = c.positional[1];
  return null;
});
def('line.set_extend', (c) => {
  if (c.positional[0]?.type === 'line') c.positional[0].extend = c.positional[1];
  return null;
});
def('line.delete', (c) => {
  const list = c.interp.outputs.lines;
  const i = list.indexOf(c.positional[0]);
  if (i >= 0) list.splice(i, 1);
  return null;
});
def('line.get_price', (c) => {
  const l = c.positional[0];
  const x = num(c, c.positional[1], 0);
  if (!l || l.x2 === l.x1) return l?.y1 ?? null;
  const t = (x - l.x1) / (l.x2 - l.x1);
  return l.y1 + (l.y2 - l.y1) * t;
});

/* ---------------- Pine v6 point-based line setters ----------------
 * These accept a `chart.point` object (constructed via chart.point.new or
 * chart.point.from_index) and update the corresponding x/y on the line.
 * When the point has a `time` (not `index`), it's used directly as the x
 * coordinate — the chart renderer handles the xloc.bar_time mapping.
 */
function applyPointToLine(line, point, which) {
  if (!line || line.type !== 'line' || !point) return;
  const isTime = point.time != null && point.index == null;
  const x = isTime ? point.time : (point.index != null ? point.index : null);
  const y = point.price != null ? point.price : null;
  if (which === 'first') {
    line.x1 = x != null ? x : line.x1;
    line.y1 = y != null ? y : line.y1;
    if (isTime) line.xloc = 'bar_time';
  } else if (which === 'second') {
    line.x2 = x != null ? x : line.x2;
    line.y2 = y != null ? y : line.y2;
    if (isTime) line.xloc = 'bar_time';
  }
}
def('line.set_first_point', (c) => {
  applyPointToLine(c.positional[0], c.positional[1], 'first');
  return null;
});
def('line.set_second_point', (c) => {
  applyPointToLine(c.positional[0], c.positional[1], 'second');
  return null;
});
def('line.set_point', (c) => {
  // Pine v6 has a `set_point(id, point)` form on some drawing objects, but
  // line doesn't — accept it gracefully anyway.
  applyPointToLine(c.positional[0], c.positional[1], 'first');
  return null;
});

def('label.set_xy', (c) => {
  const l = c.positional[0];
  if (l && l.type === 'label') {
    l.x = num(c, c.positional[1], l.x);
    l.y = num(c, c.positional[2], l.y);
  }
  return null;
});
def('label.set_text', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].text = strv(c, c.positional[1], '');
  return null;
});
def('label.set_color', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].color = colorv(c.positional[1], c.positional[0].color);
  return null;
});
def('label.set_textcolor', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].textcolor = colorv(c.positional[1], c.positional[0].textcolor);
  return null;
});
def('label.set_style', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].style = c.positional[1];
  return null;
});
def('label.set_size', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].size = c.positional[1];
  return null;
});
def('label.set_tooltip', (c) => {
  if (c.positional[0]?.type === 'label') c.positional[0].tooltip = strv(c, c.positional[1], '');
  return null;
});
def('label.delete', (c) => {
  const list = c.interp.outputs.labels;
  const i = list.indexOf(c.positional[0]);
  if (i >= 0) list.splice(i, 1);
  return null;
});

/* Pine v6 `label.set_point(label, chart.point)` — move a label to a
 * chart.point (time/index, price). */
def('label.set_point', (c) => {
  const l = c.positional[0];
  const p = c.positional[1];
  if (l && l.type === 'label' && p) {
    const isTime = p.time != null && p.index == null;
    l.x = isTime ? p.time : (p.index != null ? p.index : l.x);
    l.y = p.price != null ? p.price : l.y;
    if (isTime) l.xloc = 'bar_time';
  }
  return null;
});

def('box.set_lefttop', (c) => {
  const b = c.positional[0];
  if (b?.type === 'box') {
    b.left = num(c, c.positional[1], b.left);
    b.top = num(c, c.positional[2], b.top);
  }
  return null;
});
def('box.set_rightbottom', (c) => {
  const b = c.positional[0];
  if (b?.type === 'box') {
    b.right = num(c, c.positional[1], b.right);
    b.bottom = num(c, c.positional[2], b.bottom);
  }
  return null;
});
def('box.set_bgcolor', (c) => {
  if (c.positional[0]?.type === 'box') c.positional[0].bgcolor = colorv(c.positional[1], c.positional[0].bgcolor);
  return null;
});
def('box.set_border_color', (c) => {
  if (c.positional[0]?.type === 'box') c.positional[0].border_color = colorv(c.positional[1], c.positional[0].border_color);
  return null;
});
def('box.delete', (c) => {
  const list = c.interp.outputs.boxes;
  const i = list.indexOf(c.positional[0]);
  if (i >= 0) list.splice(i, 1);
  return null;
});

def('table.cell', (c) => {
  const h = c.positional[0];
  const obj = h && h.__tableHandle ? h._obj : null;
  if (!obj) return null;
  const col = Math.floor(num(c, c.positional[1], 0));
  const row = Math.floor(num(c, c.positional[2], 0));
  const named = c.named;
  obj.cells.set(`${col},${row}`, {
    text: strv(c, c.positional[3], ''),
    text_color: colorv(named.text_color, makeColor('000000')),
    bgcolor: colorv(named.bgcolor, null),
    text_size: named.text_size ?? sizeStyle.normal,
    text_halign: named.text_halign ?? 'center',
    text_valign: named.text_valign ?? 'center',
    width: named.width ?? null,
    height: named.height ?? null,
  });
  obj.columns = Math.max(obj.columns, col + 1);
  obj.rows = Math.max(obj.rows, row + 1);
  return null;
});
def('table.clear', (c) => {
  const h = c.positional[0];
  if (h && h.__tableHandle) {
    h._obj.cells.clear();
    h._obj.columns = 0;
    h._obj.rows = 0;
  }
  return null;
});
def('table.set_position', (c) => {
  const h = c.positional[0];
  if (h && h.__tableHandle) h._obj.position = c.positional[1];
  return null;
});
def('table.set_bgcolor', (c) => {
  const h = c.positional[0];
  if (h && h.__tableHandle) h._obj.bgcolor = colorv(c.positional[1], h._obj.bgcolor);
  return null;
});

/* ================================================================== *
 * request namespace
 * ================================================================== */

def('request.security', (c) => {
  const named = c.named;
  const symbol = strv(c, named.symbol ?? c.positional[0], c.interp.symbol?.symbol || '');
  const timeframe = strv(c, named.timeframe ?? c.positional[1], c.interp.timeframe?.period || '1D');
  const expression = named.expression ?? c.positional[2];
  const gaps = named.gaps ?? barmergeGaps.gaps_off;
  const lookahead = named.lookahead ?? barmergeLookahead.lookahead_off;
  void gaps;
  void lookahead;
  const result = c.interp.requestSymbol(symbol, timeframe, expression);
  // Host may return a series-like ({values, isSeries, length}); extract the
  // value at the current bar. Otherwise return as-is (scalar).
  if (result && result.isSeries && Array.isArray(result.values)) {
    return result.values[c.bar];
  }
  return result;
});

def('request.security_lower_tf', (c) => {
  const named = c.named;
  const symbol = strv(c, named.symbol ?? c.positional[0], c.interp.symbol?.symbol || '');
  const expression = named.expression ?? c.positional[2];
  const v = c.interp.requestSymbol(symbol, '1', expression);
  return new PineArray([v]);
});

def('request.currency_rate', (c) => {
  const from = strv(c, c.positional[0], 'USD');
  const to = strv(c, c.positional[1], 'USD');
  return from === to ? 1 : NaN;
});

// __real_dividends__ returns dividend amount on ex-div bar, na otherwise
def('request.dividends', (c) => c.interp.dividendsAt(c.bar));
// __real_dividends__ field constants
def('dividends.net',   () => 'net');
def('dividends.gross', () => 'gross');
// __real_splits__ returns split ratio field on split bars, na otherwise
def('request.splits', (c) => {
  const field = strv(c, c.positional[1], 'splits.numerator');
  const split = c.interp.splitsAt(c.bar);
  if (!split) return null;
  if (field === 'splits.denominator') return split.denominator;
  return split.numerator;
});
// __real_splits__ field constants
def('splits.numerator',   () => 'splits.numerator');
def('splits.denominator', () => 'splits.denominator');
// __real_earnings__ returns earnings field on report-date bars, na otherwise
def('request.earnings', (c) => {
  const field = strv(c, c.positional[1], 'earnings.actual');
  const e = c.interp.earningsAt(c.bar);
  if (!e) return null;
  if (field === 'earnings.estimate') return e.estimate;
  if (field === 'earnings.surprise') return (e.actual !== null && e.estimate !== null) ? (e.actual - e.estimate) : null;
  if (field === 'earnings.surprise_pct') return e.surprisePct;
  return e.actual;
});
// __real_earnings__ field constants
def('earnings.actual',       () => 'earnings.actual');
def('earnings.estimate',     () => 'earnings.estimate');
def('earnings.surprise',     () => 'earnings.surprise');
def('earnings.surprise_pct', () => 'earnings.surprise_pct');
def('request.quandl', () => NaN);
def('request.financial', () => NaN);
def('request.seed', () => NaN);

/**
 * Pine v6 `request.security_refreshed(symbol, timeframe, expression, gaps, lookahead, ignore_invalid_symbol)`.
 * Behaves like `request.security` but signals the host to refresh on every bar;
 * this engine's host already does that, so the implementation is identical.
 */
def('request.security_refreshed', (c) => {
  const named = c.named;
  const symbol = strv(c, named.symbol ?? c.positional[0], c.interp.symbol?.symbol || '');
  const timeframe = strv(c, named.timeframe ?? c.positional[1], c.interp.timeframe?.period || '1D');
  const expression = named.expression ?? c.positional[2];
  return c.interp.requestSymbol(symbol, timeframe, expression);
});

/**
 * Pine v6 `request.momentum_anomaly(momentum)` placeholder.
 * Returns `na` so v6 scripts that use it compile cleanly.
 */
def('request.momentum_anomaly', () => NaN);

/* ================================================================== *
 * chart namespace (Pine v6)
 * ================================================================== */

/**
 * `chart.left_visible_bar_time` / `chart.right_visible_bar_time` /
 * `chart.left_visible_bar_index` / `chart.right_visible_bar_index` — the
 * Pine v6 chart-context accessors. They are read live from the host chart
 * if available, otherwise fall back to the full data range.
 */
def('chart.left_visible_bar_time', (c) => {
  const interp = c.interp;
  const host = interp.host || {};
  const left = host.leftVisibleIndex ?? 0;
  return interp.bars[Math.max(0, Math.min(interp.bars.length - 1, Math.floor(left)))]?.t ?? null;
});
def('chart.right_visible_bar_time', (c) => {
  const interp = c.interp;
  const host = interp.host || {};
  const right = host.rightVisibleIndex ?? (interp.bars.length - 1);
  return interp.bars[Math.max(0, Math.min(interp.bars.length - 1, Math.floor(right)))]?.t ?? null;
});
def('chart.left_visible_bar_index', (c) => {
  const interp = c.interp;
  const host = interp.host || {};
  return Math.max(0, Math.floor(host.leftVisibleIndex ?? 0));
});
def('chart.right_visible_bar_index', (c) => {
  const interp = c.interp;
  const host = interp.host || {};
  return Math.max(0, Math.floor(host.rightVisibleIndex ?? (interp.bars.length - 1)));
});
def('chart.is_standard', () => true);
def('chart.is_heikinashi', () => false);
def('chart.point_from_index', (c) => {
  const i = Math.floor(num(c, c.positional[0], 0));
  const b = c.interp.bars[i];
  return b ? { index: i, time: b.t, price: b.c } : null;
});

/**
 * Pine v6 `chart.point.new(time, index, price)` — construct a chart point.
 * Any of the three args may be `na`. The point is used by drawing objects
 * (line.set_first_point, label.set_point, etc.) when `xloc=xloc.bar_time`.
 */
def('chart.point.new', (c) => {
  const t = c.positional[0];
  const i = c.positional[1];
  const p = c.positional[2];
  return {
    __point: true,
    time: t == null || Number.isNaN(num(c, t, NaN)) ? null : num(c, t, NaN),
    index: i == null || Number.isNaN(num(c, i, NaN)) ? null : num(c, i, NaN),
    price: p == null || Number.isNaN(num(c, p, NaN)) ? null : num(c, p, NaN),
  };
});
def('chart.point.from_index', (c) => {
  const i = Math.floor(num(c, c.positional[0], 0));
  const b = c.interp.bars[i];
  return b ? { __point: true, index: i, time: b.t, price: b.c } : null;
});
def('chart.point.from_time', (c) => {
  const t = num(c, c.positional[0], NaN);
  if (Number.isNaN(t)) return null;
  // Find the bar whose time is closest to (but <=) t.
  const bars = c.interp.bars;
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found >= 0 ? { __point: true, index: found, time: bars[found].t, price: bars[found].c } : null;
});

/* ================================================================== *
 * timeframe / time helpers
 * ================================================================== */

def('timeframe.change', (c) => {
  const spec = strv(c, c.positional[0], '');
  return withState(c, (s) => { s.last = null; s.result = false; }, (s) => {
    const t = c.interp.bars[c.bar]?.t;
    if (t == null) return false;
    const key = String(spec).toLowerCase();
    const d = new Date(t);
    let bucket;
    if (key === 'd' || key === '1d') bucket = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    else if (key === 'w' || key === '1w') bucket = Math.floor(t / (7 * 86400000));
    else if (key === 'm' || key === '1m') bucket = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    else if (/^\d+$/.test(key)) bucket = Math.floor(t / (Number(key) * 60000));
    else bucket = Math.floor(t / 86400000);
    const changed = s.last !== null && s.last !== bucket;
    s.last = bucket;
    return changed;
  });
});

def('time', (c) => {
  const named = c.named;
  const tf = named.timeframe;
  const t = c.interp.bars[c.bar]?.t ?? NaN;
  if (!tf) return t;
  return t;
});
def('time_close', (c) => {
  const t = c.interp.bars[c.bar]?.t ?? NaN;
  const next = c.interp.bars[c.bar + 1]?.t;
  return next != null ? next : t;
});
def('timeframe.period', (c) => c.interp.timeframe?.period ?? '1D');
/**
 * Pine v6 `timeframe.in_seconds(timeframe)` — returns the number of seconds
 * in one period of the given timeframe string (e.g. '1' → 60, '5' → 300,
 * 'D' → 86400). With no argument, uses the chart's current timeframe.
 */
def('timeframe.in_seconds', (c) => {
  const tf = c.positional.length > 0
    ? String(c.positional[0] || c.named.timeframe || '').trim()
    : (c.interp.timeframe?.period || '1D');
  const m = /^(\d*)([smhdwmo])$/.exec(tf.toLowerCase());
  if (!m) {
    if (tf === 'd' || tf === '1d') return 86400;
    if (tf === 'w' || tf === '1w') return 604800;
    if (tf === 'mo' || tf === '1mo') return 2592000;
    return 86400;
  }
  const n = m[1] === '' ? 1 : parseInt(m[1], 10);
  const unit = m[2];
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 };
  return (mult[unit] || 86400) * n;
});
def('timestamp', (c) => {
  const a = c.positional;
  if (a.length === 1) return num(c, a[0], NaN) * 1000;
  // timestamp(year, month, day[, hour, minute[, second]])
  const [y, mo, d, h = 0, mi = 0, s = 0] = a.map((v) => num(c, v, 0));
  return Date.UTC(y, mo - 1, d, h, mi, s);
});

def('dayofmonth', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'day');
});
def('dayofweek', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  const iso = tzPart(t, tz, 'weekday');
  const map = { Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6, Sat: 7, Sun: 1 };
  return map[iso] ?? 1;
});
def('hour', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'hour');
});
def('minute', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'minute');
});
def('second', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'second');
});
def('year', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'year');
});
def('month', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const tz = strv(c, c.positional[1], 'UTC');
  return tzPart(t, tz, 'month');
});
def('weekofyear', (c) => {
  const t = c.positional.length ? num(c, c.positional[0], NaN) : c.interp.bars[c.bar]?.t;
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((t - start) / 86400000 + new Date(start).getUTCDay() + 1) / 7);
});
function tzPart(t, tz, part) {
  if (t == null || Number.isNaN(t)) return NaN;
  try {
    const opts = { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
    const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(new Date(t));
    const get = (k) => parts.find((p) => p.type === k)?.value;
    switch (part) {
      case 'day': return Number(get('day'));
      case 'weekday': return get('weekday');
      case 'hour': return Number(get('hour')) % 24;
      case 'minute': return Number(get('minute'));
      case 'second': return Number(get('second'));
      case 'year': return Number(get('year'));
      case 'month': return Number(get('month'));
      default: return NaN;
    }
  } catch {
    return new Date(t).getUTCDate();
  }
}

def('barstate.islast', (c) => c.bar === c.interp.n - 1);
def('barstate.isfirst', (c) => c.bar === 0);
def('barstate.ishistory', (c) => c.bar < c.interp.n - 1);
def('barstate.isrealtime', (c) => c.bar === c.interp.n - 1);
def('barstate.isnew', (c) => c.bar === c.interp.n - 1);
def('barstate.isconfirmed', (c) => c.bar < c.interp.n - 1);
def('barstate.islastconfirmedhistory', (c) => c.bar === c.interp.n - 2);

def('na', (c) => {
  const v = c.positional[0];
  const x = v instanceof Series ? v.values[c.bar] : v;
  return x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
});
def('nz', (c) => {
  const v = c.positional[0];
  const r = c.positional.length > 1 ? c.positional[1] : 0;
  const x = v instanceof Series ? v.values[c.bar] : v;
  if (x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))) return r === null || r === undefined ? 0 : r;
  return x;
});
def('fixnan', (c) => {
  const v = c.positional[0];
  return withState(c, (s) => { s.last = null; }, (s) => {
    const x = v instanceof Series ? v.values[c.bar] : v;
    if (x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x))) return s.last;
    s.last = x;
    return x;
  });
});
def('tostring', (c) => c.interp.toStr(c.positional[0]));
/**
 * Pine v6 type-cast functions: `int(x)`, `float(x)`, `bool(x)`, `string(x)`.
 * These convert between types. `int` truncates; `float` and `bool` are
 * straightforward; `string` formats numbers using the interpreter's toStr.
 */
def('int', (c) => {
  const v = c.positional[0];
  if (v === null || v === undefined) return null;
  const n = c.interp.toNum(v);
  if (Number.isNaN(n)) return NaN;
  return Math.trunc(n);
});
def('float', (c) => {
  const v = c.positional[0];
  if (v === null || v === undefined) return null;
  return c.interp.toNum(v);
});
def('bool', (c) => {
  const v = c.positional[0];
  if (v === null || v === undefined) return null;
  return c.interp.toBool(v);
});
def('string', (c) => c.interp.toStr(c.positional[0]));
def('tonumber', (c) => {
  const v = c.positional[0];
  const n = Number(v instanceof Series ? v.values[c.bar] : v);
  return Number.isNaN(n) ? NaN : n;
});
def('color.new', (c) => makeColor(c.positional[0], num(c, c.positional[1], 0)));
def('color.rgb', (c) => new PineColor(hexFromRgb(num(c, c.positional[0], 0), num(c, c.positional[1], 0), num(c, c.positional[2], 0)), num(c, c.positional[3], 0)));
def('color.from_gradient', (c) => colorNamespace.from_gradient(...c.positional.map((v) => c.interp.toNum(v))));
def('color.t', (c) => makeColor(c.positional[0], num(c, c.positional[1], 0)));
/**
 * Pine v6 bare `color(x)` — convert a value to a color. If x is already a
 * color, return it; if x is na, return na (null); otherwise treat x as a
 * color hex/name and convert it. This is the form used in
 * `label.new(..., color=color(na), ...)` to pass na as a color argument.
 */
def('color', (c) => {
  const v = c.positional[0];
  if (v === null || v === undefined) return null;
  if (v instanceof PineColor) return v;
  if (typeof v === 'string') return makeColor(v);
  if (typeof v === 'number' && !Number.isNaN(v)) return makeColor(String(v));
  return null;
});
def('runtime.error', (c) => {
  throw new PineRuntimeError(strv(c, c.positional[0], 'runtime error'), c.node.line);
});
def('runtime.log', (c) => {
  c.interp.outputs.logs.push({ bar: c.bar, message: strv(c, c.positional[0], '') });
  return null;
});
def('runtime.timenow', () => Date.now());
def('max_bars_back', () => null);
def('indicator', (c) => {
  const named = c.named;
  if (named.title) c.interp.scriptName = strv(c, named.title, '');
  // Pine v6 indicator declaration flags. We store them on the interpreter so
  // the host can pick them up; defaults match Pine v6 documentation.
  c.interp.scriptFlags = {
    overlay: named.overlay !== undefined ? boolv(c, named.overlay, true) : null,
    format: named.format ?? null,
    precision: named.precision ?? null,
    scale: named.scale ?? null,
    max_bars_back: named.max_bars_back !== undefined ? Math.floor(num(c, named.max_bars_back, 0)) : null,
    max_lines_count: named.max_lines_count !== undefined ? Math.floor(num(c, named.max_lines_count, 0)) : null,
    max_labels_count: named.max_labels_count !== undefined ? Math.floor(num(c, named.max_labels_count, 0)) : null,
    max_boxes_count: named.max_boxes_count !== undefined ? Math.floor(num(c, named.max_boxes_count, 0)) : null,
    max_polylines_count: named.max_polylines_count !== undefined ? Math.floor(num(c, named.max_polylines_count, 0)) : null,
    dynamic_requests: named.dynamic_requests !== undefined ? boolv(c, named.dynamic_requests) : false,
    calc_bars_count: named.calc_bars_count !== undefined ? Math.floor(num(c, named.calc_bars_count, 0)) : null,
    max_paint_count: named.max_paint_count !== undefined ? Math.floor(num(c, named.max_paint_count, 0)) : null,
    explicit_plot_zorder: named.explicit_plot_zorder !== undefined ? boolv(c, named.explicit_plot_zorder) : false,
    display: named.display ?? null,
    timeframe: named.timeframe ?? null,
    timeframe_gaps: named.timeframe_gaps !== undefined ? boolv(c, named.timeframe_gaps, true) : null,
  };
  return null;
});
def('strategy', (c) => {
  const named = c.named;
  const s = c.interp.outputs.strategy;
  if (named.title) c.interp.scriptName = strv(c, named.title, '');
  if (named.initial_capital !== undefined) s.initialCapital = num(c, named.initial_capital, s.initialCapital);
  if (named.commission_value !== undefined) s.commission = num(c, named.commission_value, 0);
  if (named.slippage !== undefined) s.slippage = num(c, named.slippage, 0);
  if (named.default_qty_type !== undefined) s.defaultQtyType = named.default_qty_type;
  if (named.default_qty_value !== undefined) s.defaultQty = num(c, named.default_qty_value, 1);
  if (named.overlay !== undefined) s.overlay = boolv(c, named.overlay, true);
  if (named.calc_on_order_fills !== undefined) s.calcOnOrderFills = boolv(c, named.calc_on_order_fills);
  // Pine v6 strategy additions
  c.interp.scriptFlags = c.interp.scriptFlags || {};
  c.interp.scriptFlags.calc_bars_count = named.calc_bars_count !== undefined ? Math.floor(num(c, named.calc_bars_count, 0)) : null;
  c.interp.scriptFlags.max_paint_count = named.max_paint_count !== undefined ? Math.floor(num(c, named.max_paint_count, 0)) : null;
  c.interp.scriptFlags.max_lines_count = named.max_lines_count !== undefined ? Math.floor(num(c, named.max_lines_count, 0)) : null;
  c.interp.scriptFlags.max_labels_count = named.max_labels_count !== undefined ? Math.floor(num(c, named.max_labels_count, 0)) : null;
  c.interp.scriptFlags.max_boxes_count = named.max_boxes_count !== undefined ? Math.floor(num(c, named.max_boxes_count, 0)) : null;
  c.interp.scriptFlags.dynamic_requests = named.dynamic_requests !== undefined ? boolv(c, named.dynamic_requests) : false;
  c.interp.scriptFlags.max_bars_back = named.max_bars_back !== undefined ? Math.floor(num(c, named.max_bars_back, 0)) : null;
  if (named.pyramiding !== undefined) s.pyramiding = Math.floor(num(c, named.pyramiding, 1));
  if (named.process_orders_on_close !== undefined) s.processOrdersOnClose = boolv(c, named.process_orders_on_close);
  if (named.close_entries_when !== undefined) s.closeEntriesWhen = named.close_entries_when;
  // __commission_type_support__ commission_type support
  if (named.commission_type !== undefined) s.commissionType = strv(c, named.commission_type, 'percent');
  return null;
});
// __commission_type_support__ strategy.commission.* constants
def('strategy.commission.percent',           () => 'percent');
def('strategy.commission.cash_per_contract', () => 'cash_per_contract');
def('strategy.commission.cash_per_order',    () => 'cash_per_order');
def('library', () => null);
def('study', (c) => BUILTINS.get('indicator')(c));

export { context, withState, num, boolv, strv, colorv, barsOf, makeSubCtx };

/* ================================================================== *
 * strategy namespace
 * ================================================================== */

// __commission_type_support__ compute commission based on commission_type
function computeCommission(s, size, fill) {
  const cv = Number(s.commission) || 0;
  if (cv === 0) return 0;
  const type = s.commissionType || 'percent';
  if (type === 'cash_per_contract') return Math.abs(size) * cv;
  if (type === 'cash_per_order') return cv;
  return Math.abs(size) * fill * (cv / 100);
}

function stratState(c) {
  return c.interp.outputs.strategy;
}

function doEntry(c, direction, qty) {
  const s = stratState(c);
  const price = c.interp.bars[c.bar]?.c ?? NaN;
  const slip = s.slippage || 0;
  const fill = direction === 'long' ? price + slip : price - slip;
  const q = Number.isFinite(qty) && qty > 0 ? qty : s.defaultQty;
  const signed = direction === 'long' ? q : -q;
  // __entry_leg_commission__ entry-leg commission (Pine charges both legs)
  const entryCommission = computeCommission(s, signed, fill);

  if (s.position.size !== 0 && Math.sign(s.position.size) !== Math.sign(signed)) {
    closePosition(c, 'reverse', price);
  }
  const prev = s.position.size;
  const newSize = prev + signed;
  s.position.avgPrice = prev === 0 ? fill : (s.position.avgPrice * Math.abs(prev) + fill * Math.abs(signed)) / Math.abs(newSize);
  if (prev === 0) s.position.entryBar = c.bar;
  s.position.size = newSize;
  s.position.dir = Math.sign(newSize);
  // __entry_leg_commission__ accumulate across pyramided entries
  s.position.entryCommission = (s.position.entryCommission || 0) + entryCommission;
  const order = {
    bar: c.bar,
    time: c.interp.bars[c.bar]?.t,
    kind: direction,
    qty: signed,
    price: fill,
    id: `ord${s.orders.length}`,
  };
  s.orders.push(order);
  return order;
}

function closePosition(c, reason = 'close', priceOverride = null) {
  const s = stratState(c);
  if (s.position.size === 0) return null;
  const price = priceOverride ?? c.interp.bars[c.bar]?.c ?? NaN;
  const slip = s.slippage || 0;
  const fill = s.position.size > 0 ? price - slip : price + slip;
  const size = s.position.size;
  const gross = (fill - s.position.avgPrice) * size;
  // __entry_leg_commission__ total commission = entry leg + exit leg
  const exitCommission = computeCommission(s, size, fill);
  const entryCommission = s.position.entryCommission || 0;
  const commission = exitCommission + entryCommission;
  const trade = {
    entryBar: s.position.entryBar,
    exitBar: c.bar,
    entryTime: c.interp.bars[s.position.entryBar]?.t ?? null,
    exitTime: c.interp.bars[c.bar]?.t ?? null,
    entryPrice: s.position.avgPrice,
    exitPrice: fill,
    size,
    direction: size > 0 ? 'long' : 'short',
    profit: gross - commission,
    commission,
    reason,
  };
  s.closedTrades.push(trade);
  s.trades.push(trade);
  const eq = (s.equityCurve[c.bar] ?? s.initialCapital) + trade.profit;
  s.equityCurve[c.bar] = eq;
  s.position = { size: 0, avgPrice: NaN, entryBar: -1, dir: 0 };
  return trade;
}

def('strategy.entry', (c) => {
  const named = c.named;
  const direction = strv(c, named.direction ?? c.positional[1], 'long');
  const qtyRaw = named.qty ?? c.positional[2];
  const qty = qtyRaw === undefined || qtyRaw === null ? NaN : num(c, qtyRaw, NaN);
  return doEntry(c, direction, qty);
});
def('strategy.order', (c) => {
  const named = c.named;
  const direction = strv(c, named.direction ?? c.positional[1], 'long');
  const qtyRaw = named.qty ?? c.positional[2];
  const qty = qtyRaw === undefined || qtyRaw === null ? NaN : num(c, qtyRaw, NaN);
  return doEntry(c, direction, qty);
});
def('strategy.close', (c) => closePosition(c, strv(c, c.named.comment, 'close')));
def('strategy.close_all', (c) => closePosition(c, 'close_all'));
def('strategy.exit', (c) => {
  // Simplified: evaluate stop/limit against the current bar's range and exit if hit.
  const named = c.named;
  const s = stratState(c);
  if (s.position.size === 0) return null;
  const bar = c.interp.bars[c.bar];
  const from = named.from_entry;
  void from;
  // Track the protective order; it is evaluated on subsequent bars.
  let pending = s.pendingExit;
  if (!pending || pending.entryBar !== s.position.entryBar) {
    pending = {
      entryBar: s.position.entryBar,
      stop: named.stop != null ? num(c, named.stop, NaN) : null,
      limit: named.limit != null ? num(c, named.limit, NaN) : null,
      profit: named.profit != null ? num(c, named.profit, NaN) : null,
      loss: named.loss != null ? num(c, named.loss, NaN) : null,
      qtyPercent: named.qty_percent != null ? num(c, named.qty_percent, 100) : 100,
      trail: named.trail_points != null ? num(c, named.trail_points, NaN) : null,
      comment: strv(c, named.comment, 'exit'),
    };
    s.pendingExit = pending;
  } else {
    if (named.stop != null) pending.stop = num(c, named.stop, pending.stop);
    if (named.limit != null) pending.limit = num(c, named.limit, pending.limit);
  }
  void bar;
  return null;
});
def('strategy.cancel', (c) => {
  stratState(c).pendingExit = null;
  return null;
});
def('strategy.cancel_all', (c) => {
  stratState(c).pendingExit = null;
  return null;
});

/* ================================================================== *
 * Global resolution
 * ================================================================== */

const NS_CONSTANTS = {
  'plot.style': plotStyle,
  // Pine v5/v6 references plot styles as plot.style_line, plot.style_columns, etc.
  // These are a single identifier with an underscore (not a dotted path), so we
  // register them explicitly here.
  'plot.style_line': plotStyle.line,
  'plot.style_stepline': plotStyle.stepline,
  'plot.style_histogram': plotStyle.histogram,
  'plot.style_cross': plotStyle.cross,
  'plot.style_area': plotStyle.area,
  'plot.style_columns': plotStyle.columns,
  'plot.style_circles': plotStyle.circles,
  'plot.style_linebr': plotStyle.linebr,
  'plot.style_areabr': plotStyle.areabr,
  'plot.style_stepline_diamond': plotStyle.stepline_diamond,
  'plot.style_steplinebr': plotStyle.steplinebr,
  'plot.style_labels': plotStyle.labels,
  'shape': shapeStyle,
  'shape.style': shapeStyle,
  // Pine style constants use underscore notation (shape.style_*, label.style_*, etc.)
  'shape.xcross': 'xcross', 'shape.cross': 'cross', 'shape.triangleup': 'triangleup',
  'shape.triangledown': 'triangledown', 'shape.flag': 'flag', 'shape.circle': 'circle',
  'shape.arrowup': 'arrowup', 'shape.arrowdown': 'arrowdown', 'shape.labelup': 'labelup',
  'shape.labeldown': 'labeldown', 'shape.square': 'square', 'shape.diamond': 'diamond',
  'size': sizeStyle,
  'position': positionStyle,
  'text': textStyle,
  'extend': extendStyle,
  'xloc': xlocStyle,
  'yloc': ylocStyle,
  'display': displayStyle,
  'scale': scaleStyle,
  // hline.style_*
  'hline.style_solid': 'solid', 'hline.style_dotted': 'dotted', 'hline.style_dashed': 'dashed',
  // line.style_*
  'line.style_solid': 'solid', 'line.style_dotted': 'dotted', 'line.style_dashed': 'dashed',
  // label.style_*
  'label.style_none': 'none', 'label.style_xcross': 'xcross', 'label.style_cross': 'cross',
  'label.style_triangleup': 'triangleup', 'label.style_triangledown': 'triangledown',
  'label.style_flag': 'flag', 'label.style_circle': 'circle', 'label.style_arrowup': 'arrowup',
  'label.style_arrowdown': 'arrowdown', 'label.style_label_up': 'labelup',
  'label.style_label_down': 'labeldown', 'label.style_label_left': 'label_left',
  'label.style_label_right': 'label_right', 'label.style_label_lower_left': 'lower_left',
  'label.style_label_lower_right': 'lower_right', 'label.style_label_upper_left': 'upper_left',
  'label.style_label_upper_right': 'upper_right', 'label.style_square': 'square',
  'label.style_label_center': 'center', 'label.style_text_left': 'left',
  'label.style_text_right': 'right', 'label.style_text_center': 'center',
  // barmerge.gaps_* and barmerge.lookahead_*
  'barmerge.gaps_off': 'gaps_off', 'barmerge.gaps_on': 'gaps_on',
  'barmerge.lookahead_off': 'lookahead_off', 'barmerge.lookahead_on': 'lookahead_on',
  // alert.freq_*
  'alert.freq_once_per_bar': 'once_per_bar', 'alert.freq_once_per_bar_close': 'once_per_bar_close',
  'alert.freq_alert_once': 'alert_once',
  // strategy.*
  'strategy.direction_long': 'long', 'strategy.direction_short': 'short', 'strategy.direction_all': 'all',
  'strategy.order_market': 'market', 'strategy.order_limit': 'limit', 'strategy.order_stop': 'stop',
  // location.*
  'location.abovebar': 'abovebar', 'location.belowbar': 'belowbar',
  'location.top': 'top', 'location.bottom': 'bottom', 'location.absolute': 'absolute',
  // format.*
  'format.price': 'price', 'format.volume': 'volume', 'format.percent': 'percent',
  'format.mintick': 'mintick', 'format.inherit': 'inherit',
  // size.*
  'size.auto': 'auto', 'size.tiny': 'tiny', 'size.small': 'small',
  'size.normal': 'normal', 'size.large': 'large', 'size.huge': 'huge',
  // extend.*
  'extend.left': 'left', 'extend.right': 'right', 'extend.both': 'both', 'extend.none': 'none',
  // xloc.*
  'xloc.bar_index': 'bar_index', 'xloc.bar_time': 'bar_time',
  // yloc.*
  'yloc.price': 'price', 'yloc.abovebar': 'abovebar', 'yloc.belowbar': 'belowbar',
  // display.*
  'display.all': 1, 'display.none': 0, 'display.data_window': 2, 'display.pane': 3,
  // scale.*
  'scale.right': 1, 'scale.left': 2, 'scale.none': 0,
  'barmerge': { ...barmergeGaps, ...barmergeLookahead },
  'barmerge.gaps': barmergeGaps,
  'barmerge.lookahead': barmergeLookahead,
  'currency': currencyStyle,
  'order': orderStyle,
  'direction': directionStyle,
  'alert': alertFreqStyle,
  'strategy.direction': directionStyle,
  'strategy.order': orderStyle,
  'math': mathNamespaceExtras,
  'color': colorNamespace,
  'location': { abovebar: 'abovebar', belowbar: 'belowbar', top: 'top', bottom: 'bottom', absolute: 'absolute' },
  'format': { price: 'price', volume: 'volume', percent: 'percent', mintick: 'mintick', inherit: 'inherit' },
  'scale.right': 1,
  'scale.left': 2,
  'scale.none': 0,
};

/**
 * Namespaces that must resolve as *objects* when referenced without a call,
 * e.g. `label.new(...)` resolves `label` first, or `array.size(a)`.
 * Constants namespaces such as `plot.style_area` / `label.style_label_down`
 * are merged in here as well.
 */
const CONSTANT_NAMESPACES = {
  plot: plotStyle,
  'plot.style': plotStyle,
  shape: shapeStyle,
  size: sizeStyle,
  position: positionStyle,
  text: textStyle,
  extend: extendStyle,
  xloc: xlocStyle,
  yloc: ylocStyle,
  display: displayStyle,
  location: { abovebar: 'abovebar', belowbar: 'belowbar', top: 'top', bottom: 'bottom', absolute: 'absolute' },
  line: lineStyle,
  'line.style': lineStyle,
  label: { ...shapeStyle, ...positionStyle, ...sizeStyle },
  'label.style': shapeStyle,
  hline: lineStyle,
  'hline.style': lineStyle,
  box: { ...lineStyle, ...extendStyle },
  'box.style': lineStyle,
  table: positionStyle,
  'table.position': positionStyle,
  alert: alertFreqStyle,
  'alert.freq': alertFreqStyle,
  strategy: { ...directionStyle, ...orderStyle },
  'strategy.direction': directionStyle,
  'strategy.order': orderStyle,
  order: orderStyle,
  direction: directionStyle,
  currency: currencyStyle,
  scale: scaleStyle,
  format: { price: 'price', volume: 'volume', percent: 'percent', mintick: 'mintick', inherit: 'inherit' },
  barmerge: { ...barmergeGaps, ...barmergeLookahead },
  'barmerge.gaps': barmergeGaps,
  'barmerge.lookahead': barmergeLookahead,
  math: mathNamespaceExtras,
  color: colorNamespace,
  session: { regular: 'regular', extended: 'extended' },
};

function buildLibraryNamespaces() {
  const out = {};
  // Start from the constant namespaces (deep-ish copy so builtins can be merged).
  for (const [ns, value] of Object.entries(CONSTANT_NAMESPACES)) {
    out[ns] = { ...value };
  }
  // Merge every built-in member (ta.sma, array.push, label.new, ...).
  for (const key of BUILTINS.keys()) {
    const dot = key.indexOf('.');
    if (dot <= 0) continue;
    const ns = key.slice(0, dot);
    const member = key.slice(dot + 1);
    if (member.startsWith('__')) continue;
    if (!out[ns] || typeof out[ns] !== 'object') out[ns] = {};
    out[ns][member] = BUILTINS.get(key);
  }
  return out;
}
let LIBRARY_NS = null;

export function resolveGlobal(name) {
  if (!name) return undefined;
  if (name in NS_CONSTANTS) return NS_CONSTANTS[name];
  if (name.includes('.')) {
    // Walk the namespace chain: `plot.style_line` -> NS_CONSTANTS['plot.style'].line
    const parts = name.split('.');
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const head = parts.slice(0, cut).join('.');
      const tail = parts.slice(cut);
      const ns = NS_CONSTANTS[head];
      if (ns && typeof ns === 'object') {
        let cur = ns;
        let ok = true;
        for (const t of tail) {
          if (cur == null || !(t in cur)) {
            ok = false;
            break;
          }
          cur = cur[t];
        }
        if (ok) return cur;
      }
    }
    return undefined;
  }
  if (name === 'math.pi') return Math.PI;
  if (name === 'na') return null;
  // Bare namespace reference (label, line, array, matrix, map, str, ...)
  if (!LIBRARY_NS) LIBRARY_NS = buildLibraryNamespaces();
  if (name in LIBRARY_NS) return LIBRARY_NS[name];
  return undefined;
}

export function callBuiltin(name, ctx) {
  const fn = BUILTINS.get(name);
  if (!fn) throw new PineRuntimeError(`Unknown built-in '${name}'`);
  return fn(ctx);
}

export { bindArgs, makeSubCtx as subContext, isNa, at, PineArray, PineMatrix, PineMap };
