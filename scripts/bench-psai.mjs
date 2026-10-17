// Benchmark the Pine runtime to identify real bottlenecks.
// Runs the PSAI template (with useAI forced on) over different bar counts and
// measures wall-clock time, slot count, and closures count.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TVCLONE = join(__dirname, '..');
const ROOT = join(TVCLONE, 'public', 'js');

const runtime = await import(`file://${join(ROOT, 'pine', 'runtime.js')}`);
const { Interpreter } = runtime;

// Get the PSAI template
const editorSrc = readFileSync(join(ROOT, 'editor2.js'), 'utf8');
const m = editorSrc.match(/name:\s*'PSAI[^']*'[^`]*?source:\s*`([\s\S]*?)`/);
const psaiSrc = m[1].replace(/^useAI\s*=\s*input\.bool\([^,]+,\s*"/m, 'useAI = input.bool(true, "');

// Bars generator
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
    const low = Math.min(open, close) - rnd() * 0.5;
    bars.push({ t, o: open, h: high, l: low, c: close, v: 1000 + Math.floor(rnd() * 500) });
    t += 60_000;
    px = close;
  }
  return bars;
}

console.log('=== PSAI runtime benchmark ===\n');
console.log('Bar count | Wall time (ms) | ms/bar | Slots | Closures | Memory (MB)');
console.log('----------|----------------|--------|-------|----------|------------');

for (const n of [200, 500, 1000, 2000, 4000, 8000]) {
  const bars = makeBars(n);
  // Force GC before each run for cleaner memory measurement
  if (global.gc) global.gc();

  const t0 = performance.now();
  const interp = new Interpreter(bars, { inputs: {} });
  const result = interp.run(psaiSrc);
  const t1 = performance.now();

  if (!result.ok) {
    console.log(`${n} | FAILED: ${result.error && result.error.message}`);
    continue;
  }

  const wall = (t1 - t0).toFixed(1);
  const perBar = ((t1 - t0) / n).toFixed(3);
  const slots = interp.slotValues.length;
  const closures = interp.closures.size;

  // Memory estimate: each slot has `n` values (most are null after scratch pool reset)
  let memMB = 'n/a';
  if (global.gc) {
    const used = process.memoryUsage();
    memMB = (used.heapUsed / 1024 / 1024).toFixed(1);
  }

  console.log(`${String(n).padStart(9)} | ${wall.padStart(14)} | ${perBar.padStart(6)} | ${String(slots).padStart(5)} | ${String(closures).padStart(8)} | ${memMB.padStart(10)}`);
}

console.log('\n=== Breakdown: time spent in different code paths ===\n');

// Now instrument: count how many times various hot functions get called during 2000 bars
const bars = makeBars(2000);
const interp = new Interpreter(bars, { inputs: {} });

// Wrap key functions with counters
let callCount = 0, exprCount = 0, stmtCount = 0, stateLookup = 0, slotRead = 0;
const origExecStmt = interp.execStatement.bind(interp);
interp.execStatement = function(node, scope, hoisting) {
  stmtCount++;
  return origExecStmt(node, scope, hoisting);
};

const t0 = performance.now();
const result = interp.run(psaiSrc);
const t1 = performance.now();

console.log(`2000 bars: ${(t1 - t0).toFixed(1)} ms total`);
console.log(`  execStatement calls:   ${stmtCount.toLocaleString()}  (${(stmtCount / 2000).toFixed(0)}/bar)`);
console.log(`  slots allocated:       ${interp.slotValues.length}`);
console.log(`  closures tracked:      ${interp.closures.size}`);
console.log(`  warnings:              ${(result.outputs.warnings || []).length}`);
