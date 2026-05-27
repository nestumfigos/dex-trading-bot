'use strict';

const { normalizeCandles } = require('./perps-anchors');

function detectHorizontalRange(candles = [], {
  lookback = 12,
  minCandles = 6,
  maxWidthPct = 12,
  touchTolerancePct = 0.35,
  minTouches = 2,
} = {}) {
  const rows = normalizeCandles(candles).slice(-lookback);
  if (rows.length < minCandles) return { qualifies: false, reasons: ['insufficient_range_candles'] };
  const high = Math.max(...rows.map((candle) => candle.high));
  const low = Math.min(...rows.map((candle) => candle.low));
  const eq = (high + low) / 2;
  const widthPct = ((high - low) / eq) * 100;
  // B3P.04: tolerance basis = HIGH (asymmetric reference) instead of midpoint.
  // Previous code used `eq * (tolerancePct/100)` which produced different
  // absolute price bands at different price regimes for the SAME percentage
  // — 0.35% at BTC=50k → 175 ticks, at BTC=20k → 70 ticks. That meant
  // "the same range shape" qualified or didn't depending on absolute price.
  // Tying tolerance to `high` produces a stable relative band consistent
  // across regimes; same range geometry passes the same touch threshold.
  const tolerance = high * (Number(touchTolerancePct) / 100);
  // B4P.range recency: require touches to occur within a recent sub-window so a
  // broken range can't qualify just because it WAS a range earlier in the
  // lookback. Touches inside the last `recencyWindow` bars count toward the
  // confirmation; older touches still mark the range but cannot satisfy the
  // minTouches floor alone.
  const recencyWindow = Math.min(rows.length, Math.max(3, Math.floor(rows.length / 2)));
  const recentRows = rows.slice(-recencyWindow);
  const highTouchesAll = rows.filter((candle) => high - candle.high <= tolerance).length;
  const lowTouchesAll = rows.filter((candle) => candle.low - low <= tolerance).length;
  const highTouchesRecent = recentRows.filter((candle) => high - candle.high <= tolerance).length;
  const lowTouchesRecent = recentRows.filter((candle) => candle.low - low <= tolerance).length;
  const highTouches = highTouchesAll;
  const lowTouches = lowTouchesAll;
  const reasons = [];
  if (!Number.isFinite(widthPct) || widthPct <= 0 || widthPct > maxWidthPct) reasons.push('range_width_invalid');
  if (highTouches < minTouches || lowTouches < minTouches) reasons.push('range_touches_unconfirmed');
  // B4P.range recency: range must still be active. At least 1 recent touch on
  // EACH side (within the last `recencyWindow` bars) — otherwise the levels
  // are stale and price has already moved on.
  if (highTouchesRecent < 1 || lowTouchesRecent < 1) reasons.push('range_touches_not_recent');
  return {
    qualifies: reasons.length === 0,
    reasons,
    high,
    low,
    eq,
    widthPct,
    highTouches,
    lowTouches,
    highTouchesRecent,
    lowTouchesRecent,
  };
}

module.exports = { detectHorizontalRange };
