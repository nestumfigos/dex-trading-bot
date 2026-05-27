'use strict';

const { normalizeCandles } = require('../strategies/perps-anchors');

function createBinancePublicPerpsFeed({
  baseUrl = 'https://fapi.binance.com',
  fetchFn = global.fetch,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchFn !== 'function') throw new Error('fetchFn is required');

  // B3P.14: retry transient 429 / 5xx with exponential backoff + jitter.
  // Binance Futures rate-limits the public klines endpoint; without retry the
  // scanner hangs on the first 429 and operator sees a feed-down without
  // recovery.
  const MAX_KLINE_ATTEMPTS = 4;
  const KLINE_BASE_DELAY_MS = 500;
  const KLINE_MAX_DELAY_MS = 8000;

  function shouldRetryKlineResponse(status) {
    return status === 429 || (status >= 500 && status < 600);
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function getKlines(symbol, interval, limit, { startTime, endTime } = {}) {
    const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (Number.isFinite(Number(startTime))) query.set('startTime', String(Number(startTime)));
    if (Number.isFinite(Number(endTime))) query.set('endTime', String(Number(endTime)));
    const url = `${baseUrl}/fapi/v1/klines?${query.toString()}`;
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
          throw new Error(`Binance Futures klines failed with HTTP ${response.status}`);
        }
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('Binance Futures klines response is invalid');
        return rows;
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

  async function getCompletedCandles(symbol, interval, limit) {
    const raw = await getKlines(symbol, interval, limit + 1);
    return normalizeCandles(raw.filter((row) => Number(row[6]) < Number(now()))).slice(-limit);
  }

  async function getDailyCandles(symbol, limit = 40) {
    return normalizeCandles(await getKlines(symbol, '1d', limit));
  }

  async function getHistoricalCandles(symbol, interval, {
    startTime,
    endTime = now(),
    limit = 1500,
    maxPages = 20,
  } = {}) {
    let cursor = Number(startTime);
    const finish = Number(endTime);
    if (!Number.isFinite(cursor) || !Number.isFinite(finish) || cursor >= finish) {
      throw new Error('valid historical startTime and endTime are required');
    }
    const rows = [];
    for (let page = 0; page < maxPages && cursor < finish; page += 1) {
      const rawPage = await getKlines(symbol, interval, Math.min(1500, limit), {
        startTime: cursor,
        endTime: finish,
      });
      const pageRows = normalizeCandles(rawPage.filter((row) => Number(row[6]) < finish));
      if (!pageRows.length) break;
      rows.push(...pageRows);
      const nextCursor = pageRows[pageRows.length - 1].openTime + 1;
      if (nextCursor <= cursor || rawPage.length < Math.min(1500, limit)) break;
      cursor = nextCursor;
    }
    const deduped = new Map(rows.map((candle) => [candle.openTime, candle]));
    return Array.from(deduped.values()).sort((left, right) => left.openTime - right.openTime);
  }

  return { getCompletedCandles, getDailyCandles, getHistoricalCandles };
}

module.exports = { createBinancePublicPerpsFeed };
