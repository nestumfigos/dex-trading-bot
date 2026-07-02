'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mc = require('../../src/stats/metrics-compute');

// ── defaultStatsShape ──────────────────────────────────────────────────────

test('defaultStatsShape: returns all expected zeroed fields', () => {
  const s = mc.defaultStatsShape();
  assert.equal(s.closedTrades, 0);
  assert.equal(s.wins, 0);
  assert.equal(s.losses, 0);
  assert.equal(s.profitFactor, 0);
  assert.equal(s.avgSlippageBps, 0);
  assert.equal(s.skippedExitChecks, 0);
});

test('defaultStatsShape: each call returns a fresh object (no mutation leakage)', () => {
  const a = mc.defaultStatsShape();
  a.wins = 99;
  const b = mc.defaultStatsShape();
  assert.equal(b.wins, 0);
});

// ── ensureStatsShape ───────────────────────────────────────────────────────

test('ensureStatsShape: throws on missing portfolio', () => {
  assert.throws(() => mc.ensureStatsShape(null), /portfolio required/);
});

test('ensureStatsShape: fills defaults on empty portfolio', () => {
  const p = {};
  mc.ensureStatsShape(p);
  assert.equal(p.stats.closedTrades, 0);
  assert.ok(p.strategies.momentum);
  assert.equal(p.strategies.swing, undefined);
  assert.deepEqual(p.strategies.momentum.trades, []);
  assert.equal(p.strategies.momentum.stats.wins, 0);
});

test('ensureStatsShape: preserves existing stats fields', () => {
  const p = { stats: { wins: 5, customField: 'keep me' } };
  mc.ensureStatsShape(p);
  assert.equal(p.stats.wins, 5);
  assert.equal(p.stats.customField, 'keep me');
  assert.equal(p.stats.losses, 0); // default added
});

test('ensureStatsShape: routes positions into strategies by position.strategy', () => {
  const p = {
    positions: {
      'kucoin:BTC': { strategy: 'momentum', symbol: 'BTC' },
      'kucoin:ETH': { strategy: 'swing', symbol: 'ETH' },
      'kucoin:SOL': { strategy: undefined, symbol: 'SOL' }, // defaults to momentum
    },
  };
  mc.ensureStatsShape(p);
  assert.ok(p.strategies.momentum.positions['kucoin:BTC']);
  assert.ok(p.strategies.swing.positions['kucoin:ETH']);
  assert.ok(p.strategies.momentum.positions['kucoin:SOL']);
});

// ── refreshPerformanceMetrics ──────────────────────────────────────────────

test('refreshPerformanceMetrics: computes avgWin/avgLoss/expectancy/profitFactor', () => {
  const p = {
    stats: {
      closedTrades: 10,
      wins: 6,
      losses: 4,
      grossProfit: 60,
      grossLoss: 20,
      slippageSamples: 0,
      totalSlippageBps: 0,
    },
  };
  mc.refreshPerformanceMetrics(p);
  assert.equal(p.stats.avgWinUsd, 10);     // 60/6
  assert.equal(p.stats.avgLossUsd, 5);     // 20/4
  // expectancy = (0.6 * 10) - (0.4 * 5) = 6 - 2 = 4
  assert.equal(p.stats.expectancyUsd, 4);
  assert.equal(p.stats.profitFactor, 3);   // 60/20
});

test('refreshPerformanceMetrics: profitFactor null when wins but no losses', () => {
  const p = { stats: { closedTrades: 3, wins: 3, losses: 0, grossProfit: 30, grossLoss: 0 } };
  mc.refreshPerformanceMetrics(p);
  assert.equal(p.stats.profitFactor, null);
});

test('refreshPerformanceMetrics: profitFactor 0 when no closed trades', () => {
  const p = { stats: { closedTrades: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0 } };
  mc.refreshPerformanceMetrics(p);
  assert.equal(p.stats.profitFactor, 0);
});

test('refreshPerformanceMetrics: avgSlippageBps computed from samples', () => {
  const p = { stats: { closedTrades: 5, wins: 3, losses: 2, grossProfit: 30, grossLoss: 10, slippageSamples: 4, totalSlippageBps: 80 } };
  mc.refreshPerformanceMetrics(p);
  assert.equal(p.stats.avgSlippageBps, 20); // 80/4
});

test('refreshPerformanceMetrics: per-strategy stats computed independently', () => {
  const p = {
    strategies: {
      // Use implemented strategy names — ensureStatsShape() prunes removed
      // strategies (e.g. legacy 'swing', stage:'removed') that have no open
      // position, so a bare removed-strategy entry would be deleted before
      // refreshPerformanceMetrics computes its stats.
      momentum: { stats: { closedTrades: 2, wins: 2, losses: 0, grossProfit: 20, grossLoss: 0 }, trades: [] },
      backes:   { stats: { closedTrades: 4, wins: 1, losses: 3, grossProfit: 5,  grossLoss: 15 }, trades: [] },
    },
  };
  mc.refreshPerformanceMetrics(p);
  assert.equal(p.strategies.momentum.stats.avgWinUsd, 10);
  assert.equal(p.strategies.backes.stats.avgWinUsd, 5);
  assert.equal(p.strategies.backes.stats.profitFactor, 5 / 15);
});

// ── recordPortfolioSnapshot ────────────────────────────────────────────────

test('recordPortfolioSnapshot: appends point with timestamp + getSnapshot data', () => {
  const p = {};
  const snap = { cashBalance: 100, equity: 150, totalPnl: 50, unrealizedPnl: 10 };
  const point = mc.recordPortfolioSnapshot({
    portfolio: p,
    getSnapshot: () => snap,
    reason: 'test_reason',
  });
  assert.equal(point.cash, 100);
  assert.equal(point.equity, 150);
  assert.equal(point.totalPnl, 50);
  assert.equal(point.reason, 'test_reason');
  assert.equal(p.pnlHistory.length, 1);
  assert.ok(!isNaN(Date.parse(point.timestamp)));
});

test('recordPortfolioSnapshot: caps history at maxHistory (default 240)', () => {
  const p = { pnlHistory: Array.from({ length: 240 }, (_, i) => ({ timestamp: `t${i}` })) };
  const getSnapshot = () => ({ cashBalance: 0, equity: 0, totalPnl: 0, unrealizedPnl: 0 });
  mc.recordPortfolioSnapshot({ portfolio: p, getSnapshot, reason: 'new' });
  assert.equal(p.pnlHistory.length, 240); // oldest shifted
  assert.equal(p.pnlHistory[239].reason, 'new');
  assert.equal(p.pnlHistory[0].timestamp, 't1'); // t0 dropped
});

test('recordPortfolioSnapshot: telemetry.logPnlPoint called when provided', () => {
  const calls = [];
  mc.recordPortfolioSnapshot({
    portfolio: {},
    getSnapshot: () => ({ cashBalance: 0, equity: 0, totalPnl: 0, unrealizedPnl: 0 }),
    telemetry: { logPnlPoint: (pt) => calls.push(pt) },
    reason: 'r',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'r');
});

test('recordPortfolioSnapshot: telemetry.logPortfolioExposureSnapshot called for open positions', () => {
  const pnlCalls = [];
  const exposureCalls = [];
  mc.recordPortfolioSnapshot({
    portfolio: {},
    getSnapshot: () => ({
      cashBalance: 500,
      equity: 650,
      totalPnl: 10,
      unrealizedPnl: 5,
      positions: [
        {
          symbol: 'ABC',
          chain: 'KuCoin',
          chainKey: 'kucoin',
          strategy: 'spot_day_bull_flag',
          quantity: 10,
          entryPrice: 10,
          currentPrice: 12,
          stopLoss: 9,
          takeProfit: 15,
          costBasisUsd: 100,
          positionValueUsd: 120,
          unrealizedPnl: 19,
          unrealizedPnlPct: 19,
        },
      ],
    }),
    telemetry: {
      logPnlPoint: (pt) => pnlCalls.push(pt),
      logPortfolioExposureSnapshot: (row) => exposureCalls.push(row),
    },
    reason: 'scan_spot_day_bull_flag',
  });

  assert.equal(pnlCalls.length, 1);
  assert.equal(exposureCalls.length, 1);
  assert.equal(exposureCalls[0].symbol, 'ABC');
  assert.equal(exposureCalls[0].strategy, 'spot_day_bull_flag');
  assert.equal(exposureCalls[0].exposureUsd, 120);
  assert.equal(exposureCalls[0].notionalUsd, 100);
  assert.equal(exposureCalls[0].riskUsd, 10);
  assert.equal(exposureCalls[0].correlationBucket, 'kucoin');
  assert.equal(exposureCalls[0].details.reason, 'scan_spot_day_bull_flag');
});

test('buildCorrelationSnapshotRows: computes pairwise correlations from price histories', () => {
  const rows = mc.buildCorrelationSnapshotRows({
    timestamp: '2026-06-06T12:00:00.000Z',
    reason: 'scan',
    minBars: 4,
    lookbackBars: 6,
    snapshot: {
      positions: [
        { symbol: 'AAA', chainKey: 'kucoin', address: 'AAA', strategy: 'momentum' },
        { symbol: 'BBB', chainKey: 'kucoin', address: 'BBB', strategy: 'spot_day_bull_flag' },
      ],
    },
    priceHistories: {
      'kucoin:aaa': [10, 11, 12, 13, 14, 15],
      'kucoin:bbb': [20, 22, 24, 26, 28, 30],
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].assetA, 'AAA');
  assert.equal(rows[0].assetB, 'BBB');
  assert.ok(rows[0].correlation > 0.99);
  assert.equal(rows[0].source, 'strategy.priceHistory');
  assert.equal(rows[0].details.leftHistoryKey, 'kucoin:aaa');
});

test('recordPortfolioSnapshot: telemetry.logCorrelationSnapshot called only with enough history', () => {
  const correlationCalls = [];
  mc.recordPortfolioSnapshot({
    portfolio: {},
    getSnapshot: () => ({
      cashBalance: 500,
      equity: 650,
      totalPnl: 10,
      unrealizedPnl: 5,
      positions: [
        { symbol: 'AAA', chainKey: 'kucoin', address: 'AAA', strategy: 'momentum' },
        { symbol: 'BBB', chainKey: 'kucoin', address: 'BBB', strategy: 'momentum' },
        { symbol: 'SHORT', chainKey: 'kucoin', address: 'SHORT', strategy: 'momentum' },
      ],
    }),
    telemetry: {
      logCorrelationSnapshot: (row) => correlationCalls.push(row),
    },
    priceHistories: {
      'kucoin:aaa': [10, 11, 12, 13, 14],
      'kucoin:bbb': [30, 31, 33, 34, 36],
      'kucoin:short': [1, 2],
    },
    correlationMinBars: 4,
    correlationLookbackBars: 5,
    reason: 'scan',
  });

  assert.equal(correlationCalls.length, 1);
  assert.equal(correlationCalls[0].assetA, 'AAA');
  assert.equal(correlationCalls[0].assetB, 'BBB');
});

test('recordPortfolioSnapshot: throws on missing portfolio', () => {
  assert.throws(() => mc.recordPortfolioSnapshot({ getSnapshot: () => ({}) }), /portfolio required/);
});

test('recordPortfolioSnapshot: throws on missing getSnapshot', () => {
  assert.throws(() => mc.recordPortfolioSnapshot({ portfolio: {} }), /getSnapshot required/);
});

test('recordPortfolioSnapshot: maxHistory configurable', () => {
  const p = { pnlHistory: [{ timestamp: 'x' }] };
  mc.recordPortfolioSnapshot({
    portfolio: p,
    getSnapshot: () => ({ cashBalance: 0, equity: 0, totalPnl: 0, unrealizedPnl: 0 }),
    reason: 'r',
    maxHistory: 1,
  });
  assert.equal(p.pnlHistory.length, 1);
  assert.equal(p.pnlHistory[0].reason, 'r'); // 'x' got shifted out
});
