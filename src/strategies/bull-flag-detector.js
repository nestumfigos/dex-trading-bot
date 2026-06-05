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
  breakoutLookbackCandles: 0,
  allowContinuationScout: false,
  scoutPolePctMin: null,
  scoutMinSixtyMinuteMovePct: null,
  scoutLatestVolumeMinRatio: null,
  scoutBreakoutVolMinRatio: null,
  scoutFlagVolContractMaxRatio: null,
  scoutLookbackCandles: 16,
  scoutMinPullbackPct: 0.10,
  scoutMaxDepthPct: 75,
  scoutBreakoutReclaimTolerancePct: 0.10,
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

function calculateRecentMovePct(candles, timeframeMinutes, candleIdx = candles.length - 1) {
  const bars = Math.max(1, Math.ceil(60 / Math.max(1, timeframeMinutes)));
  if (candleIdx - bars < 0) return null;
  const start = candles[candleIdx - bars];
  const breakout = candles[candleIdx];
  const from = Number(start.open || start.close || 0);
  return Number.isFinite(from) && from > 0 ? pctChange(from, breakout.close) : null;
}

function calculateLatestVolumeRatio(candles, lookbackCandles, candleIdx = candles.length - 1) {
  const lookback = Math.max(1, Number(lookbackCandles || 20));
  if (candleIdx < lookback) return null;
  const prior = candles.slice(candleIdx - lookback, candleIdx);
  const priorMedian = median(prior.map((cnd) => cnd.volume));
  if (!(priorMedian > 0)) return null;
  return candles[candleIdx].volume / priorMedian;
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function findExtremeIdx(slice, selector, compare) {
  let selectedIdx = -1;
  let selectedValue = null;
  slice.forEach((item, index) => {
    const value = Number(selector(item));
    if (!Number.isFinite(value)) return;
    if (selectedIdx < 0 || compare(value, selectedValue)) {
      selectedIdx = index;
      selectedValue = value;
    }
  });
  return { idx: selectedIdx, value: selectedValue };
}

function detectContinuationScout(candles, opts, breakoutIdx, timeframeMinutes, latestVolumeLookback, breakoutAgeCandles) {
  const breakout = candles[breakoutIdx];
  if (!breakout) return { qualifies: false, reason: 'scout_no_breakout_candle' };

  const sixtyMinuteMovePct = calculateRecentMovePct(candles, timeframeMinutes, breakoutIdx);
  const minMove = finiteNumber(opts.scoutMinSixtyMinuteMovePct, finiteNumber(opts.minSixtyMinuteMovePct, 0));
  if (minMove > 0 && (!Number.isFinite(sixtyMinuteMovePct) || sixtyMinuteMovePct < minMove)) {
    return { qualifies: false, reason: 'scout_sixty_minute_move_below_min', sixtyMinuteMovePct };
  }
  if (Number(opts.maxSixtyMinuteMovePct || 0) > 0
    && Number.isFinite(sixtyMinuteMovePct)
    && sixtyMinuteMovePct > Number(opts.maxSixtyMinuteMovePct)) {
    return { qualifies: false, reason: 'scout_sixty_minute_move_above_max', sixtyMinuteMovePct };
  }

  const latestVolumeRatio = calculateLatestVolumeRatio(candles, latestVolumeLookback, breakoutIdx);
  const minLatestVol = finiteNumber(opts.scoutLatestVolumeMinRatio, finiteNumber(opts.latestVolumeMinRatio, 0));
  if (minLatestVol > 0 && (!Number.isFinite(latestVolumeRatio) || latestVolumeRatio < minLatestVol)) {
    return { qualifies: false, reason: 'scout_latest_volume_below_prior_median', latestVolumeRatio };
  }

  const flagMin = Math.max(1, Number(opts.flagMinCandles || 2));
  const flagMax = Math.max(flagMin, Number(opts.flagMaxCandles || 8));
  const lookbackCandles = Math.max(flagMin + 2, Number(opts.scoutLookbackCandles || 16));
  const polePctMin = finiteNumber(opts.scoutPolePctMin, finiteNumber(opts.polePctMin, 5));
  const minPullbackPct = Math.max(0, finiteNumber(opts.scoutMinPullbackPct, 0.10));
  const maxDepthPct = Math.max(1, finiteNumber(opts.scoutMaxDepthPct, finiteNumber(opts.flagDepthMaxPct, 75)));
  const reclaimTolerancePct = Math.max(0, finiteNumber(opts.scoutBreakoutReclaimTolerancePct, 0.10));
  const maxContraction = finiteNumber(
    opts.scoutFlagVolContractMaxRatio,
    Math.max(finiteNumber(opts.flagVolContractMaxRatio, 0.70), 1.25),
  );
  const minBreakoutExpansion = finiteNumber(opts.scoutBreakoutVolMinRatio, finiteNumber(opts.breakoutVolMinRatio, 1.5));

  let bestReject = null;
  for (let flagLen = flagMin; flagLen <= flagMax; flagLen += 1) {
    const flagEndIdx = breakoutIdx - 1;
    const flagStartIdx = flagEndIdx - flagLen + 1;
    if (flagStartIdx < 2) continue;

    const contextStartIdx = Math.max(0, flagStartIdx - lookbackCandles);
    const preFlagSlice = candles.slice(contextStartIdx, flagStartIdx);
    const flagSlice = candles.slice(flagStartIdx, flagEndIdx + 1);
    if (preFlagSlice.length < 2 || flagSlice.length < flagMin) continue;

    const poleLow = findExtremeIdx(preFlagSlice, (cnd) => cnd.low, (value, selected) => value < selected);
    const highSearch = poleLow.idx >= 0 ? preFlagSlice.slice(poleLow.idx) : preFlagSlice;
    const poleHigh = findExtremeIdx(highSearch, (cnd) => cnd.high, (value, selected) => value > selected);
    if (poleLow.idx < 0 || poleHigh.idx < 0) continue;

    const poleStartIdx = contextStartIdx + poleLow.idx;
    const poleEndIdx = contextStartIdx + poleLow.idx + poleHigh.idx;
    if (poleEndIdx <= poleStartIdx) continue;

    const poleStartPrice = Number(poleLow.value);
    const poleHighPrice = Number(poleHigh.value);
    const poleHeightPct = pctChange(poleStartPrice, poleHighPrice);
    if (poleHeightPct < polePctMin) {
      bestReject = bestReject || { reason: 'scout_pole_below_min', poleHeightPct };
      continue;
    }

    const flagHigh = Math.max(...flagSlice.map((cnd) => cnd.high));
    const flagLow = Math.min(...flagSlice.map((cnd) => cnd.low));
    const flagPullbackPct = Math.abs(pctChange(flagHigh, flagLow));
    if (flagPullbackPct < minPullbackPct) {
      bestReject = bestReject || { reason: 'scout_pullback_too_shallow', flagPullbackPct };
      continue;
    }

    const poleRange = poleHighPrice - poleStartPrice;
    if (!(poleRange > 0)) continue;
    const flagDepthPct = ((poleHighPrice - flagLow) / poleRange) * 100;
    if (flagDepthPct > maxDepthPct) {
      bestReject = bestReject || { reason: 'scout_flag_depth_above_max', flagDepthPct };
      continue;
    }

    const flagFirstClose = Number(flagSlice[0]?.close || 0);
    const flagLastClose = Number(flagSlice[flagSlice.length - 1]?.close || 0);
    if (flagFirstClose > 0 && flagLastClose > flagFirstClose * (1 + (Number(opts.maxFlagUpwardDriftPct || 0) / 100))) {
      bestReject = bestReject || { reason: 'scout_flag_drift_above_max' };
      continue;
    }

    const poleSlice = candles.slice(poleStartIdx, poleEndIdx + 1);
    const poleVolMedian = median(poleSlice.map((cnd) => cnd.volume));
    const flagVolMedian = median(flagSlice.map((cnd) => cnd.volume));
    if (!(poleVolMedian > 0) || !(flagVolMedian > 0)) continue;
    const volumeContraction = flagVolMedian / poleVolMedian;
    if (volumeContraction > maxContraction) {
      bestReject = bestReject || { reason: 'scout_flag_volume_above_max', volumeContraction };
      continue;
    }

    const breakoutLevel = flagHigh * (1 - (reclaimTolerancePct / 100));
    if (breakout.close <= breakoutLevel) {
      bestReject = bestReject || { reason: 'scout_breakout_not_reclaimed' };
      continue;
    }

    const volumeExpansion = breakout.volume / flagVolMedian;
    if (volumeExpansion < minBreakoutExpansion) {
      bestReject = bestReject || { reason: 'scout_breakout_volume_below_min', volumeExpansion };
      continue;
    }

    const postBreakoutCandles = candles.slice(breakoutIdx + 1);
    if (postBreakoutCandles.some((cnd) => Number(cnd.close || 0) <= breakoutLevel)) {
      bestReject = bestReject || { reason: 'scout_post_breakout_closed_back_inside' };
      continue;
    }
    if (postBreakoutCandles.some((cnd) => Number(cnd.low || 0) <= flagLow)) {
      bestReject = bestReject || { reason: 'scout_post_breakout_hit_flag_low' };
      continue;
    }

    const latest = candles[candles.length - 1];
    const measuredMove = poleHighPrice - poleStartPrice;
    const targetPrice = breakout.close + measuredMove;
    const stopPrice = flagLow;
    const stopDistancePct = pctChange(breakout.close, stopPrice);

    return {
      qualifies: true,
      setupType: opts.setupType || 'spot_day_bull_flag',
      setupSubtype: 'continuation_scout',
      timeframeMinutes,
      poleStartIdx,
      poleEndIdx,
      flagStartIdx,
      flagEndIdx,
      poleLen: Math.max(1, poleEndIdx - poleStartIdx + 1),
      flagLen,
      poleStartPrice,
      poleHighPrice,
      poleClose: candles[poleEndIdx]?.close,
      poleHeightPct,
      flagHigh,
      flagLow,
      flagDepthPct,
      flagPullbackPct,
      flagTrendlineAtBreakout: null,
      brokeFlagHigh: breakout.close > flagHigh,
      brokeFlagTrendline: false,
      breakoutClose: breakout.close,
      breakoutHigh: breakout.high,
      breakoutTimestamp: breakout.timestamp,
      breakoutIdx,
      breakoutAgeCandles,
      lateEntry: breakoutAgeCandles > 0,
      currentClose: latest.close,
      currentTimestamp: latest.timestamp,
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

  return { qualifies: false, ...(bestReject || { reason: 'scout_no_valid_continuation_window' }) };
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

  const timeframeMinutes = resolveTimeframeMinutes(opts.timeframeMinutes, 15);
  const maxBreakoutLookback = Math.max(0, Number(opts.breakoutLookbackCandles || 0));
  const attempts = [];

  for (let breakoutAgeCandles = 0; breakoutAgeCandles <= maxBreakoutLookback; breakoutAgeCandles += 1) {
    const breakoutIdx = candles.length - 1 - breakoutAgeCandles;
    if (breakoutIdx < 0) continue;
    const breakout = candles[breakoutIdx];
    const flagSearchEnd = breakoutIdx;
    const tryScout = () => {
      if (!opts.allowContinuationScout) return null;
      return detectContinuationScout(candles, opts, breakoutIdx, timeframeMinutes, latestVolumeLookback, breakoutAgeCandles);
    };
    const sixtyMinuteMovePct = calculateRecentMovePct(candles, timeframeMinutes, breakoutIdx);
    if (Number(opts.minSixtyMinuteMovePct || 0) > 0
      && (!Number.isFinite(sixtyMinuteMovePct) || sixtyMinuteMovePct < Number(opts.minSixtyMinuteMovePct))) {
      attempts.push({ reason: 'sixty_minute_move_below_min', breakoutAgeCandles, sixtyMinuteMovePct });
      const scout = tryScout();
      if (scout) {
        attempts.push({ reason: scout.reason || 'scout_qualified', breakoutAgeCandles, scout });
        if (scout.qualifies) return scout;
      }
      continue;
    }
    if (Number(opts.maxSixtyMinuteMovePct || 0) > 0
      && Number.isFinite(sixtyMinuteMovePct)
      && sixtyMinuteMovePct > Number(opts.maxSixtyMinuteMovePct)) {
      attempts.push({ reason: 'sixty_minute_move_above_max', breakoutAgeCandles, sixtyMinuteMovePct });
      const scout = tryScout();
      if (scout) {
        attempts.push({ reason: scout.reason || 'scout_qualified', breakoutAgeCandles, scout });
        if (scout.qualifies) return scout;
      }
      continue;
    }

    const latestVolumeRatio = calculateLatestVolumeRatio(candles, latestVolumeLookback, breakoutIdx);
    if (Number(opts.latestVolumeMinRatio || 0) > 0
      && (!Number.isFinite(latestVolumeRatio) || latestVolumeRatio < Number(opts.latestVolumeMinRatio))) {
      attempts.push({ reason: 'latest_volume_below_prior_median', breakoutAgeCandles, latestVolumeRatio });
      const scout = tryScout();
      if (scout) {
        attempts.push({ reason: scout.reason || 'scout_qualified', breakoutAgeCandles, scout });
        if (scout.qualifies) return scout;
      }
      continue;
    }

    let matchedWindow = false;
    // Search flag windows: 2..flagMaxCandles ending before the breakout candle.
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
        if (poleNetPct < opts.polePctMin) continue;
        const poleStartFloor = poleStartPrice * 0.99;
        if (poleSlice.some((cnd) => cnd.low < poleStartFloor)) continue;

        const flagHigh = Math.max(...flagSlice.map((c) => c.high));
        const flagLow = Math.min(...flagSlice.map((c) => c.low));
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
        if (!(brokeFlagHigh || (opts.allowTrendlineBreakout && brokeFlagTrendline))) continue;
        const volumeExpansion = flagVolMedian > 0 ? breakout.volume / flagVolMedian : 0;
        if (volumeExpansion < opts.breakoutVolMinRatio) continue;

        const triggerLevel = brokeFlagHigh ? flagHigh : flagTrendlineAtBreakout;
        const postBreakoutCandles = candles.slice(breakoutIdx + 1);
        if (postBreakoutCandles.some((cnd) => Number(cnd.close || 0) <= Number(triggerLevel || flagHigh))) continue;
        if (postBreakoutCandles.some((cnd) => Number(cnd.low || 0) <= flagLow)) continue;

        matchedWindow = true;
        const measuredMove = poleHighPrice - poleStartPrice;
        const targetPrice = breakout.close + measuredMove;
        const stopPrice = flagLow;
        const stopDistancePct = pctChange(breakout.close, stopPrice);
        const latest = candles[candles.length - 1];

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
          breakoutIdx,
          breakoutAgeCandles,
          lateEntry: breakoutAgeCandles > 0,
          currentClose: latest.close,
          currentTimestamp: latest.timestamp,
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
    attempts.push({ reason: matchedWindow ? 'post_breakout_invalidated' : 'no_valid_flag_window', breakoutAgeCandles });

    if (opts.allowContinuationScout) {
      const scout = detectContinuationScout(candles, opts, breakoutIdx, timeframeMinutes, latestVolumeLookback, breakoutAgeCandles);
      attempts.push({ reason: scout.reason || 'scout_qualified', breakoutAgeCandles, scout });
      if (scout.qualifies) return scout;
    }
  }

  const firstAttempt = attempts[0] || { reason: 'no_valid_flag_window' };
  return {
    qualifies: false,
    reason: firstAttempt.reason,
    candlesAvailable: candles.length,
    ...('sixtyMinuteMovePct' in firstAttempt ? { sixtyMinuteMovePct: firstAttempt.sixtyMinuteMovePct } : {}),
    ...('latestVolumeRatio' in firstAttempt ? { latestVolumeRatio: firstAttempt.latestVolumeRatio } : {}),
    attempts,
  };
}

module.exports = {
  detectBullFlag,
  DEFAULTS,
  median,
  normalizeCandle,
  pctChange,
};
