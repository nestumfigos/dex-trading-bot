'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('./logger');

const listingCache = new Map();
const quoteCache = new Map();

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
    timeout: 10000,
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
  if (Array.isArray(items)) return items[0] || null;
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

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getCoinMarketCapContext(symbol, reference = {}) {
  if (!hasCoinMarketCapApiKey()) {
    return {
      source: 'coinmarketcap',
      available: false,
      confirmsMomentum: false,
      reason: 'disabled_or_missing_api_key',
    };
  }
  try {
    const data = await coinMarketCapRequest('/v2/cryptocurrency/quotes/latest', {
      symbol,
      convert: 'USD',
    });
    const entry = extractQuoteEntry(data, String(symbol || '').toUpperCase());
    const quote = entry?.quote?.USD || {};
    const price = safeNumber(quote.price, 0);
    if (!price) {
      return {
        source: 'coinmarketcap',
        available: false,
        confirmsMomentum: false,
        reason: 'no_price_in_response',
      };
    }
    const tickerChange = safeNumber(quote.percent_change_24h, 0);
    const refChange = safeNumber(reference.priceChange24hPct ?? reference.priceChange24h, 0);
    const confirmsMomentum = Math.sign(tickerChange || refChange) === Math.sign(refChange || tickerChange)
      && Boolean(tickerChange || refChange);
    return {
      source: 'coinmarketcap',
      available: true,
      confirmsMomentum: Boolean(confirmsMomentum),
      price,
      marketCapUsd: safeNumber(quote.market_cap, 0),
      volume24hUsd: safeNumber(quote.volume_24h, 0),
      priceChange1hPct: safeNumber(quote.percent_change_1h, 0),
      priceChange24hPct: tickerChange,
      priceChange7dPct: safeNumber(quote.percent_change_7d, 0),
      rank: safeNumber(entry?.cmc_rank, 0),
      coinMarketCapId: Number(entry?.id || 0) || null,
    };
  } catch (error) {
    return {
      source: 'coinmarketcap',
      available: false,
      confirmsMomentum: false,
      reason: error?.message || String(error),
    };
  }
}

module.exports = {
  findListingBySymbol,
  getQuoteBySymbol,
  getCoinMarketCapContext,
  hasCoinMarketCapApiKey,
};