'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { atr, classifySlope, simpleMA, simpleMASeries, wilderRsi } = require('../../src/strategies/backes-indicators');
const { classifyMacroRegime, clearMacroRegimeCache, getMacroRegime, getMacroSizeMultiplier } = require('../../src/strategies/backes-macro');
const { detect56dRetest } = require('../../src/strategies/backes-setups/56d-retest');
const { detect21wSupport } = require('../../src/strategies/backes-setups/21w-support');
const { detectCaixote } = require('../../src/strategies/backes-setups/caixote');
const { detectMegaphone } = require('../../src/strategies/backes-setups/megaphone');
const { createBackesEvaluator } = require('../../src/strategies/backes-evaluator');

const DAY = 86_400;

function c(index, close, overrides = {}) {
  const open = Number(overrides.open ?? close * 0.995);
  return {
    timestamp: (index + 1) * DAY,
    open,
    high: Number(overrides.high ?? Math.max(open, close) * 1.012),
    low: Number(overrides.low ?? Math.min(open, close) * 0.988),
    close: Number(close),
    volume: Number(overrides.volume ?? 1000),
  };
}

function flatCandles(count, close = 100, overrides = {}) {
  return Array.from({ length: count }, (_, index) => c(index, close, overrides));
}

function weeklySeries(count, closeFn) {
  return Array.from({ length: count }, (_, index) => c(index * 7, closeFn(index), {
    open: closeFn(index) * 0.996,
    high: closeFn(index) * 1.01,
    low: closeFn(index) * 0.99,
  }));
}

function token56dSetup(multiplier = 1) {
  const rows = flatCandles(78, 100 * multiplier);
  rows.push(c(78, 101 * multiplier, { open: 99.7 * multiplier, low: 99.5 * multiplier }));
  rows.push(c(79, 100.7 * multiplier, { open: 101 * multiplier, low: 100 * multiplier }));
  rows.push(c(80, 103 * multiplier, { open: 100.8 * multiplier, low: 100.5 * multiplier, volume: 1800 }));
  return rows;
}

function token21wSetup(multiplier = 1) {
  const daily = flatCandles(82, 108 * multiplier);
  daily[daily.length - 3] = c(79, 103 * multiplier, { open: 107 * multiplier, low: 101.5 * multiplier });
  daily[daily.length - 2] = c(80, 106 * multiplier, { open: 103 * multiplier, high: 106.5 * multiplier, low: 102.5 * multiplier });
  daily[daily.length - 1] = c(81, 109 * multiplier, { open: 106 * multiplier, high: 110 * multiplier, low: 105 * multiplier, volume: 1800 });
  const weekly = weeklySeries(28, (index) => (100 + index * 0.2) * multiplier);
  return { daily, weekly };
}

function tokenCaixoteSetup(multiplier = 1) {
  const rows = [];
  for (let index = 0; index < 64; index += 1) {
    const close = (109 + Math.sin(index / 2) * 4) * multiplier;
    rows.push(c(index, close, { high: 118 * multiplier, low: 101 * multiplier, volume: 1000 }));
  }
  rows[63] = c(63, 102 * multiplier, { open: 104 * multiplier, high: 106 * multiplier, low: 101 * multiplier, volume: 1000 });
  rows.push(c(64, 103 * multiplier, { open: 101.8 * multiplier, high: 106 * multiplier, low: 100.8 * multiplier, volume: 1800 }));
  return rows;
}

function tokenMegaphoneSetup(multiplier = 1) {
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    rows.push(c(index, 100 * multiplier, { high: 104 * multiplier, low: 96 * multiplier, volume: 1000 }));
  }
  for (let index = 20; index < 34; index += 1) {
    rows.push(c(index, (100 + (index % 2 ? 4 : -4)) * multiplier, {
      high: (108 + index * 0.2) * multiplier,
      low: (92 - index * 0.15) * multiplier,
      volume: 1000,
    }));
  }
  rows.push(c(34, 94 * multiplier, { open: 88 * multiplier, high: 99 * multiplier, low: 86 * multiplier, volume: 1800 }));
  return rows;
}

function macroBullPullback() {
  return {
    daily: flatCandles(140, 105),
    weekly: weeklySeries(30, (index) => (index < 22 ? 100 : 102 + (index - 22) * 0.45)),
  };
}

function macroRiskOff() {
  const daily = flatCandles(120, 100);
  for (let index = 120; index < 140; index += 1) {
    daily.push(c(index, 100 - (index - 119), { open: 101 - (index - 119) }));
  }
  return {
    daily,
    weekly: weeklySeries(30, (index) => (index < 29 ? 100 : 80)),
  };
}

function macroCapitulation() {
  const weekly = weeklySeries(30, (index) => (index < 29 ? 120 - index * 3.5 : 22));
  weekly[28] = c(28 * 7, 18, { open: 24, high: 25, low: 17 });
  weekly[29] = c(29 * 7, 22, { open: 18, high: 23, low: 17 });
  const daily = flatCandles(139, 20);
  daily.push(c(139, 22, { open: 20, high: 23, low: 19, volume: 2000 }));
  return { daily, weekly };
}

function macroReversalPending() {
  const daily = flatCandles(130, 100);
  daily.push(c(130, 101, { open: 99.5, low: 100 }));
  daily.push(c(131, 104, { open: 101, low: 101 }));
  return {
    daily,
    weekly: weeklySeries(30, (index) => (index < 25 ? 100 : 103 + (index - 25) * 0.2)),
  };
}

test('Backes indicators return known fixture values', () => {
  assert.equal(simpleMA([1, 2, 3, 4, 5], 3), 4);
  assert.deepEqual(simpleMASeries([1, 2, 3, 4], 2), [1.5, 2.5, 3.5]);
  assert.equal(wilderRsi([1, 2, 3, 4, 5, 6], 3), 100);
  assert.equal(classifySlope([100, 101, 103, 105], { lookback: 4 }), 'rising');
  assert.equal(classifySlope([100, 99.9, 100.1, 100], { lookback: 4 }), 'flat');
  assert.ok(atr([
    c(0, 10, { high: 11, low: 9 }),
    c(1, 12, { high: 13, low: 10 }),
    c(2, 11, { high: 12, low: 9 }),
    c(3, 13, { high: 14, low: 10 }),
  ], 2) > 0);
});

test('Backes macro classifier covers planned regimes and multiplier table', () => {
  const cases = [
    ['risk_off', macroRiskOff()],
    ['capitulation', macroCapitulation()],
    ['reversal_pending', macroReversalPending()],
    ['bull_pullback', macroBullPullback()],
  ];
  for (const [expected, fixture] of cases) {
    const result = classifyMacroRegime({ btcKlines: fixture, ethKlines: macroBullPullback() });
    assert.equal(result.regime, expected);
    assert.ok(Array.isArray(result.reasons));
    assert.ok(Number.isFinite(result.scores.trend));
  }
  assert.equal(getMacroSizeMultiplier('risk_off'), 0.5);
  assert.equal(getMacroSizeMultiplier('capitulation'), 1);
  assert.equal(getMacroSizeMultiplier('reversal_pending'), 0.8);
  assert.equal(getMacroSizeMultiplier('bull_pullback'), 1);
});

test('Backes macro cache avoids repeated BTC/ETH fetches for 4h window', async () => {
  clearMacroRegimeCache();
  let calls = 0;
  const fetchOhlcv = async () => {
    calls += 1;
    return { candles: macroBullPullback().daily };
  };
  const first = await getMacroRegime({ fetchOhlcv, cacheKey: 'test-cache', cacheTtlMs: 4 * 60 * 60_000 });
  const second = await getMacroRegime({ fetchOhlcv, cacheKey: 'test-cache', cacheTtlMs: 4 * 60 * 60_000 });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 2);
});

test('Backes setup detectors qualify their core synthetic structures', () => {
  const retest = detect56dRetest(token56dSetup());
  assert.equal(retest.qualifies, true);
  assert.equal(retest.structureType, '56d_retest');
  assert.ok(retest.targetPrices.length >= 2);

  const support = token21wSetup();
  const supportResult = detect21wSupport({ dailyCandles: support.daily, weeklyCandles: support.weekly });
  assert.equal(supportResult.qualifies, true);
  assert.equal(supportResult.structureType, '21w_support');

  const box = detectCaixote(tokenCaixoteSetup());
  assert.equal(box.qualifies, true);
  assert.equal(box.structureType, 'caixote_floor');

  const megaphone = detectMegaphone(tokenMegaphoneSetup());
  assert.equal(megaphone.qualifies, true);
  assert.equal(megaphone.structureType, 'megaphone_reclaim');
});

test('Backes setup detectors reject broken structures with reasons', () => {
  assert.equal(detect56dRetest(flatCandles(30, 100)).qualifies, false);
  assert.equal(detect21wSupport({ dailyCandles: flatCandles(30, 100), weeklyCandles: [] }).qualifies, false);
  assert.equal(detectCaixote(flatCandles(65, 100, { high: 200, low: 80 })).qualifies, false);
  assert.equal(detectMegaphone(flatCandles(40, 100)).qualifies, false);
});

test('Backes evaluator returns BUY contract with setup and macro details', async () => {
  clearMacroRegimeCache();
  const fetchOhlcv = async ({ symbol }) => {
    if (String(symbol).startsWith('BTC') || String(symbol).startsWith('ETH')) {
      return { candles: macroBullPullback().daily };
    }
    return { candles: token56dSetup() };
  };
  const evaluator = createBackesEvaluator({ fetchOhlcv });
  const result = await evaluator.evaluate(
    { symbol: 'SOL', address: 'SOL/USDT', chainKey: 'kucoin', liquidityUsd: 1_000_000, volume24hUsd: 1_000_000 },
    { config: { enabled: true, enabledChains: ['kucoin'], minLiquidityUsd: 500_000, min24hVolumeUsd: 100_000 }, chainKey: 'kucoin' },
  );
  assert.equal(result.signal, 'BUY');
  assert.equal(result.details.setupType, 'swing');
  assert.equal(result.details.strategyMode, 'backes_htf_swing');
  assert.ok(result.details.structureType);
  assert.ok(result.details.invalidationPrice < result.details.entryPrice);
  assert.ok(Array.isArray(result.details.targetPrices));
  assert.ok(Number.isFinite(result.details.macroSizeMultiplier));
});

test('Backes evaluator scanner gates and risk-off gate return HOLD', async () => {
  clearMacroRegimeCache();
  const evaluator = createBackesEvaluator({
    fetchOhlcv: async ({ symbol }) => {
      if (String(symbol).startsWith('BTC') || String(symbol).startsWith('ETH')) return { candles: macroRiskOff().daily };
      return { candles: token56dSetup() };
    },
  });
  const cfg = { enabled: true, enabledChains: ['kucoin'], minLiquidityUsd: 500_000, min24hVolumeUsd: 100_000 };
  assert.equal((await evaluator.evaluate({ chainKey: 'kucoin', liquidityUsd: 1, volume24hUsd: 1_000_000 }, { config: cfg })).signal, 'HOLD');
  assert.equal((await evaluator.evaluate({ chainKey: 'kucoin', liquidityUsd: 1_000_000, volume24hUsd: 1 }, { config: cfg })).signal, 'HOLD');
  const riskOff = await evaluator.evaluate(
    { symbol: 'SOL', address: 'SOL/USDT', chainKey: 'kucoin', liquidityUsd: 1_000_000, volume24hUsd: 1_000_000 },
    { config: cfg, chainKey: 'kucoin' },
  );
  assert.equal(riskOff.signal, 'HOLD');
  assert.equal(riskOff.details.macroRegime, 'risk_off');
});

test('Backes evaluator has stable HOLD responses for disabled, wrong chain, short OHLCV, and fetch errors', async () => {
  const evaluator = createBackesEvaluator({ fetchOhlcv: async () => ({ candles: [] }) });
  const token = { symbol: 'SOL', address: 'SOL/USDT', chainKey: 'kucoin', liquidityUsd: 1_000_000, volume24hUsd: 1_000_000 };
  assert.equal((await evaluator.evaluate(token, { config: { enabled: false } })).details.scannerReasons[0], 'strategy_disabled');
  assert.match((await evaluator.evaluate(token, { config: { enabled: true, enabledChains: ['bsc'] } })).details.scannerReasons[0], /chain_not_enabled/);
  assert.equal((await evaluator.evaluate(token, { config: { enabled: true, enabledChains: ['kucoin'] } })).details.scannerReasons[0], 'ohlcv_unavailable_or_short');

  const throwing = createBackesEvaluator({ fetchOhlcv: async () => { throw new Error('boom'); } });
  assert.equal((await throwing.evaluate(token, { config: { enabled: true, enabledChains: ['kucoin'] } })).details.scannerReasons[0], 'ohlcv_fetch_error');
});

function scaleCandles(rows, multiplier) {
  return rows.map((row) => ({
    ...row,
    open: row.open * multiplier,
    high: row.high * multiplier,
    low: row.low * multiplier,
    close: row.close * multiplier,
  }));
}

const macroFixtureMatrix = [
  ['risk_off', macroRiskOff],
  ['capitulation', macroCapitulation],
  ['reversal_pending', macroReversalPending],
  ['bull_pullback', macroBullPullback],
];

for (const [expected, factory] of macroFixtureMatrix) {
  for (let index = 0; index < 20; index += 1) {
    test(`Backes macro ${expected} fixture ${index + 1}/20`, () => {
      const multiplier = 0.75 + index * 0.025;
      const fixture = factory();
      const result = classifyMacroRegime({
        btcKlines: {
          daily: scaleCandles(fixture.daily, multiplier),
          weekly: scaleCandles(fixture.weekly, multiplier),
        },
        ethKlines: macroBullPullback(),
      });
      assert.equal(result.regime, expected);
      assert.ok(result.reasons.length > 0);
    });
  }
}

const setupFixtureMatrix = [
  ['56d_retest', (multiplier) => detect56dRetest(token56dSetup(multiplier))],
  ['21w_support', (multiplier) => {
    const fixture = token21wSetup(multiplier);
    return detect21wSupport({ dailyCandles: fixture.daily, weeklyCandles: fixture.weekly });
  }],
  ['caixote_floor', (multiplier) => detectCaixote(tokenCaixoteSetup(multiplier))],
  ['megaphone_reclaim', (multiplier) => detectMegaphone(tokenMegaphoneSetup(multiplier))],
];

for (const [structureType, runDetector] of setupFixtureMatrix) {
  for (let index = 0; index < 10; index += 1) {
    test(`Backes setup ${structureType} fixture ${index + 1}/10`, () => {
      const result = runDetector(0.8 + index * 0.05);
      assert.equal(result.qualifies, true);
      assert.equal(result.structureType, structureType);
      assert.ok(Number(result.entryPrice) > 0);
      assert.ok(Number(result.stopPrice) > 0);
      assert.ok(Array.isArray(result.targetPrices));
    });
  }
}

for (let index = 0; index < 15; index += 1) {
  test(`Backes evaluator integration fixture ${index + 1}/15`, async () => {
    clearMacroRegimeCache();
    const multiplier = 0.85 + index * 0.025;
    const fetchOhlcv = async ({ symbol }) => {
      if (String(symbol).startsWith('BTC') || String(symbol).startsWith('ETH')) {
        return { candles: macroBullPullback().daily };
      }
      return { candles: token56dSetup(multiplier) };
    };
    const evaluator = createBackesEvaluator({ fetchOhlcv });
    const result = await evaluator.evaluate(
      { symbol: `SOL${index}`, address: 'SOL/USDT', chainKey: 'kucoin', liquidityUsd: 1_000_000 + index, volume24hUsd: 1_000_000 + index },
      { config: { enabled: true, enabledChains: ['kucoin'], minLiquidityUsd: 500_000, min24hVolumeUsd: 100_000, macroCacheKey: `fixture-${index}` }, chainKey: 'kucoin' },
    );
    assert.equal(result.signal, 'BUY');
    assert.equal(result.details.setupType, 'swing');
    assert.equal(result.details.structureType, '56d_retest');
    assert.ok(result.details.stopDistancePct > 0);
  });
}
