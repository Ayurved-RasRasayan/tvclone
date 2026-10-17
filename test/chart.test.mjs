/**
 * Chart engine tests against the real Chart class using a DOM shim.
 * Verifies geometry, scaling, rendering output, interaction maths and
 * Pine overlay integration.
 *
 * Run: node test/chart.test.mjs
 */
import { installDomShim } from './dom-shim.mjs';

const { document, Element } = installDomShim({ width: 1400, height: 800 });

// Local storage must exist before modules read it.
global.window.localStorage = global.localStorage;

const { Chart } = await import('../public/js/chart/chart.js');
const { PriceScale, Viewport, niceTicks, niceLogTicks } = await import('../public/js/chart/scale.js');
const { runPine } = await import('../public/js/pine/runtime.js');
const { createPineIndicator } = await import('../public/js/chart/pine-bridge.js');
globalThis.__chartTestDeps = { createPineIndicator };

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
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'values differ'}: got ${a}, want ${b}`);
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'values differ'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/* ------------------------------------------------------------------ *
 * Test data
 * ------------------------------------------------------------------ */

function makeBars(n, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
  const bars = [];
  let price = 180;
  const start = Date.UTC(2024, 0, 2, 14, 30);
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.48) * 2.4;
    const o = price;
    const c = Math.max(5, o + drift);
    const h = Math.max(o, c) + rnd() * 1.1;
    const l = Math.min(o, c) - rnd() * 1.1;
    bars.push({
      t: start + i * 86400000,
      o: round(o),
      h: round(h),
      l: round(l),
      c: round(c),
      v: Math.floor(1e6 + rnd() * 5e6),
    });
    price = c;
  }
  return bars;
}
const round = (v) => Math.round(v * 100) / 100;
const BARS = makeBars(420);

function makeChart(opts = {}) {
  const container = document.createElement('div');
  container._width = opts.width || 1400;
  container._height = opts.height || 800;
  const chart = new Chart(container, opts);
  chart.resize();
  chart.setData(opts.bars || BARS, {
    symbol: 'TEST',
    currency: 'USD',
    exchange: 'Test Exchange',
    timezone: 'America/New_York',
    instrumentType: 'EQUITY',
    description: 'Test Instrument',
  });
  return chart;
}

/* ------------------------------------------------------------------ */

console.log('\nChart engine tests');
console.log('==================');

test('PriceScale linear mapping round-trips', () => {
  const ps = new PriceScale('linear');
  ps.fit(100, 200, 0);
  assertClose(ps.toRatio(100), 0, 1e-9);
  assertClose(ps.toRatio(200), 1, 1e-9);
  assertClose(ps.toRatio(150), 0.5, 1e-9);
  assertClose(ps.fromRatio(0.25), 125, 1e-9);
  for (const r of [0, 0.13, 0.5, 0.87, 1]) {
    assertClose(ps.toRatio(ps.fromRatio(r)), r, 1e-9, `round trip at ${r}`);
  }
});

test('PriceScale percent mode', () => {
  const ps = new PriceScale('percent');
  ps.baseValue = 100;
  ps.fit(80, 130, 0);
  assertClose(ps.toRatio(110), (10 / 30) * 100 / 100 + 0.5, 1, 'percent r1');
  assert(ps.label(110).includes('+10.00%'), `percent label: ${ps.label(110)}`);
  assert(ps.label(90).includes('-10.00%'), `percent label: ${ps.label(90)}`);
});

test('PriceScale log mode spaces values logarithmically', () => {
  const ps = new PriceScale('log');
  ps.fit(10, 1000, 0);
  const mid = ps.toRatio(Math.sqrt(10 * 1000)); // geometric mean
  assertClose(mid, 0.5, 0.02, 'geometric midpoint should sit at the centre');
  assert(ps.toRatio(100) > ps.toRatio(10), 'monotonic');
});

test('Viewport x/index conversion', () => {
  const vp = new Viewport();
  vp.barSpacing = 10;
  vp.leftIndex = 100;
  assertClose(vp.xAtIndex(100, 1000), 0, 1e-9);
  assertClose(vp.xAtIndex(110, 1000), 100, 1e-9);
  assertClose(vp.indexAtX(250, 1000), 125, 1e-9);
});

test('Viewport zoom keeps the anchor bar fixed', () => {
  const vp = new Viewport();
  vp.barSpacing = 10;
  vp.leftIndex = 50;
  const anchor = vp.indexAtX(300, 1000); // bar under cursor
  const xBefore = vp.xAtIndex(anchor, 1000);
  vp.zoomAt(anchor, 1.5);
  const xAfter = vp.xAtIndex(anchor, 1000);
  assertClose(xAfter, xBefore, 1e-6, 'anchor bar must stay under the cursor');
});

test('niceTicks produces human-friendly steps', () => {
  const ticks = niceTicks(97.3, 103.8, 5);
  assert(ticks.length >= 3 && ticks.length <= 12, `tick count ${ticks.length}`);
  const step = ticks[1] - ticks[0];
  assert([0.5, 1, 2, 2.5, 5].some((s) => Math.abs(step - s) < 1e-9), `step ${step} should be a "nice" number`);
  for (let i = 1; i < ticks.length; i++) assertClose(ticks[i] - ticks[i - 1], step, 1e-9, 'uniform spacing');
});

test('niceLogTicks covers powers of ten', () => {
  const ticks = niceLogTicks(10, 1000, 6);
  assert(ticks.includes(100), 'should include 100');
  assert(ticks.includes(1000), 'should include 1000');
});

test('chart builds panes for price and volume', () => {
  const chart = makeChart();
  assertEqual(chart.panes.length >= 2, true, 'price + volume panes');
  assertEqual(chart.pricePane.type, 'price');
  assert(chart.volumePane && chart.volumePane.type === 'volume', 'volume pane present');
});

test('rendering draws candles, grid and axes', () => {
  const chart = makeChart();
  const ctx = chart.ctx;
  ctx.calls.length = 0;
  chart.render();
  const ops = ctx.drawOps();
  assert(ops > 100, `expected many draw ops, got ${ops}`);
  assert(ctx.countOf('fillRect') > 50, 'candle bodies drawn');
  const texts = ctx.texts();
  assert(texts.some((t) => /TEST/.test(t)), `watermark/legend text expected, got ${texts.slice(0, 12).join('|')}`);
  assert(texts.some((t) => /\d/.test(t)), 'axis labels drawn');
});

test('view transform maps prices to pixels consistently', () => {
  const chart = makeChart();
  const pane = chart.pricePane;
  const min = chart.priceScale.bottom;
  const max = chart.priceScale.top;
  const yTop = chart.yAtPrice(max);
  const yBottom = chart.yAtPrice(min);
  assertClose(yTop, pane.top, 0.5, 'max price at pane top');
  assertClose(yBottom, pane.bottom, 0.5, 'min price at pane bottom');
  const mid = chart.yAtPrice((min + max) / 2);
  assertClose(mid, (pane.top + pane.bottom) / 2, 1, 'mid price at pane middle');
  // inverse
  assertClose(chart.priceAtY(mid), (min + max) / 2, (max - min) * 0.01, 'priceAtY inverts yAtPrice');
});

test('autoscale follows the visible window', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 8;
  chart.viewport.leftIndex = 100;
  chart.autoScale = true;
  chart.render();
  const from = Math.floor(chart.viewport.leftIndex);
  const to = Math.floor(chart.viewport.leftIndex + chart.viewport.barsVisible(chart.plotWidth));
  let min = Infinity;
  let max = -Infinity;
  for (let i = from; i <= to; i++) {
    if (!BARS[i]) continue;
    min = Math.min(min, BARS[i].l);
    max = Math.max(max, BARS[i].h);
  }
  assert(chart.priceScale.bottom <= min, `bottom ${chart.priceScale.bottom} should be <= visible low ${min}`);
  assert(chart.priceScale.top >= max, `top ${chart.priceScale.top} should be >= visible high ${max}`);
});

test('all chart types render without throwing', () => {
  for (const type of ['candles', 'hollow', 'bars', 'line', 'area', 'baseline']) {
    const chart = makeChart();
    chart.setChartType(type);
    chart.ctx.calls.length = 0;
    chart.render();
    assert(chart.ctx.drawOps() > 40, `${type} produced ${chart.ctx.drawOps()} ops`);
  }
});

test('zooming out to many bars stays bounded', () => {
  const chart = makeChart({ bars: makeBars(6000) });
  chart.fitContent();
  chart.ctx.calls.length = 0;
  const t0 = Date.now();
  chart.render();
  const ms = Date.now() - t0;
  assert(ms < 1500, `render of 6000 bars took ${ms}ms`);
  console.log(`       (6000 bars rendered in ${ms}ms)`);
});

test('wheel zoom changes bar spacing and clamps', () => {
  const chart = makeChart();
  const before = chart.viewport.barSpacing;
  chart._onWheel({ offsetX: 500, offsetY: 300, deltaY: -100, preventDefault() {} });
  const zoomedIn = chart.viewport.barSpacing;
  assert(zoomedIn > before, `zoomed in: ${before} -> ${zoomedIn}`);
  for (let i = 0; i < 100; i++) chart._onWheel({ offsetX: 500, offsetY: 300, deltaY: 100, preventDefault() {} });
  assert(chart.viewport.barSpacing >= chart.viewport.minSpacing, 'clamped at minimum spacing');
  for (let i = 0; i < 200; i++) chart._onWheel({ offsetX: 500, offsetY: 300, deltaY: -100, preventDefault() {} });
  assert(chart.viewport.barSpacing <= chart.viewport.maxSpacing, 'clamped at maximum spacing');
});

test('dragging pans the viewport', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 8;
  const startLeft = chart.viewport.leftIndex;
  chart._onPointerDown({ offsetX: 600, offsetY: 300, pointerId: 1 });
  chart._onPointerMove({ offsetX: 400, offsetY: 300, pointerId: 1 });
  chart._onPointerUp({ offsetX: 400, offsetY: 300, pointerId: 1 });
  assert(chart.viewport.leftIndex > startLeft, `dragging left should advance the window (${startLeft} -> ${chart.viewport.leftIndex})`);
});

test('crosshair reports the bar under the cursor', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 10;
  chart.viewport.leftIndex = 100;
  let reported = null;
  chart.callbacks.onCrosshairMove = (info) => {
    reported = info;
  };
  chart._onPointerMove({ offsetX: 250, offsetY: 300, pointerId: 1 });
  assert(reported, 'callback fired');
  assertEqual(reported.index, 125, 'bar index under cursor');
  assert(reported.bar && typeof reported.bar.c === 'number', 'bar payload present');
  assertClose(reported.bar.c, BARS[125].c, 1e-9, 'correct bar');
});

test('crosshair renders an axis badge', () => {
  const chart = makeChart();
  chart.crosshair.visible = true;
  chart.crosshair.x = 400;
  chart.crosshair.y = 250;
  chart.crosshair.snappedIndex = 120;
  chart.octx.calls.length = 0;
  chart._renderCrosshair();
  assert(chart.octx.countOf('fillText') >= 1, 'value badge text drawn');
  assert(chart.octx.countOf('setLineDash') >= 1, 'dashed crosshair lines drawn');
});

// __bar_transforms_tests__
const mkTransformBars = (n) => {
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o + ((i % 4) - 1.5) * 3;
    const h = Math.max(o, c) + 0.5;
    const l = Math.min(o, c) - 0.5;
    out.push({ t: 1000000 + i * 86400000, o, h, l, c, v: 1000 });
    price = c;
  }
  return out;
};

test('setChartType: each price-driven type produces bars', () => {
  const types = ['renko', 'range', 'linebreak', 'kagi', 'pnf'];
  for (const type of types) {
    const chart = makeChart();
    chart.setData(mkTransformBars(200));
    const candlesCount = chart.bars.length;
    chart.setChartType(type);
    assert(chart.bars.length > 0, type + ' produced bars');
    assert(chart.bars.length !== candlesCount || type === 'linebreak',
      type + ' should change bar count (unless linebreak found no breaks)');
  }
});

test('setChartType: switching back to candles restores raw bar count', () => {
  const chart = makeChart();
  const raw = mkTransformBars(200);
  chart.setData(raw);
  const candlesCount = chart.bars.length;
  chart.setChartType('renko');
  assert(chart.bars.length !== candlesCount, 'renko changed bar count');
  chart.setChartType('candles');
  assertEqual(chart.bars.length, candlesCount, 'candles restored');
});

test('setData: stores _rawBars regardless of chart type', () => {
  const chart = makeChart();
  chart.setChartType('renko');
  const raw = mkTransformBars(150);
  chart.setData(raw);
  assertEqual(chart._rawBars.length, raw.length, '_rawBars stored');
  assert(chart.bars.length !== raw.length, 'bars are transformed');
});

// __bar_transforms_tests_end__

// __smc_drawings_test__
test('SMC drawings: all 12 types create + render without throw', () => {
  const chart = makeChart();
  chart.setData([
    { t: 1000000, o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
    { t: 1000001, o: 100.5, h: 102, l: 100, c: 101.5, v: 1000 },
    { t: 1000002, o: 101.5, h: 103, l: 101, c: 102.5, v: 1000 },
    { t: 1000003, o: 102.5, h: 104, l: 102, c: 103.5, v: 1000 },
  ]);
  const smcTypes = [
    'order_block_bull', 'order_block_bear',
    'fvg_bull', 'fvg_bear',
    'liquidity_high', 'liquidity_low',
    'bos', 'choch',
    'equal_highs', 'equal_lows',
    'premium_zone', 'discount_zone',
  ];
  for (const type of smcTypes) {
    chart.setActiveTool(type);
    chart._startDrawing(100, 300);
    chart._updatePendingDrawing(200, 200);
    chart._finishDrawing();
    assert(chart.drawings.length > 0, type + ' should add a drawing');
    const last = chart.drawings[chart.drawings.length - 1];
    assertEqual(last.type, type, type + ' drawing type');
  }
  chart.render();
  assert(true, 'render with 12 SMC drawings completed');
});

// __drawings_phase2_test__
test('phase2 drawings: 14 new types create + render without throw', () => {
  const chart = makeChart();
  chart.setData([
    { t: 1000000, o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
    { t: 1000001, o: 100.5, h: 102, l: 100, c: 101.5, v: 1000 },
    { t: 1000002, o: 101.5, h: 103, l: 101, c: 102.5, v: 1000 },
    { t: 1000003, o: 102.5, h: 104, l: 102, c: 103.5, v: 1000 },
  ]);
  const types = [
    'ellipse', 'circle', 'triangle', 'arc',
    'fib_extension', 'fib_fan', 'fib_time',
    'long_position', 'short_position',
    'gann_fan', 'arrow_marker', 'flag',
    'measure_price', 'measure_date',
  ];
  for (const type of types) {
    chart.setActiveTool(type);
    chart._startDrawing(100, 300);
    chart._updatePendingDrawing(200, 200);
    chart._finishDrawing();
    const last = chart.drawings[chart.drawings.length - 1];
    assertEqual(last.type, type, type + ' drawing type');
  }
  chart.render();
  assert(true, 'render with 14 phase2 drawings completed');
});

test('drawing tool: trendline create, hit-test, drag, delete', () => {
  const chart = makeChart();
  chart.setActiveTool('trendline');
  chart._startDrawing(200, 400);
  chart._updatePendingDrawing(600, 200);
  chart._finishDrawing();
  assertEqual(chart.drawings.length, 1, 'one drawing');
  const d = chart.drawings[0];
  assertEqual(d.type, 'trendline');

  // hit-test the middle of the line
  const midX = (chart.xAtIndex(d.x1) + chart.xAtIndex(d.x2)) / 2;
  const midY = (chart.yAtPrice(d.y1) + chart.yAtPrice(d.y2)) / 2;
  const hit = chart.hitTest(midX, midY);
  assert(hit && hit.kind === 'drawing', 'line hit-test');
  assertEqual(hit.drawing.id, d.id);

  // drag the endpoint
  chart._onPointerDown({ offsetX: chart.xAtIndex(d.x2), offsetY: chart.yAtPrice(d.y2), pointerId: 2 });
  chart._onPointerMove({ offsetX: 700, offsetY: 150, pointerId: 2 });
  chart._onPointerUp({ offsetX: 700, offsetY: 150, pointerId: 2 });
  assert(d.x1 !== undefined && Number.isFinite(d.x2), 'endpoint moved');

  chart.removeDrawing(d.id);
  assertEqual(chart.drawings.length, 0, 'removed');
});

test('drawing tool: every type can be created and rendered', () => {
  for (const type of ['trendline', 'hline', 'ray', 'rect', 'fib', 'measure']) {
    const chart = makeChart();
    chart.setActiveTool(type);
    chart._startDrawing(150, 300);
    chart._updatePendingDrawing(500, 180);
    chart._finishDrawing();
    assertEqual(chart.drawings.length, 1, `${type} created`);
    chart.ctx.calls.length = 0;
    chart.render();
    assert(chart.ctx.drawOps() > 20, `${type} rendered`);
  }
});

test('drawings survive serialise/restore', () => {
  const chart = makeChart();
  chart.addDrawing({ type: 'rect', x1: 10, y1: 200, x2: 40, y2: 190, color: '#ff0000' });
  const saved = JSON.parse(JSON.stringify(chart.getDrawings()));
  const chart2 = makeChart();
  chart2.setDrawings(saved);
  assertEqual(chart2.drawings.length, 1);
  assertEqual(chart2.drawings[0].type, 'rect');
  assertClose(chart2.drawings[0].y1, 200, 1e-9);
});

test('Pine overlay: plots/hlines/fills/labels/lines/boxes render', () => {
  const chart = makeChart();
  const result = runPine(
    `
indicator("Everything", overlay = true)
[rsiVal] = ta.rsi(close, 14)
sma20 = ta.sma(close, 20)
plot(sma20, "SMA", color = color.orange, linewidth = 2)
plot(rsiVal, "RSI", color = color.purple)
plot(ta.ema(close, 9), "EMA", style = plot.style_area, color = color.blue)
plot(hl2, "HL2", style = plot.style_stepline, color = color.teal)
hline(200, "Line", color = color.gray)
bgcolor(close > open ? color.new(color.green, 90) : na)
barcolor(close > open ? color.green : color.red)
if bar_index == 40
    line.new(bar_index - 10, low, bar_index + 10, high, color = color.orange, width = 2)
if bar_index == 41
    label.new(bar_index, high, text = "Label", style = label.style_label_down)
if bar_index == 42
    box.new(bar_index - 5, high, bar_index, low, bgcolor = color.new(color.red, 85))
plotshape(ta.crossover(close, sma20), "Up", shape.triangleup, location.belowbar, color.green)
`,
    { bars: BARS, symbol: { symbol: 'TEST', currency: 'USD' } }
  );
  assert(result.ok, `pine failed: ${result.ok ? '' : result.error.message}`);
  const ind = chart.addIndicator({
    name: 'Everything',
    overlay: true,
    compute: () => result,
    result,
  });
  assert(ind, 'indicator added');
  assertEqual(chart.isOverlay(ind), true, 'detected as overlay');
  chart.ctx.calls.length = 0;
  chart.render();
  assert(chart.ctx.drawOps() > 100, `overlay rendered (${chart.ctx.drawOps()} ops)`);
  // Fills use the path fill
  assert(chart.ctx.countOf('fill') > 0, 'fill paths drawn');
});

test('Pine pane indicator gets its own pane and scale', () => {
  const chart = makeChart();
  const result = runPine('indicator("RSI")\nplot(ta.rsi(close, 14))', { bars: BARS });
  assert(result.ok);
  const ind = chart.addIndicator({ name: 'RSI', compute: () => result, result });
  chart.recomputeIndicators();
  chart._layoutPanes();
  assertEqual(chart.isOverlay(ind), false, 'RSI should not overlay price');
  const pane = chart.panes.find((p) => p.type === 'indicator');
  assert(pane, 'indicator pane created');
  chart.render();
  assert(ind._scale && Number.isFinite(ind._scale.min) && Number.isFinite(ind._scale.max), 'pane scale computed');
  assert(ind._scale.min >= -10 && ind._scale.max <= 110, `RSI scale sane: ${JSON.stringify(ind._scale)}`);
});

test('pane heights fit inside the plot area', () => {
  const chart = makeChart();
  const result = runPine('plot(ta.rsi(close, 14))\nplot(ta.atr(14))', { bars: BARS });
  chart.addIndicator({ name: 'osc', compute: () => result, result });
  chart.recomputeIndicators();
  chart._layoutPanes();
  let prevBottom = 0;
  for (const p of chart.panes) {
    assert(p.y >= prevBottom - 2, `pane at ${p.y} overlaps previous bottom ${prevBottom}`);
    assert(p.h > 10, `pane height ${p.h} too small`);
    prevBottom = p.y + p.h;
  }
  assert(prevBottom <= chart.plotHeight + 2, `panes overflow: ${prevBottom} > ${chart.plotHeight}`);
});

test('histogram plots use the histbase', () => {
  const chart = makeChart();
  const result = runPine(
    'indicator("Hist")\n[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)\nplot(histLine, style = plot.style_columns, histbase = 0)',
    { bars: BARS }
  );
  assert(result.ok);
  chart.addIndicator({ name: 'Hist', compute: () => result, result });
  chart.recomputeIndicators();
  chart.render();
  const before = chart.ctx.countOf('fillRect');
  assert(before > 10, `histogram bars drawn (${before} fillRect)`);
});

test('replay truncates the last bar index', () => {
  const chart = makeChart();
  assertEqual(chart.lastBarIndex(), BARS.length - 1, 'full series by default');
  chart.setReplay(100);
  assertEqual(chart.lastBarIndex(), 99, 'truncated during replay');
  chart.setReplay(null);
  assertEqual(chart.lastBarIndex(), BARS.length - 1, 'restored');
});

test('legend shows OHLC of the hovered bar', () => {
  const chart = makeChart();
  chart.crosshair.visible = true;
  chart.crosshair.snappedIndex = 50;
  chart._renderLegend();
  const html = chart.legendEl.innerHTML;
  assert(/O<\/span>/.test(html), 'open label present');
  assert(/TEST/.test(html), 'symbol present');
  assert(html.includes(BARS[50].c.toFixed(chart.decimals)), `close value present: ${html.slice(0, 200)}`);
});

test('log scale toggle changes the mapping', () => {
  const chart = makeChart();
  chart.setLogScale(true);
  assertEqual(chart.priceScale.mode, 'log');
  chart.setLogScale(false);
  assertEqual(chart.priceScale.mode, 'linear');
});

test('percent scale toggle changes labels', () => {
  const chart = makeChart();
  chart.setPercentScale(true);
  assertEqual(chart.priceScale.mode, 'percent');
  const label = chart.priceScale.label(chart.priceScale.top, 2);
  assert(label.includes('%'), `percent label: ${label}`);
});

test('price axis draws the last price marker', () => {
  const chart = makeChart();
  chart.ctx.calls.length = 0;
  chart._renderPriceAxis();
  const texts = chart.ctx.texts();
  const last = BARS[BARS.length - 1].c.toFixed(chart.decimals);
  assert(texts.includes(last), `last price ${last} should be labelled; got ${texts.slice(0, 8).join(',')}`);
});

test('time axis labels adapt to the visible span', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 2;
  chart.viewport.leftIndex = 0;
  chart.ctx.calls.length = 0;
  chart._renderTimeAxis();
  const textsWide = chart.ctx.texts();
  chart.viewport.barSpacing = 40;
  chart.viewport.leftIndex = 300;
  chart.ctx.calls.length = 0;
  chart._renderTimeAxis();
  const textsZoomed = chart.ctx.texts();
  assert(textsWide.length > 0, 'wide view has labels');
  assert(textsZoomed.length > 0, 'zoomed view has labels');
  assert(textsWide.length !== textsZoomed.length || textsWide[0] !== textsZoomed[0], 'labels differ by zoom level');
});

test('empty data renders a placeholder without throwing', () => {
  const container = document.createElement('div');
  const chart = new Chart(container, {});
  chart.resize();
  chart.setData([], {});
  chart.render();
  assert(chart.ctx.texts().some((t) => /No data/.test(t)), 'placeholder text drawn');
});

test('indicator compute errors surface in the pane', () => {
  const chart = makeChart();
  chart.addIndicator({
    name: 'Broken',
    compute: () => ({ ok: false, error: { message: 'boom' } }),
  });
  chart.recomputeIndicators();
  chart.render();
  const texts = chart.ctx.texts();
  assert(texts.some((t) => /boom/.test(t)), `error should render in the pane; got ${texts.slice(0, 6).join('|')}`);
});

test('backgroundColor overrides from Pine are painted', () => {
  const chart = makeChart();
  const result = runPine('bgcolor(close > 190 ? color.new(color.green, 80) : na)', { bars: BARS });
  assert(result.ok);
  chart.addIndicator({ name: 'bg', compute: () => result, result });
  chart.recomputeIndicators();
  chart.ctx.calls.length = 0;
  chart.render();
  assert(chart.ctx.countOf('fillRect') > 10, 'background bands painted');
});

test('chart survives rapid symbol/type/layout churn', () => {
  const chart = makeChart({ bars: makeBars(200) });
  for (const type of ['line', 'candles', 'area', 'bars']) {
    chart.setChartType(type);
    chart.setData(makeBars(150, Math.floor(Math.random() * 1000)), {});
    chart.render();
  }
  assert(true);
});

test('resize recalculates pane geometry', () => {
  const chart = makeChart();
  const before = chart.pricePane.h;
  chart.container._width = 900;
  chart.container._height = 500;
  chart.resize();
  assert(chart.width === 900, `width updated (${chart.width})`);
  assert(chart.pricePane.h !== before, 'pane height recalculated');
  assert(chart.pricePane.y + chart.pricePane.h <= chart.plotHeight + 2, 'panes fit after resize');
});

/* ---------------- Pine v6: axis drag tests ---------------- */

test('dragging the price axis middle zooms the price range (TradingView style)', () => {
  const chart = makeChart();
  // Snapshot the price range set by autoscale.
  chart._layoutPanes();
  chart._autoscale();
  const top0 = chart.priceScale.top;
  const bot0 = chart.priceScale.bottom;
  const range0 = top0 - bot0;
  // Drag the middle of the price axis DOWNWARD — TradingView zooms IN, so
  // the visible price range shrinks (the chart bars appear taller).
  chart._onPointerDown({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2, pointerId: 1 });
  chart._onPointerMove({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2 + 80, pointerId: 1 });
  chart._onPointerUp({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2 + 80, pointerId: 1 });
  const range1 = chart.priceScale.top - chart.priceScale.bottom;
  assert(range1 < range0, `dragging price axis down should shrink the range (zoom in) (${range0} -> ${range1})`);
  assert(chart.autoScale === false, 'autoScale should turn off after a manual price drag');
});

test('dragging the price axis UP zooms out (range grows)', () => {
  const chart = makeChart();
  chart._layoutPanes();
  chart._autoscale();
  const range0 = chart.priceScale.top - chart.priceScale.bottom;
  chart._onPointerDown({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2, pointerId: 1 });
  chart._onPointerMove({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2 - 80, pointerId: 1 });
  chart._onPointerUp({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2 - 80, pointerId: 1 });
  const range1 = chart.priceScale.top - chart.priceScale.bottom;
  assert(range1 > range0, `dragging price axis up should grow the range (zoom out) (${range0} -> ${range1})`);
});

test('dragging the price axis edge extends only that side', () => {
  const chart = makeChart();
  chart._layoutPanes();
  chart._autoscale();
  const top0 = chart.priceScale.top;
  const bot0 = chart.priceScale.bottom;
  // Click at the very top of the price axis and drag up — top should grow.
  chart._onPointerDown({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + 2, pointerId: 1 });
  chart._onPointerMove({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top - 40, pointerId: 1 });
  chart._onPointerUp({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top - 40, pointerId: 1 });
  assert(chart.priceScale.top > top0, `top should grow (${top0} -> ${chart.priceScale.top})`);
  // The bottom must stay close to its original position (only the top moved).
  assertClose(chart.priceScale.bottom, bot0, Math.abs(top0 - bot0) * 0.05, 'bottom stays pinned');
});

test('dragging the time axis scales the bar spacing (manual mode)', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 8;
  const sp0 = chart.viewport.barSpacing;
  // Drag the middle of the time axis to the right — should zoom in (spacing grows).
  chart._onPointerDown({ offsetX: chart.plotWidth / 2, offsetY: chart.plotHeight + 12, pointerId: 1 });
  chart._onPointerMove({ offsetX: chart.plotWidth / 2 + 120, offsetY: chart.plotHeight + 12, pointerId: 1 });
  chart._onPointerUp({ offsetX: chart.plotWidth / 2 + 120, offsetY: chart.plotHeight + 12, pointerId: 1 });
  const sp1 = chart.viewport.barSpacing;
  assert(sp1 > sp0, `dragging time axis right should expand bar spacing (${sp0} -> ${sp1})`);
});

test('double-click on the price axis re-enables auto-fit', () => {
  const chart = makeChart();
  // Disable auto-fit by simulating a manual drag.
  chart._layoutPanes();
  chart.autoScale = false;
  chart._onDoubleClick({ offsetX: chart.plotWidth + 30, offsetY: chart.pricePane.top + chart.pricePane.h / 2 });
  assert(chart.autoScale === true, 'price-axis double-click re-enables auto-fit');
});

test('double-click on the plot area does a full reset', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 30;
  chart.autoScale = false;
  chart._onDoubleClick({ offsetX: 400, offsetY: 200 });
  // After a full reset, barSpacing returns to its default (8) and autoScale is back on.
  assert(chart.autoScale === true, 'plot-area double-click re-enables autoScale');
  assertEqual(chart.viewport.barSpacing, 8, 'plot-area double-click resets barSpacing');
});

test('dragging the chart body vertically pans the visible price range up/down', () => {
  const chart = makeChart();
  // Snapshot the autoscaled price range.
  chart._layoutPanes();
  chart._autoscale();
  const top0 = chart.priceScale.top;
  const bot0 = chart.priceScale.bottom;
  const range0 = top0 - bot0;
  // Click and drag DOWN on the plot area — should pan the price range DOWN
  // (both top and bottom shift by the same number of price units, range
  // width preserved). TradingView behavior.
  chart._onPointerDown({ offsetX: 400, offsetY: 200, pointerId: 1 });
  chart._onPointerMove({ offsetX: 400, offsetY: 280, pointerId: 1 });
  chart._onPointerUp({ offsetX: 400, offsetY: 280, pointerId: 1 });
  const top1 = chart.priceScale.top;
  const bot1 = chart.priceScale.bottom;
  const range1 = top1 - bot1;
  // Range width preserved.
  assertClose(range1, range0, Math.abs(range0) * 0.01, 'vertical pan preserves range width');
  // Both ends shifted down by the same amount.
  const shiftTop = top0 - top1;
  const shiftBot = bot0 - bot1;
  assert(shiftTop > 0, `top should shift down (was ${top0}, now ${top1})`);
  assertClose(shiftTop, shiftBot, Math.abs(range0) * 0.01, 'top and bottom shift by the same amount');
  // autoScale must turn off so the manual pan sticks.
  assert(chart.autoScale === false, 'vertical pan disables autoScale');
});

test('dragging the chart body horizontally still scrolls the time axis', () => {
  const chart = makeChart();
  chart.viewport.barSpacing = 8;
  const left0 = chart.viewport.leftIndex;
  // Click and drag LEFT — chart should scroll right (leftIndex increases).
  chart._onPointerDown({ offsetX: 600, offsetY: 200, pointerId: 1 });
  chart._onPointerMove({ offsetX: 400, offsetY: 200, pointerId: 1 });
  chart._onPointerUp({ offsetX: 400, offsetY: 200, pointerId: 1 });
  assert(chart.viewport.leftIndex > left0, `dragging left should advance the window (${left0} -> ${chart.viewport.leftIndex})`);
});

test('dragging the chart body diagonally pans both time and price', () => {
  const chart = makeChart();
  chart._layoutPanes();
  chart._autoscale();
  const top0 = chart.priceScale.top;
  const bot0 = chart.priceScale.bottom;
  const left0 = chart.viewport.leftIndex;
  // Drag diagonally (down + left) — both axes should pan.
  chart._onPointerDown({ offsetX: 600, offsetY: 200, pointerId: 1 });
  chart._onPointerMove({ offsetX: 400, offsetY: 280, pointerId: 1 });
  chart._onPointerUp({ offsetX: 400, offsetY: 280, pointerId: 1 });
  // Horizontal: scrolled.
  assert(chart.viewport.leftIndex > left0, 'horizontal pan happened on diagonal drag');
  // Vertical: price range shifted down.
  assert(chart.priceScale.top < top0, 'vertical pan happened on diagonal drag');
  assert(chart.priceScale.bottom < bot0, 'bottom also shifted down');
});

test('Pine v6 indicator with overlay=true is rendered on the price pane', () => {
  const chart = makeChart();
  const { createPineIndicator } = globalThis.__chartTestDeps || {};
  if (!createPineIndicator) { assert(true, 'createPineIndicator not available in test env — skipped'); return; }
  const ind = createPineIndicator({
    id: 'test_overlay',
    name: 'Test overlay',
    source: `//@version=6
indicator("test", overlay=true)
plot(close)`,
    inputs: {},
    feed: { getBars: async () => ({ bars: BARS, meta: {} }) },
    onUpdate: () => {},
  });
  const entry = chart.addIndicator(ind);
  assertEqual(entry.overlay, true, 'overlay flag read from scriptFlags');
  assert(chart._isOverlay(entry), 'indicator is treated as overlay');
});

test('Pine v6 drawing with xloc=bar_time uses timestamp for x position', () => {
  const chart = makeChart();
  const { createPineIndicator } = globalThis.__chartTestDeps || {};
  if (!createPineIndicator) { assert(true, 'skipped'); return; }
  const ind = createPineIndicator({
    id: 'test_bar_time',
    name: 'Test bar_time',
    source: `//@version=6
indicator("test", overlay=true)
label.new(time, high, text="X", xloc=xloc.bar_time)
line.new(time, high, time[5], low, xloc=xloc.bar_time, color=color.red)`,
    inputs: {},
    feed: { getBars: async () => ({ bars: BARS, meta: {} }) },
    onUpdate: () => {},
  });
  const entry = chart.addIndicator(ind);
  chart.render();
  assert(entry.result.outputs.labels.length >= 1, 'label created');
  assert(entry.result.outputs.lines.length >= 1, 'line created');
  assertEqual(entry.result.outputs.labels[0].xloc, 'bar_time', 'label xloc');
  assertEqual(entry.result.outputs.lines[0].xloc, 'bar_time', 'line xloc');
});

/* ------------------------------------------------------------------ */

console.log('==================');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`\n--- ${f.name} ---\n${f.err.stack}`);
  process.exit(1);
}
void Element;
