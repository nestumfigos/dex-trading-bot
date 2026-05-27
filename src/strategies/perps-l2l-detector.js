'use strict';

const { normalizeCandles } = require('./perps-anchors');

// B2P.26: target-validity gate. Previously the detector accepted any
// nextTarget the caller passed (typically monthlyOpen). If the target sits
// INSIDE the current range or is the wrong side of recent extremes, the
// L2L "continuation" target is unreachable in the signal direction —
// stops/manual-cuts trigger first, locking in losses on a target that
// could never have been hit. Require target beyond recent latest extreme
// in the signal direction.
function evaluateLevelToLevel({ candles = [], anchors, level, nextTarget, stopBufferPct = 0.1 } = {}) {
  const rows = normalizeCandles(candles);
  if (rows.length < 2 || !anchors?.valid || !Number.isFinite(Number(level)) || !Number.isFinite(Number(nextTarget))) {
    return { qualifies: false, reasons: ['level_to_level_context_required'] };
  }
  const prior = rows[rows.length - 2];
  const latest = rows[rows.length - 1];
  const trigger = Number(level);
  const target = Number(nextTarget);
  const weeklyOpen = Number(anchors.weeklyOpen);
  const buffer = Number(stopBufferPct) / 100;
  // B2P.26: pre-compute latest-window extremes for target validity.
  const recentWindow = rows.slice(-Math.min(10, rows.length));
  const recentHigh = Math.max(...recentWindow.map((row) => row.high));
  const recentLow = Math.min(...recentWindow.map((row) => row.low));
  if (
    latest.close > weeklyOpen
    && target > trigger
    && prior.close > trigger
    && latest.low <= trigger
    && latest.close > trigger
  ) {
    // B2P.26: long target must exceed recent-window high; otherwise it's
    // inside consolidation and price has already proven it can't break through.
    if (target <= recentHigh) {
      return { qualifies: false, reasons: ['l2l_long_target_inside_recent_range'] };
    }
    return {
      qualifies: true,
      side: 'long',
      setup: 'level_to_level',
      entry: latest.close,
      stop: latest.low * (1 - buffer),
      targets: [target],
      invalidationReason: 'reclaimed_resistance_failed',
      manualCutReasons: ['failed_upside_follow_through', 'ema_rhythm_lost'],
    };
  }
  if (
    latest.close < weeklyOpen
    && target < trigger
    && prior.close < trigger
    && latest.high >= trigger
    && latest.close < trigger
  ) {
    // B2P.26: short target must be below recent-window low.
    if (target >= recentLow) {
      return { qualifies: false, reasons: ['l2l_short_target_inside_recent_range'] };
    }
    return {
      qualifies: true,
      side: 'short',
      setup: 'level_to_level',
      entry: latest.close,
      stop: latest.high * (1 + buffer),
      targets: [target],
      invalidationReason: 'rejected_support_failed',
      manualCutReasons: ['failed_downside_follow_through', 'ema_rhythm_lost'],
    };
  }
  return { qualifies: false, reasons: ['level_to_level_not_confirmed'] };
}

module.exports = { evaluateLevelToLevel };
