import { tokenize, TT } from '../public/js/pine/lexer.js';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
const toks = tokenize(src);
// Show the last 30 tokens
console.log('Total tokens:', toks.length);
for (let i = Math.max(0, toks.length - 40); i < toks.length; i++) {
  const t = toks[i];
  console.log(i, t.type, JSON.stringify(t.value), 'line', t.line, 'col', t.col);
}

