'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideExitAction } = require('../src/exits/evaluate-exit-decision');

const NOW = 1_730_000_000_000;
const MIN_MS = 60_000;

function pos(overrides = {}) {
  return {
    setupType: 'bsc_flow_breakout',
    entryPrice: 1,
    structuralStopPrice: 0.92,
    measuredMoveTargetPrice: 1.14,
    staleExitMinutes: 30,
    openedAt: new Date(NOW - 10 * MIN_MS).toISOString(),
    ...overrides,
  };
}

test('bsc flow exit: structural stop sells all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 0.91 }, now: NOW });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BSC_FLOW_STRUCTURAL_STOP');
  assert.equal(result.sellPct, 1);
});

test('bsc flow exit: quick measured-move TP sells all', () => {
  const result = decideExitAction({ position: pos(), tokenData: { price: 1.15 }, now: NOW });
  assert.equal(result.reason, 'BSC_FLOW_QUICK_TP');
  assert.equal(result.sellPct, 1);
});

test('bsc flow exit: 30 minute stale exit sells when no follow-through', () => {
  const result = decideExitAction({
    position: pos({ openedAt: new Date(NOW - 31 * MIN_MS).toISOString() }),
    tokenData: { price: 1.005 },
    now: NOW,
  });
  assert.equal(result.reason, 'BSC_FLOW_STALE_EXIT');
});

test('bsc flow exit: stale exit does not fire before 30 minutes', () => {
  const result = decideExitAction({
    position: pos({ openedAt: new Date(NOW - 20 * MIN_MS).toISOString() }),
    tokenData: { price: 1.005 },
    now: NOW,
  });
  assert.equal(result.reason, 'bsc_flow_hold');
});

test('bsc flow exit: stale exit does not fire after enough follow-through', () => {
  const result = decideExitAction({
    position: pos({ openedAt: new Date(NOW - 40 * MIN_MS).toISOString() }),
    tokenData: { price: 1.02 },
    now: NOW,
  });
  assert.equal(result.reason, 'bsc_flow_hold');
});

test('bsc flow exit: strategy exit is respected after structural checks', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 1.03 },
    exitSignal: { shouldExit: true, reason: 'BSC_FLOW_FLOW_REVERSAL' },
    now: NOW,
  });
  assert.equal(result.reason, 'BSC_FLOW_FLOW_REVERSAL');
});

test('bsc flow exit: stale data suppresses strategy exit', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 1.03 },
    exitSignal: { shouldExit: true, reason: 'BSC_FLOW_FLOW_REVERSAL' },
    staleData: true,
    now: NOW,
  });
  assert.equal(result.reason, 'bsc_flow_hold');
});

test('bsc flow exit: invalidation price can provide structural stop', () => {
  const result = decideExitAction({
    position: pos({ structuralStopPrice: 0, invalidationPrice: 0.94 }),
    tokenData: { price: 0.93 },
    now: NOW,
  });
  assert.equal(result.reason, 'BSC_FLOW_STRUCTURAL_STOP');
});

test('bsc flow exit: stopLoss can provide structural stop fallback', () => {
  const result = decideExitAction({
    position: pos({ structuralStopPrice: 0, invalidationPrice: 0, stopLoss: 0.95 }),
    tokenData: { price: 0.94 },
    now: NOW,
  });
  assert.equal(result.reason, 'BSC_FLOW_STRUCTURAL_STOP');
});

test('bsc flow exit: generic sell tiers are skipped for setup contract', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 1.1 },
    sellTiers: [{ profitMultiplier: 1.05, sellPct: 1 }],
    now: NOW,
  });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'bsc_flow_hold');
});
