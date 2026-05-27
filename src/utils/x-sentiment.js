'use strict';

const axios = require('axios');
const config = require('../../config');

async function fetchXPosts(symbol = '', logger = console) {
  const bearerToken = String(config.xSentiment?.bearerToken || '').trim();
  if (config.xSentiment?.enabled === false || !bearerToken || !symbol) {
    return [];
  }

  const maxResults = Math.max(5, Math.min(50, Number(config.xSentiment?.maxPosts || 12)));
  const query = encodeURIComponent(`(${symbol} OR $${symbol}) lang:en -is:retweet`);
  const url = `${String(config.xSentiment?.baseUrl || 'https://api.x.com/2').replace(/\/$/, '')}/tweets/search/recent?query=${query}&max_results=${maxResults}&tweet.fields=created_at,public_metrics`;

  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });
    return Array.isArray(response?.data?.data)
      ? response.data.data.map((item) => ({
        id: item.id,
        text: item.text,
        createdAt: item.created_at,
        metrics: item.public_metrics || {},
      }))
      : [];
  } catch (error) {
    // B3.api.5: bump to error + include HTTP context so a sustained Twitter
    // blackout shows up in logs as a data-feed alert rather than as
    // "sentiment quiet on this symbol". Downstream still treats [] as a
    // valid empty fetch — a fuller solution (cached-posts fallback + stale
    // flag) is deferred to a separate refactor.
    const statusCode = error.response?.status;
    const errCode = error.code || (statusCode ? `HTTP_${statusCode}` : 'UNKNOWN');
    logger?.error?.(`[XSentiment] fetch failed for ${symbol} (${errCode}): ${error.message}`);
    return [];
  }
}

module.exports = {
  fetchXPosts,
};
