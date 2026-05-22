'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPortfolio } = require('../../src/state/portfolio');
const { getImplementedStrategyNames } = require('../../src/strategies/deployment');

test('createPortfolio: empty config returns shape with zero balance', () => {
  const p = createPortfolio({});
  assert.equal(p.startingBalance, 0);
  assert.equal(p.balance, 0);
  assert.equal(p.walletBalanceUsd, null);
  assert.deepEqual(p.walletBalancesUsd, { solana: null, bsc: null, base: null, kucoin: null });
});

test('createPortfolio: paperTrading=true seeds balance from paperBalance', () => {
  const p = createPortfolio({ paperTrading: true, paperBalance: 1000 });
  assert.equal(p.startingBalance, 1000);
  assert.equal(p.balance, 1000);
});

test('createPortfolio: paperTrading=false ignores paperBalance', () => {
  const p = createPortfolio({ paperTrading: false, paperBalance: 1000 });
  assert.equal(p.startingBalance, 0);
  assert.equal(p.balance, 0);
});

test('createPortfolio: paperTrading=true with NaN paperBalance defaults to 0', () => {
  const p = createPortfolio({ paperTrading: true, paperBalance: undefined });
  assert.equal(p.startingBalance, 0);
});

test('createPortfolio: includes safe-mode + persistence flags', () => {
  const p = createPortfolio({});
  assert.equal(p.statePersistenceError, false);
  assert.equal(p.safeMode, false);
  assert.equal(p.saveFailureCount, 0);
});

test('createPortfolio: stateReconciliation shape correct', () => {
  const p = createPortfolio({});
  assert.equal(p.stateReconciliation.lastRunAt, null);
  assert.deepEqual(p.stateReconciliation.discrepancies, []);
});

test('createPortfolio: balanceDrift initialized + halt false', () => {
  const p = createPortfolio({});
  assert.deepEqual(p.balanceDrift, { amountUsd: 0, pct: 0 });
  assert.equal(p.balanceDriftHalt, false);
});

test('createPortfolio: executionJournal + positions + trades empty', () => {
  const p = createPortfolio({});
  assert.deepEqual(p.executionJournal, {});
  assert.deepEqual(p.positions, {});
  assert.deepEqual(p.trades, []);
});

test('createPortfolio: per-strategy sub-objects for runtime strategies', () => {
  const p = createPortfolio({});
  for (const s of getImplementedStrategyNames()) {
    assert.ok(p.strategies[s]);
    assert.deepEqual(p.strategies[s].positions, {});
    assert.deepEqual(p.strategies[s].trades, []);
    assert.equal(p.strategies[s].stats.wins, 0);
    assert.equal(p.strategies[s].stats.losses, 0);
    assert.equal(p.strategies[s].stats.totalPnl, 0);
  }
});

test('createPortfolio: aggregate stats present + zeroed', () => {
  const p = createPortfolio({});
  assert.equal(p.stats.wins, 0);
  assert.equal(p.stats.losses, 0);
  assert.equal(p.stats.profitFactor, 0);
  assert.equal(p.stats.expectancyUsd, 0);
});

test('createPortfolio: learning sub-object present', () => {
  const p = createPortfolio({});
  assert.deepEqual(p.learning.badTokenMemory, {});
  assert.deepEqual(p.learning.sleevePerformance, {});
});

test('createPortfolio: pnlHistory empty array', () => {
  const p = createPortfolio({});
  assert.deepEqual(p.pnlHistory, []);
});

test('createPortfolio: each call returns fresh object (no mutation leakage)', () => {
  const a = createPortfolio({});
  const b = createPortfolio({});
  a.balance = 999;
  a.positions['test'] = { foo: 'bar' };
  a.trades.push({ tx: 1 });
  a.strategies.momentum.stats.wins = 5;
  assert.equal(b.balance, 0);
  assert.deepEqual(b.positions, {});
  assert.deepEqual(b.trades, []);
  assert.equal(b.strategies.momentum.stats.wins, 0);
});

test('createPortfolio: stats shape matches metrics-compute.defaultStatsShape', () => {
  const p = createPortfolio({});
  const { defaultStatsShape } = require('../../src/stats/metrics-compute');
  const baseline = defaultStatsShape();
  assert.deepEqual(Object.keys(p.stats).sort(), Object.keys(baseline).sort());
  for (const strategyName of getImplementedStrategyNames()) {
    assert.deepEqual(Object.keys(p.strategies[strategyName].stats).sort(), Object.keys(baseline).sort());
  }
});
