'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBullFlagEvaluator } = require('../src/strategies/bull-flag-evaluator');
const { detectBullFlag } = require('../src/strategies/bull-flag-detector');

function c(close, volume, { open, high, low } = {}) {
  return {
    open: open ?? close,
    high: high ?? Math.max(close, open ?? close) * 1.002,
    low: low ?? Math.min(close, open ?? close) * 0.998,
    close,
    volume,
  };
}

function validCandles() {
  return [
    c(100, 1000),
    c(100.5, 1000),
    c(103, 2200, { open: 100.6, high: 103.5, low: 100.6 }),
    c(106, 2400, { open: 103, high: 106.5, low: 103 }),
    c(108, 2600, { open: 106, high: 108.5, low: 106 }),
    c(107.2, 1200, { open: 108, high: 108.2, low: 106.8 }),
    c(106.5, 1100, { open: 107.2, high: 107.5, low: 106.2 }),
    c(106.8, 1000, { open: 106.5, high: 107.2, low: 106.3 }),
    c(107.0, 900,  { open: 106.8, high: 107.4, low: 106.5 }),
    c(108.8, 3500, { open: 107.0, high: 109.0, low: 107.0 }),
  ];
}

function baseCfg(overrides = {}) {
  return {
    enabled: true,
    enabledChains: ['kucoin', 'base'],
    polePctMin: 5,
    poleMaxCandles: 4,
    flagMinCandles: 2,
    flagMaxCandles: 8,
    flagDepthMaxPct: 50,
    flagVolContractMaxRatio: 0.70,
    breakoutVolMinRatio: 1.5,
    min24hVolumeUsd: 5_000_000,
    minLiquidityUsd: 500_000,
    minNetEdgePct: 2.5,
    riskPctBase: 0.35,
    riskPctAPlus: 0.50,
    aPlusVolumeExpansionMin: 3.0,
    aPlusFlagDepthMaxPct: 30,
    maxStopDistancePct: 3.5,
    perChainOverrides: {},
    ...overrides,
  };
}

function makeFetcher(candles) {
  return async () => ({ candles, closes: candles.map((x) => x.close), volumes: candles.map((x) => x.volume), source: 'mock' });
}

test('disabled strategy returns HOLD with reason', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ enabled: false }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.includes('strategy_disabled'));
});

test('chain not in enabledChains returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'solana', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('chain_not_enabled:')));
});

test('low 24h volume returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 100_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('volume_below_min:')));
});

test('low liquidity returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('liquidity_below_min:')));
});

test('valid setup all gates pass returns BUY with full details', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'BUY');
  assert.equal(result.details.setupType, 'spot_day_bull_flag');
  assert.ok(result.details.stopPrice < result.details.breakoutClose);
  assert.ok(result.details.targetPrice > result.details.breakoutClose);
  assert.ok(result.details.confidence >= 0.55);
  assert.ok(Number.isFinite(result.details.netEdgePct));
});

test('stop distance over max returns HOLD', async () => {
  // Force wide stop: use cfg with very low maxStopDistancePct
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ maxStopDistancePct: 0.5 }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('stop_distance_too_wide:')));
});

test('net edge below threshold returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ minNetEdgePct: 50 }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('net_edge_too_thin:')));
});

test('OHLCV unavailable returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: async () => null, detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.includes('ohlcv_unavailable'));
});

test('OHLCV fetch error returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: async () => { throw new Error('boom'); }, detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.includes('ohlcv_fetch_error'));
});

test('per-chain override raises min24h volume for BSC', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const cfg = baseCfg({
    enabledChains: ['bsc'],
    perChainOverrides: { bsc: { min24hVolumeUsd: 50_000_000 } },
  });
  // Token has $10M vol — passes base $5M but fails BSC override $50M
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'bsc', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: cfg }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('volume_below_min:')));
});

test('A+ grading flips riskPct from base to APlus', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  // Loose A+ thresholds → setup qualifies as A+
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ aPlusVolumeExpansionMin: 1.0, aPlusFlagDepthMaxPct: 99 }) }
  );
  assert.equal(result.signal, 'BUY');
  assert.equal(result.details.isAPlus, true);
  assert.equal(result.details.riskPct, 0.50);
});
