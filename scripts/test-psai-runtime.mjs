// Runtime smoke test: feed the stripped PSAI source some synthetic OHLCV bars
// and confirm it runs to completion without runtime errors.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT = join(__dirname, '..', 'public', 'js');

const editorSrc = readFileSync(join(ROOT, 'editor2.js'), 'utf8');
const m = editorSrc.match(/name:\s*'PSAI[^']*'[^`]*?source:\s*`([\s\S]*?)`/);
const psaiSource = m[1];

const runtime = await import(`file://${join(ROOT, 'pine', 'runtime.js')}`);
const runPine = runtime.runPine;

// Build 250 synthetic 1-minute OHLCV bars (need at least 50 for stdev lookback, 21 for HMA, 20 for AI length)
function makeBars(n) {
  const bars = [];
  let t = 1700000000000; // ms timestamp
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = (Math.sin(i / 7) + Math.cos(i / 13)) * 0.7 + (Math.random() - 0.5) * 0.4;
    const open = px;
    const close = open + drift;
    const high = Math.max(open, close) + Math.random() * 0.5;
    const low  = Math.min(open, close) - Math.random() * 0.5;
    const vol  = 1000 + Math.floor(Math.random() * 500);
    bars.push({ time: t, open, high, low, close, volume: vol });
    t += 60_000;
    px = close;
  }
  return bars;
}

const bars = makeBars(300);
console.log(`Generated ${bars.length} synthetic bars`);

try {
  const result = runPine(psaiSource, { bars });
  if (!result.ok) {
    console.log(`\n❌ Runtime error: ${result.error && result.error.message}`);
    process.exit(1);
  }
  console.log('Execution OK.');
  const outs = result.outputs || {};
  console.log(`  bars processed: ${result.bars}`);
  console.log(`  plots returned: ${(outs.plots || []).length}`);
  console.log(`  plotshape:      ${(outs.shapes || []).length}`);
  console.log(`  fills:          ${(outs.fills || []).length}`);
  console.log(`  hlines:         ${(outs.hlines || []).length}`);
  console.log(`  inputs manifest entries: ${(result.inputs || []).length}`);
  (outs.plots || []).forEach((p, i) => {
    console.log(`    plot#${i + 1}: title=${JSON.stringify(p.title)} color=${JSON.stringify(p.color)} lineWidth=${p.lineWidth}`);
  });
  if ((result.outputs.warnings || []).length) {
    console.log(`\n  Warnings:`);
    result.outputs.warnings.forEach(w => console.log(`    - ${w}`));
  }
  if ((outs.plots || []).length === 4 && (outs.shapes || []).length === 0 && (outs.fills || []).length === 0) {
    console.log('\n✅ PSAI template executes cleanly with exactly 4 plots (no shapes, no fills, no hlines).');
  } else {
    console.log('\n❌ Unexpected output count.');
    process.exit(1);
  }
} catch (e) {
  console.log(`\n❌ Runtime error: ${e.message}`);
  console.log(e.stack);
  process.exit(1);
}
