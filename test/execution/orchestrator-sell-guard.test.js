'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExecutionOrchestrator } = require('../../src/execution/orchestrator');

test('executeSell skips missing or already-closed positions without venue call', async () => {
  let venueCalls = 0;
  let lockReleased = false;
  const orchestrator = createExecutionOrchestrator({
    config: { paperTrading: true, execution: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    portfolio: { positions: {}, stats: {} },
    risk: {},
    positionSizingEngine: { calculateSmallIterationSize: () => 10 },
    positionMutex: { lock: async () => () => { lockReleased = true; } },
    telemetry: { logOrder() {} },
    telemetryUuid: () => 'id-1',
    sqlCoordination: { acquireLock: async () => ({ ok: true, release: async () => {} }) },
    executionFlow: { finalizeSellExecutionState: async () => ({}), handleSellExecutionFailure: async () => {} },
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
    executeBuyViaVenue: async () => ({ txid: 'buy' }),
    executeSellViaVenue: async () => { venueCalls += 1; return { txid: 'sell' }; },
    getNativeQuoteOrThrow: async () => 1,
    ensureStatsShape() {},
    round: (value) => value,
    recoverFailedSellExecutionFromExchange: async () => null,
  });

  await orchestrator.executeSell('kucoin', {}, { symbol: 'ABC', address: 'abc', price: 1 }, null, 1, 'EXIT');
  assert.equal(venueCalls, 0);
  assert.equal(lockReleased, true);
});
