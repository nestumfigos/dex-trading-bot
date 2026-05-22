'use strict';

const config = require('../../config');
const { runPythonSidecar } = require('./python-sidecar');
const { FEATURE_ORDER, summarizeFeatureParity } = require('./feature-schema');

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

function inferTransformerSequence(features = {}, params = {}) {
  const horizons = [
    { name: 'return1Pct', weight: 0.18 },
    { name: 'return3Pct', weight: 0.28 },
    { name: 'return12Pct', weight: 0.34 },
    { name: 'return24Pct', weight: 0.20 },
  ];
  const attention = horizons.map((item) => {
    const value = Number(features[item.name] || 0);
    const volatilityDampener = 1 / (1 + Math.abs(Number(features.garchVolatilityPct || features.realizedVolPct || 0)) / 10);
    const salience = Math.abs(value) * item.weight * volatilityDampener;
    return { ...item, value, salience };
  });
  const salienceTotal = attention.reduce((sum, item) => sum + item.salience, 0) || 1;
  const directionalScore = attention.reduce((sum, item) => {
    const normalizedWeight = item.salience / salienceTotal;
    return sum + (item.value * normalizedWeight);
  }, 0);
  const crossSourceBoost = (
    ((Number(features.sentimentScore || 0.5) - 0.5) * 0.75)
    + ((Number(features.onchainMacroScore || 0.5) - 0.5) * 0.65)
    + ((Number(features.binanceMomentumConfirm || 0) - 0.5) * 0.35)
    + ((Number(features.arimaReturnForecastPct || 0)) * 0.08)
  );
  const riskPenalty = (Number(features.mvrvRiskScore || 0) * 0.30)
    + (Number(features.holderConcentrationRiskPct || 0) * 0.008);
  const probability = sigmoid((directionalScore * 0.18) + crossSourceBoost - riskPenalty);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.63), Number(params.thresholdSell || 0.37)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'transformer_attention_surrogate',
      directionalScore,
      crossSourceBoost,
      riskPenalty,
      attention: attention.map((item) => ({ name: item.name, weight: Number((item.salience / salienceTotal).toFixed(4)) })),
    },
  };
}

function inferGruSequence(features = {}, params = {}) {
  const momentumGate = sigmoid(
    (Number(features.return1Pct || 0) * 0.25)
    + (Number(features.return3Pct || 0) * 0.18)
    + ((Number(features.volumeTrendPct || 0)) * 0.06)
  );
  const resetGate = sigmoid(
    1
    - (Number(features.garchVolatilityPct || features.realizedVolPct || 0) * 0.18)
    - (Number(features.mvrvRiskScore || 0) * 0.45)
  );
  const candidate = (
    (Number(features.return12Pct || 0) * 0.20)
    + ((Number(features.sentimentScore || 0.5) - 0.5) * 0.75)
    + ((Number(features.onchainMacroScore || 0.5) - 0.5) * 0.55)
  );
  const hiddenState = ((1 - momentumGate) * Number(features.return3Pct || 0) * 0.08)
    + (momentumGate * resetGate * candidate);
  const probability = sigmoid(hiddenState);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.63), Number(params.thresholdSell || 0.37)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'gru_sequence_surrogate',
      momentumGate,
      resetGate,
      hiddenState,
    },
  };
}

function inferLogisticRegression(features = {}, params = {}) {
  const weightedScore = Number(params.bias ?? -0.15)
    + (Number(features.return3Pct || 0) * Number(params.return3Weight ?? 0.12))
    + (Number(features.volumeSpike || 1) - 1) * Number(params.volumeSpikeWeight ?? 0.75)
    + ((Number(features.sentimentScore || 0.5) - 0.5) * Number(params.sentimentWeight ?? 1.1))
    + ((Number(features.binanceMomentumConfirm || 0) - 0.5) * Number(params.binanceWeight ?? 0.35))
    + ((Number(features.onchainMacroScore || 0.5) - 0.5) * Number(params.onchainWeight ?? 0.6))
    - (Number(features.garchVolatilityPct || features.realizedVolPct || 0) * Number(params.volatilityPenalty ?? 0.12))
    - (Number(features.mvrvRiskScore || 0) * Number(params.mvrvPenalty ?? 0.35));
  const probability = sigmoid(weightedScore);
  return {
    score: probability,
    signal: scoreToSignal(probability, Number(params.thresholdBuy || 0.62), Number(params.thresholdSell || 0.38)),
    confidence: Math.abs(probability - 0.5) * 2,
    reasoning: {
      model: 'logistic_regression_surrogate',
      weightedScore,
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
  // Breadth-of-agreement gate: ceil(70% of models) must align. Replaces strict 0.62 score gate
  // with a lower 0.58 score requirement that demands more models actually agree.
  const minBreadth = Math.max(2, Math.ceil(usable.length * 0.7));
  const buy = buyVotes >= minBreadth && avgScore >= 0.58;
  const sell = sellVotes >= minBreadth && avgScore <= 0.42;
  return {
    signal: buy ? 'BUY' : sell ? 'SELL' : 'HOLD',
    confidence: clamp(Math.abs(avgScore - 0.5) * 2, 0, 1),
    score: avgScore,
    consensus: buyVotes === sellVotes ? 'mixed' : buyVotes > sellVotes ? 'bullish' : 'bearish',
  };
}

const BASELINE_MODEL_VERSIONS = [
  {
    versionId: 'runtime_xgboost_surrogate-v1',
    family: 'xgboost',
    displayName: 'Runtime Gradient Boosting Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.67, thresholdSell: 0.33 },
  },
  {
    versionId: 'runtime_random_forest_surrogate-v1',
    family: 'random_forest',
    displayName: 'Runtime Random Forest Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.64, thresholdSell: 0.36 },
  },
  {
    versionId: 'runtime_lstm_sequence_surrogate-v1',
    family: 'lstm',
    displayName: 'Runtime Sequence Model Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.66, thresholdSell: 0.34 },
  },
  {
    versionId: 'runtime_transformer_attention_surrogate-v1',
    family: 'transformer',
    displayName: 'Runtime Transformer Attention Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.63, thresholdSell: 0.37 },
  },
  {
    versionId: 'runtime_gru_sequence_surrogate-v1',
    family: 'gru',
    displayName: 'Runtime GRU Sequence Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.63, thresholdSell: 0.37 },
  },
  {
    versionId: 'runtime_logistic_regression_surrogate-v1',
    family: 'logistic_regression',
    displayName: 'Runtime Logistic Regression Baseline',
    provider: 'native',
    params: { thresholdBuy: 0.62, thresholdSell: 0.38 },
  },
];

async function runModelInference({ features = {}, modelVersions = [] } = {}) {
  const outputs = [];
  const versions = modelVersions.length ? modelVersions : BASELINE_MODEL_VERSIONS;
  for (const version of versions) {
    let result = null;
    const provider = String(version.provider || '').toLowerCase();
    const expectedFeatureOrder = version.metadata?.featureOrder || version.params?.featureOrder || FEATURE_ORDER;
    const parity = summarizeFeatureParity(features, expectedFeatureOrder);
    if (provider === 'python_sidecar' && config.externalModels?.enabled !== false) {
      try {
        if (parity.coverage < 0.7) {
          throw new Error(`feature_coverage_too_low:${parity.presentCount}/${parity.featureCount}`);
        }
        const external = await runPythonSidecar('infer_model', {
          framework: version.metadata?.framework || version.params?.framework || version.family,
          artifactPath: version.metadata?.artifactPath || version.params?.artifactPath,
          metadata: {
            ...(version.metadata || {}),
            ...(version.params || {}),
            featureOrder: expectedFeatureOrder,
            featureSchemaHash: parity.schemaHash,
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
            featureParity: parity,
          },
        };
      } catch (error) {
        if (config.externalModels?.failOpen === false) {
          throw error;
        }
      }
    }
    const family = String(version.family || '').toLowerCase();
    if (!result && ['xgboost', 'lightgbm', 'catboost', 'gradient_boosting'].includes(family)) {
      result = inferGradientBoost(features, version.params);
    } else if (!result && family === 'random_forest') {
      result = inferRandomForest(features, version.params);
    } else if (!result && family === 'lstm') {
      result = inferSequenceModel(features, version.params);
    } else if (!result && ['transformer', 'tft', 'informer', 'chronos', 'timegpt'].includes(family)) {
      result = inferTransformerSequence(features, version.params);
    } else if (!result && family === 'gru') {
      result = inferGruSequence(features, version.params);
    } else if (!result && family === 'logistic_regression') {
      result = inferLogisticRegression(features, version.params);
    }
    if (!result) continue;
    outputs.push({
      versionId: version.versionId,
      family: version.family,
      displayName: version.displayName,
      featureParity: parity,
      ...result,
    });
  }
  return {
    predictions: outputs,
    aggregate: aggregateModelPredictions(outputs),
  };
}

module.exports = {
  BASELINE_MODEL_VERSIONS,
  inferGradientBoost,
  inferGruSequence,
  inferLogisticRegression,
  inferRandomForest,
  inferSequenceModel,
  inferTransformerSequence,
  aggregateModelPredictions,
  runModelInference,
};
