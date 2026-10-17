import { Interpreter } from '../public/js/pine/runtime.js';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
const bars = [];
let p = 190;
for (let i = 0; i < 500; i++) {
  const drift = Math.sin(i/9)*1.2 + (Math.random()-0.5)*0.8;
  const o = p, c = Math.max(1, o+drift);
  bars.push({t: 1514764800000+i*86400000, o, h:o+1, l:o-1, c, v:5e6});
  p = c;
}

const interp = new Interpreter(bars, {
  symbol: {symbol:'AAPL',currency:'USD',mintick:0.01,exchange:'Nasdaq'},
  host: {requestSecurity:()=>null, leftVisibleIndex:0, rightVisibleIndex:bars.length-1},
});

const callCounts = new Map();
const origEvalCall = interp.evalCall.bind(interp);
interp.evalCall = function(node, scope) {
  const path = node.callee?.name || (node.callee?.property ? 'method.' + node.callee.property : 'unknown');
  callCounts.set(path, (callCounts.get(path) || 0) + 1);
  return origEvalCall(node, scope);
};

const t0 = Date.now();
const r = interp.run(src);
const ms = Date.now() - t0;

console.log('Total:', ms, 'ms for', bars.length, 'bars');
console.log('Top 20 most-called functions:');
const sorted = [...callCounts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20);
for (const [name, count] of sorted) {
  console.log(`  ${name}: ${count.toLocaleString()} calls (${(count/bars.length).toFixed(1)}/bar)`);
}
const total = [...callCounts.values()].reduce((a,b)=>a+b, 0);
console.log('Total function calls:', total.toLocaleString());
console.log('Calls per bar:', (total/bars.length).toFixed(0));
