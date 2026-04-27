'use strict';

const config = require('../../config');
const logger = require('./logger');
const { fetchCryptoNews } = require('./news');

const catalystCache = new Map(); // key: pair (e.g. BTC/USDT)
let lastRefreshAt = 0;

const MAJOR_EVENT_PATTERNS = [
  { type: 'mainnet_upgrade', pattern: /\b(mainnet|hard\s*fork|network\s*upgrade|protocol\s*upgrade)\b/i, confidence: 84 },
  { type: 'listing', pattern: /\b(listing|listed|goes\s+live|starts\s+trading)\b/i, confidence: 82 },
  { type: 'launch', pattern: /\b(launch|release|rollout|deploy(?:ment)?)\b/i, confidence: 76 },
  { type: 'integration', pattern: /\b(integration|partnership|collaboration)\b/i, confidence: 70 },
  { type: 'governance', pattern: /\b(governance\s+vote|proposal\s+pass(?:ed)?|snapshot)\b/i, confidence: 68 },
];

function getSourceQualityBoost(source) {
  const s = String(source || '').toLowerCase();
  if (!s) return 0;
  if (s.includes('kucoin')) return 10;
  if (s.includes('coindesk')) return 6;
  if (s.includes('cryptocompare') || s.includes('cryptopanic')) return 4;
  if (s.includes('reddit')) return -4;
  return 0;
}

function parseEventType(title) {
  const text = String(title || '');
  for (const row of MAJOR_EVENT_PATTERNS) {
    if (row.pattern.test(text)) {
      return { type: row.type, baseConfidence: row.confidence };
    }
  }
  return null;
}

function parseEventTimeMs(title) {
  const text = String(title || '');

  const isoLike = text.match(/\b(20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z|\s*UTC|\s*GMT)?)?)\b/i);
  if (isoLike?.[1]) {
    const normalized = isoLike[1].replace(/\s+(UTC|GMT)$/i, 'Z');
    const ts = Date.parse(normalized);
    if (Number.isFinite(ts)) return ts;
  }

  const monthLike = text.match(/\b(?:on\s+)?([A-Z][a-z]{2,8}\s+\d{1,2}(?:,\s*20\d{2})?(?:\s+\d{1,2}:\d{2}\s*(?:UTC|GMT))?)\b/);
  if (monthLike?.[1]) {
    const withYear = /20\d{2}/.test(monthLike[1])
      ? monthLike[1]
      : `${monthLike[1]}, ${new Date().getUTCFullYear()}`;
    const normalized = withYear.replace(/\s+(UTC|GMT)$/i, ' UTC');
    const ts = Date.parse(normalized);
    if (Number.isFinite(ts)) return ts;
  }

  return null;
}

function findMentionedPairs(headline, pairUniverse) {
  const title = String(headline || '').toUpperCase();
  const hits = [];

  pairUniverse.forEach((pair) => {
    const symbol = pair.replace('/USDT', '');
    if (symbol.length < 3) return;
    const bounded = new RegExp(`(^|[^A-Z0-9])\\$?${symbol}([^A-Z0-9]|$)`, 'i');
    if (bounded.test(title) || title.includes(`${symbol}/USDT`)) {
      hits.push(pair);
    }
  });

  return hits;
}

function buildEntryScore(entry) {
  const minutesToEvent = (entry.eventTimeMs - Date.now()) / 60000;
  const urgencyBonus = minutesToEvent > 0 ? Math.max(0, 18 - Math.min(18, minutesToEvent / 60)) : 0;
  return Number((entry.confidence + Math.min(20, entry.sourceCount * 6) + urgencyBonus).toFixed(2));
}

function getKnobs() {
  const risk = config.risk || {};
  return {
    enabled: risk.catalystEnabled !== false,
    cacheTtlSeconds: Math.max(60, Number(risk.catalystCacheTtlSeconds || 900)),
    newsLimit: Math.max(5, Number(risk.catalystNewsLimit || 30)),
    preEventMaxLeadMinutes: Math.max(30, Number(risk.catalystPreEventMaxLeadMinutes || 1440)),
    preEventMinLeadMinutes: Math.max(0, Number(risk.catalystPreEventMinLeadMinutes || 15)),
    minConfidence: Math.max(0, Math.min(100, Number(risk.catalystMinConfidence || 72))),
    minSourceCount: Math.max(1, Number(risk.catalystMinSourceCount || 2)),
  };
}

async function refreshKucoinCatalystCache(exchange) {
  const knobs = getKnobs();
  if (!knobs.enabled) {
    catalystCache.clear();
    return [];
  }

  const now = Date.now();
  if (now - lastRefreshAt < knobs.cacheTtlSeconds * 1000) {
    return getPrioritizedKucoinCatalystPairs();
  }

  const pairUniverse = new Set(
    (Array.isArray(exchange?.symbols) ? exchange.symbols : [])
      .filter((pair) => String(pair).endsWith('/USDT'))
  );
  if (!pairUniverse.size) return [];

  const headlines = await fetchCryptoNews('', knobs.newsLimit).catch(() => []);
  const nextMap = new Map();

  for (const item of headlines) {
    const title = String(item?.title || '').trim();
    if (!title) continue;

    const event = parseEventType(title);
    if (!event) continue;

    const eventTimeMs = parseEventTimeMs(title);
    if (!Number.isFinite(eventTimeMs)) continue;

    const minutesToEvent = (eventTimeMs - now) / 60000;
    if (minutesToEvent <= knobs.preEventMinLeadMinutes || minutesToEvent > knobs.preEventMaxLeadMinutes) {
      continue;
    }

    const pairs = findMentionedPairs(title, pairUniverse);
    if (!pairs.length) continue;

    for (const pair of pairs) {
      const key = pair;
      const existing = nextMap.get(key) || {
        pair,
        symbol: pair.replace('/USDT', ''),
        eventType: event.type,
        eventTimeMs,
        eventTimeIso: new Date(eventTimeMs).toISOString(),
        confidence: 0,
        sourceSet: new Set(),
        headlineSamples: [],
        firstSeenAt: new Date(now).toISOString(),
      };

      const sourceKey = `${String(item?.source || '').trim()}|${String(item?.url || '').trim()}`;
      existing.sourceSet.add(sourceKey);

      const confidence = Math.max(
        0,
        Math.min(100, event.baseConfidence + getSourceQualityBoost(item?.source) + (existing.sourceSet.size - 1) * 4)
      );
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.eventType = existing.eventType || event.type;
      existing.eventTimeMs = Math.min(existing.eventTimeMs, eventTimeMs);
      existing.eventTimeIso = new Date(existing.eventTimeMs).toISOString();

      if (existing.headlineSamples.length < 3) {
        existing.headlineSamples.push({
          title,
          source: item?.source || '',
          url: item?.url || '',
          publishedAt: item?.published_at || null,
        });
      }

      nextMap.set(key, existing);
    }
  }

  catalystCache.clear();
  nextMap.forEach((entry, key) => {
    const sourceCount = entry.sourceSet.size;
    if (entry.confidence < knobs.minConfidence || sourceCount < knobs.minSourceCount) {
      return;
    }

    const normalized = {
      pair: entry.pair,
      symbol: entry.symbol,
      eventType: entry.eventType,
      eventTimeMs: entry.eventTimeMs,
      eventTimeIso: entry.eventTimeIso,
      confidence: Number(entry.confidence.toFixed(2)),
      sourceCount,
      headlineSamples: entry.headlineSamples,
      firstSeenAt: entry.firstSeenAt,
      lastUpdatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + knobs.cacheTtlSeconds * 1000).toISOString(),
      score: 0,
    };
    normalized.score = buildEntryScore(normalized);
    catalystCache.set(key, normalized);
  });

  lastRefreshAt = now;

  if (catalystCache.size > 0) {
    logger.info(`KuCoin catalyst cache refreshed: ${catalystCache.size} candidate events`);
  }

  return getPrioritizedKucoinCatalystPairs();
}

function getPrioritizedKucoinCatalystPairs() {
  const now = Date.now();
  const knobs = getKnobs();

  const pairs = [];
  for (const [key, entry] of catalystCache.entries()) {
    const expires = Date.parse(entry.expiresAt || '');
    if (Number.isFinite(expires) && expires <= now) {
      catalystCache.delete(key);
      continue;
    }

    const minutesToEvent = (Number(entry.eventTimeMs || 0) - now) / 60000;
    if (minutesToEvent <= knobs.preEventMinLeadMinutes || minutesToEvent > knobs.preEventMaxLeadMinutes) {
      continue;
    }

    pairs.push({ pair: entry.pair, score: Number(entry.score || 0) });
  }

  return pairs.sort((a, b) => b.score - a.score).map((row) => row.pair);
}

function getKucoinCatalystForToken(tokenData) {
  const pair = String(tokenData?.address || '').toUpperCase();
  if (!pair.endsWith('/USDT')) return null;

  const row = catalystCache.get(pair);
  if (!row) return null;

  return {
    ...row,
    minutesToEvent: Number(((Number(row.eventTimeMs || 0) - Date.now()) / 60000).toFixed(2)),
  };
}

module.exports = {
  refreshKucoinCatalystCache,
  getPrioritizedKucoinCatalystPairs,
  getKucoinCatalystForToken,
};
