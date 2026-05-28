'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EvolutionValidator = require('../src/evolution-validator');

// Construct minimal validator with stubbed internal runners so we don't
// actually run the test suite + backtests during unit tests.
function makeValidator() {
  const v = new EvolutionValidator({
    config: {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    projectRoot: __dirname,
  });
  // Replace runners with deterministic fakes.
  v.runSyntaxChecks = async () => v._fakeSyntax || [];
  v.runScriptedTests = async () => v._fakeTests || [];
  v.runDeterministicBacktests = () => v._fakeBacktests || [];
  v.runDeterministicSimulations = () => v._fakeSimulations || [];
  return v;
}

test('captureBaseline returns Map of resultKey → ok', async () => {
  const v = makeValidator();
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: false },
  ];
  v._fakeBacktests = [{ type: 'backtest', target: 'bull', ok: true }];
  const cap = await v.captureBaseline();
  assert.equal(cap.summary.totalChecks, 3);
  assert.equal(cap.summary.passedChecks, 2);
  assert.equal(cap.map.get('script_test:test/a.js'), true);
  assert.equal(cap.map.get('script_test:test/b.js'), false);
  assert.equal(cap.map.get('backtest:bull'), true);
});

test('legacy strict mode (no baseline) fails on any failure', async () => {
  const v = makeValidator();
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: false },
  ];
  const r = await v.validateCandidate({ changedFiles: [] });
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.equal(r.summary.mode, 'strict');
});

test('delta mode: pre-existing failures do NOT block (regression for 2026-05-17)', async () => {
  const v = makeValidator();
  // Baseline: test/b.js was already failing pre-patch
  const baseline = new Map([
    ['script_test:test/a.js', true],
    ['script_test:test/b.js', false],
  ]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: false }, // still failing, same as baseline
  ];
  const r = await v.validateCandidate({ changedFiles: [], baseline });
  assert.equal(r.ok, true, 'patch should pass when only pre-existing tests fail');
  assert.equal(r.newFailures.length, 0);
  assert.equal(r.preexistingFailures.length, 1);
  assert.equal(r.summary.mode, 'delta');
});

test('delta mode: NEW regression introduced by patch DOES block', async () => {
  const v = makeValidator();
  // Baseline: both passing pre-patch
  const baseline = new Map([
    ['script_test:test/a.js', true],
    ['script_test:test/b.js', true],
  ]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: false }, // BROKEN by patch
  ];
  const r = await v.validateCandidate({ changedFiles: ['src/foo.js'], baseline });
  assert.equal(r.ok, false);
  assert.equal(r.newFailures.length, 1);
  assert.equal(r.newFailures[0].target, 'test/b.js');
  assert.equal(r.preexistingFailures.length, 0);
});

test('delta mode: patch that FIXES pre-existing failure passes (improvement allowed)', async () => {
  const v = makeValidator();
  const baseline = new Map([
    ['script_test:test/a.js', true],
    ['script_test:test/b.js', false], // was failing pre-patch
  ]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: true }, // patch fixed it!
  ];
  const r = await v.validateCandidate({ changedFiles: ['src/b.js'], baseline });
  assert.equal(r.ok, true);
  assert.equal(r.newFailures.length, 0);
  assert.equal(r.preexistingFailures.length, 0);
});

test('delta mode: new check introduced by patch (not in baseline) is strict', async () => {
  const v = makeValidator();
  const baseline = new Map([['script_test:test/a.js', true]]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/new.js', ok: false }, // brand new + failing
  ];
  const r = await v.validateCandidate({ changedFiles: ['test/new.js'], baseline });
  assert.equal(r.ok, false, 'new tests added by patch must pass strictly');
  assert.equal(r.newFailures.length, 1);
  assert.equal(r.newFailures[0].target, 'test/new.js');
});

test('delta mode: summary counts both new + preexisting', async () => {
  const v = makeValidator();
  const baseline = new Map([
    ['script_test:test/a.js', true],
    ['script_test:test/b.js', false],
    ['script_test:test/c.js', true],
  ]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/a.js', ok: true },
    { type: 'script_test', target: 'test/b.js', ok: false }, // pre-existing
    { type: 'script_test', target: 'test/c.js', ok: false }, // NEW regression
  ];
  const r = await v.validateCandidate({ changedFiles: ['src/c.js'], baseline });
  assert.equal(r.ok, false);
  assert.equal(r.summary.newFailures, 1);
  assert.equal(r.summary.preexistingFailures, 1);
  assert.equal(r.summary.failedChecks, 2);
  assert.equal(r.summary.totalChecks, 3);
});

test('back-compat: `failed` array contains only blocking (NEW) failures in delta mode', async () => {
  const v = makeValidator();
  const baseline = new Map([
    ['script_test:test/preexisting.js', false],
    ['script_test:test/good.js', true],
  ]);
  v._fakeTests = [
    { type: 'script_test', target: 'test/preexisting.js', ok: false },
    { type: 'script_test', target: 'test/good.js', ok: false },
  ];
  const r = await v.validateCandidate({ changedFiles: [], baseline });
  // Old callers reading r.failed should only see the NEW regressions
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].target, 'test/good.js');
});

test('validator discovery includes nested test suites used by trading risk paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-tests-'));
  fs.mkdirSync(path.join(root, 'test', 'risk'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'root.test.js'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'test', 'risk', 'gates.test.js'), '', 'utf8');
  const discovered = await EvolutionValidator._testInternals.listJsTestsRecursively(path.join(root, 'test'));

  assert.deepEqual(discovered.map((file) => file.replace(/\\/g, '/')), ['test/risk/gates.test.js', 'test/root.test.js']);
});
