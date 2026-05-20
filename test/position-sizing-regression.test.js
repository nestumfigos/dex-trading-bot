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
