// Inspect what the script's plots produce vs. the price range.
import { runPine } from '../public/js/pine/runtime.js';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const server = spawn(process.execPath, ['server.mjs', '--port', '8851'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});
await new Promise((r) => setTimeout(r, 2000));

try {
  const res = await fetch(`http://127.0.0.1:8851/api/chart?symbol=AAPL&interval=1d&range=2y&prepost=0`);
  const j = await res.json();
  const bars = j.bars;

  const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
  const r = runPine(src, {
    bars,
    symbol: { symbol: 'AAPL', currency: 'USD', mintick: 0.01, exchange: 'Nasdaq' },
    host: { requestSecurity: () => null, leftVisibleIndex: 0, rightVisibleIndex: bars.length - 1 },
  });

  console.log('ok:', r.ok);
  if (!r.ok) { console.log('error:', r.error); process.exit(0); }

  // Inspect plots
  console.log('\nPlots:');
  for (const p of r.outputs.plots) {
    const vals = (p.values || []).filter(v => v != null && !Number.isNaN(v));
    if (!vals.length) { console.log(`  ${p.id}: all na, display=${p.display}, style=${p.style}`); continue; }
    const min = Math.min(...vals), max = Math.max(...vals);
    console.log(`  ${p.id}: min=${min.toFixed(4)} max=${max.toFixed(4)} count=${vals.length} display=${p.display} style=${p.style} title=${p.title}`);
  }
  // Inspect shapes
  console.log('\nShapes:', r.outputs.shapes.length);
  if (r.outputs.shapes.length) console.log('  first shape:', JSON.stringify(r.outputs.shapes[0]).slice(0, 200));
  // Inspect labels
  console.log('\nLabels:', r.outputs.labels.length);
  if (r.outputs.labels.length) console.log('  first label:', JSON.stringify(r.outputs.labels[0]).slice(0, 200));
  // Inspect lines
  console.log('\nLines:', r.outputs.lines.length);
  if (r.outputs.lines.length) console.log('  first line:', JSON.stringify(r.outputs.lines[0]).slice(0, 200));
  // Inspect tables
  console.log('\nTables:', r.outputs.tables.length);
  if (r.outputs.tables.length) console.log('  first table keys:', Object.keys(r.outputs.tables[0]));
  // Inspect barcolors
  console.log('\nBarcolors:', r.outputs.barcolors.length);
  if (r.outputs.barcolors.length) console.log('  first barcolor:', JSON.stringify(r.outputs.barcolors[0]).slice(0, 200));

  // Price range of last 50 bars
  const last50 = bars.slice(-50);
  const pmin = Math.min(...last50.map(b => b.l));
  const pmax = Math.max(...last50.map(b => b.h));
  console.log('\nPrice range (last 50 bars):', pmin.toFixed(4), '-', pmax.toFixed(4));

  // scriptFlags
  console.log('\nscriptFlags:', JSON.stringify(r.interpreter.scriptFlags, null, 2));
} catch (err) {
  console.log('error:', err.message);
} finally {
  server.kill('SIGTERM');
}
