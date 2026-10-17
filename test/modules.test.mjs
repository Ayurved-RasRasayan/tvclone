/**
 * Static verification of frontend module wiring.
 *  - every relative import resolves to a real file
 *  - every named import is actually exported by the target module
 *  - no obvious duplicate exports
 *
 * Run: node test/modules.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public', 'js');
let errors = 0;
let checked = 0;

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walkJs(ROOT);
const exportsOf = new Map();

/** Collect exported names from a module source (regex-based, good enough here). */
function collectExports(src) {
  const names = new Set();
  // export function/class/const/let/var NAME
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const asMatch = /^(?:[A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.add(asMatch ? asMatch[1] : t);
    }
  }
  return names;
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (/^export\s+default/m.test(src)) exportsOf.set(file, new Set(['default']));
  exportsOf.set(file, collectExports(src));
  // Detect duplicate declarations of the same exported name.
  const seen = new Map();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) {
      console.error(`  FAIL ${rel}: '${m[1]}' exported more than once`);
      errors++;
    }
    seen.set(m[1], true);
  }
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const dir = path.dirname(file);

  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // bare specifier (none expected)
    checked++;
    const target = path.resolve(dir, spec);
    if (!fs.existsSync(target)) {
      console.error(`  FAIL ${rel}: import target does not exist -> ${spec}`);
      errors++;
      continue;
    }
    const targetExports = exportsOf.get(target);
    if (!targetExports) continue;

    // named imports: { a, b as c }
    const braceMatch = /\{([\s\S]*)\}/.exec(clause);
    if (braceMatch) {
      for (const part of braceMatch[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const orig = t.split(/\s+as\s+/)[0].trim();
        if (!orig) continue;
        if (!targetExports.has(orig)) {
          console.error(`  FAIL ${rel}: '${orig}' is not exported by ${path.relative(ROOT, target)}`);
          errors++;
        }
      }
    }
    // default import: `foo from` with no braces and no `* as`
    if (!braceMatch && !/^\*\s+as/.test(clause)) {
      if (!targetExports.has('default')) {
        console.error(`  FAIL ${rel}: default import but ${path.relative(ROOT, target)} has no default export`);
        errors++;
      }
    }
  }
}

console.log(`\nmodule wiring: ${files.length} modules, ${checked} relative imports checked`);
if (errors) {
  console.error(`${errors} problem(s) found`);
  process.exit(1);
}
console.log('all imports resolve and every named import exists\n');
