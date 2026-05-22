const test = require('node:test');
const assert = require('node:assert/strict');

const { createScanOrchestration } = require('../src/utils/scan-orchestration');

test('scan orchestration runs enabled momentum chains and saves state once', async () => {
  const calls = [];
  const loopLocks = {};
  const loopLastCompletedAt = {};
  const filterStatsState = { currentCycle: { momentum: { evaluated: 0 } } };
  const statuses = {};
  const scanStatus = { solana: {}, bsc: {}, kucoin: {} };

  const orchestration = createScanOrchestration({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { bot: {}, risk: {} },
    exchanges: {
      solana: { name: 'Solana' },
      bsc: { name: 'BSC' },
      kucoin: { name: 'KuCoin' },
    },
    marketState: { trackedTokens: {} },
    scanStatus,
    filterStatsState,
    loopLocks,
    loopLastCompletedAt,
    getStrategyScanStatus(chain, strategy) {
      const key = `${chain}:${strategy}`;
      statuses[key] = statuses[key] || { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0 };
      return statuses[key];
    },
    isExchangeAvailable() { return true; },
    syncChainScanStatus() {},
    async getTokensForStrategy(chainName) {
      return chainName === 'solana' ? ['AAA'] : ['BBB'];
    },
    async refreshKucoinCatalystCache() { return []; },
    getPrioritizedKucoinCatalystPairs() { return []; },
    getBscDiscoveryRankSummary() { return { lanes: 1 }; },
    getRotatingScanWindow(tokens) { return tokens; },
    async sleep() {},
    async processToken(chainName, exchange, tokenAddress, options) {
      calls.push({ chainName, tokenAddress, options });
    },
    async withTimeout(promise) { return promise; },
    recordExchangeSuccess() {},
    recordExchangeFailure() {},
    isWithinTradingWindow() { return true; },
    startFilterCycle() {},
    finalizeFilterCycle() {},
    isStrategyScanEnabled() { return true; },
    recordPortfolioSnapshot(reason) { calls.push({ snapshot: reason }); },
    async saveState() { calls.push({ save: true }); },
    refreshScanInFlightFlag() {},
    shouldPauseKucoinEntryScans() { return { paused: false, msUntilReset: 0 }; },
  });

  await orchestration.runStrategyScanCycle('momentum');

  assert.equal(calls.filter((entry) => entry.tokenAddress).length, 3);
  assert.ok(calls.some((entry) => entry.snapshot === 'scan_momentum'));
  assert.ok(calls.some((entry) => entry.save === true));
  assert.equal(loopLocks.momentumScan, false);
  assert.ok(Number.isFinite(loopLastCompletedAt.momentumScan));
});

test('scan orchestration pauses detached kucoin scan when gate is active', async () => {
  let scanned = false;
  const orchestration = createScanOrchestration({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: { bot: {}, risk: {} },
    exchanges: { kucoin: { name: 'KuCoin' } },
    marketState: { trackedTokens: {} },
    scanStatus: { kucoin: {} },
    filterStatsState: { currentCycle: {} },
    loopLocks: {},
    loopLastCompletedAt: {},
    getStrategyScanStatus() { return {}; },
    isExchangeAvailable() { return true; },
    syncChainScanStatus() {},
    getTokensForStrategy() { return []; },
    refreshKucoinCatalystCache() { return []; },
    getPrioritizedKucoinCatalystPairs() { return []; },
    getBscDiscoveryRankSummary() { return null; },
    getRotatingScanWindow(tokens) { return tokens; },
    async sleep() {},
    async processToken() { scanned = true; },
    async withTimeout(promise) { return promise; },
    recordExchangeSuccess() {},
    recordExchangeFailure() {},
    isWithinTradingWindow() { return true; },
    startFilterCycle() {},
    finalizeFilterCycle() {},
    isStrategyScanEnabled() { return true; },
    recordPortfolioSnapshot() {},
    async saveState() {},
    refreshScanInFlightFlag() {},
    shouldPauseKucoinEntryScans() { return { paused: true, reason: 'gate', msUntilReset: 60_000 }; },
  });

  await orchestration.runDetachedKucoinMomentumScan();
  assert.equal(scanned, false);
});
