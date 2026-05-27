'use strict';

const { normalizeCandles } = require('./perps-anchors');

// B2P.11: market structure shift confirmation requires more than a single wick
// peeking past the prior 4-bar extreme. Real structure breaks show either
// (a) two consecutive closes beyond the level OR (b) a single close with at
// least minDisplacementPct beyond it (default 0.3%). Bot rejected noise wicks
// caused chop-friendly setups to fail their first follow-through.
function detectMarketStructureShift({
  candles = [],
  side,
  minDisplacementPct = 0.3,
} = {}) {
  const rows = normalizeCandles(candles).slice(-6);
  if (rows.length < 4) return { confirmed: false, reasons: ['insufficient_mss_candles'] };
  const latest = rows[rows.length - 1];
  const prior = rows[rows.length - 2];
  // Structure window excludes the two most-recent bars to evaluate displacement
  // against the established 4-bar extreme.
  const structure = rows.slice(0, -2);
  const displacement = Number(minDisplacementPct) / 100;

  if (side === 'long') {
    if (structure.length === 0) return { confirmed: false, reasons: ['insufficient_mss_candles'] };
    const brokenHigh = Math.max(...structure.map((candle) => candle.high));
    const latestExceeds = latest.close > brokenHigh;
    const priorAlsoExceeds = prior && prior.close > brokenHigh;
    const displacementOk = latestExceeds && (latest.close - brokenHigh) / brokenHigh >= displacement;
    const confirmed = latestExceeds && (priorAlsoExceeds || displacementOk);
    return confirmed
      ? { confirmed: true, side, brokenLevel: brokenHigh, retestLevel: brokenHigh, confirmation: priorAlsoExceeds ? 'two_bar_close' : 'displacement' }
      : { confirmed: false, reasons: ['bullish_mss_not_confirmed_above_displacement_floor'] };
  }
  if (side === 'short') {
    if (structure.length === 0) return { confirmed: false, reasons: ['insufficient_mss_candles'] };
    const brokenLow = Math.min(...structure.map((candle) => candle.low));
    const latestBreaks = latest.close < brokenLow;
    const priorAlsoBreaks = prior && prior.close < brokenLow;
    const displacementOk = latestBreaks && (brokenLow - latest.close) / brokenLow >= displacement;
    const confirmed = latestBreaks && (priorAlsoBreaks || displacementOk);
    return confirmed
      ? { confirmed: true, side, brokenLevel: brokenLow, retestLevel: brokenLow, confirmation: priorAlsoBreaks ? 'two_bar_close' : 'displacement' }
      : { confirmed: false, reasons: ['bearish_mss_not_confirmed_above_displacement_floor'] };
  }
  return { confirmed: false, reasons: ['side_required'] };
}

module.exports = { detectMarketStructureShift };
