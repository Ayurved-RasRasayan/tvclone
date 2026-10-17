import { tokenize, TT } from '../public/js/pine/lexer.js';
const src = `alertcondition(show_engulf and engBear, title='Bearish Engulfing', message='[CurrencyPair] [TimeFrame], Bearish candle engulfing previous candle')`;
const toks = tokenize(src);
for (let i = 0; i < toks.length; i++) {
  const t = toks[i];
  console.log(i, t.type, JSON.stringify(t.value), 'line', t.line, 'col', t.col);
}
