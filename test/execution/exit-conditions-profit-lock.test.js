'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createExitConditions } = require('../../src/execution/exit-conditions');

test('checkExitConditions applies profit-lock stop mutation without selling', async () => {
  const position = {
    strategy: 'momentum',
    entryPrice: 100,
    stopLoss: 90,
    openedAt: new Date(Date.now() - 60_000).toISOString(),
    symbol: 'GAIN',
  };
  let sells = 0;
  const { checkExitConditions } = createExitConditions({
    config: {
      risk: {
        profitLockTiers: [
          { triggerPct: 4, lockPct: 0 },
          { triggerPct: 8, lockPct: 3 },
        ],
        staleDriftExitEnabled: false,
      },
      strategies: { momentum: { minHoldHours: 100, maxHoldMinutes: 10000 } },
    },
    logger: { info() {}, warn() {} },
    portfolio: { safeMode: false },
    strategy: { evaluateExitForStrategy: () => ({ shouldExit: false, details: {} }) },
    buildTokenKey: (chain, address) => `${chain}:${address}`,
    applyTrailingStopState: () => {},
    shouldExtendMaxHold: () => ({ extend: false }),
    shouldDelayBorderlineStop: () => false,
    getExecuteSell: () => async () => { sells += 1; },
  });

  await checkExitConditions('kucoin', {}, { symbol: 'GAIN', address: 'GAIN', price: 108.5 }, position);

  assert.equal(sells, 0);
  assert.equal(position.stopLoss, 103);
  assert.equal(position.profitLockPct, 3);
});
