'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBayesianPosterior, runHybridDecision } = require('../src/utils/hybrid-agent-orchestrator');

test('hybrid orchestrator can promote a strong non-buy setup', async () => {
  const registry = {
    async getActiveModelVersions() {
      return [
        { versionId: 'xgboost_surrogate-v1', family: 'xgboost', displayName: 'gbm', params: {} },
        { versionId: 'random_forest_surrogate-v1', family: 'random_forest', displayName: 'rf', params: {} },
      ];
    },
    async recordPrediction() {},
    async recordMultiAgentDecision() {},
  };

  const rlPolicyManager = {
    async getActivePolicy() {
      return { policy: { q: {} } };
    },
    inferAction() {
      return { signal: 'BUY', confidence: 0.8, score: 0.7 };
    },
  };

  const result = await runHybridDecision({
    registry,
    rlPolicyManager,
    logger: console,
    tokenData: { symbol: 'TEST', chainKey: 'kucoin', marketRegime: 'uptrend' },
    strategyName: 'momentum',
    evaluation: { signal: 'HOLD', details: { marketRegime: 'uptrend' } },
    featureSnapshot: {
      features: {
        priceChange24hPct: 9,
        return3Pct: 4,
        return12Pct: 10,
        volumeSpike: 1.8,
        buyRatioRecentPct: 62,
        netBuyFlowUsd10m: 9000,
        sentimentScore: 0.67,
        realizedVolPct: 2.5,
        holderConcentrationRiskPct: 5,
        rsi: 58,
      },
    },
    sentimentSnapshot: { signal: 'BUY', confidence: 0.7, aggregateScore: 0.66 },
  });

  assert.equal(result.finalSignal, 'BUY');
  assert.ok(result.confidence > 0.2);
  assert.ok(result.route.bayesian.posterior > 0.5);
  assert.ok(result.route.bayesianNetwork.probability > 0.5);
});

test('hybrid orchestrator uses baseline ML models when registry has no active versions', async () => {
  const registry = {
    async getActiveModelVersions() {
      return [];
    },
    async recordPrediction() {},
    async recordMultiAgentDecision() {},
  };

  const result = await runHybridDecision({
    registry,
    rlPolicyManager: null,
    logger: console,
    tokenData: { symbol: 'BASE', chainKey: 'kucoin', marketRegime: 'uptrend' },
    strategyName: 'momentum',
    evaluation: { signal: 'BUY', details: { marketRegime: 'uptrend' } },
    featureSnapshot: {
      features: {
        priceChange24hPct: 4,
        return3Pct: 2,
        return12Pct: 5,
        volumeSpike: 1.6,
        buyRatioRecentPct: 58,
        netBuyFlowUsd10m: 7000,
        sentimentScore: 0.61,
        realizedVolPct: 2,
        holderConcentrationRiskPct: 3,
        rsi: 55,
      },
    },
    sentimentSnapshot: { signal: 'BUY', confidence: 0.62, aggregateScore: 0.61 },
  });

  assert.ok(result.predictions.length >= 3);
  assert.ok(result.predictions.some((prediction) => prediction.versionId === 'runtime_xgboost_surrogate-v1'));
});

test('bayesian posterior rises with bullish evidence', () => {
  const neutral = computeBayesianPosterior({
    regimeFamily: 'unknown',
    taskClass: 'momentum_entry_confirmation',
    inputs: {},
  });
  const bullish = computeBayesianPosterior({
    regimeFamily: 'uptrend',
    taskClass: 'momentum_entry_confirmation',
    inputs: {
      technicalSignal: 'BUY',
      technicalScore: 0.72,
      mlSignal: 'BUY',
      mlScore: 0.7,
      mlConfidence: 0.4,
      sentimentSignal: 'BUY',
      sentimentScore: 0.65,
      sentimentConfidence: 0.7,
      llmSignal: 'BUY',
      llmScore: 0.7,
      llmConfidence: 0.5,
    },
  });

  assert.ok(bullish.posterior > neutral.posterior);
});
