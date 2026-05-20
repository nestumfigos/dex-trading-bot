'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeSymbol } = require('../src/utils/binance-market');
const { buildFeatureSnapshot } = require('../src/utils/feature-pipeline');
const { deriveOnchainMacroFeatures } = require('../src/utils/onchain-macro');
const { hierarchicalRiskParityWeights } = require('../src/utils/portfolio-optimization');
const { evaluateGraphicalBayesianNetwork } = require('../src/utils/bayesian-network');
const { forecastArimaReturn, forecastVarMacro, returnsFromCloses } = require('../src/utils/statistical-models');
const {
  classifyCompositeRegime,
  classifyGaussianMixtureRegime,
  classifyKMeansRegime,
  classifyHmmRegime,
  estimateGarchVolatilityPct,
} = require('../src/utils/regime-models');

test('normalizeSymbol maps assets to Binance USDT symbols', () => {
  assert.equal(normalizeSymbol('btc'), 'BTCUSDT');
  assert.equal(normalizeSymbol('ETH/USDT'), 'ETHUSDT');
});

test('on-chain macro features score accumulation and participation', () => {
  const features = deriveOnchainMacroFeatures({
    activeAddresses: 100000,
    exchangeInflowUsd: 1000,
    exchangeOutflowUsd: 5000,
    whaleNetFlowUsd: 25000,
    mvrv: 1.4,
  }, { stablecoinSupplyUsd: 150_000_000_000 });
  assert.ok(features.onchainMacroScore > 0.5);
  assert.ok(features.participationScore > 0);
});

test('regime classifiers identify bullish breakout-like conditions', () => {
  const features = {
    return12Pct: 8,
    realizedVolPct: 3,
    volumeSpike: 2.4,
    sentimentScore: 0.62,
    binanceMomentumConfirm: 1,
  };
  assert.ok(['breakout', 'risk_on'].includes(classifyKMeansRegime(features).label));
  assert.ok(['breakout', 'risk_on'].includes(classifyGaussianMixtureRegime(features).label));
  assert.ok(classifyHmmRegime(features, 'risk_on').confidence > 0);
  assert.ok(classifyCompositeRegime(features, 'risk_on').confidence > 0);
});

test('GARCH volatility estimate increases with larger returns', () => {
  const calm = estimateGarchVolatilityPct([0.1, -0.1, 0.2, -0.2]);
  const volatile = estimateGarchVolatilityPct([3, -4, 5, -6]);
  assert.ok(volatile > calm);
});

test('statistical models expose ARIMA and VAR lightweight forecasts', () => {
  const closes = [1, 1.01, 1.03, 1.02, 1.05, 1.07, 1.10, 1.11];
  const arima = forecastArimaReturn(closes);
  const varModel = forecastVarMacro({
    assetReturns: returnsFromCloses(closes),
    marketReturns: [0.1, 0.2, 0.1, 0.3, 0.2, 0.1],
    onchainScores: [0.55, 0.6, 0.62],
  });
  assert.equal(arima.method, 'arima_lightweight_ar1');
  assert.equal(varModel.method, 'var_lightweight_macro');
  assert.ok(varModel.macroScore > 0.5);
});

test('graphical Bayesian network responds to bullish evidence', () => {
  const result = evaluateGraphicalBayesianNetwork({
    regimeFamily: 'uptrend',
    taskClass: 'momentum_entry_confirmation',
    features: {
      liquidityUsd: 250000,
      onchainMacroScore: 0.7,
      binanceDepthImbalance: 0.2,
      garchVolatilityPct: 2,
      mvrvRiskScore: 0.1,
    },
    signals: {
      technicalSignal: 'BUY',
      technicalScore: 0.72,
      mlSignal: 'BUY',
      mlScore: 0.68,
      rlSignal: 'BUY',
      rlScore: 0.65,
      sentimentSignal: 'BUY',
      sentimentScore: 0.64,
    },
  });
  assert.equal(result.signal, 'BUY');
  assert.ok(result.nodes.onchain > 0.5);
});

test('HRP surrogate returns normalized capped weights', () => {
  const result = hierarchicalRiskParityWeights({
    A: [1, 1.01, 1.02, 1.03, 1.04],
    B: [1, 1.10, 0.90, 1.12, 0.88],
    C: [1, 1.02, 1.04, 1.06, 1.08],
  }, { maxWeight: 0.6 });
  const total = Object.values(result.weights).reduce((sum, value) => sum + value, 0);
  assert.equal(result.method, 'hrp_inverse_volatility_surrogate');
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('feature snapshot exposes HRP target weight from portfolio history', async () => {
  const closes = Array.from({ length: 80 }, (_, index) => 1 + (index * 0.01));
  const snapshot = await buildFeatureSnapshot({
    chainName: 'kucoin',
    tokenData: { symbol: 'AAA', price: closes.at(-1), priceChange24h: 3, volume24h: 100000 },
    strategyName: 'momentum',
    evaluation: { details: { volumeSpike: 1.4, rsi: 55 } },
    localPriceHistory: closes,
    localVolumeHistory: closes.map(() => 1000),
    portfolioPriceHistory: {
      'kucoin:aaa': closes,
      'kucoin:bbb': closes.map((value, index) => value + Math.sin(index) * 0.05),
    },
    assetKey: 'kucoin:aaa',
  });
  assert.ok(snapshot.features.hrpTargetWeight > 0);
});
