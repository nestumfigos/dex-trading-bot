'use strict';

process.env.PAPER_TRADING = 'true';
process.env.BOT_PROFILE = 'paper';
process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE = 'true';
process.env.PAPER_DISABLE_KPI_PERFORMANCE_GATE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const RiskGuardian = require('../../src/risk/guardian');

test('paper research mode can disable loss-streak and KPI performance gates', () => {
  const risk = new RiskGuardian({
    balance: 1000,
    positions: {},
    stats: {},
  });

  const result = risk.checkPerformanceGate({
    consecutiveLosses: 99,
    closedTrades: 100,
    profitFactor: 0.01,
    avgSlippageBps: 0,
    slippageSamples: 0,
  });

  assert.deepEqual(result, { allowed: true });
});
