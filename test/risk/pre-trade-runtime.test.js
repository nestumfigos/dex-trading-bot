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
});
