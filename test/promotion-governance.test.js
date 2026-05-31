'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeStrategyVersionHash,
  computeDiscrepancyScore,
  classifyPromotionImpact,
  validateGeneratedBehaviorApplication,
  validatePromotionCandidate,
  hashText,
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
  assert.ok(high.scoreRaw >= high.score);
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

test('generated behavior cannot apply until validation and approval are recorded', () => {
  assert.equal(
    validateGeneratedBehaviorApplication({ changes: [{ type: 'env_set', key: 'MAX_POSITION_SIZE_PCT', value: '4' }] }).allow,
    false,
  );
  assert.equal(
    validateGeneratedBehaviorApplication({
      changes: [{ type: 'env_set', key: 'MAX_POSITION_SIZE_PCT', value: '4' }],
      validation: { preApplyPassed: true },
      approval: { approved: true },
    }).allow,
    true,
  );
});

test('generated behavior can never relax capital protections', () => {
  assert.deepEqual(
    validateGeneratedBehaviorApplication({
      changes: [{ type: 'env_set', key: 'MAX_DAILY_LOSS_PCT_BY_CHAIN', value: '{"bsc":40}' }],
      validation: { preApplyPassed: true },
      approval: { approved: true },
    }),
    { allow: false, reason: 'capital_protections_cannot_be_relaxed_by_generated_behavior' },
  );
  assert.equal(
    validateGeneratedBehaviorApplication({
      changes: [{ type: 'env_set', key: 'MAX_CONCURRENT_POSITIONS', value: '15' }],
      validation: { preApplyPassed: true },
      approval: { approved: true },
    }).allow,
    false,
  );
});

test('promotion requires a validated eligible and explicitly approved candidate', () => {
  assert.deepEqual(validatePromotionCandidate(null), { allow: false, reason: 'candidate_manifest_required' });
  assert.equal(validatePromotionCandidate({ promotion: { eligible: true, approved: true } }).allow, false);
  assert.equal(validatePromotionCandidate({
    validation: { passed: true },
    promotion: { eligible: true, approved: false },
  }).allow, false);
  assert.equal(validatePromotionCandidate({
    validation: { passed: true },
    promotion: { eligible: true, approved: true },
    rollout: { manualApprovalRequired: true, manualApprovalGranted: false },
  }).allow, false);
  assert.equal(validatePromotionCandidate({
    validation: { passed: true },
    promotion: { eligible: true, approved: true },
    rollout: { manualApprovalRequired: true, manualApprovalGranted: true },
  }).allow, true);
  assert.equal(validatePromotionCandidate({
    validation: { passed: true },
    promotion: { eligible: true, approved: true },
    changedEnvKeys: ['MAX_CONCURRENT_POSITIONS'],
  }).reason, 'environment_changes_are_not_promotable');
});

test('candidate source hashes change when validated file content changes', () => {
  assert.equal(hashText('const value = 1;\n'), hashText('const value = 1;\n'));
  assert.notEqual(hashText('const value = 1;\n'), hashText('const value = 2;\n'));
});
