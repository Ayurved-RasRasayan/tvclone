// Verify that the stripped-down PSAI template in editor2.js still parses cleanly
// through the Pine v6 lexer + parser. The parser's `parse(source)` takes the
// source string directly (it internally tokenizes).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT = join(__dirname, '..', 'public', 'js');

const editorSrc = readFileSync(join(ROOT, 'editor2.js'), 'utf8');
const m = editorSrc.match(/name:\s*'PSAI[^']*'[^`]*?source:\s*`([\s\S]*?)`/);
if (!m) {
  console.error('Could not extract PSAI source from editor2.js');
  process.exit(1);
}
const psaiSource = m[1];
console.log(`PSAI source: ${psaiSource.split('\n').length} lines, ${psaiSource.length} chars`);

const parser = await import(`file://${join(ROOT, 'pine', 'parser.js')}`);
const parse  = parser.parse;

const ast = parse(psaiSource);
console.log(`Parsed OK. Top-level statements: ${ast.body ? ast.body.length : (ast.length || 'n/a')}`);

// Count plot/plotshape/fill calls
const body = ast.body || ast;
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => walk(x, fn));
    else if (v && typeof v === 'object') walk(v, fn);
  }
}

let plotCount = 0, plotshapeCount = 0, fillCount = 0, hlineCount = 0;
const plotTitles = [];
walk(ast, n => {
  if (n.type === 'Call' && n.callee) {
    let calleeName = '';
    if (n.callee.type === 'Ident') calleeName = n.callee.name;
    else if (typeof n.callee === 'string') calleeName = n.callee;
    if (calleeName === 'plot') {
      plotCount++;
      const titleArg = n.args && n.args.find(a => a && a.name === 'title');
      plotTitles.push(titleArg ? titleArg.value : '(positional)');
    } else if (calleeName === 'plotshape') plotshapeCount++;
    else if (calleeName === 'fill') fillCount++;
    else if (calleeName === 'hline') hlineCount++;
  }
});

console.log(`\nVisualization summary (should be 4 plot() calls, 0 plotshape, 0 fill, 0 hline):`);
console.log(`  plot()     = ${plotCount}`);
console.log(`  plotshape()= ${plotshapeCount}`);
console.log(`  fill()     = ${fillCount}`);
console.log(`  hline()    = ${hlineCount}`);
console.log(`\nPlot titles:`);
plotTitles.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

if (plotCount === 4 && plotshapeCount === 0 && fillCount === 0) {
  console.log('\n✅ PSAI template stripped correctly: exactly 4 lines (upper, lower, oscillator, AI bias).');
} else {
  console.log('\n❌ Strip-down incomplete: extra visualisation elements remain.');
  process.exit(1);
}
