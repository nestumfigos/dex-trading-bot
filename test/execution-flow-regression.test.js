const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionFlow } = require('../src/utils/execution-flow');

function createDeps(overrides = {}) {
  const portfolio = {
    balance: 100,
    positions: {},
    strategies: { momentum: { positions: {}, stats: { executions: 0, closedTrades: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, wins: 0, losses: 0 } } },
    stats: { executions: 0, closedTrades: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, wins: 0, losses: 0 },
    runtime: {},
  };
  let symbolMemoryRecord = null;
  let rlRecord = null;
  let safeModeReason = null;
  const deps = {
    config: {
      paperTrading: false,
      execution: { feeProfile: { default: { entryBps: 0, exitBps: 0 } }, sellFailureSafeModeThreshold: 3, sellFailureEscalationWindowMs: 60000 },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    portfolio,
    strategy: { clearHistory() {} },
    telemetry: {
      logOrder() {},
      logFill() {},
      logPositionOpen() {},
      logPositionClose() {},
      logDecision() {},
      logDecisionReflection() {},
      logOpsEvent() {},
    },
    telemetryUuid: (() => { let i = 0; return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`; })(),
    operationalDiagnostics: {},
    risk: {},
    sqlCoordination: {},
    markExecutionConfirmed() {},
    resolveBuyFillMetrics() {},
    resolveSellFillMetrics: () => ({ realizedExitPrice: 12, filledBaseQty: 1, filledQuoteUsd: 12, filledFraction: 1 }),
    setExecutionJournalState() {},
    calcSlippageBps: () => null,
    calcDiscrepancyPct: () => 0,
    recordSlippageSample() {},
    refreshPerformanceMetrics() {},
    buildTokenKey: (chain, address) => `${chain}:${address}`,
    ensureLiquiditySentinel() {},
    releaseLiquiditySentinel() {},
    markTokenBadPattern() {},
    recordTradeBlockState() {},
    sendErrorAlert: async () => {},
    sendTradeAlert: async () => {},
    enterSafeMode: async (reason) => { safeModeReason = reason; portfolio.safeMode = true; },
    saveState: async () => {},
    logTrade() {},
    recordPortfolioSnapshot() {},
    queueDecisionTelemetry() {},
    safeDecisionText: (value) => String(value || ''),
    buildDecisionReflection: () => ({ reflectionId: 'r1', ts: new Date().toISOString(), chainKey: 'kucoin', symbol: 'ABC', strategy: 'momentum', outcome: 'win', pnlUsd: 2, pnlPct: 20, holdDurationHours: 1, reflection: {}, summary: 'ok' }),
    updateAdaptiveSleevePerformance() {},
    updateBrainProfileFromClosedTrade() {},
    strategyBrain: { recordClosedTrade() {} },
    agentMemory: { generateLessonWithAI: async () => {} },
    symbolPnLMemory: { recordTrade: (...args) => { symbolMemoryRecord = args; } },
    rlOnlineUpdater: { updateFromTrade: (entry) => { rlRecord = entry; } },
    round: (value) => value,
    normalizeChainKey: (value) => value,
    updateWalletBalance: async () => {},
    reconcileWalletPositions: async () => {},
    recordExchangeFailure() {},
    recordBuyFailureState() {},
    orderToPositionId: new Map(),
    ...overrides,
  };
  return { deps, portfolio, getSymbolMemoryRecord: () => symbolMemoryRecord, getRlRecord: () => rlRecord, getSafeModeReason: () => safeModeReason };
}

test('closed-trade learning hold time uses openedAt when entryAt is absent', async () => {
  const { deps, portfolio, getSymbolMemoryRecord, getRlRecord } = createDeps();
  const position = {
    key: 'kucoin:abc',
    address: 'abc',
    symbol: 'ABC',
    chainKey: 'kucoin',
    strategy: 'momentum',
    quantity: 1,
    costBasisUsd: 10,
    initialSizeUsd: 10,
    entryPrice: 10,
    openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  };
  portfolio.positions[position.key] = position;
  portfolio.strategies.momentum.positions[position.key] = position;

  const flow = createExecutionFlow(deps);
  await flow.finalizeSellExecutionState({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', address: 'abc', chain: 'KuCoin', price: 12 },
    position,
    txResult: { txid: 'sell1' },
    reason: 'TAKE_PROFIT',
    strategyName: 'momentum',
    expectedExitPrice: 12,
    quantityRequested: 1,
    requestedFraction: 1,
  });

  assert.ok(getSymbolMemoryRecord()[5] >= 29);
  assert.ok(getSymbolMemoryRecord()[5] <= 31);
  assert.ok(getRlRecord().holdMinutes >= 29);
  assert.ok(getRlRecord().holdMinutes <= 31);
});

test('paper cash ledger reconciles net PnL after modeled entry and exit fees', async () => {
  const { deps, portfolio } = createDeps({
    config: {
      paperTrading: true,
      execution: { feeProfile: { default: { entryBps: 100, exitBps: 100 } } },
    },
    risk: {
      stopLossPrice: () => 9,
      takeProfitPrice: () => 12,
    },
    resolveBuyFillMetrics: () => ({
      realizedEntryPrice: 10,
      hasExchangeFilledData: true,
      filledQuoteUsd: 10,
      filledBaseQty: 1,
    }),
  });
  const flow = createExecutionFlow(deps);
  await flow.finalizeBuyExecution({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', address: 'abc', chain: 'KuCoin', price: 10 },
    strategyName: 'momentum',
    txResult: { txid: 'buy1' },
    sizeUsd: 10,
    calculatedSizeUsd: 10,
    entryDelayMs: 0,
    expectedEntryPrice: 10,
    orderId: 'buy-order',
  });
  const position = portfolio.positions['kucoin:abc'];
  await flow.finalizeSellExecutionState({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', address: 'abc', chain: 'KuCoin', price: 12 },
    position,
    txResult: { txid: 'sell1' },
    reason: 'TAKE_PROFIT',
    strategyName: 'momentum',
    expectedExitPrice: 12,
    quantityRequested: 1,
    requestedFraction: 1,
  });
  assert.equal(Number(portfolio.balance.toFixed(2)), 101.78);
  assert.equal(Number(portfolio.stats.totalPnl.toFixed(2)), 1.78);
});

test('paper buy cannot create a position or negative cash when funds are exhausted', async () => {
  const { deps, portfolio } = createDeps({
    config: {
      paperTrading: true,
      execution: { feeProfile: { default: { entryBps: 100, exitBps: 100 } } },
    },
    risk: { stopLossPrice: () => 9, takeProfitPrice: () => 12 },
    resolveBuyFillMetrics: () => ({
      realizedEntryPrice: 10,
      hasExchangeFilledData: true,
      filledQuoteUsd: 10,
      filledBaseQty: 1,
    }),
  });
  portfolio.balance = 5;
  const result = await createExecutionFlow(deps).finalizeBuyExecution({
    chainName: 'kucoin',
    tokenData: { symbol: 'ABC', address: 'abc', chain: 'KuCoin', price: 10 },
    strategyName: 'momentum',
    txResult: { txid: 'rejected-buy' },
    sizeUsd: 10,
    calculatedSizeUsd: 10,
    entryDelayMs: 0,
    expectedEntryPrice: 10,
    orderId: 'buy-order',
  });
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'insufficient_paper_cash');
  assert.equal(portfolio.balance, 5);
  assert.deepEqual(portfolio.positions, {});
});

test('repeated live sell failures escalate to safe mode', async () => {
  const { deps, getSafeModeReason } = createDeps();
  const flow = createExecutionFlow(deps);
  const args = {
    chainName: 'kucoin',
    exchange: {},
    tokenData: { symbol: 'ABC', address: 'abc', price: 1 },
    position: { quantity: 1, currentPrice: 1, entryPrice: 1 },
    quantityToSell: 1,
    strategyName: 'momentum',
    reason: 'TAKE_PROFIT',
    error: new Error('SELL IOC not filled'),
  };

  await flow.handleSellExecutionFailure(args);
  await flow.handleSellExecutionFailure(args);
  await flow.handleSellExecutionFailure(args);

  assert.match(getSafeModeReason(), /Repeated SELL failures/);
});
