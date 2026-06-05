'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectBullFlag } = require('../src/strategies/bull-flag-detector');

// Helper: build OHLCV candle. close drives close, range = ±0.2% around close.
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

function buildValidSetup() {
  // 24 candles: 20 prior candles for scanner volume context + 1 pole + 2 flag + 1 breakout.
  // Last 60m = pole + flag + breakout, up ~6.7%, inside the +5%..+12% scanner band.
  return [
    ...Array.from({ length: 20 }, (_, index) => c(100 + (index % 3) * 0.05, 900 + (index % 4) * 30)),
    c(106.2, 2400, { open: 100.6, high: 107.0, low: 100.6 }),  // 20 pole
    c(105.7, 800, { open: 106.2, high: 106.2, low: 105.3 }),   // 21 flag
    c(105.9, 760, { open: 105.7, high: 106.1, low: 105.4 }),   // 22 flag
    c(107.3, 3000, { open: 105.9, high: 107.5, low: 105.9 }),  // 23 breakout
  ];
}

function buildScoutSetup() {
  return [
    ...Array.from({ length: 18 }, (_, index) => c(100 + (index % 2) * 0.03, 1000 + (index % 3) * 20)),
    c(100.8, 1600, { open: 100.0, high: 100.9, low: 100.0 }),
    c(100.7, 1500, { open: 100.75, high: 100.85, low: 100.60 }),
    c(100.45, 1100, { open: 100.7, high: 100.70, low: 100.35 }),
    c(100.50, 1050, { open: 100.45, high: 100.60, low: 100.40 }),
    c(100.63, 800, { open: 100.50, high: 100.75, low: 100.48 }),
  ];
}

test('valid pole + contracting flag + breakout returns qualifying setup', () => {
  const result = detectBullFlag(buildValidSetup());
  assert.equal(result.qualifies, true);
  assert.equal(result.setupType, 'spot_day_bull_flag');
  assert.ok(result.poleHeightPct >= 5, `pole height ${result.poleHeightPct} should be >= 5%`);
  assert.ok(result.flagDepthPct <= 50, `flag depth ${result.flagDepthPct} should be <= 50%`);
  assert.ok(result.volumeContraction <= 0.70, `flag vol ratio ${result.volumeContraction} should be <= 0.70`);
  assert.ok(result.volumeExpansion >= 1.5, `breakout vol ratio ${result.volumeExpansion} should be >= 1.5`);
  assert.ok(result.latestVolumeRatio >= 2, `latest vol ratio ${result.latestVolumeRatio} should be >= 2`);
  assert.ok(result.sixtyMinuteMovePct >= 5 && result.sixtyMinuteMovePct <= 12);
  assert.ok(result.targetPrice > result.breakoutClose);
  assert.ok(result.stopPrice < result.breakoutClose);
});

test('pump without flag (continuous rise, no consolidation) returns no qualify', () => {
  // No volume contraction phase - all candles high vol pumping
  const candles = [];
  for (let i = 0; i < 10; i += 1) candles.push(c(100 + i, 2000 + i * 100));
  const result = detectBullFlag(candles);
  assert.equal(result.qualifies, false);
});

test('flag retrace deeper than 50% of pole returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.flag1] = c(103.0, 800, { open: 106.2, high: 106.2, low: 103.0 });
  setup[IDX.flag2] = c(102.5, 760, { open: 103.0, high: 103.5, low: 102.0 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('breakout without volume expansion returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.breakout] = c(107.3, 800, { open: 105.9, high: 107.5, low: 105.9 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('breakout close below flag high returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.breakout] = c(105.95, 3000, { open: 105.9, high: 106.0, low: 105.6 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('flag with high volume (no contraction) returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.flag1] = c(105.7, 2300, { open: 106.2, high: 106.2, low: 105.3 });
  setup[IDX.flag2] = c(105.9, 2200, { open: 105.7, high: 106.1, low: 105.4 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('insufficient candles returns insufficient_candles reason', () => {
  const result = detectBullFlag([c(100, 1000), c(101, 1000), c(102, 1000)]);
  assert.equal(result.qualifies, false);
  assert.equal(result.reason, 'insufficient_candles');
});

test('measured move target = breakout close + pole height', () => {
  const result = detectBullFlag(buildValidSetup());
  assert.equal(result.qualifies, true);
  const expectedMove = result.poleHighPrice - result.poleStartPrice;
  const expectedTarget = result.breakoutClose + expectedMove;
  assert.ok(Math.abs(result.targetPrice - expectedTarget) < 1e-9);
});

test('stop placed at flag low', () => {
  const result = detectBullFlag(buildValidSetup());
  assert.equal(result.qualifies, true);
  assert.equal(result.stopPrice, result.flagLow);
});

test('rr ratio computed and positive on valid setup', () => {
  const result = detectBullFlag(buildValidSetup());
  assert.equal(result.qualifies, true);
  assert.ok(result.rr !== null);
  assert.ok(result.rr > 0);
});

test('flag making higher high than pole rejects setup', () => {
  const setup = buildValidSetup();
  setup[IDX.flag2] = c(108.0, 760, { open: 105.7, high: 108.0, low: 105.4 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('60m move above chase cap returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.breakout] = c(114.0, 3000, { open: 105.9, high: 114.2, low: 105.9 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
  assert.equal(result.reason, 'sixty_minute_move_above_max');
});

test('latest 15m volume below prior 20-candle median returns no qualify', () => {
  const setup = buildValidSetup();
  setup[IDX.breakout] = c(107.3, 1000, { open: 105.9, high: 107.5, low: 105.9 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
  assert.equal(result.reason, 'latest_volume_below_prior_median');
});

test('recent breakout still qualifies inside bounded day-trade entry window', () => {
  const setup = buildValidSetup();
  setup.push(c(107.8, 1400, { open: 107.3, high: 108.0, low: 107.2 }));
  const result = detectBullFlag(setup, { breakoutLookbackCandles: 1 });
  assert.equal(result.qualifies, true);
  assert.equal(result.breakoutAgeCandles, 1);
  assert.equal(result.lateEntry, true);
  assert.equal(result.breakoutClose, setup[IDX.breakout].close);
});

test('recent breakout is rejected after closing back inside the flag', () => {
  const setup = buildValidSetup();
  setup.push(c(105.8, 1400, { open: 107.3, high: 107.5, low: 105.5 }));
  const result = detectBullFlag(setup, { breakoutLookbackCandles: 1 });
  assert.equal(result.qualifies, false);
});

test('continuation scout is opt-in and catches intraday micro bull flag', () => {
  const setup = buildScoutSetup();
  const strict = detectBullFlag(setup);
  assert.equal(strict.qualifies, false);
  assert.equal(strict.reason, 'sixty_minute_move_below_min');

  const scout = detectBullFlag(setup, {
    allowContinuationScout: true,
    scoutMinSixtyMinuteMovePct: 0.25,
    scoutPolePctMin: 0.40,
    scoutLatestVolumeMinRatio: 0.20,
    scoutBreakoutVolMinRatio: 0.45,
    scoutFlagVolContractMaxRatio: 1.80,
    scoutLookbackCandles: 24,
    scoutMinPullbackPct: 0.08,
    scoutMaxDepthPct: 85,
    scoutBreakoutReclaimTolerancePct: 0.12,
  });
  assert.equal(scout.qualifies, true);
  assert.equal(scout.setupSubtype, 'continuation_scout');
  assert.ok(scout.sixtyMinuteMovePct >= 0.25);
  assert.ok(scout.targetPrice > scout.breakoutClose);
  assert.ok(scout.stopPrice < scout.breakoutClose);
});
