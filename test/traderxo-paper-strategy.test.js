'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { calculateTimeOpenAnchors } = require('../src/strategies/perps-anchors');
const { detectHorizontalRange } = require('../src/strategies/perps-range-detector');
const { evaluateDeviationReclaim } = require('../src/strategies/perps-deviation-reclaim');
const { evaluateLevelToLevel } = require('../src/strategies/perps-l2l-detector');
const { evaluateTraderXoEntry, evaluatePositionManagement } = require('../src/strategies/traderxo-paper-engine');
const { createBinancePublicPerpsFeed } = require('../src/market/binance-public-perps');
const { createPaperMarketScanner } = require('../src/paper/paper-market-scanner');
const { createPaperTelemetry } = require('../src/telemetry/perps-stats');
const { createPaperExecutionAdapter } = require('../src/paper/paper-perps-adapter');
const { createPaperSignalProcessor } = require('../src/paper/paper-signal-processor');
const { createPaperStrategyAdmission } = require('../src/paper/paper-strategy-admission');

function candle(openTime, open, high, low, close, volume = 100) {
  return { openTime, open, high, low, close, volume };
}

const range = { high: 110, low: 100, eq: 105 };
const longSetup = [
  candle(1, 103, 104, 102, 103),
  candle(2, 102, 103, 99.4, 101),
  candle(3, 101, 102, 99.9, 101),
];
const shortSetup = [
  candle(1, 107, 108, 106, 107),
  candle(2, 109, 111.5, 108, 109),
  candle(3, 109, 110.1, 108, 109),
];
const longMss = [
  candle(1, 100, 100.5, 99.7, 100.1),
  candle(2, 100.1, 100.7, 99.9, 100.2),
  candle(3, 100.2, 100.6, 99.8, 100.3),
  candle(4, 100.3, 101.5, 100.1, 101.2),
];
// B2P.11: stricter MSS detector requires >=0.3% displacement past brokenLow OR
// two consecutive closes through it. Original fixture broke structure by only
// ~0.27% which the new detector correctly rejects as noise. Updated close to
// 108.5 — a clear ~0.7% structure break consistent with a real bearish MSS.
const shortMss = [
  candle(1, 110, 110.3, 109.5, 109.9),
  candle(2, 109.9, 110.1, 109.3, 109.7),
  candle(3, 109.8, 110, 109.4, 109.6),
  candle(4, 109.6, 109.8, 108.3, 108.5),
];

test('anchors derive monthly weekly and daily bias from perps candle data', () => {
  const anchors = calculateTimeOpenAnchors({
    dailyCandles: [
      candle(Date.parse('2026-05-01T00:00:00Z'), 98, 101, 97, 100),
      candle(Date.parse('2026-05-25T00:00:00Z'), 100, 104, 99, 103),
    ],
    currentPrice: 103,
  });
  assert.equal(anchors.valid, true);
  assert.equal(anchors.monthlyOpen, 98);
  assert.equal(anchors.weeklyOpen, 100);
  assert.equal(anchors.sideBias, 'long');
});

test('horizontal range requires repeated RH and RL touches', () => {
  // B4P.range recency: range now also requires at least one touch per side
  // within the recency window (last half of lookback). Fixture extended to
  // include both old + recent touches so the range still qualifies.
  const detected = detectHorizontalRange([
    candle(1, 105, 110, 104, 106), candle(2, 105, 106, 100, 103),
    candle(3, 105, 109.9, 103, 106), candle(4, 104, 106, 100.1, 102),
    candle(5, 103, 109.95, 100.05, 105), candle(6, 104, 109.9, 100.1, 104),
  ]);
  assert.equal(detected.qualifies, true);
  assert.equal(detected.eq, 105);
});

test('range-low deviation and reclaim creates a long paper intent', () => {
  const setup = evaluateDeviationReclaim({ candles: longSetup, range });
  assert.equal(setup.qualifies, true);
  assert.equal(setup.side, 'long');
  const intent = evaluateTraderXoEntry({ symbol: 'BTCUSDT', candles15m: longSetup, candles5m: longMss, range });
  assert.equal(intent.qualifies, true);
  assert.equal(intent.setup, 'deviation_reclaim');
  assert.ok(intent.rr >= 3);
});

test('range-high deviation and reclaim creates a short paper intent', () => {
  const setup = evaluateDeviationReclaim({ candles: shortSetup, range });
  assert.equal(setup.qualifies, true);
  assert.equal(setup.side, 'short');
  const intent = evaluateTraderXoEntry({ symbol: 'ETHUSDT', candles15m: shortSetup, candles5m: shortMss, range });
  assert.equal(intent.qualifies, true);
  assert.ok(intent.rr >= 3);
});

test('sweep without reclaim and poor reward-to-risk never create entries', () => {
  assert.equal(evaluateDeviationReclaim({
    candles: [candle(1, 102, 103, 98, 98.5), candle(2, 99, 100, 97, 98)],
    range,
  }).qualifies, false);
  const tooTightRange = { high: 103, low: 100, eq: 101.5 };
  const intent = evaluateTraderXoEntry({ symbol: 'BTCUSDT', candles15m: longSetup, candles5m: longMss, range: tooTightRange });
  assert.equal(intent.qualifies, false);
  assert.deepEqual(intent.reasons, ['reward_risk_below_3']);
});

test('valid deviation without lower-timeframe structure shift is rejected', () => {
  const intent = evaluateTraderXoEntry({ symbol: 'BTCUSDT', candles15m: longSetup, candles5m: longSetup, range });
  assert.equal(intent.qualifies, false);
  assert.deepEqual(intent.reasons, ['market_structure_shift_required']);
});

test('missing deviation without a continuation target reports the actual setup rejection', () => {
  const intent = evaluateTraderXoEntry({
    symbol: 'BTCUSDT',
    candles15m: [candle(1, 103, 104, 102, 103), candle(2, 103, 104, 102, 103)],
    candles5m: longMss,
    range,
  });
  assert.equal(intent.qualifies, false);
  assert.deepEqual(intent.reasons, ['deviation_reclaim_not_confirmed']);
});

test('level-to-level continuation respects weekly bias', () => {
  const result = evaluateLevelToLevel({
    anchors: { valid: true, weeklyOpen: 100 },
    level: 104,
    nextTarget: 116,
    candles: [candle(1, 104, 108, 103, 106), candle(2, 105, 107, 103.9, 105)],
  });
  assert.equal(result.qualifies, true);
  assert.equal(result.side, 'long');
  assert.equal(evaluateLevelToLevel({
    anchors: { valid: true, weeklyOpen: 110 },
    level: 104,
    nextTarget: 116,
    candles: [candle(1, 104, 108, 103, 106), candle(2, 105, 107, 103.9, 105)],
  }).qualifies, false);
});

test('paper management scales at EQ, closes at target two, and cuts stalled trades', () => {
  const position = {
    side: 'long', entryPrice: 101, stopPrice: 98, targets: [105, 110],
    remainingNotionalUsd: 1000, notionalUsd: 1000,
  };
  const scaleDecision = evaluatePositionManagement({
    position, candle: candle(1, 103, 105.5, 102, 105), barsSinceEntry: 2,
  });
  assert.equal(scaleDecision.action, 'PARTIAL_EXIT');
  assert.equal(scaleDecision.nextStopPrice, 101);
  assert.equal(evaluatePositionManagement({
    position: { ...position, remainingNotionalUsd: 500 },
    candle: candle(2, 108, 111, 107, 110),
  }).reason, 'TARGET2_LEVEL_CLOSE');
  assert.equal(evaluatePositionManagement({
    position, candle: candle(3, 101, 102, 100, 101.2), barsSinceEntry: 5,
  }).reason, 'MANUAL_CUT_NO_FOLLOW_THROUGH');
});

test('paper adapter moves remaining stop to breakeven after target-one scale', () => {
  const telemetry = createPaperTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  adapter.openPosition({
    id: 'breakeven-stop',
    symbol: 'BTCUSDT',
    side: 'long',
    equityUsd: 10000,
    riskPct: 0.5,
    entryPrice: 101,
    stopPrice: 98,
    targets: [105, 110],
    leverage: 3,
    plannedRewardRisk: 3,
    marginMode: 'isolated',
  });
  const opened = adapter.positions.get('breakeven-stop');
  adapter.reduceOnlyExit({
    positionId: 'breakeven-stop',
    notionalUsd: Number(opened.remainingNotionalUsd) / 2,
    price: 105,
    reason: 'TARGET1_EQ_SCALE',
    nextStopPrice: 101,
  });
  assert.equal(adapter.positions.get('breakeven-stop').stopPrice, 101);
});

test('Binance public perps feed reads only completed klines and needs no trading credentials', async () => {
  const urls = [];
  const feed = createBinancePublicPerpsFeed({
    now: () => 3000,
    fetchFn: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => [
          [1000, '100', '101', '99', '100', '10', 1999],
          [2000, '100', '102', '99', '101', '10', 2999],
          [3000, '101', '103', '100', '102', '10', 3999],
        ],
      };
    },
  });
  const rows = await feed.getCompletedCandles('BTCUSDT', '15m', 2);
  assert.equal(rows.length, 2);
  assert.match(urls[0], /\/fapi\/v1\/klines\?/);
  assert.match(urls[0], /symbol=BTCUSDT/);
});

test('native paper scanner opens, scales, and closes a genuine perps lifecycle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-native-scanner-'));
  const telemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json') });
  const adapter = createPaperExecutionAdapter({ telemetry });
  const processor = createPaperSignalProcessor({ adapter, telemetry });
  let phase = 'open';
  // B4P.range recency: range now requires a recent touch on each side. Old
  // fixture only had touches early in the window; extended to include recent
  // touches at both 110 (RH) and 100 (RL) so the range qualifies under the
  // tightened detector.
  const rangeCandles = [
    candle(1, 105, 110, 104, 106), candle(2, 105, 106, 100, 103),
    candle(3, 105, 109.9, 103, 106), candle(4, 104, 106, 100.1, 102),
    candle(5, 103, 109.95, 100.05, 105), candle(6, 104, 108, 100.1, 104),
    candle(7, 104, 109.9, 103, 105), candle(8, 104, 109.95, 100.05, 104),
  ];
  const feed = {
    async getDailyCandles() {
      return [candle(Date.parse('2026-05-25T00:00:00Z'), 100, 103, 99, 101)];
    },
    async getCompletedCandles(_symbol, interval) {
      if (interval === '1h') return [...rangeCandles, candle(9, 104, 105, 103, 104), candle(10, 104, 105, 103, 104)];
      if (interval === '5m') return longMss;
      if (phase === 'open') return longSetup;
      if (phase === 'scale') return [...longSetup, candle(4, 102, 105.5, 101, 105)];
      return [...longSetup, candle(4, 102, 105.5, 101, 105), candle(5, 106, 111, 105, 110)];
    },
  };
  const scanner = createPaperMarketScanner({ processor, telemetry, feed, symbols: ['BTCUSDT'] });
  assert.equal((await scanner.scanAll()).results[0].action, 'OPEN');
  assert.equal(telemetry.listOpenPositions().length, 1);
  phase = 'scale';
  assert.equal((await scanner.scanAll()).results[0].action, 'PARTIAL_EXIT');
  assert.equal(telemetry.listTrades().length, 1);
  phase = 'close';
  assert.equal((await scanner.scanAll()).results[0].action, 'EXIT');
  assert.equal(telemetry.listOpenPositions().length, 0);
  assert.equal(telemetry.stats().closed, 1);
  assert.equal(telemetry.listTrades().every((trade) => trade.market === 'perps'), true);
});

test('native scanner blocks new entries behind failed admission evidence but still manages exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-admission-scanner-'));
  const telemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json') });
  const adapter = createPaperExecutionAdapter({ telemetry });
  const processor = createPaperSignalProcessor({ adapter, telemetry });
  const admission = createPaperStrategyAdmission({ required: true, approvalPath: path.join(dir, 'admission.json') });
  const guardedAdapter = createPaperExecutionAdapter({ telemetry, entryAdmission: admission });
  assert.deepEqual(guardedAdapter.openPosition({
    id: 'direct-open', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).reasons, ['historical_evidence_not_passed']);
  // B4P.range recency: range now requires a recent touch on each side. Old
  // fixture only had touches early in the window; extended to include recent
  // touches at both 110 (RH) and 100 (RL) so the range qualifies under the
  // tightened detector.
  const rangeCandles = [
    candle(1, 105, 110, 104, 106), candle(2, 105, 106, 100, 103),
    candle(3, 105, 109.9, 103, 106), candle(4, 104, 106, 100.1, 102),
    candle(5, 103, 109.95, 100.05, 105), candle(6, 104, 108, 100.1, 104),
    candle(7, 104, 109.9, 103, 105), candle(8, 104, 109.95, 100.05, 104),
  ];
  let closeExisting = false;
  const feed = {
    async getDailyCandles() { return [candle(Date.parse('2026-05-25T00:00:00Z'), 100, 103, 99, 101)]; },
    async getCompletedCandles(_symbol, interval) {
      if (interval === '1h') return [...rangeCandles, candle(9, 104, 105, 103, 104), candle(10, 104, 105, 103, 104)];
      if (interval === '5m') return longMss;
      return closeExisting ? [...longSetup, candle(4, 102, 111, 101, 110)] : longSetup;
    },
  };
  const scanner = createPaperMarketScanner({ processor, telemetry, feed, symbols: ['BTCUSDT'], entryAdmission: admission });
  const blocked = await scanner.scanAll();
  assert.deepEqual(blocked.results[0].reasons, ['historical_evidence_not_passed']);
  assert.equal(telemetry.listOpenPositions().length, 0);
  adapter.openPosition({
    id: 'existing', symbol: 'BTCUSDT', market: 'perps', strategy: 'traderxo_perps',
    setup: 'deviation_reclaim', side: 'long', entryPrice: 101, stopPrice: 98,
    targets: [105, 110], equityUsd: 10000, riskPct: 0.5, leverage: 3,
    plannedRewardRisk: 3, marginMode: 'isolated', openedMarketAt: 1,
  });
  closeExisting = true;
  const managed = await scanner.scanAll();
  assert.equal(managed.results[0].action, 'EXIT');
  assert.equal(telemetry.listOpenPositions().length, 0);
});

test('native scanner reports a symbol feed failure in its health status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-scanner-health-'));
  const telemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json') });
  const processor = createPaperSignalProcessor({ adapter: createPaperExecutionAdapter({ telemetry }), telemetry });
  const scanner = createPaperMarketScanner({
    processor,
    telemetry,
    symbols: ['BTCUSDT'],
    feed: {
      async getCompletedCandles() { throw new Error('market feed down'); },
      async getDailyCandles() { throw new Error('market feed down'); },
    },
  });

  const result = await scanner.scanAll();
  assert.equal(result.results[0].action, 'ERROR');
  assert.match(scanner.getStatus().lastError, /market feed down/);
});
