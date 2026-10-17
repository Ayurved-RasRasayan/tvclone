// Debug: dump AI Bias values bar-by-bar to understand the null pattern
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const TVCLONE = join(__dirname, '..');
const ROOT = join(TVCLONE, 'public', 'js');

const runtime = await import(`file://${join(ROOT, 'pine', 'runtime.js')}`);

const editorSrc = readFileSync(join(ROOT, 'editor2.js'), 'utf8');
const m = editorSrc.match(/name:\s*'PSAI[^']*'[^`]*?source:\s*`([\s\S]*?)`/);
let src = m[1];

// Force useAI=true (patch the defval)
src = src.replace(/^useAI\s*=\s*input\.bool\([^,]+,\s*"/m, 'useAI = input.bool(true, "');

// Add debug plots of intermediate AI calculations
src = src.replace(
  /confirmedAiBias = f_nr\(aiBias\)/,
  `confirmedAiBias = f_nr(aiBias)
plot(aiBias,            color=color.orange, title="DEBUG_aiBias_raw")
plot(confirmedAiBias,   color=color.yellow, title="DEBUG_confirmedAiBias")
plot(aiVal,             color=color.red,     title="DEBUG_aiVal")
plot(aiSlope,           color=color.lime,    title="DEBUG_aiSlope")`
);

function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const bars = [];
const rnd = mulberry32(12345);
let t = 1700000000000;
let px = 100;
for (let i = 0; i < 400; i++) {
  const drift = (Math.sin(i / 7) + Math.cos(i / 13)) * 0.7 + (rnd() - 0.5) * 0.4;
  const open = px;
  const close = open + drift;
  const high = Math.max(open, close) + rnd() * 0.5;
  const low = Math.min(open, close) - rnd() * 0.5;
  bars.push({ time: t, open, high, low, close, volume: 1000 + Math.floor(rnd() * 500) });
  t += 60_000;
  px = close;
}

const r = runtime.runPine(src, { bars, inputs: {} });
console.log('ok:', r.ok);
if (!r.ok) {
  console.log('error:', r.error);
  process.exit(1);
}
console.log('plots:', r.outputs.plots.length);
r.outputs.plots.forEach((p, i) => {
  const v = p.values || [];
  const last10 = v.slice(-10);
  const firstNonNull = v.findIndex(x => x !== null && x !== undefined);
  const nonNullCount = v.filter(x => x !== null && x !== undefined).length;
  console.log(`  [${i}] title=${JSON.stringify(p.title)} firstNonNullAt=${firstNonNull} nonNullCount=${nonNullCount}/${v.length}`);
  console.log(`       last 10: ${JSON.stringify(last10)}`);
});

// Also dump bars 380-399 for each plot
console.log('\n=== Bars 380-399 ===');
for (let i = 380; i < 400; i++) {
  const row = [];
  r.outputs.plots.forEach(p => {
    const v = (p.values || [])[i];
    row.push(typeof v === 'number' ? v.toFixed(2) : 'null');
  });
  console.log(`  bar ${i}: ${row.join(' | ')}`);
}
