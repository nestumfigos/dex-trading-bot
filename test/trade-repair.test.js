const test = require('node:test');
const assert = require('node:assert/strict');

const { createTradeRepairHelpers } = require('../src/utils/trade-repair');

test('trade repair helpers compute signatures and patch matching trade copies', () => {
  const sharedTrade = {
    timestamp: '2026-05-03T00:00:00.000Z',
    type: 'BUY',
    chain: 'bsc',
    address: '0xABC',
    strategy: 'momentum',
    reason: 'ENTRY',
  };
  const portfolio = {
    trades: [sharedTrade],
    strategies: {
      momentum: { trades: [{ ...sharedTrade }] },
    },
  };

  const helpers = createTradeRepairHelpers({
    portfolio,
    logger: { info() {}, warn() {}, error() {} },
    exchanges: {},
    config: {},
    normalizeChainKey: (chain) => String(chain).toLowerCase(),
    buildTokenKey: (chain, address) => `${chain}:${address}`,
    ensureStatsShape() {},
    extractFilledBaseQty: () => 0,
    extractFilledQuoteUsd: () => 0,
    extractExecutionPriceUsd: () => 0,
    calcSlippageBps: () => 0,
    calcDiscrepancyPct: () => 0,
    round: (value) => value,
    setExecutionJournalState() {},
    refreshPerformanceMetrics() {},
    recordPortfolioSnapshot() {},
    saveState: async () => {},
  });

  const signature = helpers.getTradeRepairSignature(sharedTrade);
  helpers.patchTradeCopiesBySignature(signature, (trade) => { trade.patched = true; });

  assert.equal(helpers.getTradePositionKey(sharedTrade), 'bsc:0xabc:momentum');
  assert.equal(portfolio.trades[0].patched, true);
  assert.equal(portfolio.strategies.momentum.trades[0].patched, true);
});
