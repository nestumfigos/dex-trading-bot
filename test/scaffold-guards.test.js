'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Verify every scaffold module throws NotImplementedError when called.
// This is the safety net — if any module ships working code by accident,
// these tests fail and the operator is forced to update the test before
// flipping to production.

const STUB_MODULES = [
  '../src/exchanges/binance-perps.js',
  '../src/strategies/perps-anchors.js',
  '../src/strategies/perps-range-detector.js',
  '../src/strategies/perps-deviation-reclaim.js',
  '../src/strategies/perps-mss-detector.js',
  '../src/strategies/perps-l2l-detector.js',
  '../src/strategies/perps-sizing.js',
  '../src/risk/perps-gates.js',
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
