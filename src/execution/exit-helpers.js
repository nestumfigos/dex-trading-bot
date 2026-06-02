'use strict';

// Extracted from src/index.js (Week 12 A.9b).
// Pure exit helpers: trailing-stop state updates + max-hold extension decisions.

function applyTrailingStopState(position, currentPrice, trailingStartMultiplier, trailingStopPct) {
  const price = Number(currentPrice || 0);
  const entryPrice = Number(position?.entryPrice || 0);
  const activation = Number(trailingStartMultiplier || 0);
  const stopPct = Number(trailingStopPct || 0);

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return;
  }
  if (!Number.isFinite(activation) || activation <= 0 || !Number.isFinite(stopPct) || stopPct <= 0) {
    return;
  }
  if (price < entryPrice * activation) {
    return;
  }

  const prevHighest = Number(position.highestPrice || 0);
  const nextHighest = Math.max(prevHighest, price);
  const computedStop = nextHighest * (1 - stopPct / 100);
  const prevStop = Number(position.trailingStop || 0);
  const nextStop = Math.max(prevStop, computedStop);

  position.highestPrice = nextHighest;
  position.trailingStop = nextStop;
}

function shouldExtendMaxHold(position, tokenData, exitSignal, strategyCfg, currentProfit) {
  const details = exitSignal?.details || {};
  const extensionEnabled = strategyCfg.extendMaxHoldOnTrend !== false;
  const maxExtensions = Math.max(0, Number(strategyCfg.maxHoldExtensions || 0));
  const extensionMinutes = Math.max(0, Number(strategyCfg.holdExtensionMinutes || 0));
  const extensionsUsed = Math.max(0, Number(position.holdExtensionsUsed || 0));
  const minProfitPct = Number(strategyCfg.holdExtensionMinProfitPct || 0);
  const currentProfitPct = Number.isFinite(currentProfit) ? currentProfit * 100 : 0;
  const fast = Number(details.fast);
  const slow = Number(details.slow);
  const rsiValue = Number(details.rsiValue);
  const sellRatioPct = Number(details.sellRatio10mPct ?? 0);
  const liquidityDropPct = Number(details.liquidityDropPct ?? 0);
  const holderJumpPct = Number(details.holderJumpPct ?? 0);
  const maxSellRatioPct = Number(strategyCfg.maxSellRatioPct10m || 60);
  const isBackes = ['backes', 'swing', 'backes_swing'].includes(String(position.strategy || '').toLowerCase());
  const maxLiquidityDropPct = Number(strategyCfg.liquidityDropExitPct || (isBackes ? 30 : 20));
  const maxHolderJumpPct = Number(strategyCfg.holderConcentrationJumpPct || (isBackes ? 8 : 6));
  const minTrendRsi = isBackes ? 52 : 50;

  if (!extensionEnabled || extensionMinutes <= 0 || maxExtensions <= 0) return { extend: false, reason: 'extension_disabled' };
  if (extensionsUsed >= maxExtensions) return { extend: false, reason: 'extension_budget_exhausted' };
  if (!Number.isFinite(currentProfitPct) || currentProfitPct < minProfitPct) return { extend: false, reason: 'profit_below_extension_floor' };
  if (exitSignal?.shouldExit) return { extend: false, reason: 'strategy_exit_active' };
  if (details.emaCrossDown) return { extend: false, reason: 'ema_crossdown' };
  if (Number.isFinite(fast) && Number.isFinite(slow) && fast < slow) return { extend: false, reason: 'trend_below_slow_ema' };
  if (Number.isFinite(rsiValue) && rsiValue < minTrendRsi) return { extend: false, reason: 'rsi_too_weak' };
  if (sellRatioPct > maxSellRatioPct) return { extend: false, reason: 'sell_pressure_too_high' };
  if (liquidityDropPct >= maxLiquidityDropPct) return { extend: false, reason: 'liquidity_deteriorating' };
  if (holderJumpPct >= maxHolderJumpPct) return { extend: false, reason: 'holder_concentration_worsening' };
  if (position.trailingStop && Number(tokenData?.price || 0) <= Number(position.trailingStop || 0)) return { extend: false, reason: 'at_trailing_stop' };

  return {
    extend: true,
    reason: 'trend_still_healthy',
    extensionMinutes,
    nextDeadlineAt: new Date(Date.now() + (extensionMinutes * 60000)).toISOString(),
  };
}

module.exports = { applyTrailingStopState, shouldExtendMaxHold };
