'use strict';
const axios = require('axios');
const { findListingBySymbol } = require('./coinmarketcap');
const logger = require('./logger');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const tokenIdCache = new Map();
const contractIdCache = new Map();
const failedSearchCache = new Map(); // Cache failed searches to avoid retrying
const requestQueue = [];
let lastRequestTime = 0;
const REQUEST_DELAY_MS = 300; // 300ms between requests = ~3.3 req/sec (well under 10-50/min limit)
let isProcessing = false;

const CHAIN_TO_PLATFORM = {
  solana: 'solana',
  bsc: 'binance-smart-chain',
  base: 'base',
};

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  while (requestQueue.length > 0) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS - timeSinceLastRequest));
    }
    
    const request = requestQueue.shift();
    lastRequestTime = Date.now();
    
    try {
      const result = await request.fn();
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    }
  }
  isProcessing = false;
}

function queueRequest(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function searchCoinGeckoId(query, retryCount = 0) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  
  // Check if we already have the result
  if (tokenIdCache.has(normalized)) {
    return tokenIdCache.get(normalized);
  }
  
  // Check if we recently failed to find it (avoid retrying immediately)
  if (failedSearchCache.has(normalized)) {
    const failedAt = failedSearchCache.get(normalized);
    if (Date.now() - failedAt < 3600000) { // Don't retry for 1 hour
      return null;
    }
  }

  const MAX_RETRIES = 5;
  const BASE_DELAY = 1000; // 1s base delay for backoff
  try {
    const result = await queueRequest(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/search`, {
        params: { query: normalized },
        timeout: 10000,
      });

      const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
      const match = coins.find((coin) => coin.symbol?.toLowerCase() === normalized);
      return (match || coins[0] || {}).id || null;
    });

    tokenIdCache.set(normalized, result);
    if (!result) {
      failedSearchCache.set(normalized, Date.now());
    }
    return result;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount); // Exponential backoff
      logger.debug(`CoinGecko rate limited (429) for search: ${query}, retry ${retryCount + 1} in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return searchCoinGeckoId(query, retryCount + 1);
    } else {
      logger.debug(`CoinGecko search failed for ${query}: ${error.message}`);
      failedSearchCache.set(normalized, Date.now());
      return null;
    }
  }
}

async function searchCoinGeckoContractId(tokenAddress, chain, retryCount = 0) {
  const normalizedAddress = String(tokenAddress || '').trim();
  const platform = CHAIN_TO_PLATFORM[String(chain || '').trim().toLowerCase()];
  if (!platform || !normalizedAddress) {
    return null;
  }

  const cacheKey = `${platform}:${normalizedAddress.toLowerCase()}`;
  if (contractIdCache.has(cacheKey)) {
    return contractIdCache.get(cacheKey);
  }

  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000;
  try {
    const result = await queueRequest(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/coins/${platform}/contract/${normalizedAddress}`, {
        params: {
          localization: 'false',
          tickers: 'false',
          market_data: 'false',
          community_data: 'false',
          developer_data: 'false',
          sparkline: 'false',
        },
        timeout: 10000,
      });
      return res.data?.id || null;
    });
    contractIdCache.set(cacheKey, result);
    return result;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      logger.debug(`CoinGecko contract lookup rate limited for ${normalizedAddress}, retry ${retryCount + 1} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return searchCoinGeckoContractId(normalizedAddress, chain, retryCount + 1);
    }
    if (error.response?.status !== 404) {
      logger.debug(`CoinGecko contract lookup failed for ${normalizedAddress}: ${error.message}`);
    }
    contractIdCache.set(cacheKey, null);
    return null;
  }
}

async function fetchCoinGeckoMetrics(id, retryCount = 0) {
  if (!id) return null;
  
  const MAX_RETRIES = 5;
  const BASE_DELAY = 1000;
  try {
    const result = await queueRequest(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/coins/${id}`, {
        params: {
          localization: 'false',
          tickers: 'false',
          market_data: 'false',
          community_data: 'true',
          developer_data: 'true',
          sparkline: 'false',
        },
        timeout: 10000,
      });

      const data = res.data;
      return {
        coingeckoId: data.id,
        communityScore: Number(data.community_score || 0),
        developerScore: Number(data.developer_score || 0),
        publicInterestScore: Number(data.public_interest_score || 0),
        sentimentUpPct: Number(data.sentiment_votes_up_percentage || 0),
        sentimentDownPct: Number(data.sentiment_votes_down_percentage || 0),
        homepage: Array.isArray(data.links?.homepage) ? data.links.homepage[0] : null,
      };
    });

    return result;
  } catch (error) {
    if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      logger.debug(`CoinGecko rate limited (429) for metrics: ${id}, retry ${retryCount + 1} in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchCoinGeckoMetrics(id, retryCount + 1);
    } else {
      logger.debug(`CoinGecko metrics failed for ${id}: ${error.message}`);
      return null;
    }
  }
}

async function getTokenMetrics(tokenAddress, chain, symbol, name) {
  const queries = [symbol, name, tokenAddress].filter(Boolean);
  const [contractId, coinMarketCapListing] = await Promise.all([
    searchCoinGeckoContractId(tokenAddress, chain),
    findListingBySymbol(symbol, name),
  ]);

  let coingeckoId = contractId;
  for (const query of queries) {
    if (coingeckoId) break;
    coingeckoId = await searchCoinGeckoId(query);
  }

  if (!coingeckoId && !coinMarketCapListing) {
    return null;
  }

  const metrics = coingeckoId ? await fetchCoinGeckoMetrics(coingeckoId) : null;
  return {
    ...(metrics || {}),
    coingeckoId: coingeckoId || null,
    listedOnCoinGecko: Boolean(coingeckoId),
    listedOnCoinMarketCap: Boolean(coinMarketCapListing?.listedOnCoinMarketCap),
    coinMarketCapId: coinMarketCapListing?.coinMarketCapId || null,
    coinMarketCapSlug: coinMarketCapListing?.coinMarketCapSlug || null,
  };
}

module.exports = { getTokenMetrics, getQueueStats: () => ({ queueLength: requestQueue.length, lastRequestTime }) };
