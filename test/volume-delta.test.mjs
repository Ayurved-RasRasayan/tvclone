import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBarDelta, computeDeltaSeries, cvdRange, DELTA_METHODS } from '../public/js/chart/volume-delta.js';

const mkBar = (o, h, l, c, v) => ({ t: 1, o, h, l, c, v });

test('DELTA_METHODS exposes close-position and bar-direction', () => {
  assert(DELTA_METHODS.includes('close-position'));
  assert(DELTA_METHODS.includes('bar-direction'));
});

test('close-position: bullish bar (close at high) attributes all volume to buy', () => {
  const d = computeBarDelta(mkBar(100, 110, 100, 110, 1000), 'close-position');
  assert.equal(d.buyShare, 1);
  assert.equal(d.buy, 1000);
  assert.equal(d.sell, 0);
  assert.equal(d.delta, 1000);
});

test('close-position: bearish bar (close at low) attributes all volume to sell', () => {
  const d = computeBarDelta(mkBar(100, 110, 100, 100, 1000), 'close-position');
  assert.equal(d.buyShare, 0);
  assert.equal(d.buy, 0);
  assert.equal(d.sell, 1000);
  assert.equal(d.delta, -1000);
});

test('close-position: close in middle splits 50/50', () => {
  const d = computeBarDelta(mkBar(100, 110, 100, 105, 1000), 'close-position');
  assert.equal(d.buyShare, 0.5);
  assert.equal(d.buy, 500);
  assert.equal(d.sell, 500);
  assert.equal(d.delta, 0);
});

test('close-position: no-range bar (h == l) splits 50/50', () => {
  const d = computeBarDelta(mkBar(100, 100, 100, 100, 1000), 'close-position');
  assert.equal(d.delta, 0);
  assert.equal(d.buy, 500);
  assert.equal(d.sell, 500);
});

test('bar-direction: bullish  all volume to buy', () => {
  const d = computeBarDelta(mkBar(100, 110, 90, 105, 800), 'bar-direction');
  assert.equal(d.delta, 800);
  assert.equal(d.buy, 800);
  assert.equal(d.sell, 0);
});

test('bar-direction: bearish  all volume to sell', () => {
  const d = computeBarDelta(mkBar(105, 110, 90, 95, 800), 'bar-direction');
  assert.equal(d.delta, -800);
  assert.equal(d.buy, 0);
  assert.equal(d.sell, 800);
});

test('bar-direction: doji bar uses previous close as tie-breaker', () => {
  // doji: o == c == 100. prevClose = 99  close > prevClose  buy
  const up = computeBarDelta(mkBar(100, 101, 99, 100, 500), 'bar-direction', 99);
  assert.equal(up.delta, 500);
  // prevClose = 101  close < prevClose  sell
  const down = computeBarDelta(mkBar(100, 101, 99, 100, 500), 'bar-direction', 101);
  assert.equal(down.delta, -500);
  // prevClose == close  no side  50/50
  const flat = computeBarDelta(mkBar(100, 101, 99, 100, 500), 'bar-direction', 100);
  assert.equal(flat.delta, 0);
});

test('zero / invalid volume  delta 0', () => {
  assert.equal(computeBarDelta(mkBar(100, 110, 90, 105, 0), 'close-position').delta, 0);
  assert.equal(computeBarDelta(mkBar(100, 110, 90, 105, NaN), 'close-position').delta, 0);
});

test('computeDeltaSeries: running cumulative delta sums correctly', () => {
  const bars = [
    mkBar(100, 110, 100, 110, 1000),   // close at high  +1000
    mkBar(110, 120, 100, 100, 500),    // close at low   -500
    mkBar(100, 110, 100, 105, 1000),   // close mid     0
  ];
  const s = computeDeltaSeries(bars, { method: 'close-position' });
  assert.deepEqual(s.deltas, [1000, -500, 0]);
  assert.deepEqual(s.cvd, [1000, 500, 500]);
  assert.equal(s.method, 'close-position');
});

test('computeDeltaSeries: invalid method falls back to close-position', () => {
  const s = computeDeltaSeries([mkBar(100, 110, 100, 110, 1000)], { method: 'bogus' });
  assert.equal(s.method, 'close-position');
  assert.equal(s.deltas[0], 1000);
});

test('computeDeltaSeries: empty bars  empty arrays', () => {
  const s = computeDeltaSeries([]);
  assert.equal(s.cvd.length, 0);
  assert.equal(s.deltas.length, 0);
});

test('cvdRange returns min/max of the running total', () => {
  const bars = [
    mkBar(100, 110, 100, 110, 1000),   // +1000, cvd 1000
    mkBar(110, 120, 100, 100, 500),    // -500,  cvd 500
    mkBar(100, 110, 100, 110, 1000),   // +1000, cvd 1500
  ];
  const r = cvdRange(bars);
  assert.equal(r.min, 500);
  assert.equal(r.max, 1500);
});
