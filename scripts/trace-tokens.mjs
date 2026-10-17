import { tokenize, TT } from '../public/js/pine/lexer.js';
const src = `//@version=6
indicator("test")
x = input(false, 'Color Candles', group="g")
plot(x ? 1 : 0)`;
const toks = tokenize(src);
for (let i = 0; i < toks.length; i++) {
  const t = toks[i];
  console.log(i, t.type, JSON.stringify(t.value), 'line', t.line, 'col', t.col);
}
