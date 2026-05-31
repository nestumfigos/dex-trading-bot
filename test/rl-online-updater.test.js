'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const RLOnlineUpdater = require('../src/utils/rl-online-updater');

function makeUpdater(config = {}) {
  return new RLOnlineUpdater({
    logger: { debug() {}, warn() {}, info() {} },
    config: { rl: {}, ...config },
  });
}

test('online updater accepts singular symbol and buffers by default', () => {
  const updater = makeUpdater();
  updater.updateFromTrade({
    symbol: 'ABC',
    pnl: 5,
    sizeUsd: 20,
    strategy: 'momentum',
    portfolio: { balance: 100, peakBalance: 100 },
  });
  assert.equal(updater.getStats().experienceCount, 1);
  assert.equal(updater.getStats().stateCount, 0);
  assert.deepEqual(updater.getPendingUpdates()[0].symbols, ['ABC']);
});

test('reward thresholds use fractional returns and penalize drawdown', () => {
  const updater = makeUpdater();
  const noDrawdown = updater.computeReward({
    symbol: 'ABC',
    pnl: 25,
    sizeUsd: 100,
    portfolio: { balance: 1000, peakBalance: 1000 },
  });
  const withDrawdown = updater.computeReward({
    symbol: 'ABC',
    pnl: 25,
    sizeUsd: 100,
    portfolio: { balance: 800, peakBalance: 1000 },
  });
  assert.equal(noDrawdown, 40);
  assert.ok(withDrawdown < noDrawdown);
});

test('zero portfolio balance remains full drawdown', () => {
  const updater = makeUpdater();
  assert.equal(updater.calculateDrawdown({ balance: 0, peakBalance: 100 }), 100);
});
