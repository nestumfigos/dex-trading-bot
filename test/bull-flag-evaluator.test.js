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

const IDX = Object.freeze({
  pole: 20,
  flag1: 21,
  flag2: 22,
  breakout: 23,
});

function validCandles() {
  return [
    ...Array.from({ length: 20 }, (_, index) => c(100 + (index % 3) * 0.05, 900 + (index % 4) * 30)),
    c(106.2, 2400, { open: 100.6, high: 107.0, low: 100.6 }),
    c(105.7, 800, { open: 106.2, high: 106.2, low: 105.3 }),
    c(105.9, 760, { open: 105.7, high: 106.1, low: 105.4 }),
    c(107.3, 3000, { open: 105.9, high: 107.5, low: 105.9 }),
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
    latestVolumeLookbackCandles: 20,
    latestVolumeMinRatio: 2,
    minSixtyMinuteMovePct: 5,
    maxSixtyMinuteMovePct: 12,
    min24hVolumeUsd: 5_000_000,
    minLiquidityUsd: 500_000,
    minNetEdgePct: 2.5,
    minTargetRemainingPct: 20,
    riskPctBase: 0.35,
    riskPctAPlus: 0.50,
    aPlusVolumeExpansionMin: 3.0,
    aPlusFlagDepthMaxPct: 30,
    maxStopDistancePct: 3.5,
    requireEmaConfirmation: true,
    requireOneHourConfirmation: true,
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
  assert.equal(result.details.triggerTimeframe, '15m');
  assert.ok(result.details.expectedFeesBps >= 0);
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

test('entry too close to measured target returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', price: 113, volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ maxStopDistancePct: 10, minNetEdgePct: 0 }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('entry_too_close_to_target:')));
});

test('stop distance inside fees/slippage buffer returns HOLD', async () => {
  const tightStop = validCandles();
  tightStop[IDX.flag1] = c(106.95, 800, { open: 106.2, high: 106.99, low: 106.90 });
  tightStop[IDX.flag2] = c(106.98, 760, { open: 106.95, high: 106.99, low: 106.92 });
  tightStop[IDX.breakout] = c(107.05, 3000, { open: 106.98, high: 107.2, low: 106.98 });
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(tightStop), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000, expectedFeesBps: 30, expectedSlippageBps: 20 },
    { config: baseCfg({ minNetEdgePct: 0, minRR: 0, minSixtyMinuteMovePct: 0 }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('stop_distance_inside_cost_buffer:')));
});

test('EMA confirmation requires enough 15m context', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg({ emaFastPeriod: 9, emaSlowPeriod: 50 }) }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.includes('ema_confirmation_insufficient_candles'));
});

test('1h confirmation failure returns HOLD', async () => {
  const fetchOhlcv = async ({ interval }) => {
    if (interval === '1h') {
      return { candles: [c(110, 1000, { open: 109, high: 112, low: 108 }), c(106, 1000, { open: 108, high: 109, low: 105 })] };
    }
    return { candles: validCandles() };
  };
  const evaluator = createBullFlagEvaluator({ fetchOhlcv, detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.includes('one_hour_confirmation_failed'));
});

test('ask wall orderbook dominance returns HOLD', async () => {
  const evaluator = createBullFlagEvaluator({ fetchOhlcv: makeFetcher(validCandles()), detectBullFlag });
  const result = await evaluator.evaluate(
    { symbol: 'X', address: '0x1', chainKey: 'kucoin', volume24hUsd: 10_000_000, liquidityUsd: 1_000_000, bidDepthUsd: 100_000, askDepthUsd: 170_000 },
    { config: baseCfg() }
  );
  assert.equal(result.signal, 'HOLD');
  assert.ok(result.details.scannerReasons.some((r) => r.startsWith('ask_wall_depth_ratio:')));
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
