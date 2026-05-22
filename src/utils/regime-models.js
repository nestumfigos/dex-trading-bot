'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function avg(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : 0;
}

function stddev(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return 0;
  const mean = avg(nums);
  return Math.sqrt(nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / nums.length);
}

function pctChange(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return ((b - a) / Math.abs(a)) * 100;
}

function buildRegimeVector(features = {}) {
  return [
    Number(features.return12Pct || 0),
    Number(features.realizedVolPct || 0),
    Number(features.volumeSpike || 1),
    Number(features.sentimentScore || 0.5),
    Number(features.binanceMomentumConfirm || 0),
  ];
}

function distance(a = [], b = []) {
  return Math.sqrt(a.reduce((sum, value, index) => sum + ((Number(value || 0) - Number(b[index] || 0)) ** 2), 0));
}

const CENTROIDS = {
  risk_on: [4, 2, 1.4, 0.62, 1],
  risk_off: [-4, 4, 1.2, 0.40, 0],
  chop: [0, 1.5, 0.9, 0.50, 0.5],
  breakout: [7, 3, 2.2, 0.58, 1],
  high_volatility: [0, 7, 1.7, 0.50, 0.5],
};

function classifyKMeansRegime(features = {}) {
  const vector = buildRegimeVector(features);
  const ranked = Object.entries(CENTROIDS)
    .map(([label, centroid]) => ({ label, distance: distance(vector, centroid) }))
    .sort((a, b) => a.distance - b.distance);
  const best = ranked[0] || { label: 'unknown', distance: 0 };
  const second = ranked[1] || { distance: best.distance + 1 };
  const confidence = clamp((second.distance - best.distance) / Math.max(second.distance, 1), 0, 1);
  return { label: best.label, confidence, distances: ranked };
}

function classifyGaussianMixtureRegime(features = {}) {
  const vector = buildRegimeVector(features);
  const raw = Object.entries(CENTROIDS).map(([label, centroid]) => ({
    label,
    weight: Math.exp(-distance(vector, centroid) / 3),
  }));
  const total = raw.reduce((sum, item) => sum + item.weight, 0) || 1;
  const probabilities = Object.fromEntries(raw.map((item) => [item.label, item.weight / total]));
  const best = raw.reduce((top, item) => (item.weight > top.weight ? item : top), raw[0] || { label: 'unknown', weight: 0 });
  return {
    label: best.label,
    confidence: probabilities[best.label] || 0,
    probabilities,
  };
}

function classifyHmmRegime(features = {}, previousRegime = 'unknown') {
  const emissions = classifyGaussianMixtureRegime(features).probabilities;
  const transitionStay = 0.68;
  const labels = Object.keys(CENTROIDS);
  const scores = {};
  for (const label of labels) {
    const transition = label === previousRegime ? transitionStay : (1 - transitionStay) / Math.max(1, labels.length - 1);
    scores[label] = Number(emissions[label] || 0) * transition;
  }
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0) || 1;
  const probabilities = Object.fromEntries(Object.entries(scores).map(([label, value]) => [label, value / total]));
  const label = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  return { label, confidence: probabilities[label] || 0, probabilities };
}

function estimateGarchVolatilityPct(returns = [], options = {}) {
  const values = returns.map(Number).filter(Number.isFinite);
  if (!values.length) return 0;
  const omega = Number(options.omega || 0.05);
  const alpha = Number(options.alpha || 0.12);
  const beta = Number(options.beta || 0.82);
  let variance = Math.max(0.0001, stddev(values) ** 2);
  for (const ret of values.slice(-60)) {
    variance = omega + (alpha * (ret ** 2)) + (beta * variance);
  }
  return Math.sqrt(Math.max(0, variance));
}

function classifyCompositeRegime(features = {}, previousRegime = 'unknown') {
  const kmeans = classifyKMeansRegime(features);
  const gmm = classifyGaussianMixtureRegime(features);
  const hmm = classifyHmmRegime(features, previousRegime);
  const votes = [kmeans.label, gmm.label, hmm.label];
  const tally = votes.reduce((acc, label) => {
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const label = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || hmm.label;
  const confidence = clamp((Number(kmeans.confidence || 0) + Number(gmm.confidence || 0) + Number(hmm.confidence || 0)) / 3, 0, 1);
  return { label, confidence, kmeans, gmm, hmm };
}

module.exports = {
  buildRegimeVector,
  classifyKMeansRegime,
  classifyGaussianMixtureRegime,
  classifyHmmRegime,
  classifyCompositeRegime,
  estimateGarchVolatilityPct,
  pctChange,
};
