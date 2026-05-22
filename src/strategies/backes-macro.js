'use strict';

const {
  classifySlope,
  normalizeCandles,
  simpleMA,
  simpleMASeries,
  wilderRsi,
} = require('./backes-indicators');

const REGIME_SIZE_MULTIPLIERS = Object.freeze({
  risk_off: 0.5,
  capitulation: 0.3,
  reversal_pending: 0.8,
  bull_pullback: 1.0,
  neutral: 1.0,
  unknown: 1.0,
});

const MACRO_CACHE = new Map();

function asDateKey(timestamp) {
  const ms = Number(timestamp || 0);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const normalized = ms < 1e12 ? ms * 1000 : ms;
  return new Date(normalized).toISOString().slice(0, 10);
}

function aggregateDailyToWeekly(candles = []) {
  const rows = normalizeCandles(candles);
  if (rows.length < 5) return rows;
  const weeks = [];
  let bucket = null;
  for (const candle of rows) {
    const dateKey = asDateKey(candle.timestamp);
    const date = dateKey ? new Date(`${dateKey}T00:00:00Z`) : null;
    const day = date ? date.getUTCDay() : weeks.length % 7;
    const weekStartMs = date
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((day + 6) % 7))
      : Math.floor(weeks.length / 5);
    if (!bucket || bucket.weekStartMs !== weekStartMs) {
      if (bucket) weeks.push(bucket);
      bucket = {
        weekStartMs,
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      };
    } else {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.volume += candle.volume;
      bucket.timestamp = candle.timestamp;
    }
  }
  if (bucket) weeks.push(bucket);
  return weeks;
}

function normalizeMarketKlines(input = {}) {
  if (Array.isArray(input)) {
    const daily = normalizeCandles(input);
    return { daily, weekly: aggregateDailyToWeekly(daily) };
  }
  const daily = normalizeCandles(input.daily || input.dailyCandles || input.candles || []);
  const weekly = normalizeCandles(input.weekly || input.weeklyCandles || []);
  return {
    daily,
    weekly: weekly.length ? weekly : aggregateDailyToWeekly(daily),
  };
}

function latestMetrics(input = {}) {
  const { daily, weekly } = normalizeMarketKlines(input);
  const dailyCloses = daily.map((row) => row.close);
  const weeklyCloses = weekly.map((row) => row.close);
  const latestDaily = daily[daily.length - 1] || null;
  const previousDaily = daily[daily.length - 2] || null;
  const latestWeekly = weekly[weekly.length - 1] || null;
  const ma56d = simpleMA(dailyCloses, 56);
  const ma56dSeries = simpleMASeries(dailyCloses, 56);
  const ma8w = simpleMA(weeklyCloses, 8);
  const ma21w = simpleMA(weeklyCloses, 21);
  const weeklyRsi = wilderRsi(weeklyCloses, 14);
  const latestClose = latestDaily?.close || latestWeekly?.close || null;
  const near21w = latestClose > 0 && ma21w > 0
    ? Math.abs(latestClose - ma21w) / ma21w
    : Infinity;
  const recentDaily = daily.slice(-7);
  const recentLow = recentDaily.length ? Math.min(...recentDaily.map((row) => row.low)) : null;
  return {
    daily,
    weekly,
    latestClose,
    previousClose: previousDaily?.close || null,
    latestDaily,
    latestWeekly,
    ma56d,
    ma8w,
    ma21w,
    ma56dSlope: classifySlope(ma56dSeries, { lookback: 8, flatThresholdPct: 0.003 }),
    weeklySlope: classifySlope(weeklyCloses, { lookback: 8, flatThresholdPct: 0.01 }),
    weeklyRsi,
    near21w,
    recentLow,
  };
}

function buildScores(btc, eth) {
  const trendInputs = [btc, eth].filter((m) => m.latestClose > 0);
  if (!trendInputs.length) return { trend: 0, momentum: 0, volatility: 0 };
  const trend = trendInputs.reduce((sum, m) => {
    let score = 0;
    if (m.ma8w && m.latestClose > m.ma8w) score += 35;
    if (m.ma56d && m.latestClose > m.ma56d) score += 35;
    if (m.ma56dSlope === 'rising') score += 20;
    if (m.weeklySlope === 'rising') score += 10;
    return sum + score;
  }, 0) / trendInputs.length;
  const momentum = trendInputs.reduce((sum, m) => sum + Math.max(0, Math.min(100, Number(m.weeklyRsi || 50))), 0) / trendInputs.length;
  const volatility = trendInputs.reduce((sum, m) => {
    if (!m.latestClose || !m.recentLow) return sum;
    return sum + Math.min(100, Math.max(0, ((m.latestClose - m.recentLow) / m.latestClose) * 1000));
  }, 0) / trendInputs.length;
  return {
    trend: Number(trend.toFixed(2)),
    momentum: Number(momentum.toFixed(2)),
    volatility: Number(volatility.toFixed(2)),
  };
}

function classifyMacroRegime({ btcKlines, ethKlines } = {}) {
  const btc = latestMetrics(btcKlines || {});
  const eth = latestMetrics(ethKlines || {});
  const markets = [
    ['BTC', btc],
    ['ETH', eth],
  ].filter(([, m]) => m.latestClose > 0);

  if (!markets.length) {
    return { regime: 'unknown', reasons: ['macro_ohlcv_unavailable'], scores: buildScores(btc, eth) };
  }

  const reasons = [];
  const capitulation = markets.some(([symbol, m]) => {
    const reclaim = m.previousClose > 0 && m.latestClose > m.previousClose && m.latestDaily?.close > m.latestDaily?.open;
    const hit = Number(m.weeklyRsi) <= 30 && reclaim;
    if (hit) reasons.push(`${symbol}:weekly_rsi_capitulation_reclaim`);
    return hit;
  });
  if (capitulation) return { regime: 'capitulation', reasons, scores: buildScores(btc, eth) };

  const riskOff = markets.some(([symbol, m]) => {
    const below8w = m.ma8w > 0 && m.latestClose < m.ma8w;
    const belowFalling56d = m.ma56d > 0 && m.latestClose < m.ma56d && m.ma56dSlope === 'falling';
    if (below8w) reasons.push(`${symbol}:close_below_8w_ma`);
    if (belowFalling56d) reasons.push(`${symbol}:close_below_falling_56d_ma`);
    return below8w || belowFalling56d;
  });
  if (riskOff) return { regime: 'risk_off', reasons, scores: buildScores(btc, eth) };

  const reversalPending = markets.some(([symbol, m]) => {
    const retested56d = m.ma56d > 0 && m.recentLow > 0 && m.recentLow <= m.ma56d * 1.015;
    const reclaim = m.ma56d > 0 && m.latestClose > m.ma56d && m.latestClose > m.previousClose;
    const hit = retested56d && reclaim;
    if (hit) reasons.push(`${symbol}:56d_retest_hold_reclaim`);
    return hit;
  });
  if (reversalPending) return { regime: 'reversal_pending', reasons, scores: buildScores(btc, eth) };

  const bullPullback = markets.some(([symbol, m]) => {
    const uptrend = m.ma8w > 0 && m.ma21w > 0 && m.latestClose > m.ma8w && m.ma8w >= m.ma21w * 0.98;
    const nearSupport = m.near21w <= 0.06;
    const defensive = m.recentLow > 0 && m.ma21w > 0 && m.recentLow >= m.ma21w * 0.94;
    const hit = uptrend && nearSupport && defensive;
    if (hit) reasons.push(`${symbol}:weekly_uptrend_near_21w_support`);
    return hit;
  });
  if (bullPullback) return { regime: 'bull_pullback', reasons, scores: buildScores(btc, eth) };

  return { regime: 'neutral', reasons: ['macro_no_special_regime'], scores: buildScores(btc, eth) };
}

function getMacroSizeMultiplier(regimeOrResult) {
  const regime = typeof regimeOrResult === 'string'
    ? regimeOrResult
    : String(regimeOrResult?.regime || 'neutral');
  return REGIME_SIZE_MULTIPLIERS[regime] ?? 1.0;
}

async function getMacroRegime({ fetchOhlcv, chainKey = 'kucoin', cacheKey = 'global', cacheTtlMs = 4 * 60 * 60 * 1000 } = {}) {
  if (typeof fetchOhlcv !== 'function') {
    return { regime: 'unknown', reasons: ['macro_fetcher_unavailable'], scores: { trend: 0, momentum: 0, volatility: 0 }, cached: false };
  }
  const key = `${cacheKey}:${chainKey}`;
  const cached = MACRO_CACHE.get(key);
  if (cached && Date.now() < cached.expiresAt) return { ...cached.value, cached: true };

  const [btcDaily, ethDaily] = await Promise.all([
    fetchOhlcv({ chainKey, symbol: 'BTC/USDT', address: 'BTC/USDT', interval: '1d', limit: 420 }).catch(() => null),
    fetchOhlcv({ chainKey, symbol: 'ETH/USDT', address: 'ETH/USDT', interval: '1d', limit: 420 }).catch(() => null),
  ]);
  const value = classifyMacroRegime({
    btcKlines: btcDaily?.candles || btcDaily || [],
    ethKlines: ethDaily?.candles || ethDaily || [],
  });
  MACRO_CACHE.set(key, { value, expiresAt: Date.now() + Math.max(60_000, Number(cacheTtlMs || 0)) });
  return { ...value, cached: false };
}

function clearMacroRegimeCache() {
  MACRO_CACHE.clear();
}

module.exports = {
  REGIME_SIZE_MULTIPLIERS,
  aggregateDailyToWeekly,
  classifyMacroRegime,
  clearMacroRegimeCache,
  getMacroRegime,
  getMacroSizeMultiplier,
  normalizeMarketKlines,
};
