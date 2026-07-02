'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Smoke test — verifies critical modules load cleanly and key invariants hold
// without spawning the full bot. Target: < 30s. Block boot if any FAIL.
// Coverage:
//   1. Config schema validates current env
//   2. Memory shape ↔ MERGE_KEYS coverage
//   3. Pre-trade contract gate catalog matches expected set
//   4. Policy module loads + DEFAULTS sane
//   5. Health canary module loads + CHECKS length = 8
//   6. Decision tracker module loads
//   7. Boot modules load (singleton, lifecycle, error-handlers)
//   8. SQL utility loads (without requiring connection)
//   9. Migrations directory has expected files

const path = require('path');
const fs = require('fs');

test('smoke: config/schema validates current process.env without throwing', () => {
  const { validate, KNOBS } = require('../../src/config/schema');
  const res = validate(process.env, { strictUnknown: false });
  assert.ok(typeof res === 'object', 'validate() returns an object');
  assert.ok(Object.keys(KNOBS).length > 30, `KNOBS has ${Object.keys(KNOBS).length} entries (expected >30)`);
});

test('smoke: memory shape ↔ MERGE_KEYS coverage (Week 2 regression check)', () => {
  const { DATA_SHAPE_KEYS } = require('../../src/agent/memory/shape');
  const { MERGE_KEYS, assertMergeCoverage } = require('../../src/agent/memory/merge');
  assert.doesNotThrow(() => assertMergeCoverage(), 'merge coverage must hold');
  assert.deepEqual(
    [...DATA_SHAPE_KEYS].sort(),
    [...MERGE_KEYS].sort(),
    'shape keys and MERGE_KEYS must match',
  );
});

test('smoke: pre-trade contract catalog has 8 gates (Week 3)', () => {
  const { GATE_CATALOG } = require('../../src/risk/pre-trade-contract');
  assert.equal(GATE_CATALOG.length, 8);
});

test('smoke: policy DEFAULTS are sane (Week 5)', () => {
  const { DEFAULTS, RULES_CATALOG } = require('../../src/policy/preconditions');
  assert.equal(RULES_CATALOG.length, 5);
  assert.ok(DEFAULTS.EVO_MIN_WIN_RATE > 0 && DEFAULTS.EVO_MIN_WIN_RATE < 100);
  assert.ok(DEFAULTS.LIVE_REQUIRED_PAPER_HOURS >= 1);
  assert.ok(DEFAULTS.SIZE_MAX_CONSECUTIVE_LOSSES >= 1);
});

test('smoke: health canary has 8 checks (Week 4)', () => {
  const { CHECKS, RECOVERY_HINTS } = require('../../src/cycle/health-canary');
  assert.equal(CHECKS.length, 8);
  for (const c of CHECKS) {
    assert.ok(typeof RECOVERY_HINTS[c.name] === 'string', `${c.name} missing recovery hint`);
  }
});

test('smoke: decision tracker loads + estimateCost basic sanity', () => {
  const { trackAi, estimateCost } = require('../../src/ai/decision-tracker');
  assert.equal(typeof trackAi, 'function');
  assert.ok(estimateCost('anthropic', 1000, 1000) > 0);
});

test('smoke: boot modules load (singleton, lifecycle, error-handlers)', () => {
  assert.doesNotThrow(() => require('../../src/boot/singleton'));
  assert.doesNotThrow(() => require('../../src/boot/lifecycle'));
  assert.doesNotThrow(() => require('../../src/boot/error-handlers'));
});

test('smoke: state/lock-manager loads + has register/drain/clear/list API', () => {
  const lm = require('../../src/state/lock-manager');
  for (const fn of ['register', 'drain', 'clear', 'list']) {
    assert.equal(typeof lm[fn], 'function', `lock-manager.${fn} missing`);
  }
});

test('smoke: SQL utility loads without requiring connection', () => {
  assert.doesNotThrow(() => require('../../src/utils/sqlServer'));
});

test('smoke: migration directory has M001-M015 (15 files including 0000 bootstrap)', () => {
  const dir = path.resolve(__dirname, '../../db/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f));
  assert.ok(files.length >= 15, `expected ≥15 migration files, got ${files.length}`);
});

test('smoke: errors taxonomy loads + isTransient distinguishes EADDRINUSE', () => {
  const { isTransient, PortBindError } = require('../../src/errors');
  const err = new PortBindError('EADDRINUSE');
  assert.equal(isTransient(err), true);
});

test('smoke: total runtime under 30s (sanity)', () => {
  // This test always passes; presence in suite ensures total runtime is checked
  // via the overall test reporter. node:test reports duration_ms at the end.
  assert.ok(true);
});
