// Free news utility with provider fallbacks.
const axios = require('axios');
const logger = require('./logger');

const CRYPTOPANIC_BASE = 'https://cryptopanic.com/api/v1/posts/';
const CRYPTOPANIC_KEY = process.env.CRYPTOPANIC_API_KEY || '';
const CRYPTOCOMPARE_BASE = 'https://min-api.cryptocompare.com/data/v2/news/';
const CRYPTOCOMPARE_KEY = process.env.CRYPTOCOMPARE_API_KEY || '';
const NEWS_CACHE_TTL_MS = Math.max(30_000, Number(process.env.NEWS_CACHE_TTL_MS || 60_000));

// Keyless RSS feeds, each verified live on 2026-08-25 (item counts in the
// chain comment below). Note CoinDesk has NO trailing slash — the old
// '/rss/' 308-redirects. Override the set with NEWS_RSS_FEEDS as
// "Label|url,Label|url".
const RSS_FEEDS = (() => {
  const raw = String(process.env.NEWS_RSS_FEEDS || '').trim();
  if (raw) {
    return raw.split(',').map((entry) => {
      const [label, url] = entry.split('|').map((s) => String(s || '').trim());
      return label && url ? [label, url] : null;
    }).filter(Boolean);
  }
  return [
    ['CoinDeskRSS', 'https://www.coindesk.com/arc/outboundfeeds/rss'],
    ['CointelegraphRSS', 'https://cointelegraph.com/rss'],
    ['DecryptRSS', 'https://decrypt.co/feed'],
    ['NewsBTCRSS', 'https://www.newsbtc.com/feed/'],
    ['BitcoinMagazineRSS', 'https://bitcoinmagazine.com/feed'],
  ];
})();

const sourceState = {
  CryptoPanic: { cooldownUntil: 0 },
  CryptoCompare: { cooldownUntil: 0 },
};
for (const [label] of RSS_FEEDS) {
  sourceState[label] = { cooldownUntil: 0 };
}

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
    // min-api requires a key as of 2026; only reached when one is set.
    api_key: CRYPTOCOMPARE_KEY || undefined,
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

// 2026-08-25: generalised from the CoinDesk-only parser. Every source below
// is a standard RSS feed (<item><title><link><pubDate>), so one parser
// serves all of them and adding a feed is a one-line change.
async function fetchFromRss(feedUrl, sourceLabel, symbol = '', limit = 10) {
  const res = await axios.get(feedUrl, {
    timeout: 10000,
    responseType: 'text',
    // CoinDesk's /rss/ returns 308 -> /rss. Redirects are followed by
    // default, but pinning this makes the behaviour explicit rather than
    // dependent on an axios default.
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dex-trading-bot/1.0)' },
  });
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
      source: sourceLabel,
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

  // 2026-08-25: source chain rebuilt against live probe results.
  //   CryptoPanic v1  -> 403 (and v2 -> 404); needs a paid key
  //   CryptoCompare   -> 401; min-api now requires a key
  //   Reddit          -> 403 on any User-Agent; requires OAuth now
  //   CoinDesk        -> worked all along; the trailing slash 308-redirects
  // The keyed providers are kept but SKIPPED when no key is configured —
  // previously they burned a request and a cooldown on every cycle to fail
  // in a way no key-less deployment could ever recover from. The RSS feeds
  // below were each verified returning items (Decrypt 58, Cointelegraph 30,
  // CoinDesk 25, NewsBTC 10, BitcoinMagazine 10) with no credentials.
  const sources = [
    ...(CRYPTOPANIC_KEY ? [['CryptoPanic', () => fetchFromCryptoPanic(symbol, limit)]] : []),
    ...(CRYPTOCOMPARE_KEY ? [['CryptoCompare', () => fetchFromCryptoCompare(symbol, limit)]] : []),
    ...RSS_FEEDS.map(([name, url]) => [name, () => fetchFromRss(url, name, symbol, limit)]),
  ];

  // Distinguish "every source errored" from "sources worked, nothing matched
  // this symbol". Both used to log 'All news sources failed', which made a
  // perfectly healthy feed look broken whenever an altcoin simply had no
  // coverage — and hid the real outage in the noise.
  let anySourceResponded = false;
  const aggregated = [];
  const seen = new Set();

  for (const [sourceName, sourceFetcher] of sources) {
    if (sourceOnCooldown(sourceName)) {
      continue;
    }

    try {
      const results = await sourceFetcher();
      if (Array.isArray(results)) {
        anySourceResponded = true;
        for (const item of results) {
          const dedupeKey = String(item?.url || item?.title || '').trim().toLowerCase();
          if (!dedupeKey || seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          aggregated.push(item);
        }
      }
      // Aggregate across feeds rather than returning the first hit: a single
      // outlet rarely covers a given altcoin, so pooling materially improves
      // the odds of finding symbol-specific coverage.
      if (aggregated.length >= limit) break;
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

  if (aggregated.length) {
    const items = aggregated.slice(0, limit);
    cachedNews = { key: cacheKey, items, expiresAt: Date.now() + NEWS_CACHE_TTL_MS };
    return items;
  }

  if (cachedNews.key === cacheKey && cachedNews.items.length) {
    return cachedNews.items;
  }

  // Only a genuine outage is worth a warning. A symbol with no coverage is
  // normal and silent (debug), so the warning keeps its signal value.
  if (!anySourceResponded) {
    if (Date.now() - lastAllFailedLogAt > 120_000) {
      lastAllFailedLogAt = Date.now();
      logger.warn('All news sources failed, returning empty list.');
    }
  } else {
    logger.debug(`No news matched ${symbol || 'market'} across ${sources.length} source(s).`);
  }
  return [];
}

async function analyzeNewsSentiment(headlines) {
  // headlines: array of strings
  return nvidiaAnalyzeBatch(headlines, 'Analyze this for crypto sentiment (bullish/bearish/neutral)');
}

module.exports = { fetchCryptoNews };
module.exports.analyzeNewsSentiment = analyzeNewsSentiment;