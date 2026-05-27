'use strict';

const { rsi: computeRsi } = require('./indicators');
const { getOhlcvSeries } = require('./candles');

class TimeframeConfluenceAnalyzer {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.cache = new Map();
    this.cacheTtlMs = 60000; // 1 minute cache for OHLCV data
  }

  /**
   * Analyzes technical alignment across 1h and 4h timeframes
   * Returns confluence score: 0-100 (higher = more alignment)
   */
  async analyzeTimeframeConfluence(tokenData, chainName) {
    if (!tokenData?.symbol) return null;

    try {
      const ohlcv1h = await this.fetchOhlcv(tokenData, chainName, '1h', 20);
      const ohlcv4h = await this.fetchOhlcv(tokenData, chainName, '4h', 20);

      if (!ohlcv1h || ohlcv1h.length < 5 || !ohlcv4h || ohlcv4h.length < 3) {
        return null;
      }

      const analysis1h = this.analyzeTimeframe(ohlcv1h, '1h');
      const analysis4h = this.analyzeTimeframe(ohlcv4h, '4h');

      if (!analysis1h || !analysis4h) return null;

      return {
        confluence1h: analysis1h,
        confluence4h: analysis4h,
        alignmentScore: this.calculateAlignment(analysis1h, analysis4h),
        signal: this.determineConfluenceSignal(analysis1h, analysis4h),
        details: {
          rsi1h: analysis1h.rsi,
          rsi4h: analysis4h.rsi,
          trend1h: analysis1h.trend,
          trend4h: analysis4h.trend,
          ema1h: analysis1h.emaSignal,
          ema4h: analysis4h.emaSignal,
        },
      };
    } catch (err) {
      this.logger?.debug(`[Confluence] Analysis error for ${tokenData?.symbol}: ${err.message}`);
      return null;
    }
  }

  /**
   * Analyzes a single timeframe for trend and momentum
   */
  analyzeTimeframe(ohlcv, timeframe) {
    if (!Array.isArray(ohlcv) || ohlcv.length < 3) return null;

    try {
      const closes = ohlcv.map((bar) => bar.close);
      const highs = ohlcv.map((bar) => bar.high);
      const lows = ohlcv.map((bar) => bar.low);
      const volumes = ohlcv.map((bar) => bar.volume);

      // B2.23: RSI period per timeframe. Previous code used 14 for both 1h and
      // 4h, which over-smooths the 4h reading and misaligns the cross-TF
      // confluence score. Standard convention: shorter window on longer TF
      // (or vice versa) — here 4h uses 9 to react to HTF shifts; 1h keeps 14;
      // anything else stays at config default (14 fallback).
      const rsiPeriodByTf = { '1h': 14, '4h': 9, '1d': 9 };
      const rsiPeriod = rsiPeriodByTf[timeframe] ?? 14;
      const rsi = computeRsi(closes, rsiPeriod);
      const ema9 = this.computeEma(closes, 9);
      const ema21 = this.computeEma(closes, 21);

      const lastClose = closes[closes.length - 1];
      const ema9Val = ema9[ema9.length - 1];
      const ema21Val = ema21[ema21.length - 1];

      // B3.strat.6: when EMA arrays are empty or values undefined (input too
      // short / non-finite slot), bail this timeframe out as 'neutral' rather
      // than letting NaN comparisons silently produce 'bearish'. Callers that
      // depend on a confluence score will skip this timeframe in the average
      // instead of being skewed by a phantom bearish vote.
      if (!Number.isFinite(ema9Val) || !Number.isFinite(ema21Val) || !Number.isFinite(lastClose)) {
        return { timeframe, emaSignal: 'neutral', rsiVal: null, neutralReason: 'ema_data_insufficient' };
      }

      const rsiVal = rsi[rsi.length - 1];
      const emaSignal = lastClose > ema9Val && ema9Val > ema21Val ? 'bullish' : 'bearish';

      const highestHigh = Math.max(...highs.slice(-10));
      const lowestLow = Math.min(...lows.slice(-10));
      const atr = (highestHigh - lowestLow) / lowestLow;

      const volumeTrend = this.analyzeVolumeTrend(volumes);

      return {
        rsi: Number.isFinite(rsiVal) ? rsiVal : 50,
        emaSignal,
        ema9: ema9Val,
        ema21: ema21Val,
        trend: this.classifyTrend(closes),
        atr,
        volumeTrend,
        lastPrice: lastClose,
      };
    } catch (err) {
      this.logger?.debug(`[Confluence] Timeframe analysis error: ${err.message}`);
      return null;
    }
  }

  /**
   * Calculates alignment score between two timeframes (0-100)
   */
  calculateAlignment(analysis1h, analysis4h) {
    let alignmentPoints = 0;
    const maxPoints = 5;

    // RSI alignment: if both in oversold/overbought, alignment = high
    if ((analysis1h.rsi < 35 && analysis4h.rsi < 45) || (analysis1h.rsi > 65 && analysis4h.rsi > 55)) {
      alignmentPoints += 1;
    }

    // EMA signal alignment: both bullish or both bearish
    if (analysis1h.emaSignal === analysis4h.emaSignal) {
      alignmentPoints += 1.5;
    }

    // Trend alignment: 1h trend matches or validates 4h trend
    const trend1h = analysis1h.trend;
    const trend4h = analysis4h.trend;

    if ((trend1h === 'uptrend' && trend4h === 'uptrend') || (trend1h === 'downtrend' && trend4h === 'downtrend')) {
      alignmentPoints += 1.5;
    } else if ((trend1h === 'uptrend' && trend4h === 'consolidating') || (trend1h === 'downtrend' && trend4h === 'consolidating')) {
      alignmentPoints += 0.5;
    }

    // Volume trend alignment
    if (analysis1h.volumeTrend === 'increasing' && analysis4h.volumeTrend === 'increasing') {
      alignmentPoints += 1;
    }

    const alignmentScore = Math.round((alignmentPoints / maxPoints) * 100);
    return Math.min(100, alignmentScore);
  }

  /**
   * Determines confluence signal quality
   */
  determineConfluenceSignal(analysis1h, analysis4h) {
    const strongBullish = analysis1h.emaSignal === 'bullish' && analysis4h.emaSignal === 'bullish' && analysis4h.trend === 'uptrend';
    const strongBearish = analysis1h.emaSignal === 'bearish' && analysis4h.emaSignal === 'bearish' && analysis4h.trend === 'downtrend';
    const weakBullish = analysis1h.emaSignal === 'bullish' && analysis4h.emaSignal === 'bullish';
    const weakBearish = analysis1h.emaSignal === 'bearish' && analysis4h.emaSignal === 'bearish';

    if (strongBullish) return 'STRONG_BUY';
    if (strongBearish) return 'STRONG_SELL';
    if (weakBullish) return 'BUY';
    if (weakBearish) return 'SELL';
    return 'NEUTRAL';
  }

  /**
   * Classifies trend based on price action
   */
  classifyTrend(closes) {
    if (closes.length < 5) return 'unknown';

    const recent = closes.slice(-5);
    const older = closes.slice(-10, -5);

    const recentAvg = recent.reduce((a, b) => a + b) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b) / older.length;

    if (recentAvg > olderAvg * 1.02) return 'uptrend';
    if (recentAvg < olderAvg * 0.98) return 'downtrend';
    return 'consolidating';
  }

  /**
   * Analyzes volume trend
   */
  analyzeVolumeTrend(volumes) {
    if (volumes.length < 5) return 'unknown';

    const recent = volumes.slice(-5).reduce((a, b) => a + b) / 5;
    const older = volumes.slice(-10, -5).reduce((a, b) => a + b) / 5;

    if (recent > older * 1.2) return 'increasing';
    if (recent < older * 0.8) return 'decreasing';
    return 'stable';
  }

  /**
   * Computes EMA
   */
  computeEma(prices, period) {
    if (!Array.isArray(prices) || prices.length < period) return [];

    const ema = [];
    const multiplier = 2 / (period + 1);

    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    ema[period - 1] = sum / period;

    for (let i = period; i < prices.length; i++) {
      ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
    }

    return ema;
  }

  /**
   * Fetches OHLCV data for a specific timeframe
   */
  async fetchOhlcv(tokenData, chainName, timeframe, bars) {
    const cacheKey = `${chainName}:${tokenData?.address}:${timeframe}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const ohlcv = await getOhlcvSeries(
        tokenData?.address,
        chainName,
        timeframe,
        bars
      );

      if (Array.isArray(ohlcv) && ohlcv.length > 0) {
        this.cache.set(cacheKey, { data: ohlcv, timestamp: Date.now() });
        return ohlcv;
      }
    } catch (err) {
      this.logger?.debug(`[Confluence] Failed to fetch ${timeframe} OHLCV: ${err.message}`);
    }

    return null;
  }

  /**
   * Get confluence boost for confidence score (0-30)
   */
  getConfluenceBoost(alignmentScore) {
    if (!Number.isFinite(alignmentScore)) return 0;

    if (alignmentScore >= 85) return 30;
    if (alignmentScore >= 75) return 25;
    if (alignmentScore >= 65) return 20;
    if (alignmentScore >= 50) return 15;
    if (alignmentScore >= 35) return 8;

    return 0;
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = TimeframeConfluenceAnalyzer;
