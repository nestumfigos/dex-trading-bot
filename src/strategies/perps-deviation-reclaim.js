'use strict';

const { normalizeCandles } = require('./perps-anchors');

// B2P.12: sweep + reclaim must be DISTINCT bars.
//
// Original logic allowed the sweep extreme and the reclaim close to live on
// the same bar (the `latest`) because `latest.high >= high*(1-tol) AND
// latest.close < high` matches a single wick-then-close-inside candle.
// Real deviation+reclaim setups need a PRIOR sweep bar (extending beyond range)
// followed by a SEPARATE reclaim bar that closes back inside.
//
// Also enforce minReclaimMargin: the reclaim close must be at least
// `reclaimMarginPct` (default 0.05%) inside the range to count — bars closing
// exactly at the level are too marginal to act on.
function evaluateDeviationReclaim({
  candles = [],
  range,
  retestTolerancePct = 0.25,
  stopBufferPct = 0.05,
  reclaimMarginPct = 0.05,
} = {}) {
  const rows = normalizeCandles(candles);
  if (!range || !Number.isFinite(Number(range.high)) || !Number.isFinite(Number(range.low))) {
    return { qualifies: false, reasons: ['valid_range_required'] };
  }
  if (rows.length < 2) return { qualifies: false, reasons: ['insufficient_setup_candles'] };
  const latest = rows[rows.length - 1];
  // priorRows EXCLUDES `latest`; sweep must occur in a bar prior to the reclaim bar.
  const priorRows = rows.slice(Math.max(0, rows.length - 6), -1).reverse();
  const high = Number(range.high);
  const low = Number(range.low);
  const eq = Number(range.eq ?? ((high + low) / 2));
  const tolerance = Number(retestTolerancePct) / 100;
  const buffer = Number(stopBufferPct) / 100;
  const reclaimMargin = Number(reclaimMarginPct) / 100;

  // SHORT setup: prior bar extended above range high; latest bar reclaims back inside.
  const shortSweep = priorRows.find((candle) => candle.high > high && candle.close < high);
  if (
    shortSweep
    && latest.high >= high * (1 - tolerance)
    && latest.close < high * (1 - reclaimMargin) // strict reclaim margin
  ) {
    const entry = latest.close;
    const stop = Math.max(shortSweep.high, latest.high) * (1 + buffer);
    return {
      qualifies: true,
      side: 'short',
      setup: 'deviation_reclaim',
      entry,
      stop,
      targets: [eq, low],
      sweptLevel: 'range_high',
      deviationExtreme: Math.max(shortSweep.high, latest.high),
      invalidationReason: 'price_traded_above_deviation_extreme',
      manualCutReasons: ['failed_downside_follow_through', 'reclaim_lost', 'ema_rhythm_lost'],
    };
  }

  // LONG setup: prior bar extended below range low; latest bar reclaims back inside.
  const longSweep = priorRows.find((candle) => candle.low < low && candle.close > low);
  if (
    longSweep
    && latest.low <= low * (1 + tolerance)
    && latest.close > low * (1 + reclaimMargin) // strict reclaim margin
  ) {
    const entry = latest.close;
    const stop = Math.min(longSweep.low, latest.low) * (1 - buffer);
    return {
      qualifies: true,
      side: 'long',
      setup: 'deviation_reclaim',
      entry,
      stop,
      targets: [eq, high],
      sweptLevel: 'range_low',
      deviationExtreme: Math.min(longSweep.low, latest.low),
      invalidationReason: 'price_traded_below_deviation_extreme',
      manualCutReasons: ['failed_upside_follow_through', 'reclaim_lost', 'ema_rhythm_lost'],
    };
  }
  return { qualifies: false, reasons: ['deviation_reclaim_not_confirmed'] };
}

module.exports = { evaluateDeviationReclaim };
