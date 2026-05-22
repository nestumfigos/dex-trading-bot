'use strict';

const { estimateGarchVolatilityPct } = require('./regime-models');

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function pctChange(previous, current) {
  const prev = Number(previous);
  const next = Number(current);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev === 0) return 0;
  return ((next - prev) / Math.abs(prev)) * 100;
}

function returnsFromCloses(closes = []) {
  const nums = closes.map(Number).filter(Number.isFinite);
  const returns = [];
  for (let i = 1; i < nums.length; i += 1) {
    returns.push(pctChange(nums[i - 1], nums[i]));
  }
  return returns;
}

function forecastArimaReturn(closes = []) {
  const returns = returnsFromCloses(closes).slice(-48);
  if (returns.length < 6) {
    return { method: 'arima_lightweight', forecastPct: 0, confidence: 0, samples: returns.length };
  }
  const last = returns[returns.length - 1];
  const mean = average(returns);
  const lag1Numerator = returns.slice(1).reduce((sum, value, index) => (
    sum + ((returns[index] - mean) * (value - mean))
  ), 0);
  const lag1Denominator = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) || 1;
  const phi = Math.max(-0.85, Math.min(0.85, lag1Numerator / lag1Denominator));
  const forecastPct = mean + (phi * (last - mean));
  return {
    method: 'arima_lightweight_ar1',
    forecastPct,
    confidence: Math.min(1, returns.length / 48) * Math.min(1, Math.abs(phi) + 0.15),
    phi,
    samples: returns.length,
  };
}

function forecastVarMacro({ assetReturns = [], marketReturns = [], onchainScores = [] } = {}) {
  const asset = assetReturns.map(Number).filter(Number.isFinite).slice(-48);
  const market = marketReturns.map(Number).filter(Number.isFinite).slice(-48);
  const onchain = onchainScores.map(Number).filter(Number.isFinite).slice(-48);
  if (asset.length < 6) {
    return { method: 'var_lightweight', macroScore: 0.5, confidence: 0, samples: asset.length };
  }
  const assetMomentum = average(asset.slice(-6));
  const marketMomentum = market.length >= 6 ? average(market.slice(-6)) : 0;
  const onchainTilt = onchain.length ? average(onchain.slice(-6)) - 0.5 : 0;
  const macroScore = Math.max(0, Math.min(1, 0.5 + (assetMomentum * 0.025) + (marketMomentum * 0.015) + (onchainTilt * 0.35)));
  return {
    method: 'var_lightweight_macro',
    macroScore,
    confidence: Math.min(1, asset.length / 48),
    assetMomentum,
    marketMomentum,
    onchainTilt,
    samples: asset.length,
  };
}

function estimatePackageGarchSurrogate(returns = []) {
  return {
    method: 'garch_lightweight_surrogate',
    volatilityPct: safeNumber(estimateGarchVolatilityPct(returns), 0),
    samples: Array.isArray(returns) ? returns.length : 0,
  };
}

module.exports = {
  forecastArimaReturn,
  forecastVarMacro,
  estimatePackageGarchSurrogate,
  returnsFromCloses,
};
