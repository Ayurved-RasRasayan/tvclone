import { tokenize, TT } from '../public/js/pine/lexer.js';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./real-v6-script.pine', import.meta.url), 'utf8');
const lines = src.split('\n');

// Inline copy of the lexer's needsContinuation.
function needsContinuation(text) {
  let depth = 0;
  let inStr = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '/' && text[k + 1] === '/') break;
    if (c === '"') inStr = true;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
  }
  if (inStr || depth > 0) return true;
  const stripped = text.replace(/\/\/.*$/, '').trimEnd();
  if (!stripped) return false;
  if (/=>$/.test(stripped)) return false;
  const m = /(?:[+\-*/%<>=!]=?|:=|\?|:|,|\band\b|\bor\b|\bnot\b)$/.exec(stripped);
  if (!m) return false;
  const op = m[0];
  if (/^(?:[+\-*/%]=|:=|=|,|\?|:|and|or|not)$/.test(op)) return true;
  if (/(?:^|\s)[A-Za-z_][\w.]*\s*=\s*[^\s].*[+\-*/%<>=!]$/.test(stripped) && !/[)\]]$/.test(stripped)) return true;
  return false;
}

for (let i = 864; i < 880; i++) {
  const line = lines[i] || '';
  console.log(`L${i+1}: needsCont=${needsContinuation(line)} | ${line.trim().substring(0, 60)}`);
}

