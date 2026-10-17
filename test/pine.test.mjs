/**
 * Pine engine test suite.
 * Run: node test/pine.test.mjs
 */
import { runPine } from '../public/js/pine/runtime.js';

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

function assertClose(a, b, tol, msg) {
  const d = Math.abs(a - b);
  if (!(d <= tol)) throw new Error(`${msg || 'values differ'}: got ${a}, want ${b} (delta ${d})`);
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'values differ'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/** Deterministic pseudo-data so tests are reproducible. */
function makeBars(n, seed = 42) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const bars = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.48) * 3;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rnd() * 1.5;
    const low = Math.min(open, close) - rnd() * 1.5;
    bars.push({
      t: Date.UTC(2024, 0, 1) + i * 86400000,
      o: round(open),
      h: round(high),
      l: round(low),
      c: round(close),
      v: Math.floor(1000 + rnd() * 9000),
    });
    price = close;
  }
  return bars;
}
const round = (v) => Math.round(v * 100) / 100;

const BARS = makeBars(300);

function run(src, opts = {}) {
  const res = runPine(src, {
    bars: opts.bars || BARS,
    symbol: { symbol: 'TEST', currency: 'USD', exchange: 'TEST', description: 'Test Instrument', mintick: 0.01 },
    timeframe: opts.timeframe || { period: '1D', multiplier: 1, isintraday: false },
    inputs: opts.inputs || {},
    host: opts.host || {},
  });
  if (!res.ok) {
    throw new Error(`Pine error: ${res.error.message}${res.error.line ? ` (line ${res.error.line})` : ''}`);
  }
  return res;
}

/* ------------------------------------------------------------------ */
console.log('\nPine Script engine tests');
console.log('========================');

test('parses and plots a constant', () => {
  const r = run('//@version=5\nindicator("c")\nplot(42)');
  assertEqual(r.outputs.plots.length, 1, 'plot count');
  assertEqual(r.outputs.plots[0].values[0], 42, 'value');
  assertEqual(r.outputs.plots[0].values[299], 42, 'last value');
});

test('ta.sma matches a reference implementation', () => {
  const r = run('plot(ta.sma(close, 10))');
  const got = r.outputs.plots[0].values;
  for (let i = 0; i < BARS.length; i++) {
    if (i < 9) {
      assertEqual(got[i], null, `bar ${i} should be na`);
    } else {
      const sum = BARS.slice(i - 9, i + 1).reduce((a, b) => a + b.c, 0);
      assertClose(got[i], sum / 10, 1e-9, `bar ${i}`);
    }
  }
});

test('ta.ema matches a reference implementation', () => {
  const r = run('plot(ta.ema(close, 12))');
  const got = r.outputs.plots[0].values;
  const alpha = 2 / 13;
  for (let i = 0; i < 11; i++) assertEqual(got[i], null, `bar ${i} should be na`);
  let prev = BARS.slice(0, 12).reduce((a, b) => a + b.c, 0) / 12;
  assertClose(got[11], prev, 1e-9, 'seed');
  for (let i = 12; i < BARS.length; i++) {
    prev = alpha * BARS[i].c + (1 - alpha) * prev;
    assertClose(got[i], prev, 1e-9, `bar ${i}`);
  }
});

test('ta.rsi (Wilder) matches a reference implementation', () => {
  const r = run('plot(ta.rsi(close, 14))');
  const got = r.outputs.plots[0].values;
  const n = 14;
  let prevClose = BARS[0].c;
  const ups = [];
  const downs = [];
  for (let i = 1; i < BARS.length; i++) {
    const diff = BARS[i].c - prevClose;
    prevClose = BARS[i].c;
    ups.push(Math.max(diff, 0));
    downs.push(Math.max(-diff, 0));
  }
  let upAvg = null;
  let downAvg = null;
  assertEqual(got[0], null, 'bar 0 must be na');
  for (let i = 0; i < ups.length; i++) {
    if (i < n) {
      if (i === n - 1) {
        upAvg = ups.slice(0, n).reduce((a, b) => a + b, 0) / n;
        downAvg = downs.slice(0, n).reduce((a, b) => a + b, 0) / n;
      }
    } else {
      upAvg = (upAvg * (n - 1) + ups[i]) / n;
      downAvg = (downAvg * (n - 1) + downs[i]) / n;
    }
    if (upAvg === null) {
      assertEqual(got[i + 1], null, `bar ${i + 1} should be na`);
      continue;
    }
    const want = downAvg === 0 ? 100 : 100 - 100 / (1 + upAvg / downAvg);
    assertClose(got[i + 1], want, 1e-7, `bar ${i + 1}`);
  }
});
test('history operator works on user variables', () => {
  const r = run('x = close\nplot(x[1])');
  const got = r.outputs.plots[0].values;
  assertEqual(got[0], null);
  for (let i = 1; i < BARS.length; i++) {
    assertClose(got[i], BARS[i - 1].c, 1e-9, `bar ${i}`);
  }
});

test('var persists across bars and is initialised once', () => {
  const r = run('var float first = close\nplot(first)');
  const got = r.outputs.plots[0].values;
  assertClose(got[0], BARS[0].c, 1e-9);
  assertClose(got[150], BARS[0].c, 1e-9, 'var must not be re-initialised');
});

test('accumulator with := builds a running series', () => {
  const r = run('var float acc = 0.0\nacc := acc + 1\nplot(acc)');
  const got = r.outputs.plots[0].values;
  assertClose(got[0], 1, 1e-9);
  assertClose(got[299], 300, 1e-9);
});

test('inside a loop, += produces a real series (not just per-bar)', () => {
  const r = run('float s = 0.0\nfor i = 1 to 5\n    s += i\nplot(s)');
  assertClose(r.outputs.plots[0].values[0], 15, 1e-9);
  assertClose(r.outputs.plots[0].values[299], 15, 1e-9);
});

test('crossover/crossunder', () => {
  const r = run(`
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
up = ta.crossover(fast, slow)
dn = ta.crossunder(fast, slow)
plot(up ? 1 : 0)
plot(dn ? -1 : 0, pane = "x")
`);
  const up = r.outputs.plots[0].values;
  const dn = r.outputs.plots[1].values;
  const fast = [];
  const slow = [];
  for (let i = 0; i < BARS.length; i++) {
    fast.push(i >= 4 ? BARS.slice(i - 4, i + 1).reduce((a, b) => a + b.c, 0) / 5 : null);
    slow.push(i >= 19 ? BARS.slice(i - 19, i + 1).reduce((a, b) => a + b.c, 0) / 20 : null);
  }
  for (let i = 1; i < BARS.length; i++) {
    const wantUp = fast[i - 1] !== null && slow[i - 1] !== null && fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
    assertEqual(up[i] === 1, wantUp, `crossover at ${i}`);
    const wantDn = fast[i - 1] !== null && slow[i - 1] !== null && fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
    assertEqual(dn[i] === -1, wantDn, `crossunder at ${i}`);
  }
});

test('if / else if chains', () => {
  const r = run(`
x = 0.0
if close > open
    x := 1
else if close < open
    x := -1
else
    x := 0
plot(x)
`);
  const got = r.outputs.plots[0].values;
  for (let i = 0; i < 50; i++) {
    const want = BARS[i].c > BARS[i].o ? 1 : BARS[i].c < BARS[i].o ? -1 : 0;
    assertClose(got[i], want, 1e-9, `bar ${i}`);
  }
});

test('user-defined function with parameters', () => {
  const r = run(`
mySma(src, len) =>
    ta.sma(src, len)

plot(mySma(close, 7))
`);
  const got = r.outputs.plots[0].values;
  let sum = 0;
  for (let i = 0; i < BARS.length; i++) {
    sum += BARS[i].c;
    if (i >= 7) sum -= BARS[i - 7].c;
    if (i >= 6) assertClose(got[i], sum / 7, 1e-9, `bar ${i}`);
  }
});

test('user-defined function with a statement body and early return value', () => {
  const r = run(`
range10() =>
    h = ta.highest(high, 10)
    l = ta.lowest(low, 10)
    h - l

plot(range10())
`);
  const got = r.outputs.plots[0].values;
  for (let i = 10; i < 40; i++) {
    const h = Math.max(...BARS.slice(i - 9, i + 1).map((b) => b.h));
    const l = Math.min(...BARS.slice(i - 9, i + 1).map((b) => b.l));
    assertClose(got[i], round(h - l), 0.02, `bar ${i}`);
  }
});

test('recursive function', () => {
  const r = run(`
fib(n) =>
    n < 2 ? n : fib(n - 1) + fib(n - 2)
plot(fib(10))
`);
  assertClose(r.outputs.plots[0].values[0], 55, 1e-9);
});

test('tuple destructuring from ta.macd', () => {
  const r = run(`
[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)
plot(macdLine)
plot(signalLine, pane = "s")
plot(histLine, pane = "h")
`);
  assertEqual(r.outputs.plots.length, 3);
  assert(r.outputs.plots[0].values[40] !== null, 'macd should have a value after warm-up');
  const macd = r.outputs.plots[0].values;
  const sig = r.outputs.plots[1].values;
  const hist = r.outputs.plots[2].values;
  let checked = 0;
  for (let i = 0; i < BARS.length; i++) {
    if (macd[i] !== null && sig[i] !== null) {
      assertClose(hist[i], macd[i] - sig[i], 1e-9, `hist at ${i}`);
      checked++;
    }
  }
  assert(checked > 200, `expected many hist values, got ${checked}`);
});

test('bollinger bands tuple + fill + hline', () => {
  const r = run(`
[upper, basis, lower] = ta.bb(close, 20, 2)
p1 = plot(upper, color = color.red)
p2 = plot(lower, color = color.green)
fill(p1, p2, color = color.new(color.blue, 90))
hline(0, title = "zero")
`);
  assertEqual(r.outputs.plots.length, 2);
  assertEqual(r.outputs.fills.length, 1);
  assertEqual(r.outputs.hlines.length, 1);
  assertEqual(r.outputs.hlines[0].price, 0);
});

test('arrays: push, sum, size, loops', () => {
  const r = run(`
var float[] vals = array.new_float()
if bar_index % 10 == 0
    array.push(vals, close)
plot(array.size(vals))
plot(array.sum(vals))
`);
  const size = r.outputs.plots[0].values;
  assertClose(size[299], 30, 1e-9, 'pushed 30 values over 300 bars');
  let sum = 0;
  for (let i = 0; i < BARS.length; i += 10) sum += BARS[i].c;
  assertClose(r.outputs.plots[1].values[299], sum, 0.02, 'array sum');
});

test('while loop with break', () => {
  const r = run(`
i = 0
while true
    i += 1
    if i >= 4
        break
plot(i)
`);
  assertClose(r.outputs.plots[0].values[0], 4, 1e-9);
});

test('switch statement', () => {
  const r = run(`
v = switch bar_index % 3
    0 => 100
    1 => 200
    => 300
plot(v)
`);
  const got = r.outputs.plots[0].values;
  assertClose(got[0], 100, 1e-9);
  assertClose(got[1], 200, 1e-9);
  assertClose(got[2], 300, 1e-9);
  assertClose(got[99], 100, 1e-9);
});

test('input.* registers a manifest and honours overrides', () => {
  const src = `
len = input.int(14, title = "Length", minval = 1, maxval = 200)
src = input.source(close, title = "Source")
plot(ta.sma(src, len))
`;
  const r = run(src);
  assertEqual(r.inputs.length, 1, 'one slider input');
  assertEqual(r.inputs[0].title, 'Length');
  assertEqual(r.inputs[0].defval, 14);
  const id = r.inputs[0].id;
  const r2 = run(src, { inputs: { [id]: 5 } });
  const got = r2.outputs.plots[0].values;
  for (let i = 0; i < 40; i++) {
    if (i >= 4) {
      const sum = BARS.slice(i - 4, i + 1).reduce((a, b) => a + b.c, 0);
      assertClose(got[i], sum / 5, 1e-9, `overridden length at ${i}`);
    }
  }
});

test('math and str namespaces', () => {
  const r = run(`
plot(math.round(math.sqrt(math.abs(close - close[1])), 3))
plot(str.length(str.tostring(12345)))
`);
  assertEqual(r.outputs.plots[1].values[0], 5);
});

test('request.security pulls another symbol through the host', () => {
  const btc = makeBars(300, 7);
  const host = {
    requestSecurity: (symbol, tf, expr, interp) => {
      assertEqual(symbol, 'BTC-USD');
      const vals = expr?.values;
      const out = new Array(interp.n).fill(null);
      for (let i = 0; i < interp.n; i++) out[i] = vals ? vals[i] : null;
      return { values: out, isSeries: true, length: out.length };
    },
  };
  const r = run(`plot(request.security("BTC-USD", "1D", close))`, { host });
  const got = r.outputs.plots[0].values;
  assertClose(got[10], BARS[10].c, 1e-9, 'identity passthrough');
  void btc;
});

test('strategy.entry / strategy.close record trades', () => {
  const r = run(`
strategy("t", overlay = true)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")
`);
  const s = r.outputs.strategy;
  assert(s.orders.length > 2, `expected several orders, got ${s.orders.length}`);
  assert(s.closedTrades.length > 0, 'expected at least one closed trade');
  for (const t of s.trades) {
    assert(Number.isFinite(t.profit), 'trade profit must be numeric');
    assert(t.exitBar >= t.entryBar, 'exit must not precede entry');
    assertEqual(t.direction, 'long');
  }
});

test('alertcondition records per-bar flags', () => {
  const r = run(`
c = ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
alertcondition(c, title = "Cross", message = "Crossed!")
`);
  assertEqual(r.outputs.alertConditions.length, 1);
  const flags = r.outputs.alertConditions[0].flags;
  const upCount = flags.filter(Boolean).length;
  assert(upCount > 0, 'expected at least one alert flag');
  assertEqual(r.outputs.alertConditions[0].message, 'Crossed!');
});

test('alert() logs messages with bar times', () => {
  const r = run(`
if bar_index == 5
    alert("hello", alert.freq_once_per_bar_close)
`);
  assertEqual(r.outputs.alerts.length, 1);
  assertEqual(r.outputs.alerts[0].message, 'hello');
  assertEqual(r.outputs.alerts[0].bar, 5);
});

// __commission_type_tests__
test('commission_type=cash_per_order charges flat per order', () => {
  const r = run(`
strategy("t", commission_type=strategy.commission.cash_per_order, commission_value=5, initial_capital=10000)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 5
    strategy.close("L")
`);
  const t = r.outputs.strategy.trades[0];
  assertClose(t.commission, 10, 0.01, 'flat per-order commission');
});

test('commission_type=cash_per_contract scales with size', () => {
  const r = run(`
strategy("t", commission_type=strategy.commission.cash_per_contract, commission_value=0.5, initial_capital=100000)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 5
    strategy.close("L")
`);
  const t = r.outputs.strategy.trades[0];
  assertClose(t.commission, 10, 0.01, 'per-contract commission');
});

test('commission_type=percent is the default', () => {
  const r = run(`
strategy("t", commission_value=0.1, initial_capital=10000)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 5
    strategy.close("L")
`);
  const t = r.outputs.strategy.trades[0];
  const expected = t.entryPrice * Math.abs(t.size) * 0.001 + t.exitPrice * Math.abs(t.size) * 0.001;
  assertClose(t.commission, expected, 0.01, 'default percent commission');
});

// __dividend_test__ request.dividends returns amount on ex-div bars, na elsewhere
test('request.dividends returns dividend amount on ex-div bars', () => {
  const mkBar = (t) => ({ t, o: 100, h: 101, l: 99, c: 100, v: 1000 });
  const bars = [mkBar(1000), mkBar(2000), mkBar(3000), mkBar(4000), mkBar(5000)];
  const dividends = [{ t: 3000, amount: 0.25 }];
  const r = runPine(
    `plot(request.dividends("X", dividends.net))`,
    { bars, symbol: { symbol: 'X' }, meta: { dividends } }
  );
  assert(r.ok, r.error?.message);
  const vals = r.outputs.plots[0].values;
  assertEqual(vals[0], null, 'bar 0 no dividend');
  assertEqual(vals[1], null, 'bar 1 no dividend');
  assertClose(vals[2], 0.25, 1e-9, 'bar 2 dividend amount');
  assertEqual(vals[3], null, 'bar 3 no dividend');
  assertEqual(vals[4], null, 'bar 4 no dividend');
});

// __split_test__ request.splits returns numerator/denominator on split bars
test('request.splits returns numerator and denominator on split bars', () => {
  const mkBar = (t) => ({ t, o: 100, h: 101, l: 99, c: 100, v: 1000 });
  const bars = [mkBar(1000), mkBar(2000), mkBar(3000), mkBar(4000)];
  const splits = [{ t: 3000, numerator: 4, denominator: 1 }];
  const rNum = runPine(
    `plot(request.splits("X", splits.numerator))`,
    { bars, symbol: { symbol: 'X' }, meta: { splits } }
  );
  assert(rNum.ok, rNum.error?.message);
  const numVals = rNum.outputs.plots[0].values;
  assertEqual(numVals[0], null, 'bar 0 no split');
  assertClose(numVals[2], 4, 1e-9, 'numerator at bar 2');

  const rDen = runPine(
    `plot(request.splits("X", splits.denominator))`,
    { bars, symbol: { symbol: 'X' }, meta: { splits } }
  );
  assert(rDen.ok, rDen.error?.message);
  const denVals = rDen.outputs.plots[0].values;
  assertClose(denVals[2], 1, 1e-9, 'denominator at bar 2');
});

// __entry_leg_commission_test__ commission charged on both entry and exit
test('strategy() commission is charged on entry AND exit', () => {
  const r = run(`
strategy("t", commission_value=0.1, initial_capital=10000)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 5
    strategy.close("L")
`);
  const trades = r.outputs.strategy.trades;
  assertEqual(trades.length, 1);
  const t = trades[0];
  const expectedEntryComm = t.entryPrice * Math.abs(t.size) * 0.001;
  const expectedExitComm = t.exitPrice * Math.abs(t.size) * 0.001;
  const expectedTotalComm = expectedEntryComm + expectedExitComm;
  assertClose(t.commission, expectedTotalComm, 0.01, 'commission (entry+exit)');
});

test('drawing objects: line, label, box', () => {
  const r = run(`
if bar_index == 3
    line.new(bar_index, low, bar_index + 10, high, color = color.orange, width = 2)
    label.new(bar_index, high, text = "Hi", style = label.style_label_down)
if bar_index == 4
    box.new(bar_index - 2, high, bar_index, low, bgcolor = color.new(color.red, 80))
`);
  assertEqual(r.outputs.lines.length, 1);
  assertEqual(r.outputs.labels.length, 1);
  assertEqual(r.outputs.boxes.length, 1);
  assertEqual(r.outputs.labels[0].text, 'Hi');
  assertEqual(r.outputs.lines[0].x2, 13);
});

test('bgcolor and barcolor arrays', () => {
  const r = run(`
bgcolor(close > open ? color.new(color.green, 90) : color.new(color.red, 90))
barcolor(close > open ? color.green : color.red)
`);
  assertEqual(r.outputs.bgcolors.length, 1);
  assertEqual(r.outputs.barcolors.length, 1);
  assert(r.outputs.bgcolors[0].colors[0] !== null, 'first bar should have a bg colour');
});

test('plotshape records markers', () => {
  const r = run(`
c = ta.crossover(ta.sma(close,5), ta.sma(close,20))
plotshape(c, style = shape.triangleup, location = location.belowbar, color = color.green, size = size.small)
`);
  assertEqual(r.outputs.shapes.length, 1);
  const n = r.outputs.shapes[0].series.filter(Boolean).length;
  assert(n > 0, 'expected shape markers');
});

test('syminfo and timeframe constants resolve', () => {
  const r = run(`
plot(str.length(syminfo.ticker))
plot(timeframe.isdaily ? 1 : 0)
plot(timeframe.period == "1D" ? 1 : 0)
`);
  assertEqual(r.outputs.plots[0].values[0], 4);
  assertClose(r.outputs.plots[1].values[0], 1, 1e-9);
  assertClose(r.outputs.plots[2].values[0], 1, 1e-9);
});

test('indexing into a matrix', () => {
  const r = run(`
m = matrix.new(2, 2, 0)
matrix.set(m, 0, 1, 7)
plot(m[0][1])
`);
  assertClose(r.outputs.plots[0].values[0], 7, 1e-9);
});

test('nz and na handling', () => {
  const r = run('plot(nz(na, 5))');
  assertClose(r.outputs.plots[0].values[0], 5, 1e-9);
  assertEqual(r.outputs.plots[0].values.length, BARS.length);
});

test('na() function and na constant coexist', () => {
  const r = run(`
plot(na(close) ? 1 : 0)
plot(na(na) ? 1 : 0)
plot(na(close[1]) ? 1 : 0)
plot(nz(na, 7))
`);
  assertClose(r.outputs.plots[0].values[0], 0, 1e-9, 'close is not na');
  assertClose(r.outputs.plots[1].values[0], 1, 1e-9, 'na constant is na');
  assertClose(r.outputs.plots[2].values[0], 1, 1e-9, 'close[1] is na on bar 0');
  assertClose(r.outputs.plots[2].values[1], 0, 1e-9, 'close[1] is defined on bar 1');
  assertClose(r.outputs.plots[3].values[0], 7, 1e-9, 'nz substitutes the default');
});

test('syntax errors surface with a line number', () => {
  const res = runPine('plot(close', { bars: BARS });
  assertEqual(res.ok, false, 'should fail');
  assert(/Expected/.test(res.error.message), `unhelpful error: ${res.error.message}`);
  assert(res.error.line >= 1, 'should carry a line number');
});

test('undeclared identifier is a clean runtime error', () => {
  const res = runPine('plot(nope)', { bars: BARS });
  assertEqual(res.ok, false);
  assert(/Undeclared identifier/.test(res.error.message), res.error.message);
});

test('unknown function is reported', () => {
  const res = runPine('plot(ta.doesnotexist(close))', { bars: BARS });
  assertEqual(res.ok, false);
  assert(/Unknown function/.test(res.error.message), res.error.message);
});

test('re-running over a shorter dataset resets rolling state', () => {
  const src = 'plot(ta.sma(close, 5))';
  const long = run(src, { bars: makeBars(200) });
  const short = run(src, { bars: makeBars(20) });
  assertClose(long.outputs.plots[0].values[10], short.outputs.plots[0].values[10], 1e-9, 'shorter run must agree');
  const again = run(src, { bars: makeBars(200) });
  assertClose(long.outputs.plots[0].values[199], again.outputs.plots[0].values[199], 1e-9, 'repeat run must agree');
});

test('deeply nested expressions and operator precedence', () => {
  const r = run('plot(2 + 3 * 4 - 6 / 2)\nplot((2 + 3) * (4 - 6))\nplot(1 == 1 and not (2 > 3))');
  assertClose(r.outputs.plots[0].values[0], 11, 1e-9);
  assertClose(r.outputs.plots[1].values[0], -10, 1e-9);
  assertClose(r.outputs.plots[2].values[0], 1, 1e-9);
});

test('string comparison and concatenation', () => {
  const r = run(`
s = "a" + "b"
plot(s == "ab" ? 1 : 0)
plot(str.contains(str.tostring(close), ".") ? 1 : 0)
`);
  assertClose(r.outputs.plots[0].values[0], 1, 1e-9);
});

test('performance: 3000 bars with several indicators stays fast', () => {
  const bars = makeBars(3000);
  const t0 = Date.now();
  run(
    `
[macd, sig, hist] = ta.macd(close, 12, 26, 9)
r = ta.rsi(close, 14)
[u, b, l] = ta.bb(close, 20, 2)
atr = ta.atr(14)
plot(ta.sma(close, 50) - ta.ema(close, 200))
plot(r)
plot(macd)
plot(atr)
plot(hist)
`,
    { bars }
  );
  const ms = Date.now() - t0;
  assert(ms < 8000, `took ${ms}ms which is too slow`);
  console.log(`       (3000 bars x 5 indicators = ${ms}ms)`);
});

/* ------------------------------------------------------------------ */
/* Pine v6 features                                                    */
/* ------------------------------------------------------------------ */

test('@version=6 directive sets interpreter.pineVersion', () => {
  const r = runPine(`//@version=6
indicator("v6")
plot(close)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.interpreter.pineVersion, 6);
});

test('@version=5 directive sets interpreter.pineVersion', () => {
  const r = runPine(`//@version=5
indicator("v5")
plot(close)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.interpreter.pineVersion, 5);
});

test('type / UDT constructor + field access', () => {
  const r = runPine(`//@version=6
indicator("UDT", overlay = true)
type Bar
    float high = 0.0
    float low  = 0.0
    float close = 0.0

var Bar b = Bar.new(high, low, close)
plot(b.high)
plot(b.low)
plot(b.close)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.outputs.plots.length, 3);
});

test('enum member access', () => {
  const r = runPine(`//@version=6
indicator("enum test")
enum Side
    LONG = 1
    SHORT = -1

plot(Side.LONG)
plot(Side.SHORT)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.outputs.plots.length, 2);
});

test('method on UDT', () => {
  const r = runPine(`//@version=6
indicator("method test")
type Counter
    float value = 0.0
    method add(Counter this, float x) =>
        this.value + x

var Counter c = Counter.new(0.0)
plot(c.add(5))`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.outputs.plots.length, 1);
});

test('ta.supertrend returns a tuple', () => {
  const r = runPine(`//@version=6
indicator("supertrend", overlay = true)
[st, dir] = ta.supertrend(3, 10)
plot(st)
plot(dir)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.outputs.plots.length, 2);
});

test('ta.dmi returns a tuple', () => {
  const r = runPine(`//@version=6
indicator("dmi")
[plus, minus, adx] = ta.dmi(14, 14)
plot(plus)
plot(minus)
plot(adx)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.outputs.plots.length, 3);
});

test('ta.cog compiles', () => {
  const r = runPine(`//@version=6
indicator("cog")
plot(ta.cog(close, 14))`, { bars: BARS });
  assertEqual(r.ok, true);
});

test('ta.cum compiles', () => {
  const r = runPine(`//@version=6
indicator("cum")
plot(ta.cum(close - close[1]))`, { bars: BARS });
  assertEqual(r.ok, true);
});

test('chart.left_visible_bar_index resolves', () => {
  const r = runPine(`//@version=6
indicator("chart_ns")
plot(chart.left_visible_bar_index)
plot(chart.right_visible_bar_index)`, { bars: BARS });
  assertEqual(r.ok, true);
});

test('request.security_refreshed compiles', () => {
  const r = runPine(`//@version=6
indicator("req")
plot(request.security_refreshed("AAPL", "1D", close))`, {
    bars: BARS,
    host: { requestSecurity: () => null },
  });
  assertEqual(r.ok, true);
});

test('import + export declarations compile', () => {
  const r = runPine(`//@version=6
import user/lib/1/MyLib as ml
export double(float x) => x * 2
indicator("imports")
plot(double(close))`, { bars: BARS });
  assertEqual(r.ok, true);
});

test('indicator v6 flags accepted (dynamic_requests, calc_bars_count, max_paint_count)', () => {
  const r = runPine(`//@version=6
indicator("v6 flags", overlay = true, dynamic_requests = true, calc_bars_count = 500, max_paint_count = 100)
plot(close)`, { bars: BARS });
  assertEqual(r.ok, true);
  assertEqual(r.interpreter.scriptFlags.dynamic_requests, true);
  assertEqual(r.interpreter.scriptFlags.calc_bars_count, 500);
  assertEqual(r.interpreter.scriptFlags.max_paint_count, 100);
});

test('real-world v6 script: type as param name, generic array, default values, chart.point.new, line.set_first_point', () => {
  // A focused slice of the patterns found in the user's "(17) Up finale"
  // script: `type` used as a parameter name, `int size` type-qualified param,
  // `array<orderBlock>` generic var decl, default param values, and
  // chart.point.new + line.set_first_point.
  const r = runPine(`//@version=6
indicator("real-world v6", overlay = true)
type Bar
    float hi = 0.0
    float lo = 0.0

var array<Bar> bars = array.new<Bar>()
var line myLine = line.new(na, na, na, na, color = color.red)

f_ma(src, len, type) =>
    switch type
        'EMA' => ta.ema(src, len)
        'SMA' => ta.sma(src, len)

draw(int size, bool bold = false) =>
    size * (bold ? 2 : 1)

plot(f_ma(close, 20, 'SMA'))
myLine.set_first_point(chart.point.new(time, bar_index, high))
myLine.set_second_point(chart.point.new(last_bar_time, bar_index, low))
`, { bars: BARS });
  assertEqual(r.ok, true, r.error?.message);
});

test('type-cast functions int(), float(), bool(), string()', () => {
  const r = runPine(`//@version=6
indicator("casts")
plot(int(3.7))
plot(float(2))
plot(bool(0) ? 1 : 0)
plot(string(close))`, { bars: BARS });
  assertEqual(r.ok, true, r.error?.message);
  // int(3.7) truncates to 3
  assertClose(r.outputs.plots[0].values[BARS.length - 1], 3, 1e-9, 'int truncates');
});

test('color(na) returns null without error', () => {
  const r = runPine(`//@version=6
indicator("color na")
label.new(bar_index, high, color = color(na))
plot(close)`, { bars: BARS });
  assertEqual(r.ok, true, r.error?.message);
});

test('var referencing a non-var declared on the same bar', () => {
  const r = runPine(`//@version=6
indicator("var ref")
COLORED = 'Colored'
MONOCHROME = 'Monochrome'
styleInput = input.string(COLORED, 'Style', options = [COLORED, MONOCHROME])
var x = styleInput == MONOCHROME ? 1 : 2
plot(x)`, { bars: BARS });
  assertEqual(r.ok, true, r.error?.message);
});

/* ------------------------------------------------------------------ */
console.log('========================');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) {
    console.log(`\n--- ${f.name} ---\n${f.err.stack}`);
  }
  process.exit(1);
}
