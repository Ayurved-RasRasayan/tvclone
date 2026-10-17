// Compare PSAI original script output (with useLatching=false, composite line conceptually hidden)
// vs the edited template in editor2.js. We compare the 4 visible plot outputs:
//   1. Dynamic Upper Threshold
//   2. Dynamic Lower Threshold
//   3. Zero Line
//   4. AI Bias
//
// Both scripts must produce identical values bar-by-bar for these 4 plots.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TVCLONE = join(__dirname, '..');
const ROOT = join(TVCLONE, 'public', 'js');

// Load runtime
const runtime = await import(`file://${join(ROOT, 'pine', 'runtime.js')}`);
const runPine = runtime.runPine;

// Read the ORIGINAL psai-indicator.pine
const originalSrc = readFileSync(join(TVCLONE, 'scripts', 'psai-indicator.pine'), 'utf8');
console.log(`Original script: ${originalSrc.split('\n').length} lines, ${originalSrc.length} chars`);

// Read the EDITED template from editor2.js
const editorSrc = readFileSync(join(ROOT, 'editor2.js'), 'utf8');
const m = editorSrc.match(/name:\s*'PSAI[^']*'[^`]*?source:\s*`([\s\S]*?)`/);
if (!m) {
  console.error('Could not extract PSAI source from editor2.js');
  process.exit(1);
}
const editedSrc = m[1];
console.log(`Edited template: ${editedSrc.split('\n').length} lines, ${editedSrc.length} chars`);

// Determine which input names exist in the original (they use _sfds suffix)
// We need to set useLatching_sfds=false (it defaults to true in the original)
const origHasLatching = originalSrc.includes('useLatching_sfds');
console.log(`Original has useLatching_sfds: ${origHasLatching}`);

// The original's plot titles are (from psai-indicator.pine):
//   - "Dynamic Upper Threshold" (mappedUpper)
//   - "Dynamic Lower Threshold" (mappedLower)
//   - "Zero Line"               (mappedZero)
//   - "AI Bias"                  (mappedAiBias)
//   - "Composite Oscillator"     (mappedOsc) — we will IGNORE this one
const TARGET_TITLES = ['Dynamic Upper Threshold', 'Dynamic Lower Threshold', 'Zero Line', 'AI Bias'];

// Build synthetic bars — use a fixed seed for reproducibility
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeBars(n, seed = 12345) {
  const rnd = mulberry32(seed);
  const bars = [];
  let t = 1700000000000;
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = (Math.sin(i / 7) + Math.cos(i / 13)) * 0.7 + (rnd() - 0.5) * 0.4;
    const open = px;
    const close = open + drift;
    const high = Math.max(open, close) + rnd() * 0.5;
    const low  = Math.min(open, close) - rnd() * 0.5;
    const vol  = 1000 + Math.floor(rnd() * 500);
    bars.push({ t, o: open, h: high, l: low, c: close, v: vol });
    t += 60_000;
    px = close;
  }
  return bars;
}

// Use 400 bars to be safe (need at least 50 for stdev lookback + 20 for AI length + 50 for volLookback)
const bars = makeBars(400);
console.log(`Generated ${bars.length} bars (seed=12345)`);

// Both scripts have `useAI ? mappedAiBias : na` for the AI Bias plot. When useAI=false
// (default for both), the AI Bias plot is na everywhere — so we can't compare values.
// To make a meaningful comparison, we PATCH both scripts to force useAI=true at
// runtime by replacing the input declaration's defval. This is the most faithful
// way to "tick the useAI checkbox" without trying to map variable names to the
// auto-generated input IDs.
function forceUseAITrue(src) {
  // Original: useAI_sfds = input.bool(true,  "Use AI Forecast?", ...)
  // Edited:   useAI       = input.bool(false, "Use AI Forecast?")
  // Both should become input.bool(true, "Use AI Forecast?")
  return src
    .replace(/useAI_sfds\s*=\s*input\.bool\([^,]+,\s*"/, 'useAI_sfds = input.bool(true, "')
    .replace(/^useAI\s*=\s*input\.bool\([^,]+,\s*"/m, 'useAI = input.bool(true, "');
}

const origSrcForced = forceUseAITrue(originalSrc);
const editSrcForced = forceUseAITrue(editedSrc);
console.log(`Forced useAI=true in both. Orig patch applied: ${origSrcForced !== originalSrc}; Edit patch applied: ${editSrcForced !== editedSrc}`);

const commonOptions = {
  bars,
  inputs: {
    useLatching_sfds: false, // user said "uncheck the latch"
    // Other inputs keep their defaults
  },
};

console.log('\n=== Running ORIGINAL psai-indicator.pine (useAI forced true, useLatching=false) ===');
let origResult;
try {
  origResult = runPine(origSrcForced, commonOptions);
} catch (e) {
  console.log(`Original failed to execute: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
}
if (!origResult.ok) {
  console.log(`Original returned error: ${origResult.error && origResult.error.message}`);
  process.exit(1);
}
console.log(`Original OK. ${origResult.bars} bars processed.`);
console.log(`Original plots: ${(origResult.outputs.plots || []).length}`);
(origResult.outputs.plots || []).forEach((p, i) => {
  console.log(`  [${i}] title=${JSON.stringify(p.title)} color=${JSON.stringify(p.color)}`);
});

console.log('\n=== Running EDITED template (useAI forced true) ===');
let editResult;
try {
  editResult = runPine(editSrcForced, commonOptions);
} catch (e) {
  console.log(`Edited failed to execute: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
}
if (!editResult.ok) {
  console.log(`Edited returned error: ${editResult.error && editResult.error.message}`);
  process.exit(1);
}
console.log(`Edited OK. ${editResult.bars} bars processed.`);
console.log(`Edited plots: ${(editResult.outputs.plots || []).length}`);
(editResult.outputs.plots || []).forEach((p, i) => {
  console.log(`  [${i}] title=${JSON.stringify(p.title)} color=${JSON.stringify(p.color)}`);
});

// Now compare each target plot's values bar-by-bar
function findPlotByTitle(plots, title) {
  return (plots || []).find(p => p.title === title) || null;
}

function getValues(plot) {
  if (!plot) return null;
  return plot.values || plot.data || plot.series || [];
}

console.log('\n=== COMPARISON (bar-by-bar, last 50 bars) ===');
let allMatch = true;
let maxDiff = 0;
let maxDiffAt = -1;
let maxDiffTitle = '';

for (const title of TARGET_TITLES) {
  const origPlot = findPlotByTitle(origResult.outputs.plots, title);
  const editPlot = findPlotByTitle(editResult.outputs.plots, title);
  if (!origPlot) {
    console.log(`\n❌ Original missing plot titled "${title}"`);
    allMatch = false;
    continue;
  }
  if (!editPlot) {
    console.log(`\n❌ Edited missing plot titled "${title}"`);
    allMatch = false;
    continue;
  }
  const origVals = getValues(origPlot);
  const editVals = getValues(editPlot);
  if (!origVals || !editVals) {
    console.log(`\n❌ Could not extract values for "${title}" (orig has values: ${!!origVals}, edit has values: ${!!editVals})`);
    allMatch = false;
    continue;
  }
  if (origVals.length !== editVals.length) {
    console.log(`\n❌ Length mismatch for "${title}": orig=${origVals.length} edit=${editVals.length}`);
    allMatch = false;
    continue;
  }
  let titleMaxDiff = 0;
  let titleMaxDiffAt = -1;
  let mismatchCount = 0;
  // Skip first ~50 bars (warm-up: lookback periods)
  const start = Math.min(60, origVals.length - 50);
  for (let i = start; i < origVals.length; i++) {
    const a = origVals[i];
    const b = editVals[i];
    const aN = (a === null || a === undefined || (typeof a === 'number' && !isFinite(a))) ? null : a;
    const bN = (b === null || b === undefined || (typeof b === 'number' && !isFinite(b))) ? null : b;
    if (aN === null && bN === null) continue;
    if (aN === null || bN === null) {
      if (mismatchCount < 15) console.log(`  [${title}] bar ${i}: orig=${JSON.stringify(a)} edit=${JSON.stringify(b)} (null mismatch)`);
      mismatchCount++;
      continue;
    }
    const diff = Math.abs(aN - bN);
    if (diff > 1e-6) {
      if (mismatchCount < 8) console.log(`  [${title}] bar ${i}: orig=${aN} edit=${bN} diff=${diff}`);
      mismatchCount++;
    }
    if (diff > titleMaxDiff) {
      titleMaxDiff = diff;
      titleMaxDiffAt = i;
    }
  }
  // Dump first 5 and last 5 values for AI Bias specifically
  if (title === 'AI Bias') {
    console.log(`  AI Bias orig first 5: ${JSON.stringify(origVals.slice(0, 5))}`);
    console.log(`  AI Bias edit first 5: ${JSON.stringify(editVals.slice(0, 5))}`);
    console.log(`  AI Bias orig last 5:  ${JSON.stringify(origVals.slice(-5))}`);
    console.log(`  AI Bias edit last 5:  ${JSON.stringify(editVals.slice(-5))}`);
  }
  console.log(`  ${title}: max diff = ${titleMaxDiff.toExponential(3)} at bar ${titleMaxDiffAt}; mismatches (>1e-6): ${mismatchCount}/${origVals.length - start}`);
  // Show non-null count and sample values
  const origNonNull = origVals.filter(x => x !== null && x !== undefined && !(typeof x === 'number' && Number.isNaN(x))).length;
  const editNonNull = editVals.filter(x => x !== null && x !== undefined && !(typeof x === 'number' && Number.isNaN(x))).length;
  console.log(`    orig non-null: ${origNonNull}/${origVals.length}, edit non-null: ${editNonNull}/${editVals.length}`);
  if (origNonNull > 0) {
    const firstNN = origVals.findIndex(x => x !== null && x !== undefined && !(typeof x === 'number' && Number.isNaN(x)));
    console.log(`    orig first non-null at bar ${firstNN}: ${origVals[firstNN]}`);
    console.log(`    edit first non-null at bar ${firstNN}: ${editVals[firstNN]}`);
  }
  if (titleMaxDiff > maxDiff) {
    maxDiff = titleMaxDiff;
    maxDiffAt = titleMaxDiffAt;
    maxDiffTitle = title;
  }
  if (titleMaxDiff > 1e-4 || mismatchCount > 0) {
    allMatch = false;
  }
}

console.log(`\nOverall max diff: ${maxDiff.toExponential(3)} at bar ${maxDiffAt} (${maxDiffTitle})`);
if (allMatch) {
  console.log('\n✅ COMPLETE MATCH: edited template produces identical values to original for the 4 target plots.');
} else {
  console.log('\n❌ Outputs do not match. See differences above.');
  process.exit(1);
}

// ── Run again with different seed and more bars to confirm robustness ──
console.log('\n\n=== ROBUSTNESS CHECK: different seed (99), 600 bars ===');
const bars2 = makeBars(600, 99);
console.log(`Generated ${bars2.length} bars (seed=99)`);
const opts2 = { bars: bars2, inputs: { useLatching_sfds: false } };
const rA = runPine(forceUseAITrue(originalSrc), opts2);
const rB = runPine(forceUseAITrue(editedSrc), opts2);
if (!rA.ok || !rB.ok) {
  console.log(`Robustness run failed: orig.ok=${rA.ok} edit.ok=${rB.ok}`);
  process.exit(1);
}
let robustMatch = true;
for (const title of TARGET_TITLES) {
  const a = findPlotByTitle(rA.outputs.plots, title);
  const b = findPlotByTitle(rB.outputs.plots, title);
  if (!a || !b) { robustMatch = false; continue; }
  const av = getValues(a) || [];
  const bv = getValues(b) || [];
  if (av.length !== bv.length) { robustMatch = false; console.log(`  [${title}] length mismatch ${av.length} vs ${bv.length}`); continue; }
  let maxD = 0, misms = 0;
  for (let i = 60; i < av.length; i++) {
    const x = av[i], y = bv[i];
    const xN = (x === null || x === undefined || (typeof x === 'number' && !isFinite(x))) ? null : x;
    const yN = (y === null || y === undefined || (typeof y === 'number' && !isFinite(y))) ? null : y;
    if (xN === null && yN === null) continue;
    if (xN === null || yN === null) { misms++; continue; }
    const d = Math.abs(xN - yN);
    if (d > 1e-6) misms++;
    if (d > maxD) maxD = d;
  }
  console.log(`  ${title}: max diff = ${maxD.toExponential(3)}; mismatches = ${misms}/${av.length - 60}`);
  if (maxD > 1e-4 || misms > 0) robustMatch = false;
}
if (robustMatch) {
  console.log('\n✅ ROBUSTNESS CHECK PASSED: match holds across different bar counts and seeds.');
} else {
  console.log('\n❌ Robustness check failed.');
  process.exit(1);
}
