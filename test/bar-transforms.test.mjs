import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoSize, rangeBars, renko, lineBreak, kagi, pointFigure } from '../public/js/chart/bar-transforms.js';

const mkBar = (t, price) => ({ t, o: price, h: price, l: price, c: price, v: 1000 });
const mkBars = (...prices) => prices.map((p, i) => mkBar(1000 + i * 1000, p));

/* ---------------- autoSize ---------------- */
test('autoSize returns 1 for empty input', () => {
  assert.equal(autoSize([]), 1);
  assert.equal(autoSize(null), 1);
});

test('autoSize returns 1% of median close', () => {
  const bars = mkBars(100, 200, 300, 400, 500);
  assert.equal(autoSize(bars), 3);
});

/* ---------------- Range Bars ---------------- */
test('rangeBars: monotonic up series produces fixed-range bars', () => {
  const bars = mkBars(100, 101, 102, 103);
  const out = rangeBars(bars, 1);
  assert.equal(out.length, 3);
  assert.equal(out[0].o, 100);
  assert.equal(out[0].c, 101);
  assert.equal(out[1].o, 101);
  assert.equal(out[1].c, 102);
  assert.equal(out[2].o, 102);
  assert.equal(out[2].c, 103);
  for (const b of out) assert(Math.abs(b.c - b.o) <= 1 + 1e-9);
});

test('rangeBars: empty input  empty output', () => {
  assert.deepEqual(rangeBars([], 1), []);
  assert.deepEqual(rangeBars(null, 1), []);
});

test('rangeBars: trailing partial bar is included when price moved but did not close', () => {
  const bars = mkBars(100, 101, 101.5);
  const out = rangeBars(bars, 1);
  assert.equal(out.length, 2, 'one closed bar + one in-progress bar');
  assert.equal(out[0].o, 100);
  assert.equal(out[0].c, 101);
  assert.equal(out[1].o, 101);
  assert.equal(out[1].c, 101.5);
});

/* ---------------- Renko ---------------- */
test('renko: monotonic up closes with reversal=2  one up brick per move', () => {
  const bars = mkBars(100, 101, 102, 103);
  const out = renko(bars, 1, { reversal: 2 });
  assert.equal(out.length, 3);
  assert.equal(out[0].o, 100); assert.equal(out[0].c, 101);
  assert.equal(out[1].o, 101); assert.equal(out[1].c, 102);
  assert.equal(out[2].o, 102); assert.equal(out[2].c, 103);
  assert(out.every(b => b.direction === 1));
});

test('renko: reversal requires 2 bricks down to flip', () => {
  const bars = mkBars(100, 101, 102, 103, 102, 101);
  const out = renko(bars, 1, { reversal: 2 });
  assert.equal(out.length, 5);
  assert.equal(out[3].direction, -1);
  assert.equal(out[3].o, 103); assert.equal(out[3].c, 102);
  assert.equal(out[4].o, 102); assert.equal(out[4].c, 101);
});

/* ---------------- Line Break ---------------- */
test('lineBreak: breaks n-period high produce up lines', () => {
  const bars = mkBars(100, 101, 102, 103, 104);
  const out = lineBreak(bars, 3);
  assert.equal(out.length, 2);
  assert(out.every(b => b.direction === 1));
});

test('lineBreak: empty or too-short input  empty output', () => {
  assert.deepEqual(lineBreak([], 3), []);
  assert.deepEqual(lineBreak(mkBars(100, 101, 102), 3), []);
});

/* ---------------- Kagi ---------------- */
test('kagi: up move then reversal produces 2 lines', () => {
  const bars = mkBars(100, 101, 102, 101, 100);
  const out = kagi(bars, 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].direction, 1);
  assert.equal(out[0].o, 100); assert.equal(out[0].c, 102);
  assert.equal(out[1].direction, -1);
  assert.equal(out[1].o, 102); assert.equal(out[1].c, 100);
});

test('kagi: empty input  empty output', () => {
  assert.deepEqual(kagi([], 1), []);
});

/* ---------------- Point & Figure ---------------- */
test('pointFigure: up move then reversal  X then O columns', () => {
  const bars = mkBars(100, 101, 102, 101, 100, 99);
  const out = pointFigure(bars, 1, 2);
  const ups = out.filter(b => b.direction === 1);
  const downs = out.filter(b => b.direction === -1);
  assert.equal(ups.length, 2, 'should have 2 X boxes');
  assert.equal(downs.length, 3, 'should have 3 O boxes');
  assert.equal(ups[0].o, 100); assert.equal(ups[0].c, 101);
  assert.equal(ups[1].o, 101); assert.equal(ups[1].c, 102);
  assert.equal(downs[0].o, 102); assert.equal(downs[0].c, 101);
  assert.equal(downs[1].o, 101); assert.equal(downs[1].c, 100);
  assert.equal(downs[2].o, 100); assert.equal(downs[2].c, 99);
});

test('pointFigure: empty or single-bar input  empty output', () => {
  assert.deepEqual(pointFigure([], 1, 3), []);
  assert.deepEqual(pointFigure(mkBars(100), 1, 3), []);
});
