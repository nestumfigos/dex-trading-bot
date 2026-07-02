'use strict';

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePromotionMetrics(metrics = {}) {
  return {
    sampleSize: Math.max(0, Math.trunc(numberOr(metrics.sampleSize ?? metrics.trades, 0))),
    expectancyUsd: numberOr(metrics.expectancyUsd ?? metrics.expectancy, 0),
    stressedExpectancyUsd: numberOr(metrics.stressedExpectancyUsd ?? metrics.stressedExpectancy, 0),
    profitFactor: numberOr(metrics.profitFactor, 0),
    maxDrawdownPct: Math.abs(numberOr(metrics.maxDrawdownPct ?? metrics.drawdownPct, 0)),
    symbolConcentrationPct: Math.abs(numberOr(metrics.symbolConcentrationPct, 0)),
    regimeCoverageCount: Math.max(0, Math.trunc(numberOr(metrics.regimeCoverageCount, 0))),
    executionDiscrepancyPct: Math.abs(numberOr(metrics.executionDiscrepancyPct, 0)),
  };
}

function defaultPromotionThresholds(strategyClass = 'generic') {
  const base = {
    minSampleSize: 100,
    minProfitFactor: 1.25,
    minExpectancyUsd: 0,
    minStressedExpectancyUsd: 0,
    maxDrawdownPct: 6,
    maxSymbolConcentrationPct: 35,
    minRegimeCoverageCount: 2,
    maxExecutionDiscrepancyPct: 15,
  };
  if (strategyClass === 'perp') {
    return { ...base, minSampleSize: 200, maxDrawdownPct: 5, maxExecutionDiscrepancyPct: 10 };
  }
  if (strategyClass === 'day_trade') {
    return { ...base, minSampleSize: 100, maxDrawdownPct: 6 };
  }
  if (strategyClass === 'swing') {
    return { ...base, minSampleSize: 60, maxDrawdownPct: 8 };
  }
  return base;
}

function evaluatePromotionGate({
  botProfile,
  targetProfile,
  strategy,
  strategyClass = 'generic',
  metrics = {},
  thresholds = {},
  now = () => new Date(),
} = {}) {
  const normalizedMetrics = normalizePromotionMetrics(metrics);
  const activeThresholds = {
    ...defaultPromotionThresholds(strategyClass),
    ...thresholds,
  };
  const reasons = [];

  if (!botProfile) reasons.push('bot_profile_required');
  if (!targetProfile) reasons.push('target_profile_required');
  if (!strategy) reasons.push('strategy_required');
  if (normalizedMetrics.sampleSize < activeThresholds.minSampleSize) reasons.push('sample_size_below_min');
  if (normalizedMetrics.expectancyUsd <= activeThresholds.minExpectancyUsd) reasons.push('expectancy_not_positive_after_costs');
  if (normalizedMetrics.stressedExpectancyUsd <= activeThresholds.minStressedExpectancyUsd) reasons.push('stressed_expectancy_not_positive');
  if (normalizedMetrics.profitFactor < activeThresholds.minProfitFactor) reasons.push('profit_factor_below_min');
  if (normalizedMetrics.maxDrawdownPct > activeThresholds.maxDrawdownPct) reasons.push('max_drawdown_above_limit');
  if (normalizedMetrics.symbolConcentrationPct > activeThresholds.maxSymbolConcentrationPct) reasons.push('single_symbol_dependency');
  if (normalizedMetrics.regimeCoverageCount < activeThresholds.minRegimeCoverageCount) reasons.push('regime_coverage_below_min');
  if (normalizedMetrics.executionDiscrepancyPct > activeThresholds.maxExecutionDiscrepancyPct) reasons.push('execution_discrepancy_above_max');

  let score = 100;
  score -= Math.max(0, activeThresholds.minSampleSize - normalizedMetrics.sampleSize) / Math.max(1, activeThresholds.minSampleSize) * 25;
  if (normalizedMetrics.expectancyUsd <= activeThresholds.minExpectancyUsd) score -= 20;
  if (normalizedMetrics.stressedExpectancyUsd <= activeThresholds.minStressedExpectancyUsd) score -= 20;
  if (normalizedMetrics.profitFactor < activeThresholds.minProfitFactor) score -= 20;
  if (normalizedMetrics.maxDrawdownPct > activeThresholds.maxDrawdownPct) score -= 15;
  if (normalizedMetrics.symbolConcentrationPct > activeThresholds.maxSymbolConcentrationPct) score -= 10;
  if (normalizedMetrics.regimeCoverageCount < activeThresholds.minRegimeCoverageCount) score -= 10;
  if (normalizedMetrics.executionDiscrepancyPct > activeThresholds.maxExecutionDiscrepancyPct) score -= 10;
  score = Math.max(0, Math.min(100, Number(score.toFixed(2))));

  return {
    passed: reasons.length === 0,
    reasons,
    score,
    botProfile: botProfile || null,
    targetProfile: targetProfile || null,
    strategy: strategy || null,
    strategyClass,
    metrics: normalizedMetrics,
    thresholds: activeThresholds,
    evaluatedAt: new Date(now()).toISOString(),
  };
}

module.exports = {
  normalizePromotionMetrics,
  defaultPromotionThresholds,
  evaluatePromotionGate,
};
