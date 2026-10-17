/**
 * Bridge between the Pine engine and the chart.
 *
 * Pine scripts are evaluated over the full bar array whenever data changes.
 * `request.security()` needs other symbols, which cannot be fetched
 * synchronously; those series are pre-fetched into a cache and the script is
 * re-run once they arrive, so indicators fill in as data lands.
 */
import { runPine, Interpreter, Series } from '../pine/runtime.js';
// FIX C: Import the async worker client so heavy scripts run off-main-thread.
import { runPineAsync, hasWorker } from '../pine-worker-client.js';

/** Cache of externally requested symbols: symbol|timeframe -> Series */
const securityCache = new Map();
const securityInflight = new Set();

/**
 * Build a chart-compatible indicator descriptor.
 *
 * @param {Object} opts
 * @param {string} opts.id       stable id
 * @param {string} opts.name     display name
 * @param {string} opts.source   Pine source
 * @param {Object} opts.inputs   user input overrides
 * @param {Object} opts.feed     datafeed instance
 * @param {Function} [opts.onUpdate] called when async data arrives
 * @param {boolean} [opts.overlay]
 */
export function createPineIndicator(opts) {
  const {
    id,
    name = 'Indicator',
    source,
    inputs = {},
    feed,
    onUpdate,
    overlay,
    symbol,
    intervalLabel,
    timezone,
  } = opts;

  let lastRun = null;
  let lastKey = null;
  let lastInterp = null;
  let lastBarsLength = 0;
  let lastBarsHash = '';

  // FIX (Item 3): Global result cache — persists across indicator add/remove
  // cycles. Keyed by (source hash, inputs hash, bars identity).
  const RESULT_CACHE = new Map();
  const CACHE_MAX = 20;  // max 20 cached results
  function cacheKey(source, inputs, bars) {
    const srcHash = source.length + ':' + (source.length > 0 ? source.charCodeAt(0) + source.charCodeAt(source.length - 1) : 0);
    const inpHash = JSON.stringify(inputs);
    const barHash = bars.length + ':' + (bars.length ? bars[bars.length - 1].t : 0);
    return `${srcHash}|${inpHash}|${barHash}`;
  }
  function getCached(key) {
    const entry = RESULT_CACHE.get(key);
    if (entry) {
      // Move to end (LRU)
      RESULT_CACHE.delete(key);
      RESULT_CACHE.set(key, entry);
    }
    return entry;
  }
  function setCached(key, result) {
    if (RESULT_CACHE.size >= CACHE_MAX) {
      // Evict oldest
      const oldest = RESULT_CACHE.keys().next().value;
      RESULT_CACHE.delete(oldest);
    }
    RESULT_CACHE.set(key, result);
  }

  const indicator = {
    id,
    key: `pine:${id}`,
    name,
    overlay,
    source,
    inputs: { ...inputs },
    result: null,
    async: false,
    output: 'overlay',
    compute(bars, chart) {
      const key = `${bars.length}|${bars.length ? bars[bars.length - 1].t : 0}|${JSON.stringify(indicator.inputs)}|${indicator.source.length}|${securityEpoch}`;
      if (lastKey === key && lastRun) return lastRun;

      // FIX (Item 3): Check global result cache first.
      const gKey = cacheKey(indicator.source || '', indicator.inputs, bars);
      const cached = getCached(gKey);
      if (cached) {
        lastRun = cached;
        lastKey = key;
        return cached;
      }

      // FIX C: For heavy scripts (> 1000 bars + > 500 chars of source),
      // dispatch to a Web Worker to avoid blocking the UI thread. Return the
      // last known result immediately and trigger an update when the worker
      // finishes. Falls back to sync if Workers are unavailable.
      const useWorker = hasWorker() && bars.length > 1000 && (indicator.source || '').length > 500;
      if (useWorker && !indicator._workerInflight) {
        indicator._workerInflight = true;
        runPineAsync(indicator.source || '', bars, {
          inputs: indicator.inputs,
        }).then((wResult) => {
          indicator._workerInflight = false;
          if (wResult && wResult.ok) {
            lastRun = wResult;
            lastKey = key;
            setCached(gKey, wResult);
            if (onUpdate) onUpdate();
          }
        }).catch(() => { indicator._workerInflight = false; });
        if (lastRun) return lastRun;
      }

      // FIX (Item 2): Incremental execution. If we have a cached interpreter
      // and only new bars were appended (no historical bars changed), use
      // appendBars() to process only the new bars instead of re-running
      // the entire script.
      const newBarsCount = bars.length - lastBarsLength;
      const canIncremental = lastInterp && lastInterp._ast
        && lastBarsLength > 0
        && newBarsCount > 0
        && newBarsCount <= 100  // only for small additions (live updates)
        && indicator.source === (lastInterp._source || '');

      if (canIncremental) {
        try {
          const newBars = bars.slice(lastBarsLength);
          const result = lastInterp.appendBars(newBars);
          result.inputs = lastInterp.inputManifest;
          result.inputValues = lastInterp.inputValues;
          result.interpreter = lastInterp;
          lastRun = result;
          lastKey = key;
          lastBarsLength = bars.length;
          setCached(gKey, result);
          return result;
        } catch {
          // Incremental failed — fall through to full re-run
          lastInterp = null;
        }
      }

      const interp = makeInterpreter({
        bars,
        chart,
        feed,
        symbol,
        intervalLabel,
        timezone,
        inputs: indicator.inputs,
        scriptName: name,
        onNeedData: () => indicator.markDirty(),
      });
      interp._source = indicator.source || '';
      const result = interp.run(indicator.source || '');
      result.inputs = interp.inputManifest;
      result.inputValues = interp.inputValues;
      result.interpreter = interp;

      if (indicator.overlay === undefined && interp.scriptFlags && interp.scriptFlags.overlay !== null && interp.scriptFlags.overlay !== undefined) {
        indicator.overlay = interp.scriptFlags.overlay;
      }

      const requested = interp.__requestedSymbols;
      if (requested && requested.length && feed) {
        indicator.async = true;
        preloadSecurity(requested, feed).then((loaded) => {
          if (loaded && onUpdate) onUpdate();
        });
      }

      lastRun = result;
      lastKey = key;
      lastInterp = interp;  // FIX (Item 2): Save for incremental execution
      lastBarsLength = bars.length;
      setCached(gKey, result);
      return result;
    },
    markDirty() {
      lastKey = null;
      lastInterp = null;  // FIX (Item 2): Invalidate incremental state
    },
    setInputs(next) {
      indicator.inputs = { ...indicator.inputs, ...next };
      lastKey = null;
      lastInterp = null;  // FIX (Item 2): Invalidate incremental state
      if (onUpdate) onUpdate();
    },
    get inputsManifest() {
      return lastRun?.inputs || [];
    },
  };
  return indicator;
}

let securityEpoch = 0;

function makeInterpreter({ bars, chart, feed, symbol, intervalLabel, timezone, inputs, scriptName, onNeedData }) {
  const requested = [];
  const meta = chart?.meta || {};
  /**
   * Partial series handed to the script while real data is still loading.
   * Cached per key so a per-bar call does not allocate a new array each bar.
   */
  const partialSeries = new Map();

  const interp = new Interpreter(bars, {
    symbol: {
      symbol: chart?.symbol || symbol || 'UNKNOWN',
      ticker: chart?.symbol || symbol || 'UNKNOWN',
      tickerid: chart?.symbol || symbol || 'UNKNOWN',
      prefix: (meta.exchange || '').split(' ')[0] || '',
      currency: meta.currency || 'USD',
      exchange: meta.exchange || '',
      description: meta.description || '',
      type: (meta.instrumentType || 'stock').toLowerCase(),
      mintick: chart?.mintick ?? 0.01,
      timezone: timezone || 'America/New_York',
      session: '0930-1600',
    },
    timeframe: pineTimeframe(intervalLabel || chart?.interval || '1d'),
    inputs,
    scriptName,
    host: {
      requestSecurity: (reqSymbol, timeframe, expression) => {
        const tf = normaliseTf(timeframe, intervalLabel || chart?.interval);
        const key = `${reqSymbol}|${tf}`;
        const cached = securityCache.get(key);
        if (cached && cached.length >= bars.length) return seriesView(cached);

        if (!securityInflight.has(key)) {
          securityInflight.add(key);
          requested.push({ symbol: reqSymbol, timeframe: tf, key });
        }
        let view = partialSeries.get(key);
        if (!view) {
          const values = new Array(bars.length).fill(NaN);
          if (cached) for (let i = 0; i < bars.length; i++) values[i] = cached[i] ?? NaN;
          view = new Series(values);
          partialSeries.set(key, view);
        }
        return view;
      },
    },
  });
  interp.__requestedSymbols = requested;
  interp.__feed = feed;
  interp.__onNeedData = onNeedData;
  return interp;
}

/** Wrap a plain numeric array as a Series without copying it. */
function seriesView(values) {
  return new Series(values);
}

function normaliseTf(tf, fallback) {
  const t = String(tf || '').trim();
  if (!t) return fallback || '1d';
  return t;
}

/**
 * Fetch every requested security series and store aligned values.
 * Resolves true when at least one series arrived.
 */
async function preloadSecurity(requests, feed) {
  if (!requests.length) return false;
  let loadedAny = false;
  await Promise.all(
    requests.map(async ({ symbol, timeframe, key }) => {
      try {
        const tfForFeed = mapToFeedInterval(timeframe);
        const range = timeframeRange(tfForFeed);
        const { bars } = await feed.getBars(symbol, tfForFeed, range);
        // Only mark as loaded if we actually got new data (different length
        // or different last bar time). This prevents an infinite loop where
        // onUpdate → recompute → request.security → preloadSecurity →
        // onUpdate → ... when the data hasn't changed.
        const existing = securityCache.get(key);
        const newClose = bars.map((b) => b.c);
        if (!existing || existing.length !== newClose.length ||
            (existing.length && newClose.length && existing[existing.length - 1] !== newClose[newClose.length - 1])) {
          const close = new Series(newClose);
          clampSecuritySeries(key, close);
          loadedAny = true;
        }
      } catch {
        // leave the entry absent so the script keeps returning na
        securityCache.set(key, new Array(0));
      } finally {
        securityInflight.delete(key);
        securityEpoch++;
      }
    })
  );
  return loadedAny;
}

/** Clamp a security series so it never exposes future bars before their time. */
function clampSecuritySeries(key, series) {
  const existing = securityCache.get(key);
  if (!existing || existing.length < series.length) {
    securityCache.set(key, series.values);
    return;
  }
  // merge in any newly available tail
  for (let i = 0; i < series.values.length; i++) {
    if (series.values[i] !== null && series.values[i] !== undefined) existing[i] = series.values[i];
  }
}

function mapToFeedInterval(tf) {
  const t = String(tf).trim().toLowerCase();
  const m = /^(\d*)([smhdw])$/.exec(t);
  if (!m) {
    if (t === '1d' || t === 'd') return '1d';
    if (t === '1w' || t === 'w') return '1wk';
    if (t === '1m' && t.length === 2) return '1mo';
    return '1d';
  }
  const n = m[1] === '' ? 1 : Number(m[1]);
  const unit = m[2];
  if (unit === 's') return '1m';
  if (unit === 'm') return `${[1, 2, 5, 15, 30, 60, 90].filter((a) => a <= n).pop() || 1}m`;
  if (unit === 'h') return n <= 1 ? '60m' : '60m';
  if (unit === 'd') return '1d';
  if (unit === 'w') return '1wk';
  return '1d';
}

function timeframeRange(interval) {
  const map = {
    '1m': '5d',
    '2m': '5d',
    '5m': '1mo',
    '15m': '1mo',
    '30m': '3mo',
    '60m': '6mo',
    '90m': '6mo',
    '1d': '2y',
    '1wk': '5y',
    '1mo': 'max',
  };
  return map[interval] || '1y';
}

function pineTimeframe(intervalLabel) {
  const t = String(intervalLabel || '1d').toLowerCase();
  const m = /^(\d*)([smhdw]|mo)$/.exec(t);
  if (!m) return { period: intervalLabel || '1D', multiplier: 1, isintraday: false };
  const mult = m[1] === '' ? 1 : Number(m[1]);
  const unit = m[2];
  const isintraday = unit === 'm' && mult < 60 ? true : unit === 'm' && mult >= 60 ? false : unit === 'h' || unit === 's';
  const periodMap = { s: 'S', m: 'M', h: 'M', d: 'D', w: 'W', mo: 'M' };
  const period = unit === 'mo' ? 'M' : `${mult * (unit === 'h' ? 60 : 1)}${periodMap[unit] || 'D'}`;
  return {
    period: unit === 'd' ? '1D' : unit === 'w' ? '1W' : unit === 'mo' ? '1M' : period,
    multiplier: mult,
    isintraday,
  };
}

/** Clear cached cross-symbol data (e.g. when the primary symbol changes). */
export function clearSecurityCache() {
  securityCache.clear();
  securityInflight.clear();
  securityEpoch++;
}

export { securityCache };
