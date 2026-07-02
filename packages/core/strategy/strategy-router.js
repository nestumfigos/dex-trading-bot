'use strict';

function toId(value) {
  if (value && typeof value === 'object') return String(value.id || '').trim();
  return String(value || '').trim();
}

function toSet(values) {
  if (!Array.isArray(values)) return null;
  return new Set(values.map(toId).filter(Boolean));
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getStrategyMetric(source, strategyId) {
  if (!source) return {};
  if (source instanceof Map) return source.get(strategyId) || {};
  return source[strategyId] || {};
}

function normalizeStrategies(strategies = []) {
  return strategies
    .map((strategy) => {
      if (typeof strategy === 'string') return { id: strategy };
      return strategy && typeof strategy === 'object' ? { ...strategy } : null;
    })
    .filter((strategy) => toId(strategy));
}

function routeStrategies({
  strategies = [],
  marketContext = {},
  performanceByStrategy = {},
  openExposure = {},
  config = {},
  now = () => new Date(),
} = {}) {
  const enabledSet = toSet(config.enabledStrategyIds);
  const disabledSet = toSet(config.disabledStrategyIds) || new Set();
  const riskOffAllowedSet = toSet(config.riskOffAllowedStrategyIds) || new Set();
  const minRiskMultiplier = numberOr(config.minRiskMultiplier, 0);
  const maxRiskMultiplier = numberOr(config.maxRiskMultiplier, 1);
  const baseRiskMultiplier = numberOr(config.baseRiskMultiplier, 1);
  const maxPortfolioHeatPct = numberOr(config.maxPortfolioHeatPct, 100);
  const maxCorrelation = numberOr(config.maxCorrelation, 0.85);
  const minExecutionQuality = numberOr(config.minExecutionQuality, 0.4);
  const minSampleSize = numberOr(config.minSampleSize, 20);
  const minProfitFactor = numberOr(config.minProfitFactor, 1);
  const maxConcurrentPositions = numberOr(config.maxConcurrentPositions, Infinity);
  const baseRequiredConfirmations = Math.max(0, Math.trunc(numberOr(config.baseRequiredConfirmations, 1)));

  const portfolioHeatPct = numberOr(openExposure.portfolioHeatPct, 0);
  const openPositionCount = numberOr(openExposure.openPositionCount, 0);
  const normalized = normalizeStrategies(strategies);
  const decisions = normalized.map((strategy) => {
    const strategyId = toId(strategy);
    const perf = getStrategyMetric(performanceByStrategy, strategyId);
    const reasons = [];
    let enabled = true;
    let score = 50;
    let riskMultiplier = baseRiskMultiplier;
    let requiredConfirmations = baseRequiredConfirmations;

    if (enabledSet && !enabledSet.has(strategyId)) {
      enabled = false;
      reasons.push('strategy_not_enabled_for_profile');
    }
    if (disabledSet.has(strategyId)) {
      enabled = false;
      reasons.push('strategy_disabled_by_config');
    }
    if (
      Array.isArray(strategy.marketTypes)
      && marketContext.marketType
      && !strategy.marketTypes.includes(marketContext.marketType)
    ) {
      enabled = false;
      reasons.push('market_type_not_supported');
    }
    if (marketContext.riskOff && !riskOffAllowedSet.has(strategyId)) {
      enabled = false;
      reasons.push('macro_risk_off');
    }
    if (portfolioHeatPct >= maxPortfolioHeatPct) {
      enabled = false;
      reasons.push('portfolio_heat_cap_reached');
    }
    if (openPositionCount >= maxConcurrentPositions) {
      enabled = false;
      reasons.push('max_concurrent_positions_reached');
    }

    const sampleSize = numberOr(perf.sampleSize ?? perf.trades, 0);
    const expectancyUsd = numberOr(perf.expectancyUsd ?? perf.expectancy, 0);
    const profitFactor = numberOr(perf.profitFactor, null);
    if (sampleSize >= minSampleSize && expectancyUsd < 0) {
      riskMultiplier *= 0.35;
      score -= 20;
      requiredConfirmations += 1;
      reasons.push('recent_expectancy_negative');
    }
    if (sampleSize >= minSampleSize && profitFactor != null && profitFactor < minProfitFactor) {
      riskMultiplier *= 0.5;
      score -= 15;
      requiredConfirmations += 1;
      reasons.push('profit_factor_below_min');
    }

    const executionQuality = numberOr(
      perf.executionQuality ?? marketContext.executionQualityByStrategy?.[strategyId],
      null,
    );
    if (executionQuality != null && executionQuality < minExecutionQuality) {
      riskMultiplier *= 0.5;
      score -= 10;
      requiredConfirmations += 1;
      reasons.push('execution_quality_below_min');
    }

    const correlation = numberOr(
      perf.maxOpenCorrelation
        ?? openExposure.correlationByStrategy?.[strategyId]
        ?? openExposure.correlationBySymbol?.[marketContext.symbol],
      null,
    );
    if (correlation != null && correlation > maxCorrelation) {
      riskMultiplier *= 0.35;
      score -= 15;
      requiredConfirmations += 1;
      reasons.push('correlation_cap_pressure');
    }

    const liquidityTier = String(marketContext.liquidityTier || '').toLowerCase();
    if (['dust', 'illiquid', 'thin'].includes(liquidityTier)) {
      enabled = false;
      reasons.push('liquidity_tier_not_tradeable');
    } else if (['low', 'weak'].includes(liquidityTier)) {
      riskMultiplier *= 0.5;
      score -= 10;
      requiredConfirmations += 1;
      reasons.push('liquidity_tier_low');
    }

    riskMultiplier = enabled ? clamp(riskMultiplier, minRiskMultiplier, maxRiskMultiplier) : 0;
    if (enabled && riskMultiplier <= 0) {
      enabled = false;
      reasons.push('risk_multiplier_zero');
    }

    return {
      strategyId,
      enabled,
      score: clamp(score, 0, 100),
      riskMultiplier,
      requiredConfirmations,
      reasons,
      route: {
        botProfile: marketContext.botProfile || null,
        marketType: marketContext.marketType || null,
        symbol: marketContext.symbol || null,
        regime: marketContext.regime || null,
      },
    };
  });

  decisions.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return b.score - a.score || a.strategyId.localeCompare(b.strategyId);
  });

  return {
    generatedAt: new Date(now()).toISOString(),
    decisions,
    enabledStrategies: decisions.filter((decision) => decision.enabled).map((decision) => decision.strategyId),
  };
}

module.exports = {
  routeStrategies,
};
