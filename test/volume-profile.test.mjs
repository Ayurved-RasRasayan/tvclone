import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVolumeProfile } from '../public/js/chart/volume-profile.js';

const mkBar = (price, volume) => ({ t: 1, o: price, h: price, l: price, c: price, v: volume });

test('empty bars  empty profile', () => {
  const vp = computeVolumeProfile([]);
  assert.equal(vp.rows.length, 0);
  assert.equal(vp.poc, null);
});

test('single price across all bars  one-bucket degenerate profile', () => {
  const bars = [
    { t: 1, o: 100, h: 100, l: 100, c: 100, v: 500 },
    { t: 2, o: 100, h: 100, l: 100, c: 100, v: 300 },
  ];
  const vp = computeVolumeProfile(bars, { rows: 10 });
  assert.equal(vp.rows.length, 1);
  assert.equal(vp.rows[0].volume, 800);
  assert.equal(vp.rows[0].isPOC, true);
  assert.equal(vp.poc, 100);
  assert.equal(vp.totalVolume, 800);
});

test('5 uniform buckets: exact volumes and POC at highest', () => {
  const bars = [
    mkBar(100.5, 100),
    mkBar(101.5, 200),
    mkBar(102.5, 300),
    mkBar(103.5, 400),
    mkBar(104.5, 500),
  ];
  const vp = computeVolumeProfile(bars, { rows: 5, priceMin: 100, priceMax: 105, valueAreaPct: 0.7 });
  assert.equal(vp.rows.length, 5);
  assert.equal(vp.rows[0].volume, 100);
  assert.equal(vp.rows[1].volume, 200);
  assert.equal(vp.rows[2].volume, 300);
  assert.equal(vp.rows[3].volume, 400);
  assert.equal(vp.rows[4].volume, 500);
  assert.equal(vp.pocIdx, 4);
  assert.equal(vp.totalVolume, 1500);
  // VA target = 1050. POC=500, expand to 3 (+400=900), expand to 2 (+300=1200)
  assert.equal(vp.vaLowIdx, 2);
  assert.equal(vp.vaHighIdx, 4);
});

test('VA expands from POC outward choosing the heavier neighbor', () => {
  const bars = [
    mkBar(100.5, 100),  // bucket 0
    mkBar(101.5, 400),  // bucket 1
    mkBar(102.5, 500),  // bucket 2 (POC)
    mkBar(103.5, 300),  // bucket 3
    mkBar(104.5, 100),  // bucket 4
  ];
  const vp = computeVolumeProfile(bars, { rows: 5, priceMin: 100, priceMax: 105, valueAreaPct: 0.7 });
  assert.equal(vp.pocIdx, 2);
  // VA target = 1400*0.7 = 980. POC=500. Next options: L=400, R=300. Pick L  900.
  // Next: L=100, R=300. Pick R  1200. VA = [1,3]
  assert.equal(vp.vaLowIdx, 1);
  assert.equal(vp.vaHighIdx, 3);
});

test('bar spanning multiple buckets distributes volume evenly', () => {
  // One bar spanning 100103 (3 buckets) with volume 900
  const bars = [
    { t: 1, o: 100, h: 103, l: 100, c: 103, v: 900 },
  ];
  const vp = computeVolumeProfile(bars, { rows: 3, priceMin: 100, priceMax: 103 });
  assert.equal(vp.rows.length, 3);
  assert.equal(vp.rows[0].volume, 300);
  assert.equal(vp.rows[1].volume, 300);
  assert.equal(vp.rows[2].volume, 300);
  assert.equal(vp.totalVolume, 900);
});

test('zero-volume bars are skipped', () => {
  const bars = [
    mkBar(100.5, 100),
    mkBar(101.5, 0),
    mkBar(102.5, 200),
  ];
  const vp = computeVolumeProfile(bars, { rows: 3, priceMin: 100, priceMax: 103 });
  assert.equal(vp.totalVolume, 300);
});

test('POC picks the highest volume bucket even in a 2-bar profile', () => {
  const bars = [mkBar(100.5, 100), mkBar(101.5, 900)];
  const vp = computeVolumeProfile(bars, { rows: 2, priceMin: 100, priceMax: 102 });
  assert.equal(vp.pocIdx, 1);
  assert.equal(vp.rows[1].volume, 900);
});
