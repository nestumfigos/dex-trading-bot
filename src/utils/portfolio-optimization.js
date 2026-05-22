'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function returnsFromPrices(prices = []) {
  const rows = [];
  const nums = prices.map(Number).filter(Number.isFinite);
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i - 1] > 0) rows.push((nums[i] - nums[i - 1]) / nums[i - 1]);
  }
  return rows;
}

function variance(values = []) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (nums.length < 2) return 0;
  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  return nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / nums.length;
}

function inverseVolWeights(priceHistoryByAsset = {}) {
  const risks = Object.fromEntries(Object.entries(priceHistoryByAsset).map(([asset, prices]) => {
    const vol = Math.sqrt(variance(returnsFromPrices(prices)));
    return [asset, vol > 0 ? vol : 1];
  }));
  const inv = Object.fromEntries(Object.entries(risks).map(([asset, risk]) => [asset, 1 / risk]));
  const total = Object.values(inv).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(inv).map(([asset, value]) => [asset, value / total]));
}

function hierarchicalRiskParityWeights(priceHistoryByAsset = {}, options = {}) {
  const base = inverseVolWeights(priceHistoryByAsset);
  const maxWeight = clamp(Number(options.maxWeight || 0.35), 0.05, 1);
  let capped = Object.fromEntries(Object.entries(base).map(([asset, weight]) => [asset, Math.min(weight, maxWeight)]));
  const total = Object.values(capped).reduce((sum, value) => sum + value, 0) || 1;
  capped = Object.fromEntries(Object.entries(capped).map(([asset, weight]) => [asset, weight / total]));
  return {
    method: 'hrp_inverse_volatility_surrogate',
    weights: capped,
    assetCount: Object.keys(capped).length,
  };
}

function getTargetWeightForAsset(assetKey, priceHistoryByAsset = {}, options = {}) {
  const result = hierarchicalRiskParityWeights(priceHistoryByAsset, options);
  return {
    ...result,
    targetWeight: Number(result.weights?.[assetKey] || 0),
  };
}

module.exports = {
  returnsFromPrices,
  inverseVolWeights,
  hierarchicalRiskParityWeights,
  getTargetWeightForAsset,
};
