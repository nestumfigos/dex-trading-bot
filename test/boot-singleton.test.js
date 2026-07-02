'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const { acquireRuntimeSingleton, classifyProcessProbe } = require('../src/boot/singleton');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'singleton-test-'));
}

function waitForFile(filePath, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return false;
}

function waitForProcessExit(child, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try {
      process.kill(child.pid, 0);
    } catch (_) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

test('acquireRuntimeSingleton writes lock with current pid', () => {
  const dir = mkTmpDir();
  try {
    const { release, lockPath, pid } = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'test',
      port: 19999,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.ok(fs.existsSync(lockPath));
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(payload.pid, pid);
    assert.equal(payload.profile, 'test');
    assert.equal(payload.port, 19999);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('takeover when prior pid is dead (sibling died)', () => {
  const dir = mkTmpDir();
  try {
    const lockPath = path.join(dir, 'runtime-test-29999.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, profile: 'test', port: 29999, startedAt: new Date().toISOString() }));

    const { lockPath: gotPath, pid } = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'test',
      port: 29999,
      graceMs: 50,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.equal(gotPath, lockPath);
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(payload.pid, pid, 'should have taken over with our pid');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('integration: child process exits 0 when sibling holds lock', () => {
  const dir = mkTmpDir();
  const port = 39999;
  try {
    // First process acquires
    const { release } = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'test',
      port,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    // Second tries — should exit(0) since we (parent) are alive
    const childScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'boot', 'singleton.js'))});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'test',
        port: ${port},
        graceMs: 50,
        logger: { warn() {}, info() {}, debug() {}, error() {} },
      });
      // If we reach here, we wrongly acquired. Exit 1.
      process.exit(1);
    `;
    const res = spawnSync(process.execPath, ['-e', childScript], { timeout: 15000 });
    assert.equal(res.status, 0, `child should exit 0 (duplicate-spawn clean exit), got ${res.status}`);
    release();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('pm2 replacement can take over stale same-port paper holder without respawn loop', () => {
  const dir = mkTmpDir();
  const port = 40003;
  const profileLock = path.join(dir, 'runtime-paper.lock');
  const portLock = path.join(dir, `runtime-paper-${port}.lock`);
  const singletonPath = path.resolve(__dirname, '..', 'src', 'boot', 'singleton.js');
  let holder;
  try {
    const holderScript = `
      const fs = require('fs');
      const stalePayload = JSON.stringify({
        pid: process.pid,
        profile: 'paper',
        port: ${port},
        startedAt: new Date(Date.now() - 600000).toISOString()
      });
      fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(profileLock)}, stalePayload);
      fs.writeFileSync(${JSON.stringify(portLock)}, stalePayload);
      setInterval(() => {}, 1000);
    `;
    holder = spawn(process.execPath, ['-e', holderScript], { stdio: 'ignore' });
    assert.equal(waitForFile(profileLock), true, 'holder lock should be created');

    const replacementScript = `
      const fs = require('fs');
      const { acquireRuntimeSingleton } = require(${JSON.stringify(singletonPath)});
      const acquired = acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper',
        port: ${port},
        graceMs: 10,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      const payload = JSON.parse(fs.readFileSync(acquired.profileLockPath, 'utf8'));
      if (payload.pid !== process.pid) process.exit(88);
      acquired.release();
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ['-e', replacementScript], {
      timeout: 10000,
      env: {
        ...process.env,
        pm_id: '2',
        PM2_SINGLETON_REPLACE_AFTER_MS: '100',
        PM2_SINGLETON_SIGTERM_GRACE_MS: '100',
        PM2_SINGLETON_POLL_MS: '50',
      },
    });
    assert.equal(res.status, 0, `replacement should acquire and exit cleanly, stderr=${res.stderr}`);
  } finally {
    if (holder && !holder.killed) {
      try { holder.kill('SIGKILL'); } catch (_) {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('pm2 replacement can take over a healthy same-port holder after grace', () => {
  const dir = mkTmpDir();
  const port = 40004;
  const profileLock = path.join(dir, 'runtime-paper.lock');
  const singletonPath = path.resolve(__dirname, '..', 'src', 'boot', 'singleton.js');
  let holder;
  try {
    const holderScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(singletonPath)});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper',
        port: ${port},
        graceMs: 10,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      setInterval(() => {}, 1000);
    `;
    holder = spawn(process.execPath, ['-e', holderScript], {
      stdio: 'ignore',
      env: { ...process.env, SINGLETON_HEARTBEAT_INTERVAL_MS: '50' },
    });
    assert.equal(waitForFile(profileLock), true, 'holder lock should be created');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);

    const replacementScript = `
      const fs = require('fs');
      const { acquireRuntimeSingleton } = require(${JSON.stringify(singletonPath)});
      const acquired = acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper',
        port: ${port},
        graceMs: 10,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      const payload = JSON.parse(fs.readFileSync(acquired.profileLockPath, 'utf8'));
      if (payload.pid !== process.pid) process.exit(88);
      acquired.release();
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ['-e', replacementScript], {
      timeout: 15000,
      env: {
        ...process.env,
        pm_id: '2',
        PM2_MIN_UPTIME_MS: '1',
        PM2_SINGLETON_REPLACE_AFTER_MS: '100',
        PM2_SINGLETON_STALE_HEARTBEAT_MS: '5000',
        PM2_SINGLETON_SIGTERM_GRACE_MS: '100',
        PM2_SINGLETON_POLL_MS: '50',
      },
    });
    assert.equal(res.status, 0, `replacement should acquire cleanly, stderr=${res.stderr}`);
    assert.equal(waitForProcessExit(holder), true, 'previous holder should have been terminated');
    assert.equal(fs.existsSync(profileLock), false, 'replacement release should remove profile lock');
  } finally {
    if (holder && !holder.killed) {
      try { holder.kill('SIGKILL'); } catch (_) {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('duplicate port lock releases profile lock acquired earlier', () => {
  const dir = mkTmpDir();
  const port = 40005;
  const profileLock = path.join(dir, 'runtime-paper.lock');
  const portLock = path.join(dir, `runtime-paper-${port}.lock`);
  const singletonPath = path.resolve(__dirname, '..', 'src', 'boot', 'singleton.js');
  try {
    fs.writeFileSync(portLock, JSON.stringify({
      pid: process.pid,
      profile: 'paper',
      port,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));

    const childScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(singletonPath)});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper',
        port: ${port},
        graceMs: 10,
        logger: { warn(){}, info(){}, debug(){}, error(){} },
      });
      process.exit(88);
    `;
    const res = spawnSync(process.execPath, ['-e', childScript], { timeout: 10000 });
    assert.equal(res.status, 0, `duplicate child should exit cleanly, stderr=${res.stderr}`);
    assert.equal(fs.existsSync(profileLock), false, 'child must release profile lock before duplicate exit');
    const payload = JSON.parse(fs.readFileSync(portLock, 'utf8'));
    assert.equal(payload.pid, process.pid, 'original port lock remains untouched');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('rejects when required deps missing', () => {
  assert.throws(() => acquireRuntimeSingleton({}), /dataDirAbs/);
  assert.throws(() => acquireRuntimeSingleton({ dataDirAbs: '/tmp' }), /profile/);
  assert.throws(() => acquireRuntimeSingleton({ dataDirAbs: '/tmp', profile: 'x' }), /port/);
});

test('profile-lock blocks cross-port duplicate (2026-05-17 regression: paper@3001 + paper@3003)', () => {
  const dir = mkTmpDir();
  try {
    // First process: paper on port 3001
    const first = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'paper',
      port: 3001,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.ok(fs.existsSync(first.profileLockPath), 'profile lockfile created');
    assert.ok(fs.existsSync(first.lockPath),        'port lockfile created');

    // Second process: SAME profile, DIFFERENT port. Should exit(0) because
    // profile lock is held by living pid (this process).
    const childScript = `
      const { acquireRuntimeSingleton } = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'boot', 'singleton.js'))});
      acquireRuntimeSingleton({
        dataDirAbs: ${JSON.stringify(dir)},
        profile: 'paper',
        port: 3003,
        graceMs: 50,
        logger: { warn() {}, info() {}, debug() {}, error() {} },
      });
      process.exit(1); // reaching here = bug (we wrongly acquired)
    `;
    const res = spawnSync(process.execPath, ['-e', childScript], { timeout: 15000 });
    assert.equal(res.status, 0, `cross-port same-profile must exit 0 cleanly, got ${res.status}`);

    // Verify port-3003 lockfile was NOT created (we exited before reaching it)
    const port3003Lock = path.join(dir, 'runtime-paper-3003.lock');
    assert.equal(fs.existsSync(port3003Lock), false, 'port-3003 lock must not exist');

    first.release();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('release() removes BOTH profile lock and port lock', () => {
  const dir = mkTmpDir();
  try {
    const { release, lockPath, profileLockPath } = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'test',
      port: 49999,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.ok(fs.existsSync(profileLockPath), 'profile lock created');
    assert.ok(fs.existsSync(lockPath),        'port lock created');
    release();
    assert.equal(fs.existsSync(profileLockPath), false, 'profile lock removed');
    assert.equal(fs.existsSync(lockPath),        false, 'port lock removed');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('takeover applies to profile lock too (dead pid on profile lock)', () => {
  const dir = mkTmpDir();
  try {
    const profileLock = path.join(dir, 'runtime-test.lock');
    fs.writeFileSync(profileLock, JSON.stringify({ pid: 999999, profile: 'test', port: 59999, startedAt: new Date().toISOString() }));
    const { profileLockPath, pid } = acquireRuntimeSingleton({
      dataDirAbs: dir,
      profile: 'test',
      port: 59999,
      graceMs: 50,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.equal(profileLockPath, profileLock);
    const payload = JSON.parse(fs.readFileSync(profileLock, 'utf8'));
    assert.equal(payload.pid, pid, 'should have taken over profile lock with our pid');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

// PID-reuse staleness (2026-05-30): a dead bot's pid was recycled by Windows to
// msedgewebview2.exe; the old process.kill(pid,0) check read it as a live
// sibling and locked the whole fleet out. classifyProcessProbe distinguishes a
// real node process from a recycled-pid stranger.
test('classifyProcessProbe: win tasklist node.exe row => live bot (true)', () => {
  assert.equal(classifyProcessProbe('win32', '"node.exe","1234","Console","1","120,000 K"'), true);
});

test('classifyProcessProbe: win recycled-pid stranger (Edge) => stale (false)', () => {
  assert.equal(classifyProcessProbe('win32', '"msedgewebview2.exe","14392","Console","1","80,000 K"'), false);
});

test('classifyProcessProbe: win tasklist no-match => undetermined (null)', () => {
  assert.equal(classifyProcessProbe('win32', 'INFO: No tasks are running which match the specified criteria.'), null);
});

test('classifyProcessProbe: unix ps node => true, stranger => false, empty => null', () => {
  assert.equal(classifyProcessProbe('linux', 'node\n'), true);
  assert.equal(classifyProcessProbe('linux', 'msedgewebview2\n'), false);
  assert.equal(classifyProcessProbe('linux', '   '), null);
});
