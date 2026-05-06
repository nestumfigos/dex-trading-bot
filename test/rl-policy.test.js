'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  trainQPolicy,
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
