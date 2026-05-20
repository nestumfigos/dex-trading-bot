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
  polePctMin: 5,
  poleMaxCandles: 4,
  flagMinCandles: 2,
  flagMaxCandles: 8,
  flagDepthMaxPct: 50,
  flagVolContractMaxRatio: 0.70,
  breakoutVolMinRatio: 1.5,
  minCandlesRequired: 8,
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

function detectBullFlag(rawCandles, cfg = {}) {
  const opts = { ...DEFAULTS, ...cfg };
  const candles = Array.isArray(rawCandles) ? rawCandles.map(normalizeCandle).filter(Boolean) : [];
  if (candles.length < opts.minCandlesRequired) {
    return { qualifies: false, reason: 'insufficient_candles', candlesAvailable: candles.length };
  }

  const breakout = candles[candles.length - 1];
  const flagSearchEnd = candles.length - 1;

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

      // Breakout trigger: close above flag high + volume expansion vs flag median
      if (!(breakout.close > flagHigh)) continue;
      const volumeExpansion = flagVolMedian > 0 ? breakout.volume / flagVolMedian : 0;
      if (volumeExpansion < opts.breakoutVolMinRatio) continue;

      const measuredMove = poleHighPrice - poleStartPrice;
      const targetPrice = breakout.close + measuredMove;
      const stopPrice = flagLow;
      const stopDistancePct = pctChange(breakout.close, stopPrice);

      return {
        qualifies: true,
        setupType: 'spot_day_bull_flag',
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
        breakoutClose: breakout.close,
        breakoutHigh: breakout.high,
        breakoutTimestamp: breakout.timestamp,
        targetPrice,
        stopPrice,
        stopDistancePct,
        measuredMovePct: pctChange(breakout.close, targetPrice),
        volumeExpansion,
        volumeContraction,
        poleVolMedian,
        flagVolMedian,
        rr: Math.abs(stopDistancePct) > 0 ? pctChange(breakout.close, targetPrice) / Math.abs(stopDistancePct) : null,
      };
    }
  }

  return { qualifies: false, reason: 'no_valid_flag_window', candlesAvailable: candles.length };
}

module.exports = {
  detectBullFlag,
  DEFAULTS,
};
