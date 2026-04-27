// Free news utility with provider fallbacks.
const axios = require('axios');
const logger = require('./logger');

const CRYPTOPANIC_BASE = 'https://cryptopanic.com/api/v1/posts/';
const CRYPTOPANIC_KEY = process.env.CRYPTOPANIC_API_KEY || '';
const CRYPTOCOMPARE_BASE = 'https://min-api.cryptocompare.com/data/v2/news/';
const REDDIT_BASE = 'https://www.reddit.com/r/CryptoCurrency/new.json';
const COINDESK_RSS = 'https://www.coindesk.com/arc/outboundfeeds/rss/';
const NEWS_CACHE_TTL_MS = Math.max(60_000, Number(process.env.NEWS_CACHE_TTL_MS || 180_000));

const sourceState = {
  CryptoPanic: { cooldownUntil: 0 },
  CryptoCompare: { cooldownUntil: 0 },
  Reddit: { cooldownUntil: 0 },
  CoinDeskRSS: { cooldownUntil: 0 },
};

let cachedNews = { key: '', items: [], expiresAt: 0 };
let lastAllFailedLogAt = 0;

let hasLoggedCryptoPanic404 = false;

function normalizeDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

async function fetchFromCryptoPanic(symbol = '', limit = 10) {
  const params = {
    auth_token: CRYPTOPANIC_KEY,
    currencies: symbol,
    filter: 'hot',
    public: true,
    kind: 'news',
    regions: 'en',
    limit,
  };

  Object.keys(params).forEach((k) => (params[k] === '' || params[k] === undefined) && delete params[k]);
  const res = await axios.get(CRYPTOPANIC_BASE, { params, timeout: 10000 });

  return (res.data?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    published_at: item.published_at,
    source: item.source?.title || '',
    votes: item.votes || {},
    tags: item.tags || [],
  }));
}

async function fetchFromCryptoCompare(symbol = '', limit = 10) {
  const params = {
    lang: 'EN',
    categories: symbol ? symbol.toUpperCase() : undefined,
  };

  Object.keys(params).forEach((k) => (params[k] === '' || params[k] === undefined) && delete params[k]);
  const res = await axios.get(CRYPTOCOMPARE_BASE, { params, timeout: 10000 });
  const payload = res.data?.Data;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.List)
      ? payload.List
      : [];

  return items.slice(0, limit).map((item) => ({
    title: item.title,
    url: item.url,
    published_at: normalizeDate((item.published_on || 0) * 1000),
    source: item.source_info?.name || item.source || '',
    votes: {},
    tags: item.categories ? String(item.categories).split('|') : [],
  }));
}

async function fetchFromReddit(symbol = '', limit = 10) {
  const res = await axios.get(REDDIT_BASE, {
    params: { limit: Math.max(limit * 2, limit) },
    timeout: 10000,
    headers: { 'User-Agent': 'DEXBot/1.0' },
  });

  const items = (res.data?.data?.children || []).map((item) => ({
    title: item.data?.title || '',
    url: item.data?.permalink ? `https://reddit.com${item.data.permalink}` : '',
    published_at: normalizeDate((item.data?.created_utc || 0) * 1000),
    source: `r/${item.data?.subreddit || 'CryptoCurrency'}`,
    votes: { score: item.data?.score || 0, comments: item.data?.num_comments || 0 },
    tags: ['reddit'],
  }));

  if (!symbol) {
    return items.slice(0, limit);
  }

  const upper = symbol.toUpperCase();
  return items.filter((item) => item.title.toUpperCase().includes(upper)).slice(0, limit);
}

async function fetchFromCoinDeskRss(symbol = '', limit = 10) {
  const res = await axios.get(COINDESK_RSS, { timeout: 10000, responseType: 'text' });
  const xml = String(res.data || '');
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  const titleRegex = /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i;
  const linkRegex = /<link>([\s\S]*?)<\/link>/i;
  const pubDateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/i;

  const rows = [];
  let match;
  while ((match = itemRegex.exec(xml)) && rows.length < Math.max(limit * 3, 30)) {
    const block = match[1];
    const titleMatch = block.match(titleRegex);
    const linkMatch = block.match(linkRegex);
    const dateMatch = block.match(pubDateRegex);

    const title = (titleMatch?.[1] || titleMatch?.[2] || '').trim();
    const url = (linkMatch?.[1] || '').trim();
    const published = normalizeDate(dateMatch?.[1] || '');

    if (!title || !url) continue;
    rows.push({
      title,
      url,
      published_at: published,
      source: 'CoinDesk',
      votes: {},
      tags: ['rss'],
    });
  }

  if (!symbol) {
    return rows.slice(0, limit);
  }

  const upper = symbol.toUpperCase();
  return rows.filter((item) => item.title.toUpperCase().includes(upper)).slice(0, limit);
}

function setSourceCooldown(sourceName, ms) {
  const state = sourceState[sourceName];
  if (!state) return;
  state.cooldownUntil = Date.now() + ms;
}

function sourceOnCooldown(sourceName) {
  const state = sourceState[sourceName];
  return Boolean(state && state.cooldownUntil > Date.now());
}

/**
 * Fetch latest crypto news headlines (free tier, no sentiment)
 * Optionally filter by coin symbol (e.g., BTC, ETH)
 */
async function fetchCryptoNews(symbol = '', limit = 10) {
  const cacheKey = `${String(symbol || '').toUpperCase()}:${Number(limit || 10)}`;
  if (cachedNews.key === cacheKey && cachedNews.expiresAt > Date.now() && cachedNews.items.length) {
    return cachedNews.items;
  }

  const sources = [
    ['CryptoPanic', () => fetchFromCryptoPanic(symbol, limit)],
    ['CryptoCompare', () => fetchFromCryptoCompare(symbol, limit)],
    ['Reddit', () => fetchFromReddit(symbol, limit)],
    ['CoinDeskRSS', () => fetchFromCoinDeskRss(symbol, limit)],
  ];

  for (const [sourceName, sourceFetcher] of sources) {
    if (sourceOnCooldown(sourceName)) {
      continue;
    }

    try {
      const results = await sourceFetcher();
      if (Array.isArray(results) && results.length) {
        cachedNews = {
          key: cacheKey,
          items: results,
          expiresAt: Date.now() + NEWS_CACHE_TTL_MS,
        };
        return results;
      }
    } catch (error) {
      const status = error?.response?.status;
      if (sourceName === 'CryptoPanic' && status === 404) {
        setSourceCooldown(sourceName, 6 * 60 * 60 * 1000);
        if (!hasLoggedCryptoPanic404) {
          hasLoggedCryptoPanic404 = true;
          logger.warn('News source CryptoPanic returned 404. Using fallback providers.');
        }
      } else if (status === 429) {
        setSourceCooldown(sourceName, 10 * 60 * 1000);
        logger.warn(`News source ${sourceName} rate-limited (429). Cooling down for 10m.`);
      } else {
        setSourceCooldown(sourceName, 2 * 60 * 1000);
        logger.warn(`News source ${sourceName} failed: ${error.message}`);
      }
    }
  }

  if (cachedNews.key === cacheKey && cachedNews.items.length) {
    return cachedNews.items;
  }

  if (Date.now() - lastAllFailedLogAt > 120_000) {
    lastAllFailedLogAt = Date.now();
    logger.warn('All news sources failed, returning empty list.');
  }
  return [];
}

async function analyzeNewsSentiment(headlines) {
  // headlines: array of strings
  return nvidiaAnalyzeBatch(headlines, 'Analyze this for crypto sentiment (bullish/bearish/neutral)');
}

module.exports = { fetchCryptoNews };
module.exports.analyzeNewsSentiment = analyzeNewsSentiment;