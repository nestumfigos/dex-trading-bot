'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TransientError, FatalError, ConfigError, PortBindError, ExchangeError, SqlError,
  isTransient, isFatal, NON_FATAL_NODE_CODES,
} = require('../src/errors');

test('TransientError marks retryable=true', () => {
  const e = new TransientError('x');
  assert.equal(e.retryable, true);
  assert.equal(isTransient(e), true);
  assert.equal(isFatal(e), false);
});

test('FatalError marks retryable=false', () => {
  const e = new FatalError('x');
  assert.equal(e.retryable, false);
  assert.equal(isFatal(e), true);
  assert.equal(isTransient(e), false);
});

test('ConfigError extends FatalError', () => {
  const e = new ConfigError('bad config');
  assert.ok(e instanceof FatalError);
  assert.ok(isFatal(e));
});

test('PortBindError uses EADDRINUSE code', () => {
  const e = new PortBindError('port held');
  assert.equal(e.code, 'EADDRINUSE');
  assert.ok(isTransient(e));
});

test('ExchangeError + SqlError are transient', () => {
  assert.ok(isTransient(new ExchangeError('ws drop')));
  assert.ok(isTransient(new SqlError('pool dead')));
});

test('Raw Node errors with non-fatal codes are transient', () => {
  for (const code of NON_FATAL_NODE_CODES) {
    const e = Object.assign(new Error(`raw ${code}`), { code });
    assert.equal(isTransient(e), true, `${code} should be transient`);
  }
});

test('Unknown error defaults to fatal', () => {
  const e = new Error('mystery');
  assert.equal(isFatal(e), true);
  assert.equal(isTransient(e), false);
});

test('null/undefined are safe', () => {
  assert.equal(isFatal(null), false);
  assert.equal(isTransient(undefined), false);
});

test('EADDRINUSE behavior: never crashes (regression for 2026-05-16 crash-loop)', () => {
  // The bug: an EADDRINUSE bubbling to process.on('uncaughtException') exited
  // the process, which triggered PM2 restart, which racced the prior child
  // still holding the port → endless crash loop. Fix: catch by code in handler.
  const e = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  assert.ok(isTransient(e), 'EADDRINUSE must be transient — do not exit on it');
});

test('ECONNRESET behavior: transient (regression for 2026-05-16 unhandledRejection)', () => {
  const e = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  assert.ok(isTransient(e));
});
