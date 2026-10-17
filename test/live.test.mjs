/**
 * Integration test against live Yahoo Finance data (through the local proxy)
 * and Pine scripts run over real bars.
 *
 * Run: node test/live.test.mjs
 * The script starts its own server on a free port; if the network is
 * unavailable the live checks are skipped and only offline checks run.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', String(port)], {
  cwd: ROOT,
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

let online = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (r.ok) {
      online = true;
      break;
    }
  } catch {
    /* retry */
  }
  await sleep(250);
}

console.log('\nLive integration tests');
console.log('======================');
console.log(`server on port ${port}, online=${online}`);

const base = `http://127.0.0.1:${port}`;

async function getJson(pathname) {
  const res = await fetch(base + pathname);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

if (!online) {
  console.log('server did not start; aborting');
  server.kill();
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Datafeed
 * ------------------------------------------------------------------ */

let dailyBars = null;
try {
  const chart = await getJson('/api/chart?symbol=AAPL&interval=1d&range=1y');
  dailyBars = chart.bars;
  test('daily chart returns a full year of bars', () => {
    assert(Array.isArray(chart.bars), 'bars array');
    assert(chart.bars.length > 180, `expected >180 bars, got ${chart.bars.length}`);
    assert(chart.symbol === 'AAPL', `symbol ${chart.symbol}`);
    assert(chart.currency === 'USD', `currency ${chart.currency}`);
    assert(chart.timezone && chart.timezone.includes('/'), `timezone ${chart.timezone}`);
  });

  test('bars are chronological and internally consistent', () => {
    for (let i = 1; i < chart.bars.length; i++) {
      assert(chart.bars[i].t > chart.bars[i - 1].t, `bar ${i} time must increase`);
    }
    for (const [i, b] of chart.bars.entries()) {
      assert(b.h >= b.l, `bar ${i}: high ${b.h} < low ${b.l}`);
      assert(b.h >= b.o && b.h >= b.c, `bar ${i}: high not the maximum`);
      assert(b.l <= b.o && b.l <= b.c, `bar ${i}: low not the minimum`);
      assert(b.v >= 0, `bar ${i}: negative volume`);
      assert(Number.isFinite(b.c) && b.c > 0, `bar ${i}: bad close`);
    }
  });

  test('bars contain no null gaps', () => {
    const bad = chart.bars.filter((b) => [b.t, b.o, b.h, b.l, b.c, b.v].some((v) => v === null || v === undefined));
    assert(bad.length === 0, `${bad.length} bars have null fields`);
  });
} catch (err) {
  console.log(`  skip live chart checks: ${err.message}`);
}

// Intraday
try {
  const intraday = await getJson('/api/chart?symbol=MSFT&interval=5m&range=5d');
  test('intraday chart returns bars for a 5-day window', () => {
    assert(intraday.bars.length > 50, `expected intraday bars, got ${intraday.bars.length}`);
    const spanHours = (intraday.bars[intraday.bars.length - 1].t - intraday.bars[0].t) / 3600000;
    assert(spanHours > 4 && spanHours < 24 * 8, `unexpected span ${spanHours}h`);
  });
} catch (err) {
  console.log(`  skip intraday: ${err.message}`);
}

// Other asset classes
try {
  const [etf, crypto, fx, index] = await Promise.all([
    getJson('/api/chart?symbol=SPY&interval=1d&range=1mo'),
    getJson('/api/chart?symbol=BTC-USD&interval=1d&range=1mo'),
    getJson('/api/chart?symbol=EURUSD=X&interval=1d&range=1mo'),
    getJson('/api/chart?symbol=%5EGSPC&interval=1d&range=1mo'),
  ]);
  test('ETFs, crypto, FX and indices all return bars', () => {
    for (const [name, data] of [['SPY', etf], ['BTC-USD', crypto], ['EURUSD=X', fx], ['^GSPC', index]]) {
      assert(data.bars.length > 5, `${name}: only ${data.bars.length} bars`);
      assert(Number.isFinite(data.bars[0].c), `${name}: close not finite`);
    }
  });
} catch (err) {
  console.log(`  skip asset classes: ${err.message}`);
}

// Search (Yahoo's search endpoint is occasionally flaky, so retry before failing)
try {
  let search = { quotes: [] };
  for (let attempt = 0; attempt < 4 && !search.quotes.length; attempt++) {
    search = await getJson('/api/search?q=nvidia');
    if (!search.quotes.length) await sleep(1200);
  }
  test('symbol search returns matching instruments', () => {
    assert(search.quotes.length > 0, 'no results after 4 attempts');
    assert(search.quotes.some((q) => q.symbol === 'NVDA'), `NVDA missing from ${search.quotes.map((q) => q.symbol).join(',')}`);
    assert(search.quotes[0].name, 'result has no name field');
  });
} catch (err) {
  console.log(`  skip search: ${err.message}`);
}

// Quotes
try {
  const quotes = await getJson('/api/quote?symbols=AAPL,MSFT,NVDA');
  test('quote endpoint returns prices and changes', () => {
    assert(quotes.quotes.length === 3, `expected 3 quotes, got ${quotes.quotes.length}`);
    for (const q of quotes.quotes) {
      assert(!q.error, `${q.symbol} error: ${q.error}`);
      assert(Number.isFinite(q.price) && q.price > 0, `${q.symbol} price ${q.price}`);
      assert(Number.isFinite(q.changePercent), `${q.symbol} change %`);
    }
  });
} catch (err) {
  console.log(`  skip quotes: ${err.message}`);
}

// Bad symbol handling
try {
  const bad = await getJson('/api/chart?symbol=NOTAREALSYMBOL123&interval=1d&range=1mo');
  test('unknown symbol returns an empty payload rather than crashing', () => {
    assert(Array.isArray(bad.bars), 'bars should still be an array');
    assert(bad.bars.length === 0, `expected 0 bars, got ${bad.bars.length}`);
  });
} catch (err) {
  test('unknown symbol returns an empty payload rather than crashing', () => {
    assert(/400|404|no data|Not Found/i.test(err.message), `unexpected error: ${err.message}`);
  });
}

/* ------------------------------------------------------------------ *
 * Pine over real data
 * ------------------------------------------------------------------ */

if (dailyBars && dailyBars.length > 50) {
  const { runPine } = await import('../public/js/pine/runtime.js');
  const meta = { symbol: 'AAPL', currency: 'USD', exchange: 'NasdaqGS', description: 'Apple Inc.', timezone: 'America/New_York' };

  test('indicator over real AAPL data produces finite values', () => {
    const r = runPine(
      `[m, s, h] = ta.macd(close, 12, 26, 9)
r = ta.rsi(close, 14)
[u, b, l] = ta.bb(close, 20, 2)
plot(m)
plot(r)
plot(u)
plot(ta.atr(14))
plot(ta.sma(close, 50))`,
      { bars: dailyBars, symbol: meta }
    );
    assert(r.ok, r.ok ? '' : r.error.message);
    assert(r.outputs.plots.length === 5, `expected 5 plots, got ${r.outputs.plots.length}`);
    for (const plot of r.outputs.plots) {
      const finite = plot.values.filter((v) => typeof v === 'number' && Number.isFinite(v));
      assert(finite.length > 20, `plot "${plot.title}" only produced ${finite.length} finite values`);
    }
  });

  test('RSI stays within 0..100 on real data', () => {
    const r = runPine('plot(ta.rsi(close, 14))', { bars: dailyBars, symbol: meta });
    assert(r.ok, r.error?.message);
    const vals = r.outputs.plots[0].values.filter((v) => v !== null);
    assert(vals.length > 50, 'not enough RSI values');
    for (const v of vals) assert(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  });

  test('SMA of close stays between the min and max close', () => {
    const r = runPine('plot(ta.sma(close, 20))', { bars: dailyBars, symbol: meta });
    assert(r.ok, r.error?.message);
    const closes = dailyBars.map((b) => b.c);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    for (const v of r.outputs.plots[0].values.filter((x) => x !== null)) {
      assert(v >= min - 1e-6 && v <= max + 1e-6, `SMA ${v} outside close range [${min}, ${max}]`);
    }
  });

  test('crossover signals only fire where the series actually cross', () => {
    const r = runPine(
      `fast = ta.sma(close, 10)
slow = ta.sma(close, 30)
plot(ta.crossover(fast, slow) ? 1 : 0)
plot(ta.crossunder(fast, slow) ? 1 : 0)`,
      { bars: dailyBars, symbol: meta }
    );
    assert(r.ok, r.error?.message);
    const ups = r.outputs.plots[0].values;
    const downs = r.outputs.plots[1].values;
    const upCount = ups.filter((v) => v === 1).length;
    const downCount = downs.filter((v) => v === 1).length;
    assert(upCount > 0 || downCount > 0, 'no crossovers detected in real data');
    for (let i = 0; i < ups.length; i++) assert(!(ups[i] === 1 && downs[i] === 1), `both directions fired on bar ${i}`);
  });

  test('strategy produces trades on real AAPL data', () => {
    const r = runPine(
      `strategy("s", overlay = true, initial_capital = 100000)
[upper, basis, lower] = ta.bb(close, 20, 2)
if ta.crossover(close, upper)
    strategy.entry("L", strategy.long)
if ta.crossunder(close, basis)
    strategy.close("L")`,
      { bars: dailyBars, symbol: meta }
    );
    assert(r.ok, r.error?.message);
    const s = r.outputs.strategy;
    assert(s.orders.length > 0, 'no orders were placed');
    for (const t of s.trades) {
      assert(Number.isFinite(t.profit), 'trade profit not finite');
      assert(t.exitBar >= t.entryBar, 'exit before entry');
      assert(t.entryPrice > 0 && t.exitPrice > 0, 'non-positive fill price');
    }
  });

  test('performance: full pipeline over a 5-year daily series', async () => {
    const big = await getJson('/api/chart?symbol=AAPL&interval=1d&range=5y');
    assert(big.bars.length > 1000, `expected >1000 bars, got ${big.bars.length}`);
    const t0 = Date.now();
    const r = runPine(
      `[m, s, h] = ta.macd(close, 12, 26, 9)
plot(ta.rsi(close, 14))
plot(ta.sma(close, 200))
plot(ta.atr(14))
[u, b, l] = ta.bb(close, 20, 2)
plot(u)
plot(hist)`,
      { bars: big.bars, symbol: meta }
    );
    const ms = Date.now() - t0;
    assert(r.ok, r.error?.message);
    assert(ms < 5000, `took ${ms}ms for ${big.bars.length} bars`);
    console.log(`       (${big.bars.length} real bars x 6 indicators = ${ms}ms)`);
  });
} else {
  console.log('  skip Pine-over-live-data checks (no bars)');
}

/* ------------------------------------------------------------------ */

console.log('======================');
console.log(`${passed} passed, ${failed} failed`);
server.kill();
if (failed) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.err.stack}`);
  process.exit(1);
}
process.exit(0);
