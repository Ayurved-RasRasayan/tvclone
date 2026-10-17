import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILE = new URL('../public/js/pine/builtins.js', import.meta.url);

test('no builtin uses empty-init withState around a nested BUILTINS.get call', () => {
  const lines = readFileSync(FILE, 'utf8').split('\n');
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/withState\(\s*c\s*,\s*\(\)\s*=>\s*\{\s*\}/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 50, lines.length); j++) {
      if (/BUILTINS\.get\([^)]+\)\(\s*\{?\s*\.\.\.c/.test(lines[j])) {
        problems.push(`withState @${i + 1} wraps BUILTINS.get @${j + 1}: ${lines[j].trim()}`);
      }
      if (/^\}\);/.test(lines[j])) break;
    }
  }
  assert.equal(
    problems.length,
    0,
    `Slot-collision pattern detected (nested BUILTINS.get inside empty-init withState):\n  ${problems.join('\n  ')}`
  );
});
