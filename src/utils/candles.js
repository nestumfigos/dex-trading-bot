'use strict';

const axios = require('axios');
const logger = require('./logger');

const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const OHLCV_CACHE = new Map();

function normalizeChain(chainKey) {
  const key = String(chainKey || '').toLowerCase();
  if (key === 'bsc' || key === 'binance' || key === 'binance-smart-chain') return 'bsc';
  if (key === 'base') return 'base';
  if (key === 'solana' || key === 'sol') return 'solana';
  return null;
}

function parseInterval(interval) {
  const raw = String(interval || '15m').trim().toLowerCase();
  const match = raw.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    return { resolution: 'minute', aggregate: 15, cacheTtlMs: 45_000 };
  }

  const value = Math.max(1, Number(match[1]));
  const unit = match[2];

  if (unit === 'h') {
    return { resolution: 'hour', aggregate: value, cacheTtlMs: 120_000 };
  }
  if (unit === 'd') {
    return { resolution: 'day', aggregate: value, cacheTtlMs: 300_000 };
  }

  return { resolution: 'minute', aggregate: value, cacheTtlMs: 45_000 };
}

function intervalToMs(intervalSpec) {
  const aggregate = Math.max(1, Number(intervalSpec?.aggregate || 1));
  const resolution = String(intervalSpec?.resolution || 'minute').toLowerCase();
  if (resolution === 'hour') return aggregate * 60 * 60 * 1000;
  if (resolution === 'day') return aggregate * 24 * 60 * 60 * 1000;
  return aggregate * 60 * 1000;
}

function normalizeTimestampMs(timestamp) {
  const ts = Number(timestamp || 0);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  // GeckoTerminal timestamps are typically epoch seconds.
  return ts < 1e12 ? ts * 1000 : ts;
}

function parseRows(payload) {
  const rows = payload?.data?.attributes?.ohlcv_list
    || payload?.data?.attributes?.ohlcvList
    || payload?.data?.ohlcv_list
    || payload?.ohlcv_list
    || [];

  if (!Array.isArray(rows)) return [];

  return rows
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) return null;
      const [timestamp, open, high, low, close, volume] = row;
      return {
        timestamp: Number(timestamp || 0),
        open: Number(open || 0),
        high: Number(high || 0),
        low: Number(low || 0),
        close: Number(close || 0),
        volume: Number(volume || 0),
      };
    })
    .filter((row) => Number.isFinite(row?.timestamp)
      && Number.isFinite(row?.close)
      && row.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchGeckoOhlcv(url, params) {
  const response = await axios.get(url, {
    params,
    headers: { accept: 'application/json' },
    timeout: 10_000,
  });
  return parseRows(response.data);
}

async function getOhlcvSeries({ chainKey, address, pairAddress, interval = '15m', limit = 120 }) {
  const network = normalizeChain(chainKey);
  const tokenAddress = String(address || '').trim();
  const poolAddress = String(pairAddress || '').trim();
  if (!network || !tokenAddress) return null;

  const bars = Math.max(30, Math.min(300, Number(limit || 120)));
  const intervalSpec = parseInterval(interval);
  const cacheKey = `${network}:${tokenAddress}:${poolAddress}:${intervalSpec.resolution}:${intervalSpec.aggregate}:${bars}`;
  const cached = OHLCV_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const params = {
    aggregate: intervalSpec.aggregate,
    limit: bars,
    currency: 'usd',
  };

  const urls = [
    `${GECKO_BASE_URL}/networks/${network}/tokens/${tokenAddress}/ohlcv/${intervalSpec.resolution}`,
    ...(poolAddress ? [`${GECKO_BASE_URL}/networks/${network}/pools/${poolAddress}/ohlcv/${intervalSpec.resolution}`] : []),
  ];

  for (const url of urls) {
    try {
      const rows = await fetchGeckoOhlcv(url, params);
      if (!rows.length) continue;

      const nowMs = Date.now();
      const candleDurationMs = intervalToMs(intervalSpec);
      const closedRows = rows.filter((row) => {
        const openMs = normalizeTimestampMs(row.timestamp);
        if (!openMs) return false;
        return (openMs + candleDurationMs) <= nowMs;
      });
      if (!closedRows.length) continue;

      const value = {
        candles: closedRows,
        closes: closedRows.map((row) => row.close),
        volumes: closedRows.map((row) => row.volume),
        source: 'geckoterminal',
      };

      OHLCV_CACHE.set(cacheKey, {
        value,
        expiresAt: Date.now() + intervalSpec.cacheTtlMs,
      });

      return value;
    } catch (error) {
      logger.debug(`OHLCV fetch failed (${network}) ${tokenAddress}: ${error.message}`);
    }
  }

  return null;
}

module.exports = {
  getOhlcvSeries,
};