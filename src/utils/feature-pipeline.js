'use strict';

const { getOhlcvSeries } = require('./candles');
const { getBinanceConfirmation } = require('./binance-market');
const { getPolygonConfirmation } = require('./polygon-market');
const { getCoinMarketCapContext } = require('./coinmarketcap');
const { getCoinPaprikaContext } = require('./coinpaprika-market');
const { getOnchainMacroSnapshot } = require('./onchain-macro');
const { getTargetWeightForAsset } = require('./portfolio-optimization');
const { classifyCompositeRegime, estimateGarchVolatilityPct, pctChange } = require('./regime-models');
const { forecastArimaReturn, forecastVarMacro, returnsFromCloses } = require('./statistical-models');
const { summarizeFeatureParity } = require('./feature-schema');

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

function estimateAtrProxyPct(closes = []) {
  if (!Array.isArray(closes) || closes.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push(Math.abs(pctChange(closes[i - 1], closes[i])));
  }
  const recent = returns.slice(-14);
  return average(recent);
}

function classifyCoverage(barCount = 0) {
  if (barCount >= 240) return 'excellent';
  if (barCount >= 120) return 'good';
  if (barCount >= 60) return 'usable';
  if (barCount >= 30) return 'thin';
  return 'sparse';
}

function withProviderTimeout(promise, label, timeoutMs = 2500) {
  let timeoutId;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({
          source: label,
          available: false,
          reason: `${label}_timeout_${timeoutMs}ms`,
          confirmsMomentum: false,
        });
      }, Math.max(250, Number(timeoutMs || 2500)));
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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

async function buildFeatureSnapshot({
  chainName,
  tokenData,
  strategyName,
  evaluation,
  localPriceHistory = [],
  localVolumeHistory = [],
  sentimentSnapshot = null,
  portfolioPriceHistory = {},
  assetKey = '',
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
  const garchVolatilityPct = estimateGarchVolatilityPct(recentReturns);
  const atrProxyPct = estimateAtrProxyPct(closes);
  const avgVolume = average(volumes.slice(-24));
  const currentVolume = safeNumber(volumes[volumes.length - 1], safeNumber(tokenData?.volume24h, 0));
  const volumeTrendPct = pctChange(average(volumes.slice(-12, -6)), average(volumes.slice(-6)));
  const sentimentScore = safeNumber(sentimentSnapshot?.aggregateScore, 0.5);
  const providerTimeoutMs = Math.max(500, Number(process.env.MARKET_ENRICHMENT_TIMEOUT_MS || 2500));
  const [binanceConfirmation, polygonConfirmation, coinMarketCapContext, coinPaprikaContext, onchainMacro] = await Promise.all([
    withProviderTimeout(getBinanceConfirmation(tokenData?.symbol, {
      price: tokenData?.price,
      priceChange24hPct: tokenData?.priceChange24h,
    }).catch(() => null), 'binance', providerTimeoutMs),
    withProviderTimeout(getPolygonConfirmation(tokenData?.symbol, {
      price: tokenData?.price,
      priceChange24hPct: tokenData?.priceChange24h,
    }).catch(() => null), 'polygon', providerTimeoutMs),
    withProviderTimeout(getCoinMarketCapContext(tokenData?.symbol, {
      price: tokenData?.price,
      priceChange24hPct: tokenData?.priceChange24h,
    }).catch(() => null), 'coinmarketcap', providerTimeoutMs),
    withProviderTimeout(getCoinPaprikaContext(tokenData?.symbol, {
      price: tokenData?.price,
      priceChange24hPct: tokenData?.priceChange24h,
    }).catch(() => null), 'coinpaprika', providerTimeoutMs),
    withProviderTimeout(getOnchainMacroSnapshot(tokenData, { includeStablecoins: true }).catch(() => null), 'onchain_macro', providerTimeoutMs),
  ]);
  const aggregatorMomentumConfirm = coinMarketCapContext?.confirmsMomentum || coinPaprikaContext?.confirmsMomentum;
  const cexMomentumConfirm = binanceConfirmation?.confirmsMomentum || polygonConfirmation?.confirmsMomentum || aggregatorMomentumConfirm;
  const preliminaryFeatures = {
    return12Pct: pctChange(prev12, last),
    realizedVolPct,
    volumeSpike: safeNumber(evaluation?.details?.volumeSpike, 1),
    sentimentScore,
    binanceMomentumConfirm: cexMomentumConfirm ? 1 : 0,
  };
  const regimeModel = classifyCompositeRegime(preliminaryFeatures, evaluation?.details?.regimeFamily || tokenData?.marketRegime);
  const arimaForecast = forecastArimaReturn(closes);
  const varForecast = forecastVarMacro({
    assetReturns: returnsFromCloses(closes),
    onchainScores: [safeNumber(onchainMacro?.onchainMacroScore, 0.5)],
  });
  const hrp = assetKey
    ? getTargetWeightForAsset(assetKey, portfolioPriceHistory, { maxWeight: 0.35 })
    : null;

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
    garchVolatilityPct,
    atrProxyPct,
    return1Pct: pctChange(prev1, last),
    return3Pct: pctChange(prev3, last),
    return12Pct: pctChange(prev12, last),
    return24Pct: pctChange(prev24, last),
    arimaReturnForecastPct: safeNumber(arimaForecast?.forecastPct, 0),
    arimaForecastConfidence: safeNumber(arimaForecast?.confidence, 0),
    varMacroScore: safeNumber(varForecast?.macroScore, 0.5),
    varMacroConfidence: safeNumber(varForecast?.confidence, 0),
    volumeTrendPct,
    avgVolume24Bars: avgVolume,
    currentVolume,
    sentimentScore,
    sentimentConfidence: safeNumber(sentimentSnapshot?.confidence, 0),
    sentimentNewsCount: safeNumber(sentimentSnapshot?.newsCount, 0),
    sentimentRedditCount: safeNumber(sentimentSnapshot?.redditCount, 0),
    sentimentSignal: sentimentSnapshot?.signal || 'HOLD',
    onchainBuyPressure: safeNumber(tokenData?.buyPressureScore ?? evaluation?.details?.buyPressureScore, 0),
    onchainMacroScore: safeNumber(onchainMacro?.onchainMacroScore, 0.5),
    activeAddresses: safeNumber(onchainMacro?.activeAddresses, 0),
    exchangeFlowScore: safeNumber(onchainMacro?.exchangeFlowScore, 0),
    whaleAccumulationScore: safeNumber(onchainMacro?.whaleAccumulationScore, 0),
    stablecoinSupplyUsd: safeNumber(onchainMacro?.stablecoinSupplyUsd, 0),
    mvrvRiskScore: safeNumber(onchainMacro?.mvrvRiskScore, 0),
    binanceMomentumConfirm: cexMomentumConfirm ? 1 : 0,
    binanceDepthUsd: safeNumber(binanceConfirmation?.depth?.depthUsd, 0),
    binanceDepthImbalance: safeNumber(binanceConfirmation?.depthImbalance, 0),
    binancePriceChangeDiffPct: safeNumber(binanceConfirmation?.priceChangeDiffPct, 0),
    polygonMomentumConfirm: polygonConfirmation?.confirmsMomentum ? 1 : 0,
    polygonPriceChangeDiffPct: safeNumber(polygonConfirmation?.priceChangeDiffPct, 0),
    polygonVolume24hUsd: safeNumber(polygonConfirmation?.volume24hUsd, 0),
    coinMarketCapMomentumConfirm: coinMarketCapContext?.confirmsMomentum ? 1 : 0,
    coinMarketCapRank: safeNumber(coinMarketCapContext?.rank, 0),
    coinMarketCapMarketCapUsd: safeNumber(coinMarketCapContext?.marketCapUsd, 0),
    coinMarketCapVolume24hUsd: safeNumber(coinMarketCapContext?.volume24hUsd, 0),
    coinMarketCapPriceChangeDiffPct: safeNumber(coinMarketCapContext?.priceChangeDiffPct, 0),
    coinPaprikaMomentumConfirm: coinPaprikaContext?.confirmsMomentum ? 1 : 0,
    coinPaprikaRank: safeNumber(coinPaprikaContext?.rank, 0),
    coinPaprikaMarketCapUsd: safeNumber(coinPaprikaContext?.marketCapUsd, 0),
    coinPaprikaVolume24hUsd: safeNumber(coinPaprikaContext?.volume24hUsd, 0),
    coinPaprikaPriceChangeDiffPct: safeNumber(coinPaprikaContext?.priceChangeDiffPct, 0),
    regimeModelConfidence: safeNumber(regimeModel?.confidence, 0),
    hrpTargetWeight: safeNumber(hrp?.targetWeight, 0),
    sentimentUpPct: safeNumber(tokenData?.sentimentUpPct, 0),
    sentimentDownPct: safeNumber(tokenData?.sentimentDownPct, 0),
    holderConcentrationRiskPct: safeNumber(tokenData?.holderConcentrationPct, 0),
    ageHours: safeNumber(tokenData?.ageHours, 0),
    confidence: safeNumber(evaluation?.details?.confidence, 0),
  };
  const parity = summarizeFeatureParity(features);

  return {
    ts: new Date().toISOString(),
    chainKey: chainName,
    symbol: tokenData?.symbol || null,
    address: tokenData?.address || null,
    strategy: strategyName || null,
    regimeLabel: regimeModel?.label || evaluation?.details?.marketRegime || tokenData?.marketRegime || 'unknown',
    source: series.source,
    barCount: closes.length,
    coverage: classifyCoverage(closes.length),
    featureSchema: parity,
    features,
    enrichment: {
      binanceConfirmation,
      polygonConfirmation,
      coinMarketCapContext,
      coinPaprikaContext,
      onchainMacro,
      regimeModel,
      statisticalModels: {
        arimaForecast,
        varForecast,
      },
      portfolioOptimization: hrp,
    },
  };
}

module.exports = {
  buildFeatureSnapshot,
  getFeatureSeries,
  classifyCoverage,
};
