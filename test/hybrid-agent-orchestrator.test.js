'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runHybridDecision } = require('../src/utils/hybrid-agent-orchestrator');

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
});
