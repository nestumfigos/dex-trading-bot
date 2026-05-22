'use strict';

const { getOhlcvSeries } = require('./candles');
const { rsi: computeRsi, ema } = require('./indicators');

const MAJOR_SYMBOLS = new Set([
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'TRX', 'AVAX', 'LINK',
  'DOT', 'MATIC', 'TON', 'LTC', 'ATOM', 'UNI', 'ETC', 'BCH', 'XLM', 'HBAR',
]);

const ANALYSIS_CACHE = new Map();

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isEstablishedTokenCandidate(tokenData = {}) {
  const symbol = normalizeSymbol(tokenData.symbol);
  const volume24h = Number(tokenData.volume24h || tokenData.volume24hUsd || 0);
  return MAJOR_SYMBOLS.has(symbol) || volume24h >= 50_000_000;
}

function getCacheKey(tokenData = {}) {
  return [
    String(tokenData.chainKey || tokenData.chain || '').toLowerCase(),
    String(tokenData.address || '').toLowerCase(),
    String(tokenData.pairAddress || '').toLowerCase(),
    normalizeSymbol(tokenData.symbol),
  ].join(':');
}

function avg(values = []) {
  const usable = values.filter((v) => Number.isFinite(Number(v)));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + Number(value), 0) / usable.length;
}

function percentDiff(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0 || right === 0) return Infinity;
  return Math.abs(left - right) / ((Math.abs(left) + Math.abs(right)) / 2);
}

function buildPivotSeries(candles = [], window = 2) {
  const highs = [];
  const lows = [];
  for (let i = window; i < candles.length - window; i += 1) {
    const slice = candles.slice(i - window, i + window + 1);
    const current = candles[i];
    const high = Number(current.high || current.close || 0);
    const low = Number(current.low || current.close || 0);
    const isHigh = slice.every((row) => high >= Number(row.high || row.close || 0));
    const isLow = slice.every((row) => low <= Number(row.low || row.close || 0));
    if (isHigh) highs.push({ index: i, price: high, ts: current.timestamp });
    if (isLow) lows.push({ index: i, price: low, ts: current.timestamp });
  }
  return { highs, lows };
}

function linearSlope(points = []) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  const dx = Number(last.index) - Number(first.index);
  if (!Number.isFinite(dx) || dx === 0) return 0;
  return (Number(last.price) - Number(first.price)) / dx;
}

function computeMacdSignal(closes = []) {
  if (!Array.isArray(closes) || closes.length < 35) {
    return { macd: null, signal: null, histogram: null, bias: 'neutral' };
  }
  const fast = [];
  const slow = [];
  for (let i = 0; i < closes.length; i += 1) {
    const slice = closes.slice(0, i + 1);
    fast.push(ema(slice, 12));
    slow.push(ema(slice, 26));
  }
  const macdLine = fast.map((value, idx) => Number(value) - Number(slow[idx] || 0)).filter((value) => Number.isFinite(value));
  if (macdLine.length < 9) {
    return { macd: null, signal: null, histogram: null, bias: 'neutral' };
  }
  const signalLine = ema(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const histogram = Number.isFinite(Number(signalLine)) ? macd - Number(signalLine) : null;
  const bias = Number.isFinite(histogram)
    ? (histogram > 0 ? 'bullish' : (histogram < 0 ? 'bearish' : 'neutral'))
    : 'neutral';
  return {
    macd: Number.isFinite(macd) ? Number(macd.toFixed(6)) : null,
    signal: Number.isFinite(Number(signalLine)) ? Number(Number(signalLine).toFixed(6)) : null,
    histogram: Number.isFinite(histogram) ? Number(histogram.toFixed(6)) : null,
    bias,
  };
}

function detectPatternsForCandles(candles = [], interval = '4h') {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { interval, detected: [], support: null, resistance: null, rsi: null, macd: { bias: 'neutral' } };
  }

  const closes = candles.map((row) => Number(row.close || 0)).filter((value) => Number.isFinite(value) && value > 0);
  const { highs, lows } = buildPivotSeries(candles, 2);
  const recentHighs = highs.slice(-3);
  const recentLows = lows.slice(-3);
  const resistance = recentHighs.length ? avg(recentHighs.map((row) => row.price)) : null;
  const support = recentLows.length ? avg(recentLows.map((row) => row.price)) : null;
  const rsi = computeRsi(closes, 14);
  const macd = computeMacdSignal(closes);
  const detected = [];

  if (recentHighs.length >= 2) {
    const [left, right] = recentHighs.slice(-2);
    const valley = lows.filter((row) => row.index > left.index && row.index < right.index).slice(-1)[0];
    if (valley && percentDiff(left.price, right.price) <= 0.03 && valley.price <= Math.min(left.price, right.price) * 0.96) {
      detected.push({ pattern: 'double_top', class: 'reversal_bearish', confidence: 72, bias: 'bearish' });
    }
  }

  if (recentLows.length >= 2) {
    const [left, right] = recentLows.slice(-2);
    const peak = highs.filter((row) => row.index > left.index && row.index < right.index).slice(-1)[0];
    if (peak && percentDiff(left.price, right.price) <= 0.03 && peak.price >= Math.max(left.price, right.price) * 1.04) {
      detected.push({ pattern: 'double_bottom', class: 'reversal_bullish', confidence: 72, bias: 'bullish' });
    }
  }

  if (recentHighs.length >= 3 && recentLows.length >= 3) {
    const highSpread = percentDiff(recentHighs[0].price, recentHighs[recentHighs.length - 1].price);
    const highSlope = linearSlope(recentHighs);
    const lowSlope = linearSlope(recentLows);
    if (highSpread <= 0.03 && lowSlope > 0) {
      detected.push({ pattern: 'ascending_triangle', class: 'continuation_bullish', confidence: 70, bias: 'bullish' });
    } else if (percentDiff(recentLows[0].price, recentLows[recentLows.length - 1].price) <= 0.03 && highSlope < 0) {
      detected.push({ pattern: 'descending_triangle', class: 'continuation_bearish', confidence: 70, bias: 'bearish' });
    } else if (highSlope < 0 && lowSlope > 0) {
      detected.push({ pattern: 'symmetrical_triangle', class: 'continuation_neutral', confidence: 64, bias: macd.bias });
    }

    const widthStart = Number(recentHighs[0].price) - Number(recentLows[0].price);
    const widthEnd = Number(recentHighs[recentHighs.length - 1].price) - Number(recentLows[recentLows.length - 1].price);
    if (widthStart > 0 && widthEnd > 0 && widthEnd < widthStart * 0.8) {
      if (highSlope < 0 && lowSlope < 0) {
        detected.push({ pattern: 'falling_wedge', class: 'reversal_bullish', confidence: 68, bias: 'bullish' });
      } else if (highSlope > 0 && lowSlope > 0) {
        detected.push({ pattern: 'rising_wedge', class: 'reversal_bearish', confidence: 68, bias: 'bearish' });
      }
    }
  }

  const recent = closes.slice(-25);
  const minRecent = Math.min(...recent);
  const maxRecent = Math.max(...recent);
  const endClose = recent[recent.length - 1];
  if (recent.length >= 20 && Number.isFinite(minRecent) && Number.isFinite(maxRecent) && minRecent > 0) {
    const drawdown = (maxRecent - minRecent) / minRecent;
    const recovery = (endClose - minRecent) / minRecent;
    if (drawdown > 0.08 && recovery > 0.06 && endClose >= maxRecent * 0.97) {
      detected.push({ pattern: 'rounding_bottom', class: 'reversal_bullish', confidence: 63, bias: 'bullish' });
    }
  }

  return {
    interval,
    detected,
    support: Number.isFinite(support) ? Number(support.toFixed(6)) : null,
    resistance: Number.isFinite(resistance) ? Number(resistance.toFixed(6)) : null,
    rsi: Number.isFinite(rsi) ? Number(rsi.toFixed(2)) : null,
    macd,
  };
}

function mergePatternBias(patterns = []) {
  const bullish = patterns.filter((row) => row.bias === 'bullish').reduce((sum, row) => sum + Number(row.confidence || 0), 0);
  const bearish = patterns.filter((row) => row.bias === 'bearish').reduce((sum, row) => sum + Number(row.confidence || 0), 0);
  if (bullish > bearish + 10) return 'bullish';
  if (bearish > bullish + 10) return 'bearish';
  return 'neutral';
}

async function analyzeEstablishedTokenPatterns(tokenData = {}) {
  if (!isEstablishedTokenCandidate(tokenData)) return null;

  const key = getCacheKey(tokenData);
  const cached = ANALYSIS_CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const baseArgs = {
    chainKey: tokenData.chainKey || tokenData.chain,
    address: tokenData.address,
    pairAddress: tokenData.pairAddress || tokenData.pair,
  };
  const [fourHour, daily] = await Promise.all([
    getOhlcvSeries({ ...baseArgs, interval: '4h', limit: 140 }).catch(() => null),
    getOhlcvSeries({ ...baseArgs, interval: '1d', limit: 140 }).catch(() => null),
  ]);

  const fourHourSummary = detectPatternsForCandles(fourHour?.candles || [], '4h');
  const dailySummary = detectPatternsForCandles(daily?.candles || [], '1d');
  const allDetected = [...fourHourSummary.detected, ...dailySummary.detected];
  const bias = mergePatternBias(allDetected);
  const summary = {
    applicable: true,
    suitable: true,
    establishedToken: true,
    symbol: normalizeSymbol(tokenData.symbol),
    timeframes: ['4h', '1d'],
    bias,
    detectedPatterns: allDetected,
    strongestPattern: allDetected.slice().sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0] || null,
    supportResistance: {
      h4Support: fourHourSummary.support,
      h4Resistance: fourHourSummary.resistance,
      d1Support: dailySummary.support,
      d1Resistance: dailySummary.resistance,
    },
    divergenceChecks: {
      h4Rsi: fourHourSummary.rsi,
      d1Rsi: dailySummary.rsi,
      h4MacdBias: fourHourSummary.macd?.bias || 'neutral',
      d1MacdBias: dailySummary.macd?.bias || 'neutral',
    },
    notes: [
      'Use 4H and 1D only for established, liquid tokens.',
      'Confirm patterns with support/resistance plus RSI or MACD bias.',
      'Use on-chain data or sentiment as a secondary confirmation layer.',
    ],
  };

  ANALYSIS_CACHE.set(key, {
    value: summary,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return summary;
}

module.exports = {
  analyzeEstablishedTokenPatterns,
  isEstablishedTokenCandidate,
};
