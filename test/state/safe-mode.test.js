'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../../src/state/safe-mode');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

test('safe-mode: enter sets portfolio.safeMode=true', async () => {
  const portfolio = {};
  await sm.enter({ reason: 'test', portfolio, logger: silentLogger() });
  assert.equal(portfolio.safeMode, true);
});

test('safe-mode: enter calls stopSchedulers + onPersistError(true)', async () => {
  const portfolio = {};
  const calls = [];
  await sm.enter({
    reason: 'r',
    portfolio,
    logger: silentLogger(),
    stopSchedulers: () => calls.push('stop'),
    onPersistError: (v) => calls.push(`persist=${v}`),
  });
  assert.deepEqual(calls, ['persist=true', 'stop']);
});

test('safe-mode: enter awaits onAlert + onReconcile', async () => {
  const portfolio = {};
  let alertCalled = false;
  let reconCalled = false;
  await sm.enter({
    reason: 'r',
    portfolio,
    logger: silentLogger(),
    onAlert: async () => { alertCalled = true; },
    onReconcile: async () => { reconCalled = true; },
  });
  assert.equal(alertCalled, true);
  assert.equal(reconCalled, true);
});

test('safe-mode: enter swallows alert/reconcile errors (does not crash)', async () => {
  const portfolio = {};
  await sm.enter({
    reason: 'r',
    portfolio,
    logger: silentLogger(),
    onAlert: async () => { throw new Error('alert boom'); },
    onReconcile: async () => { throw new Error('recon boom'); },
  });
  assert.equal(portfolio.safeMode, true); // still set despite errors
});

test('safe-mode: clear resets portfolio.safeMode=false', () => {
  const portfolio = { safeMode: true };
  const result = sm.clear({ portfolio });
  assert.equal(portfolio.safeMode, false);
  assert.equal(result.wasActive, true);
});

test('safe-mode: clear calls onPersistError(false) + onLoopLocks(false)', () => {
  const portfolio = { safeMode: true };
  const calls = [];
  sm.clear({
    portfolio,
    onPersistError: (v) => calls.push(`persist=${v}`),
    onLoopLocks: (v) => calls.push(`locks=${v}`),
  });
  assert.deepEqual(calls, ['persist=false', 'locks=false']);
});

test('safe-mode: clear when not active still completes', () => {
  const portfolio = { safeMode: false };
  const result = sm.clear({ portfolio });
  assert.equal(portfolio.safeMode, false);
  assert.equal(result.wasActive, false);
});

test('safe-mode: isActive reflects portfolio flag', () => {
  assert.equal(sm.isActive({ safeMode: true }), true);
  assert.equal(sm.isActive({ safeMode: false }), false);
  assert.equal(sm.isActive({}), false);
  assert.equal(sm.isActive(null), false);
});

test('safe-mode: enter throws if portfolio missing (regression guard)', async () => {
  await assert.rejects(
    () => sm.enter({ reason: 'r', logger: silentLogger() }),
    /portfolio required/
  );
});

test('safe-mode: clear throws if portfolio missing (regression guard)', () => {
  assert.throws(() => sm.clear({}), /portfolio required/);
});

test('safe-mode: enter→clear→enter sequence (operator recovery flow)', async () => {
  const portfolio = {};
  await sm.enter({ reason: 'first', portfolio, logger: silentLogger() });
  assert.equal(portfolio.safeMode, true);
  sm.clear({ portfolio });
  assert.equal(portfolio.safeMode, false);
  await sm.enter({ reason: 'second', portfolio, logger: silentLogger() });
  assert.equal(portfolio.safeMode, true);
});
