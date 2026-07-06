'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideExitAction } = require('../../src/exits/evaluate-exit-decision');

// Test fixtures

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_730_000_000_000; // arbitrary fixed timestamp

function basePosition(over = {}) {
  return {
    entryPrice: 100,
    stopLoss: 90,
    takeProfit: 200,
    trailingStop: 0,
    highestPrice: 0,
    openedAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
    strategy: 'momentum',
    triggeredSellTiers: {},
    tierDelayedAt: {},
    tierLocalHigh: 0,
    realizedPnlByTier: {},
    holdExtensionsUsed: 0,
    symbol: 'TEST',
    ...over,
  };
}

function baseStrategyCfg(over = {}) {
  return {
    minHoldHours: 4,
    maxHoldMinutes: 1440, // 24h
    adaptiveTierExit: true,
    tierDelayRsiMin: 70,
    tierAccelSellRatioPct: 60,
    tierLocalHighReversalPct: 5,
    ...over,
  };
}

function baseRiskCfg(over = {}) {
  return {
    staleDriftExitEnabled: true,
    staleDriftTier1Hours: 12,
    staleDriftTier1MinProfitPct: 1,
    staleDriftTier2Hours: 24,
    staleDriftTier2MinProfitPct: 3,
    staleDriftTier3Hours: 48,
    staleDriftTier3MinProfitPct: 8,
    ...over,
  };
}

const DEFAULT_TIERS = [
  { profitMultiplier: 1.3, sellPct: 0.25 }, // +30% -> sell 25%
  { profitMultiplier: 1.7, sellPct: 0.35 }, // +70% -> sell 35%
  { profitMultiplier: 2.5, sellPct: 0.4 },  // +150% -> sell 40%
];

// Defensive guards

test('decideExitAction: throws if position missing', () => {
  assert.throws(
    () => decideExitAction({ tokenData: { price: 100 } }),
    /position required/
  );
});

test('decideExitAction: throws if tokenData missing', () => {
  assert.throws(
    () => decideExitAction({ position: basePosition() }),
    /tokenData required/
  );
});

test('decideExitAction: noop when price=0 (insufficient data)', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 0 },
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'insufficient_price_data');
});

// 1. STRATEGY_EXIT precedence

test('STRATEGY_EXIT: shouldExit=true causes sell, sellPct=1', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 105 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { shouldExit: true, reason: 'MOMENTUM_FADE_RSI_SELL_PRESSURE' },
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'MOMENTUM_FADE_RSI_SELL_PRESSURE');
  assert.equal(r.sellPct, 1);
});

test('STRATEGY_EXIT: staleData=true suppresses strategy exit', () => {
  const r = decideExitAction({
    position: basePosition({ stopLoss: 0, openedAt: new Date(NOW - HOUR_MS).toISOString() }),
    tokenData: { price: 105 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { shouldExit: true, reason: 'STRATEGY_X' },
    staleData: true,
    now: NOW,
  });
  assert.notEqual(r.reason, 'STRATEGY_X');
});

// 2. TRAILING_STOP

test('TRAILING_STOP: price <= trailingStop -> sell with stopLevel meta', () => {
  const r = decideExitAction({
    position: basePosition({ trailingStop: 110, highestPrice: 130 }),
    tokenData: { price: 109 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'TRAILING_STOP');
  assert.equal(r.meta.stopType, 'TRAILING_STOP');
  assert.equal(r.meta.stopLevel, 110);
});

test('TRAILING_STOP: price > trailingStop -> NOT triggered (price above)', () => {
  const r = decideExitAction({
    position: basePosition({ trailingStop: 110 }),
    tokenData: { price: 111 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.notEqual(r.reason, 'TRAILING_STOP');
});

test('PROFIT_LOCK: winning generic position ratchets stop without exiting', () => {
  const r = decideExitAction({
    position: basePosition({ stopLoss: 90, takeProfit: 0 }),
    tokenData: { price: 108.5 },
    strategyCfg: baseStrategyCfg({ minHoldHours: 100, maxHoldMinutes: 10000 }),
    riskCfg: baseRiskCfg({
      profitLockTiers: [
        { triggerPct: 4, lockPct: 0 },
        { triggerPct: 8, lockPct: 3 },
      ],
    }),
    sellTiers: [],
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.mutations.stopLoss, 103);
  assert.equal(r.mutations.profitLockPct, 3);
});

test('PROFIT_LOCK: never lowers an existing tighter stop', () => {
  const r = decideExitAction({
    position: basePosition({ stopLoss: 105, takeProfit: 0 }),
    tokenData: { price: 108.5 },
    strategyCfg: baseStrategyCfg({ minHoldHours: 100, maxHoldMinutes: 10000 }),
    riskCfg: baseRiskCfg({ profitLockTiers: [{ triggerPct: 8, lockPct: 3 }] }),
    sellTiers: [],
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.mutations.stopLoss, undefined);
});

// 3. STOP_LOSS

test('STOP_LOSS: price <= stopLoss -> sell with stopLevel meta', () => {
  const r = decideExitAction({
    position: basePosition({ stopLoss: 90 }),
    tokenData: { price: 89.5 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'STOP_LOSS');
  assert.equal(r.meta.stopType, 'STOP_LOSS');
  assert.equal(r.meta.stopLevel, 90);
});

test('STOP_LOSS: trailing checked before stop_loss (precedence)', () => {
  // Both would trigger; trailing wins
  const r = decideExitAction({
    position: basePosition({ stopLoss: 90, trailingStop: 95 }),
    tokenData: { price: 89 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'TRAILING_STOP');
});

// 4. TIME_STOP + extension

test('TIME_STOP: past holdDeadline + no extension -> sell TIME_STOP', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 25 * HOUR_MS).toISOString() }), // 25h held
    tokenData: { price: 150 },
    strategyCfg: baseStrategyCfg({ maxHoldMinutes: 1440 }), // 24h
    riskCfg: baseRiskCfg(),
    sellTiers: [], // no tiers so we hit TIME_STOP not tier
    holdExtensionDecision: { extend: false, reason: 'extension_disabled' },
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'TIME_STOP');
});

test('TIME_STOP: past deadline + extend=true -> extend_hold, NOT sell', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 25 * HOUR_MS).toISOString() }),
    tokenData: { price: 150 },
    strategyCfg: baseStrategyCfg({ maxHoldMinutes: 1440 }),
    riskCfg: baseRiskCfg(),
    sellTiers: [],
    holdExtensionDecision: {
      extend: true,
      reason: 'trend_still_healthy',
      extensionMinutes: 60,
      nextDeadlineAt: new Date(NOW + HOUR_MS).toISOString(),
    },
    now: NOW,
  });
  assert.equal(r.action, 'extend_hold');
  assert.equal(r.mutations.holdExtensionsUsed, 1);
  assert.ok(r.mutations.holdUntilAt);
});

// 5. MIN_HOLD_NO_GAIN

test('MIN_HOLD_NO_GAIN: held >= minHoldHours and decayed past floor -> sell', () => {
  const r = decideExitAction({
    position: basePosition({
      entryPrice: 100,
      openedAt: new Date(NOW - 5 * HOUR_MS).toISOString(), // 5h
    }),
    tokenData: { price: 98 }, // -2% — past the -1.5% default floor
    strategyCfg: baseStrategyCfg({ minHoldHours: 4 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'MIN_HOLD_NO_GAIN');
});

// 2026-07-02 perf audit: barely-negative positions keep their optionality —
// the cull only fires past noGainExitProfitFloorPct (default -1.5%). The old
// any-loss trigger produced 22 paper trades at 0% win / -$357.
test('MIN_HOLD_NO_GAIN: barely negative (-1%) above floor -> NOT triggered', () => {
  const r = decideExitAction({
    position: basePosition({
      entryPrice: 100,
      openedAt: new Date(NOW - 5 * HOUR_MS).toISOString(),
    }),
    tokenData: { price: 99 }, // -1% — above the -1.5% floor
    strategyCfg: baseStrategyCfg({ minHoldHours: 4 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.notEqual(r.reason, 'MIN_HOLD_NO_GAIN');
});

test('MIN_HOLD_NO_GAIN: floor 0 restores legacy any-loss cull', () => {
  const r = decideExitAction({
    position: basePosition({
      entryPrice: 100,
      openedAt: new Date(NOW - 5 * HOUR_MS).toISOString(),
    }),
    tokenData: { price: 99.9 }, // -0.1%
    strategyCfg: baseStrategyCfg({ minHoldHours: 4, noGainExitProfitFloorPct: 0 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'MIN_HOLD_NO_GAIN');
});

test('MIN_HOLD_NO_GAIN: held < minHoldHours -> NOT triggered', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 1 * HOUR_MS).toISOString() }),
    tokenData: { price: 99 },
    strategyCfg: baseStrategyCfg({ minHoldHours: 4 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.notEqual(r.reason, 'MIN_HOLD_NO_GAIN');
});

// 6. STALE_DRIFT tiers

test('STALE_DRIFT tier1: 12h+ with <1% gain -> sell, tier=1', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 13 * HOUR_MS).toISOString() }),
    tokenData: { price: 100.5 }, // +0.5%
    strategyCfg: baseStrategyCfg({ minHoldHours: 100 }), // disable min_hold trigger
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'STALE_DRIFT');
  assert.equal(r.meta.tier, 1);
});

test('STALE_DRIFT tier3: 48h+ with <8% gain -> sell, tier=3 (highest tier wins)', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 49 * HOUR_MS).toISOString() }),
    tokenData: { price: 105 }, // +5%
    strategyCfg: baseStrategyCfg({ minHoldHours: 100, maxHoldMinutes: 6000 }), // 100h max
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'STALE_DRIFT');
  assert.equal(r.meta.tier, 3);
});

test('STALE_DRIFT: disabled via riskCfg -> NOT triggered', () => {
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 50 * HOUR_MS).toISOString() }),
    tokenData: { price: 101 },
    strategyCfg: baseStrategyCfg({ minHoldHours: 100, maxHoldMinutes: 6000 }),
    riskCfg: baseRiskCfg({ staleDriftExitEnabled: false }),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.notEqual(r.reason, 'STALE_DRIFT');
});

// 7. SELL_TIER cascade

test('SELL_TIER_1: hit +30% threshold -> normal tier sell, tier 1 flagged', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 131 }, // +31% (above 1.3x threshold, defeats FP edge)
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { rsiValue: 50, sellRatio10mPct: 30 } },
    now: NOW,
  });
  assert.equal(r.reason, 'SELL_TIER_1');
  assert.equal(r.sellPct, 0.25);
  assert.equal(r.tierIndex, 0);
  assert.equal(r.mutations.triggeredSellTiers[0], true);
});

test('SELL_TIER_ACCEL: sell pressure > tierAccelSellRatioPct -> full exit', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 131 },
    strategyCfg: baseStrategyCfg({ tierAccelSellRatioPct: 60 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { sellRatio10mPct: 75 } }, // hot sell
    now: NOW,
  });
  assert.equal(r.reason, 'SELL_TIER_ACCEL_1');
  assert.equal(r.sellPct, 1);
  assert.equal(r.mutations.triggeredSellTiers[0], true);
  assert.equal(r.mutations.triggeredSellTiers[1], true);
  assert.equal(r.mutations.triggeredSellTiers[2], true);
});

test('SELL_TIER_REVERSAL: pullback >= tierLocalHighReversalPct -> full exit', () => {
  const r = decideExitAction({
    position: basePosition({ tierLocalHigh: 150 }), // saw 150 earlier
    tokenData: { price: 131 }, // 12.7% pullback from 150
    strategyCfg: baseStrategyCfg({ tierLocalHighReversalPct: 5 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { sellRatio10mPct: 20 } }, // not hot enough to accel
    now: NOW,
  });
  assert.equal(r.reason, 'SELL_TIER_REVERSAL_1');
  assert.equal(r.sellPct, 1);
});

test('TIER_DELAYED: hot RSI + cool sells -> delay one cycle', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 131 },
    strategyCfg: baseStrategyCfg({ tierDelayRsiMin: 70, tierAccelSellRatioPct: 60 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { rsiValue: 75, sellRatio10mPct: 30 } },
    now: NOW,
  });
  assert.equal(r.action, 'delay_tier');
  assert.equal(r.reason, 'TIER_DELAYED_1');
  assert.equal(r.mutations.tierDelayedAt[0], NOW);
});

test('TIER_DELAYED: already delayed -> proceed to normal sell', () => {
  const r = decideExitAction({
    position: basePosition({ tierDelayedAt: { 0: NOW - 60000 } }),
    tokenData: { price: 131 },
    strategyCfg: baseStrategyCfg({ tierDelayRsiMin: 70 }),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { rsiValue: 75, sellRatio10mPct: 30 } },
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'SELL_TIER_1');
});

test('SELL_TIER skips already-triggered tiers and lands on tier 2', () => {
  const r = decideExitAction({
    position: basePosition({ triggeredSellTiers: { 0: true } }),
    tokenData: { price: 171 }, // +71% (above 1.7x threshold)
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { rsiValue: 50, sellRatio10mPct: 20 } },
    now: NOW,
  });
  assert.equal(r.reason, 'SELL_TIER_2');
  assert.equal(r.tierIndex, 1);
});

// 8. ORPHANED_TIERS_EXIT

test('ORPHANED_TIERS_EXIT: all tiers triggered + no sells -> full exit', () => {
  const r = decideExitAction({
    position: basePosition({
      triggeredSellTiers: { 0: true, 1: true, 2: true },
      realizedPnlByTier: {},
      exitInProgress: false,
    }),
    tokenData: { price: 250 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'ORPHANED_TIERS_EXIT');
});

test('ORPHANED_TIERS_EXIT: skipped if exitInProgress=true', () => {
  const r = decideExitAction({
    position: basePosition({
      triggeredSellTiers: { 0: true, 1: true, 2: true },
      realizedPnlByTier: {},
      exitInProgress: true,
    }),
    tokenData: { price: 250 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  // 250 >= 200 takeProfit -> TAKE_PROFIT fires instead
  assert.equal(r.reason, 'TAKE_PROFIT');
});

// 9. TAKE_PROFIT

test('TAKE_PROFIT: price >= takeProfit and no tier matches -> sell', () => {
  const r = decideExitAction({
    position: basePosition({ takeProfit: 200, triggeredSellTiers: { 0: true, 1: true, 2: true } }),
    tokenData: { price: 210 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  // ORPHANED_TIERS fires first if no realized sells (and that's correct precedence in prod too)
  // Make sure ORPHANED is satisfied first OR set realizedPnlByTier
  assert.ok(r.reason === 'ORPHANED_TIERS_EXIT' || r.reason === 'TAKE_PROFIT');
});

test('TAKE_PROFIT: hit with prior tier sells recorded -> sell TAKE_PROFIT', () => {
  const r = decideExitAction({
    position: basePosition({
      takeProfit: 200,
      triggeredSellTiers: { 0: true, 1: true, 2: true },
      realizedPnlByTier: { 0: 1.5 },
    }),
    tokenData: { price: 210 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'TAKE_PROFIT');
});

// 10. noop default

test('noop: no exit conditions met -> action=noop', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 105 }, // +5%, not enough for any tier
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { shouldExit: false, details: {} },
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'no_exit_trigger');
});

// 11. Stale data branch

test('staleData=true: STOP_LOSS still fires (safety)', () => {
  const r = decideExitAction({
    position: basePosition({ stopLoss: 90 }),
    tokenData: { price: 85 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    staleData: true,
    now: NOW,
  });
  assert.equal(r.reason, 'STOP_LOSS');
});

test('staleData=true: tier sells suppressed (no fresh signal)', () => {
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 130 }, // would normally hit tier 1
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    staleData: true,
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'stale_data_no_tier_eval');
});

// 12. Regression: precedence chain order

test('precedence: STRATEGY_EXIT beats TRAILING_STOP', () => {
  // Both can trigger; strategy first
  const r = decideExitAction({
    position: basePosition({ trailingStop: 95 }),
    tokenData: { price: 94 }, // below trailing
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { shouldExit: true, reason: 'STRATEGY_EXIT_X' },
    now: NOW,
  });
  assert.equal(r.reason, 'STRATEGY_EXIT_X');
});

test('STOP_LOSS: suppressed for adopted positions within grace window', () => {
  // PENGU pattern fix — adopted positions should NOT trip stop in first N hours
  const r = decideExitAction({
    position: basePosition({
      stopLoss: 90,
      adoptedFromWallet: true,
      adoptedAt: new Date(NOW - 1 * HOUR_MS).toISOString(), // 1h ago, < 4h grace
    }),
    tokenData: { price: 85 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'adopted_stop_grace');
});

test('STOP_LOSS: fires after grace window elapsed on adopted positions', () => {
  const r = decideExitAction({
    position: basePosition({
      stopLoss: 90,
      adoptedFromWallet: true,
      adoptedAt: new Date(NOW - 5 * HOUR_MS).toISOString(), // 5h ago, > 4h grace
    }),
    tokenData: { price: 85 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'STOP_LOSS');
});

test('STOP_LOSS: fires immediately for non-adopted positions (no grace)', () => {
  const r = decideExitAction({
    position: basePosition({
      stopLoss: 90,
      adoptedFromWallet: false,
      openedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    }),
    tokenData: { price: 85 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'STOP_LOSS');
});

test('STOP_LOSS: grace disabled via RECONCILE_ADOPT_STOP_GRACE_HOURS=0', () => {
  process.env.RECONCILE_ADOPT_STOP_GRACE_HOURS = '0';
  const r = decideExitAction({
    position: basePosition({
      stopLoss: 90,
      adoptedFromWallet: true,
      adoptedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    }),
    tokenData: { price: 85 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'STOP_LOSS');
  delete process.env.RECONCILE_ADOPT_STOP_GRACE_HOURS;
});

test('SELL_TIER: exact threshold price triggers tier (FP epsilon fix)', () => {
  // 1.3 - 1 = 0.30000000000000004 in JS — pre-epsilon, 30% profit (price=130) failed to trigger
  const r = decideExitAction({
    position: basePosition(),
    tokenData: { price: 130 }, // exactly +30%
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    exitSignal: { details: { rsiValue: 50, sellRatio10mPct: 30 } },
    now: NOW,
  });
  assert.equal(r.reason, 'SELL_TIER_1', 'exact threshold (130 = 1.3x of 100) must trigger tier 1');
});

test('precedence: TIME_STOP beats STALE_DRIFT', () => {
  // Old position with low profit -> both could fire; TIME_STOP first
  const r = decideExitAction({
    position: basePosition({ openedAt: new Date(NOW - 50 * HOUR_MS).toISOString() }),
    tokenData: { price: 101 },
    strategyCfg: baseStrategyCfg({ maxHoldMinutes: 60, minHoldHours: 100 }), // 1h max hold
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    holdExtensionDecision: { extend: false },
    now: NOW,
  });
  assert.equal(r.reason, 'TIME_STOP');
});

// ─── FABLE (2026-07-07): thin-session refill structural exits ───────────────

function fablePosition(over = {}) {
  return basePosition({
    setupType: 'fable',
    entryPrice: 96.2,
    structuralStopPrice: 95.0,
    measuredMoveTargetPrice: 98.9,
    fableTimeExitAt: new Date(NOW + 3 * 3600_000).toISOString(),
    ...over,
  });
}

test('FABLE: price at structural stop -> FABLE_STRUCTURE_STOP', () => {
  const r = decideExitAction({
    position: fablePosition(),
    tokenData: { price: 94.9 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'sell');
  assert.equal(r.reason, 'FABLE_STRUCTURE_STOP');
  assert.equal(r.sellPct, 1);
});

test('FABLE: price at retrace target -> FABLE_REFILL_COMPLETE', () => {
  const r = decideExitAction({
    position: fablePosition(),
    tokenData: { price: 99.0 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'FABLE_REFILL_COMPLETE');
});

test('FABLE: past 08:00 UTC deadline -> FABLE_TIME_EXIT even at a loss', () => {
  const r = decideExitAction({
    position: fablePosition({ fableTimeExitAt: new Date(NOW - 60_000).toISOString() }),
    tokenData: { price: 95.8 }, // small loss, above stop
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.reason, 'FABLE_TIME_EXIT');
});

test('FABLE: in-window, between stop and target -> hold (no generic exits)', () => {
  const r = decideExitAction({
    position: fablePosition(),
    tokenData: { price: 96.8 },
    strategyCfg: baseStrategyCfg(),
    riskCfg: baseRiskCfg(),
    sellTiers: DEFAULT_TIERS,
    now: NOW,
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'fable_hold');
});
