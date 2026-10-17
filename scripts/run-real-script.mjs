// Run a real-world Pine v6 script against our interpreter.
import { runPine } from '../public/js/pine/runtime.js';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../scripts/real-v6-script.pine', import.meta.url), 'utf8');

// Synthesize 500 bars of plausible AAPL data
const bars = [];
let p = 190;
for (let i = 0; i < 500; i++) {
  const drift = Math.sin(i / 9) * 1.2 + (Math.random() - 0.5) * 0.8;
  const o = p;
  const c = Math.max(1, o + drift);
  const h = Math.max(o, c) + Math.abs(Math.sin(i / 5)) * 1.5;
  const l = Math.min(o, c) - Math.abs(Math.cos(i / 7)) * 1.5;
  bars.push({
    t: 1514764800000 + i * 86400000,
    o: round(o), h: round(h), l: round(l), c: round(c),
    v: 5e6 + Math.floor(Math.abs(Math.sin(i / 13)) * 4e6),
  });
  p = c;
}
function round(v) { return Math.round(v * 100) / 100; }

const r = runPine(src, {
  bars,
  symbol: { symbol: 'AAPL', currency: 'USD', mintick: 0.01, exchange: 'Nasdaq' },
  host: { requestSecurity: () => null, leftVisibleIndex: 0, rightVisibleIndex: 1999 },
});

console.log('ok:', r.ok);
if (!r.ok) {
  console.log('error:', JSON.stringify(r.error, null, 2));
} else {
  console.log('plots:', r.outputs.plots.length);
  console.log('hlines:', r.outputs.hlines.length);
  console.log('shapes:', r.outputs.shapes.length);
  console.log('labels:', r.outputs.labels.length);
  console.log('boxes:', r.outputs.boxes.length);
  console.log('lines:', r.outputs.lines.length);
  console.log('tables:', r.outputs.tables.length);
  console.log('fills:', r.outputs.fills.length);
  console.log('bgcolors:', r.outputs.bgcolors.length);
  console.log('warnings:', r.outputs.warnings.length);
}
