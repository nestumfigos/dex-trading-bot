'use strict';

// B1P.9: mode-aware risk gate.
//   paper  — open evaluation, leverage cap 5×, no per-mode position-count cap.
//   canary — spec D.14: isolated margin, max 3× leverage, $100 equity floor, 1 position max.
//   live   — same hard caps as canary; production posture.
const MODE_CAPS = {
  paper: { maxLeverage: 5, maxOpenPositions: Infinity, minEquityUsd: 0 },
  canary: { maxLeverage: 3, maxOpenPositions: 1, minEquityUsd: 100 },
  live: { maxLeverage: 3, maxOpenPositions: 1, minEquityUsd: 100 },
};

function evaluatePaperPerpsRisk({
  equityUsd,
  dailyPnlUsd = 0,
  weeklyPnlUsd = 0,
  plannedRewardRisk = 0,
  liquidationBufferMultiple = 0,
  leverage = 1,
  marginMode = 'isolated',
  dailyR = 0,
  weeklyR = 0,
  // B2P.18: per-trade R cap separate from cumulative daily-R cap. Spec
  // "Daily max loss: -2R OR -2% whichever fires first" is ambiguous — implementing
  // BOTH: any single trade exceeding `maxPerTradeRLoss` (default -2) blocks new
  // entries via this same gate; cumulative `dailyR` is the rolling daily floor.
  perTradeR = 0,
  maxPerTradeRLoss = -2,
  requiredMarginUsd = 0,
  reservedMarginUsd = 0,
  candidateRiskUsd = 0,
  openRiskUsd = 0,
  mode = 'paper',
  openPositionCount = 0,
} = {}) {
  const equity = Number(equityUsd || 0);
  const lev = Number(leverage);
  const rewardRisk = Number(plannedRewardRisk);
  const liquidationBuffer = Number(liquidationBufferMultiple);
  const dayPnl = Number(dailyPnlUsd);
  const weekPnl = Number(weeklyPnlUsd);
  const dayR = Number(dailyR);
  const weekR = Number(weeklyR);
  const requiredMargin = Number(requiredMarginUsd);
  const reservedMargin = Number(reservedMarginUsd);
  const candidateRisk = Number(candidateRiskUsd);
  const currentOpenRisk = Number(openRiskUsd);
  const caps = MODE_CAPS[mode] || MODE_CAPS.paper;
  const reasons = [];
  if (!Number.isFinite(equity) || equity <= 0) reasons.push('invalid_equity');
  else if (equity < caps.minEquityUsd) reasons.push(`equity_below_${mode}_floor`);
  if (marginMode !== 'isolated') reasons.push('isolated_margin_required');
  if (!Number.isFinite(lev) || lev <= 0) reasons.push('invalid_leverage');
  else if (lev > caps.maxLeverage) reasons.push(`leverage_over_${mode}_cap`);
  if (!Number.isFinite(rewardRisk) || rewardRisk < 3) reasons.push('reward_risk_below_3');
  if (!Number.isFinite(liquidationBuffer) || liquidationBuffer < 2) reasons.push('liquidation_buffer_below_2x_stop');
  if (!Number.isFinite(openPositionCount) || openPositionCount < 0) {
    reasons.push('invalid_open_position_count');
  } else if (openPositionCount >= caps.maxOpenPositions) {
    reasons.push(`open_position_cap_reached_for_${mode}`);
  }
  if (!Number.isFinite(requiredMargin) || !Number.isFinite(reservedMargin) || requiredMargin < 0 || reservedMargin < 0) {
    reasons.push('invalid_margin_state');
  } else if (equity > 0 && requiredMargin + reservedMargin > equity) {
    reasons.push('insufficient_available_margin');
  }
  if (!Number.isFinite(candidateRisk) || !Number.isFinite(currentOpenRisk) || candidateRisk < 0 || currentOpenRisk < 0) {
    reasons.push('invalid_open_risk_state');
  } else if (equity > 0 && candidateRisk + currentOpenRisk > equity * 0.02) {
    reasons.push('aggregate_open_risk_above_2_pct');
  }
  // B2P.18: per-trade-R cap is independent of cumulative daily-R cap.
  if (!Number.isFinite(Number(perTradeR))) reasons.push('invalid_per_trade_r_state');
  else if (Number(perTradeR) < 0 && Number(perTradeR) <= Number(maxPerTradeRLoss)) {
    reasons.push('per_trade_loss_limit');
  }
  if (!Number.isFinite(dayPnl) || !Number.isFinite(dayR)) reasons.push('invalid_daily_loss_state');
  else if (equity > 0 && (dayPnl <= -(equity * 0.02) || dayR <= -2)) reasons.push('daily_loss_limit');
  if (!Number.isFinite(weekPnl) || !Number.isFinite(weekR)) reasons.push('invalid_weekly_loss_state');
  else if (equity > 0 && (weekPnl <= -(equity * 0.05) || weekR <= -5)) reasons.push('weekly_loss_limit');
  return { allow: reasons.length === 0, reasons };
}

module.exports = { evaluatePaperPerpsRisk, MODE_CAPS };
