/**
 * Volume Profile computation.
 *
 * Buckets bar volume into fixed price levels and computes:
 *   - POC (Point of Control): price level with the highest volume
 *   - VAH (Value Area High) / VAL (Value Area Low): the range containing
 *     valueAreaPct (default 70%) of total volume, expanded outward from POC
 *
 * Each bar's volume is distributed evenly across the buckets its [low, high]
 * range spans. Zero-range bars (l == h) place all volume in one bucket.
 *
 * This is a pure function: (bars, options) -> profile. No DOM, no canvas.
 */

export function computeVolumeProfile(bars, options = {}) {
  const rows = Math.max(2, Math.min(200, options.rows || 24));
  const valueAreaPct = Math.max(0.1, Math.min(0.99, options.valueAreaPct ?? 0.7));

  if (!Array.isArray(bars) || bars.length === 0) {
    return emptyProfile();
  }

  // Determine price range. Respect caller-supplied bounds if given (used for
  // FRVP where the user picks a fixed range), otherwise derive from bars.
  let priceMin = options.priceMin;
  let priceMax = options.priceMax;
  if (!Number.isFinite(priceMin) || !Number.isFinite(priceMax)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      if (Number.isFinite(b.l) && b.l < lo) lo = b.l;
      if (Number.isFinite(b.h) && b.h > hi) hi = b.h;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return emptyProfile();
    priceMin = priceMin ?? lo;
    priceMax = priceMax ?? hi;
  }

  const range = priceMax - priceMin;
  if (range <= 0) {
    // Degenerate: all prices equal. One bucket, POC = that price.
    const totalV = sumVolume(bars);
    return {
      rows: [{
        i: 0,
        priceLow: priceMin,
        priceHigh: priceMin,
        priceMid: priceMin,
        volume: totalV,
        inVA: true,
        isPOC: true,
      }],
      poc: priceMin,
      pocIdx: 0,
      vah: priceMin,
      val: priceMin,
      vaLowIdx: 0,
      vaHighIdx: 0,
      totalVolume: totalV,
      maxBucketVolume: totalV,
      priceMin,
      priceMax: priceMin,
      bucketSize: 0,
      rows_: rows,
    };
  }

  const bucketSize = range / rows;
  const buckets = new Array(rows).fill(0);
  let totalVolume = 0;

  for (const bar of bars) {
    const vol = Number(bar.v);
    if (!Number.isFinite(vol) || vol <= 0) continue;
    const bLow = Number(bar.l);
    const bHigh = Number(bar.h);
    if (!Number.isFinite(bLow) || !Number.isFinite(bHigh)) continue;

    const barRange = bHigh - bLow;
    if (barRange <= 0) {
      // Single-price bar: all volume into one bucket
      const idx = Math.min(rows - 1, Math.max(0, Math.floor((bLow - priceMin) / bucketSize)));
      buckets[idx] += vol;
      totalVolume += vol;
      continue;
    }
    const first = Math.max(0, Math.floor((bLow - priceMin) / bucketSize));
    const last = Math.min(rows - 1, Math.floor((bHigh - priceMin) / bucketSize));
    const span = last - first + 1;
    if (span <= 0) continue;
    const perBucket = vol / span;
    for (let i = first; i <= last; i++) buckets[i] += perBucket;
    totalVolume += vol;
  }

  // POC
  let pocIdx = 0;
  let pocVol = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > pocVol) { pocVol = buckets[i]; pocIdx = i; }
  }

  // Value area expansion
  const targetVol = totalVolume * valueAreaPct;
  let vaLow = pocIdx;
  let vaHigh = pocIdx;
  let vaVol = buckets[pocIdx];
  while (vaVol < targetVol && (vaLow > 0 || vaHigh < rows - 1)) {
    const lowVol = vaLow > 0 ? buckets[vaLow - 1] : -1;
    const highVol = vaHigh < rows - 1 ? buckets[vaHigh + 1] : -1;
    if (highVol >= lowVol) { vaHigh++; vaVol += buckets[vaHigh]; }
    else { vaLow--; vaVol += buckets[vaLow]; }
  }

  const priceAt = (i) => priceMin + (i + 0.5) * bucketSize;

  return {
    rows: buckets.map((vol, i) => ({
      i,
      priceLow: priceMin + i * bucketSize,
      priceHigh: priceMin + (i + 1) * bucketSize,
      priceMid: priceAt(i),
      volume: vol,
      inVA: i >= vaLow && i <= vaHigh,
      isPOC: i === pocIdx,
    })),
    poc: priceAt(pocIdx),
    pocIdx,
    vah: priceMin + (vaHigh + 1) * bucketSize,
    val: priceMin + vaLow * bucketSize,
    vaLowIdx: vaLow,
    vaHighIdx: vaHigh,
    totalVolume,
    maxBucketVolume: pocVol,
    priceMin,
    priceMax,
    bucketSize,
    rows_: rows,
  };
}

function sumVolume(bars) {
  let s = 0;
  for (const b of bars) { const v = Number(b.v); if (Number.isFinite(v)) s += v; }
  return s;
}

function emptyProfile() {
  return {
    rows: [],
    poc: null,
    pocIdx: -1,
    vah: null,
    val: null,
    vaLowIdx: -1,
    vaHighIdx: -1,
    totalVolume: 0,
    maxBucketVolume: 0,
    priceMin: null,
    priceMax: null,
    bucketSize: 0,
    rows_: 0,
  };
}
