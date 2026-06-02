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

function median(values = []) {
  const usable = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const mid = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
}

function volumeRatio(candles = [], lookback = 20) {
  const rows = normalizeCandles(candles);
  if (rows.length < 2) return null;
  const latest = Number(last(rows).volume || 0);
  const baseline = median(rows.slice(-lookback - 1, -1).map((row) => row.volume));
  if (!(baseline > 0)) return null;
  return latest / baseline;
}

function resolveVolumeConfirmation(ctx = {}, options = {}) {
  const supplied = options.volumeConfirmation || {};
  const dailyRatio = Number.isFinite(Number(supplied.dailyRatio))
    ? Number(supplied.dailyRatio)
    : (Number.isFinite(Number(ctx.volRatio)) ? Number(ctx.volRatio) : null);
  const fourHourRatio = Number.isFinite(Number(supplied.fourHourRatio))
    ? Number(supplied.fourHourRatio)
    : null;
  const dailyThreshold = Number(options.dailyVolumeSpikeMultiplier || supplied.dailyThreshold || 1.5);
  const fourHourThreshold = Number(options.fourHourVolumeSpikeMultiplier || supplied.fourHourThreshold || 1.3);
  const dailyOk = dailyRatio !== null && dailyRatio >= dailyThreshold;
  const fourHourOk = fourHourRatio !== null && fourHourRatio >= fourHourThreshold;
  return {
    volumeOk: dailyOk || fourHourOk,
    volumeSource: fourHourOk ? '4h' : (dailyOk ? '1d' : null),
    dailyVolumeRatio: dailyRatio,
    fourHourVolumeRatio: fourHourRatio,
    dailyVolumeThreshold: dailyThreshold,
    fourHourVolumeThreshold: fourHourThreshold,
  };
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

function dailyContext(candles = [], options = {}) {
  const daily = normalizeCandles(candles);
  const closes = daily.map((row) => row.close);
  const maDailyPeriod = Math.max(2, Number(options.maDailyPeriod || 56));
  return {
    daily,
    closes,
    latest: last(daily),
    previous: daily[daily.length - 2] || null,
    ma56: simpleMA(closes, maDailyPeriod),
    ma56Series: simpleMASeries(closes, maDailyPeriod),
    maDailyPeriod,
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
  median,
  normalizeCandles,
  pass,
  riskTargets,
  resolveVolumeConfirmation,
  volumeRatio,
  weeklyFrom,
};
