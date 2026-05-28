'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLearningBrain } = require('../../src/learning/brain-profiles');
const StrategyBrain = require('../../src/strategy-brain');

function logger() {
  return { info() {}, warn() {} };
}

test('flat closes cannot inflate learning or adaptive-sizing win rates', () => {
  const portfolio = { learning: {} };
  const brain = createLearningBrain({
    config: { risk: { learningEnabled: true, brainEnabled: true, adaptiveSizingEnabled: true } },
    logger: logger(),
    portfolio,
    normalizeChainKey: (value) => String(value || '').toLowerCase(),
  });
  const position = { chainKey: 'kucoin', strategy: 'momentum' };

  brain.updateBrainProfileFromClosedTrade(position, 0);
  brain.updateAdaptiveSleevePerformance(position, 0);

  const profile = Object.values(portfolio.learning.brainProfiles)[0];
  const sleeve = portfolio.learning.sleevePerformance['kucoin:momentum'];
  assert.equal(profile.wins, 0);
  assert.equal(profile.losses, 1);
  assert.equal(sleeve.wins, 0);
  assert.equal(sleeve.losses, 1);
});

test('flat closes cannot inflate strategy-brain win rates', () => {
  const portfolio = { learning: {} };
  const brain = new StrategyBrain({ config: { risk: { brainMinSamples: 100 } }, logger: logger(), portfolio });
  brain.recordClosedTrade({ chainKey: 'kucoin', strategy: 'momentum' }, 0);
  const profile = Object.values(portfolio.learning.strategyBrain.profiles)[0];
  assert.equal(profile.wins, 0);
  assert.equal(profile.losses, 1);
});

test('global learning cannot block or retune a chain with no local evidence', () => {
  const portfolio = { learning: {} };
  const brain = new StrategyBrain({
    config: { risk: { brainMinSamples: 6, brainBlockWinRatePct: 22 }, strategyBrain: {} },
    logger: logger(),
    portfolio,
  });
  const state = brain.ensureState();
  state.profiles['global:momentum:canonical_momentum_baseline'] = { samples: 10, recentWinRatePct: 0 };
  state.adjustments['global:momentum'] = { rsiBuyThresholdDelta: -10, volumeSpikeMultiplierDelta: 1 };
  const allowed = brain.shouldAllowEntry('kucoin', 'momentum', 'canonical_momentum_baseline');
  const params = brain.getAdaptiveParameters('kucoin', 'momentum', { rsiBuyThreshold: 45, volumeSpikeMultiplier: 2 }, {});
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.localEvidenceRequired, true);
  assert.equal(params.rsiBuyThreshold, 45);
  assert.equal(params.volumeSpikeMultiplier, 2);
});
