'use strict';

const { evaluateDeviationReclaim } = require('./perps-deviation-reclaim');
const { detectMarketStructureShift } = require('./perps-mss-detector');
const { evaluateLevelToLevel } = require('./perps-l2l-detector');

function rewardRisk({ side, entry, stop, target }) {
  const risk = side === 'long' ? entry - stop : stop - entry;
  const reward = side === 'long' ? target - entry : entry - target;
  return risk > 0 && reward > 0 ? reward / risk : 0;
}

function evaluateTraderXoEntry({
  symbol,
  candles15m = [],
  candles5m = [],
  range,
  anchors,
  equityUsd = 10000,
  leverage = 3,
  riskPct = 0.5,
  levelToLevel = null,
} = {}) {
  const primary = evaluateDeviationReclaim({ candles: candles15m, range });
  const continuation = !primary.qualifies && levelToLevel ? evaluateLevelToLevel({
    candles: candles15m,
    anchors,
    level: levelToLevel.level,
    nextTarget: levelToLevel.nextTarget,
  }) : null;
  const setup = primary.qualifies ? primary : (continuation || primary);
  if (!setup.qualifies) return { qualifies: false, reasons: setup.reasons || primary.reasons };
  const finalTarget = setup.targets[setup.targets.length - 1];
  const rr = rewardRisk({ side: setup.side, entry: setup.entry, stop: setup.stop, target: finalTarget });
  if (rr < 3) return { qualifies: false, reasons: ['reward_risk_below_3'], candidate: { ...setup, rr } };
  const mss = detectMarketStructureShift({ candles: candles5m, side: setup.side });
  if (!mss.confirmed) return { qualifies: false, reasons: ['market_structure_shift_required'], candidate: setup };
  const biasAligned = anchors?.valid && anchors.sideBias === setup.side;
  const setupGrade = biasAligned ? 'A+' : 'A';
  const allowedRiskPct = setupGrade === 'A+' ? Math.min(Number(riskPct), 1) : Math.min(Number(riskPct), 0.5);
  return {
    qualifies: true,
    side: setup.side,
    setup: setup.setup,
    setupGrade,
    anchorBias: anchors?.anchorBias || null,
    range: range ? { high: range.high, low: range.low, eq: range.eq } : null,
    entry: setup.entry,
    stop: setup.stop,
    targets: setup.targets,
    rr,
    mss,
    manualCutReasons: setup.manualCutReasons,
    invalidationReason: setup.invalidationReason,
    order: {
      symbol,
      equityUsd,
      riskPct: allowedRiskPct,
      isAPlus: setupGrade === 'A+',
      setupGrade,
      entryPrice: setup.entry,
      stopPrice: setup.stop,
      leverage,
      plannedRewardRisk: rr,
      marginMode: 'isolated',
      targets: setup.targets,
      anchorBias: anchors?.anchorBias || null,
      range: range ? { high: range.high, low: range.low, eq: range.eq } : null,
      manualCutReasons: setup.manualCutReasons,
      invalidationReason: setup.invalidationReason,
    },
  };
}

// B2P.25 (verified no-fix): anchors are recomputed by `paper-market-scanner.scanSymbol`
// every scan cycle from fresh daily candles, so the scanner's view of HTF anchors
// is current. Per-position `targets` are intentionally STATIC from entry — moving
// them mid-trade would invalidate the original setup geometry (entry/stop/target1
// math). Stale-anchor exposure is therefore limited to the signal-time entry path,
// which already uses fresh anchors at that moment. If a later management decision
// needs HTF context (e.g. trail logic), the caller can pass a refreshed
// `anchors` object into `evaluatePositionManagement` without changing this default.
//
// B2P.27: manual-cut requires trend context. Bot 5-bar "no favorable move"
// check fires regardless of whether price is still in a valid trend. A long
// drifting sideways but holding above EMA20 hasn't actually broken structure;
// cutting it surrenders the setup. Caller MAY pass `trendEma` (EMA20 of the
// 15m candles) and `currentEma` so this function can skip manual cut when
// trend remains intact.
function evaluatePositionManagement({ position, candle, barsSinceEntry = 0, policy = {}, trendEma = null } = {}) {
  if (!position || !candle) return { action: 'HOLD', reason: 'position_and_candle_required' };
  const side = position.side;
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const stop = Number(position.stopPrice);
  const targets = Array.isArray(position.targets) ? position.targets.map(Number).filter(Number.isFinite) : [];
  const target1 = targets[0];
  const target2 = targets[targets.length - 1];
  const alreadyScaled = Number(position.remainingNotionalUsd) < Number(position.notionalUsd) - 0.000001;
  if (side === 'long' && low <= stop) {
    return { action: 'EXIT', price: Math.min(stop, close), reason: 'STRUCTURE_INVALIDATION_STOP' };
  }
  if (side === 'short' && high >= stop) {
    return { action: 'EXIT', price: Math.max(stop, close), reason: 'STRUCTURE_INVALIDATION_STOP' };
  }
  if (
    Number.isFinite(target2)
    && ((side === 'long' && high >= target2) || (side === 'short' && low <= target2))
  ) {
    return { action: 'EXIT', price: target2, reason: 'TARGET2_LEVEL_CLOSE' };
  }
  if (
    !alreadyScaled
    && Number.isFinite(target1)
    && targets.length > 1
    && ((side === 'long' && high >= target1) || (side === 'short' && low <= target1))
  ) {
    return {
      action: 'PARTIAL_EXIT',
      notionalUsd: Number(position.remainingNotionalUsd) / 2,
      price: target1,
      reason: 'TARGET1_EQ_SCALE',
    };
  }
  const manualCutBars = Math.max(1, Number(policy.manualCutBars || 5));
  if (Number(barsSinceEntry) >= manualCutBars) {
    const riskMove = Math.abs(Number(position.entryPrice) - stop);
    const favorableMove = side === 'long' ? close - Number(position.entryPrice) : Number(position.entryPrice) - close;
    if (favorableMove < riskMove) {
      // B2P.27: trend-aware manual cut. Skip if price remains on the right
      // side of trendEma (long: close > ema; short: close < ema). When
      // trendEma not supplied, falls back to the original unconditional cut.
      // NOTE: `Number(null) === 0` so we must explicitly null-check trendEma
      // before treating its number cast as a valid EMA value (0 would otherwise
      // pose as a valid downside reference and the cut would never fire).
      const trendEmaValue = (trendEma != null && Number.isFinite(Number(trendEma)))
        ? Number(trendEma)
        : null;
      const trendIntact = trendEmaValue !== null && (
        (side === 'long' && close > trendEmaValue)
        || (side === 'short' && close < trendEmaValue)
      );
      if (!trendIntact) return { action: 'EXIT', price: close, reason: 'MANUAL_CUT_NO_FOLLOW_THROUGH' };
    }
  }
  return { action: 'HOLD', reason: 'position_managed' };
}

module.exports = { rewardRisk, evaluateTraderXoEntry, evaluatePositionManagement };
