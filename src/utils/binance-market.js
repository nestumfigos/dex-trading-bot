'use strict';

const axios = require('axios');

const BINANCE_BASE_URL = 'https://api.binance.com';
const CACHE = new Map();

function normalizeSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  return raw.endsWith('USDT') ? raw : `${raw}USDT`;
}

function getCached(key) {
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return null;
}

function setCached(key, value, ttlMs) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function fetchBinanceTicker(symbol, { ttlMs = 30_000 } = {}) {
  const marketSymbol = normalizeSymbol(symbol);
  if (!marketSymbol) return null;
  const cacheKey = `ticker:${marketSymbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const response = await axios.get(`${BINANCE_BASE_URL}/api/v3/ticker/24hr`, {
    params: { symbol: marketSymbol },
    timeout: 8_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Binance ticker request failed with HTTP ${response.status}`);
  }
  if (!response.data || typeof response.data !== 'object') {
    throw new Error('Binance ticker response was not an object');
  }
  const row = response.data || {};
  if (!Number.isFinite(Number(row.lastPrice))) {
    throw new Error(`Binance ticker response missing lastPrice for ${marketSymbol}`);
  }
  return setCached(cacheKey, {
    symbol: marketSymbol,
    price: Number(row.lastPrice || 0),
    priceChange24hPct: Number(row.priceChangePercent || 0),
    volume24hUsd: Number(row.quoteVolume || 0),
    tradeCount24h: Number(row.count || 0),
  }, ttlMs);
}

async function fetchBinanceDepth(symbol, { limit = 50, ttlMs = 15_000 } = {}) {
  const marketSymbol = normalizeSymbol(symbol);
  if (!marketSymbol) return null;
  const cacheKey = `depth:${marketSymbol}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const response = await axios.get(`${BINANCE_BASE_URL}/api/v3/depth`, {
    params: { symbol: marketSymbol, limit },
    timeout: 8_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Binance depth request failed with HTTP ${response.status}`);
  }
  if (!response.data || typeof response.data !== 'object') {
    throw new Error('Binance depth response was not an object');
  }
  const bids = Array.isArray(response.data?.bids) ? response.data.bids : [];
  const asks = Array.isArray(response.data?.asks) ? response.data.asks : [];
  if (!bids.length || !asks.length) {
    throw new Error(`Binance depth response missing bids/asks for ${marketSymbol}`);
  }
  const bidUsd = bids.reduce((sum, [price, qty]) => sum + (Number(price) * Number(qty)), 0);
  const askUsd = asks.reduce((sum, [price, qty]) => sum + (Number(price) * Number(qty)), 0);
  const depthUsd = bidUsd + askUsd;
  const imbalance = depthUsd > 0 ? (bidUsd - askUsd) / depthUsd : 0;
  return setCached(cacheKey, {
    symbol: marketSymbol,
    bidUsd,
    askUsd,
    depthUsd,
    imbalance,
  }, ttlMs);
}

async function getBinanceConfirmation(symbol, reference = {}) {
  const [tickerResult, depthResult] = await Promise.allSettled([
    fetchBinanceTicker(symbol),
    fetchBinanceDepth(symbol),
  ]);
  const ticker = tickerResult.status === 'fulfilled' ? tickerResult.value : null;
  const depth = depthResult.status === 'fulfilled' ? depthResult.value : null;
  if (!ticker && !depth) {
    return {
      source: 'binance',
      available: false,
      confirmsMomentum: false,
      tickerUnavailableReason: tickerResult.status === 'rejected' ? tickerResult.reason?.message || String(tickerResult.reason) : 'missing_ticker',
      depthUnavailableReason: depthResult.status === 'rejected' ? depthResult.reason?.message || String(depthResult.reason) : 'missing_depth',
    };
  }
  const refChange = Number(reference.priceChange24hPct ?? reference.priceChange24h ?? 0);
  const changeDiffPct = ticker ? Math.abs(Number(ticker.priceChange24hPct || 0) - refChange) : null;
  const confirmsMomentum = ticker
    ? Math.sign(Number(ticker.priceChange24hPct || 0)) === Math.sign(refChange || Number(ticker.priceChange24hPct || 0))
    : false;
  return {
    source: 'binance',
    available: true,
    tickerUnavailableReason: tickerResult.status === 'rejected' ? tickerResult.reason?.message || String(tickerResult.reason) : null,
    depthUnavailableReason: depthResult.status === 'rejected' ? depthResult.reason?.message || String(depthResult.reason) : null,
    ticker,
    depth,
    confirmsMomentum,
    priceChangeDiffPct: changeDiffPct,
    liquidityScore: depth ? Math.max(0, Math.min(1, Number(depth.depthUsd || 0) / 1_000_000)) : 0,
    depthImbalance: depth ? Number(depth.imbalance || 0) : 0,
  };
}

module.exports = {
  normalizeSymbol,
  fetchBinanceTicker,
  fetchBinanceDepth,
  getBinanceConfirmation,
};
