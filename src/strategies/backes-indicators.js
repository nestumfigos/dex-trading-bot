'use strict';

const { rsi } = require('../utils/indicators');

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function candleClose(candle) {
  return toFiniteNumber(candle?.close ?? candle?.c ?? candle?.[4]);
}

function candleHigh(candle) {
  const high = toFiniteNumber(candle?.high ?? candle?.h ?? candle?.[2]);
  return high ?? candleClose(candle);
}

function candleLow(candle) {
  const low = toFiniteNumber(candle?.low ?? candle?.l ?? candle?.[3]);
  return low ?? candleClose(candle);
}

function normalizeCloses(closes = []) {
  return (Array.isArray(closes) ? closes : [])
    .map((value) => toFiniteNumber(value))
    .filter((value) => value !== null);
}

function normalizeCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => {
      const close = candleClose(candle);
      const high = candleHigh(candle);
      const low = candleLow(candle);
      if (close === null || high === null || low === null) return null;
      return {
        timestamp: toFiniteNumber(candle?.timestamp ?? candle?.time ?? candle?.[0]) ?? 0,
        open: toFiniteNumber(candle?.open ?? candle?.o ?? candle?.[1]) ?? close,
        high,
        low,
        close,
        volume: toFiniteNumber(candle?.volume ?? candle?.v ?? candle?.[5]) ?? 0,
      };
    })
    .filter(Boolean);
}

function simpleMA(closes = [], period = 1) {
  const values = normalizeCloses(closes);
  const length = Math.max(1, Number(period || 1));
  if (values.length < length) return null;
  const slice = values.slice(-length);
  return slice.reduce((sum, value) => sum + value, 0) / length;
}

function simpleMASeries(closes = [], period = 1) {
  const values = normalizeCloses(closes);
  const length = Math.max(1, Number(period || 1));
  if (values.length < length) return [];
  const out = [];
  let rolling = values.slice(0, length).reduce((sum, value) => sum + value, 0);
  out.push(rolling / length);
  for (let index = length; index < values.length; index += 1) {
    rolling += values[index] - values[index - length];
    out.push(rolling / length);
  }
  return out;
}

function wilderRsi(closes = [], period = 14) {
  return rsi(normalizeCloses(closes), Math.max(2, Number(period || 14)));
}

function trueRanges(candles = []) {
  const rows = normalizeCandles(candles);
  if (rows.length < 2) return [];
  const ranges = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const prevClose = rows[index - 1].close;
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    ));
  }
  return ranges.filter((value) => Number.isFinite(value) && value >= 0);
}

function atr(candles = [], period = 14) {
  const length = Math.max(2, Number(period || 14));
  const ranges = trueRanges(candles);
  if (ranges.length < length) return null;
  let value = ranges.slice(0, length).reduce((sum, range) => sum + range, 0) / length;
  for (let index = length; index < ranges.length; index += 1) {
    value = ((value * (length - 1)) + ranges[index]) / length;
  }
  return value;
}

function slope(values = [], lookback = 5) {
  const series = normalizeCloses(values);
  const length = Math.max(2, Number(lookback || 5));
  if (series.length < length) return null;
  const slice = series.slice(-length);
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (!(first > 0)) return null;
  return (last - first) / first;
}

function classifySlope(values = [], options = {}) {
  const pct = slope(values, options.lookback || 5);
  if (pct === null) return 'unknown';
  const flatThreshold = Math.max(0, Number(options.flatThresholdPct ?? 0.005));
  if (pct > flatThreshold) return 'rising';
  if (pct < -flatThreshold) return 'falling';
  return 'flat';
}

function lastFinite(values = []) {
  const series = normalizeCloses(values);
  return series.length ? series[series.length - 1] : null;
}

module.exports = {
  atr,
  classifySlope,
  lastFinite,
  normalizeCandles,
  normalizeCloses,
  simpleMA,
  simpleMASeries,
  slope,
  trueRanges,
  wilderRsi,
};
