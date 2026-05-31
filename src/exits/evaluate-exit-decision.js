'use strict';

/**
 * Pure exit decision evaluator — no side effects, dep-injected.
 *
 * Mirrors the precedence chain inside `checkExitConditions` in src/index.js
 * (~line 6607) so it can be unit-tested in isolation. Pre-extraction for the
 * Week 8 exits/ split: index.js still owns the live wiring + executeSell;
 * this module locks the *decision* logic so the upcoming wire-in cannot
 * silently change exit behavior.
 *
 * Caller responsibilities (NOT done here, by design):
 *   - Pre-compute `exitSignal` via strategy.evaluateExitForStrategy
 *   - Pre-compute `holdExtensionDecision` via shouldExtendMaxHold
 *   - Apply `applyTrailingStopState` mutations BEFORE calling this fn
 *   - For STOP_LOSS / TRAILING_STOP results, run shouldDelayBorderlineStop and
 *     suppress sell if borderline
 *   - Apply returned `mutations` to position
 *   - Invoke executeSell with returned reason + sellPct
 *
 * Inputs are all read-only. Output is { action, reason, sellPct, tierIndex,
 * meta, mutations }.
 */

function decideExitAction({
  position,
  tokenData,
  strategyCfg = {},
  riskCfg = {},
  sellTiers = [],
  exitSignal = null,
  holdExtensionDecision = null,
  staleData = false,
  now = Date.now(),
}) {
  if (!position) throw new Error('decideExitAction: position required');
  if (!tokenData) throw new Error('decideExitAction: tokenData required');

  const price = Number(tokenData.price || 0);
  const entryPrice = Number(position.entryPrice || 0);
  if (!(price > 0) || !(entryPrice > 0)) {
    return noop({ reason: 'insufficient_price_data' });
  }

  const currentProfit = (price - entryPrice) / entryPrice;
  const profitLockMutations = (!staleData && !position.setupType)
    ? buildProfitLockMutations({ position, entryPrice, price, riskCfg })
    : {};

  // 0) BULL-FLAG SETUP — structural stop, measured-move target, manual-cut
  //    deadline. Branches run BEFORE generic trailing/stop logic so the
  //    setup's own invariants govern the exit.
  if (position.setupType === 'spot_day_bull_flag') {
    const structuralStop = Number(position.structuralStopPrice || 0);
    if (structuralStop > 0 && price <= structuralStop) {
      return sell({
        reason: 'BULL_FLAG_STRUCTURAL_STOP',
        sellPct: 1,
        meta: { stopLevel: structuralStop, stopType: 'BULL_FLAG_STRUCTURAL_STOP', currentProfit },
      });
    }

    const measuredMoveTarget = Number(position.measuredMoveTargetPrice || 0);
    if (measuredMoveTarget > 0 && price >= measuredMoveTarget) {
      return sell({
        reason: 'BULL_FLAG_MEASURED_MOVE',
        sellPct: 1,
        meta: { targetLevel: measuredMoveTarget, currentProfit },
      });
    }

    // Manual-cut deadline: if breakout doesn't follow through within N candles,
    // cut at breakeven / minor loss. Only fires if price hasn't moved meaningfully above entry.
    const cutDeadlineMs = Date.parse(position.manualCutDeadlineAt || '') || 0;
    if (cutDeadlineMs > 0 && now >= cutDeadlineMs && currentProfit < 0.005) {
      return sell({
        reason: 'BULL_FLAG_MANUAL_CUT_NO_FOLLOW_THROUGH',
        sellPct: 1,
        meta: { cutDeadline: position.manualCutDeadlineAt, currentProfit },
      });
    }

    // Strategy-level exits (e.g. exitSignal.shouldExit) still apply
    if (!staleData && exitSignal?.shouldExit) {
      return sell({ reason: exitSignal.reason || 'STRATEGY_EXIT', sellPct: 1 });
    }

    // Bull-flag positions skip tier exits, hold extensions, time-based exits —
    // the structural levels above are the full exit contract.
    return noop({ reason: 'bull_flag_hold' });
  }

  // 0b) BACKES HTF SWING — structure-first exits with partials at R/box levels.
  if (position.setupType === 'backes_swing') {
    const invalidation = Number(position.invalidationPrice || position.structuralStopPrice || position.stopLoss || 0);
    if (invalidation > 0 && price <= invalidation) {
      return sell({
        reason: 'BACKES_INVALIDATION_STOP',
        sellPct: 1,
        meta: { stopLevel: invalidation, stopType: 'BACKES_INVALIDATION_STOP', currentProfit },
      });
    }

    const trendFailureReason = getBackesTrendFailureReason({ position, tokenData, exitSignal });
    if (trendFailureReason) {
      return sell({ reason: trendFailureReason, sellPct: 1, meta: { currentProfit } });
    }

    // Refuse to evaluate stale-position age if openedAt is missing — `|| now` previously
    // masked the missing-data case and let time-stop fire only after `maxHoldDays` from "now".
    const openedAtMs = Date.parse(position.openedAt || position.createdAt || '');
    const maxHoldDays = Number(strategyCfg.backesMaxHoldDays || strategyCfg.maxHoldDays || 45);
    if (Number.isFinite(openedAtMs) && Number.isFinite(maxHoldDays) && maxHoldDays > 0 && now >= openedAtMs + maxHoldDays * 86_400_000) {
      return sell({
        reason: 'BACKES_TIME_STOP',
        sellPct: 1,
        meta: { daysInTrade: (now - openedAtMs) / 86_400_000, maxHoldDays },
      });
    }

    const riskPerUnit = entryPrice - invalidation;
    const oneRPrice = riskPerUnit > 0 ? entryPrice + riskPerUnit : 0;
    if (oneRPrice > 0 && price >= oneRPrice && !position.backesPartial1Taken) {
      return sell({
        reason: 'BACKES_PARTIAL_1R',
        sellPct: 0.5,
        meta: { oneRPrice, currentProfit },
        mutations: { backesPartial1Taken: true },
      });
    }

    const targets = Array.isArray(position.targetPrices) ? position.targetPrices.map(Number).filter(Number.isFinite) : [];
    const structureTarget = Number(position.boxMidpointPrice || position.priorDailyResistancePrice || targets[0] || position.measuredMoveTargetPrice || 0);
    if (structureTarget > 0 && price >= structureTarget && !position.backesStructureTargetTaken) {
      return sell({
        reason: 'BACKES_STRUCTURE_TARGET',
        sellPct: 0.5,
        meta: { targetLevel: structureTarget, currentProfit },
        mutations: { backesStructureTargetTaken: true },
      });
    }

    const trendConfirmed = position.backesPartial1Taken || price >= oneRPrice;
    const ma8d = Number(tokenData.ma8d || tokenData.backesMa8d || 0);
    const ma56d = Number(tokenData.ma56d || tokenData.backesMa56d || 0);
    if (trendConfirmed && ma8d > 0 && price < ma8d) {
      return sell({ reason: 'BACKES_TRAIL_8D_MA', sellPct: 1, meta: { ma8d, currentProfit } });
    }
    if (ma56d > 0 && price < ma56d) {
      return sell({ reason: 'BACKES_DAILY_CLOSE_BELOW_56D', sellPct: 1, meta: { ma56d, currentProfit } });
    }

    if (!staleData && exitSignal?.shouldExit) {
      return sell({ reason: exitSignal.reason || 'BACKES_STRATEGY_EXIT', sellPct: 1 });
    }

    return noop({ reason: 'backes_hold', meta: { currentProfit } });
  }

  // 0c) BSC FLOW BREAKOUT — fast setups get hard structural exits. The setup
  // does not use generic tier ladders because stale BSC flow needs to be cut.
  if (position.setupType === 'bsc_flow_breakout') {
    const structuralStop = Number(position.structuralStopPrice || position.invalidationPrice || position.stopLoss || 0);
    if (structuralStop > 0 && price <= structuralStop) {
      return sell({
        reason: 'BSC_FLOW_STRUCTURAL_STOP',
        sellPct: 1,
        meta: { stopLevel: structuralStop, stopType: 'BSC_FLOW_STRUCTURAL_STOP', currentProfit },
      });
    }

    const measuredMoveTarget = Number(position.measuredMoveTargetPrice || position.targetPrice || 0);
    if (measuredMoveTarget > 0 && price >= measuredMoveTarget) {
      return sell({
        reason: 'BSC_FLOW_QUICK_TP',
        sellPct: 1,
        meta: { targetLevel: measuredMoveTarget, currentProfit },
      });
    }

    const openedAtMs = Date.parse(position.openedAt || position.createdAt || '') || now;
    const staleMinutes = Number(position.staleExitMinutes || strategyCfg.bscFlowStaleExitMinutes || strategyCfg.staleExitMinutes || 30);
    const staleProfitThreshold = Number(strategyCfg.bscFlowStaleProfitThresholdPct || strategyCfg.staleProfitThresholdPct || 1) / 100;
    if (Number.isFinite(staleMinutes) && staleMinutes > 0 && now >= openedAtMs + staleMinutes * 60_000 && currentProfit < staleProfitThreshold) {
      return sell({
        reason: 'BSC_FLOW_STALE_EXIT',
        sellPct: 1,
        meta: { minutesInTrade: (now - openedAtMs) / 60000, staleMinutes, currentProfit },
      });
    }

    if (!staleData && exitSignal?.shouldExit) {
      return sell({ reason: exitSignal.reason || 'BSC_FLOW_STRATEGY_EXIT', sellPct: 1 });
    }

    return noop({ reason: 'bsc_flow_hold', meta: { currentProfit } });
  }

  // 1) STRATEGY EXIT — skipped when staleData=true
  if (!staleData && exitSignal?.shouldExit) {
    return sell({ reason: exitSignal.reason || 'STRATEGY_EXIT', sellPct: 1 });
  }

  // 2) TRAILING_STOP — borderline-delay check is caller's job
  const trailingStop = Number(position.trailingStop || 0);
  if (trailingStop > 0 && price <= trailingStop) {
    return sell({
      reason: 'TRAILING_STOP',
      sellPct: 1,
      meta: { stopLevel: trailingStop, stopType: 'TRAILING_STOP', currentProfit },
    });
  }

  // 3) STOP_LOSS
  const stopLoss = Number(position.stopLoss || 0);
  if (stopLoss > 0 && price <= stopLoss) {
    // PENGU pattern fix (2026-05-18): suppress STOP_LOSS for first N hours on
    // adopted positions. Adoption synthesizes entry=current price; any small
    // adverse move trips stop. Grace period lets price find direction.
    // Default 4h; disable via RECONCILE_ADOPT_STOP_GRACE_HOURS=0.
    if (position.adoptedFromWallet) {
      const graceHours = Number(process.env.RECONCILE_ADOPT_STOP_GRACE_HOURS || 4);
      if (graceHours > 0) {
        const adoptedAtMs = Date.parse(position.adoptedAt || position.openedAt || '') || 0;
        const ageHours = adoptedAtMs > 0 ? (now - adoptedAtMs) / 3_600_000 : Infinity;
        if (ageHours < graceHours) {
          return noop({ reason: 'adopted_stop_grace', meta: { stopLevel: stopLoss, ageHours, graceHours } });
        }
      }
    }
    return sell({
      reason: 'STOP_LOSS',
      sellPct: 1,
      meta: { stopLevel: stopLoss, stopType: 'STOP_LOSS', currentProfit },
    });
  }

  // 4) TIME_STOP — may extend via holdExtensionDecision
  const openedAtMs = Date.parse(position.openedAt || position.createdAt || '') || now;
  const minutesInTrade = Math.max(0, (now - openedAtMs) / 60000);
  const maxHoldMinutes = Number(strategyCfg.maxHoldMinutes || riskCfg.maxHoldMinutesGlobal || 4320);
  const holdDeadlineMs = Date.parse(position.holdUntilAt || '') || (openedAtMs + (maxHoldMinutes * 60000));

  if (Number.isFinite(maxHoldMinutes) && maxHoldMinutes > 0 && now >= holdDeadlineMs) {
    if (!staleData && holdExtensionDecision?.extend) {
      return {
        action: 'extend_hold',
        reason: 'MAX_HOLD_EXTENDED',
        sellPct: 0,
        tierIndex: null,
        meta: {
          extensionMinutes: holdExtensionDecision.extensionMinutes,
          nextDeadlineAt: holdExtensionDecision.nextDeadlineAt,
          extensionReason: holdExtensionDecision.reason,
        },
        mutations: {
          holdExtensionsUsed: Math.max(0, Number(position.holdExtensionsUsed || 0)) + 1,
          holdUntilAt: holdExtensionDecision.nextDeadlineAt,
        },
      };
    }
    return sell({
      reason: 'TIME_STOP',
      sellPct: 1,
      meta: {
        minutesInTrade,
        maxHoldMinutes,
        extensionsUsed: Number(position.holdExtensionsUsed || 0),
        extensionReason: holdExtensionDecision?.reason || 'no_extension_decision',
      },
    });
  }

  // 5) MIN_HOLD_NO_GAIN — held >= minHoldHours with no profit
  const minHoldHours = Number(strategyCfg.minHoldHours ?? 4);
  const hoursInTrade = minutesInTrade / 60;
  if (hoursInTrade >= minHoldHours && currentProfit <= 0) {
    return sell({
      reason: 'MIN_HOLD_NO_GAIN',
      sellPct: 1,
      meta: { hoursInTrade, minHoldHours, currentProfit },
    });
  }

  // 6) STALE_DRIFT — 3 graduated tiers
  const staleDriftEnabled = riskCfg.staleDriftExitEnabled !== false;
  if (staleDriftEnabled && currentProfit > 0) {
    const tier1Hours = Number(riskCfg.staleDriftTier1Hours || 12);
    const tier1MinProfit = Number(riskCfg.staleDriftTier1MinProfitPct || 1) / 100;
    const tier2Hours = Number(riskCfg.staleDriftTier2Hours || 24);
    const tier2MinProfit = Number(riskCfg.staleDriftTier2MinProfitPct || 3) / 100;
    const tier3Hours = Number(riskCfg.staleDriftTier3Hours || 48);
    const tier3MinProfit = Number(riskCfg.staleDriftTier3MinProfitPct || 8) / 100;
    let triggeredTier = null;
    if (hoursInTrade >= tier3Hours && currentProfit < tier3MinProfit) triggeredTier = 3;
    else if (hoursInTrade >= tier2Hours && currentProfit < tier2MinProfit) triggeredTier = 2;
    else if (hoursInTrade >= tier1Hours && currentProfit < tier1MinProfit) triggeredTier = 1;
    if (triggeredTier) {
      return sell({
        reason: 'STALE_DRIFT',
        sellPct: 1,
        meta: { tier: triggeredTier, hoursInTrade, currentProfit },
      });
    }
  }

  // Early exit on staleData — skip tier sells + take profit
  if (staleData) {
    return noop({ reason: 'stale_data_no_tier_eval' });
  }

  // 7) SELL_TIER_n loop
  const triggeredSellTiers = position.triggeredSellTiers || {};
  const tierDelayedAt = position.tierDelayedAt || {};
  const prevLocalHigh = Number(position.tierLocalHigh || price);
  const nextLocalHigh = Math.max(prevLocalHigh, price);
  const reversalFromHighPct = nextLocalHigh > 0 ? ((nextLocalHigh - price) / nextLocalHigh) * 100 : 0;

  const adaptiveTierExit = Boolean(strategyCfg.adaptiveTierExit ?? true);
  const tierDelayRsiMin = Number(strategyCfg.tierDelayRsiMin || 70);
  const tierAccelSellRatioPct = Number(strategyCfg.tierAccelSellRatioPct || 60);
  const tierLocalHighReversalPct = Number(strategyCfg.tierLocalHighReversalPct || 5);
  const tierExitRsiValue = Number(exitSignal?.details?.rsiValue ?? NaN);
  const tierSellRatioPct = Number(exitSignal?.details?.sellRatio10mPct ?? 0);

  const TIER_FP_EPSILON = 1e-9; // defeats e.g. 1.3 - 1 = 0.30000000000000004 missing exact-30%-profit
  for (let tierIndex = 0; tierIndex < sellTiers.length; tierIndex += 1) {
    const tier = sellTiers[tierIndex];
    if (triggeredSellTiers[tierIndex]) continue;
    if (!Number.isFinite(Number(tier?.profitMultiplier))) continue;

    if (currentProfit >= (Number(tier.profitMultiplier) - 1) - TIER_FP_EPSILON) {
      // 7a) ACCELERATED: high sell pressure -> full exit from this tier on
      if (adaptiveTierExit && tierSellRatioPct > tierAccelSellRatioPct) {
        return sellTierBatch({
          tierIndex,
          totalTiers: sellTiers.length,
          reason: `SELL_TIER_ACCEL_${tierIndex + 1}`,
          sellPct: 1,
          nextLocalHigh,
          meta: { tierSellRatioPct, tierAccelSellRatioPct, currentProfit, reversalFromHighPct },
        });
      }

      // 7b) REVERSAL: pullback from local high -> full exit
      if (adaptiveTierExit && reversalFromHighPct >= tierLocalHighReversalPct) {
        return sellTierBatch({
          tierIndex,
          totalTiers: sellTiers.length,
          reason: `SELL_TIER_REVERSAL_${tierIndex + 1}`,
          sellPct: 1,
          nextLocalHigh,
          meta: { reversalFromHighPct, tierLocalHighReversalPct, currentProfit },
        });
      }

      // 7c) DELAY: RSI hot + no sell pressure -> hold one cycle
      if (adaptiveTierExit) {
        const alreadyDelayed = Boolean(tierDelayedAt[tierIndex]);
        if (!alreadyDelayed && Number.isFinite(tierExitRsiValue) && tierExitRsiValue > tierDelayRsiMin && tierSellRatioPct <= tierAccelSellRatioPct) {
          return {
            action: 'delay_tier',
            reason: `TIER_DELAYED_${tierIndex + 1}`,
            sellPct: 0,
            tierIndex,
            meta: { tierExitRsiValue, tierDelayRsiMin, tierSellRatioPct, currentProfit },
            mutations: mergeMutations(profitLockMutations, {
              tierDelayedAt: { ...tierDelayedAt, [tierIndex]: now },
              tierLocalHigh: nextLocalHigh,
            }),
          };
        }
      }

      // 7d) NORMAL tier sell
      return {
        action: 'sell',
        reason: `SELL_TIER_${tierIndex + 1}`,
        sellPct: Number(tier.sellPct || 0),
        tierIndex,
        meta: { currentProfit, profitMultiplier: tier.profitMultiplier },
        mutations: mergeMutations(profitLockMutations, {
          triggeredSellTiers: { ...triggeredSellTiers, [tierIndex]: true },
          tierDelayedAt: omitKey(tierDelayedAt, tierIndex),
          tierLocalHigh: nextLocalHigh,
        }),
      };
    }
  }

  // 8) ORPHANED_TIERS_EXIT — all tiers triggered but no sells recorded
  const allTiersTriggered = sellTiers.length > 0 && sellTiers.every((_, i) => triggeredSellTiers[i]);
  const realizedPnlByTier = position.realizedPnlByTier || {};
  const noSellsRecorded = Object.keys(realizedPnlByTier).length === 0;
  if (allTiersTriggered && noSellsRecorded && !position.exitInProgress) {
    return sell({
      reason: 'ORPHANED_TIERS_EXIT',
      sellPct: 1,
      meta: { currentProfit, totalTiers: sellTiers.length },
    });
  }

  // 9) TAKE_PROFIT — explicit takeProfit field (separate from tier ladder)
  const takeProfit = Number(position.takeProfit || 0);
  if (takeProfit > 0 && price >= takeProfit) {
    return sell({
      reason: 'TAKE_PROFIT',
      sellPct: 1,
      meta: { takeProfit, currentProfit },
    });
  }

  return noop({ reason: 'no_exit_trigger', meta: { currentProfit, hoursInTrade }, mutations: profitLockMutations });
}

// --- helpers ---

function sell({ reason, sellPct = 1, meta = {}, mutations = {} }) {
  return { action: 'sell', reason, sellPct, tierIndex: null, meta, mutations };
}

function noop({ reason = 'noop', meta = {}, mutations = {} } = {}) {
  return { action: 'noop', reason, sellPct: 0, tierIndex: null, meta, mutations };
}

function sellTierBatch({ tierIndex, totalTiers, reason, sellPct, nextLocalHigh, meta }) {
  const triggered = {};
  for (let i = tierIndex; i < totalTiers; i += 1) triggered[i] = true;
  return {
    action: 'sell',
    reason,
    sellPct,
    tierIndex,
    meta,
    mutations: {
      triggeredSellTiers: triggered, // caller merges this into existing
      tierLocalHigh: nextLocalHigh,
    },
  };
}

function omitKey(obj, key) {
  const out = { ...(obj || {}) };
  delete out[key];
  return out;
}

function mergeMutations(...items) {
  return Object.assign({}, ...items.filter((item) => item && typeof item === 'object'));
}

function buildProfitLockMutations({ position, entryPrice, price, riskCfg }) {
  if (riskCfg?.profitLockEnabled === false) return {};
  const tiers = Array.isArray(riskCfg?.profitLockTiers) ? riskCfg.profitLockTiers : [];
  if (!tiers.length || !(entryPrice > 0) || !(price > entryPrice)) return {};

  const currentProfitPct = ((price - entryPrice) / entryPrice) * 100;
  const bestTier = tiers
    .map((tier, index) => ({
      index,
      triggerPct: Number(tier?.triggerPct),
      lockPct: Number(tier?.lockPct),
    }))
    .filter((tier) => (
      Number.isFinite(tier.triggerPct)
      && Number.isFinite(tier.lockPct)
      && tier.triggerPct >= 0
      && currentProfitPct >= tier.triggerPct
    ))
    .sort((left, right) => right.triggerPct - left.triggerPct)[0];
  if (!bestTier) return {};

  const lockStop = entryPrice * (1 + (bestTier.lockPct / 100));
  const currentStop = Number(position.stopLoss || 0);
  if (!(lockStop > 0) || lockStop <= currentStop + 1e-12 || lockStop >= price) return {};

  return {
    stopLoss: lockStop,
    profitLockStop: lockStop,
    profitLockTierIndex: bestTier.index,
    profitLockTriggerPct: bestTier.triggerPct,
    profitLockPct: bestTier.lockPct,
  };
}

function getBackesTrendFailureReason({ tokenData, exitSignal }) {
  if (tokenData.dailyCloseBelow56d === true || tokenData.backesDailyCloseBelow56d === true) {
    return 'BACKES_DAILY_CLOSE_BELOW_56D';
  }
  if (tokenData.weeklyCloseBelow8w === true || tokenData.backesWeeklyCloseBelow8w === true) {
    return 'BACKES_WEEKLY_CLOSE_BELOW_8W';
  }
  if (tokenData.failedReclaim === true || tokenData.backesFailedReclaim === true) {
    return 'BACKES_FAILED_RECLAIM';
  }
  const rsi = Number(tokenData.rsi ?? exitSignal?.details?.rsiValue);
  const sellVol = Number(tokenData.sellVolumeRatio ?? tokenData.sellRatio10mPct ?? exitSignal?.details?.sellRatio10mPct ?? 0);
  if (Number.isFinite(rsi) && rsi >= 78 && sellVol >= 60) {
    return 'BACKES_RSI_EXHAUSTION_SELL_VOLUME';
  }
  return null;
}

module.exports = { decideExitAction };
