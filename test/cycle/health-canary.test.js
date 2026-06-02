'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  runHealthCanary,
  CHECKS,
  RECOVERY_HINTS,
  STATUS,
  _resetCountersForTest,
  checkMemoryMtime,
  checkCountersMonotonic,
  checkSqlLatency,
  checkAiCircuit,
  checkLockFiles,
  checkPositionsIntact,
  checkRestartCount,
} = require('../../src/cycle/health-canary');

// ─── catalog sanity ───────────────────────────────────────────────────────

test('CHECKS contains 8 entries', () => {
  assert.equal(CHECKS.length, 8);
});

test('RECOVERY_HINTS covers every check', () => {
  for (const c of CHECKS) {
    assert.ok(typeof RECOVERY_HINTS[c.name] === 'string', `missing hint for ${c.name}`);
  }
});

// ─── individual checks ────────────────────────────────────────────────────

test('checkMemoryMtime: fresh file → PASS', async () => {
  const tmp = path.join(os.tmpdir(), `mem-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const res = await checkMemoryMtime({ memoryPath: tmp });
  assert.equal(res.status, STATUS.PASS);
  fs.unlinkSync(tmp);
});

test('checkMemoryMtime: stale file (mtime back-dated 250min) → FAIL', async () => {
  // Threshold raised to 240min in 2026-05-17 fix (SQL-primary save path leaves
  // file stale during idle; only flag if truly stuck > 4h).
  const tmp = path.join(os.tmpdir(), `mem-stale-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const oldTime = Date.now() / 1000 - 250 * 60;  // 250min ago (> 240min threshold)
  fs.utimesSync(tmp, oldTime, oldTime);
  const res = await checkMemoryMtime({ memoryPath: tmp });
  assert.equal(res.status, STATUS.FAIL);
  fs.unlinkSync(tmp);
});

test('checkMemoryMtime: stale file < 4h with no bootTimeMs → PASS (idle bot)', async () => {
  const tmp = path.join(os.tmpdir(), `mem-idle-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const oldTime = Date.now() / 1000 - 60 * 60; // 1h ago
  fs.utimesSync(tmp, oldTime, oldTime);
  const res = await checkMemoryMtime({ memoryPath: tmp });
  assert.equal(res.status, STATUS.PASS);
  fs.unlinkSync(tmp);
});

test('checkMemoryMtime: stale file but mtime >= bootTimeMs → PASS (writer ran post-boot)', async () => {
  const tmp = path.join(os.tmpdir(), `mem-post-boot-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const bootTimeMs = Date.now() - 5 * 60_000; // booted 5min ago
  const res = await checkMemoryMtime({ memoryPath: tmp, bootTimeMs });
  assert.equal(res.status, STATUS.PASS);
  assert.ok(res.value.includes('post-boot'));
  fs.unlinkSync(tmp);
});

test('checkMemoryMtime: missing path → SKIPPED', async () => {
  const res = await checkMemoryMtime({});
  assert.equal(res.status, STATUS.SKIPPED);
});

test('checkCountersMonotonic: first run baseline → PASS', () => {
  _resetCountersForTest();
  const res = checkCountersMonotonic({ memorySnapshot: { symbolWinRates: { a: {}, b: {} } } });
  assert.equal(res.status, STATUS.PASS);
});

test('checkCountersMonotonic: regression → FAIL', () => {
  _resetCountersForTest();
  checkCountersMonotonic({ memorySnapshot: { symbolWinRates: { a: {}, b: {}, c: {} } } });
  const res = checkCountersMonotonic({ memorySnapshot: { symbolWinRates: { a: {} } } });
  assert.equal(res.status, STATUS.FAIL);
  assert.match(res.value, /symbolWinRates/);
});

test('checkCountersMonotonic: monotonic growth → PASS', () => {
  _resetCountersForTest();
  checkCountersMonotonic({ memorySnapshot: { symbolWinRates: { a: {} } } });
  const res = checkCountersMonotonic({ memorySnapshot: { symbolWinRates: { a: {}, b: {} } } });
  assert.equal(res.status, STATUS.PASS);
});

test('checkSqlLatency: no SQL → SKIPPED', async () => {
  const res = await checkSqlLatency({});
  assert.equal(res.status, STATUS.SKIPPED);
});

test('checkSqlLatency: fast SQL → PASS', async () => {
  const sql = { request() { return { async query() { return { recordset: [] }; } }; } };
  const res = await checkSqlLatency({ sql });
  assert.equal(res.status, STATUS.PASS);
});

test('checkSqlLatency: throwing SQL → FAIL', async () => {
  const sql = { request() { return { async query() { throw new Error('boom'); } }; } };
  const res = await checkSqlLatency({ sql });
  assert.equal(res.status, STATUS.FAIL);
});

test('checkAiCircuit: all closed → PASS', () => {
  const res = checkAiCircuit({ aiCircuits: { anthropic: { cooldownUntil: 0 }, groq: { cooldownUntil: 0 } } });
  assert.equal(res.status, STATUS.PASS);
});

test('checkAiCircuit: some open → WARN', () => {
  const res = checkAiCircuit({ aiCircuits: { anthropic: { cooldownUntil: Date.now() + 10000 }, groq: { cooldownUntil: 0 } } });
  assert.equal(res.status, STATUS.WARN);
});

test('checkAiCircuit: all open → FAIL', () => {
  const future = Date.now() + 10000;
  const res = checkAiCircuit({ aiCircuits: { anthropic: { cooldownUntil: future }, groq: { cooldownUntil: future } } });
  assert.equal(res.status, STATUS.FAIL);
});

test('checkLockFiles: ignores proper-lockfile position mutex target', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
  try {
    fs.writeFileSync(path.join(dir, '.position-live.lock'), '', 'utf8');
    const res = await checkLockFiles({ dataDir: dir });
    assert.equal(res.status, STATUS.PASS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLockFiles: dead pid lock → FAIL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-'));
  try {
    fs.writeFileSync(path.join(dir, 'runtime-test.lock'), JSON.stringify({ pid: -1 }), 'utf8');
    const res = await checkLockFiles({ dataDir: dir });
    assert.equal(res.status, STATUS.FAIL);
    assert.match(res.value, /runtime-test\.lock/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkPositionsIntact: all ok → PASS', () => {
  const res = checkPositionsIntact({ positions: { 'kucoin:KCS': { entryPrice: 5, lastPriceTs: Date.now() } } });
  assert.equal(res.status, STATUS.PASS);
});

test('checkPositionsIntact: missing entryPrice → FAIL', () => {
  const res = checkPositionsIntact({ positions: { 'kucoin:KCS': { entryPrice: NaN } } });
  assert.equal(res.status, STATUS.FAIL);
  assert.match(res.value, /noEntry/);
});

test('checkPositionsIntact: stale price (>60min) → FAIL', () => {
  const stale = Date.now() - (90 * 60_000);
  const res = checkPositionsIntact({ positions: { 'kucoin:KCS': { entryPrice: 5, lastPriceTs: stale } } });
  assert.equal(res.status, STATUS.FAIL);
});

test('checkRestartCount: under threshold → PASS', () => {
  const res = checkRestartCount({ restartCountLastHour: 1 });
  assert.equal(res.status, STATUS.PASS);
});

test('checkRestartCount: at threshold → FAIL', () => {
  const res = checkRestartCount({ restartCountLastHour: 3 });
  assert.equal(res.status, STATUS.FAIL);
});

test('checkRestartCount: missing → SKIPPED', () => {
  const res = checkRestartCount({});
  assert.equal(res.status, STATUS.SKIPPED);
});

// ─── orchestrator ─────────────────────────────────────────────────────────

test('runHealthCanary: emits 8 results + overallStatus', async () => {
  _resetCountersForTest();
  const tmp = path.join(os.tmpdir(), `mem-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const r = await runHealthCanary({
    memoryPath: tmp,
    memorySnapshot: { symbolWinRates: { a: {} } },
    aiCircuits: { anthropic: { cooldownUntil: 0 } },
    positions: {},
    dataDir: os.tmpdir(),
    restartCountLastHour: 0,
    scope: 'paper',
  });
  assert.equal(r.results.length, 8);
  assert.ok(['PASS', 'WARN', 'FAIL'].includes(r.overallStatus));
  fs.unlinkSync(tmp);
});

test('runHealthCanary: FAIL when one check fails', async () => {
  _resetCountersForTest();
  const r = await runHealthCanary({
    memoryPath: '/does/not/exist/path/memory.json',  // forces FAIL
    aiCircuits: { anthropic: { cooldownUntil: 0 } },
    positions: {},
    restartCountLastHour: 0,
    scope: 'paper',
  });
  assert.equal(r.overallStatus, STATUS.FAIL);
  assert.ok(r.fails >= 1);
});

test('runHealthCanary: gate exception in check does not crash', async () => {
  _resetCountersForTest();
  const r = await runHealthCanary({
    // No data; every check should SKIPPED or PASS, never throw.
    scope: 'paper',
  });
  assert.equal(r.results.length, 8);
});

test('runHealthCanary: Telegram alert fires on FAIL', async () => {
  _resetCountersForTest();
  const sent = [];
  const telegram = { async sendMessage(msg) { sent.push(msg); } };
  await runHealthCanary({
    memoryPath: '/does/not/exist',  // forces FAIL
    aiCircuits: { anthropic: { cooldownUntil: 0 } },
    positions: {},
    restartCountLastHour: 0,
    scope: 'paper',
    telegram,
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Health canary FAIL/);
});

test('runHealthCanary: no Telegram on PASS', async () => {
  _resetCountersForTest();
  const tmp = path.join(os.tmpdir(), `mem-pass-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{}');
  const sent = [];
  const telegram = { async sendMessage(msg) { sent.push(msg); } };
  const r = await runHealthCanary({
    memoryPath: tmp,
    memorySnapshot: { symbolWinRates: {} },
    aiCircuits: { anthropic: { cooldownUntil: 0 } },
    positions: {},
    dataDir: os.tmpdir(),
    restartCountLastHour: 0,
    scope: 'paper',
    telegram,
  });
  if (r.overallStatus === STATUS.PASS || r.overallStatus === STATUS.WARN) {
    assert.equal(sent.length, 0);
  }
  fs.unlinkSync(tmp);
});
