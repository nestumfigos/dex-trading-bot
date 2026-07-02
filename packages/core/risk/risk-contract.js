'use strict';

function evaluateRiskEnvelope({
  botProfile,
  strategy,
  symbol,
  safeMode = false,
  killSwitch = false,
  dailyLossPct = 0,
  maxDailyLossPct = 1.5,
  portfolioHeatPct = 0,
  maxPortfolioHeatPct = 100,
  liquidationBufferMultiple = null,
  minLiquidationBufferMultiple = 2,
  expectedNetEdgePct = null,
  minExpectedNetEdgePct = 0,
  portfolioAllocation = null,
} = {}) {
  const reasons = [];
  if (!botProfile) reasons.push('bot_profile_required');
  if (!strategy) reasons.push('strategy_required');
  if (!symbol) reasons.push('symbol_required');
  if (killSwitch) reasons.push('kill_switch_active');
  if (safeMode) reasons.push('safe_mode_active');
  if (Number(dailyLossPct) <= -Math.abs(Number(maxDailyLossPct))) reasons.push('daily_loss_limit_reached');
  if (Number(portfolioHeatPct) > Number(maxPortfolioHeatPct)) reasons.push('portfolio_heat_limit_reached');
  if (
    liquidationBufferMultiple != null
    && Number.isFinite(Number(liquidationBufferMultiple))
    && Number(liquidationBufferMultiple) < Number(minLiquidationBufferMultiple)
  ) {
    reasons.push('liquidation_buffer_too_low');
  }
  if (
    expectedNetEdgePct != null
    && Number.isFinite(Number(expectedNetEdgePct))
    && Number(expectedNetEdgePct) < Number(minExpectedNetEdgePct)
  ) {
    reasons.push('expected_net_edge_below_min');
  }
  if (
    portfolioAllocation
    && portfolioAllocation.proposedTrade
    && portfolioAllocation.proposedTrade.allow === false
  ) {
    const allocationReasons = Array.isArray(portfolioAllocation.proposedTrade.reasons)
      ? portfolioAllocation.proposedTrade.reasons
      : ['allocation_rejected'];
    allocationReasons.forEach((reason) => {
      reasons.push(`portfolio_allocation_${reason}`);
    });
  }
  return {
    allow: reasons.length === 0,
    reasons,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  evaluateRiskEnvelope,
};
