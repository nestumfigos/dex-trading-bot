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
  const highTouches = rows.filter((candle) => high - candle.high <= tolerance).length;
  const lowTouches = rows.filter((candle) => candle.low - low <= tolerance).length;
  const reasons = [];
  if (!Number.isFinite(widthPct) || widthPct <= 0 || widthPct > maxWidthPct) reasons.push('range_width_invalid');
  if (highTouches < minTouches || lowTouches < minTouches) reasons.push('range_touches_unconfirmed');
  return {
    qualifies: reasons.length === 0,
    reasons,
    high,
    low,
    eq,
    widthPct,
    highTouches,
    lowTouches,
  };
}

module.exports = { detectHorizontalRange };
