'use strict';

const config = require('../../config');
const { evaluateGraphicalBayesianNetwork } = require('./bayesian-network');
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

function likelihoodFromSignal(signal = 'HOLD', confidence = 0, fallbackScore = 0.5) {
  const normalized = String(signal || 'HOLD').toUpperCase();
  const conf = clamp(Number(confidence || 0), 0, 1);
  const score = clamp(Number(fallbackScore || 0.5), 0, 1);
  if (normalized === 'BUY') return clamp(0.55 + (conf * 0.35) + ((score - 0.5) * 0.2), 0.05, 0.95);
  if (normalized === 'SELL') return clamp(0.45 - (conf * 0.35) + ((score - 0.5) * 0.2), 0.05, 0.95);
  return clamp(0.45 + (score * 0.1), 0.20, 0.80);
}

function computeBayesianPosterior({ inputs = {}, regimeFamily = 'unknown', taskClass = '' } = {}) {
  const isEntry = String(taskClass || '').includes('entry');
  const priors = {
    high_volatility: isEntry ? 0.42 : 0.50,
    downtrend: isEntry ? 0.40 : 0.50,
    uptrend: isEntry ? 0.56 : 0.50,
    ranging: isEntry ? 0.48 : 0.50,
    unknown: 0.50,
  };
  const prior = clamp(Number(priors[regimeFamily] ?? priors.unknown), 0.05, 0.95);
  let logOdds = Math.log(prior / (1 - prior));
  const evidence = [
    { name: 'technical', likelihood: likelihoodFromSignal(inputs.technicalSignal, 0.45, inputs.technicalScore), weight: 0.95 },
    { name: 'ml', likelihood: likelihoodFromSignal(inputs.mlSignal, inputs.mlConfidence, inputs.mlScore), weight: 1.10 },
    { name: 'rl', likelihood: likelihoodFromSignal(inputs.rlSignal, inputs.rlConfidence, inputs.rlScore), weight: 0.65 },
    { name: 'sentiment', likelihood: likelihoodFromSignal(inputs.sentimentSignal, inputs.sentimentConfidence, inputs.sentimentScore), weight: 0.75 },
    { name: 'llm', likelihood: likelihoodFromSignal(inputs.llmSignal, inputs.llmConfidence, inputs.llmScore), weight: 0.70 },
  ];

  const terms = evidence.map((item) => {
    const likelihood = clamp(item.likelihood, 0.05, 0.95);
    const contribution = Math.log(likelihood / (1 - likelihood)) * item.weight;
    logOdds += contribution;
    return {
      name: item.name,
      likelihood,
      weight: item.weight,
      contribution,
    };
  });
  const posterior = 1 / (1 + Math.exp(-logOdds));
  return {
    prior,
    posterior: clamp(posterior, 0.01, 0.99),
    terms,
  };
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
  const bayesianInputs = {
    technicalSignal: evaluation?.signal || 'HOLD',
    technicalScore: scoreTechnicalSignal(evaluation?.signal),
    mlSignal: ml.aggregate?.signal || 'HOLD',
    mlScore: ml.aggregate?.score || 0.5,
    mlConfidence: ml.aggregate?.confidence || 0,
    rlSignal: rlResolved?.signal || 'HOLD',
    rlScore: rlResolved?.score || 0.5,
    rlConfidence: rlResolved?.confidence || 0,
    sentimentSignal: sentimentSnapshot?.signal || 'HOLD',
    sentimentScore: Number(sentimentSnapshot?.aggregateScore || 0.5),
    sentimentConfidence: Number(sentimentSnapshot?.confidence || 0),
    llmSignal: evaluation?.details?.aiReason ? (evaluation?.signal || 'HOLD') : 'HOLD',
    llmScore,
    llmConfidence: Number(evaluation?.details?.aiConfidence || 0) / 100,
  };
  const bayesian = computeBayesianPosterior({
    regimeFamily,
    taskClass,
    inputs: bayesianInputs,
  });
  const bayesianNetwork = evaluateGraphicalBayesianNetwork({
    features: featureSnapshot?.features || {},
    signals: bayesianInputs,
    regimeFamily,
    taskClass,
  });
  const fusedScore = clamp((aggregateScore * 0.62) + (bayesian.posterior * 0.23) + (bayesianNetwork.probability * 0.15), 0, 1);
  const coPolicyDecision = buildCoPolicyDecision({
    technicalSignal: evaluation?.signal || 'HOLD',
    mlSignal: ml.aggregate?.signal || 'HOLD',
    rlSignal: rlResolved?.signal || 'HOLD',
    sentimentSignal: sentimentSnapshot?.signal || 'HOLD',
    llmSignal: evaluation?.details?.aiReason ? (evaluation?.signal || 'HOLD') : 'HOLD',
    aggregateScore: fusedScore,
  });

  let finalSignal = evaluation?.signal || 'HOLD';
  const technicalSignal = evaluation?.signal || 'HOLD';
  if (coPolicyDecision.signal === 'BUY' && technicalSignal !== 'BUY' && fusedScore >= 0.60) {
    finalSignal = 'BUY';
  } else if (technicalSignal !== 'BUY' && fusedScore >= 0.64 && (ml.aggregate?.signal === 'BUY' || rlResolved?.signal === 'BUY')) {
    finalSignal = 'BUY';
  } else if ((coPolicyDecision.signal === 'SELL' && technicalSignal === 'BUY') || (technicalSignal === 'BUY' && fusedScore <= 0.40 && (ml.aggregate?.signal === 'SELL' || rlResolved?.signal === 'SELL' || sentimentSnapshot?.signal === 'SELL'))) {
    finalSignal = 'HOLD';
  }

  const confidence = clamp(Math.abs(fusedScore - 0.5) * 2, 0, 1);
  const result = {
    taskClass,
    regimeFamily,
    finalSignal,
    confidence,
    aggregateScore: fusedScore,
    route: {
      weights,
      baseWeights,
      technicalSignal,
      ml: ml.aggregate,
      rl: rlResolved,
      bayesian,
      bayesianNetwork,
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
          aggregateScore: fusedScore,
          bayesianPosterior: bayesian.posterior,
          bayesianNetworkProbability: bayesianNetwork.probability,
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
  computeBayesianPosterior,
};
