'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionOrchestrator } = require('../../src/execution/orchestrator');

function makeDeps(overrides = {}) {
  const captured = { buyArgs: [], logs: [] };
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
    telemetry: { logOrder() {} },
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
