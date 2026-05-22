'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferGradientBoost,
  inferGruSequence,
  inferLogisticRegression,
  inferRandomForest,
  inferSequenceModel,
  inferTransformerSequence,
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

test('transformer attention surrogate combines multi-source evidence', () => {
  const result = inferTransformerSequence({
    ...bullish,
    return1Pct: 1,
    return24Pct: 12,
    onchainMacroScore: 0.7,
    binanceMomentumConfirm: 1,
    arimaReturnForecastPct: 1.5,
    garchVolatilityPct: 2,
    mvrvRiskScore: 0.1,
  }, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.reasoning.attention.length >= 4);
});

test('gru surrogate reacts to short-term sequence gates', () => {
  const result = inferGruSequence({
    ...bullish,
    return1Pct: 1.2,
    volumeTrendPct: 6,
    onchainMacroScore: 0.68,
    garchVolatilityPct: 2,
  }, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.reasoning.momentumGate > 0.5);
});

test('logistic regression surrogate uses macro and cross-exchange features', () => {
  const result = inferLogisticRegression({
    ...bullish,
    binanceMomentumConfirm: 1,
    onchainMacroScore: 0.68,
    garchVolatilityPct: 2,
    mvrvRiskScore: 0.1,
  }, {});
  assert.equal(result.signal, 'BUY');
  assert.ok(result.score > 0.6);
});

test('aggregateModelPredictions produces bullish consensus', () => {
  const aggregate = aggregateModelPredictions([
    { signal: 'BUY', score: 0.7 },
    { signal: 'BUY', score: 0.66 },
    { signal: 'HOLD', score: 0.55 },
    { signal: 'BUY', score: 0.64 },
  ]);
  assert.equal(aggregate.signal, 'BUY');
  assert.equal(aggregate.consensus, 'bullish');
});
