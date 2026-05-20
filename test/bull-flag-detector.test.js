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

function buildValidSetup() {
  // 10 candles: 2 base + 3 pole (+~8% rise) + 4 flag (shallow retrace, low vol) + 1 breakout
  return [
    c(100, 1000),       // 0 base
    c(100.5, 1000),     // 1 base
    c(103, 2200, { open: 100.6, high: 103.5, low: 100.6 }),  // 2 pole start
    c(106, 2400, { open: 103, high: 106.5, low: 103 }),       // 3 pole mid
    c(108, 2600, { open: 106, high: 108.5, low: 106 }),       // 4 pole end (high=108.5)
    c(107.2, 1200, { open: 108, high: 108.2, low: 106.8 }),   // 5 flag
    c(106.5, 1100, { open: 107.2, high: 107.5, low: 106.2 }), // 6 flag
    c(106.8, 1000, { open: 106.5, high: 107.2, low: 106.3 }), // 7 flag
    c(107.0, 900,  { open: 106.8, high: 107.4, low: 106.5 }), // 8 flag end (high=107.4)
    c(108.8, 3500, { open: 107.0, high: 109.0, low: 107.0 }), // 9 breakout (close > 107.4, vol >> flag median ~1050)
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
  // Force deep retrace: drop flag lows below 50% of pole range
  // Pole range = 108.5 - 100.6 = 7.9, 50% = 3.95 → flag low must be < 108.5 - 3.95 = 104.55
  setup[5] = c(103.0, 1200, { open: 108, high: 108.2, low: 103.0 });
  setup[6] = c(102.5, 1100, { open: 103.0, high: 103.5, low: 102.0 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('breakout without volume expansion returns no qualify', () => {
  const setup = buildValidSetup();
  setup[9] = c(108.8, 1000, { open: 107.0, high: 109.0, low: 107.0 }); // vol = flag median, not >= 1.5x
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('breakout close below flag high returns no qualify', () => {
  const setup = buildValidSetup();
  setup[9] = c(107.0, 3500, { open: 107.0, high: 107.3, low: 106.8 }); // close 107.0 < flag high 107.4
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});

test('flag with high volume (no contraction) returns no qualify', () => {
  const setup = buildValidSetup();
  // Set flag candles to high volume (>= 70% of pole vol median)
  setup[5] = c(107.2, 2500, { open: 108, high: 108.2, low: 106.8 });
  setup[6] = c(106.5, 2400, { open: 107.2, high: 107.5, low: 106.2 });
  setup[7] = c(106.8, 2300, { open: 106.5, high: 107.2, low: 106.3 });
  setup[8] = c(107.0, 2200, { open: 106.8, high: 107.4, low: 106.5 });
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
  // Late flag candle prints a new high above prior pole high (108.5)
  // — any reasonable flag window must contain this candle, so detector must reject.
  setup[8] = c(109.0, 900, { open: 106.8, high: 110.0, low: 106.5 });
  const result = detectBullFlag(setup);
  assert.equal(result.qualifies, false);
});
