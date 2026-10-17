// Run the real v6 script against REAL Yahoo Finance bars fetched via the server.
import { runPine } from '../public/js/pine/runtime.js';
import fs from 'node:fs';

// Start the server, fetch bars, then run the script against them.
import { spawn } from 'node:child_process';
const server = spawn(process.execPath, ['server.mjs', '--port', '8850'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
server.stdout.on('data', () => {});
server.stderr.on('data', () => {});

// Wait for server to be ready
await new Promise((r) => setTimeout(r, 2000));

try {
  const res = await fetch(`http://127.0.0.1:8850/api/chart?symbol=AAPL&interval=1d&range=2y&prepost=0`);
  const j = await res.json();
  console.log('Fetched bars:', j.bars.length);

  const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
  const t0 = Date.now();
  const r = runPine(src, {
    bars: j.bars,
    symbol: { symbol: 'AAPL', currency: 'USD', mintick: 0.01, exchange: 'Nasdaq' },
    host: { requestSecurity: () => null, leftVisibleIndex: 0, rightVisibleIndex: j.bars.length - 1 },
  });
  const ms = Date.now() - t0;
  console.log('ok:', r.ok);
  console.log('took:', ms, 'ms');
  if (!r.ok) {
    console.log('error:', JSON.stringify(r.error, null, 2));
  } else {
    console.log('plots:', r.outputs.plots.length);
    console.log('shapes:', r.outputs.shapes.length);
    console.log('labels:', r.outputs.labels.length);
    console.log('lines:', r.outputs.lines.length);
    console.log('boxes:', r.outputs.boxes.length);
    console.log('tables:', r.outputs.tables.length);
    console.log('fills:', r.outputs.fills.length);
    console.log('bgcolors:', r.outputs.bgcolors.length);
    console.log('barcolors:', r.outputs.barcolors.length);
    console.log('warnings:', r.outputs.warnings.length);
    console.log('alerts:', r.outputs.alerts.length);
    console.log('alertConditions:', r.outputs.alertConditions.length);
    if (r.outputs.warnings.length) console.log('first warnings:', r.outputs.warnings.slice(0, 3));
  }
} catch (err) {
  console.log('error:', err.message);
} finally {
  server.kill('SIGTERM');
}
