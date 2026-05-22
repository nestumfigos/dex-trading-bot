'use strict';

const { atr, normalizeCandles, simpleMA, simpleMASeries } = require('../backes-indicators');
const { aggregateDailyToWeekly } = require('../backes-macro');

function last(candles = []) {
  return candles[candles.length - 1] || null;
}

function average(values = []) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function volumeRatio(candles = [], lookback = 20) {
  const rows = normalizeCandles(candles);
  if (rows.length < 2) return null;
  const latest = Number(last(rows).volume || 0);
  const baseline = average(rows.slice(-lookback - 1, -1).map((row) => row.volume));
  if (!(baseline > 0)) return null;
  return latest / baseline;
}

function fail(structureType, reason, extra = {}) {
  return {
    qualifies: false,
    structureType,
    entryPrice: null,
    stopPrice: null,
    targetPrice: [],
    targetPrices: [],
    reasons: [reason],
    volumeOk: false,
    ...extra,
  };
}

function pass({ structureType, entryPrice, stopPrice, targetPrices, reasons, volumeOk, extra = {} }) {
  const targets = (Array.isArray(targetPrices) ? targetPrices : [targetPrices])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    qualifies: true,
    structureType,
    entryPrice,
    stopPrice,
    targetPrice: targets,
    targetPrices: targets,
    reasons,
    volumeOk: Boolean(volumeOk),
    ...extra,
  };
}

function riskTargets(entryPrice, stopPrice, multiples = [2, 3]) {
  const risk = Number(entryPrice) - Number(stopPrice);
  if (!(risk > 0)) return [];
  return multiples.map((multiple) => Number(entryPrice) + risk * Number(multiple));
}

function dailyContext(candles = []) {
  const daily = normalizeCandles(candles);
  const closes = daily.map((row) => row.close);
  return {
    daily,
    closes,
    latest: last(daily),
    previous: daily[daily.length - 2] || null,
    ma56: simpleMA(closes, 56),
    ma56Series: simpleMASeries(closes, 56),
    atr14: atr(daily, 14),
    volRatio: volumeRatio(daily, 20),
  };
}

function weeklyFrom(daily = [], weekly = []) {
  const weeks = normalizeCandles(weekly);
  return weeks.length ? weeks : aggregateDailyToWeekly(daily);
}

module.exports = {
  average,
  dailyContext,
  fail,
  last,
  normalizeCandles,
  pass,
  riskTargets,
  volumeRatio,
  weeklyFrom,
};
