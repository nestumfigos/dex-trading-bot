'use strict';

const config = require('../../config');
const {
  runBacktest,
  runBacktestWithRegimes,
  runWalkForwardBacktest,
  runRegimeSpecificBacktest,
} = require('../backtest');

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function cloneStrategySettings(strategyName = 'momentum') {
  const source = config.strategies?.[strategyName] || config.strategies?.momentum;
  return source ? JSON.parse(JSON.stringify(source)) : null;
}

function buildBaseBacktestOptions(payload = {}) {
  return {
    startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
    tradePct: Number(payload.tradePct || 0.05),
    riskSettings: config.risk,
    entrySlippagePct: Number(payload.entrySlippagePct ?? 0.8),
    exitSlippagePct: Number(payload.exitSlippagePct ?? 1.2),
    entryFeePct: Number(payload.entryFeePct ?? 0.15),
    exitFeePct: Number(payload.exitFeePct ?? 0.15),
    outageChancePct: Number(payload.outageChancePct ?? 0.5),
    ruinDrawdownLimitPct: Number(
      payload.ruinDrawdownLimitPct
      ?? config.backtest?.monteCarloRuinThresholdPct
      ?? config.risk?.dailyDrawdownLimitPct
      ?? 15
    ),
    monteCarloRuns: Number(payload.monteCarloRuns ?? config.backtest?.monteCarloRuns ?? 2000),
    seed: Number(payload.seed || 1337),
    chainKey: String(payload.chainKey || payload.chain || 'solana').toLowerCase(),
  };
}

function runMode(mode, priceHistory, volumeHistory, strategySettings, options = {}) {
  switch (String(mode || 'standard').toLowerCase()) {
    case 'walk_forward':
      return runWalkForwardBacktest(priceHistory, volumeHistory, strategySettings, {
        ...options,
        trainPct: Number(options.trainPct || config.backtest?.walkForwardTrainPct || 0.7),
        validatePct: Number(options.validatePct || config.backtest?.walkForwardValidatePct || 0.15),
      });
    case 'regime':
      return runRegimeSpecificBacktest(priceHistory, volumeHistory, strategySettings, {
        ...options,
        targetRegime: String(options.targetRegime || 'uptrend'),
        regimeWindowBars: Number(options.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      });
    case 'regime_aware':
      return runBacktestWithRegimes(priceHistory, volumeHistory, strategySettings, {
        ...options,
        regimeWindowBars: Number(options.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      });
    case 'standard':
    default:
      return runBacktest(priceHistory, volumeHistory, strategySettings, options);
  }
}

function extractComparableMetrics(result = {}) {
  const hasWalkForwardShape = Object.prototype.hasOwnProperty.call(result || {}, 'train')
    || Object.prototype.hasOwnProperty.call(result || {}, 'test')
    || Object.prototype.hasOwnProperty.call(result || {}, 'overfitAnalysis');
  const target = hasWalkForwardShape ? result?.test : result;
  if (!target || !Number.isFinite(Number(target?.tradeCount))) {
    return null;
  }
  return {
    totalReturn: Number(target?.totalReturn || 0),
    maxDrawdownPct: Number(target?.maxDrawdownPct || 0),
    winRate: Number(target?.winRate || 0),
    tradeCount: Number(target?.tradeCount || 0),
    endingBalance: Number(target?.endingBalance || 0),
    ruinProbabilityPct: Number(target?.monteCarlo?.ruinProbabilityPct || 0),
    overfitSuspicious: Boolean(result?.overfitAnalysis?.overfitSuspicious),
  };
}

function scoreCandidate(metrics = {}) {
  const returnScore = Number(metrics.totalReturn || 0);
  const drawdownPenalty = Number(metrics.maxDrawdownPct || 0) * 0.8;
  const ruinPenalty = Number(metrics.ruinProbabilityPct || 0) * 0.6;
  const winRateBoost = Math.max(0, Number(metrics.winRate || 0) - 45) * 0.25;
  const tradePenalty = Number(metrics.tradeCount || 0) < 3 ? 15 : 0;
  const overfitPenalty = metrics.overfitSuspicious ? 20 : 0;
  return round(returnScore - drawdownPenalty - ruinPenalty + winRateBoost - tradePenalty - overfitPenalty, 3);
}

function buildParameterGrid(baseSettings = {}, overrides = {}) {
  const asList = (value, fallback) => {
    if (Array.isArray(value) && value.length > 0) return value;
    return fallback;
  };

  const grid = {
    emaFast: asList(overrides.emaFast, [Math.max(3, Number(baseSettings.emaFast || 8) - 2), Number(baseSettings.emaFast || 8), Number(baseSettings.emaFast || 8) + 2]),
    emaSlow: asList(overrides.emaSlow, [Math.max(Number(baseSettings.emaFast || 8) + 2, Number(baseSettings.emaSlow || 21) - 5), Number(baseSettings.emaSlow || 21), Number(baseSettings.emaSlow || 21) + 5]),
    rsiBuyThreshold: asList(overrides.rsiBuyThreshold, [Math.max(20, Number(baseSettings.rsiBuyThreshold || 40) - 5), Number(baseSettings.rsiBuyThreshold || 40), Math.min(70, Number(baseSettings.rsiBuyThreshold || 40) + 5)]),
    volumeSpikeMultiplier: asList(overrides.volumeSpikeMultiplier, [Math.max(1, Number(baseSettings.volumeSpikeMultiplier || 1.35) - 0.15), Number(baseSettings.volumeSpikeMultiplier || 1.35), Number(baseSettings.volumeSpikeMultiplier || 1.35) + 0.15]),
    minNetBuyFlowUsd: asList(overrides.minNetBuyFlowUsd, [Math.max(250, Number(baseSettings.minNetBuyFlowUsd || 3500) * 0.75), Number(baseSettings.minNetBuyFlowUsd || 3500), Number(baseSettings.minNetBuyFlowUsd || 3500) * 1.25]),
  };

  return grid;
}

function* cartesianProduct(grid = {}) {
  const keys = Object.keys(grid);
  if (!keys.length) return;

  function* walk(index, current) {
    if (index >= keys.length) {
      yield current;
      return;
    }
    const key = keys[index];
    for (const value of grid[key] || []) {
      yield* walk(index + 1, { ...current, [key]: value });
    }
  }

  yield* walk(0, {});
}

function runHyperopt({
  priceHistory = [],
  volumeHistory = [],
  strategyName = 'momentum',
  mode = 'walk_forward',
  paramGrid = {},
  baseOptions = {},
  maxCandidates = 30,
} = {}) {
  const strategySettings = cloneStrategySettings(strategyName);
  if (!strategySettings) throw new Error(`Unknown strategy: ${strategyName}`);
  if (!Array.isArray(priceHistory) || !Array.isArray(volumeHistory) || priceHistory.length !== volumeHistory.length || priceHistory.length < 30) {
    throw new Error('Insufficient backtest history for hyperopt');
  }

  const grid = buildParameterGrid(strategySettings, paramGrid);
  const results = [];
  let tested = 0;

  for (const candidate of cartesianProduct(grid)) {
    tested += 1;
    if (tested > Math.max(1, Number(maxCandidates || 30))) break;
    const candidateSettings = { ...strategySettings, ...candidate };
    if (Number(candidateSettings.emaFast) >= Number(candidateSettings.emaSlow)) continue;

    const result = runMode(mode, priceHistory, volumeHistory, candidateSettings, baseOptions);
    if (!result) continue;
    const metrics = extractComparableMetrics(result);
    if (!metrics) continue;
    results.push({
      params: candidate,
      score: scoreCandidate(metrics),
      metrics: {
        totalReturn: round(metrics.totalReturn),
        maxDrawdownPct: round(metrics.maxDrawdownPct),
        winRate: round(metrics.winRate),
        tradeCount: metrics.tradeCount,
        ruinProbabilityPct: round(metrics.ruinProbabilityPct),
        overfitSuspicious: metrics.overfitSuspicious,
      },
      result,
    });
  }

  results.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  return {
    ok: true,
    strategy: strategyName,
    mode,
    testedCandidates: tested,
    candidates: results.slice(0, 10),
    winner: results[0] || null,
    generatedAt: new Date().toISOString(),
  };
}

function runValidation({
  priceHistory = [],
  volumeHistory = [],
  strategyName = 'momentum',
  candidateParams = {},
  baselineParams = null,
  mode = 'walk_forward',
  baseOptions = {},
} = {}) {
  const strategySettings = cloneStrategySettings(strategyName);
  if (!strategySettings) throw new Error(`Unknown strategy: ${strategyName}`);
  if (!Array.isArray(priceHistory) || !Array.isArray(volumeHistory) || priceHistory.length !== volumeHistory.length || priceHistory.length < 30) {
    throw new Error('Insufficient backtest history for validation');
  }

  const baselineSettings = { ...strategySettings, ...(baselineParams || {}) };
  const candidateSettings = { ...strategySettings, ...(candidateParams || {}) };
  const baselineResult = runMode(mode, priceHistory, volumeHistory, baselineSettings, baseOptions);
  const candidateResult = runMode(mode, priceHistory, volumeHistory, candidateSettings, baseOptions);
  if (!baselineResult || !candidateResult) {
    throw new Error('Validation backtest failed');
  }

  const baselineMetrics = extractComparableMetrics(baselineResult);
  const candidateMetrics = extractComparableMetrics(candidateResult);
  if (!baselineMetrics || !candidateMetrics) {
    throw new Error('Validation requires a comparable out-of-sample result');
  }
  const delta = {
    totalReturn: round(candidateMetrics.totalReturn - baselineMetrics.totalReturn),
    maxDrawdownPct: round(candidateMetrics.maxDrawdownPct - baselineMetrics.maxDrawdownPct),
    winRate: round(candidateMetrics.winRate - baselineMetrics.winRate),
    tradeCount: candidateMetrics.tradeCount - baselineMetrics.tradeCount,
    ruinProbabilityPct: round(candidateMetrics.ruinProbabilityPct - baselineMetrics.ruinProbabilityPct),
  };

  const passes = (
    delta.totalReturn >= Number(process.env.RESEARCH_VALIDATE_MIN_RETURN_DELTA_PCT || 0.5)
    && delta.maxDrawdownPct <= Number(process.env.RESEARCH_VALIDATE_MAX_DRAWDOWN_DELTA_PCT || 3)
    && delta.ruinProbabilityPct <= Number(process.env.RESEARCH_VALIDATE_MAX_RUIN_DELTA_PCT || 2)
    && candidateMetrics.tradeCount >= Number(process.env.RESEARCH_VALIDATE_MIN_TRADES || 3)
    && !candidateMetrics.overfitSuspicious
  );

  return {
    ok: true,
    strategy: strategyName,
    mode,
    baseline: {
      params: baselineParams || {},
      metrics: baselineMetrics,
      result: baselineResult,
    },
    candidate: {
      params: candidateParams || {},
      metrics: candidateMetrics,
      result: candidateResult,
    },
    delta,
    promotionVerdict: passes ? 'promote' : 'hold',
    rationale: passes
      ? 'Candidate improved return without unacceptable drawdown or ruin risk.'
      : 'Candidate failed validation thresholds or showed overfitting risk.',
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildBaseBacktestOptions,
  runHyperopt,
  runValidation,
};
