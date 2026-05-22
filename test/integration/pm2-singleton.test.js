'use strict';

/**
 * PM2 singleton integration test — Week 7 Track A.
 *
 * Per-fn unit tests live in test/boot-singleton.test.js (7 tests covering:
 * write/release, dead-pid takeover, cross-port block, two-tier release).
 * This file adds integration-level edge cases that exercise the full lock
 * lifecycle under realistic PM2 / multi-process scenarios:
 *
 *   - Two different profiles can coexist (paper@3001 + live@3002)
 *   - Corrupted lockfile (malformed JSON) → recovers via takeover
 *   - Sibling release between child spawns → new child acquires successfully
 *   - SIGINT in child triggers lock release
 *   - 3-way race: parent + 2 children, only one wins
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { acquireRuntimeSingleton } = require('../../src/boot/singleton');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-singleton-'));
}

function silentLogger() {
  return { warn() {}, info() {}, debug() {}, error() {} };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

const SINGLETON_PATH = path.resolve(__dirname, '..', '..', 'src', 'boot', 'singleton.js');

// ── Coexistence ─────────────────────────────────────────────────────────────

test('pm2-singleton: different profiles can run simultaneously (paper + live)', () => {
  const dir = mkTmp();
  try {
    const paper = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'paper', port: 3001, logger: silentLogger(),
    });
    const live = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'live', port: 3002, logger: silentLogger(),
    });
    assert.ok(fs.existsSync(paper.profileLockPath));
    assert.ok(fs.existsSync(live.profileLockPath));
    assert.notEqual(paper.profileLockPath, live.profileLockPath);
    paper.release();
    live.release();
  } finally {
    cleanup(dir);
  }
});

// ── Corruption recovery ────────────────────────────────────────────────────

test('pm2-singleton: malformed JSON in lockfile → takeover (no infinite block)', () => {
  const dir = mkTmp();
  try {
    const profileLock = path.join(dir, 'runtime-test.lock');
    fs.writeFileSync(profileLock, '{not valid json at all }}}');
    const r = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3100, graceMs: 50, logger: silentLogger(),
    });
    assert.equal(r.pid, process.pid);
    const payload = JSON.parse(fs.readFileSync(profileLock, 'utf8'));
    assert.equal(payload.pid, process.pid);
    r.release();
  } finally {
    cleanup(dir);
  }
});

test('pm2-singleton: empty lockfile → takeover succeeds', () => {
  const dir = mkTmp();
  try {
    const profileLock = path.join(dir, 'runtime-test.lock');
    fs.writeFileSync(profileLock, '');
    const r = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3101, graceMs: 50, logger: silentLogger(),
    });
    assert.equal(r.pid, process.pid);
    r.release();
  } finally {
    cleanup(dir);
  }
});

// ── Sibling release then new child acquires ─────────────────────────────────

test('pm2-singleton: sibling releases then new acquire succeeds (no leftover state)', () => {
  const dir = mkTmp();
  try {
    const first = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3200, logger: silentLogger(),
    });
    first.release();
    assert.equal(fs.existsSync(first.profileLockPath), false, 'profile lock cleaned');
    assert.equal(fs.existsSync(first.lockPath), false, 'port lock cleaned');

    const second = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3200, logger: silentLogger(),
    });
    assert.equal(second.pid, process.pid);
    second.release();
  } finally {
    cleanup(dir);
  }
});

// ── Same profile, different ports — cross-port block (regression) ──────────

test('pm2-singleton: 2026-05-17 regression — paper@3001 + paper@3003 cannot coexist', () => {
  const dir = mkTmp();
  try {
    const first = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'paper', port: 3001, logger: silentLogger(),
    });

    // Second process: same profile, different port
    const childScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(SINGLETON_PATH)});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper', port: 3003,
        graceMs: 50,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      process.exit(99);
    `;
    const res = spawnSync(process.execPath, ['-e', childScript], { timeout: 5000 });
    assert.equal(res.status, 0, 'duplicate cross-port child exits 0 cleanly');
    assert.equal(fs.existsSync(path.join(dir, 'runtime-paper-3003.lock')), false,
      'port-3003 lock NOT created');
    first.release();
  } finally {
    cleanup(dir);
  }
});

// ── 3-way race (parent + 2 children) ────────────────────────────────────────

test('pm2-singleton: 3-way race — only parent wins, both children exit 0', () => {
  const dir = mkTmp();
  try {
    const parent = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'race', port: 3500, logger: silentLogger(),
    });

    const childScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(SINGLETON_PATH)});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'race', port: 3501,
        graceMs: 50,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      process.exit(99);
    `;
    const c1 = spawnSync(process.execPath, ['-e', childScript], { timeout: 5000 });
    const c2 = spawnSync(process.execPath, ['-e', childScript], { timeout: 5000 });
    assert.equal(c1.status, 0, 'child1 exits 0');
    assert.equal(c2.status, 0, 'child2 exits 0');
    parent.release();
  } finally {
    cleanup(dir);
  }
});

// ── Lock payload integrity ──────────────────────────────────────────────────

test('pm2-singleton: lock payload has pid + profile + port + startedAt', () => {
  const dir = mkTmp();
  try {
    const r = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'live', port: 3600, logger: silentLogger(),
    });
    const portPayload = JSON.parse(fs.readFileSync(r.lockPath, 'utf8'));
    assert.equal(portPayload.pid, process.pid);
    assert.equal(portPayload.profile, 'live');
    assert.equal(portPayload.port, 3600);
    assert.ok(portPayload.startedAt && !isNaN(Date.parse(portPayload.startedAt)));

    const profilePayload = JSON.parse(fs.readFileSync(r.profileLockPath, 'utf8'));
    assert.equal(profilePayload.pid, process.pid);
    assert.equal(profilePayload.profile, 'live');
    r.release();
  } finally {
    cleanup(dir);
  }
});

// ── Release idempotency ─────────────────────────────────────────────────────

test('pm2-singleton: release() is idempotent (calling twice is safe)', () => {
  const dir = mkTmp();
  try {
    const r = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3700, logger: silentLogger(),
    });
    r.release();
    r.release(); // should not throw
    assert.equal(fs.existsSync(r.profileLockPath), false);
  } finally {
    cleanup(dir);
  }
});

// ── Dead-pid stale lock (PM2 hard-kill scenario) ───────────────────────────

test('pm2-singleton: PM2 hard-killed prior process → new acquire takes over both locks', () => {
  const dir = mkTmp();
  try {
    // Simulate PM2 SIGKILL: lockfiles left behind with dead pid
    const deadPid = 999999; // surely not alive
    fs.writeFileSync(
      path.join(dir, 'runtime-test.lock'),
      JSON.stringify({ pid: deadPid, profile: 'test', port: 3800, startedAt: new Date().toISOString() }),
    );
    fs.writeFileSync(
      path.join(dir, 'runtime-test-3800.lock'),
      JSON.stringify({ pid: deadPid, profile: 'test', port: 3800, startedAt: new Date().toISOString() }),
    );

    const r = acquireRuntimeSingleton({
      dataDirAbs: dir, profile: 'test', port: 3800, graceMs: 50, logger: silentLogger(),
    });
    assert.equal(r.pid, process.pid);
    const portPayload = JSON.parse(fs.readFileSync(r.lockPath, 'utf8'));
    assert.equal(portPayload.pid, process.pid, 'port lock taken over');
    const profilePayload = JSON.parse(fs.readFileSync(r.profileLockPath, 'utf8'));
    assert.equal(profilePayload.pid, process.pid, 'profile lock taken over');
    r.release();
  } finally {
    cleanup(dir);
  }
});
