/**
 * tvclone server
 * --------------
 * Zero-dependency Node HTTP server that:
 *   1. Proxies Yahoo Finance's public chart/search/quote endpoints (browser CORS blocks them directly).
 *   2. Serves the static application from ./public
 *
 * Usage: node server.mjs [--port 8787] [--host 127.0.0.1]
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(argOf('--port', process.env.PORT || 8787));
const HOST = argOf('--host', '127.0.0.1');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ------------------------------------------------------------------ *
 * Upstream fetch helpers
 * ------------------------------------------------------------------ */

const YF_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function yahooJson(pathAndQuery, { timeoutMs = 15000 } = {}) {
  let lastErr;
  for (const host of YF_HOSTS) {
    const url = `https://${host}${pathAndQuery}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://finance.yahoo.com/',
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new HttpError(res.status, `Yahoo responded ${res.status}`, text.slice(0, 500));
        continue;
      }
      const json = await res.json();
      return json;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof HttpError
    ? lastErr
    : new HttpError(502, `Upstream fetch failed: ${lastErr?.message || 'unknown'}`);
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const cache = new Map(); // key -> { expires, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { expires: Date.now() + ttlMs, value });
  if (cache.size > 800) {
    // drop oldest entries
    const keys = [...cache.keys()].slice(0, 200);
    for (const k of keys) cache.delete(k);
  }
}

/* ------------------------------------------------------------------ *
 * Yahoo Finance data mapping
 * ------------------------------------------------------------------ */

const INTERVAL_SECONDS = {
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '60m': 3600,
  '90m': 5400,
  '1h': 3600,
  '1d': 86400,
  '5d': 432000,
  '1wk': 604800,
  '1mo': 2592000,
  '3mo': 7776000,
};

const RANGE_SECONDS = {
  '1d': 86400,
  '5d': 432000,
  '1mo': 2592000,
  '3mo': 7776000,
  '6mo': 15552000,
  '1y': 31536000,
  '2y': 63072000,
  '5y': 157680000,
  '10y': 315360000,
  'max': 630720000,
};

/** Yahoo caps intraday history; degrade range when needed. */
function normaliseRange(range, interval) {
  const intraday = /m$|h$/.test(interval);
  if (!intraday) return range;
  const maxFor1m = 7 * 86400; // 1m data only ~7 days back
  const cap = interval === '1m' ? maxFor1m : 60 * 86400;
  const want = RANGE_SECONDS[range] ?? maxFor1m;
  if (want <= cap) return range;
  // pick the largest allowed range
  let best = '1d';
  for (const [name, secs] of Object.entries(RANGE_SECONDS)) {
    if (secs <= cap && secs <= want) best = name;
  }
  return best;
}

function mapChart(json) {
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const ts = result.timestamp || [];

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({
      t: ts[i] * 1000,
      o,
      h,
      l,
      c,
      v: q.volume?.[i] ?? 0,
      ac: adj?.[i] ?? c,
    });
  }
  bars.sort((a, b) => a.t - b.t);

  return {
    symbol: meta.symbol,
    currency: meta.currency || 'USD',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    instrumentType: meta.instrumentType || 'EQUITY',
    timezone: meta.exchangeTimezoneName || 'America/New_York',
    gmtoffset: meta.gmtoffset ?? 0,
    description: meta.longName || meta.shortName || meta.symbol,
    regularMarketPrice: meta.regularMarketPrice ?? (bars.length ? bars[bars.length - 1].c : null),
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    marketState: meta.marketState || '',
    hasPrePost: !!meta.hasPrePostMarketData,
    bars,
    // __dividends_extracted__ extract dividend events for Pine request.dividends
    dividends: (() => {
      const ev = result.events?.dividends;
      if (!ev) return [];
      const out = [];
      for (const [tsStr, e] of Object.entries(ev)) {
        const t = Number(tsStr) * 1000;
        const amount = Number(e.amount);
        if (Number.isFinite(t) && Number.isFinite(amount)) out.push({ t, amount });
      }
      out.sort((a, b) => a.t - b.t);
      return out;
    })(),
    // __splits_extracted__ extract split events for Pine request.splits
    splits: (() => {
      const ev = result.events?.splits;
      if (!ev) return [];
      const out = [];
      for (const [tsStr, e] of Object.entries(ev)) {
        const t = Number(tsStr) * 1000;
        const numerator = Number(e.numerator);
        const denominator = Number(e.denominator);
        if (Number.isFinite(t) && Number.isFinite(numerator) && Number.isFinite(denominator)) {
          out.push({ t, numerator, denominator });
        }
      }
      out.sort((a, b) => a.t - b.t);
      return out;
    })(),
  };
}

/* ------------------------------------------------------------------ *
 * Route handlers
 * ------------------------------------------------------------------ */

async function handleChart(url) {
  const symbol = (url.searchParams.get('symbol') || 'AAPL').trim();
  const interval = (url.searchParams.get('interval') || '1d').trim();
  let range = (url.searchParams.get('range') || '1y').trim();
  const prepost = url.searchParams.get('prepost') === '1';
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds) throw new HttpError(400, `Unsupported interval: ${interval}`);

  const key = `chart:${symbol}:${interval}:${range}:${prepost}:${from}:${to}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    interval,
    includePrePost: prepost ? 'true' : 'false',
    events: 'div,splits,capitalGains',
  });
  if (from && to) {
    params.set('period1', String(Math.floor(Number(from) / 1000)));
    params.set('period2', String(Math.floor(Number(to) / 1000)));
  } else {
    range = normaliseRange(range, interval);
    params.set('range', range);
  }

  const json = await yahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`
  );
  const mapped = mapChart(json);
  if (!mapped || mapped.bars.length === 0) {
    // Return an empty-but-valid payload so the UI can show "no data" instead of erroring.
    const empty = mapped || { symbol, currency: 'USD', bars: [] };
    cacheSet(key, empty, 30000);
    return empty;
  }
  cacheSet(key, mapped, seconds >= 86400 ? 60000 : 20000);
  return mapped;
}

async function handleSearch(url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return { quotes: [] };
  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Yahoo's search endpoint is occasionally flaky (empty body / 5xx). Try a
  // couple of shapes before giving up, and never cache a failure for long.
  const attempts = [
    { quotesCount: '12', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' },
    { quotesCount: '12', newsCount: '0' },
    { q, quotesCount: '10' },
  ];

  let quotes = [];
  for (const extra of attempts) {
    const params = new URLSearchParams(extra);
    try {
      const json = await yahooJson(`/v1/finance/search?${params.toString()}`, { timeoutMs: 8000 });
      const mapped = (json.quotes || [])
        .filter((r) => r.symbol)
        .map((r) => ({
          symbol: r.symbol,
          name: r.longname || r.shortname || r.symbol,
          exchange: r.exchDisp || r.exchange || '',
          type: r.quoteType || r.typeDisp || '',
          score: r.score ?? 0,
        }));
      if (mapped.length) {
        quotes = mapped;
        break;
      }
    } catch {
      /* try the next shape */
    }
  }

  // Last resort: treat the query as a bare ticker and validate it against the
  // chart endpoint so the UI still resolves exact symbols during an outage.
  if (!quotes.length && /^[A-Za-z0-9.^=-]{1,12}$/.test(q)) {
    try {
      const probe = mapChart(
        await yahooJson(`/v8/finance/chart/${encodeURIComponent(q.toUpperCase())}?range=5d&interval=1d`, { timeoutMs: 8000 })
      );
      if (probe && probe.bars.length) {
        quotes = [
          {
            symbol: probe.symbol,
            name: probe.description || probe.symbol,
            exchange: probe.exchange || '',
            type: probe.instrumentType || 'EQUITY',
            score: 1,
          },
        ];
      }
    } catch {
      /* give up */
    }
  }

  const out = { quotes };
  // Successful lookups cache for 5 minutes; empty ones only briefly so a
  // transient upstream failure recovers quickly.
  cacheSet(key, out, quotes.length ? 300000 : 5000);
  return out;
}

async function handleQuote(url) {
  const symbols = (url.searchParams.get('symbols') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 60);
  if (!symbols.length) return { quotes: [] };
  const key = `quote:${symbols.join(',')}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  // Use the chart endpoint per-symbol: it is far more reliable than /v7/quote (which now needs a crumb).
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const json = await yahooJson(
          `/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
          { timeoutMs: 9000 }
        );
        const m = mapChart(json);
        if (!m) return { symbol, error: 'no data' };
        const bars = m.bars;
        const last = bars[bars.length - 1];
        const prev = bars.length > 1 ? bars[bars.length - 2] : null;
        const change = last && prev ? last.c - prev.c : 0;
        return {
          symbol: m.symbol,
          name: m.description,
          exchange: m.exchange,
          currency: m.currency,
          price: m.regularMarketPrice ?? last?.c ?? null,
          previousClose: prev?.c ?? m.previousClose ?? null,
          change,
          changePercent: prev?.c ? (change / prev.c) * 100 : 0,
          volume: last?.v ?? 0,
          marketState: m.marketState,
        };
      } catch (err) {
        return { symbol, error: err.message };
      }
    })
  );
  const out = { quotes: results };
  cacheSet(key, out, 15000);
  return out;
}

/* Intraday "sparkline" data for the watchlist */
async function handleSpark(url) {
  const symbol = (url.searchParams.get('symbol') || '').trim();
  const range = (url.searchParams.get('range') || '1d').trim();
  if (!symbol) throw new HttpError(400, 'symbol required');
  const interval = RANGE_SECONDS[range] > 86400 * 10 ? '1d' : '5m';
  const key = `spark:${symbol}:${range}:${interval}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const json = await yahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`
  );
  const m = mapChart(json);
  const out = {
    symbol,
    closes: (m?.bars || []).map((b) => Number(b.c.toFixed(4))),
    previousClose: m?.previousClose ?? null,
  };
  cacheSet(key, out, 60000);
  return out;
}

async function handleNews(url) {
  const symbol = (url.searchParams.get('symbol') || '').trim();
  const key = `news:${symbol}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const params = new URLSearchParams({ q: symbol || 'stock market', quotesCount: '0', newsCount: '12' });
  let json;
  try {
    json = await yahooJson(`/v1/finance/search?${params.toString()}`, { timeoutMs: 8000 });
  } catch {
    json = {};
  }
  const out = {
    news: (json.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      providerPublishTime: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    })),
  };
  cacheSet(key, out, 300000);
  return out;
}

/* ------------------------------------------------------------------ *
 * Static file serving
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path
    .normalize(rel)
    .replace(/^([/\\])+/, '')
    .replace(/^(\.\.([/\\]|$))+/, '');
  const full = path.join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) return serveStatic(req, res, path.posix.join(urlPath, 'index.html'));
    const ext = path.extname(full).toLowerCase();
    // Use no-store for JS/CSS so the browser NEVER caches them — it always
    // fetches the latest version from the server. This prevents stale
    // module imports from breaking the app after updates.
    const noStore = ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store, no-cache, must-revalidate' : 'no-cache',
      'Pragma': noStore ? 'no-cache' : undefined,
      'Expires': noStore ? '0' : undefined,
      'Content-Length': stat.size,
    });
    fs.createReadStream(full).pipe(res);
  } catch {
    // SPA-ish fallback: unknown non-asset paths get index.html
    if (!path.extname(safe)) {
      const index = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        fs.createReadStream(index).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  try {
    if (p === '/api/chart') return json(res, 200, await handleChart(url));
    if (p === '/api/search') return json(res, 200, await handleSearch(url));
    if (p === '/api/quote') return json(res, 200, await handleQuote(url));
    if (p === '/api/spark') return json(res, 200, await handleSpark(url));
    if (p === '/api/news') return json(res, 200, await handleNews(url));
    if (p === '/api/health') return json(res, 200, { ok: true, ts: Date.now() });
    if (p.startsWith('/api/')) return json(res, 404, { error: `Unknown endpoint ${p}` });
    return serveStatic(req, res, p);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[500] ${p} ->`, err.message);
    return json(res, status, { error: err.message, detail: err.body });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`tvclone running at http://${HOST}:${PORT}`);
  console.log(`  static root: ${PUBLIC_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
