// Smoke test for Pine v6 features: type/method/enum, @version=6, ta.supertrend.
import { runPine } from '../public/js/pine/runtime.js';

function buildBars(n) {
  const out = new Array(n);
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    const h = o + (Math.sin(i / 3) + 1) * 1.2;
    const l = o - (Math.cos(i / 4) + 1) * 1.0;
    const c = (o + h + l) / 3 + Math.sin(i / 5) * 0.7;
    const v = 1000 + Math.round(Math.abs(Math.sin(i / 7)) * 500);
    out[i] = { t: 1700000000000 + i * 86400000, o, h, l, c, v };
    price = c;
  }
  return out;
}

function assert(name, ok, extra) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
    process.exit(1);
  }
}

const bars = buildBars(100);

console.log('Pine v6 smoke tests');
console.log('===================');

// 1. @version=6 directive is accepted and surfaces on the interpreter.
{
  const r = runPine(
    `//@version=6
indicator("v6 pragma", overlay = true)
plot(close)`,
    { bars }
  );
  assert('script with @version=6 compiles', r.ok, r.error?.message);
  assert('interpreter.pineVersion === 6', r.interpreter.pineVersion === 6, `got ${r.interpreter.pineVersion}`);
}

// 2. UDT: type Bar with fields, constructor Bar.new(...), field access.
{
  const r = runPine(
    `//@version=6
indicator("UDT", overlay = true)
type Bar
    float high = 0.0
    float low  = 0.0
    float close = 0.0

var Bar b = Bar.new(high, low, close)
plot(b.high)
plot(b.low)
plot(b.close)`,
    { bars }
  );
  assert('UDT with .new() compiles', r.ok, r.error?.message);
  assert('UDT plot outputs a series', (r.outputs.plots || []).length === 3, `got ${r.outputs.plots?.length}`);
}

// 3. Enum: enum Side with members, member access.
{
  const r = runPine(
    `//@version=6
indicator("enum test", overlay = true)
enum Side
    LONG = 1
    SHORT = -1

plot(Side.LONG)
plot(Side.SHORT)`,
    { bars }
  );
  assert('enum compiles', r.ok, r.error?.message);
}

// 4. Method: a UDT method called via `instance.method(args)`.
{
  const r = runPine(
    `//@version=6
indicator("method test", overlay = true)
type Counter
    float value = 0.0
    method add(Counter this, float x) =>
        this.value + x
var Counter c = Counter.new(0.0)
plot(c.add(5))`,
    { bars }
  );
  assert('UDT method compiles and runs', r.ok, r.error?.message);
  assert('UDT method plot exists', (r.outputs.plots || []).length === 1, `got ${r.outputs.plots?.length}`);
}

// 5. ta.supertrend compiles and returns a tuple.
{
  const r = runPine(
    `//@version=6
indicator("supertrend", overlay = true)
[st, dir] = ta.supertrend(3, 10)
plot(st)
plot(dir)`,
    { bars }
  );
  assert('ta.supertrend compiles', r.ok, r.error?.message);
  assert('supertrend plots two series', (r.outputs.plots || []).length === 2, `got ${r.outputs.plots?.length}`);
}

// 6. ta.dmi compiles and returns a tuple.
{
  const r = runPine(
    `//@version=6
indicator("dmi")
[plus, minus, adx] = ta.dmi(14, 14)
plot(plus)
plot(minus)
plot(adx)`,
    { bars }
  );
  assert('ta.dmi compiles', r.ok, r.error?.message);
  assert('dmi plots three series', (r.outputs.plots || []).length === 3, `got ${r.outputs.plots?.length}`);
}

// 7. ta.cog compiles.
{
  const r = runPine(
    `//@version=6
indicator("cog")
plot(ta.cog(close, 14))`,
    { bars }
  );
  assert('ta.cog compiles', r.ok, r.error?.message);
}

// 8. ta.cum compiles.
{
  const r = runPine(
    `//@version=6
indicator("cum")
plot(ta.cum(close - close[1]))`,
    { bars }
  );
  assert('ta.cum compiles', r.ok, r.error?.message);
}

// 9. ta.percentile_linear_interpolation compiles.
{
  const r = runPine(
    `//@version=6
indicator("pct")
plot(ta.percentile_linear_interpolation(close, 20, 50))`,
    { bars }
  );
  assert('ta.percentile_linear_interpolation compiles', r.ok, r.error?.message);
}

// 10. chart.* namespace resolves.
{
  const r = runPine(
    `//@version=6
indicator("chart_ns")
plot(chart.left_visible_bar_index)
plot(chart.right_visible_bar_index)`,
    { bars }
  );
  assert('chart.* resolves', r.ok, r.error?.message);
}

// 11. request.security_refreshed compiles.
{
  const r = runPine(
    `//@version=6
indicator("req")
plot(request.security_refreshed("AAPL", "1D", close))`,
    { bars, host: { requestSecurity: () => null } }
  );
  assert('request.security_refreshed compiles', r.ok, r.error?.message);
}

// 12. import / export compile cleanly.
{
  const r = runPine(
    `//@version=6
import user/lib/1/MyLib as ml
export double(float x) => x * 2
indicator("imports")
plot(double(close))`,
    { bars }
  );
  assert('import + export compile', r.ok, r.error?.message);
}

// 13. indicator v6 flags accepted.
{
  const r = runPine(
    `//@version=6
indicator("v6 flags", overlay = true, dynamic_requests = true, calc_bars_count = 500, max_paint_count = 100)
plot(close)`,
    { bars }
  );
  assert('indicator v6 flags accepted', r.ok, r.error?.message);
  assert('scriptFlags.dynamic_requests = true', r.interpreter.scriptFlags?.dynamic_requests === true, JSON.stringify(r.interpreter.scriptFlags));
  assert('scriptFlags.calc_bars_count = 500', r.interpreter.scriptFlags?.calc_bars_count === 500, JSON.stringify(r.interpreter.scriptFlags));
}

// 14. Backwards compatibility: v5 scripts (without @version) still run.
{
  const r = runPine(
    `//@version=5
indicator("v5 still works")
plot(close)`,
    { bars }
  );
  assert('v5 still works', r.ok, r.error?.message);
  assert('interpreter.pineVersion === 5', r.interpreter.pineVersion === 5, `got ${r.interpreter.pineVersion}`);
}

console.log('===================');
console.log('All Pine v6 smoke tests passed.');
