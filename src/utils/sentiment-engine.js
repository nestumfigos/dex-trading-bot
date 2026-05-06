'use strict';

const config = require('../../config');
const { fetchCryptoNews } = require('./news');
const { getRedditPosts } = require('./reddit');
const { fetchXPosts } = require('./x-sentiment');
const { runPythonSidecar } = require('./python-sidecar');

const BULLISH_TERMS = ['bullish', 'breakout', 'surge', 'rally', 'upgrade', 'adoption', 'accumulate', 'strong', 'recovery', 'beat'];
const BEARISH_TERMS = ['bearish', 'dump', 'selloff', 'lawsuit', 'hack', 'exploit', 'warning', 'fear', 'liquidation', 'crash'];
const sentimentCache = new Map();
let cachedRedditFeed = {
  items: [],
  expiresAt: 0,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreText(text = '') {
  const normalized = String(text || '').toLowerCase();
  let score = 0;
  for (const term of BULLISH_TERMS) {
    if (normalized.includes(term)) score += 1;
  }
  for (const term of BEARISH_TERMS) {
    if (normalized.includes(term)) score -= 1;
  }
  return score;
}

function mapScoreToSignal(score = 0.5) {
  if (score >= 0.58) return 'BUY';
  if (score <= 0.42) return 'SELL';
  return 'HOLD';
}

function mapConfidence(score = 0.5, evidenceCount = 0) {
  const distance = Math.abs(Number(score || 0.5) - 0.5) * 2;
  const evidenceBoost = clamp(Number(evidenceCount || 0) / 10, 0, 1);
  return clamp((distance * 0.75) + (evidenceBoost * 0.25), 0, 1);
}

async function fetchTokenSentiment({
  symbol,
  chainKey,
  tokenData,
  logger,
  modelRegistry,
} = {}) {
  const cacheKey = `${String(chainKey || 'unknown')}:${String(symbol || '').toUpperCase()}`;
  const cached = sentimentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const redditLoader = async () => {
    if (cachedRedditFeed.expiresAt > Date.now() && Array.isArray(cachedRedditFeed.items)) {
      return cachedRedditFeed.items;
    }
    const posts = await getRedditPosts('CryptoCurrency', 40);
    cachedRedditFeed = {
      items: Array.isArray(posts) ? posts : [],
      expiresAt: Date.now() + 120000,
    };
    return cachedRedditFeed.items;
  };

  const [news, reddit] = await Promise.allSettled([
    fetchCryptoNews(symbol || '', 6),
    redditLoader(),
  ]);
  const xPosts = await fetchXPosts(symbol || '', logger).catch(() => []);

  const newsItems = Array.isArray(news.value) ? news.value : [];
  const redditItems = Array.isArray(reddit.value)
    ? reddit.value.filter((item) => String(item?.title || '').toUpperCase().includes(String(symbol || '').toUpperCase())).slice(0, 8)
    : [];
  const xItems = Array.isArray(xPosts) ? xPosts.slice(0, Math.max(1, Number(config.xSentiment?.maxPosts || 12))) : [];

  const textScores = [
    ...newsItems.map((item) => scoreText(item?.title || '')),
    ...redditItems.map((item) => scoreText(item?.title || '')),
    ...xItems.map((item) => scoreText(item?.text || '')),
  ];

  const lexiconRaw = textScores.length
    ? textScores.reduce((sum, value) => sum + value, 0) / Math.max(1, textScores.length * 2)
    : 0;
  const coingeckoBias = clamp(((Number(tokenData?.sentimentUpPct || 0) - Number(tokenData?.sentimentDownPct || 0)) / 100), -1, 1);
  let aggregateScore = clamp(0.5 + (lexiconRaw * 0.4) + (coingeckoBias * 0.2), 0, 1);
  let signal = mapScoreToSignal(aggregateScore);
  let scorer = 'custom_crypto_vader_like';
  const evidenceCount = newsItems.length + redditItems.length + xItems.length;

  const activeSentimentModels = modelRegistry
    ? await modelRegistry.getActiveModelVersions('sentiment', 'any').catch(() => [])
    : [];
  const externalSentimentModel = activeSentimentModels.find((version) => String(version.provider || '').toLowerCase() === 'python_sidecar');
  if (externalSentimentModel && config.externalModels?.enabled !== false) {
    try {
      const external = await runPythonSidecar('infer_sentiment', {
        framework: externalSentimentModel.metadata?.framework || externalSentimentModel.params?.framework || 'finbert',
        artifactPath: externalSentimentModel.metadata?.artifactPath || externalSentimentModel.params?.artifactPath,
        metadata: {
          ...(externalSentimentModel.metadata || {}),
          ...(externalSentimentModel.params || {}),
        },
        texts: [
          ...newsItems.map((item) => item?.title).filter(Boolean),
          ...redditItems.map((item) => item?.title).filter(Boolean),
          ...xItems.map((item) => item?.text).filter(Boolean),
        ],
      });
      aggregateScore = clamp(Number(external.score || aggregateScore), 0, 1);
      signal = String(external.signal || mapScoreToSignal(aggregateScore)).toUpperCase();
      scorer = String(external.provider || externalSentimentModel.displayName || 'python_sidecar_sentiment');
    } catch (error) {
      logger?.debug?.(`[Sentiment] external scorer unavailable for ${symbol}: ${error.message}`);
    }
  }

  const payload = {
    ts: new Date().toISOString(),
    chainKey: chainKey || null,
    symbol: symbol || null,
    address: tokenData?.address || null,
    aggregateScore,
    signal,
    confidence: mapConfidence(aggregateScore, evidenceCount),
    newsCount: newsItems.length,
    redditCount: redditItems.length,
    xCount: xItems.length,
    newsHeadlines: newsItems.slice(0, 5).map((item) => item?.title).filter(Boolean),
    redditHeadlines: redditItems.slice(0, 5).map((item) => item?.title).filter(Boolean),
    xHeadlines: xItems.slice(0, 5).map((item) => item?.text).filter(Boolean),
    scorer,
  };

  sentimentCache.set(cacheKey, {
    value: payload,
    expiresAt: Date.now() + 120000,
  });

  if (modelRegistry) {
    modelRegistry.recordSentimentSnapshot(payload).catch((error) => {
      logger?.warn?.(`[Sentiment] snapshot persistence failed: ${error.message}`);
    });
  }

  return payload;
}

module.exports = {
  fetchTokenSentiment,
  scoreText,
  mapScoreToSignal,
};
