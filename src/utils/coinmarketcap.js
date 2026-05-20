'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('./logger');

const listingCache = new Map();
const quoteCache = new Map();
const marketContextCache = new Map();

function hasCoinMarketCapApiKey() {
  return Boolean(config.coinmarketcap?.enabled && config.coinmarketcap?.apiKey);
}

async function coinMarketCapRequest(path, params = {}) {
  if (!hasCoinMarketCapApiKey()) {
    return null;
  }

  const response = await axios.get(`${config.coinmarketcap.baseUrl}${path}`, {
    headers: {
      'X-CMC_PRO_API_KEY': config.coinmarketcap.apiKey,
      Accept: 'application/json',
    },
    params,
    timeout: Math.max(1000, Number(process.env.COINMARKETCAP_TIMEOUT_MS || 5000)),
  });

  return response.data?.data || null;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function pickBestListing(entries, symbol, name) {
  const normalizedSymbol = normalizeText(symbol);
  const normalizedName = normalizeText(name);
  if (!Array.isArray(entries) || entries.length === 0 || !normalizedSymbol) {
    return null;
  }

  const ranked = [...entries].sort((left, right) => Number(left?.rank || Number.MAX_SAFE_INTEGER) - Number(right?.rank || Number.MAX_SAFE_INTEGER));
  const exactName = normalizedName
    ? ranked.find((entry) => normalizeText(entry?.name) === normalizedName && normalizeText(entry?.symbol) === normalizedSymbol)
    : null;
  if (exactName) return exactName;

  return ranked.find((entry) => normalizeText(entry?.symbol) === normalizedSymbol) || ranked[0] || null;
}

async function findListingBySymbol(symbol, name) {
  if (!hasCoinMarketCapApiKey() || !symbol) {
    return null;
  }

  const cacheKey = `${normalizeText(symbol)}|${normalizeText(name)}`;
  if (listingCache.has(cacheKey)) {
    return listingCache.get(cacheKey);
  }

  try {
    const data = await coinMarketCapRequest('/v1/cryptocurrency/map', {
      symbol,
      listing_status: 'active',
      sort: 'cmc_rank',
    });
    const entries = Array.isArray(data) ? data : [];
    const listing = pickBestListing(entries, symbol, name);
    const result = listing
      ? {
          listedOnCoinMarketCap: true,
          coinMarketCapId: Number(listing.id || 0) || null,
          coinMarketCapName: listing.name || null,
          coinMarketCapSlug: listing.slug || null,
          coinMarketCapSymbol: listing.symbol || null,
        }
      : null;
    listingCache.set(cacheKey, result);
    return result;
  } catch (error) {
    logger.debug(`CoinMarketCap listing lookup failed for ${symbol}: ${error.message}`);
    listingCache.set(cacheKey, null);
    return null;
  }
}

function extractQuoteEntry(data, symbol) {
  const items = data?.[symbol];
  if (Array.isArray(items)) {
    return [...items]
      .sort((left, right) => {
        const leftHasPrice = Number(left?.quote?.USD?.price || 0) > 0 ? 0 : 1;
        const rightHasPrice = Number(right?.quote?.USD?.price || 0) > 0 ? 0 : 1;
        if (leftHasPrice !== rightHasPrice) return leftHasPrice - rightHasPrice;
        return Number(left?.cmc_rank || Number.MAX_SAFE_INTEGER) - Number(right?.cmc_rank || Number.MAX_SAFE_INTEGER);
      })[0] || null;
  }
  if (items && typeof items === 'object') return items;
  return null;
}

async function getQuoteBySymbol(symbol) {
  if (!hasCoinMarketCapApiKey() || !symbol) {
    return null;
  }

  const normalizedSymbol = normalizeText(symbol);
  const cached = quoteCache.get(normalizedSymbol);
  if (cached && (Date.now() - cached.fetchedAt) < 30000) {
    return cached.value;
  }

  try {
    const data = await coinMarketCapRequest('/v2/cryptocurrency/quotes/latest', {
      symbol,
      convert: 'USD',
    });
    const entry = extractQuoteEntry(data, symbol.toUpperCase());
    const price = Number(entry?.quote?.USD?.price || 0);
    const result = Number.isFinite(price) && price > 0
      ? {
          price,
          source: 'coinmarketcap',
          coinMarketCapId: Number(entry.id || 0) || null,
        }
      : null;
    quoteCache.set(normalizedSymbol, { value: result, fetchedAt: Date.now() });
    return result;
  } catch (error) {
    logger.debug(`CoinMarketCap quote lookup failed for ${symbol}: ${error.message}`);
    quoteCache.set(normalizedSymbol, { value: null, fetchedAt: Date.now() });
    return null;
  }
}

function extractQuoteUsd(entry) {
  return entry?.quote?.USD || {};
}

async function getCoinMarketCapContext(symbol, reference = {}) {
  if (!hasCoinMarketCapApiKey() || !symbol) {
    return {
      source: 'coinmarketcap',
      available: false,
      reason: 'disabled_or_missing_api_key',
      confirmsMomentum: false,
    };
  }

  const normalizedSymbol = normalizeText(symbol).toUpperCase();
  const cached = marketContextCache.get(normalizedSymbol);
  if (cached && (Date.now() - cached.fetchedAt) < Number(config.coinmarketcap?.snapshotTtlMs || 60_000)) {
    return cached.value;
  }

  try {
    const data = await coinMarketCapRequest('/v2/cryptocurrency/quotes/latest', {
      symbol: normalizedSymbol,
      convert: 'USD',
    });
    const entry = extractQuoteEntry(data, normalizedSymbol);
    if (!entry) throw new Error(`CoinMarketCap quote missing ${normalizedSymbol}`);
    const quote = extractQuoteUsd(entry);
    const price = Number(quote.price || 0);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`CoinMarketCap quote invalid price for ${normalizedSymbol}`);
    }
    const refChange = Number(reference.priceChange24hPct ?? reference.priceChange24h ?? 0);
    const priceChange24hPct = Number(quote.percent_change_24h || 0);
    const result = {
      source: 'coinmarketcap',
      available: true,
      coinMarketCapId: Number(entry.id || 0) || null,
      name: entry.name || null,
      symbol: entry.symbol || normalizedSymbol,
      rank: Number(entry.cmc_rank || 0) || 0,
      price,
      marketCapUsd: Number(quote.market_cap || 0) || 0,
      volume24hUsd: Number(quote.volume_24h || 0) || 0,
      volumeChange24hPct: Number(quote.volume_change_24h || 0) || 0,
      priceChange1hPct: Number(quote.percent_change_1h || 0) || 0,
      priceChange24hPct,
      priceChange7dPct: Number(quote.percent_change_7d || 0) || 0,
      priceChangeDiffPct: Math.abs(priceChange24hPct - refChange),
      confirmsMomentum: Math.sign(priceChange24hPct || refChange) === Math.sign(refChange || priceChange24hPct),
      liquidityScore: Math.max(0, Math.min(1, Number(quote.volume_24h || 0) / 1_000_000)),
      lastUpdated: quote.last_updated || entry.last_updated || null,
    };
    marketContextCache.set(normalizedSymbol, { value: result, fetchedAt: Date.now() });
    return result;
  } catch (error) {
    const result = {
      source: 'coinmarketcap',
      available: false,
      reason: error.message,
      confirmsMomentum: false,
    };
    marketContextCache.set(normalizedSymbol, { value: result, fetchedAt: Date.now() });
    logger.debug(`CoinMarketCap context lookup failed for ${symbol}: ${error.message}`);
    return result;
  }
}

module.exports = {
  findListingBySymbol,
  getQuoteBySymbol,
  getCoinMarketCapContext,
  hasCoinMarketCapApiKey,
};
