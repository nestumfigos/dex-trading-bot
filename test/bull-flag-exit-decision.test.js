'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideExitAction } = require('../src/exits/evaluate-exit-decision');

function pos(overrides = {}) {
  return {
    setupType: 'spot_day_bull_flag',
    entryPrice: 100,
    structuralStopPrice: 95,
    measuredMoveTargetPrice: 110,
    breakoutClosePrice: 100,
    flagHighPrice: 99,
    manualCutDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    trailingStop: 0,
    stopLoss: 0,
    ...overrides,
  };
}

test('bull-flag: structural stop hit → BULL_FLAG_STRUCTURAL_STOP sell 100%', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 94 },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_STRUCTURAL_STOP');
  assert.equal(result.sellPct, 1);
});

test('bull-flag: measured-move target hit → BULL_FLAG_MEASURED_MOVE sell 100%', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 111 },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_MEASURED_MOVE');
  assert.equal(result.sellPct, 1);
});

test('bull-flag: manual cut deadline + no follow-through → BULL_FLAG_MANUAL_CUT', () => {
  const result = decideExitAction({
    position: pos({ manualCutDeadlineAt: new Date(Date.now() - 60_000).toISOString() }),
    tokenData: { price: 100.1 }, // <0.5% above entry = no follow-through
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_MANUAL_CUT_NO_FOLLOW_THROUGH');
});

test('bull-flag: manual cut deadline passed BUT price moved enough → no cut', () => {
  const result = decideExitAction({
    position: pos({ manualCutDeadlineAt: new Date(Date.now() - 60_000).toISOString() }),
    tokenData: { price: 102 }, // +2% above entry → follow-through, hold
  });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'bull_flag_hold');
});

test('bull-flag: price between stop and target → noop bull_flag_hold', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 103 },
  });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'bull_flag_hold');
});

test('bull-flag: Solana paper setup uses structural exit branch', () => {
  const result = decideExitAction({
    position: pos({ setupType: 'solana_bull_flag_v2' }),
    tokenData: { price: 94 },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_STRUCTURAL_STOP');
});

test('bull-flag: closed candle back inside flag exits immediately', () => {
  const result = decideExitAction({
    position: pos({ flagHighPrice: 101 }),
    tokenData: { price: 101.2, lastClosedPrice: 100.8 },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_CLOSE_BACK_INSIDE_FLAG');
});

test('bull-flag: volume collapse while stalled exits', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 100.2, breakoutFollowThroughVolumeRatio: 0.5 },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_VOLUME_COLLAPSE_STALL');
});

test('bull-flag: exitSignal.shouldExit still respected', () => {
  const result = decideExitAction({
    position: pos(),
    tokenData: { price: 103 },
    exitSignal: { shouldExit: true, reason: 'MOMENTUM_FADE_RSI_SELL_PRESSURE' },
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'MOMENTUM_FADE_RSI_SELL_PRESSURE');
});

test('bull-flag: tier exits skipped (no sellTiers triggered)', () => {
  const result = decideExitAction({
    position: pos({ entryPrice: 100 }),
    tokenData: { price: 109 }, // would trigger 1.08x momentum tier, but bull-flag skips
    sellTiers: [{ profitMultiplier: 1.08, sellPct: 0.25 }],
  });
  assert.equal(result.action, 'noop');
  assert.equal(result.reason, 'bull_flag_hold');
});

test('bull-flag: structural stop takes priority over target if both could fire', () => {
  // Edge case: price below stop AND above target wouldn't physically happen,
  // but verify stop check runs first
  const result = decideExitAction({
    position: pos({ structuralStopPrice: 95, measuredMoveTargetPrice: 90 }),
    tokenData: { price: 90 }, // below stop
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'BULL_FLAG_STRUCTURAL_STOP');
});

test('non-bull-flag position passes through to normal exit logic', () => {
  const result = decideExitAction({
    position: { entryPrice: 100, trailingStop: 0, stopLoss: 90, setupType: null },
    tokenData: { price: 89 }, // hits regular stop loss
  });
  assert.equal(result.action, 'sell');
  assert.equal(result.reason, 'STOP_LOSS');
});
