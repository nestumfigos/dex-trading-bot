'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreTrade, invalidateCaches } = require('../../src/risk/pre-trade-runtime');

test('runPreTrade loads scope on risk rules so scoped severity overrides global', async () => {
  invalidateCaches();
  const queries = [];
  const sql = {
    request() {
      return {
        input() { return this; },
        async query(text) {
          queries.push(text);
          if (text.includes('dbo.risk_rules')) {
            return { recordset: [
              { name: 'symbol_block', scope: 'global', severity: 'log', enabled: true },
              { name: 'symbol_block', scope: 'live', severity: 'block', enabled: true },
            ] };
          }
          if (text.includes('dbo.symbol_overrides')) {
            return { recordset: [{ symbol: 'KCS', chain: 'kucoin', scope: 'live', action: 'block', active: true }] };
          }
          return { recordset: [] };
        },
      };
    },
  };

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'live',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000 },
    config: { mode: 'enforce' },
    sql,
  });

  assert.match(queries.find((query) => query.includes('dbo.risk_rules')), /SELECT name, scope, severity, enabled/);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.blocked[0].gate, 'symbol_block');
  assert.equal(outcome.v2RiskAudit.enabled, true);
  assert.equal(outcome.v2RiskAudit.input.botProfile, 'live_spot');
  assert.equal(outcome.v2RiskAudit.legacyBlocked, true);
});

test('paper disable flag bypasses pre-trade consecutive-loss enforcement', async () => {
  invalidateCaches();
  const previousDisable = process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE;
  const previousMaxLosses = process.env.MAX_CONSECUTIVE_LOSSES;
  process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE = 'true';
  process.env.MAX_CONSECUTIVE_LOSSES = '4';

  const sql = {
    request() {
      return {
        input() { return this; },
        async query(text) {
          if (text.includes('dbo.risk_rules')) {
            return { recordset: [
              { name: 'consecutive_loss_streak', scope: 'paper', severity: 'block', enabled: true },
            ] };
          }
          return { recordset: [] };
        },
      };
    },
  };

  try {
    const outcome = await runPreTrade({
      side: 'BUY',
      scope: 'paper',
      strategy: 'momentum',
      trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
      state: { walletUsd: 1000, consecutiveLosses: 99 },
      config: { mode: 'enforce' },
      sql,
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result.blocked, []);
    assert.equal(outcome.v2RiskAudit.input.botProfile, 'paper_spot');
  } finally {
    if (previousDisable == null) delete process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE;
    else process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE = previousDisable;
    if (previousMaxLosses == null) delete process.env.MAX_CONSECUTIVE_LOSSES;
    else process.env.MAX_CONSECUTIVE_LOSSES = previousMaxLosses;
    invalidateCaches();
  }
});

test('runPreTrade blocks new BUY when strategy or chain closed-trade evidence is negative', async () => {
  invalidateCaches();
  const queries = [];
  const sql = {
    request() {
      return {
        input() { return this; },
        async query(text) {
          queries.push(text);
          if (text.includes('dbo.bot_trade_ledger')) {
            return { recordset: [{
              closed_trades: 30,
              wins: 8,
              losses: 22,
              gross_profit_usd: 8,
              gross_loss_usd: 22,
              pnl_usd: -14,
            }] };
          }
          return { recordset: [] };
        },
      };
    },
  };

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'paper',
    strategy: 'momentum',
    trade: {
      symbol: 'KCS',
      chain: 'kucoin',
      sizeUsd: 50,
      positionValueUsd: 50,
      setupType: 'spot_day_bull_flag',
    },
    state: { walletUsd: 1000, consecutiveLosses: 0 },
    config: {
      mode: 'enforce',
      profitabilityGuard: {
        enabled: true,
        minClosedTrades: 20,
        minProfitFactor: 1,
        minExpectancyUsd: 0,
      },
    },
    sql,
  });

  assert.ok(queries.some((query) => query.includes('dbo.bot_trade_ledger')));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.blocked[0].gate, 'performance_admission');
  assert.match(outcome.result.blocked[0].reason, /performance admission blocked/);
});

test('V2 risk audit stays advisory by default even when core rejects', async () => {
  invalidateCaches();

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'live',
    strategy: 'momentum',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000, killSwitch: true },
    config: { mode: 'enforce' },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.v2Blocked, false);
  assert.equal(outcome.v2RiskEnforcementMode, 'advisory');
  assert.equal(outcome.v2RiskAudit.coreBlocked, true);
  assert.equal(outcome.v2RiskAudit.advisoryOnly, true);
  assert.deepEqual(outcome.v2RiskAudit.reasons, ['kill_switch_active']);
});

test('V2 risk enforcement blocks core rejection when enabled for profile', async () => {
  invalidateCaches();

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'paper',
    strategy: 'momentum',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000, killSwitch: true },
    config: {
      mode: 'shadow',
      v2RiskEnforcementMode: 'block_core',
      v2RiskEnforceProfiles: 'paper_spot',
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.v2Blocked, true);
  assert.equal(outcome.v2RiskEnforcementMode, 'block_core');
  assert.equal(outcome.v2EnforcementActive, true);
  assert.equal(outcome.v2RiskAudit.advisoryOnly, false);
  assert.deepEqual(outcome.reasons, ['kill_switch_active']);
});

test('V2 risk enforcement profile scope prevents accidental live block', async () => {
  invalidateCaches();

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'live',
    strategy: 'momentum',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000, killSwitch: true },
    config: {
      mode: 'shadow',
      v2RiskEnforcementMode: 'block_core',
      v2RiskEnforceProfiles: 'paper_spot',
    },
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.v2Blocked, false);
  assert.equal(outcome.v2EnforcementActive, false);
  assert.equal(outcome.v2RiskAudit.advisoryOnly, true);
});
