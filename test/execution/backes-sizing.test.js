'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionOrchestrator } = require('../../src/execution/orchestrator');

function makeDeps(overrides = {}) {
  const captured = { buyArgs: [], finalized: [] };
  const portfolio = overrides.portfolio || {
    balance: 10_000,
    positions: {},
    stats: { todaysPnl: 0, consecutiveLosses: 0 },
  };
  const deps = {
    config: {
      paperTrading: true,
      strategies: { backes_swing: { maxConcurrentPositions: 3 } },
      risk: { maxPositionSizePct: 3 },
      execution: {},
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    portfolio,
    risk: { positionSize: () => 99 },
    positionSizingEngine: { calculateSmallIterationSize: () => overrides.fallbackSize || 42 },
    positionMutex: { lock: async () => () => {} },
    telemetry: { logOrder() {} },
    telemetryUuid: (() => { let i = 0; return () => `id-${++i}`; })(),
    sqlCoordination: { acquireLock: async () => ({ ok: true, release: async () => {} }) },
    executionFlow: {
      runBuyPreflightChecks: () => ({ ok: true }),
      finalizeBuyExecution: async (args) => {
        captured.finalized.push(args);
        return {};
      },
      handleBuyExecutionFailure: async () => {},
    },
    runPreTradeContract: async () => ({ ok: true }),
    aiCircuit: { cooldownUntil: 0 },
    AITradeBrain: { hasAnyEnabledProvider: () => false },
    BOT_PROFILE: 'paper',
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
  return { orchestrator: createExecutionOrchestrator(deps), captured, portfolio };
}

function token(overrides = {}) {
  return {
    symbol: 'SOL',
    address: 'SOL/USDT',
    chain: 'KuCoin',
    chainKey: 'kucoin',
    price: 100,
    setupType: 'backes_swing',
    structuralStopPrice: 90,
    _backesRiskPct: 0.5,
    _macroSizeMultiplier: 1,
    ...overrides,
  };
}

async function runBuy(harness, tokenData = token()) {
  await harness.orchestrator.executeBuy('kucoin', {}, tokenData, 'backes_swing');
  return harness.captured.buyArgs[0]?.sizeUsd ?? null;
}

test('backes sizing uses equity risk divided by stop distance', async () => {
  const harness = makeDeps();
  assert.equal(await runBuy(harness), 500);
});

test('backes sizing applies macro multiplier', async () => {
  const harness = makeDeps();
  assert.equal(await runBuy(harness, token({ _macroSizeMultiplier: 0.8 })), 400);
});

test('backes sizing uses 0.2 percent risk for capitulation fallback', async () => {
  const harness = makeDeps();
  assert.equal(await runBuy(harness, token({ _backesRiskPct: null, macroRegime: 'capitulation' })), 200);
});

test('backes sizing caps total exposure at 25 percent equity', async () => {
  const harness = makeDeps({
    portfolio: {
      balance: 10_000,
      positions: { old: { setupType: 'backes_swing', costBasisUsd: 2400 } },
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
  });
  assert.equal(await runBuy(harness), 100);
});

test('backes sizing skips when exposure cap is already full', async () => {
  const harness = makeDeps({
    portfolio: {
      balance: 10_000,
      positions: { old: { setupType: 'backes_swing', costBasisUsd: 2500 } },
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
  });
  assert.equal(await runBuy(harness), null);
});

test('backes sizing skips at max concurrent positions', async () => {
  const harness = makeDeps({
    portfolio: {
      balance: 10_000,
      positions: {
        a: { setupType: 'backes_swing', costBasisUsd: 100 },
        b: { setupType: 'backes_swing', costBasisUsd: 100 },
        c: { setupType: 'backes_swing', costBasisUsd: 100 },
      },
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
  });
  assert.equal(await runBuy(harness), null);
});

test('backes sizing counts strategy field toward max concurrent', async () => {
  const harness = makeDeps({
    portfolio: {
      balance: 10_000,
      positions: {
        a: { strategy: 'backes_swing', costBasisUsd: 100 },
        b: { strategy: 'backes_swing', costBasisUsd: 100 },
        c: { strategy: 'backes_swing', costBasisUsd: 100 },
      },
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
  });
  assert.equal(await runBuy(harness), null);
});

test('backes sizing falls back to iteration engine when stop distance missing', async () => {
  const harness = makeDeps({ fallbackSize: 42 });
  assert.equal(await runBuy(harness, token({ structuralStopPrice: 0, invalidationPrice: 0 })), 42);
});

test('backes sizing falls back to iteration engine when entry price missing', async () => {
  const harness = makeDeps({ fallbackSize: 44 });
  assert.equal(await runBuy(harness, token({ price: 0 })), 44);
});

test('backes sizing skips tiny capped positions below exchange minimum', async () => {
  const harness = makeDeps({
    portfolio: {
      balance: 10_000,
      positions: { old: { setupType: 'backes_swing', costBasisUsd: 2499 } },
      stats: { todaysPnl: 0, consecutiveLosses: 0 },
    },
  });
  assert.equal(await runBuy(harness), null);
});
