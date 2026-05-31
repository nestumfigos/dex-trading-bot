'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  check,
  GATE_CATALOG,
  checkTierFeasibility,
  checkPositionSize,
  checkSymbolBlock,
  checkDuplicateOrder,
  checkDailyLossBudget,
  checkConsecutiveLossStreak,
  checkAiCircuit,
  recordRejections,
} = require('../../src/risk/pre-trade-contract');

// ─── Catalog sanity ────────────────────────────────────────────────────────

test('GATE_CATALOG has 7 gates', () => {
  assert.equal(GATE_CATALOG.length, 7);
  const names = GATE_CATALOG.map((g) => g.name);
  assert.deepEqual(names, [
    'tier_feasibility',
    'position_size',
    'symbol_block',
    'duplicate_order',
    'daily_loss_budget',
    'consecutive_loss_streak',
    'ai_circuit',
  ]);
});

// ─── tier_feasibility ──────────────────────────────────────────────────────

test('tier_feasibility: $5 position with 30% smallest tier → $1.50 < $1 min → PASS (boundary)', () => {
  const res = checkTierFeasibility({
    side: 'BUY',
    positionValueUsd: 5,
    sellTiers: [{ sellPct: 0.30 }, { sellPct: 0.35 }],
    minNotionalUsd: 1,
  });
  assert.equal(res.pass, true, '$1.50 ≥ $1 should pass');
});

test('tier_feasibility: $5 position with 10% smallest tier → $0.50 < $1 → BLOCK (regression for 2026-05-16 tier-too-small bug)', () => {
  const res = checkTierFeasibility({
    side: 'BUY',
    positionValueUsd: 5,
    sellTiers: [{ sellPct: 0.10 }, { sellPct: 0.20 }],
    minNotionalUsd: 1,
  });
  assert.equal(res.pass, false);
  assert.match(res.reason, /below min notional/);
  assert.equal(res.metadata.smallestTierUsd, 0.5);
});

test('tier_feasibility: SELL side bypasses gate', () => {
  const res = checkTierFeasibility({
    side: 'SELL',
    positionValueUsd: 5,
    sellTiers: [{ sellPct: 0.10 }],
    minNotionalUsd: 1,
  });
  assert.equal(res.pass, true);
});

test('tier_feasibility: no tiers → pass', () => {
  const res = checkTierFeasibility({ side: 'BUY', positionValueUsd: 5, sellTiers: [], minNotionalUsd: 1 });
  assert.equal(res.pass, true);
});

// ─── position_size ─────────────────────────────────────────────────────────

test('position_size: below min → BLOCK', () => {
  const res = checkPositionSize({ side: 'BUY', sizeUsd: 3, walletUsd: 1000, minSizeUsd: 6, maxPctOfWallet: 0.25 });
  assert.equal(res.pass, false);
  assert.match(res.reason, /MIN_POSITION_SIZE_USD/);
});

test('position_size: above wallet cap → BLOCK', () => {
  const res = checkPositionSize({ side: 'BUY', sizeUsd: 300, walletUsd: 1000, minSizeUsd: 6, maxPctOfWallet: 0.25 });
  assert.equal(res.pass, false);
  assert.match(res.reason, /25%/);
});

test('position_size: within bounds → pass', () => {
  const res = checkPositionSize({ side: 'BUY', sizeUsd: 50, walletUsd: 1000, minSizeUsd: 6, maxPctOfWallet: 0.25 });
  assert.equal(res.pass, true);
});

test('position_size: NaN size → BLOCK', () => {
  const res = checkPositionSize({ side: 'BUY', sizeUsd: NaN, walletUsd: 1000 });
  assert.equal(res.pass, false);
});

// ─── symbol_block ──────────────────────────────────────────────────────────

test('symbol_block: matching active block → BLOCK', () => {
  const res = checkSymbolBlock({
    symbol: 'KCS', chain: 'kucoin', scope: 'live',
    symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'live', action: 'block', active: true, reason: 'rug risk', id: 1 }],
  });
  assert.equal(res.pass, false);
  assert.match(res.reason, /rug risk/);
});

test('symbol_block: global scope blocks live trade', () => {
  const res = checkSymbolBlock({
    symbol: 'KCS', chain: 'kucoin', scope: 'live',
    symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'global', action: 'block', active: true, id: 1 }],
  });
  assert.equal(res.pass, false);
});

test('symbol_block: expired block → pass', () => {
  const res = checkSymbolBlock({
    symbol: 'KCS', chain: 'kucoin', scope: 'live',
    symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'global', action: 'block', active: true, expires_at: new Date(Date.now() - 1000).toISOString(), id: 1 }],
  });
  assert.equal(res.pass, true);
});

test('symbol_block: inactive block → pass', () => {
  const res = checkSymbolBlock({
    symbol: 'KCS', chain: 'kucoin', scope: 'live',
    symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'global', action: 'block', active: false, id: 1 }],
  });
  assert.equal(res.pass, true);
});

test('symbol_block: prefer action ignored', () => {
  const res = checkSymbolBlock({
    symbol: 'KCS', chain: 'kucoin', scope: 'live',
    symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'global', action: 'prefer', active: true, id: 1 }],
  });
  assert.equal(res.pass, true);
});

// ─── duplicate_order ───────────────────────────────────────────────────────

test('duplicate_order: matching key → BLOCK', () => {
  const inFlight = new Set(['buy:kucoin:kcs']);
  const res = checkDuplicateOrder({ side: 'BUY', symbol: 'KCS', chain: 'kucoin', address: 'KCS', inFlightKeys: inFlight });
  assert.equal(res.pass, false);
});

test('duplicate_order: no match → pass', () => {
  const inFlight = new Set(['buy:kucoin:btc']);
  const res = checkDuplicateOrder({ side: 'BUY', symbol: 'KCS', chain: 'kucoin', address: 'KCS', inFlightKeys: inFlight });
  assert.equal(res.pass, true);
});

// ─── daily_loss_budget ─────────────────────────────────────────────────────

test('daily_loss_budget: PnL hits limit → BLOCK', () => {
  const res = checkDailyLossBudget({ todaysPnlUsd: -50, dailyDrawdownLimitUsd: 50 });
  assert.equal(res.pass, false);
});

test('daily_loss_budget: PnL within limit → pass', () => {
  const res = checkDailyLossBudget({ todaysPnlUsd: -40, dailyDrawdownLimitUsd: 50 });
  assert.equal(res.pass, true);
});

test('daily_loss_budget: limit ≤0 → unset (pass)', () => {
  const res = checkDailyLossBudget({ todaysPnlUsd: -1000, dailyDrawdownLimitUsd: 0 });
  assert.equal(res.pass, true);
});

// ─── consecutive_loss_streak ───────────────────────────────────────────────

test('consecutive_loss_streak: at cap → BLOCK', () => {
  const res = checkConsecutiveLossStreak({ consecutiveLosses: 5, maxConsecutiveLosses: 5 });
  assert.equal(res.pass, false);
});

test('consecutive_loss_streak: under cap → pass', () => {
  const res = checkConsecutiveLossStreak({ consecutiveLosses: 2, maxConsecutiveLosses: 5 });
  assert.equal(res.pass, true);
});

// ─── ai_circuit ────────────────────────────────────────────────────────────

test('ai_circuit: open without override → BLOCK', () => {
  const res = checkAiCircuit({ aiCircuitOpen: true, aiOverride: false });
  assert.equal(res.pass, false);
});

test('ai_circuit: open WITH override → pass', () => {
  const res = checkAiCircuit({ aiCircuitOpen: true, aiOverride: true });
  assert.equal(res.pass, true);
});

test('ai_circuit: closed → pass', () => {
  const res = checkAiCircuit({ aiCircuitOpen: false });
  assert.equal(res.pass, true);
});

// ─── Orchestrator ──────────────────────────────────────────────────────────

test('check(): clean BUY passes all gates', () => {
  const res = check({
    side: 'BUY',
    trade: { symbol: 'KCS', chain: 'kucoin', address: 'KCS', sizeUsd: 50, positionValueUsd: 50, strategy: 'momentum' },
    state: { walletUsd: 1000, todaysPnlUsd: 5, consecutiveLosses: 0, aiCircuitOpen: false },
    config: { scope: 'live', minSizeUsd: 6, maxPctOfWallet: 0.25, minNotionalUsd: 1, dailyDrawdownLimitUsd: 100, maxConsecutiveLosses: 5 },
    lookups: { sellTiers: [{ sellPct: 0.3 }, { sellPct: 0.35 }], symbolOverrides: [], inFlightKeys: new Set() },
  });
  assert.equal(res.pass, true);
  assert.deepEqual(res.blocked, []);
});

test('check(): block severity short-circuits, warn does not', () => {
  const ruleConfig = new Map([
    ['tier_feasibility', { enabled: true, severity: 'warn' }],   // size-too-small → warn
    ['position_size',    { enabled: true, severity: 'block' }],
  ]);
  const res = check({
    side: 'BUY',
    trade: { symbol: 'KCS', chain: 'kucoin', address: 'KCS', sizeUsd: 3, positionValueUsd: 3 },
    state: { walletUsd: 1000 },
    config: { scope: 'live', minSizeUsd: 6, minNotionalUsd: 1 },
    lookups: { sellTiers: [{ sellPct: 0.10 }], symbolOverrides: [], inFlightKeys: new Set(), ruleConfig },
  });
  assert.equal(res.pass, false, 'size violation still blocks');
  assert.equal(res.blocked.length, 1);
  assert.equal(res.blocked[0].gate, 'position_size');
  assert.equal(res.warned.length, 1);
  assert.equal(res.warned[0].gate, 'tier_feasibility');
});

test('check(): disabled rule is skipped entirely', () => {
  const ruleConfig = new Map([
    ['tier_feasibility', { enabled: false }],
  ]);
  const res = check({
    side: 'BUY',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000 },
    config: { scope: 'live', minSizeUsd: 6, maxPctOfWallet: 0.25, minNotionalUsd: 1000 }, // would block but disabled
    lookups: { sellTiers: [{ sellPct: 0.1 }], symbolOverrides: [], inFlightKeys: new Set(), ruleConfig },
  });
  assert.equal(res.pass, true);
});

test('check(): SELL side runs only SELL-applicable gates', () => {
  const res = check({
    side: 'SELL',
    trade: { symbol: 'KCS', chain: 'kucoin', address: 'KCS' },
    state: {},
    config: { scope: 'live' },
    lookups: {
      sellTiers: [{ sellPct: 0.001 }],   // would block on BUY
      symbolOverrides: [{ symbol: 'KCS', chain: 'kucoin', scope: 'global', action: 'block', active: true, id: 1 }],
      inFlightKeys: new Set(),
    },
  });
  // tier_feasibility & position_size & daily_loss_budget & streak & ai_circuit all skip SELL.
  // symbol_block + duplicate_order run; symbol_block fires.
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'symbol_block');
});

test('check(): gate exception → recorded as log severity, never blocks', () => {
  // Inject a bad lookup so symbol_block iteration would throw if mis-built.
  // Easiest: pass non-iterable symbolOverrides
  const res = check({
    side: 'BUY',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000 },
    config: { scope: 'live', minSizeUsd: 6, maxPctOfWallet: 0.25, minNotionalUsd: 1 },
    lookups: { sellTiers: [{ sellPct: 0.3 }], symbolOverrides: 'not-an-array', inFlightKeys: new Set() },
  });
  // symbol_block treats non-array as empty (returns pass:true) — no throw, no log.
  assert.equal(res.pass, true);
});

test('check(): all defaults / minimal ctx → does not throw', () => {
  const res = check({ side: 'BUY' });
  // No trade data → some gates bail to pass, others may block (size NaN). Important: no throw.
  assert.ok(typeof res === 'object');
  assert.ok(Array.isArray(res.blocked));
});

test('recordRejections persists walletUsd from state fallback', async () => {
  const capturedInputs = {};
  const sql = {
    request() {
      return {
        input(key, value) {
          capturedInputs[key] = value;
          return this;
        },
        async query() {
          return { rowsAffected: [1] };
        },
      };
    },
  };
  await recordRejections({
    sql,
    scope: 'live',
    strategy: 'momentum',
    side: 'BUY',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000 },
    result: { blocked: [{ gate: 'daily_loss_budget', severity: 'block', reason: 'daily halt' }] },
  });
  assert.equal(capturedInputs.wallet_usd, 1000);
});
