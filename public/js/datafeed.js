/**
 * Datafeed: talks to the local /api proxy, which in turn reads Yahoo Finance.
 * Adds caching, in-flight de-duplication and client-side bar aggregation.
 */

const API = '';

/** Interval metadata used by the toolbar and for aggregation. */
export const INTERVALS = [
  { id: '1m', label: '1m', seconds: 60, intraday: true },
  { id: '2m', label: '2m', seconds: 120, intraday: true },
  { id: '5m', label: '5m', seconds: 300, intraday: true },
  { id: '15m', label: '15m', seconds: 900, intraday: true },
  { id: '30m', label: '30m', seconds: 1800, intraday: true },
  { id: '60m', label: '1H', seconds: 3600, intraday: true },
  { id: '90m', label: '90m', seconds: 5400, intraday: true },
  { id: '1d', label: '1D', seconds: 86400, intraday: false },
  { id: '5d', label: '5D', seconds: 432000, intraday: false },
  { id: '1wk', label: '1W', seconds: 604800, intraday: false },
  { id: '1mo', label: '1M', seconds: 2592000, intraday: false },
];

export const RANGES = [
  { id: '1d', label: '1D' },
  { id: '5d', label: '5D' },
  { id: '1mo', label: '1M' },
  { id: '3mo', label: '3M' },
  { id: '6mo', label: '6M' },
  { id: '1y', label: '1Y' },
  { id: '2y', label: '2Y' },
  { id: '5y', label: '5Y' },
  { id: '10y', label: '10Y' },
  { id: 'max', label: 'MAX' },
];

const intervalById = new Map(INTERVALS.map((i) => [i.id, i]));

export function intervalInfo(id) {
  return intervalById.get(id) || intervalById.get('1d');
}

/** Range that comfortably covers `bars` bars of `interval`. */
export function rangeForBars(interval, bars = 500) {
  const secs = intervalInfo(interval).seconds * bars;
  const options = [
    ['1d', 86400],
    ['5d', 432000],
    ['1mo', 2592000],
    ['3mo', 7776000],
    ['6mo', 15552000],
    ['1y', 31536000],
    ['2y', 63072000],
    ['5y', 157680000],
    ['10y', 315360000],
    ['max', 1261440000],
  ];
  for (const [id, s] of options) if (s >= secs) return id;
  return 'max';
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.set(k, String(v));
  return u.toString();
}

class Datafeed {
  constructor() {
    this.barCache = new Map(); // key -> { bars, meta, ts }
    this.inflight = new Map();
    this.searchCache = new Map();
    this.quoteSubscribers = new Set();
    this.quoteCache = new Map();
    this.pollTimer = null;
    this.pollIntervalMs = 20000;
    this.online = true;
  }

  /* ---------------- bars ---------------- */

  cacheKey(symbol, interval, range, prepost) {
    return `${symbol}|${interval}|${range}|${prepost ? 1 : 0}`;
  }

  /**
   * @returns {Promise<{bars:Array,meta:Object}>}
   */
  async getBars(symbol, interval, range, { prepost = false, force = false } = {}) {
    const key = this.cacheKey(symbol, interval, range, prepost);
    const hit = this.barCache.get(key);
    const ttl = intervalInfo(interval).intraday ? 20000 : 60000;
    if (!force && hit && Date.now() - hit.ts < ttl) return hit;

    if (!force && this.inflight.has(key)) return this.inflight.get(key);

    const promise = (async () => {
      const url = `${API}/api/chart?${qs({ symbol, interval, range, prepost: prepost ? 1 : 0 })}`;
      let json;
      try {
        const res = await fetch(url);
        json = await res.json();
        if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
        this.setOnline(true);
      } catch (err) {
        this.setOnline(false);
        throw err;
      }
      const bars = (json.bars || []).map(normaliseBar);
      const payload = { bars, meta: json, ts: Date.now() };
      this.barCache.set(key, payload);
      if (this.barCache.size > 120) {
        const oldest = [...this.barCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) this.barCache.delete(oldest[0]);
      }
      return payload;
    })();

    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Fetch bars for an arbitrary symbol/timeframe (used by request.security). */
  async getBarsForTimeframe(symbol, timeframe, mainInterval) {
    const tf = String(timeframe || '').toLowerCase();
    const mapped = mapPineTimeframe(tf, mainInterval);
    return this.getBars(symbol, mapped, rangeForBars(mapped, 500));
  }

  /* ---------------- search & quotes ---------------- */

  async search(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const key = q.toLowerCase();
    const hit = this.searchCache.get(key);
    if (hit && Date.now() - hit.ts < 300000) return hit.quotes;
    try {
      const res = await fetch(`${API}/api/search?${qs({ q })}`);
      const json = await res.json();
      const quotes = json.quotes || [];
      this.searchCache.set(key, { quotes, ts: Date.now() });
      this.setOnline(true);
      return quotes;
    } catch {
      this.setOnline(false);
      return [];
    }
  }

  async getQuotes(symbols) {
    const list = [...new Set(symbols.filter(Boolean))];
    if (!list.length) return [];
    try {
      const res = await fetch(`${API}/api/quote?${qs({ symbols: list.join(',') })}`);
      const json = await res.json();
      const quotes = json.quotes || [];
      this.setOnline(true);
      for (const q of quotes) if (!q.error) this.quoteCache.set(q.symbol, q);
      return quotes;
    } catch {
      this.setOnline(false);
      return list.map((symbol) => ({ symbol, error: 'offline' }));
    }
  }

  async getSpark(symbol, range = '1d') {
    try {
      const res = await fetch(`${API}/api/spark?${qs({ symbol, range })}`);
      return await res.json();
    } catch {
      return { symbol, closes: [] };
    }
  }

  async getNews(symbol) {
    try {
      const res = await fetch(`${API}/api/news?${qs({ symbol })}`);
      return (await res.json()).news || [];
    } catch {
      return [];
    }
  }

  /* ---------------- polling ---------------- */

  subscribeQuotes(fn) {
    this.quoteSubscribers.add(fn);
    this.ensurePolling();
    return () => this.quoteSubscribers.delete(fn);
  }

  ensurePolling() {
    if (this.pollTimer || !this.quoteSubscribers.size) return;
    this.pollTimer = setInterval(async () => {
      if (!this.quoteSubscribers.size) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
        return;
      }
      if (document.hidden) return;
      const symbols = new Set();
      for (const sub of this.quoteSubscribers) for (const s of sub.symbols || []) symbols.add(s);
      if (!symbols.size) return;
      const quotes = await this.getQuotes([...symbols]);
      for (const sub of this.quoteSubscribers) {
        const relevant = quotes.filter((q) => sub.symbols?.includes(q.symbol));
        if (relevant.length) sub.fn(relevant);
      }
    }, this.pollIntervalMs);
  }

  setOnline(ok) {
    if (this.online !== ok) {
      this.online = ok;
      window.dispatchEvent(new CustomEvent('feed:status', { detail: { online: ok } }));
    }
  }

  clearCache() {
    this.barCache.clear();
    this.searchCache.clear();
    this.quoteCache.clear();
  }
}

function normaliseBar(b) {
  return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 };
}

/** Map a Pine timeframe string onto a Yahoo interval id. */
function mapPineTimeframe(tf, mainInterval) {
  const t = tf.replace(/\s/g, '');
  if (!t) return mainInterval;
  const m = /^(\d*)([smhdwM])$/.exec(t);
  if (!m) return mainInterval;
  const n = m[1] === '' ? 1 : Number(m[1]);
  const unit = m[2];
  if (unit === 's') return n <= 59 ? '1m' : '1m';
  if (unit === 'm') {
    const allowed = [1, 2, 5, 15, 30, 60, 90];
    const pick = allowed.filter((a) => a <= n).pop() || 1;
    return `${pick}m`;
  }
  if (unit === 'h') return n <= 1 ? '60m' : '60m';
  if (unit === 'd') return '1d';
  if (unit === 'w') return '1wk';
  if (unit === 'M') return '1mo';
  return mainInterval;
}

export const feed = new Datafeed();

/* ------------------------------------------------------------------ *
 * Time helpers (chart axis + session handling)
 * ------------------------------------------------------------------ */

const tzFormatterCache = new Map();

export function tzParts(ms, timeZone) {
  let fmt = tzFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    tzFormatterCache.set(timeZone, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    hour: +out.hour % 24,
    minute: +out.minute,
    second: +out.second,
    weekday: out.weekday,
  };
}

export function formatPrice(value, { decimals, currency = 'USD' } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const d = decimals ?? autoDecimals(value);
  return value.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function autoDecimals(value) {
  const a = Math.abs(value);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return 2;
  if (a >= 0.1) return 3;
  if (a >= 0.01) return 4;
  if (a >= 0.001) return 5;
  return 8;
}

export function decimalsForBars(bars) {
  let max = 0;
  for (let i = Math.max(0, bars.length - 200); i < bars.length; i++) {
    const b = bars[i];
    if (!b) continue;
    max = Math.max(max, autoDecimals(b.c));
  }
  return max || 2;
}

export function formatCompact(value) {
  const a = Math.abs(value);
  if (!Number.isFinite(a)) return '—';
  const sign = value < 0 ? '-' : '';
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(2)}K`;
  return `${sign}${a.toFixed(2)}`;
}

export function formatTime(ms, timeZone, { withDate = false, withSeconds = false } = {}) {
  const p = tzParts(ms, timeZone || 'UTC');
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  const ss = String(p.second).padStart(2, '0');
  const time = withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
  if (!withDate) return time;
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${time}`;
}

export function formatDateShort(ms, timeZone) {
  const p = tzParts(ms, timeZone || 'UTC');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.day} ${months[p.month - 1]}`;
}

export function formatDateMedium(ms, timeZone) {
  const p = tzParts(ms, timeZone || 'UTC');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.day} ${months[p.month - 1]} ${p.year}`;
}

/**
 * Aggregate bars into a coarser timeframe.
 * Yahoo only serves a fixed set of intervals, so anything else is built locally.
 */
export function aggregateBars(bars, targetSeconds, sourceSeconds) {
  if (!bars.length || targetSeconds <= sourceSeconds) return bars;
  const factor = Math.max(1, Math.round(targetSeconds / sourceSeconds));
  const out = [];
  let bucket = null;
  for (const b of bars) {
    const slot = Math.floor(b.t / (targetSeconds * 1000));
    if (!bucket || bucket.slot !== slot) {
      if (bucket) out.push(bucket.bar);
      bucket = { slot, bar: { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v } };
    } else {
      bucket.bar.h = Math.max(bucket.bar.h, b.h);
      bucket.bar.l = Math.min(bucket.bar.l, b.l);
      bucket.bar.c = b.c;
      bucket.bar.v += b.v;
    }
  }
  if (bucket) out.push(bucket.bar);
  void factor;
  return out;
}
