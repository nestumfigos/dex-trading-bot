const test = require('node:test');
const assert = require('node:assert/strict');

const { createResearchHandlers } = require('../src/utils/research-handlers');

test('research handlers run standard backtest request and store result', async () => {
  const marketState = { backtests: [] };
  const strategy = {
    priceHistory: { 'kucoin:btc': [1, 2, 3] },
    volumeHistory: { 'kucoin:btc': [4, 5, 6] },
  };

  const handlers = createResearchHandlers({
    config: { paperBalance: 1000, risk: {}, strategies: { momentum: { name: 'momentum' } } },
    logger: { info() {}, warn() {}, error() {} },
    marketState,
    strategy,
    exchanges: {},
    CHAIN_LABELS: { kucoin: 'KuCoin' },
    normalizeChainKey: (chain) => String(chain).toLowerCase(),
    buildTokenKey: (chain, token) => `${chain}:${String(token).toLowerCase()}`,
    getTrackedTokens: () => [{ address: 'BTC', symbol: 'BTC', chain: 'KuCoin' }],
    getPortfolioSnapshot: () => ({}),
    getHistorySeries: (bucket, chain, token) => bucket[`${chain}:${String(token).toLowerCase()}`] || [],
    getOhlcvSeries: () => [],
    runBacktest: (priceHistory, volumeHistory) => ({ totalReturn: 12, trades: 3, historyBars: priceHistory.length + volumeHistory.length }),
    runBacktestWithRegimes: () => null,
    runWalkForwardBacktest: () => null,
    runRegimeSpecificBacktest: () => null,
    runPortfolioBacktest: () => null,
    runPaperSimulation: () => null,
    runHyperopt: () => null,
    runValidation: () => null,
    buildBaseBacktestOptions: () => ({}),
    AITradeBrain: class {},
    recordBrainSuccess() {},
    recordBrainFailure() {},
    refreshBrainAvailability() {},
    round: (value) => value,
  });

  const result = await handlers.runBacktestRequest({ tokenAddress: 'BTC', chain: 'kucoin', strategy: 'momentum' });

  assert.equal(result.symbol, 'BTC');
  assert.equal(result.chain, 'KuCoin');
  assert.equal(marketState.backtests.length, 1);
});
