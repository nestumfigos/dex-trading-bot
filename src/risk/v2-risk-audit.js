'use strict';

const { buildPortfolioAllocationPlan, evaluateRiskEnvelope, normalizeBotProfile } = require('../../packages/core');

function parseBool(value, fallback = false) {
  if (value == null || value === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function firstBool(...values) {
  for (const value of values) {
    if (value != null && value !== '') return parseBool(value);
  }
  return false;
}

function objectOrNull(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function arrayOrNull(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

function firstObject(...values) {
  for (const value of values) {
    const parsed = objectOrNull(value);
    if (parsed) return parsed;
  }
  return {};
}

function firstArray(...values) {
  for (const value of values) {
    const parsed = arrayOrNull(value);
    if (parsed) return parsed;
  }
  return [];
}

function pctFromDailyPnl(state = {}) {
  const explicit = firstNumber(
    state.dailyLossPct,
    state.dailyDrawdownPct,
    state.todaysPnlPct,
  );
  if (explicit != null) return explicit;

  const pnlUsd = firstNumber(state.todaysPnlUsd, state.dailyPnlUsd, state.realizedPnlUsd);
  const equityUsd = firstNumber(state.walletUsd, state.equityUsd, state.accountEquityUsd, state.balanceUsd);
  if (pnlUsd == null || equityUsd == null || equityUsd <= 0) return 0;
  return (pnlUsd / equityUsd) * 100;
}

function maxDailyLossPct({ state = {}, config = {} } = {}) {
  const explicit = firstNumber(
    config.maxDailyLossPct,
    config.dailyLossLimitPct,
    state.maxDailyLossPct,
    process.env.V2_MAX_DAILY_LOSS_PCT,
    process.env.MAX_DAILY_LOSS_PCT,
    process.env.DAILY_LOSS_LIMIT_PCT,
  );
  if (explicit != null) return Math.abs(explicit);

  const limitUsd = firstNumber(config.dailyDrawdownLimitUsd, state.dailyDrawdownLimitUsd);
  const equityUsd = firstNumber(state.walletUsd, state.equityUsd, state.accountEquityUsd, state.balanceUsd);
  if (limitUsd != null && limitUsd > 0 && equityUsd != null && equityUsd > 0) {
    return Math.abs((limitUsd / equityUsd) * 100);
  }

  return 1.5;
}

function buildV2RiskEnvelopeInput({
  trade = {},
  state = {},
  scope = 'global',
  strategy = 'momentum',
  config = {},
} = {}) {
  const botProfile = normalizeBotProfile(scope);
  const symbol = trade.symbol || trade.contract || trade.pair || null;
  const expectedNetEdgePct = firstNumber(
    trade.expectedNetEdgePct,
    trade.netEdgePct,
    trade.edgePct,
    trade.expectedMoveNetPct,
  );
  const maxPortfolioHeatPctValue = firstNumber(
    config.maxPortfolioHeatPct,
    config.v2MaxPortfolioHeatPct,
    config.risk?.v2MaxPortfolioHeatPct,
    config.risk?.maxPortfolioHeatPct,
    state.maxPortfolioHeatPct,
    process.env.V2_MAX_PORTFOLIO_HEAT_PCT,
    process.env.MAX_PORTFOLIO_HEAT_PCT,
  ) || 100;
  const proposedRiskUsd = firstNumber(
    trade.riskUsd,
    trade.risk_usd,
    trade.maxLossUsd,
    trade.max_loss_usd,
    trade.riskAmountUsd,
    trade.risk_amount_usd,
  );
  const equityUsd = firstNumber(state.walletUsd, state.equityUsd, state.accountEquityUsd, state.balanceUsd, config.equityUsd);
  const exposures = firstArray(
    state.portfolioExposures,
    state.openExposures,
    state.exposures,
    config.portfolioExposures,
    config.openExposures,
  );
  const portfolioAllocation = buildPortfolioAllocationPlan({
    equityUsd: equityUsd || 0,
    exposures,
    targetHeatPct: firstNumber(
      config.targetPortfolioHeatPct,
      config.v2TargetPortfolioHeatPct,
      config.risk?.v2TargetPortfolioHeatPct,
      state.targetPortfolioHeatPct,
      process.env.V2_TARGET_PORTFOLIO_HEAT_PCT,
    ) || Math.min(3, maxPortfolioHeatPctValue),
    maxHeatPct: maxPortfolioHeatPctValue,
    profileBudgets: firstObject(
      config.profileRiskBudgetsPct,
      config.v2ProfileRiskBudgetsPct,
      config.risk?.v2ProfileRiskBudgetsPct,
      state.profileRiskBudgetsPct,
      process.env.V2_PROFILE_RISK_BUDGETS_JSON,
    ),
    strategyBudgets: firstObject(
      config.strategyRiskBudgetsPct,
      config.v2StrategyRiskBudgetsPct,
      config.risk?.v2StrategyRiskBudgetsPct,
      state.strategyRiskBudgetsPct,
      process.env.V2_STRATEGY_RISK_BUDGETS_JSON,
    ),
    correlationPairs: firstObject(config.correlationPairs, state.correlationPairs),
    maxCorrelation: firstNumber(
      config.maxCorrelation,
      config.v2MaxPortfolioCorrelation,
      config.risk?.v2MaxPortfolioCorrelation,
      state.maxCorrelation,
      process.env.V2_MAX_PORTFOLIO_CORRELATION,
    ) || 1,
    proposedTrade: proposedRiskUsd != null && proposedRiskUsd > 0
      ? {
        botProfile,
        marketType: trade.marketType || state.marketType || config.marketType,
        symbol,
        strategy,
        notionalUsd: firstNumber(
          trade.notionalUsd,
          trade.notional_usd,
          trade.quoteUsd,
          trade.quote_usd,
          trade.positionUsd,
          trade.position_usd,
        ) || 0,
        riskUsd: proposedRiskUsd,
        correlationKey: trade.correlationKey || trade.correlation_key || trade.baseAsset || symbol,
      }
      : null,
  });

  return {
    botProfile,
    strategy,
    symbol,
    safeMode: firstBool(
      state.safeMode,
      state.riskSafeMode,
      state.portfolioSafeMode,
      config.safeMode,
      process.env.SAFE_MODE,
      process.env.RISK_SAFE_MODE,
    ),
    killSwitch: firstBool(
      state.killSwitch,
      state.killSwitchActive,
      config.killSwitch,
      process.env.KILL_SWITCH,
      process.env.TRADING_KILL_SWITCH,
    ),
    dailyLossPct: pctFromDailyPnl(state),
    maxDailyLossPct: maxDailyLossPct({ state, config }),
    portfolioHeatPct: exposures.length > 0
      ? portfolioAllocation.currentHeatPct
      : firstNumber(state.portfolioHeatPct, config.portfolioHeatPct) || 0,
    maxPortfolioHeatPct: maxPortfolioHeatPctValue,
    liquidationBufferMultiple: firstNumber(
      trade.liquidationBufferMultiple,
      state.liquidationBufferMultiple,
      config.liquidationBufferMultiple,
    ),
    minLiquidationBufferMultiple: firstNumber(
      config.minLiquidationBufferMultiple,
      process.env.V2_MIN_LIQUIDATION_BUFFER_MULTIPLE,
      process.env.MIN_LIQUIDATION_BUFFER_MULTIPLE,
    ) || 2,
    expectedNetEdgePct,
    minExpectedNetEdgePct: firstNumber(
      config.minExpectedNetEdgePct,
      process.env.V2_MIN_EXPECTED_NET_EDGE_PCT,
      process.env.MIN_EXPECTED_NET_EDGE_PCT,
    ) || 0,
    portfolioAllocation,
  };
}

function runV2RiskAudit({
  side,
  trade = {},
  state = {},
  scope = 'global',
  strategy = 'momentum',
  config = {},
  legacyResult = {},
  logger,
} = {}) {
  if (parseBool(process.env.V2_RISK_AUDIT_ENABLED, true) === false) {
    return { enabled: false };
  }

  try {
    const input = buildV2RiskEnvelopeInput({ trade, state, scope, strategy, config });
    const envelope = evaluateRiskEnvelope(input);
    const legacyBlocked = Array.isArray(legacyResult.blocked) && legacyResult.blocked.length > 0;
    const coreBlocked = envelope.allow === false;
    const disagreement = legacyBlocked !== coreBlocked;
    const audit = {
      enabled: true,
      advisoryOnly: true,
      allow: envelope.allow,
      reasons: envelope.reasons,
      checkedAt: envelope.checkedAt,
      legacyBlocked,
      coreBlocked,
      disagreement,
      input,
    };

    if (coreBlocked && !legacyBlocked && logger && typeof logger.warn === 'function') {
      logger.warn(
        `[v2-risk-audit] ADVISORY_BLOCK ${side || '?'} ${input.symbol || '?'} `
        + `${input.botProfile}/${strategy}: ${envelope.reasons.join(',')}`
      );
    } else if (legacyBlocked && !coreBlocked && logger && typeof logger.debug === 'function') {
      logger.debug(
        `[v2-risk-audit] legacy-only block ${side || '?'} ${input.symbol || '?'} `
        + `${input.botProfile}/${strategy}`
      );
    }

    return audit;
  } catch (err) {
    if (logger && typeof logger.debug === 'function') {
      logger.debug(`[v2-risk-audit] skipped: ${err?.message || err}`);
    }
    return {
      enabled: true,
      advisoryOnly: true,
      error: err?.message || String(err),
    };
  }
}

module.exports = {
  buildV2RiskEnvelopeInput,
  runV2RiskAudit,
};
