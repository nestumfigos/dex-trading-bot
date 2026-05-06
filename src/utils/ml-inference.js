'use strict';

const config = require('../../config');
const { runPythonSidecar } = require('./python-sidecar');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function scoreToSignal(probability, buyThreshold = 0.64, sellThreshold = 0.36) {
  if (probability >= buyThreshold) return 'BUY';
  if (probability <= sellThreshold) return 'SELL';
  return 'HOLD';
}

function inferGradientBoost(features = {}, params = {}) {
  const weightedScore = (
    (Number(features.priceChange24hPct || 0) * 0.04)
    + (Number(features.return3Pct || 0) * 0.06)
    + (Number(features.return12Pct || 0) * 0.03)
    + ((Number(features.volumeSpike || 1) - 1) * 0.45)
    + ((Number(features.buyRatioRecentPct || 50) - 50) * 0.05)
    + (Number(features.netBuyFlowUsd10m || 0) / 15000)
    + ((Number(features.sentimentScore || 0.5) - 0.5) * 1.2)
    - (Number(features.realizedVolPct || 0) * 0.18)
    - (Number(features.holderConcentrationRiskPct || 0) * 0.015)
  );
  const probability = sigmoid(weightedScore);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.67), Number(params.thresholdSell || 0.33)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'xgboost_surrogate',
      weightedScore,
    },
  };
}

function inferRandomForest(features = {}, params = {}) {
  const votes = [];
  votes.push(Number(features.rsi || 50) > 48 && Number(features.rsi || 50) < 72 ? 1 : 0);
  votes.push(Number(features.volumeSpike || 1) > 1.15 ? 1 : 0);
  votes.push(Number(features.buyRatioRecentPct || 50) > 53 ? 1 : 0);
  votes.push(Number(features.netBuyFlowUsd10m || 0) > 2500 ? 1 : 0);
  votes.push(Number(features.sentimentScore || 0.5) > 0.54 ? 1 : 0);
  votes.push(Number(features.return12Pct || 0) > 0 ? 1 : 0);
  votes.push(Number(features.realizedVolPct || 0) < 6 ? 1 : 0);
  const bullishRatio = votes.reduce((sum, value) => sum + value, 0) / Math.max(1, votes.length);
  const bearishPenalty = Number(features.return3Pct || 0) < -3 ? 0.25 : 0;
  const probability = clamp(bullishRatio - bearishPenalty, 0, 1);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.64), Number(params.thresholdSell || 0.36)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'random_forest_surrogate',
      bullishVotes: votes.reduce((sum, value) => sum + value, 0),
      voteCount: votes.length,
    },
  };
}

function inferSequenceModel(features = {}, params = {}) {
  const sequenceTrend = (
    (Number(features.return1Pct || 0) * 0.15)
    + (Number(features.return3Pct || 0) * 0.25)
    + (Number(features.return12Pct || 0) * 0.35)
    + (Number(features.volumeTrendPct || 0) * 0.05)
    + ((Number(features.sentimentScore || 0.5) - 0.5) * 0.6)
  );
  const stabilityPenalty = Number(features.realizedVolPct || 0) * 0.1;
  const probability = sigmoid(sequenceTrend - stabilityPenalty);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.66), Number(params.thresholdSell || 0.34)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'lstm_sequence_surrogate',
      sequenceTrend,
      stabilityPenalty,
    },
  };
}

function aggregateModelPredictions(predictions = []) {
  const usable = predictions.filter((prediction) => Number.isFinite(Number(prediction?.score)));
  if (!usable.length) {
    return {
      signal: 'HOLD',
      confidence: 0,
      score: 0.5,
      consensus: 'none',
    };
  }
  const avgScore = usable.reduce((sum, prediction) => sum + Number(prediction.score), 0) / usable.length;
  const buyVotes = usable.filter((prediction) => prediction.signal === 'BUY').length;
  const sellVotes = usable.filter((prediction) => prediction.signal === 'SELL').length;
  return {
    signal: buyVotes > sellVotes && avgScore >= 0.62 ? 'BUY' : sellVotes > buyVotes && avgScore <= 0.38 ? 'SELL' : 'HOLD',
    confidence: clamp(Math.abs(avgScore - 0.5) * 2, 0, 1),
    score: avgScore,
    consensus: buyVotes === sellVotes ? 'mixed' : buyVotes > sellVotes ? 'bullish' : 'bearish',
  };
}

async function runModelInference({ features = {}, modelVersions = [] } = {}) {
  const outputs = [];
  for (const version of modelVersions) {
    let result = null;
    const provider = String(version.provider || '').toLowerCase();
    if (provider === 'python_sidecar' && config.externalModels?.enabled !== false) {
      try {
        const external = await runPythonSidecar('infer_model', {
          framework: version.metadata?.framework || version.params?.framework || version.family,
          artifactPath: version.metadata?.artifactPath || version.params?.artifactPath,
          metadata: {
            ...(version.metadata || {}),
            ...(version.params || {}),
          },
          features,
        });
        result = {
          score: Number(external.score || 0.5),
          signal: String(external.signal || 'HOLD').toUpperCase(),
          confidence: Number(external.confidence || 0),
          reasoning: {
            model: version.displayName || version.versionId,
            provider: external.provider || 'python_sidecar',
            external: true,
          },
        };
      } catch (error) {
        if (config.externalModels?.failOpen === false) {
          throw error;
        }
      }
    }
    if (!result && version.family === 'xgboost') {
      result = inferGradientBoost(features, version.params);
    } else if (!result && version.family === 'random_forest') {
      result = inferRandomForest(features, version.params);
    } else if (!result && version.family === 'lstm') {
      result = inferSequenceModel(features, version.params);
    }
    if (!result) continue;
    outputs.push({
      versionId: version.versionId,
      family: version.family,
      displayName: version.displayName,
      ...result,
    });
  }
  return {
    predictions: outputs,
    aggregate: aggregateModelPredictions(outputs),
  };
}

module.exports = {
  inferGradientBoost,
  inferRandomForest,
  inferSequenceModel,
  aggregateModelPredictions,
  runModelInference,
};
