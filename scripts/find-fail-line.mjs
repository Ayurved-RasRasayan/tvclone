import { parse } from '../public/js/pine/parser.js';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
const lines = src.split('\n');

// Binary search for the line where parsing first fails.
let lo = 50, hi = lines.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const slice = lines.slice(0, mid).join('\n');
  try {
    parse(slice);
    lo = mid + 1;
  } catch (e) {
    hi = mid;
  }
}
console.log('First failing line (line at which parser errors when sliced up to that line):', lo);
// Show context
for (let i = Math.max(0, lo - 4); i < Math.min(lines.length, lo + 2); i++) {
  console.log(`${i+1}: ${lines[i]}`);
}
// Now parse up to lo-1 and see what error appears at lo
const slice = lines.slice(0, lo - 1).join('\n');
try {
  parse(slice);
  console.log('Parsing up to line', lo - 1, 'OK');
} catch (e) {
  console.log('Error at line', lo - 1, ':', e.message);
}
// Now parse up to lo
const slice2 = lines.slice(0, lo).join('\n');
try {
  parse(slice2);
} catch (e) {
  console.log('Error at line', lo, ':', e.message, '(line', e.line, 'col', e.col, ')');
}
