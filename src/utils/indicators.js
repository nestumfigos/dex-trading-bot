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

function volumeSpike(volumes) {
  if (volumes.length < 2) return 1;
  const avg = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  if (avg === 0) return 1;
  return volumes[volumes.length - 1] / avg;
}

function momentumSignal(priceHistory, volumeHistory, cfg) {
  const { emaFast, emaSlow, rsiPeriod, rsiBuyThreshold, volumeSpikeMultiplier } = cfg;

  const fastEma = ema(priceHistory, emaFast);
  const prevFastEma = ema(priceHistory.slice(0, -1), emaFast);
  const slowEma = ema(priceHistory, emaSlow);
  const prevSlowEma = ema(priceHistory.slice(0, -1), emaSlow);
  const rsiVal = rsi(priceHistory, rsiPeriod);
  const spike = volumeSpike(volumeHistory);

  if (fastEma === null || slowEma === null || rsiVal === null) {
    return { signal: 'INSUFFICIENT_DATA', details: {} };
  }

  const emaCrossUp = prevFastEma < prevSlowEma && fastEma > slowEma;
  const emaCrossDown = prevFastEma > prevSlowEma && fastEma < slowEma;
  const rsiOversold = rsiVal < rsiBuyThreshold;
  const rsiOverbought = rsiVal > 70;
  const hasVolumeSpike = spike >= volumeSpikeMultiplier;

  let signal = 'HOLD';
  if (emaCrossUp && rsiOversold && hasVolumeSpike) signal = 'BUY';
  else if (emaCrossDown || rsiOverbought) signal = 'SELL';

  return {
    signal,
    details: {
      fastEma: fastEma.toFixed(8),
      slowEma: slowEma.toFixed(8),
      rsi: rsiVal.toFixed(2),
      volumeSpike: spike.toFixed(2),
      emaCrossUp,
      emaCrossDown,
    },
  };
}

module.exports = { ema, rsi, volumeSpike, momentumSignal };
