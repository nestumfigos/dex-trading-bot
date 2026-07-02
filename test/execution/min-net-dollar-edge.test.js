'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionOrchestrator } = require('../../src/execution/orchestrator');

function makeDeps(overrides = {}) {
  const captured = { buyArgs: [], logs: [], events: [] };
  const deps = {
    config: {
      paperTrading: false,
      strategies: {},
      risk: {
        maxPositionSizePct: 100,
        minNetExpectedEdgeUsd: 0.25,
      },
      execution: {
        slippageBps: 20,
        feeProfile: { kucoin: { entryBps: 10, exitBps: 10 } },
      },
    },
    logger: {
      info(message) { captured.logs.push(String(message)); },
      warn() {},
      error() {},
      debug() {},
    },
    portfolio: {
      balance: 1000,
      positions: {},
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
    risk: { positionSize: () => 10 },
    positionSizingEngine: { calculateSmallIterationSize: () => 10 },
    positionMutex: { lock: async () => () => {} },
    telemetry: { logOrder() {}, logTradingEvent: (event) => captured.events.push(event) },
    telemetryUuid: (() => { let i = 0; return () => `id-${++i}`; })(),
    sqlCoordination: { acquireLock: async () => ({ ok: true, release: async () => {} }) },
    executionFlow: {
      runBuyPreflightChecks: () => ({ ok: true }),
      finalizeBuyExecution: async () => ({}),
      handleBuyExecutionFailure: async () => {},
    },
    runPreTradeContract: async () => ({ ok: true }),
    aiCircuit: { cooldownUntil: 0 },
    AITradeBrain: { hasAnyEnabledProvider: () => false },
    BOT_PROFILE: 'live',
    applyPositionJitter: (value) => value,
    getRandomEntryDelay: () => 0,
    sleep: async () => {},
    withTimeout: async (promise) => promise,
    shouldSplitSolanaTrade: () => false,
    generateSplitTradeSchedule: () => [],
    executeBuyViaVenue: async (args) => {
      captured.buyArgs.push(args);
      return { txid: 'buy-1' };
    },
    executeSellViaVenue: async () => ({ txid: 'sell-1' }),
    getNativeQuoteOrThrow: async () => 1,
    ensureStatsShape() {},
    round: (value) => value,
    recoverFailedSellExecutionFromExchange: async () => null,
    ...overrides.deps,
  };
  return { orchestrator: createExecutionOrchestrator(deps), captured };
}

function token(overrides = {}) {
  return {
    symbol: 'EDGE',
    address: 'EDGE/USDT',
    chain: 'KuCoin',
    chainKey: 'kucoin',
    price: 100,
    measuredMoveTargetPrice: 101,
    expectedFeesBps: 20,
    expectedSlippageBps: 20,
    expectedSpreadBps: 0,
    ...overrides,
  };
}

test('live buy skips when expected net dollar edge is below floor', async () => {
  const harness = makeDeps();

  await harness.orchestrator.executeBuy('kucoin', {}, token(), 'momentum');

  assert.equal(harness.captured.buyArgs.length, 0);
  assert.ok(harness.captured.logs.some((line) => line.includes('[net-edge] EDGE skipped')));
});

test('live buy proceeds when expected net dollar edge clears floor', async () => {
  const harness = makeDeps();

  await harness.orchestrator.executeBuy('kucoin', {}, token({ measuredMoveTargetPrice: 110 }), 'momentum');

  assert.equal(harness.captured.buyArgs.length, 1);
  assert.equal(harness.captured.buyArgs[0].sizeUsd, 10);
});

test('live buy passes exposure rows and proposed risk into pre-trade contract', async () => {
  const preTradeCalls = [];
  const harness = makeDeps({
    deps: {
      config: {
        paperTrading: false,
        strategies: { momentum: { riskPct: 0.5 } },
        risk: {
          maxPositionSizePct: 100,
          minNetExpectedEdgeUsd: 0.25,
          v2TargetPortfolioHeatPct: 2,
          v2MaxPortfolioHeatPct: 3,
          v2ProfileRiskBudgetsPct: { live_spot: 2 },
          v2StrategyRiskBudgetsPct: { momentum: 1.5 },
        },
        execution: {
          slippageBps: 20,
          feeProfile: { kucoin: { entryBps: 10, exitBps: 10 } },
        },
      },
      portfolio: {
        balance: 1000,
        positions: {
          btc: {
            symbol: 'BTCUSDT',
            chainKey: 'kucoin',
            strategy: 'momentum',
            quantity: 2,
            entryPrice: 100,
            currentPrice: 105,
            stopLoss: 95,
            costBasisUsd: 200,
            unrealizedPnlUsd: 10,
          },
        },
        stats: { todaysPnl: 0, consecutiveLosses: 0 },
      },
      runPreTradeContract: async (args) => {
        preTradeCalls.push(args);
        return { ok: true };
      },
    },
  });

  await harness.orchestrator.executeBuy(
    'kucoin',
    {},
    token({ measuredMoveTargetPrice: 110, stopPrice: 98 }),
    'momentum',
  );

  assert.equal(harness.captured.buyArgs.length, 1);
  assert.equal(preTradeCalls.length, 1);

  const [call] = preTradeCalls;
  assert.equal(call.trade.notionalUsd, 10);
  assert.equal(call.trade.riskUsd, 0.2);
  assert.equal(call.trade.maxLossUsd, 0.2);
  assert.equal(call.trade.marketType, 'spot');
  assert.equal(call.trade.correlationKey, 'kucoin');

  assert.equal(call.state.portfolioExposures.length, 1);
  assert.deepEqual(call.state.portfolioExposures[0], {
    botProfile: 'live_spot',
    marketType: 'spot',
    symbol: 'BTCUSDT',
    strategy: 'momentum',
    notionalUsd: 210,
    riskUsd: 10,
    unrealizedPnlUsd: 10,
    correlationKey: 'kucoin',
  });
  assert.equal(call.config.targetPortfolioHeatPct, 2);
  assert.equal(call.config.maxPortfolioHeatPct, 3);
  assert.deepEqual(call.config.profileRiskBudgetsPct, { live_spot: 2 });
  assert.deepEqual(call.config.strategyRiskBudgetsPct, { momentum: 1.5 });
});

test('live buy emits first-class V2 risk audit event for advisory core block', async () => {
  const harness = makeDeps({
    deps: {
      runPreTradeContract: async () => ({
        ok: true,
        v2RiskAudit: {
          enabled: true,
          advisoryOnly: true,
          allow: false,
          reasons: ['expected_net_edge_below_min'],
          legacyBlocked: false,
          coreBlocked: true,
          disagreement: true,
          input: { botProfile: 'live_spot', strategy: 'momentum', symbol: 'EDGE' },
        },
      }),
    },
  });

  await harness.orchestrator.executeBuy('kucoin', {}, token({ measuredMoveTargetPrice: 110, signalId: 'sig-1' }), 'momentum');

  const audit = harness.captured.events.find((event) => event.eventName === 'risk.audit');
  assert.equal(harness.captured.buyArgs.length, 1);
  assert.equal(audit.symbol, 'EDGE');
  assert.equal(audit.strategy, 'momentum');
  assert.equal(audit.correlationId, 'sig-1');
  assert.equal(audit.severity, 'warn');
  assert.equal(audit.payload.advisoryOnly, true);
  assert.deepEqual(audit.payload.reasons, ['expected_net_edge_below_min']);
  assert.equal(audit.payload.coreBlocked, true);
  assert.equal(audit.payload.legacyBlocked, false);
});
