'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const EvolutionGovernor = require('../src/evolution-governor');

function createGovernor() {
  return new EvolutionGovernor({
    config: {
      paperTrading: true,
      selfEvolution: {
        governance: {
          minObservationMinutes: 5,
          minClosedTrades: 2,
          minShadowClosedTrades: 5,
          maxPaperLiveDiscrepancyScore: 35,
          minPromotionConfidence: 60,
          requireManualApprovalForHighImpact: true,
          shadowModeRequired: true,
        },
      },
    },
    logger: console,
    projectRoot: process.cwd(),
  });
}

test('evaluateManifest defers to shadow when evidence is still early', () => {
  const governor = createGovernor();
  const manifest = {
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    changedFiles: ['config/index.js'],
    baseline: {
      closedTrades: 0,
      profitFactor: 1,
      winRatePct: 40,
      maxDrawdownPct: 10,
      falsePositiveRatePct: 5,
      fillSlippagePct: 0.2,
      fillDiscrepancyPct: 0.1,
    },
    validation: { required: true, passed: true },
    observation: { startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
  };
  const result = governor.evaluateManifest(manifest, {
    stats: { closedTrades: 2, wins: 1, losses: 1, profitFactor: 1.5, maxDrawdownPct: 9 },
    signalQuality: { falsePositiveRatePct: 4 },
    fillQuality: { avgSlippagePct: 0.2, avgFillDiscrepancyPct: 0.1 },
    paperLiveComparison: { approvalRateDeltaPct: 0 },
  });
  assert.equal(result.decision, 'shadow');
});

test('evaluateManifest awaits manual approval for high-impact promotions', () => {
  const governor = createGovernor();
  const manifest = {
    createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    changedFiles: ['src/index.js', 'src/utils/execution-flow.js', 'config/index.js'],
    baseline: {
      closedTrades: 0,
      profitFactor: 1,
      winRatePct: 30,
      maxDrawdownPct: 10,
      falsePositiveRatePct: 5,
      fillSlippagePct: 0.1,
      fillDiscrepancyPct: 0.1,
    },
    validation: { required: true, passed: true },
    observation: { startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() },
  };
  const result = governor.evaluateManifest(manifest, {
    stats: { closedTrades: 7, wins: 3, losses: 1, profitFactor: 1.15, maxDrawdownPct: 9.5 },
    signalQuality: { falsePositiveRatePct: 4.8 },
    fillQuality: { avgSlippagePct: 0.12, avgFillDiscrepancyPct: 0.11 },
    paperLiveComparison: { approvalRateDeltaPct: 0 },
  });
  assert.equal(result.decision, 'await_manual_approval');
});

test('evaluateManifest can enforce V2 evidence gate before promotion', () => {
  const governor = new EvolutionGovernor({
    config: {
      paperTrading: true,
      selfEvolution: {
        governance: {
          minObservationMinutes: 5,
          minClosedTrades: 2,
          maxPaperLiveDiscrepancyScore: 100,
          minPromotionConfidence: 60,
          requireManualApprovalForHighImpact: false,
          shadowModeRequired: false,
          requireV2EvidenceGate: true,
        },
      },
    },
    logger: console,
    projectRoot: process.cwd(),
  });
  const manifest = {
    strategy: 'spot_day_bull_flag',
    strategyClass: 'day_trade',
    createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    changedFiles: ['src/strategies/spot-day-bull-flag.js'],
    versioning: { sourceProfile: 'paper_spot' },
    baseline: {
      closedTrades: 0,
      profitFactor: 1,
      winRatePct: 30,
      maxDrawdownPct: 10,
      falsePositiveRatePct: 5,
      fillSlippagePct: 0.1,
      fillDiscrepancyPct: 0.1,
    },
    validation: { required: true, passed: true },
    observation: { startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() },
    promotion: { targetProfile: 'live_spot' },
  };
  const result = governor.evaluateManifest(manifest, {
    botProfile: 'paper_spot',
    targetProfile: 'live_spot',
    stats: { closedTrades: 7, wins: 5, losses: 1, profitFactor: 2.2, expectancyUsd: 3, maxDrawdownPct: 2 },
    stressedExpectancyUsd: 1,
    regimeCoverageCount: 2,
    symbolConcentrationPct: 20,
    signalQuality: { falsePositiveRatePct: 4.8 },
    fillQuality: { avgSlippagePct: 0.12, avgFillDiscrepancyPct: 0.11 },
    paperLiveComparison: { approvalRateDeltaPct: 0, executionDiscrepancyPct: 3 },
  });

  assert.equal(result.decision, 'hold');
  assert.equal(result.evidenceGate.passed, false);
  assert.ok(result.reasons.some((reason) => reason.includes('v2_evidence_gate:sample_size_below_min')));
});
