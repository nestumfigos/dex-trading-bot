'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Live venue execution stays guarded while paper-only strategy modules run.

const STUB_MODULES = [
  '../src/exchanges/binance-perps.js',
];

for (const modPath of STUB_MODULES) {
  test(`scaffold guard: ${modPath} throws NotImplementedError`, () => {
    const mod = require(modPath);
    // Any method call must throw.
    assert.throws(() => mod.someArbitraryMethod(), /PERPS:.+ is not implemented/);
    assert.throws(() => mod.placeOrder(), /PERPS:.+ is not implemented/);
  });
}

test('_not-implemented exports guard + NotImplementedError class', () => {
  const { NotImplementedError, guard } = require('../src/_not-implemented');
  assert.equal(typeof NotImplementedError, 'function');
  assert.equal(typeof guard, 'function');
  const g = guard('test/x');
  assert.throws(() => g.foo(), NotImplementedError);
});
