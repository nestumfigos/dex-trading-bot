'use strict';

const config = require('../../config');
const { runModelInference } = require('./ml-inference');
const { classifyRegimeFamily } = require('./promotion-governance');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function classifyTaskClass({ technicalSignal, strategyName } = {}) {
  if (technicalSignal === 'BUY') return `${strategyName || 'momentum'}_entry_confirmation`;
  if (technicalSignal === 'SELL') return `${strategyName || 'momentum'}_exit_confirmation`;
  return `${strategyName || 'momentum'}_opportunity_discovery`;
}

function getRouteWeights(regimeFamily = 'unknown', taskClass = '') {
  const isEntry = String(taskClass || '').includes('entry');
  if (regimeFamily === 'high_volatility') {
    return { technical: 0.25, ml: 0.25, rl: 0.30, sentiment: 0.08, llm: 0.12, entry: isEntry };
  }
  if (regimeFamily === 'downtrend') {
    return { technical: 0.28, ml: 0.20, rl: 0.22, sentiment: 0.18, llm: 0.12, entry: isEntry };
  }
  return { technical: 0.28, ml: 0.25, rl: 0.20, sentiment: 0.12, llm: 0.15, entry: isEntry };
}

function scoreTechnicalSignal(signal = 'HOLD') {
  if (signal === 'BUY') return 0.72;
  if (signal === 'SELL') return 0.28;
  return 0.5;
}

function scoreLlmSignal(aiDecision = {}) {
  const signal = String(aiDecision?.signal || '').toUpperCase();
  const confidence = clamp(Number(aiDecision?.confidence || 0) / 100, 0, 1);
  if (signal === 'BUY') return 0.5 + (confidence * 0.35);
  if (signal === 'SELL') return 0.5 - (confidence * 0.35);
  return 0.5;
}

function aggregateRouteScores(weights, inputs = {}) {
  const aggregateScore = (
    (weights.technical * Number(inputs.technicalScore || 0.5))
    + (weights.ml * Number(inputs.mlScore || 0.5))
    + (weights.rl * Number(inputs.rlScore || 0.5))
    + (weights.sentiment * Number(inputs.sentimentScore || 0.5))
    + (weights.llm * Number(inputs.llmScore || 0.5))
  );
  return clamp(aggregateScore, 0, 1);
}

function deriveAdaptiveWeights(baseWeights, { modelVersions = [], rlPolicy = null, sentimentSnapshot = null } = {}) {
  const next = { ...baseWeights };
  const modelMetrics = modelVersions.map((version) => version.metrics || {});
  const avgWinRate = modelMetrics.length
    ? modelMetrics.reduce((sum, metrics) => sum + Number(metrics.winRatePct || 0), 0) / modelMetrics.length
    : 0;
  const avgReturn = modelMetrics.length
    ? modelMetrics.reduce((sum, metrics) => sum + Number(metrics.returnPct || 0), 0) / modelMetrics.length
    : 0;

  if (avgWinRate > 54 || avgReturn > 2) next.ml += 0.04;
  if (avgWinRate < 45 && avgReturn < 0) next.ml -= 0.04;

  const rlWinRate = Number(rlPolicy?.metrics?.winRatePct || 0);
  const rlReward = Number(rlPolicy?.metrics?.avgReward || 0);
  if (rlWinRate > 52 || rlReward > 0) next.rl += 0.05;
  if (rlWinRate > 0 && rlWinRate < 42 && rlReward < 0) next.rl -= 0.05;

  const sentimentConfidence = Number(sentimentSnapshot?.confidence || 0);
  if (sentimentConfidence >= 0.72) next.sentiment += 0.04;
  if (sentimentConfidence > 0 && sentimentConfidence <= 0.25) next.sentiment -= 0.04;

  const total = Math.max(0.0001, next.technical + next.ml + next.rl + next.sentiment + next.llm);
  return {
    technical: next.technical / total,
    ml: next.ml / total,
    rl: next.rl / total,
    sentiment: next.sentiment / total,
    llm: next.llm / total,
    entry: Boolean(next.entry),
  };
}

function buildSpecialistFramework({ evaluation, ml, rlResolved, sentimentSnapshot, llmScore, weights }) {
  return {
    technicalAgent: {
      signal: evaluation?.signal || 'HOLD',
      score: scoreTechnicalSignal(evaluation?.signal),
      weight: weights.technical,
    },
    mlAgent: {
      signal: ml.aggregate?.signal || 'HOLD',
      score: Number(ml.aggregate?.score || 0.5),
      weight: weights.ml,
    },
    rlAgent: {
      signal: rlResolved?.signal || 'HOLD',
      score: rlResolved?.signal === 'BUY' ? 0.75 : rlResolved?.signal === 'SELL' ? 0.25 : 0.5,
      weight: weights.rl,
    },
    sentimentAgent: {
      signal: sentimentSnapshot?.signal || 'HOLD',
      score: Number(sentimentSnapshot?.aggregateScore || 0.5),
      weight: weights.sentiment,
    },
    llmAgent: {
      signal: evaluation?.details?.aiReason ? (evaluation?.signal || 'HOLD') : 'HOLD',
      score: llmScore,
      weight: weights.llm,
    },
  };
}

function buildCoPolicyDecision({ technicalSignal, mlSignal, rlSignal, sentimentSignal, llmSignal, aggregateScore }) {
  const bullishVotes = [technicalSignal, mlSignal, rlSignal, sentimentSignal, llmSignal]
    .filter((signal) => String(signal || '').toUpperCase() === 'BUY').length;
  const bearishVotes = [technicalSignal, mlSignal, rlSignal, sentimentSignal, llmSignal]
    .filter((signal) => String(signal || '').toUpperCase() === 'SELL').length;
  if (bullishVotes >= 3 && aggregateScore >= 0.60) return { signal: 'BUY', rationale: 'committee_bullish' };
  if (bearishVotes >= 2 && aggregateScore <= 0.42) return { signal: 'SELL', rationale: 'committee_bearish' };
  return { signal: technicalSignal || 'HOLD', rationale: 'committee_defer' };
}

async function runHybridDecision({
  registry,
  rlPolicyManager,
  logger,
  tokenData,
  strategyName,
  evaluation,
  featureSnapshot,
  sentimentSnapshot,
} = {}) {
  const regimeFamily = classifyRegimeFamily(evaluation?.details?.marketRegime || tokenData?.marketRegime || 'unknown');
  const taskClass = classifyTaskClass({ technicalSignal: evaluation?.signal, strategyName });
  const modelVersions = registry
    ? await registry.getActiveModelVersions('trade_inference', regimeFamily).catch(() => [])
    : [];
  const ml = await runModelInference({
    features: featureSnapshot?.features || {},
    modelVersions,
  });
  const rlPolicy = rlPolicyManager ? await rlPolicyManager.getActivePolicy().catch(() => null) : null;
  let rlResolved = null;
  if (rlPolicyManager) {
    try {
      const rlDecision = rlPolicyManager.inferAction(rlPolicy, featureSnapshot);
      rlResolved = rlDecision && typeof rlDecision.then === 'function' ? await rlDecision : rlDecision;
    } catch {
      rlResolved = null;
    }
  }
  const baseWeights = getRouteWeights(regimeFamily, taskClass);
  const llmScore = scoreLlmSignal({ signal: evaluation?.details?.aiReason ? evaluation?.signal : 'HOLD', confidence: evaluation?.details?.aiConfidence || 0 });
  const weights = config.hybridAgent?.adaptiveRoutingEnabled === false
    ? baseWeights
    : deriveAdaptiveWeights(baseWeights, { modelVersions, rlPolicy, sentimentSnapshot });
  const specialists = config.hybridAgent?.specialistFrameworkEnabled === false
    ? null
    : buildSpecialistFramework({ evaluation, ml, rlResolved, sentimentSnapshot, llmScore, weights });

  const aggregateScore = aggregateRouteScores(weights, {
    technicalScore: scoreTechnicalSignal(evaluation?.signal),
    mlScore: ml.aggregate?.score || 0.5,
    rlScore: rlResolved?.signal === 'BUY' ? 0.75 : rlResolved?.signal === 'SELL' ? 0.25 : 0.5,
    sentimentScore: Number(sentimentSnapshot?.aggregateScore || 0.5),
    llmScore,
  });
  const coPolicyDecision = buildCoPolicyDecision({
    technicalSignal: evaluation?.signal || 'HOLD',
    mlSignal: ml.aggregate?.signal || 'HOLD',
    rlSignal: rlResolved?.signal || 'HOLD',
    sentimentSignal: sentimentSnapshot?.signal || 'HOLD',
    llmSignal: evaluation?.details?.aiReason ? (evaluation?.signal || 'HOLD') : 'HOLD',
    aggregateScore,
  });

  let finalSignal = evaluation?.signal || 'HOLD';
  const technicalSignal = evaluation?.signal || 'HOLD';
  if (coPolicyDecision.signal === 'BUY' && technicalSignal !== 'BUY' && aggregateScore >= 0.60) {
    finalSignal = 'BUY';
  } else if (technicalSignal !== 'BUY' && aggregateScore >= 0.64 && (ml.aggregate?.signal === 'BUY' || rlResolved?.signal === 'BUY')) {
    finalSignal = 'BUY';
  } else if ((coPolicyDecision.signal === 'SELL' && technicalSignal === 'BUY') || (technicalSignal === 'BUY' && aggregateScore <= 0.40 && (ml.aggregate?.signal === 'SELL' || rlResolved?.signal === 'SELL' || sentimentSnapshot?.signal === 'SELL'))) {
    finalSignal = 'HOLD';
  }

  const confidence = clamp(Math.abs(aggregateScore - 0.5) * 2, 0, 1);
  const result = {
    taskClass,
    regimeFamily,
    finalSignal,
    confidence,
    aggregateScore,
    route: {
      weights,
      baseWeights,
      technicalSignal,
      ml: ml.aggregate,
      rl: rlResolved,
      specialists,
      coPolicyDecision,
      sentiment: sentimentSnapshot ? {
        signal: sentimentSnapshot.signal,
        confidence: sentimentSnapshot.confidence,
        score: sentimentSnapshot.aggregateScore,
      } : null,
    },
    predictions: ml.predictions,
  };

  if (registry) {
    await Promise.all([
      ...(ml.predictions || []).map((prediction) => registry.recordPrediction({
        versionId: prediction.versionId,
        chainKey: tokenData?.chainKey,
        symbol: tokenData?.symbol,
        address: tokenData?.address,
        taskClass,
        signal: prediction.signal,
        confidence: prediction.confidence,
        score: prediction.score,
        explanation: prediction.reasoning,
      }).catch((error) => logger?.warn?.(`[Hybrid] prediction persistence failed: ${error.message}`))),
      registry.recordMultiAgentDecision({
        chainKey: tokenData?.chainKey,
        symbol: tokenData?.symbol,
        address: tokenData?.address,
        taskClass,
        regimeFamily,
        finalSignal,
        confidence,
        route: result.route,
        context: {
          aggregateScore,
          strategyName,
        },
      }).catch((error) => logger?.warn?.(`[Hybrid] route persistence failed: ${error.message}`)),
    ]);
  }

  return result;
}

module.exports = {
  runHybridDecision,
  classifyTaskClass,
  getRouteWeights,
};
