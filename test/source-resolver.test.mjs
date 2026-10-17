import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceBars, listAvailableSources } from '../public/js/chart/source-resolver.js';

test('resolveSourceBars returns original bars for close/builtin specs', () => {
  const bars = [{ t: 1, o: 10, h: 11, l: 9, c: 10 }, { t: 2, o: 20, h: 21, l: 19, c: 20 }];
  const chart = { indicators: [] };
  for (const spec of ['close', 'open', 'hl2', null, undefined, '']) {
    assert.equal(resolveSourceBars(chart, bars, spec), bars);
  }
});

test('resolveSourceBars substitutes indicator plot values into all OHLC', () => {
  const bars = [
    { t: 1, o: 1, h: 2, l: 1, c: 10 },
    { t: 2, o: 2, h: 3, l: 2, c: 20 },
    { t: 3, o: 3, h: 4, l: 3, c: 30 },
  ];
  const chart = {
    indicators: [{
      id: 'ind1', name: 'SMA',
      result: { ok: true, outputs: { plots: [{ title: 'sma', values: [5, 15, 25] }] } },
    }],
  };
  const result = resolveSourceBars(chart, bars, 'ind:ind1:0');
  assert.equal(result.length, 3);
  assert.equal(result[0].c, 5);
  assert.equal(result[0].o, 5);
  assert.equal(result[0].h, 5);
  assert.equal(result[0].l, 5);
  assert.equal(result[1].c, 15);
  assert.equal(result[2].c, 25);
});

test('resolveSourceBars keeps original bar where plot value is null', () => {
  const bars = [
    { t: 1, o: 10, h: 11, l: 9, c: 10 },
    { t: 2, o: 20, h: 21, l: 19, c: 20 },
    { t: 3, o: 30, h: 31, l: 29, c: 30 },
  ];
  const chart = {
    indicators: [{ id: 'ind1', result: { ok: true, outputs: { plots: [{ values: [null, 15, null] }] } } }],
  };
  const result = resolveSourceBars(chart, bars, 'ind:ind1:0');
  assert.equal(result[0].c, 10);
  assert.equal(result[1].c, 15);
  assert.equal(result[2].c, 30);
});

test('resolveSourceBars falls back on missing parent / plot', () => {
  const bars = [{ t: 1, c: 10 }];
  const chart = { indicators: [{ id: 'other', result: { ok: false } }] };
  assert.equal(resolveSourceBars(chart, bars, 'ind:missing:0'), bars);
  assert.equal(resolveSourceBars(chart, bars, 'ind:other:0'), bars);
  assert.equal(resolveSourceBars(chart, bars, 'ind:other:5'), bars);
});

test('listAvailableSources includes OHLC + every indicator plot', () => {
  const chart = {
    indicators: [{
      id: 'ind1', name: 'SMA 20',
      result: { ok: true, outputs: { plots: [{ title: 'sma', values: [1, 2, 3] }, { title: 'sig', values: [1, 1, 1] }] } },
    }],
  };
  const sources = listAvailableSources(chart);
  assert(sources.find((s) => s.value === 'close'));
  assert(sources.find((s) => s.value === 'hl2'));
  assert(sources.find((s) => s.value === 'ind:ind1:0'));
  assert(sources.find((s) => s.value === 'ind:ind1:1'));
});

test('listAvailableSources returns only builtins on empty chart', () => {
  const sources = listAvailableSources({});
  assert.equal(sources.length, 7);
  assert(sources.every((s) => !s.value.startsWith('ind:')));
});
