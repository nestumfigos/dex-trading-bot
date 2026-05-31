'use strict';

// Extracted from src/index.js (Week 12 A.15).
// Coordinates per-token exit checks: trailing stop, strategy signal, hold extension,
// pure decision call, borderline-stop delay, then dispatch to executeSell.

const { decideExitAction: _decideExitAction } = require('../exits/evaluate-exit-decision');

function createExitConditions(deps) {
  const {
    config,
    logger,
    portfolio,
    strategy,
    buildTokenKey,
    applyTrailingStopState,
    shouldExtendMaxHold,
    shouldDelayBorderlineStop,
    getExecuteSell,
  } = deps;

  async function checkExitConditions(chainName, exchange, tokenData, position, options = {}) {
    if (portfolio.safeMode) {
      logger.warn('Exit checks suspended in safe mode', {
        chain: chainName,
        symbol: tokenData?.symbol,
        address: tokenData?.address,
      });
      return;
    }

    const staleData = Boolean(options.staleData);
    const currentProfit = (tokenData.price - position.entryPrice) / position.entryPrice;
    const strategyName = position.strategy || 'momentum';
    const strategySellTiersRaw = config.strategies?.[strategyName]?.sellTiers || config.strategy?.sellTiers;
    const strategySellTiers = Array.isArray(strategySellTiersRaw) ? strategySellTiersRaw : [];
    const strategyCfg = config.strategies?.[strategyName] || {};

    const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
    const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
    applyTrailingStopState(position, tokenData.price, trailingStartMultiplier, trailingStopPct);

    let exitSignal = null;
    if (!staleData) {
      try {
        exitSignal = strategy.evaluateExitForStrategy(
          position.strategyKey || buildTokenKey(chainName, tokenData.address),
          strategyName,
          tokenData,
          position
        );
      } catch (error) {
        logger.warn(`Strategy exit evaluation failed for ${tokenData.symbol} [${strategyName}]: ${error.message}`);
      }
    }

    const holdExtensionDecision = shouldExtendMaxHold(position, tokenData, exitSignal, strategyCfg, currentProfit);

    const decision = _decideExitAction({
      position,
      tokenData,
      strategyCfg,
      riskCfg: config.risk || {},
      sellTiers: strategySellTiers,
      exitSignal,
      holdExtensionDecision,
      staleData,
      now: Date.now(),
    });

    const mut = decision.mutations || {};
    if (mut.triggeredSellTiers) {
      position.triggeredSellTiers = position.triggeredSellTiers || {};
      Object.assign(position.triggeredSellTiers, mut.triggeredSellTiers);
    }
    if (mut.tierDelayedAt !== undefined) position.tierDelayedAt = mut.tierDelayedAt;
    if (mut.tierLocalHigh !== undefined) position.tierLocalHigh = mut.tierLocalHigh;
    if (mut.holdExtensionsUsed !== undefined) position.holdExtensionsUsed = mut.holdExtensionsUsed;
    if (mut.holdUntilAt !== undefined) position.holdUntilAt = mut.holdUntilAt;
    if (mut.stopLoss !== undefined) position.stopLoss = mut.stopLoss;
    if (mut.profitLockStop !== undefined) position.profitLockStop = mut.profitLockStop;
    if (mut.profitLockTierIndex !== undefined) position.profitLockTierIndex = mut.profitLockTierIndex;
    if (mut.profitLockTriggerPct !== undefined) position.profitLockTriggerPct = mut.profitLockTriggerPct;
    if (mut.profitLockPct !== undefined) position.profitLockPct = mut.profitLockPct;

    if (decision.action === 'noop') return;

    if (decision.action === 'extend_hold') {
      logger.info(
        `MAX HOLD EXTENDED for ${tokenData.symbol}: extension ${position.holdExtensionsUsed}/${Number(strategyCfg.maxHoldExtensions || 0)} ` +
        `for ${decision.meta.extensionMinutes}m (${decision.meta.extensionReason})`
      );
      return;
    }

    if (decision.action === 'delay_tier') {
      const rsi = Number(decision.meta?.tierExitRsiValue);
      const rsiMin = Number(decision.meta?.tierDelayRsiMin);
      logger.info(`SELL TIER ${(decision.tierIndex || 0) + 1} DELAYED for ${tokenData.symbol}: RSI ${Number.isFinite(rsi) ? rsi.toFixed(0) : '?'} > ${rsiMin}`);
      return;
    }

    if (decision.action !== 'sell') return;

    if (decision.reason === 'STOP_LOSS' || decision.reason === 'TRAILING_STOP') {
      if (shouldDelayBorderlineStop(position, tokenData.price, decision.meta?.stopLevel, decision.reason)) {
        return;
      }
    }

    const reason = decision.reason;
    if (reason === 'TRAILING_STOP') {
      logger.info(`TRAILING STOP triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    } else if (reason === 'STOP_LOSS') {
      logger.info(`STOP LOSS triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    } else if (reason === 'TIME_STOP') {
      const m = decision.meta || {};
      logger.info(
        `TIME STOP triggered for ${tokenData.symbol}: held ${Number(m.minutesInTrade || 0).toFixed(0)}m ` +
        `>= ${m.maxHoldMinutes}m, extensions=${m.extensionsUsed}, reason=${m.extensionReason}`
      );
    } else if (reason === 'MIN_HOLD_NO_GAIN') {
      const m = decision.meta || {};
      logger.info(
        `MIN_HOLD_NO_GAIN exit for ${tokenData.symbol} [${strategyName}]: ` +
        `held ${Number(m.hoursInTrade || 0).toFixed(1)}h, pnl ${(currentProfit * 100).toFixed(2)}%`
      );
    } else if (reason === 'STALE_DRIFT') {
      const m = decision.meta || {};
      logger.info(
        `STALE_DRIFT exit for ${tokenData.symbol} [${strategyName}]: tier ${m.tier} ` +
        `(held ${Number(m.hoursInTrade || 0).toFixed(1)}h, ${(currentProfit * 100).toFixed(2)}%)`
      );
    } else if (reason.startsWith('SELL_TIER_ACCEL_')) {
      const m = decision.meta || {};
      logger.info(`SELL TIER ${(decision.tierIndex || 0) + 1} ACCELERATED for ${tokenData.symbol}: sell pressure ${Number(m.tierSellRatioPct || 0).toFixed(1)}% -> full exit`);
    } else if (reason.startsWith('SELL_TIER_REVERSAL_')) {
      const m = decision.meta || {};
      logger.info(`SELL TIER ${(decision.tierIndex || 0) + 1} ACCELERATED for ${tokenData.symbol}: reversal ${Number(m.reversalFromHighPct || 0).toFixed(1)}% -> full exit`);
    } else if (reason.startsWith('SELL_TIER_')) {
      const tier = strategySellTiers[decision.tierIndex] || {};
      logger.info(`SELL TIER ${(decision.tierIndex || 0) + 1} triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}% -> selling ${(Number(tier.sellPct || 0) * 100).toFixed(0)}%`);
    } else if (reason === 'ORPHANED_TIERS_EXIT') {
      logger.warn(`[Exit] ORPHANED TIERS for ${tokenData.symbol}: all ${strategySellTiers.length} tiers triggered but no sells recorded — forcing full exit at ${(currentProfit * 100).toFixed(1)}%`);
    } else if (reason === 'TAKE_PROFIT') {
      logger.info(`TAKE PROFIT triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    } else {
      logger.info(`STRATEGY EXIT triggered for ${tokenData.symbol} [${strategyName}]: ${reason}`);
    }

    const executeSell = getExecuteSell();
    await executeSell(chainName, exchange, tokenData, position, decision.sellPct, reason);
  }

  return { checkExitConditions };
}

module.exports = { createExitConditions };
