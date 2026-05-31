'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runHistoricalReplay } = require('../src/backtest/traderxo-replay');
const { createPublicReplayService } = require('../src/backtest/public-replay-service');
const { createBinancePublicPerpsFeed } = require('../src/market/binance-public-perps');
const { createPaperTelemetry } = require('../src/telemetry/perps-stats');
const { createPaperApiServer } = require('../src/server');
const { createPaperStrategyAdmission } = require('../src/paper/paper-strategy-admission');

const M15 = 15 * 60 * 1000;
const M5 = 5 * 60 * 1000;
const H1 = 60 * 60 * 1000;
const D1 = 24 * H1;

function candle(openTime, open, high, low, close, volume = 100) {
  return { openTime, open, high, low, close, volume };
}

function nearlyEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} !== ${expected}`);
}

function fixtureCandles(exitCandle, neutralBars = 3, start = 0) {
  return {
    candles5m: Array.from({ length: 30 }, (_, index) => candle(start + (index * M5), 100, 101, 99, 100)),
    candles15m: [
      ...Array.from({ length: neutralBars }, (_, index) => candle(start + (index * M15), 100, 100.5, 99.5, 100)),
      exitCandle,
    ],
    candles1h: Array.from({ length: 14 }, (_, index) => candle(start + (index * H1) - (12 * H1), 100, 110, 90, 100)),
    dailyCandles: [candle(start - D1, 100, 101, 99, 100), candle(start, 100, 101, 99, 100)],
  };
}

function entryOnce() {
  let emitted = false;
  return () => {
    if (emitted) return { qualifies: false, reasons: ['already_emitted'] };
    emitted = true;
    return {
      qualifies: true,
      side: 'long',
      setup: 'deviation_reclaim',
      setupGrade: 'A',
      entry: 100,
      stop: 99,
      targets: [101, 103],
      order: {
        symbol: 'BTCUSDT',
        riskPct: 0.5,
        entryPrice: 100,
        stopPrice: 99,
        leverage: 3,
        plannedRewardRisk: 3,
        marginMode: 'isolated',
      },
    };
  };
}

function rangeAlways() {
  return { qualifies: true, high: 110, low: 90, eq: 100 };
}

function anchorsAlways() {
  return { valid: true, monthlyOpen: 100, weeklyOpen: 100, sideBias: 'neutral', anchorBias: {} };
}

test('historical replay records a completed winner with explicit costs and no paper persistence', () => {
  const replay = runHistoricalReplay({
    symbol: 'BTCUSDT',
    ...fixtureCandles(candle(3 * M15, 100, 104, 100, 103)),
    evaluateEntry: entryOnce(),
    detectRange: rangeAlways,
    calculateAnchors: anchorsAlways,
  });
  assert.equal(replay.assumptions.persistsPaperTrades, false);
  assert.equal(replay.summary.completedTrades, 1);
  assert.equal(replay.summary.wins, 1);
  assert.ok(replay.summary.pnlUsd > 0);
  assert.ok(replay.summary.totalCostsUsd > 0);
  assert.ok(replay.summary.stressedPnlUsd < replay.summary.pnlUsd);
  assert.equal(replay.summary.byRegime.volatile.trades, 1);
  assert.equal(replay.summary.bySetup.deviation_reclaim.trades, 1);
  const trade = replay.trades[0];
  nearlyEqual(
    replay.summary.stressedPnlUsd,
    trade.grossPnlUsd - trade.fundingUsd - trade.feesUsd - (2 * trade.slippageUsd),
    1e-6,
  );
});

test('historical replay charges funding only on actual 8h settlement boundaries', () => {
  const start = Date.parse('2026-05-25T07:00:00.000Z');
  const replay = runHistoricalReplay({
    symbol: 'BTCUSDT',
    ...fixtureCandles(candle(start + (3 * M15), 100, 104, 100, 103), 3, start),
    feeBps: 0,
    slippageBps: 0,
    fundingBpsPerEightHours: 10,
    evaluateEntry: entryOnce(),
    detectRange: rangeAlways,
    calculateAnchors: anchorsAlways,
  });

  assert.equal(replay.summary.completedTrades, 1);
  const trade = replay.trades[0];
  assert.equal(trade.openedAt, '2026-05-25T07:45:00.000Z');
  assert.equal(trade.closedAt, '2026-05-25T08:00:00.000Z');
  const notionalUsd = trade.grossPnlUsd / 0.03;
  nearlyEqual(trade.fundingUsd, notionalUsd * 0.001, 1e-6);
  nearlyEqual(trade.costsUsd, trade.fundingUsd, 1e-9);
});

test('historical replay includes stop-loss outcomes and drawdown', () => {
  const replay = runHistoricalReplay({
    symbol: 'BTCUSDT',
    ...fixtureCandles(candle(3 * M15, 100, 100.5, 98.8, 99)),
    evaluateEntry: entryOnce(),
    detectRange: rangeAlways,
    calculateAnchors: anchorsAlways,
  });
  assert.equal(replay.summary.completedTrades, 1);
  assert.equal(replay.summary.losses, 1);
  assert.ok(replay.summary.pnlUsd < 0);
  assert.ok(replay.summary.maxDrawdownPct > 0);
  assert.equal(replay.summary.byExitReason.STRUCTURE_INVALIDATION_STOP.trades, 1);
  assert.equal(replay.summary.bySide.long.trades, 1);
  assert.ok(replay.trades[0].heldHours >= 0);
});

test('research variants filter baseline entries without changing baseline behavior', () => {
  const baseline = runHistoricalReplay({
    symbol: 'BTCUSDT',
    ...fixtureCandles(candle(3 * M15, 100, 104, 100, 103)),
    evaluateEntry: entryOnce(),
    detectRange: rangeAlways,
    calculateAnchors: anchorsAlways,
    variantId: 'baseline',
  });
  const filtered = runHistoricalReplay({
    symbol: 'BTCUSDT',
    ...fixtureCandles(candle(3 * M15, 100, 104, 100, 103)),
    evaluateEntry: entryOnce(),
    detectRange: rangeAlways,
    calculateAnchors: anchorsAlways,
    variantId: 'bias_aligned',
  });
  assert.equal(baseline.summary.completedTrades, 1);
  assert.equal(filtered.summary.completedTrades, 0);
  assert.equal(filtered.summary.rejectReasons.variant_anchor_bias_alignment_required, 1);
});

test('public historical loader filters unfinished candles and includes bounded window query', async () => {
  const urls = [];
  const feed = createBinancePublicPerpsFeed({
    fetchFn: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => [
          [1000, '100', '101', '99', '100', '10', 1999],
          [2000, '100', '101', '99', '100', '10', 2999],
          [3000, '100', '101', '99', '100', '10', 3999],
        ],
      };
    },
  });
  const candles = await feed.getHistoricalCandles('BTCUSDT', '15m', { startTime: 1000, endTime: 3000 });
  assert.equal(candles.length, 2);
  assert.match(urls[0], /startTime=1000/);
  assert.match(urls[0], /endTime=3000/);
});

test('public replay service constrains symbols and forwards completed history to replay', async () => {
  const requests = [];
  const service = createPublicReplayService({
    allowedSymbols: ['BTCUSDT'],
    now: () => Date.parse('2026-05-25T00:00:00.000Z'),
    feed: {
      async getHistoricalCandles(symbol, interval, options) {
        requests.push({ symbol, interval, options });
        return [];
      },
    },
  });
  const result = await service.run({ symbol: 'BTCUSDT', days: 10 });
  assert.equal(result.symbol, 'BTCUSDT');
  assert.deepEqual(result.dataWindow.completedCandles, { '5m': 0, '15m': 0, '1h': 0, '1d': 0 });
  assert.equal(requests.length, 4);
  await assert.rejects(() => service.run({ symbol: 'DOGEUSDT' }), /symbol_not_enabled_for_paper_replay/);
});

test('replay study compares enabled contracts and walk-forward blocks weak validation', async () => {
  const service = createPublicReplayService({
    allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
    now: () => Date.parse('2026-05-25T00:00:00.000Z'),
    feed: { async getHistoricalCandles() { return []; } },
  });
  const study = await service.runStudy({ symbols: ['BTCUSDT', 'ETHUSDT'], days: 30 });
  assert.equal(study.mode, 'historical-replay-study');
  assert.equal(study.persistsPaperTrades, false);
  assert.deepEqual(study.comparison.map((row) => row.symbol), ['BTCUSDT', 'ETHUSDT']);
  const walkForward = await service.runWalkForward({ symbol: 'BTCUSDT', trainingDays: 30, validationDays: 30 });
  assert.equal(walkForward.parametersFrozen, true);
  assert.equal(walkForward.passed, false);
  // B3P.09: WF floor raised 10 -> 30 trades (aligns with historical-replay gate).
  assert.ok(walkForward.reasons.includes('validation_trade_count_below_30'));
  assert.ok(walkForward.reasons.includes('validation_expectancy_not_positive'));
});

test('benchmark persists a blocked paper entry admission when unseen evidence fails', async () => {
  const path = require('node:path');
  const os = require('node:os');
  const fs = require('node:fs');
  const approvalPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'perps-benchmark-')), 'admission.json');
  const admission = createPaperStrategyAdmission({ required: true, approvalPath });
  const service = createPublicReplayService({
    allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
    now: () => Date.parse('2026-05-25T00:00:00.000Z'),
    admission,
    feed: { async getHistoricalCandles() { return []; } },
  });
  const benchmark = await service.runBenchmark({
    symbols: ['BTCUSDT', 'ETHUSDT'],
    trainingDays: 30,
    validationDays: 30,
  });
  assert.equal(benchmark.passed, false);
  assert.equal(benchmark.parametersFrozenForValidation, true);
  assert.equal(admission.getStatus().allowNewPaperEntries, false);
  assert.equal(admission.getStatus().benchmark.selectedVariantId, 'baseline');
});

test('backtest API results do not write to persistent paper trade history', async () => {
  const telemetry = createPaperTelemetry({
    historyPath: require('path').join(require('os').tmpdir(), `replay-history-${Date.now()}.json`),
  });
  const replayService = {
    getLastResult: () => null,
    run: async () => ({ symbol: 'BTCUSDT', summary: { completedTrades: 1 } }),
    runStudy: async () => ({ results: [{ symbol: 'BTCUSDT' }] }),
    runWalkForward: async () => ({ parametersFrozen: true, passed: false }),
    runBenchmark: async () => ({ selectedVariant: { id: 'baseline' }, passed: false }),
  };
  const server = createPaperApiServer({ telemetry, replayService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/backtests/traderxo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', days: 30 }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.persistsPaperTrades, false);
    assert.equal(telemetry.listTrades().length, 0);
    const studyResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/backtests/traderxo/study`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: ['BTCUSDT'] }),
    });
    const walkResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/backtests/traderxo/walk-forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT' }),
    });
    assert.equal(studyResponse.status, 200);
    assert.equal((await studyResponse.json()).liveExecutionEnabled, false);
    assert.equal(walkResponse.status, 200);
    assert.equal((await walkResponse.json()).persistsPaperTrades, false);
    const benchmarkResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/backtests/traderxo/benchmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: ['BTCUSDT'] }),
    });
    assert.equal(benchmarkResponse.status, 200);
    assert.equal((await benchmarkResponse.json()).liveExecutionEnabled, false);
    assert.equal(telemetry.listTrades().length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
