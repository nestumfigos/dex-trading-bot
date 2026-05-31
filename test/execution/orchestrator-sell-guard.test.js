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

test('executeSell finalizes successful venue sells with the actual tx result', async () => {
  const previousSqlEnabled = process.env.SQL_ENABLED;
  process.env.SQL_ENABLED = 'false';

  let venueCalls = 0;
  let recoveryCalls = 0;
  let failureCalls = 0;
  let lockReleased = false;
  let finalizedPayload = null;
  const position = {
    symbol: 'ABC',
    address: 'abc',
    quantity: 4,
    entryPrice: 10,
    strategy: 'momentum',
  };

  try {
    const orchestrator = createExecutionOrchestrator({
      config: { paperTrading: true, execution: { sellTimeoutMs: 30000 } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      portfolio: { positions: { abc: position }, stats: {} },
      risk: {},
      positionSizingEngine: { calculateSmallIterationSize: () => 10 },
      positionMutex: { lock: async () => () => { lockReleased = true; } },
      telemetry: { logOrder() {} },
      telemetryUuid: () => 'id-1',
      sqlCoordination: { acquireLock: async () => ({ ok: true, release: async () => {} }) },
      executionFlow: {
        finalizeSellExecutionState: async (payload) => {
          finalizedPayload = payload;
          return { ok: true };
        },
        handleSellExecutionFailure: async () => { failureCalls += 1; },
      },
      runPreTradeContract: async (payload) => {
        assert.equal(payload.side, 'SELL');
        return { ok: true };
      },
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
      executeSellViaVenue: async ({ quantityToSell }) => {
        venueCalls += 1;
        assert.equal(quantityToSell, 2);
        return { txid: 'sell-ok', filledQuantity: 2 };
      },
      getNativeQuoteOrThrow: async () => 1,
      ensureStatsShape() {},
      round: (value) => value,
      recoverFailedSellExecutionFromExchange: async () => {
        recoveryCalls += 1;
        return null;
      },
    });

    await orchestrator.executeSell(
      'kucoin',
      {},
      { symbol: 'ABC', address: 'abc', price: 12 },
      position,
      0.5,
      'TAKE_PROFIT',
    );

    assert.equal(venueCalls, 1);
    assert.equal(recoveryCalls, 0);
    assert.equal(failureCalls, 0);
    assert.equal(lockReleased, true);
    assert.equal(position.exitInProgress, false);
    assert.equal(finalizedPayload.txResult.txid, 'sell-ok');
    assert.equal(finalizedPayload.quantityRequested, 2);
    assert.equal(finalizedPayload.requestedFraction, 0.5);
  } finally {
    if (previousSqlEnabled === undefined) delete process.env.SQL_ENABLED;
    else process.env.SQL_ENABLED = previousSqlEnabled;
  }
});
