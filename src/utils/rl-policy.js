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

function softmax(logitsByAction = {}) {
  const actions = ['BUY', 'HOLD', 'SELL'];
  const maxLogit = Math.max(...actions.map((action) => Number(logitsByAction[action] || 0)));
  const exps = actions.map((action) => Math.exp(Number(logitsByAction[action] || 0) - maxLogit));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(actions.map((action, index) => [action, exps[index] / total]));
}

function chooseAction(probs = {}, deterministic = false) {
  const actions = ['BUY', 'HOLD', 'SELL'];
  if (deterministic) {
    return actions.reduce((best, action) => (Number(probs[action] || 0) > Number(probs[best] || 0) ? action : best), 'HOLD');
  }
  const roll = Math.random();
  let cumulative = 0;
  for (const action of actions) {
    cumulative += Number(probs[action] || 0);
    if (roll <= cumulative) return action;
  }
  return 'HOLD';
}

function ensureActorState(actor, stateKey) {
  if (!actor[stateKey]) {
    actor[stateKey] = { BUY: 0, HOLD: 0, SELL: 0 };
  }
  return actor[stateKey];
}

function estimateAdvantage(reward, value, nextValue, done, gamma) {
  return reward + (done ? 0 : gamma * nextValue) - value;
}

function trainActorCriticPolicy(featureSeries = [], options = {}) {
  const env = new TradingGymEnvironment(featureSeries, options.environment || {});
  const episodes = Math.max(1, Number(options.episodes || 24));
  const actorLearningRate = Number(options.actorLearningRate || 0.045);
  const criticLearningRate = Number(options.criticLearningRate || 0.12);
  const gamma = Number(options.gamma || 0.9);
  const entropyBonus = Math.max(0, Number(options.entropyBonus || 0.01));
  const actor = {};
  const critic = {};
  let totalReward = 0;
  let steps = 0;

  for (let episode = 0; episode < episodes; episode += 1) {
    let state = env.reset();
    let done = false;
    while (!done && state) {
      const stateKey = encodeState(state.features || state);
      const logits = ensureActorState(actor, stateKey);
      const probs = softmax(logits);
      const action = chooseAction(probs, false);
      const step = env.step(action);
      const nextKey = encodeState((step.nextState?.features || step.nextState || {}));
      const value = Number(critic[stateKey] || 0);
      const nextValue = Number(critic[nextKey] || 0);
      const advantage = estimateAdvantage(step.reward, value, nextValue, step.done, gamma);

      critic[stateKey] = value + (criticLearningRate * advantage);
      for (const candidate of ['BUY', 'HOLD', 'SELL']) {
        const indicator = candidate === action ? 1 : 0;
        const entropyTerm = entropyBonus * (1 / 3 - Number(probs[candidate] || 0));
        logits[candidate] += actorLearningRate * ((indicator - Number(probs[candidate] || 0)) * advantage + entropyTerm);
      }

      totalReward += Number(step.reward || 0);
      steps += 1;
      state = step.nextState;
      done = step.done;
    }
  }

  return {
    algorithm: 'actor_critic',
    actor,
    critic,
    actions: ['BUY', 'HOLD', 'SELL'],
    episodes,
    stateCount: Object.keys(actor).length,
    metrics: {
      avgReward: steps > 0 ? totalReward / steps : 0,
      steps,
    },
  };
}

function trainPpoPolicy(featureSeries = [], options = {}) {
  const env = new TradingGymEnvironment(featureSeries, options.environment || {});
  const episodes = Math.max(1, Number(options.episodes || 24));
  const actorLearningRate = Number(options.actorLearningRate || 0.035);
  const criticLearningRate = Number(options.criticLearningRate || 0.10);
  const gamma = Number(options.gamma || 0.9);
  const clipRatio = Math.max(0.01, Number(options.clipRatio || 0.2));
  const epochs = Math.max(1, Number(options.epochs || 3));
  const actor = {};
  const critic = {};
  let totalReward = 0;
  let steps = 0;

  for (let episode = 0; episode < episodes; episode += 1) {
    const trajectory = [];
    let state = env.reset();
    let done = false;
    while (!done && state) {
      const stateKey = encodeState(state.features || state);
      const logits = ensureActorState(actor, stateKey);
      const probs = softmax(logits);
      const action = chooseAction(probs, false);
      const oldProb = Math.max(1e-6, Number(probs[action] || 0));
      const step = env.step(action);
      trajectory.push({
        stateKey,
        action,
        oldProb,
        reward: Number(step.reward || 0),
        nextKey: encodeState((step.nextState?.features || step.nextState || {})),
        done: step.done,
      });
      totalReward += Number(step.reward || 0);
      steps += 1;
      state = step.nextState;
      done = step.done;
    }

    for (let epoch = 0; epoch < epochs; epoch += 1) {
      for (const item of trajectory) {
        const logits = ensureActorState(actor, item.stateKey);
        const probs = softmax(logits);
        const value = Number(critic[item.stateKey] || 0);
        const nextValue = Number(critic[item.nextKey] || 0);
        const advantage = estimateAdvantage(item.reward, value, nextValue, item.done, gamma);
        const newProb = Math.max(1e-6, Number(probs[item.action] || 0));
        const ratio = newProb / item.oldProb;
        const clippedRatio = clamp(ratio, 1 - clipRatio, 1 + clipRatio);
        const policyScale = Math.abs(clippedRatio * advantage) < Math.abs(ratio * advantage) ? clippedRatio : ratio;

        critic[item.stateKey] = value + (criticLearningRate * advantage);
        for (const candidate of ['BUY', 'HOLD', 'SELL']) {
          const indicator = candidate === item.action ? 1 : 0;
          logits[candidate] += actorLearningRate * policyScale * (indicator - Number(probs[candidate] || 0));
        }
      }
    }
  }

  return {
    algorithm: 'ppo',
    actor,
    critic,
    actions: ['BUY', 'HOLD', 'SELL'],
    episodes,
    clipRatio,
    stateCount: Object.keys(actor).length,
    metrics: {
      avgReward: steps > 0 ? totalReward / steps : 0,
      steps,
    },
  };
}

function inferRlAction(policy = {}, featureSnapshot = {}) {
  if (policy?.actor && (policy.algorithm === 'ppo' || policy.algorithm === 'actor_critic')) {
    const stateKey = encodeState(featureSnapshot.features || featureSnapshot);
    const logits = policy.actor[stateKey] || { BUY: 0, HOLD: 0, SELL: 0 };
    const probs = softmax(logits);
    const action = chooseAction(probs, true);
    const sorted = Object.values(probs).map(Number).sort((a, b) => b - a);
    return {
      signal: action,
      confidence: clamp((sorted[0] || 0) - (sorted[1] || 0), 0, 1),
      score: Number(probs[action] || 0),
      stateKey,
      probabilities: probs,
      value: Number(policy.critic?.[stateKey] || 0),
      algorithm: policy.algorithm,
    };
  }
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
    for (let i = 12; i < prices.length; i += 1) {
      const current = prices[i];
      const prev3 = prices[i - 3];
      const prev12 = prices[i - 12];
      if (!Number.isFinite(current) || !Number.isFinite(prev3) || !Number.isFinite(prev12) || prev3 === 0 || prev12 === 0) continue;
      const volWindow = volumes.slice(Math.max(0, i - 12), i + 1);
      const avgVol = volWindow.length ? volWindow.reduce((sum, value) => sum + value, 0) / volWindow.length : 0;
      series.push({
        key,
        price: current,
        features: {
          price: current,
          return3Pct: ((current - prev3) / prev3) * 100,
          return12Pct: ((current - prev12) / prev12) * 100,
          volumeSpike: avgVol > 0 ? (Number(volumes[i] || 0) / avgVol) : 1,
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
  trainActorCriticPolicy,
  trainPpoPolicy,
  inferRlAction,
  buildFeatureSeriesFromHistories,
  encodeState,
  softmax,
};
