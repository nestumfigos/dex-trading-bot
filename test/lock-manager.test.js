'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lm = require('../src/state/lock-manager');

const silentLogger = { warn() {}, info() {}, debug() {}, error() {} };

test('register + drain runs hooks in order', async () => {
  lm.clear();
  const order = [];
  lm.register('a', () => { order.push('a'); });
  lm.register('b', async () => { order.push('b'); });
  await lm.drain({ logger: silentLogger });
  assert.deepEqual(order, ['a', 'b']);
});

test('drain continues past hook failure', async () => {
  lm.clear();
  const order = [];
  lm.register('throws', () => { throw new Error('boom'); });
  lm.register('ok', () => { order.push('ok'); });
  await lm.drain({ logger: silentLogger });
  assert.deepEqual(order, ['ok']);
});

test('drain enforces per-hook timeout', async () => {
  lm.clear();
  const order = [];
  lm.register('slow', () => new Promise((r) => setTimeout(r, 1000)));
  lm.register('after', () => { order.push('after'); });
  await lm.drain({ logger: silentLogger, timeoutMs: 50 });
  assert.deepEqual(order, ['after'], 'slow hook timed out, after still ran');
});

test('list returns names', () => {
  lm.clear();
  lm.register('one', () => {});
  lm.register('two', () => {});
  assert.deepEqual(lm.list(), ['one', 'two']);
  lm.clear();
});
