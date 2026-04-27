'use strict';

function ema(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    emaVal = prices[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  const gains = changes.map(c => (c > 0 ? c : 0));
  const losses = changes.map(c => (c < 0 ? Math.abs(c) : 0));

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function volumeSpike(volumes, options = {}) {
  const baselineMethod = String(options.method || 'median').toLowerCase() === 'mean' ? 'mean' : 'median';
  const minBars = Math.max(2, Number(options.minBars || 8));
  if (!Array.isArray(volumes) || volumes.length < minBars) return Number.NaN;

  const previousVolumes = volumes
    .slice(0, -1)
    .map((v) => Number(v || 0))
    .filter((v) => Number.isFinite(v) && v >= 0);
  if (previousVolumes.length < (minBars - 1)) return Number.NaN;

  const baseline = baselineMethod === 'mean'
    ? (previousVolumes.reduce((sum, v) => sum + v, 0) / previousVolumes.length)
    : median(previousVolumes);

  if (!Number.isFinite(baseline) || baseline <= 0) return Number.NaN;
  const latestVolume = Number(volumes[volumes.length - 1] || 0);
  if (!Number.isFinite(latestVolume) || latestVolume < 0) return Number.NaN;

  return latestVolume / baseline;
}

function adx(prices, period = 14) {
  const normalizedPeriod = Math.max(2, Number(period || 14));
  if (!Array.isArray(prices) || prices.length < normalizedPeriod + 1) return null;

  const closes = prices
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (closes.length < normalizedPeriod + 1) return null;

  const dxValues = [];
  for (let index = normalizedPeriod; index < closes.length; index += 1) {
    let positiveDm = 0;
    let negativeDm = 0;
    let trueRange = 0;

    for (let offset = index - normalizedPeriod + 1; offset <= index; offset += 1) {
      const delta = closes[offset] - closes[offset - 1];
      if (delta > 0) positiveDm += delta;
      else if (delta < 0) negativeDm += Math.abs(delta);
      trueRange += Math.abs(delta);
    }

    if (trueRange <= 0) continue;
    const positiveDi = (positiveDm / trueRange) * 100;
    const negativeDi = (negativeDm / trueRange) * 100;
    const denominator = positiveDi + negativeDi;
    if (denominator <= 0) continue;
    dxValues.push((Math.abs(positiveDi - negativeDi) / denominator) * 100);
  }

  if (!dxValues.length) return null;
  return dxValues.reduce((sum, value) => sum + value, 0) / dxValues.length;
}

function momentumSignal(priceHistory, volumeHistory, cfg) {
  const { emaFast, emaSlow, rsiPeriod, rsiBuyThreshold, rsiBuyMaxThreshold, volumeSpikeMultiplier } = cfg;

  const fastEma = ema(priceHistory, emaFast);
  const prevFastEma = ema(priceHistory.slice(0, -1), emaFast);
  const slowEma = ema(priceHistory, emaSlow);
  const prevSlowEma = ema(priceHistory.slice(0, -1), emaSlow);
  const rsiVal = rsi(priceHistory, rsiPeriod);
  const spike = volumeSpike(volumeHistory, {
    method: cfg.volumeBaselineMethod || 'median',
    minBars: Number(cfg.volumeBaselineMinBars || Math.max(8, Number(rsiPeriod || 14) + 1)),
  });

  if (fastEma === null || slowEma === null || rsiVal === null) {
    return { signal: 'INSUFFICIENT_DATA', details: {} };
  }

  const emaCrossUp = prevFastEma < prevSlowEma && fastEma > slowEma;
  const emaCrossDown = prevFastEma > prevSlowEma && fastEma < slowEma;
  const emaAlignedUp = fastEma > slowEma && prevFastEma >= prevSlowEma;
  const emaAlignedDown = fastEma < slowEma && prevFastEma <= prevSlowEma;
  // Momentum trading requires RSI in ZONE (not oversold)
  const rsiBuyMin = Number(rsiBuyThreshold || 45);
  const rsiBuyMax = Number(rsiBuyMaxThreshold || 70);
  const rsiInBuyZone = rsiVal >= rsiBuyMin && rsiVal <= rsiBuyMax;
  // For momentum: allow RSI up to 95 (strong trend), only SELL on extreme overbought (>95) or crossdown
  const rsiExtreme = rsiVal > 95;
  const hasVolumeSpike = Number.isFinite(spike) && spike >= volumeSpikeMultiplier;
  const bullishTrend = emaCrossUp || (cfg.allowTrendContinuation && emaAlignedUp);

  let signal = 'HOLD';
  if (bullishTrend && rsiInBuyZone && hasVolumeSpike) signal = 'BUY';
  // Also allow BUY on bullish trend + volume spike even if RSI slightly high (80-95 is still strong trend)
  else if (bullishTrend && hasVolumeSpike && rsiVal >= rsiBuyMin) signal = 'BUY';
  else if (emaCrossDown || (cfg.allowTrendContinuation && emaAlignedDown) || rsiExtreme) signal = 'SELL';

  return {
    signal,
    details: {
      fastEma: fastEma.toFixed(8),
      slowEma: slowEma.toFixed(8),
      rsi: rsiVal.toFixed(2),
      volumeSpike: spike.toFixed(2),
      emaCrossUp,
      emaCrossDown,
      emaAlignedUp,
      emaAlignedDown,
    },
  };
}

module.exports = { ema, rsi, volumeSpike, adx, momentumSignal };
