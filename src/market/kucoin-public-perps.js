'use strict';

// K2: KuCoin Futures public market-data feed. Interface-compatible with
// createBinancePublicPerpsFeed so the scanner, anchors, and backtest replay
// can swap providers via a single factory choice (see src/index.js).
//
// Internal canonical symbols (Binance-style: BTCUSDT) translate to KuCoin
// (XBTUSDTM) only at the I/O boundary — strategies, telemetry, and persistence
// keep their existing shape.

const { toKucoinSymbol } = require('../utils/perps-symbols');
const { normalizeCandles } = require('../strategies/perps-anchors');

// Binance interval string -> KuCoin granularity in minutes (KuCoin's only
// accepted values: 1, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 10080).
const INTERVAL_TO_GRANULARITY_MIN = Object.freeze({
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '1w': 10080,
});

function toGranularityMinutes(interval) {
  const granularity = INTERVAL_TO_GRANULARITY_MIN[String(interval).toLowerCase()];
  if (!granularity) {
    throw new Error(`unsupported interval for KuCoin futures: ${interval}`);
  }
  return granularity;
}

function createKucoinPublicPerpsFeed({
  baseUrl = 'https://api-futures.kucoin.com',
  fetchFn = global.fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchFn !== 'function') throw new Error('fetchFn is required');

  // Mirror Binance feed retry policy (B3P.14): KuCoin futures rate-limits at
  // ~30 requests/sec per IP for public endpoints. Retry transient 429/5xx with
  // jittered exponential backoff to keep scans alive through bursts.
  const MAX_KLINE_ATTEMPTS = 4;
  const KLINE_BASE_DELAY_MS = 500;
  const KLINE_MAX_DELAY_MS = 8000;

  function shouldRetryKlineResponse(status) {
    return status === 429 || (status >= 500 && status < 600);
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // KuCoin returns klines as `[time, open, high, low, close, volume, turnover]`
  // where `time` is openTime in ms. normalizeCandles already reads indices 0-5
  // identically — no reshape needed at the consumer end. We synthesize a
  // closeTime by adding granularity-ms so the "drop unclosed bar" filter from
  // Binance feed semantics carries over.
  async function getKlinesRaw(kucoinSymbol, granularityMin, { from, to } = {}) {
    const query = new URLSearchParams({
      symbol: kucoinSymbol,
      granularity: String(granularityMin),
    });
    if (Number.isFinite(Number(from))) query.set('from', String(Number(from)));
    if (Number.isFinite(Number(to))) query.set('to', String(Number(to)));
    const url = `${baseUrl}/api/v1/kline/query?${query.toString()}`;
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_KLINE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          if (shouldRetryKlineResponse(response.status) && attempt < MAX_KLINE_ATTEMPTS) {
            const retryAfter = Number(response.headers?.get?.('retry-after')) * 1000;
            const backoff = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter
              : Math.min(KLINE_MAX_DELAY_MS, KLINE_BASE_DELAY_MS * (2 ** (attempt - 1)));
            await sleep(Math.floor(Math.random() * backoff));
            continue;
          }
          throw new Error(`KuCoin Futures klines failed with HTTP ${response.status}`);
        }
        const body = await response.json();
        if (!body || body.code !== '200000' || !Array.isArray(body.data)) {
          throw new Error(`KuCoin Futures klines response invalid (code=${body?.code})`);
        }
        // KuCoin returns newest-first sometimes (varies by endpoint); sort
        // ascending by openTime for normalizeCandles + downstream consumers.
        return body.data.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
      } catch (err) {
        lastError = err;
        const transient = err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED';
        if (!transient || attempt >= MAX_KLINE_ATTEMPTS) throw err;
        const backoff = Math.min(KLINE_MAX_DELAY_MS, KLINE_BASE_DELAY_MS * (2 ** (attempt - 1)));
        await sleep(Math.floor(Math.random() * backoff));
      }
    }
    throw lastError;
  }

  async function getCompletedCandles(canonicalSymbol, interval, limit) {
    const kucoinSymbol = toKucoinSymbol(canonicalSymbol);
    const granularityMin = toGranularityMinutes(interval);
    const granularityMs = granularityMin * 60 * 1000;
    // Fetch limit+1 bars so we can drop the still-forming bar at the tip.
    // KuCoin lacks a direct row limit; constrain via time window instead.
    const to = now();
    const from = to - granularityMs * (limit + 1);
    const rows = await getKlinesRaw(kucoinSymbol, granularityMin, { from, to });
    // Filter: keep only bars whose closeTime is in the past.
    const completed = rows.filter((row) => Number(row[0]) + granularityMs <= now());
    return normalizeCandles(completed).slice(-limit);
  }

  async function getDailyCandles(canonicalSymbol, limit = 40) {
    const kucoinSymbol = toKucoinSymbol(canonicalSymbol);
    const granularityMs = 1440 * 60 * 1000;
    const to = now();
    const from = to - granularityMs * (limit + 1);
    const rows = await getKlinesRaw(kucoinSymbol, 1440, { from, to });
    return normalizeCandles(rows).slice(-limit);
  }

  async function getHistoricalCandles(canonicalSymbol, interval, {
    startTime,
    endTime = now(),
    limit = 1500,
    maxPages = 20,
  } = {}) {
    const kucoinSymbol = toKucoinSymbol(canonicalSymbol);
    const granularityMin = toGranularityMinutes(interval);
    const granularityMs = granularityMin * 60 * 1000;
    let cursor = Number(startTime);
    const finish = Number(endTime);
    if (!Number.isFinite(cursor) || !Number.isFinite(finish) || cursor >= finish) {
      throw new Error('valid historical startTime and endTime are required');
    }
    const collected = [];
    for (let page = 0; page < maxPages && cursor < finish; page += 1) {
      // KuCoin returns at most 200 bars per call. Use min(limit, 200) per page.
      const pageWindowMs = Math.min(limit, 200) * granularityMs;
      const pageTo = Math.min(cursor + pageWindowMs, finish);
      const raw = await getKlinesRaw(kucoinSymbol, granularityMin, {
        from: cursor,
        to: pageTo,
      });
      const completed = raw.filter((row) => Number(row[0]) + granularityMs <= finish);
      if (!completed.length) break;
      collected.push(...completed);
      const nextCursor = Number(completed[completed.length - 1][0]) + granularityMs;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    const normalized = normalizeCandles(collected);
    const deduped = new Map(normalized.map((candle) => [candle.openTime, candle]));
    return Array.from(deduped.values()).sort((left, right) => left.openTime - right.openTime);
  }

  return { getCompletedCandles, getDailyCandles, getHistoricalCandles };
}

module.exports = {
  createKucoinPublicPerpsFeed,
  toGranularityMinutes,
  INTERVAL_TO_GRANULARITY_MIN,
};
