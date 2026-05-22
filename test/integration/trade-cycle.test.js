'use strict';

/**
 * Trade-cycle integration test — Week 7 Track A.
 *
 * Tests the full pre-trade contract orchestrator (`check()`) under realistic
 * combined scenarios that mirror the bot's executeBuy/executeSell flow:
 *   1. healthy BUY passes all 7 gates
 *   2. each gate independently blocks a malformed/risky trade
 *   3. severities (block | warn | log) routed correctly
 *   4. SELL side skips BUY-only gates
 *   5. multiple simultaneous failures all recorded
 *   6. rule disable / gate throw → defense-in-depth holds
 *
 * Per-gate unit tests live in test/risk/pre-trade-contract.test.js; this
 * file covers the orchestrator + integration behavior.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { check } = require('../../src/risk/pre-trade-contract');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function healthyBuy(over = {}) {
  return {
    side: 'BUY',
    trade: {
      symbol: 'BTC',
      chain: 'kucoin',
      address: '0xabc',
      sizeUsd: 25,
      positionValueUsd: 25,
      strategy: 'momentum',
    },
    state: {
      walletUsd: 1000,
      todaysPnlUsd: 5,
      consecutiveLosses: 1,
      aiCircuitOpen: false,
    },
    config: {
      scope: 'live',
      minNotionalUsd: 1,
      minSizeUsd: 6,
      maxPctOfWallet: 0.25,
      dailyDrawdownLimitUsd: 50,
      maxConsecutiveLosses: 5,
      aiOverride: false,
    },
    lookups: {
      sellTiers: [{ sellPct: 0.25 }, { sellPct: 0.35 }, { sellPct: 0.40 }],
      symbolOverrides: [],
      inFlightKeys: new Set(),
    },
    ...over,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────────

test('trade-cycle: healthy BUY passes all 7 gates', () => {
  const res = check(healthyBuy());
  assert.equal(res.pass, true);
  assert.deepEqual(res.blocked, []);
  assert.deepEqual(res.warned, []);
  assert.deepEqual(res.logged, []);
});

// ─── Each gate blocks ───────────────────────────────────────────────────────

test('trade-cycle: position too small blocks', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 2;
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'position_size');
});

test('trade-cycle: position > 25% wallet blocks', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 500; // 50% of $1000 > 25% cap
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.ok(res.blocked.some((b) => b.gate === 'position_size'));
});

test('trade-cycle: blocked symbol blocks', () => {
  const ctx = healthyBuy();
  ctx.lookups.symbolOverrides = [{
    action: 'block', symbol: 'BTC', chain: 'kucoin', scope: 'global',
    active: true, reason: 'pump-and-dump pattern detected',
  }];
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'symbol_block');
  assert.ok(res.blocked[0].reason.includes('pump-and-dump'));
});

test('trade-cycle: blocked symbol with scope=live blocks live trade', () => {
  const ctx = healthyBuy();
  ctx.config.scope = 'live';
  ctx.lookups.symbolOverrides = [{
    action: 'block', symbol: 'BTC', chain: 'kucoin', scope: 'live',
    active: true, reason: 'live-only block',
  }];
  const res = check(ctx);
  assert.equal(res.pass, false);
});

test('trade-cycle: blocked symbol with scope=paper does NOT block live trade', () => {
  const ctx = healthyBuy();
  ctx.config.scope = 'live';
  ctx.lookups.symbolOverrides = [{
    action: 'block', symbol: 'BTC', chain: 'kucoin', scope: 'paper',
    active: true, reason: 'paper-only block',
  }];
  const res = check(ctx);
  assert.equal(res.pass, true);
});

test('trade-cycle: expired symbol_override does NOT block', () => {
  const ctx = healthyBuy();
  ctx.lookups.symbolOverrides = [{
    action: 'block', symbol: 'BTC', chain: 'kucoin', scope: 'global',
    active: true, expires_at: new Date(Date.now() - 60000).toISOString(),
    reason: 'expired',
  }];
  assert.equal(check(ctx).pass, true);
});

test('trade-cycle: duplicate in-flight BUY blocks', () => {
  const ctx = healthyBuy();
  ctx.lookups.inFlightKeys = new Set(['buy:kucoin:0xabc']);
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'duplicate_order');
});

test('trade-cycle: daily loss budget exceeded blocks', () => {
  const ctx = healthyBuy();
  ctx.state.todaysPnlUsd = -55;
  ctx.config.dailyDrawdownLimitUsd = 50;
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'daily_loss_budget');
});

test('trade-cycle: consecutive loss streak hit blocks', () => {
  const ctx = healthyBuy();
  ctx.state.consecutiveLosses = 5;
  ctx.config.maxConsecutiveLosses = 5;
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'consecutive_loss_streak');
});

test('trade-cycle: AI circuit OPEN blocks (no override)', () => {
  const ctx = healthyBuy();
  ctx.state.aiCircuitOpen = true;
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'ai_circuit');
});

test('trade-cycle: AI circuit OPEN + override=true allows trade', () => {
  const ctx = healthyBuy();
  ctx.state.aiCircuitOpen = true;
  ctx.config.aiOverride = true;
  assert.equal(check(ctx).pass, true);
});

test('trade-cycle: tier_feasibility blocks $5 position with 10% min tier', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 10;
  ctx.trade.positionValueUsd = 5;
  ctx.lookups.sellTiers = [{ sellPct: 0.10 }, { sellPct: 0.20 }];
  ctx.config.minNotionalUsd = 1;
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'tier_feasibility');
});

// ─── SELL side ──────────────────────────────────────────────────────────────

test('trade-cycle: SELL side skips BUY-only gates (size/budget/streak/AI)', () => {
  const ctx = healthyBuy({
    side: 'SELL',
    trade: { symbol: 'BTC', chain: 'kucoin', address: '0xabc', sizeUsd: 0, positionValueUsd: 25 },
    state: { walletUsd: 0, todaysPnlUsd: -999, consecutiveLosses: 99, aiCircuitOpen: true },
  });
  const res = check(ctx);
  assert.equal(res.pass, true);
});

test('trade-cycle: SELL still respects symbol_block + duplicate_order', () => {
  const ctx = healthyBuy({
    side: 'SELL',
    trade: { symbol: 'BTC', chain: 'kucoin', address: '0xabc' },
  });
  ctx.lookups.symbolOverrides = [{
    action: 'block', symbol: 'BTC', chain: 'kucoin', scope: 'global', active: true, reason: 'sell-side block',
  }];
  const res = check(ctx);
  assert.equal(res.pass, false);
  assert.equal(res.blocked[0].gate, 'symbol_block');
});

// ─── Multiple simultaneous failures ─────────────────────────────────────────

test('trade-cycle: multiple gates fail -> ALL recorded in blocked[]', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 2;          // position_size fail
  ctx.state.todaysPnlUsd = -100;  // daily_loss_budget fail
  ctx.state.aiCircuitOpen = true; // ai_circuit fail
  const res = check(ctx);
  assert.equal(res.pass, false);
  const gates = res.blocked.map((b) => b.gate).sort();
  assert.deepEqual(gates, ['ai_circuit', 'daily_loss_budget', 'position_size']);
});

// ─── Severity routing ──────────────────────────────────────────────────────

test('trade-cycle: severity=warn -> recorded in warned[], pass=true', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 2;
  ctx.lookups.ruleConfig = new Map([['position_size', { enabled: true, severity: 'warn' }]]);
  const res = check(ctx);
  assert.equal(res.pass, true);
  assert.equal(res.warned[0].gate, 'position_size');
  assert.equal(res.warned[0].severity, 'warn');
});

test('trade-cycle: severity=log -> recorded in logged[], pass=true', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 2;
  ctx.lookups.ruleConfig = new Map([['position_size', { enabled: true, severity: 'log' }]]);
  const res = check(ctx);
  assert.equal(res.pass, true);
  assert.equal(res.logged[0].gate, 'position_size');
});

test('trade-cycle: rule enabled=false -> gate skipped entirely', () => {
  const ctx = healthyBuy();
  ctx.trade.sizeUsd = 2;
  ctx.lookups.ruleConfig = new Map([['position_size', { enabled: false, severity: 'block' }]]);
  const res = check(ctx);
  assert.equal(res.pass, true);
  assert.deepEqual(res.blocked, []);
});

// ─── Defense-in-depth ──────────────────────────────────────────────────────

test('trade-cycle: missing config falls back to safe defaults', () => {
  const res = check({
    side: 'BUY',
    trade: { symbol: 'BTC', chain: 'kucoin', sizeUsd: 25, positionValueUsd: 25 },
    state: { walletUsd: 1000 },
    // no config, no lookups
  });
  assert.equal(res.pass, true);
});

test('trade-cycle: side defaults to BUY when missing', () => {
  const ctx = healthyBuy();
  delete ctx.side;
  const res = check(ctx);
  assert.equal(res.pass, true);
});

test('trade-cycle: gate-runner throw recorded as log, never blocks', () => {
  // Force checkSymbolBlock to throw by passing malformed override
  const ctx = healthyBuy();
  ctx.lookups.symbolOverrides = [{
    get action() { throw new Error('boom from getter'); },
  }];
  const res = check(ctx);
  // Should NOT block — throw is caught + recorded as logged
  assert.equal(res.pass, true);
  assert.ok(res.logged.some((l) => l.gate === 'symbol_block' && /boom/.test(l.reason)));
});
