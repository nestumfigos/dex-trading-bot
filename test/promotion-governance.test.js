'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeStrategyVersionHash,
  computeDiscrepancyScore,
  classifyPromotionImpact,
  normalizeRegimeLabel,
} = require('../src/utils/promotion-governance');

test('computeStrategyVersionHash is stable for equivalent objects', () => {
  const a = computeStrategyVersionHash({
    config: { strategy: { a: 1 } },
    strategies: { momentum: { emaFast: 8, emaSlow: 21 } },
    risk: { stopLossPct: 8 },
  });
  const b = computeStrategyVersionHash({
    config: { strategy: { a: 1 } },
    strategies: { momentum: { emaSlow: 21, emaFast: 8 } },
    risk: { stopLossPct: 8 },
  });
  assert.equal(a, b);
});

test('computeDiscrepancyScore increases with larger deltas', () => {
  const low = computeDiscrepancyScore({ profitFactorDelta: 0.1, winRateDeltaPct: 2 });
  const high = computeDiscrepancyScore({ profitFactorDelta: 1.2, winRateDeltaPct: 20, fillSlippageDeltaPct: 2 });
  assert.ok(high.score > low.score);
});

test('classifyPromotionImpact marks execution-heavy changes high impact', () => {
  const impact = classifyPromotionImpact(['src/index.js', 'src/utils/execution-flow.js']);
  assert.equal(impact.highImpact, true);
  assert.equal(impact.impact, 'high');
});

test('normalizeRegimeLabel maps common aliases', () => {
  assert.equal(normalizeRegimeLabel('High Volatility'), 'high_volatility');
  assert.equal(normalizeRegimeLabel('uptrend'), 'uptrend');
});
