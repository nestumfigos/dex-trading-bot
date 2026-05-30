'use strict';

/**
 * Portable recursive test runner.
 *
 * Why this exists: package.json previously ran `node --test "test/*.test.js"`,
 * a TOP-LEVEL-ONLY glob that silently skipped ~37 subdirectory test files
 * (test/exits/, test/risk/, test/execution/, test/cycle/, test/strategies/,
 * test/state/, test/stats/, test/memory/, …) — exactly the critical-path tests.
 * Those tests existed but never ran in CI, so regressions in them went unseen.
 *
 * This script discovers every *.test.js under test/ recursively and runs them
 * via `node --test` with explicit file args (works on Node 18+, no glob-engine
 * dependency, cross-platform — no reliance on shell `find`).
 *
 * Integration tests (test/integration/) are EXCLUDED by default: some spawn
 * child processes and write singleton lock files, which can collide with a
 * running bot. Opt in explicitly:
 *   node scripts/run-tests.js                # unit + everything except integration
 *   node scripts/run-tests.js --integration  # integration tests ONLY
 *   node scripts/run-tests.js --all          # everything
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_DIR = path.join(__dirname, '..', 'test');
const args = process.argv.slice(2);
const runAll = args.includes('--all');
const integrationOnly = args.includes('--integration') && !runAll;

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.test.js')) acc.push(full);
  }
  return acc;
}

const isIntegration = (file) => path.relative(TEST_DIR, file).split(path.sep).includes('integration');

let files = walk(TEST_DIR);
if (integrationOnly) files = files.filter(isIntegration);
else if (!runAll) files = files.filter((file) => !isIntegration(file));

files.sort();

if (files.length === 0) {
  console.error(`No test files found under ${TEST_DIR}`);
  process.exit(1);
}

const scopeLabel = runAll ? 'all (incl. integration)' : integrationOnly ? 'integration only' : 'unit (integration excluded)';
console.log(`Running ${files.length} test file(s) — scope: ${scopeLabel}`);

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
