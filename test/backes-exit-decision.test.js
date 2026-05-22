'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideExitAction } = require('../src/exits/evaluate-exit-decision');

const NOW = 1_730_000_000_000;
const DAY_MS = 86_400_000;

function pos(overrides = {}) {
  return {
    setupType: 'backes_swing',
    entryPrice: 100,
    structuralStopPrice: 90,
    invalidationPrice: 90,
    targetPrices: [110, 120],
    openedAt: new Date(NOW - 5 * DAY_MS).toISOString(),
    ...overrides,
  };
}

test('backes exit: invalidation stop sells all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 89 }, now: NOW });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BACKES_INVALIDATION_STOP');
  assert.equal(result.sellPct, 1);
});

test('backes exit: partial 50 percent at 1R', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 110 }, now: NOW });
  assert.equal(result.reason, 'BACKES_PARTIAL_1R');
  assert.equal(result.sellPct, 0.5);
  assert.equal(result.mutations.backesPartial1Taken, true);
});

test('backes exit: structure target partial after 1R taken', () => {
  const result = decideExitAction({ position: pos({ backesPartial1Taken: true }), tokenData: { price: 112 }, now: NOW });
  assert.equal(result.reason, 'BACKES_STRUCTURE_TARGET');
  assert.equal(result.sellPct, 0.5);
  assert.equal(result.mutations.backesStructureTargetTaken, true);
});

test('backes exit: trail behind 8D MA after trend confirm', () => {
  const result = decideExitAction({ position: pos({ backesPartial1Taken: true, backesStructureTargetTaken: true }), tokenData: { price: 104, ma8d: 105 }, now: NOW });
  assert.equal(result.reason, 'BACKES_TRAIL_8D_MA');
});

test('backes exit: daily close below 56D exits all', () => {
  const result = decideExitAction({ position: pos({ backesPartial1Taken: true, backesStructureTargetTaken: true }), tokenData: { price: 99, ma56d: 100 }, now: NOW });
  assert.equal(result.reason, 'BACKES_DAILY_CLOSE_BELOW_56D');
});

test('backes exit: explicit daily close below 56D flag exits all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 101, dailyCloseBelow56d: true }, now: NOW });
  assert.equal(result.reason, 'BACKES_DAILY_CLOSE_BELOW_56D');
});

test('backes exit: weekly close below 8W flag exits all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 101, weeklyCloseBelow8w: true }, now: NOW });
  assert.equal(result.reason, 'BACKES_WEEKLY_CLOSE_BELOW_8W');
});

test('backes exit: failed reclaim exits all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 101, failedReclaim: true }, now: NOW });
  assert.equal(result.reason, 'BACKES_FAILED_RECLAIM');
});

test('backes exit: RSI exhaustion with sell volume exits all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 101, rsi: 82, sellRatio10mPct: 65 }, now: NOW });
  assert.equal(result.reason, 'BACKES_RSI_EXHAUSTION_SELL_VOLUME');
});

test('backes exit: configurable time stop exits all', () => {
  const result = decideExitAction({
    position: pos({ openedAt: new Date(NOW - 50 * DAY_MS).toISOString() }),
    tokenData: { price: 101 },
    strategyCfg: { backesMaxHoldDays: 45 },
    now: NOW,
  });
  assert.equal(result.reason, 'BACKES_TIME_STOP');
});

test('backes exit: strategy exit still respected after structural checks', () => {
  const result = decideExitAction({
    position: pos({ backesPartial1Taken: true, backesStructureTargetTaken: true }),
    tokenData: { price: 101 },
    exitSignal: { shouldExit: true, reason: 'BACKES_CUSTOM_EXIT' },
    now: NOW,
  });
  assert.equal(result.reason, 'BACKES_CUSTOM_EXIT');
});

test('backes exit: no trigger holds and skips generic tiers', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 105 },
    sellTiers: [{ profitMultiplier: 1.02, sellPct: 1 }],
    now: NOW,
  });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'backes_hold');
});
