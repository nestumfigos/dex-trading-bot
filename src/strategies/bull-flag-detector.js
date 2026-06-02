'use strict';

// Bull-flag pattern detector (Week 12 B.1).
// Pure function. Inputs OHLCV candles (oldest→newest), outputs setup descriptor.
// No I/O, no clock dependency beyond candle timestamps.
//
// Pattern definition (per plan/day-trade.txt):
//   Pole : 1-4 candles, price advance >= polePctMin (default 5%)
//   Flag : 2-8 candles after pole, retrace <= flagDepthMaxPct of pole
//          flag volume median < flagVolContractMaxRatio * pole-volume median
//   Trigger: latest candle closes above flag high with volume >= breakoutVolMinRatio * flag-volume median

const DEFAULTS = Object.freeze({
  setupType: 'spot_day_bull_flag',
  polePctMin: 5,
  poleMaxCandles: 4,
  flagMinCandles: 2,
  flagMaxCandles: 8,
  flagDepthMaxPct: 50,
  maxFlagUpwardDriftPct: 1.0,
  flagVolContractMaxRatio: 0.70,
  breakoutVolMinRatio: 1.5,
  latestVolumeLookbackCandles: 20,
  latestVolumeMinRatio: 2.0,
  minSixtyMinuteMovePct: 5,
  maxSixtyMinuteMovePct: 12,
  timeframeMinutes: 15,
  allowTrendlineBreakout: true,
  minCandlesRequired: 0,
});

function median(arr) {
  const xs = arr.filter((v) => Number.isFinite(v) && v >= 0).slice().sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function pctChange(from, to) {
  if (!(from > 0)) return 0;
  return ((to - from) / from) * 100;
}

function resolveTimeframeMinutes(value, fallback = 15) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const match = String(value || '').trim().toLowerCase().match(/^(\d+)(m|h)$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 : amount;
}

function normalizeCandle(raw) {
  if (!raw) return null;
  const open = Number(raw.open ?? raw.o);
  const high = Number(raw.high ?? raw.h);
  const low = Number(raw.low ?? raw.l);
  const close = Number(raw.close ?? raw.c);
  const volume = Number(raw.volume ?? raw.v ?? 0);
  if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) return null;
  return { open, high, low, close, volume: Number.isFinite(volume) ? volume : 0, timestamp: raw.timestamp ?? raw.t ?? null };
}

function projectedFlagResistance(flagSlice) {
  if (!Array.isArray(flagSlice) || flagSlice.length < 2) return null;
  const first = Number(flagSlice[0]?.high);
  const last = Number(flagSlice[flagSlice.length - 1]?.high);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const slope = (last - first) / Math.max(1, flagSlice.length - 1);
  return last + slope;
}

function calculateRecentMovePct(candles, timeframeMinutes) {
  const bars = Math.max(1, Math.ceil(60 / Math.max(1, timeframeMinutes)));
  if (candles.length <= bars) return null;
  const start = candles[candles.length - 1 - bars];
  const breakout = candles[candles.length - 1];
  const from = Number(start.open || start.close || 0);
  return Number.isFinite(from) && from > 0 ? pctChange(from, breakout.close) : null;
}

function calculateLatestVolumeRatio(candles, lookbackCandles) {
  const lookback = Math.max(1, Number(lookbackCandles || 20));
  if (candles.length < lookback + 1) return null;
  const prior = candles.slice(candles.length - 1 - lookback, candles.length - 1);
  const priorMedian = median(prior.map((cnd) => cnd.volume));
  if (!(priorMedian > 0)) return null;
  return candles[candles.length - 1].volume / priorMedian;
}

function detectBullFlag(rawCandles, cfg = {}) {
  const overrides = Object.fromEntries(Object.entries(cfg || {}).filter(([, value]) => value !== undefined && value !== null));
  const opts = { ...DEFAULTS, ...overrides };
  const candles = Array.isArray(rawCandles) ? rawCandles.map(normalizeCandle).filter(Boolean) : [];
  const latestVolumeLookback = Math.max(1, Number(opts.latestVolumeLookbackCandles || 20));
  const minCandlesRequired = Math.max(
    Number(opts.minCandlesRequired || 0),
    Number(opts.poleMaxCandles || 4) + Number(opts.flagMinCandles || 2) + 2,
    Number(opts.latestVolumeMinRatio || 0) > 0 ? latestVolumeLookback + 2 : 0,
  );
  if (candles.length < minCandlesRequired) {
    return { qualifies: false, reason: 'insufficient_candles', candlesAvailable: candles.length };
  }

  const breakout = candles[candles.length - 1];
  const flagSearchEnd = candles.length - 1;
  const timeframeMinutes = resolveTimeframeMinutes(opts.timeframeMinutes, 15);
  const sixtyMinuteMovePct = calculateRecentMovePct(candles, timeframeMinutes);
  if (Number(opts.minSixtyMinuteMovePct || 0) > 0
    && (!Number.isFinite(sixtyMinuteMovePct) || sixtyMinuteMovePct < Number(opts.minSixtyMinuteMovePct))) {
    return {
      qualifies: false,
      reason: 'sixty_minute_move_below_min',
      candlesAvailable: candles.length,
      sixtyMinuteMovePct,
    };
  }
  if (Number(opts.maxSixtyMinuteMovePct || 0) > 0
    && Number.isFinite(sixtyMinuteMovePct)
    && sixtyMinuteMovePct > Number(opts.maxSixtyMinuteMovePct)) {
    return {
      qualifies: false,
      reason: 'sixty_minute_move_above_max',
      candlesAvailable: candles.length,
      sixtyMinuteMovePct,
    };
  }

  const latestVolumeRatio = calculateLatestVolumeRatio(candles, latestVolumeLookback);
  if (Number(opts.latestVolumeMinRatio || 0) > 0
    && (!Number.isFinite(latestVolumeRatio) || latestVolumeRatio < Number(opts.latestVolumeMinRatio))) {
    return {
      qualifies: false,
      reason: 'latest_volume_below_prior_median',
      candlesAvailable: candles.length,
      latestVolumeRatio,
    };
  }

  // Search flag windows: 2..flagMaxCandles ending at last-closed candle (exclusive of breakout)
  for (let flagLen = opts.flagMinCandles; flagLen <= opts.flagMaxCandles; flagLen += 1) {
    const flagEndIdx = flagSearchEnd - 1;
    const flagStartIdx = flagEndIdx - flagLen + 1;
    if (flagStartIdx < opts.poleMaxCandles) continue;

    for (let poleLen = 1; poleLen <= opts.poleMaxCandles; poleLen += 1) {
      const poleEndIdx = flagStartIdx - 1;
      const poleStartIdx = poleEndIdx - poleLen + 1;
      if (poleStartIdx < 0) continue;

      const poleStartCandle = candles[poleStartIdx];
      const poleEndCandle = candles[poleEndIdx];
      const poleSlice = candles.slice(poleStartIdx, poleEndIdx + 1);
      const flagSlice = candles.slice(flagStartIdx, flagEndIdx + 1);

      const poleStartPrice = poleStartCandle.open;
      const poleHighPrice = Math.max(...poleSlice.map((c) => c.high));
      const poleClose = poleEndCandle.close;
      const poleHeightPct = pctChange(poleStartPrice, poleHighPrice);
      const poleNetPct = pctChange(poleStartPrice, poleClose);
      if (poleHeightPct < opts.polePctMin) continue;
      // Net pole advance gate: ensures the pole is a real directional move,
      // not a window that just happens to contain one tall wick.
      if (poleNetPct < opts.polePctMin) continue;
      // No candle inside the pole may drop materially below the pole start.
      const poleStartFloor = poleStartPrice * 0.99;
      if (poleSlice.some((cnd) => cnd.low < poleStartFloor)) continue;

      const flagHigh = Math.max(...flagSlice.map((c) => c.high));
      const flagLow = Math.min(...flagSlice.map((c) => c.low));
      // Flag must not exceed pole high (no new high during flag)
      if (flagHigh > poleHighPrice) continue;
      const flagFirstClose = Number(flagSlice[0]?.close || 0);
      const flagLastClose = Number(flagSlice[flagSlice.length - 1]?.close || 0);
      if (flagFirstClose > 0 && flagLastClose > flagFirstClose * (1 + (Number(opts.maxFlagUpwardDriftPct || 0) / 100))) continue;

      const retraceFromHigh = poleHighPrice - flagLow;
      const poleRange = poleHighPrice - poleStartPrice;
      if (!(poleRange > 0)) continue;
      const flagDepthPct = (retraceFromHigh / poleRange) * 100;
      if (flagDepthPct > opts.flagDepthMaxPct) continue;

      const poleVolMedian = median(poleSlice.map((c) => c.volume));
      const flagVolMedian = median(flagSlice.map((c) => c.volume));
      if (!(poleVolMedian > 0)) continue;
      const volumeContraction = flagVolMedian / poleVolMedian;
      if (volumeContraction > opts.flagVolContractMaxRatio) continue;

      const flagTrendlineAtBreakout = projectedFlagResistance(flagSlice);
      const brokeFlagHigh = breakout.close > flagHigh;
      const brokeFlagTrendline = Number.isFinite(flagTrendlineAtBreakout)
        ? breakout.close > flagTrendlineAtBreakout
        : false;
      // Breakout trigger: close above flag high or descending flag trendline + volume expansion vs flag median.
      if (!(brokeFlagHigh || (opts.allowTrendlineBreakout && brokeFlagTrendline))) continue;
      const volumeExpansion = flagVolMedian > 0 ? breakout.volume / flagVolMedian : 0;
      if (volumeExpansion < opts.breakoutVolMinRatio) continue;

      const measuredMove = poleHighPrice - poleStartPrice;
      const targetPrice = breakout.close + measuredMove;
      const stopPrice = flagLow;
      const stopDistancePct = pctChange(breakout.close, stopPrice);

      return {
        qualifies: true,
        setupType: opts.setupType || 'spot_day_bull_flag',
        timeframeMinutes,
        poleStartIdx,
        poleEndIdx,
        flagStartIdx,
        flagEndIdx,
        poleLen,
        flagLen,
        poleStartPrice,
        poleHighPrice,
        poleClose,
        poleHeightPct,
        flagHigh,
        flagLow,
        flagDepthPct,
        flagTrendlineAtBreakout,
        brokeFlagHigh,
        brokeFlagTrendline,
        breakoutClose: breakout.close,
        breakoutHigh: breakout.high,
        breakoutTimestamp: breakout.timestamp,
        targetPrice,
        stopPrice,
        stopDistancePct,
        measuredMovePct: pctChange(breakout.close, targetPrice),
        volumeExpansion,
        latestVolumeRatio,
        volumeContraction,
        poleVolMedian,
        flagVolMedian,
        sixtyMinuteMovePct,
        rr: Math.abs(stopDistancePct) > 0 ? pctChange(breakout.close, targetPrice) / Math.abs(stopDistancePct) : null,
      };
    }
  }

  return { qualifies: false, reason: 'no_valid_flag_window', candlesAvailable: candles.length };
}

module.exports = {
  detectBullFlag,
  DEFAULTS,
  median,
  normalizeCandle,
  pctChange,
};
