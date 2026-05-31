'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionOrchestrator } = require('../../src/execution/orchestrator');

function makeDeps(overrides = {}) {
  const captured = { buyArgs: [] };
  const portfolio = overrides.portfolio || {
    balance: 10_000,
    positions: {},
    stats: { todaysPnl: 0, consecutiveLosses: 0 },
  };
  const deps = {
    config: {
      paperTrading: true,
      strategies: { bsc_flow_breakout: { riskPct: 0.2, maxSlippagePct: 3, useMevJitter: true } },
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
      finalizeBuyExecution: async () => ({}),
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
    getNativeQuoteOrThrow: async () => 300,
    ensureStatsShape() {},
    round: (value) => value,
    recoverFailedSellExecutionFromExchange: async () => null,
    ...overrides.deps,
  };
  return { orchestrator: createExecutionOrchestrator(deps), captured, portfolio };
}

function token(overrides = {}) {
  return {
    symbol: 'BSCX',
    address: '0x0000000000000000000000000000000000000001',
    chain: 'BSC',
    chainKey: 'bsc',
    price: 1,
    setupType: 'bsc_flow_breakout',
    structuralStopPrice: 0.92,
    _strategyRiskPct: 0.2,
    _strategyMaxSlippagePct: 3,
    useMevJitter: true,
    ...overrides,
  };
}

async function runBuy(harness, tokenData = token()) {
  await harness.orchestrator.executeBuy('bsc', {}, tokenData, 'bsc_flow_breakout');
  return harness.captured.buyArgs[0] || null;
}

test('bsc flow sizing uses 0.2 percent equity risk divided by structural stop', async () => {
  const harness = makeDeps();
  const args = await runBuy(harness);
  assert.ok(Math.abs(args.sizeUsd - 250) < 1e-9);
});

test('bsc flow sizing clamps low risk to 0.15 percent', async () => {
  const harness = makeDeps();
  const args = await runBuy(harness, token({ _strategyRiskPct: 0.05 }));
  assert.ok(Math.abs(args.sizeUsd - 187.5) < 1e-9);
});

test('bsc flow sizing clamps high risk to 0.25 percent', async () => {
  const harness = makeDeps();
  const args = await runBuy(harness, token({ _strategyRiskPct: 1 }));
  assert.equal(args.sizeUsd, 300);
});

test('bsc flow sizing caps requested position at max risk size percent', async () => {
  const harness = makeDeps();
  const args = await runBuy(harness, token({ structuralStopPrice: 0.99 }));
  assert.equal(args.sizeUsd, 300);
});

test('positive execution jitter cannot exceed the approved position cap', async () => {
  const harness = makeDeps({ deps: { applyPositionJitter: (value) => value * 1.15 } });
  const args = await runBuy(harness, token({ structuralStopPrice: 0.99 }));
  assert.equal(args.sizeUsd, 300);
});

test('paper buy fails closed when final pre-trade validation throws', async () => {
  const harness = makeDeps({ deps: { runPreTradeContract: async () => { throw new Error('risk unavailable'); } } });
  await runBuy(harness);
  assert.equal(harness.captured.buyArgs.length, 0);
});

test('bsc flow sizing passes 3 percent slippage cap and Merkle jitter to venue', async () => {
  const harness = makeDeps();
  const tokenData = token({ _strategyMaxSlippagePct: 10 });
  await runBuy(harness, tokenData);
  assert.equal(tokenData.maxSlippageBps, 300);
  assert.equal(tokenData.useMevJitter, true);
});

test('bsc flow sizing falls back when stop distance is missing', async () => {
  const harness = makeDeps({ fallbackSize: 44 });
  const args = await runBuy(harness, token({ structuralStopPrice: 0, invalidationPrice: 0 }));
  assert.equal(args.sizeUsd, 44);
});

test('buy lock ttl follows actual buy timeout plus buffer', async () => {
  let ttlMs = 0;
  const harness = makeDeps({
    deps: {
      config: {
        paperTrading: true,
        strategies: { bsc_flow_breakout: { riskPct: 0.2, maxSlippagePct: 3, useMevJitter: true } },
        risk: { maxPositionSizePct: 3 },
        execution: { buyTimeoutMs: 90_000 },
      },
      sqlCoordination: {
        acquireLock: async (_key, options) => {
          ttlMs = options.ttlMs;
          return { ok: true, release: async () => {} };
        },
      },
    },
  });
  await runBuy(harness);
  assert.equal(ttlMs, 100_000);
});
