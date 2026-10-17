import { runPine } from '../public/js/pine/runtime.js';
const bars = [];
for (let i = 0; i < 100; i++) bars.push({ t: i * 86400000, o: 100, h: 102, l: 98, c: 101, v: 1000 });

// Show the last few lines of the script
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
const lines = src.split('\n');
console.log('Total lines:', lines.length);
console.log('Last 5 lines:');
for (let i = lines.length - 5; i < lines.length; i++) console.log(`  ${i+1}: ${lines[i]}`);

// Try to compile just the last 5 lines as a stripped indicator
const last5 = `//@version=6
indicator("test")
show_engulf = true
engBear = false
engBull = false
${lines.slice(-3).join('\n')}`;
console.log('\n--- Trying last 3 lines ---');
const r = runPine(last5, { bars, host: { requestSecurity: () => null } });
console.log('ok:', r.ok);
if (!r.ok) console.log('error:', JSON.stringify(r.error, null, 2));
