'use strict';

function candleValue(candle, key, arrayIndex) {
  return Number(Array.isArray(candle) ? candle[arrayIndex] : candle?.[key]);
}

function candleTime(candle) {
  const value = Array.isArray(candle) ? candle[0] : candle?.openTime;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.parse(value);
}

// B4P.norm: visibility into silently-dropped candles. The dense `normalizeCandles`
// path stays the default for backward compatibility; callers needing visibility
// can use `normalizeCandlesWithMeta` to see how many rows were filtered and why.
// Filter reasons surfaced: invalid_open_time, non_finite_ohlc.
function normalizeCandlesWithMeta(candles = []) {
  const input = Array.isArray(candles) ? candles : [];
  const rows = [];
  let droppedInvalidTime = 0;
  let droppedNonFinite = 0;
  for (const candle of input) {
    const normalized = {
      openTime: candleTime(candle),
      open: candleValue(candle, 'open', 1),
      high: candleValue(candle, 'high', 2),
      low: candleValue(candle, 'low', 3),
      close: candleValue(candle, 'close', 4),
      volume: candleValue(candle, 'volume', 5),
    };
    if (!Number.isFinite(normalized.openTime)) {
      droppedInvalidTime += 1;
      continue;
    }
    if (![normalized.open, normalized.high, normalized.low, normalized.close].every(Number.isFinite)) {
      droppedNonFinite += 1;
      continue;
    }
    rows.push(normalized);
  }
  const reasons = [];
  if (droppedInvalidTime > 0) reasons.push(`invalid_open_time:${droppedInvalidTime}`);
  if (droppedNonFinite > 0) reasons.push(`non_finite_ohlc:${droppedNonFinite}`);
  return {
    candles: rows,
    inputCount: input.length,
    droppedCount: droppedInvalidTime + droppedNonFinite,
    reasons,
  };
}

function normalizeCandles(candles = []) {
  return normalizeCandlesWithMeta(candles).candles;
}

function weekStartUtc(timestamp) {
  const date = new Date(timestamp);
  const weekday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - weekday);
}

function calculateTimeOpenAnchors({ dailyCandles = [], currentPrice } = {}) {
  const rows = normalizeCandles(dailyCandles).sort((left, right) => left.openTime - right.openTime);
  if (!rows.length) return { valid: false, reasons: ['daily_candles_required'] };
  const latest = rows[rows.length - 1];
  const latestDate = new Date(latest.openTime);
  const monthStart = Date.UTC(latestDate.getUTCFullYear(), latestDate.getUTCMonth(), 1);
  const weekStart = weekStartUtc(latest.openTime);
  const monthly = rows.find((candle) => candle.openTime >= monthStart) || latest;
  const weekly = rows.find((candle) => candle.openTime >= weekStart) || latest;
  const price = Number(currentPrice ?? latest.close);
  const monthlyOpen = monthly.open;
  const weeklyOpen = weekly.open;
  const dailyOpen = latest.open;
  const sideBias = price > weeklyOpen ? 'long' : price < weeklyOpen ? 'short' : 'neutral';
  return {
    valid: true,
    monthlyOpen,
    weeklyOpen,
    dailyOpen,
    price,
    sideBias,
    anchorBias: {
      monthly: price >= monthlyOpen ? 'above' : 'below',
      weekly: price >= weeklyOpen ? 'above' : 'below',
      daily: price >= dailyOpen ? 'above' : 'below',
    },
  };
}

module.exports = { normalizeCandles, normalizeCandlesWithMeta, calculateTimeOpenAnchors };
