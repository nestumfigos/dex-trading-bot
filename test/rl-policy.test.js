'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  trainQPolicy,
  trainActorCriticPolicy,
  trainPpoPolicy,
  inferRlAction,
  buildFeatureSeriesFromHistories,
  encodeState,
} = require('../src/utils/rl-policy');

test('buildFeatureSeriesFromHistories emits usable rows', () => {
  const priceHistory = {
    'token:a': Array.from({ length: 100 }, (_, index) => 1 + (index * 0.02)),
  };
  const volumeHistory = {
    'token:a': Array.from({ length: 100 }, (_, index) => 1000 + (index * 10)),
  };
  const series = buildFeatureSeriesFromHistories(priceHistory, volumeHistory, 1);
  assert.ok(series.length > 50);
});

test('trainQPolicy learns a non-empty state table', () => {
  const series = Array.from({ length: 120 }, (_, index) => ({
    price: 1 + (index * 0.01),
    features: {
      return3Pct: index % 2 === 0 ? 2 : 1,
      volumeSpike: 1.3,
      rsi: 55,
      sentimentScore: 0.6,
      realizedVolPct: 2.5,
    },
  }));
  const policy = trainQPolicy(series, { episodes: 4 });
  assert.ok(policy.stateCount > 0);
});

test('inferRlAction returns a valid action', () => {
  const features = {
    return3Pct: 2,
    volumeSpike: 1.3,
    rsi: 55,
    sentimentScore: 0.58,
    realizedVolPct: 2,
  };
  const policy = {
    q: {
      [encodeState(features)]: { BUY: 0.8, HOLD: 0.1, SELL: -0.1 },
    },
  };
  const result = inferRlAction(policy, {
    features,
  });
  assert.equal(result.signal, 'BUY');
});

test('trainActorCriticPolicy learns actor and critic tables', () => {
  const series = Array.from({ length: 120 }, (_, index) => ({
    price: 1 + (index * 0.01),
    features: {
      return3Pct: 2,
      return12Pct: 5,
      volumeSpike: 1.4,
      rsi: 56,
      sentimentScore: 0.62,
      realizedVolPct: 2,
    },
  }));
  const policy = trainActorCriticPolicy(series, { episodes: 4 });
  assert.equal(policy.algorithm, 'actor_critic');
  assert.ok(policy.stateCount > 0);
  assert.ok(Object.keys(policy.critic).length > 0);

  const result = inferRlAction(policy, { features: series[20].features });
  assert.ok(['BUY', 'HOLD', 'SELL'].includes(result.signal));
  assert.ok(result.probabilities);
});

test('trainPpoPolicy learns clipped actor-critic policy', () => {
  const series = Array.from({ length: 120 }, (_, index) => ({
    price: 1 + (index * 0.008),
    features: {
      return3Pct: 1.5,
      return12Pct: 4,
      volumeSpike: 1.35,
      rsi: 54,
      sentimentScore: 0.6,
      realizedVolPct: 2.2,
    },
  }));
  const policy = trainPpoPolicy(series, { episodes: 4, epochs: 2, clipRatio: 0.2 });
  assert.equal(policy.algorithm, 'ppo');
  assert.ok(policy.stateCount > 0);
  assert.equal(policy.clipRatio, 0.2);

  const result = inferRlAction(policy, { features: series[20].features });
  assert.ok(['BUY', 'HOLD', 'SELL'].includes(result.signal));
  assert.equal(result.algorithm, 'ppo');
});
