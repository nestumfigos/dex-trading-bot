'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLifecycle } = require('../src/boot/lifecycle');

const silentLogger = { warn() {}, info() {}, debug() {}, error() {} };

function makeStub() {
  const calls = [];
  return {
    calls,
    wsDiscovery: { stop: async () => { calls.push('wsStop'); } },
    telemetry: {
      endRun: async () => { calls.push('telEnd'); },
      flush:  async () => { calls.push('telFlush'); },
    },
    saveState: async () => { calls.push('saveState'); },
  };
}

test('createLifecycle requires logger', () => {
  assert.throws(() => createLifecycle({}), /logger required/);
});

test('shutdownAndExit calls hooks in order then exits', async () => {
  const stub = makeStub();
  const origExit = process.exit;
  let exitCode = null;
  process.exit = (code) => { exitCode = code; };

  try {
    const lifecycle = createLifecycle({
      logger: silentLogger,
      wsDiscovery: stub.wsDiscovery,
      telemetry: stub.telemetry,
      saveState: stub.saveState,
      hookTimeoutMs: 500,
      shutdownTimeoutMs: 2000,
    });
    await lifecycle.shutdownAndExit(0, 'test shutdown');
    assert.deepEqual(stub.calls, ['wsStop', 'telEnd', 'telFlush', 'saveState']);
    assert.equal(exitCode, 0);
  } finally {
    process.exit = origExit;
  }
});

test('shutdownAndExit tolerates failing hook (logs + continues)', async () => {
  const calls = [];
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const lifecycle = createLifecycle({
      logger: silentLogger,
      wsDiscovery: { stop: async () => { throw new Error('ws boom'); } },
      telemetry: { endRun: async () => { calls.push('telEnd'); }, flush: async () => { calls.push('telFlush'); } },
      saveState: async () => { calls.push('saveState'); },
      hookTimeoutMs: 200,
    });
    await lifecycle.shutdownAndExit(0, 'test');
    assert.deepEqual(calls, ['telEnd', 'telFlush', 'saveState'], 'failure in ws should not skip downstream');
  } finally {
    process.exit = origExit;
  }
});

test('shutdownAndExit per-hook timeout', async () => {
  const calls = [];
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const lifecycle = createLifecycle({
      logger: silentLogger,
      wsDiscovery: { stop: () => new Promise((r) => setTimeout(r, 5000)) },
      telemetry: { endRun: async () => { calls.push('telEnd'); }, flush: async () => { calls.push('telFlush'); } },
      saveState: async () => { calls.push('saveState'); },
      hookTimeoutMs: 50,
      shutdownTimeoutMs: 3000,
    });
    await lifecycle.shutdownAndExit(0, 'test');
    assert.deepEqual(calls, ['telEnd', 'telFlush', 'saveState'], 'slow ws timed out, downstream still ran');
  } finally {
    process.exit = origExit;
  }
});

test('shutdownAndExit drains lockManager hooks', async () => {
  const lm = require('../src/state/lock-manager');
  lm.clear();
  const calls = [];
  lm.register('singleton:test', () => { calls.push('lockRelease'); });

  const origExit = process.exit;
  process.exit = () => {};
  try {
    const lifecycle = createLifecycle({
      logger: silentLogger,
      saveState: async () => { calls.push('saveState'); },
      lockManager: lm,
      hookTimeoutMs: 200,
    });
    await lifecycle.shutdownAndExit(0, 'test');
    assert.ok(calls.includes('lockRelease'), 'lock-manager hook must run');
    assert.ok(calls.includes('saveState'));
  } finally {
    process.exit = origExit;
    lm.clear();
  }
});

test('shutdownAndExit second call exits immediately (no double-drain)', async () => {
  const calls = [];
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const lifecycle = createLifecycle({
      logger: silentLogger,
      saveState: async () => { calls.push('saveState'); },
      hookTimeoutMs: 200,
    });
    await lifecycle.shutdownAndExit(0, 'first');
    await lifecycle.shutdownAndExit(0, 'second');
    assert.equal(calls.filter((c) => c === 'saveState').length, 1, 'saveState only once');
  } finally {
    process.exit = origExit;
  }
});

test('isShuttingDown reflects state', async () => {
  const origExit = process.exit;
  process.exit = () => {};
  try {
    const lifecycle = createLifecycle({ logger: silentLogger, saveState: async () => {} });
    assert.equal(lifecycle.isShuttingDown(), false);
    await lifecycle.shutdownAndExit(0, 'test');
    assert.equal(lifecycle.isShuttingDown(), true);
  } finally {
    process.exit = origExit;
  }
});
