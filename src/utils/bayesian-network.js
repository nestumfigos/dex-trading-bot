'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function evidenceScore(value, neutral = 0.5) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : neutral;
}

function signalScore(signal = 'HOLD', score = 0.5) {
  const normalized = String(signal || 'HOLD').toUpperCase();
  const fallback = evidenceScore(score);
  if (normalized === 'BUY') return Math.max(0.58, fallback);
  if (normalized === 'SELL') return Math.min(0.42, fallback);
  return fallback;
}

function evaluateGraphicalBayesianNetwork({
  features = {},
  signals = {},
  regimeFamily = 'unknown',
  taskClass = '',
} = {}) {
  const isEntry = String(taskClass || '').includes('entry');
  const regimePrior = {
    uptrend: 0.58,
    ranging: 0.50,
    high_volatility: isEntry ? 0.42 : 0.50,
    downtrend: isEntry ? 0.38 : 0.50,
    unknown: 0.50,
  };

  const nodes = {
    regime: evidenceScore(regimePrior[regimeFamily] ?? regimePrior.unknown),
    technical: signalScore(signals.technicalSignal, signals.technicalScore),
    ml: signalScore(signals.mlSignal, signals.mlScore),
    rl: signalScore(signals.rlSignal, signals.rlScore),
    sentiment: signalScore(signals.sentimentSignal, signals.sentimentScore),
    llm: signalScore(signals.llmSignal, signals.llmScore),
    onchain: evidenceScore(features.onchainMacroScore, 0.5),
    liquidity: sigmoid(
      (Math.log10(Math.max(1, Number(features.liquidityUsd || 0))) - 4.5)
      + (Number(features.binanceDepthImbalance || 0) * 0.4)
    ),
    risk: clamp(
      1
      - (Number(features.mvrvRiskScore || 0) * 0.35)
      - (Number(features.holderConcentrationRiskPct || 0) / 200)
      - (Number(features.garchVolatilityPct || features.realizedVolPct || 0) / 30),
      0.05,
      0.95
    ),
  };

  const causalWeights = {
    regime: 0.12,
    technical: 0.15,
    ml: 0.18,
    rl: 0.10,
    sentiment: 0.10,
    llm: 0.07,
    onchain: 0.12,
    liquidity: 0.06,
    risk: 0.10,
  };

  const weightedEvidence = Object.entries(causalWeights)
    .reduce((sum, [key, weight]) => sum + (nodes[key] * weight), 0);
  const probability = clamp(weightedEvidence, 0.01, 0.99);
  const confidence = clamp(Math.abs(probability - 0.5) * 2, 0, 1);
  return {
    model: 'graphical_bayesian_network_v1',
    probability,
    confidence,
    signal: probability >= 0.62 ? 'BUY' : probability <= 0.38 ? 'SELL' : 'HOLD',
    nodes,
    weights: causalWeights,
  };
}

module.exports = {
  evaluateGraphicalBayesianNetwork,
};
