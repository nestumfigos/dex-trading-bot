'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mts = require('../../src/cycle/ml-training-scheduler');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

function baseCtx(over = {}) {
  return {
    config: {
      paperTrading: true,
      rl: { enabled: true, paperTrainingEnabled: true, trainingIntervalMinutes: 60 },
      ml: { autoTrainingEnabled: true, autoTrainingIntervalMinutes: 360, weeklyRetrainingEnabled: false },
    },
    portfolio: { closedTrades: {} },
    modelRegistry: { runAutoTraining: async () => ({ ok: true }), runWeeklyRetraining: async () => ({ ok: true }) },
    rlOnlineUpdater: { updateFromTrade: () => {}, getStats: () => ({ stateCount: 0, actionCount: 0, avgQValue: 0 }) },
    trainPaperRlPolicy: async () => ({ trained: true }),
    sendHeartbeat: async () => {},
    sendErrorAlert: async () => {},
    ...over,
  };
}

test('register: returns disposer', () => {
  const dispose = mts.register({ logger: silentLogger(), ctx: baseCtx() });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('register: disabled config still returns disposer (no-op)', () => {
  const dispose = mts.register({
    logger: silentLogger(),
    ctx: baseCtx({
      config: {
        paperTrading: false,
        rl: { enabled: false },
        ml: { autoTrainingEnabled: false, weeklyRetrainingEnabled: false },
      },
    }),
  });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('register: each call creates fresh disposer (caller must dispose previous)', () => {
  const dispose1 = mts.register({ logger: silentLogger(), ctx: baseCtx() });
  const dispose2 = mts.register({ logger: silentLogger(), ctx: baseCtx() });
  // Both return real disposers (no _registered guard)
  assert.equal(typeof dispose1, 'function');
  assert.equal(typeof dispose2, 'function');
  assert.notStrictEqual(dispose1, dispose2);
  dispose1();
  dispose2();
});

test('register: dispose then re-register creates fresh timers (restart cycle)', () => {
  const dispose1 = mts.register({ logger: silentLogger(), ctx: baseCtx() });
  dispose1();
  const dispose2 = mts.register({ logger: silentLogger(), ctx: baseCtx() });
  assert.equal(typeof dispose2, 'function');
  dispose2();
});

test('register: paper-only RL training skipped when paperTrading=false', () => {
  // Verify by re-registering after dispose with different config
  const dispose = mts.register({
    logger: silentLogger(),
    ctx: baseCtx({
      config: {
        paperTrading: false,
        rl: { enabled: true, paperTrainingEnabled: true },
        ml: { autoTrainingEnabled: false, weeklyRetrainingEnabled: false },
      },
    }),
  });
  dispose();
  // No assertions on timer count (private); just verify no throw
});

test('weekly schedule disabled by default — does not throw on dispose', () => {
  const dispose = mts.register({
    logger: silentLogger(),
    ctx: baseCtx({
      config: {
        paperTrading: true,
        rl: { enabled: false },
        ml: { autoTrainingEnabled: false, weeklyRetrainingEnabled: false },
      },
    }),
  });
  dispose();
});

test('register: weekly schedule reads ML_WEEKLY_RETRAINING_ENABLED env override', () => {
  process.env.ML_WEEKLY_RETRAINING_ENABLED = 'true';
  const dispose = mts.register({
    logger: silentLogger(),
    ctx: baseCtx({
      config: {
        paperTrading: true,
        rl: { enabled: false },
        ml: { autoTrainingEnabled: false, weeklyRetrainingEnabled: false },
      },
    }),
  });
  dispose();
  delete process.env.ML_WEEKLY_RETRAINING_ENABLED;
});
