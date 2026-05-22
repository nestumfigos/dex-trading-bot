'use strict';

const axios = require('axios');
const config = require('../../config');

const CACHE = new Map();
let tickerListCache = null;

function getCached(key) {
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return null;
}

function setCached(key, value, ttlMs) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function normalizeSymbol(symbol = '') {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/(?:USDT|USDC|USD)$/i, '');
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pctDiff(left, right) {
  const a = safeNumber(left, 0);
  const b = safeNumber(right, 0);
  if (!a || !b) return 0;
  return Math.abs(((a - b) / b) * 100);
}

function pickBestTicker(rows = [], symbol = '') {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol || !Array.isArray(rows)) return null;
  const matches = rows.filter((row) => String(row?.symbol || '').toUpperCase() === normalizedSymbol);
  if (!matches.length) return null;
  return matches
    .sort((left, right) => safeNumber(left?.rank, Number.MAX_SAFE_INTEGER) - safeNumber(right?.rank, Number.MAX_SAFE_INTEGER))[0] || null;
}

async function fetchCoinPaprikaTicker(symbol, { ttlMs } = {}) {
  if (config.coinpaprika?.enabled === false) return null;
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;
  const cacheKey = `ticker:${normalizedSymbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const listTtlMs = Math.max(10_000, Number(ttlMs || config.coinpaprika?.snapshotTtlMs || 60_000));
  if (!tickerListCache || tickerListCache.expiresAt <= Date.now()) {
    const response = await axios.get(`${config.coinpaprika?.baseUrl || 'https://api.coinpaprika.com/v1'}/tickers`, {
      params: { quotes: 'USD' },
      timeout: Math.max(1000, Number(process.env.COINPAPRIKA_TIMEOUT_MS || 5000)),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`CoinPaprika ticker request failed with HTTP ${response.status}`);
    }
    if (!Array.isArray(response.data)) {
      throw new Error('CoinPaprika ticker response was not an array');
    }
    tickerListCache = {
      rows: response.data,
      expiresAt: Date.now() + listTtlMs,
    };
  }
  const row = pickBestTicker(tickerListCache.rows, normalizedSymbol);
  if (!row) throw new Error(`CoinPaprika ticker missing ${normalizedSymbol}`);
  const quote = row.quotes?.USD || {};
  const parsed = {
    source: 'coinpaprika',
    available: true,
    id: row.id || null,
    name: row.name || null,
    symbol: row.symbol || normalizedSymbol,
    rank: safeNumber(row.rank, 0),
    price: safeNumber(quote.price, 0),
    marketCapUsd: safeNumber(quote.market_cap, 0),
    volume24hUsd: safeNumber(quote.volume_24h, 0),
    priceChange1hPct: safeNumber(quote.percent_change_1h, 0),
    priceChange24hPct: safeNumber(quote.percent_change_24h, 0),
    priceChange7dPct: safeNumber(quote.percent_change_7d, 0),
    lastUpdated: row.last_updated || null,
  };
  return setCached(cacheKey, parsed, listTtlMs);
}

async function getCoinPaprikaContext(symbol, reference = {}) {
  try {
    const ticker = await fetchCoinPaprikaTicker(symbol);
    if (!ticker) {
      return { source: 'coinpaprika', available: false, reason: 'disabled_or_missing_symbol', confirmsMomentum: false };
    }
    const refChange = safeNumber(reference.priceChange24hPct ?? reference.priceChange24h, 0);
    const refPrice = safeNumber(reference.price ?? reference.currentPrice, 0);
    const tickerChange = safeNumber(ticker.priceChange24hPct, 0);
    const confirmsMomentum = Math.sign(tickerChange || refChange) === Math.sign(refChange || tickerChange);
    return {
      ...ticker,
      confirmsMomentum: Boolean(confirmsMomentum && (tickerChange || refChange)),
      priceDiffPct: pctDiff(ticker.price, refPrice),
      priceChangeDiffPct: Math.abs(tickerChange - refChange),
      liquidityScore: Math.max(0, Math.min(1, safeNumber(ticker.volume24hUsd, 0) / 1_000_000)),
    };
  } catch (error) {
    return {
      source: 'coinpaprika',
      available: false,
      reason: error.message,
      confirmsMomentum: false,
    };
  }
}

module.exports = {
  normalizeSymbol,
  fetchCoinPaprikaTicker,
  getCoinPaprikaContext,
};
