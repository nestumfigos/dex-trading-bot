'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferGradientBoost,
  inferRandomForest,
  inferSequenceModel,
  aggregateModelPredictions,
} = require('../src/utils/ml-inference');

const bullish = {
  priceChange24hPct: 8,
  return3Pct: 4,
  return12Pct: 10,
  volumeSpike: 1.8,
  buyRatioRecentPct: 62,
  netBuyFlowUsd10m: 8000,
  sentimentScore: 0.68,
  realizedVolPct: 2.5,
  holderConcentrationRiskPct: 5,
  rsi: 58,
};

test('gradient boost surrogate identifies bullish setups', () => {
  const result = inferGradientBoost(bullish, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.score > 0.6);
});

test('random forest surrogate identifies bullish setups', () => {
  const result = inferRandomForest(bullish, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.confidence > 0.2);
});

test('sequence model reacts to improving returns', () => {
  const result = inferSequenceModel(bullish, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.score > 0.6);
});

test('aggregateModelPredictions produces bullish consensus', () => {
  const aggregate = aggregateModelPredictions([
    { signal: 'BUY', score: 0.7 },
    { signal: 'BUY', score: 0.66 },
    { signal: 'HOLD', score: 0.55 },
  ]);
  assert.equal(aggregate.signal, 'BUY');
  assert.equal(aggregate.consensus, 'bullish');
});
