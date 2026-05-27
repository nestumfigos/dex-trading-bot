'use strict';

const { TradingGymEnvironment } = require('./rl-environment');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bucket(value, thresholds = []) {
  const numeric = Number(value || 0);
  for (let i = 0; i < thresholds.length; i += 1) {
    if (numeric < thresholds[i]) return i;
  }
  return thresholds.length;
}

function encodeState(features = {}) {
  return [
    bucket(features.return3Pct,          [-4, -1.5, 0, 1.5, 4]),
    bucket(features.return12Pct,          [-6, -2, 0, 2, 6]),
    bucket(features.volumeSpike,          [0.85, 1.05, 1.25, 1.6, 2.2]),
    bucket(features.rsi,                  [30, 42, 52, 62, 72]),
    bucket(features.sentimentScore,       [0.38, 0.46, 0.52, 0.60, 0.70]),
    bucket(features.realizedVolPct,       [1.5, 3, 5, 8]),
    bucket(features.buyRatioRecentPct,    [40, 48, 54, 62]),
    bucket(features.netBuyFlowUsd10m,     [-5000, 0, 3000, 10000]),
  ].join(':');
}

function trainQPolicy(featureSeries = [], options = {}) {
  const actions = ['BUY', 'HOLD', 'SELL'];
  const env = new TradingGymEnvironment(featureSeries, options.environment || {});
  const alpha = Number(options.alpha || 0.12);
  const gamma = Number(options.gamma || 0.9);
  const epsilon = Number(options.epsilon || 0.15);
  const episodes = Math.max(1, Number(options.episodes || 24));
  const q = {};

  function ensureState(stateKey) {
    if (!q[stateKey]) {
      q[stateKey] = { BUY: 0, HOLD: 0, SELL: 0 };
    }
    return q[stateKey];
  }

  for (let episode = 0; episode < episodes; episode += 1) {
    let state = env.reset();
    let done = false;
    while (!done && state) {
      const stateKey = encodeState(state.features || state);
      const stateQ = ensureState(stateKey);
      const action = Math.random() < epsilon
        ? actions[Math.floor(Math.random() * actions.length)]
        : actions.reduce((best, candidate) => (stateQ[candidate] > stateQ[best] ? candidate : best), 'HOLD');
      const step = env.step(action);
      const nextKey = encodeState((step.nextState?.features || step.nextState || {}));
      const nextQ = ensureState(nextKey);
      const nextBest = Math.max(nextQ.BUY, nextQ.HOLD, nextQ.SELL);
      stateQ[action] = stateQ[action] + alpha * (step.reward + (gamma * nextBest) - stateQ[action]);
      state = step.nextState;
      done = step.done;
    }
  }

  return {
    q,
    actions,
    episodes,
    stateCount: Object.keys(q).length,
  };
}

function inferRlAction(policy = {}, featureSnapshot = {}) {
  const q = policy?.q || {};
  const stateKey = encodeState(featureSnapshot.features || featureSnapshot);
  const stateQ = q[stateKey] || { BUY: 0, HOLD: 0, SELL: 0 };
  const action = ['BUY', 'HOLD', 'SELL'].reduce((best, candidate) => (stateQ[candidate] > stateQ[best] ? candidate : best), 'HOLD');
  const values = Object.values(stateQ);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const confidence = clamp(Math.abs(max - min), 0, 1);
  return {
    signal: action,
    confidence,
    score: max,
    stateKey,
    q: stateQ,
  };
}

function buildFeatureSeriesFromHistories(priceHistory = {}, volumeHistory = {}, limit = 12) {
  const series = [];
  const ranked = Object.entries(priceHistory || {})
    .map(([key, values]) => ({ key, values: Array.isArray(values) ? values : [] }))
    .filter((entry) => entry.values.length >= 80)
    .sort((left, right) => right.values.length - left.values.length)
    .slice(0, Math.max(1, Number(limit || 12)));

  for (const entry of ranked) {
    const key = entry.key;
    const prices = entry.values.map(Number).filter(Number.isFinite);
    const volumes = (volumeHistory?.[key] || []).map(Number).filter(Number.isFinite);
    // B2.14: feature leakage fix. The original code computed `volWindow` as
    // `volumes.slice(max(0,i-12), i+1)` — i.e. INCLUDING `volumes[i]` itself.
    // Then `volumeSpike = volumes[i] / avgVol(volWindow)` correlated `volumes[i]`
    // with its own average → a future-volume-spike feature, indistinguishable
    // in training data from "the bar that drove the spike already happened".
    // Live data can't peek at bar `i+0` until after the decision at `i`.
    //
    // Fix: lag the window by `LOOKAHEAD_LAG` bars. `volWindow` now covers
    // `[i-12-lag, i-1-lag]` and `volumeSpike` compares `volumes[i-lag]` to
    // that lagged baseline. Default lag = 3 bars (per audit recommendation);
    // overridable via second-arg shape later if needed.
    const LOOKAHEAD_LAG = 3;
    for (let i = 12 + LOOKAHEAD_LAG; i < prices.length; i += 1) {
      const current = prices[i];
      const prev3 = prices[i - 3];
      const prev12 = prices[i - 12];
      if (!Number.isFinite(current) || !Number.isFinite(prev3) || !Number.isFinite(prev12) || prev3 === 0 || prev12 === 0) continue;
      const windowStart = Math.max(0, i - 12 - LOOKAHEAD_LAG);
      const windowEnd = i - LOOKAHEAD_LAG; // exclusive — slice(..., windowEnd) excludes index `windowEnd`
      const volWindow = volumes.slice(windowStart, windowEnd);
      const avgVol = volWindow.length ? volWindow.reduce((sum, value) => sum + value, 0) / volWindow.length : 0;
      const laggedVolume = Number(volumes[i - LOOKAHEAD_LAG] || 0);
      series.push({
        key,
        price: current,
        features: {
          price: current,
          return3Pct: ((current - prev3) / prev3) * 100,
          return12Pct: ((current - prev12) / prev12) * 100,
          volumeSpike: avgVol > 0 ? (laggedVolume / avgVol) : 1,
          rsi: 50,
          sentimentScore: 0.5,
          realizedVolPct: 3,
        },
      });
    }
  }
  return series;
}

module.exports = {
  trainQPolicy,
  inferRlAction,
  buildFeatureSeriesFromHistories,
  encodeState,
};
