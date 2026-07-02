'use strict';

const { routeStrategies, normalizeBotProfile } = require('../../packages/core');

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(safeNumber(value) * factor) / factor;
}

function normalizeStrategyId(value) {
  return String(value || '').trim().toLowerCase();
}

function isStrategyRuntimeEnabled(config, strategyId) {
  const id = normalizeStrategyId(strategyId);
  const cfg = config?.strategies?.[id] || {};
  if (id === 'momentum') return cfg.enabled !== false;
  return cfg.enabled === true;
}

function buildStrategyDescriptors(strategyNames = [], config = {}, marketType = 'spot') {
  return [...new Set(strategyNames.map(normalizeStrategyId).filter(Boolean))]
    .map((strategyId) => {
      const cfg = config?.strategies?.[strategyId] || {};
      const marketTypes = Array.isArray(cfg.marketTypes)
        ? cfg.marketTypes.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : [marketType];
      return {
        id: strategyId,
        marketTypes: marketTypes.length ? marketTypes : [marketType],
        timeframes: Array.isArray(cfg.timeframes) ? cfg.timeframes : [],
      };
    });
}

function executionQualityFromStats(stats = {}) {
  const avgSlippageBps = safeNumber(stats.avgSlippageBps, 0);
  const exitErrorCount = safeNumber(stats.exitErrorCount, 0);
  const skippedExitChecks = safeNumber(stats.skippedExitChecks, 0);
  const slippagePenalty = Math.min(0.6, Math.max(0, avgSlippageBps) / 150);
  const opsPenalty = Math.min(0.4, (exitErrorCount + skippedExitChecks) / 20);
  return round(Math.max(0, Math.min(1, 1 - slippagePenalty - opsPenalty)), 3);
}

function buildPerformanceByStrategy(portfolio = {}, strategyNames = []) {
  const performance = {};
  strategyNames.forEach((strategyName) => {
    const strategyId = normalizeStrategyId(strategyName);
    if (!strategyId) return;
    const stats = portfolio?.strategies?.[strategyId]?.stats || {};
    performance[strategyId] = {
      sampleSize: safeNumber(stats.closedTrades ?? stats.trades, 0),
      trades: safeNumber(stats.closedTrades ?? stats.trades, 0),
      expectancyUsd: safeNumber(stats.expectancyUsd ?? stats.expectancy, 0),
      profitFactor: Number.isFinite(Number(stats.profitFactor)) ? Number(stats.profitFactor) : null,
      executionQuality: executionQualityFromStats(stats),
      avgSlippageBps: round(stats.avgSlippageBps || 0, 2),
    };
  });
  return performance;
}

function getPositionValueUsd(position = {}) {
  const candidates = [
    position.positionValueUsd,
    position.valueUsd,
    position.costBasisUsd,
    position.initialSizeUsd,
    position.amountUsd,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function buildOpenExposure(portfolio = {}, config = {}) {
  const positions = Object.values(portfolio?.positions || {});
  const exposureUsd = positions.reduce((sum, position) => sum + getPositionValueUsd(position), 0);
  const walletCash = safeNumber(portfolio.walletBalanceUsd, safeNumber(portfolio.balance, 0));
  const equityUsd = Math.max(1, walletCash + exposureUsd);
  const correlationByStrategy = {};

  positions.forEach((position) => {
    const strategy = normalizeStrategyId(position.strategy || 'momentum');
    if (!strategy) return;
    const current = safeNumber(correlationByStrategy[strategy], 0);
    const pressure = safeNumber(position.maxOpenCorrelation ?? position.correlationPressure, 0);
    correlationByStrategy[strategy] = Math.max(current, pressure);
  });

  return {
    openPositionCount: positions.length,
    exposureUsd: round(exposureUsd, 2),
    equityUsd: round(equityUsd, 2),
    portfolioHeatPct: round((exposureUsd / equityUsd) * 100, 2),
    maxConcurrentPositions: safeNumber(config?.risk?.maxConcurrentPositions, null),
    correlationByStrategy,
  };
}

function buildRouterConfig(config = {}, strategyNames = []) {
  const source = config.strategyRouter || config.routing || {};
  const enabledStrategyIds = strategyNames.filter((strategyName) => isStrategyRuntimeEnabled(config, strategyName));
  const disabledStrategyIds = strategyNames.filter((strategyName) => !isStrategyRuntimeEnabled(config, strategyName));

  return {
    enabledStrategyIds,
    disabledStrategyIds,
    riskOffAllowedStrategyIds: Array.isArray(source.riskOffAllowedStrategyIds) ? source.riskOffAllowedStrategyIds : [],
    minRiskMultiplier: safeNumber(source.minRiskMultiplier, 0),
    maxRiskMultiplier: safeNumber(source.maxRiskMultiplier, 1),
    baseRiskMultiplier: safeNumber(source.baseRiskMultiplier, 1),
    maxPortfolioHeatPct: safeNumber(source.maxPortfolioHeatPct, safeNumber(config?.risk?.maxPortfolioHeatPct, 100)),
    maxCorrelation: safeNumber(source.maxCorrelation, safeNumber(config?.risk?.maxCorrelation, 0.85)),
    minExecutionQuality: safeNumber(source.minExecutionQuality, 0.4),
    minSampleSize: safeNumber(source.minSampleSize, 20),
    minProfitFactor: safeNumber(source.minProfitFactor, 1),
    maxConcurrentPositions: safeNumber(source.maxConcurrentPositions, safeNumber(config?.risk?.maxConcurrentPositions, Infinity)),
    baseRequiredConfirmations: safeNumber(source.baseRequiredConfirmations, 1),
  };
}

function buildMarketContext({
  botProfile = null,
  marketType = 'spot',
  marketState = {},
  btcRiskOffState = {},
} = {}) {
  const macroRegime = marketState?.macroRegime || {};
  const riskOff = Boolean(
    macroRegime.riskOff
    || marketState?.riskOff
    || btcRiskOffState?.riskOff
    || String(macroRegime.regime || '').toLowerCase().includes('risk_off')
  );

  return {
    botProfile: normalizeBotProfile(botProfile || (marketType === 'perp' ? 'paper_perps' : 'live_spot')),
    marketType,
    symbol: null,
    regime: macroRegime.regime || marketState?.regime || null,
    riskOff,
  };
}

function topGateRejects(cycleStats = {}, limit = 8) {
  return Object.entries(cycleStats.gateRejectCounts || {})
    .map(([reason, count]) => ({ reason, count: safeNumber(count, 0) }))
    .filter((item) => item.count > 0)
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, limit);
}

function buildStrategyRoutingAudit({
  strategyNames = [],
  currentStrategy = null,
  config = {},
  portfolio = {},
  marketState = {},
  btcRiskOffState = {},
  botProfile = null,
  marketType = 'spot',
  cycleStats = {},
  now = () => new Date(),
} = {}) {
  const normalizedStrategyNames = [...new Set(strategyNames.map(normalizeStrategyId).filter(Boolean))];
  const performanceByStrategy = buildPerformanceByStrategy(portfolio, normalizedStrategyNames);
  const openExposure = buildOpenExposure(portfolio, config);
  const marketContext = buildMarketContext({ botProfile, marketType, marketState, btcRiskOffState });
  const routed = routeStrategies({
    now,
    strategies: buildStrategyDescriptors(normalizedStrategyNames, config, marketType),
    marketContext,
    performanceByStrategy,
    openExposure,
    config: buildRouterConfig(config, normalizedStrategyNames),
  });

  const strategy = normalizeStrategyId(currentStrategy || cycleStats.strategy || '');
  const completedAt = cycleStats.completedAt || new Date(now()).toISOString();

  return {
    eventName: 'strategy.routing',
    botProfile: marketContext.botProfile,
    strategy: strategy || null,
    symbol: null,
    severity: 'info',
    occurredAt: completedAt,
    correlationId: strategy ? `strategy-routing:${strategy}:${completedAt}` : null,
    payload: {
      generatedAt: routed.generatedAt,
      currentStrategy: strategy || null,
      enabledStrategies: routed.enabledStrategies,
      decisions: routed.decisions,
      marketContext,
      openExposure,
      performanceByStrategy,
      cycle: {
        strategy: strategy || null,
        evaluated: safeNumber(cycleStats.evaluated, 0),
        passed: safeNumber(cycleStats.passed, 0),
        signalDroughtCycle: Boolean(cycleStats.signalDroughtCycle),
        topGateRejects: topGateRejects(cycleStats),
      },
    },
  };
}

function shouldEmitStrategyRoutingAudit({
  state = {},
  audit,
  nowMs = Date.now(),
  throttleMs = 300000,
} = {}) {
  const strategy = normalizeStrategyId(audit?.strategy || audit?.payload?.currentStrategy || 'global');
  const key = strategy || 'global';
  state.lastEmittedAtByStrategy = state.lastEmittedAtByStrategy || {};
  const last = safeNumber(state.lastEmittedAtByStrategy[key], 0);
  if (last > 0 && nowMs - last < Math.max(0, safeNumber(throttleMs, 300000))) {
    return false;
  }
  state.lastEmittedAtByStrategy[key] = nowMs;
  return true;
}

module.exports = {
  buildStrategyRoutingAudit,
  shouldEmitStrategyRoutingAudit,
  buildPerformanceByStrategy,
  buildOpenExposure,
  buildRouterConfig,
};
