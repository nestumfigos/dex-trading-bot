'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreTrade, invalidateCaches } = require('../../src/risk/pre-trade-runtime');

test('runPreTrade loads scope on risk rules so a paper override can block', async () => {
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
              { name: 'symbol_block', scope: 'paper', severity: 'block', enabled: true },
            ] };
          }
          if (text.includes('dbo.symbol_overrides')) {
            return { recordset: [{ symbol: 'KCS', chain: 'kucoin', scope: 'paper', action: 'block', active: true }] };
          }
          return { recordset: [] };
        },
      };
    },
  };

  const outcome = await runPreTrade({
    side: 'BUY',
    scope: 'paper',
    trade: { symbol: 'KCS', chain: 'kucoin', sizeUsd: 50, positionValueUsd: 50 },
    state: { walletUsd: 1000 },
    config: { mode: 'enforce' },
    sql,
  });

  assert.match(queries.find((query) => query.includes('dbo.risk_rules')), /SELECT name, scope, severity, enabled/);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.result.blocked[0].gate, 'symbol_block');
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
  } finally {
    if (previousDisable == null) delete process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE;
    else process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE = previousDisable;
    if (previousMaxLosses == null) delete process.env.MAX_CONSECUTIVE_LOSSES;
    else process.env.MAX_CONSECUTIVE_LOSSES = previousMaxLosses;
    invalidateCaches();
  }
});
