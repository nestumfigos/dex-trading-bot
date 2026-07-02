'use strict';

const VALID_SIGNALS = new Set(['BUY', 'SELL', 'HOLD', 'EXIT', 'UPDATE_STOP', 'OPEN_LONG', 'OPEN_SHORT']);

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeSignal(signal) {
  const value = String(signal || 'HOLD').trim().toUpperCase();
  return VALID_SIGNALS.has(value) ? value : 'HOLD';
}

function normalizeStrategyDecision(raw = {}) {
  const signal = normalizeSignal(raw.signal || raw.action);
  return {
    signal,
    setupType: raw.setupType || raw.setup || null,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0,
    entry: raw.entry ?? raw.entryPrice ?? null,
    stop: raw.stop ?? raw.stopPrice ?? null,
    targets: Array.isArray(raw.targets) ? raw.targets.slice() : [],
    riskUnit: raw.riskUnit ?? raw.riskUsd ?? null,
    expectedCostBps: Number.isFinite(Number(raw.expectedCostBps)) ? Number(raw.expectedCostBps) : null,
    expectedSlippageBps: Number.isFinite(Number(raw.expectedSlippageBps)) ? Number(raw.expectedSlippageBps) : null,
    rejectReasons: Array.isArray(raw.rejectReasons)
      ? raw.rejectReasons.slice()
      : (Array.isArray(raw.reasons) ? raw.reasons.slice() : []),
    features: raw.features && typeof raw.features === 'object' ? { ...raw.features } : {},
    strategyVersion: raw.strategyVersion || raw.version || null,
    configHash: raw.configHash || null,
    raw,
  };
}

function assertStrategyShape(strategy) {
  if (!strategy || typeof strategy !== 'object') throw new Error('strategy must be an object');
  if (!strategy.id || typeof strategy.id !== 'string') throw new Error('strategy.id is required');
  if (!strategy.version || typeof strategy.version !== 'string') throw new Error('strategy.version is required');
  if (!Array.isArray(strategy.marketTypes) || strategy.marketTypes.length === 0) {
    throw new Error('strategy.marketTypes must be a non-empty array');
  }
  if (!Array.isArray(strategy.timeframes) || strategy.timeframes.length === 0) {
    throw new Error('strategy.timeframes must be a non-empty array');
  }
  if (typeof strategy.evaluate !== 'function') throw new Error('strategy.evaluate must be a function');
  if (strategy.manage != null && typeof strategy.manage !== 'function') {
    throw new Error('strategy.manage must be a function when provided');
  }
  return strategy;
}

function buildConfigHashPayload(strategy, config = {}) {
  assertStrategyShape(strategy);
  return stableStringify({
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    config,
  });
}

module.exports = {
  VALID_SIGNALS,
  normalizeSignal,
  normalizeStrategyDecision,
  assertStrategyShape,
  buildConfigHashPayload,
};
