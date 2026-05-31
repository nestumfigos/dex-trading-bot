const test = require('node:test');
const assert = require('node:assert/strict');

const PositionSizingEngine = require('../src/utils/position-sizing');

test('position sizing uses free cash without subtracting open cost basis twice', () => {
  const engine = new PositionSizingEngine({
    logger: console,
    config: { risk: { maxPositionSizePct: 20, minPositionSizeUsd: 5 } },
  });
  const portfolio = {
    balance: 100,
    positions: {
      a: { symbol: 'AAA', costBasisUsd: 80 },
    },
    trades: [],
  };

  assert.equal(engine.getAvailableBalance(portfolio), 99.5);
  assert.ok(engine.calculateSmallIterationSize({ symbol: 'BBB', confidence: 75 }, portfolio) >= 5);
});

test('position sizing treats real zero cash as exhausted capital and full drawdown', () => {
  const engine = new PositionSizingEngine({
    logger: console,
    config: { risk: { maxPositionSizePct: 20, minPositionSizeUsd: 5 } },
  });
  const portfolio = { balance: 0, peakBalance: 100, positions: {}, trades: [] };
  assert.equal(engine.getAvailableBalance(portfolio), 0);
  assert.equal(engine.calculateDrawdown(portfolio), 100);
});

test('position sizing learns from sell trades when closedTrades is a numeric count', () => {
  const now = new Date().toISOString();
  const engine = new PositionSizingEngine({
    logger: console,
    config: { risk: { maxPositionSizePct: 10, minPositionSizeUsd: 5 } },
  });
  const portfolio = {
    balance: 1000,
    positions: {},
    closedTrades: 2,
    trades: [
      { type: 'BUY', symbol: 'AAA', timestamp: now },
      { type: 'SELL', symbol: 'AAA', pnl: 2, timestamp: now },
      { type: 'SELL', symbol: 'AAA', pnl: -1, timestamp: now },
    ],
  };

  assert.equal(engine.getRecentTradesForSymbol(portfolio, 'AAA').length, 2);
  assert.equal(engine.getIterationNumber(portfolio, 'AAA'), 3);
});

test('reduce sizing preserves fractional token quantities', () => {
  const engine = new PositionSizingEngine({
    logger: console,
    config: { risk: { takeProfitPct: 20 } },
  });
  assert.ok(Math.abs(engine.calculateReduceSizing({ quantity: 0.75, entryPrice: 100, currentPrice: 116 }) - 0.3) < 1e-12);
  assert.equal(engine.calculateReduceSizing({ quantity: 0.75, entryPrice: 100, currentPrice: 111 }), 0.1875);
});
