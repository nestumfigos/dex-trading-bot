'use strict';

const { getOhlcvSeries } = require('./candles');
const { hierarchicalRiskParityWeights } = require('./portfolio-optimization');

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values = []) {
  const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function stddev(values = []) {
  const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (nums.length < 2) return 0;
  const mean = average(nums);
  return Math.sqrt(nums.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / nums.length);
}

function pctChange(from, to) {
  const start = Number(from);
  const end = Number(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return 0;
  return ((end - start) / Math.abs(start)) * 100;
}

function classifyCoverage(barCount = 0) {
  if (barCount >= 240) return 'excellent';
  if (barCount >= 120) return 'good';
  if (barCount >= 60) return 'usable';
  if (barCount >= 30) return 'thin';
  return 'sparse';
}

async function getFeatureSeries({ chainName, tokenData, localPriceHistory = [], localVolumeHistory = [] } = {}) {
  const localCloses = Array.isArray(localPriceHistory) ? localPriceHistory.map(Number).filter(Number.isFinite) : [];
  const localVolumes = Array.isArray(localVolumeHistory) ? localVolumeHistory.map(Number).filter(Number.isFinite) : [];
  if (localCloses.length >= 60) {
    return {
      closes: localCloses.slice(-240),
      volumes: localVolumes.slice(-240),
      source: 'local_history',
    };
  }

  const remote = await getOhlcvSeries({
    chainKey: chainName,
    address: tokenData?.address,
    pairAddress: tokenData?.pairAddress || tokenData?.pair,
    interval: '15m',
    limit: 240,
  }).catch(() => null);

  if (remote?.closes?.length) {
    return {
      closes: remote.closes.slice(-240),
      volumes: (remote.volumes || []).slice(-240),
      source: remote.source || 'ohlcv_remote',
    };
  }

  return {
    closes: localCloses.slice(-240),
    volumes: localVolumes.slice(-240),
    source: 'local_sparse',
  };
}

function computeHrpTargetWeight(portfolioPriceHistory, assetKey) {
  if (!portfolioPriceHistory || typeof portfolioPriceHistory !== 'object') return 0;
  if (!assetKey) return 0;
  const series = portfolioPriceHistory[assetKey];
  if (!Array.isArray(series) || series.length < 2) return 0;
  try {
    const result = hierarchicalRiskParityWeights(portfolioPriceHistory, { maxWeight: 1 });
    const weight = Number(result?.weights?.[assetKey] || 0);
    return Number.isFinite(weight) ? weight : 0;
  } catch {
    return 0;
  }
}

async function buildFeatureSnapshot({
  chainName,
  tokenData,
  strategyName,
  evaluation,
  localPriceHistory = [],
  localVolumeHistory = [],
  sentimentSnapshot = null,
  portfolioPriceHistory = null,
  assetKey = null,
} = {}) {
  const series = await getFeatureSeries({ chainName, tokenData, localPriceHistory, localVolumeHistory });
  const closes = series.closes || [];
  const volumes = series.volumes || [];
  const last = closes.length ? closes[closes.length - 1] : safeNumber(tokenData?.price, 0);
  const prev1 = closes.length > 1 ? closes[closes.length - 2] : last;
  const prev3 = closes.length > 3 ? closes[closes.length - 4] : prev1;
  const prev12 = closes.length > 12 ? closes[closes.length - 13] : prev3;
  const prev24 = closes.length > 24 ? closes[closes.length - 25] : prev12;

  const recentReturns = [];
  for (let i = Math.max(1, closes.length - 12); i < closes.length; i += 1) {
    recentReturns.push(pctChange(closes[i - 1], closes[i]));
  }

  const realizedVolPct = stddev(recentReturns);
  const avgVolume = average(volumes.slice(-24));
  const currentVolume = safeNumber(volumes[volumes.length - 1], safeNumber(tokenData?.volume24h, 0));
  const volumeTrendPct = pctChange(average(volumes.slice(-12, -6)), average(volumes.slice(-6)));
  const sentimentScore = safeNumber(sentimentSnapshot?.aggregateScore, 0.5);

  const features = {
    price: safeNumber(tokenData?.price, last),
    liquidityUsd: safeNumber(tokenData?.liquidityUsd, 0),
    volume24hUsd: safeNumber(tokenData?.volume24h, 0),
    priceChange24hPct: safeNumber(tokenData?.priceChange24h, 0),
    volumeSpike: safeNumber(evaluation?.details?.volumeSpike, 1),
    rsi: safeNumber(evaluation?.details?.rsi, 50),
    fastEma: safeNumber(evaluation?.details?.fastEma, last),
    slowEma: safeNumber(evaluation?.details?.slowEma, last),
    buyRatioRecentPct: safeNumber(evaluation?.details?.buyRatioRecentPct ?? evaluation?.details?.buyRatio10mPct, 50),
    netBuyFlowUsd10m: safeNumber(evaluation?.details?.netBuyFlowUsd10m, 0),
    realizedVolPct,
    return1Pct: pctChange(prev1, last),
    return3Pct: pctChange(prev3, last),
    return12Pct: pctChange(prev12, last),
    return24Pct: pctChange(prev24, last),
    volumeTrendPct,
    avgVolume24Bars: avgVolume,
    currentVolume,
    sentimentScore,
    sentimentConfidence: safeNumber(sentimentSnapshot?.confidence, 0),
    sentimentNewsCount: safeNumber(sentimentSnapshot?.newsCount, 0),
    sentimentRedditCount: safeNumber(sentimentSnapshot?.redditCount, 0),
    sentimentSignal: sentimentSnapshot?.signal || 'HOLD',
    onchainBuyPressure: safeNumber(tokenData?.buyPressureScore ?? evaluation?.details?.buyPressureScore, 0),
    sentimentUpPct: safeNumber(tokenData?.sentimentUpPct, 0),
    sentimentDownPct: safeNumber(tokenData?.sentimentDownPct, 0),
    holderConcentrationRiskPct: safeNumber(tokenData?.holderConcentrationPct, 0),
    ageHours: safeNumber(tokenData?.ageHours, 0),
    confidence: safeNumber(evaluation?.details?.confidence, 0),
    hrpTargetWeight: computeHrpTargetWeight(portfolioPriceHistory, assetKey),
  };

  return {
    ts: new Date().toISOString(),
    chainKey: chainName,
    symbol: tokenData?.symbol || null,
    address: tokenData?.address || null,
    strategy: strategyName || null,
    regimeLabel: evaluation?.details?.marketRegime || tokenData?.marketRegime || 'unknown',
    source: series.source,
    barCount: closes.length,
    coverage: classifyCoverage(closes.length),
    features,
  };
}

module.exports = {
  buildFeatureSnapshot,
  getFeatureSeries,
  classifyCoverage,
};
