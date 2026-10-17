/**
 * Runs every test suite in order and prints a summary.
 * Run: node test/run-all.mjs   (or: npm test)
 *
 * Child processes use inherited stdio because piped stdio is unavailable under
 * the confined Windows sandbox used by this project's development environment.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const SUITES = [
  { name: 'module wiring', file: 'test/modules.test.mjs' },
  { name: 'pine engine', file: 'test/pine.test.mjs' },
  { name: 'pine v6 smoke', file: 'test/v6-smoke.test.mjs' },
  { name: 'chart engine', file: 'test/chart.test.mjs' },
  { name: 'application', file: 'test/app.test.mjs' },
  { name: 'live data', file: 'test/live.test.mjs' },
  { name: 'cloud alerts', file: 'test/cloud-alerts.test.mjs' },
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, file)], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

console.log('==============================================');
console.log(' tvclone test suite');
console.log('==============================================');

const results = [];
for (const suite of SUITES) {
  console.log(`\n### ${suite.name} (${suite.file})\n`);
  const code = await run(suite.file);
  results.push({ ...suite, code });
}

console.log('\n==============================================');
console.log(' summary');
console.log('==============================================');
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.name}`);
}
console.log('');
console.log(failed ? `${failed} suite(s) failed` : 'all suites passed');
process.exit(failed ? 1 : 0);
