'use strict';

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config');
const logger = require('../utils/logger');
const { evaluateToken: evaluateWithClaude } = require('../brain/anthropic');
const { fetchCryptoNews } = require('../utils/news');

const VALID_SIGNALS = new Set(['BUY', 'HOLD', 'SELL']);

let groqClient = null;
let geminiClient = null;

// Per-model backoff: if a model returns 429, skip it until retryAfter expires
const modelBackoff = { groq: 0, gemini: 0 };

function parseRetryAfterMs(errMessage) {
  // Groq: "Please try again in 4m58.944s" or "in 2m50.208s" or "in 23.699s"
  const minSec = errMessage.match(/in (\d+)m([\d.]+)s/);
  if (minSec) return (parseInt(minSec[1], 10) * 60 + parseFloat(minSec[2])) * 1000;
  const secOnly = errMessage.match(/in ([\d.]+)s/);
  if (secOnly) return parseFloat(secOnly[1]) * 1000;
  return 5 * 60 * 1000; // default 5m if unparseable
}

function nextUtcMidnight() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// Daily call counters per model. Groq: 100K tokens/day free (~450 tok/call -> ~220 max).
// Gemini 2.0-flash: 200 req/day free. Both capped at 150 to leave a 25-30% buffer.
const dailyQuota = {
  groq: { limit: 150, count: 0, resetAt: nextUtcMidnight(), warnedExhausted: false },
  gemini: { limit: 150, count: 0, resetAt: nextUtcMidnight(), warnedExhausted: false },
};

function checkAndTickQuota(model) {
  const q = dailyQuota[model];
  if (!q) return true;
  if (Date.now() >= q.resetAt) {
    q.count = 0;
    q.resetAt = nextUtcMidnight();
    q.warnedExhausted = false;
    logger.info(`AI quota reset for ${model} (new UTC day)`);
  }
  if (q.count >= q.limit) {
    if (!q.warnedExhausted) {
      logger.warn(`AI daily quota exhausted for ${model} (${q.count}/${q.limit}). Skipping until UTC midnight.`);
      q.warnedExhausted = true;
    }
    return false;
  }
  q.count += 1;
  return true;
}

// Result cache: avoid re-evaluating the same symbol+strategy within 15 min.
const EVAL_CACHE_MS = 15 * 60 * 1000;
const evalResultCache = new Map();

function getEvalCacheKey(tokenData, strategyName) {
  const sym = String(tokenData.symbol || tokenData.address || 'unknown').toUpperCase();
  return `${sym}:${String(strategyName || 'momentum').toLowerCase()}`;
}

function getCachedEvalResult(tokenData, strategyName) {
  const key = getEvalCacheKey(tokenData, strategyName);
  const entry = evalResultCache.get(key);
  if (!entry || Date.now() >= entry.expiresAt) return null;
  return entry.result;
}

function setCachedEvalResult(tokenData, strategyName, result) {
  if (!result) return;
  const key = getEvalCacheKey(tokenData, strategyName);
  evalResultCache.set(key, { result, expiresAt: Date.now() + EVAL_CACHE_MS });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

function parseSignalPayload(payloadText) {
  const rawJson = extractJsonObject(payloadText);
  if (!rawJson) return null;

  try {
    const parsed = JSON.parse(rawJson);
    const signal = String(parsed.signal || '').toUpperCase();
    if (!VALID_SIGNALS.has(signal)) return null;

    return {
      signal,
      confidence: clamp(Number(parsed.confidence || 0), 0, 100),
      reason: String(parsed.reason || '').trim(),
      narrativeStrength: clamp(Number(parsed.narrativeStrength || 0), 0, 100),
      riskFlags: Array.isArray(parsed.riskFlags)
        ? parsed.riskFlags.map((item) => String(item))
        : [],
    };
  } catch (error) {
    return null;
  }
}

function buildWalletClusteringContext(tokenData, technicalDetails) {
  const topHoldersPct = Number(tokenData.topHoldersPct || 0);
  const holderCount = Number(tokenData.holderCount || 0);
  const uniqueBuyers10m = Number(technicalDetails.uniqueBuyers10m || tokenData.uniqueBuyers10m || 0);
  const buyerToHolderRatioPct = holderCount > 0 ? (uniqueBuyers10m / holderCount) * 100 : null;

  let clusterRiskScore = 0;
  if (topHoldersPct >= 80) clusterRiskScore += 60;
  else if (topHoldersPct >= 65) clusterRiskScore += 40;
  else if (topHoldersPct >= 50) clusterRiskScore += 20;
  if (holderCount > 0 && holderCount < 150) clusterRiskScore += 20;
  if (uniqueBuyers10m > 0 && uniqueBuyers10m < 15) clusterRiskScore += 20;
  if (Number.isFinite(buyerToHolderRatioPct) && buyerToHolderRatioPct < 5) clusterRiskScore += 10;
  clusterRiskScore = clamp(clusterRiskScore, 0, 100);

  return {
    holderCount,
    uniqueBuyers10m,
    topHoldersPct,
    buyerToHolderRatioPct: Number.isFinite(buyerToHolderRatioPct) ? Number(buyerToHolderRatioPct.toFixed(2)) : null,
    clusterRiskScore,
    clusterRiskLabel: clusterRiskScore >= 70 ? 'high' : (clusterRiskScore >= 40 ? 'medium' : 'low'),
  };
}

function buildEnsemblePrompt(tokenData, technicalDetails, headlines) {
  const strategyName = String(technicalDetails.strategy || 'momentum');
  const confidenceFloor = Number(technicalDetails.confidenceFloor || 0);
  const context = {
    symbol: tokenData.symbol,
    chain: tokenData.chain,
    strategy: strategyName,
    confidenceFloor,
    priceChange24h: tokenData.priceChange24h,
    liquidityUsd: tokenData.liquidityUsd,
    volume24h: tokenData.volume24h,
    topHoldersPct: tokenData.topHoldersPct,
    listingAgeHours: tokenData.listingAgeDays ? tokenData.listingAgeDays * 24 : null,
    technicalSignal: technicalDetails.signal || 'HOLD',
    rsi: technicalDetails.rsi || null,
    volumeSpike: technicalDetails.volumeSpike || null,
    breakoutConfirmed: Boolean(technicalDetails.breakoutConfirmed),
    netBuyFlowUsd10m: technicalDetails.netBuyFlowUsd10m || null,
    walletClustering: buildWalletClusteringContext(tokenData, technicalDetails),
  };

  return [
    'You are a crypto market reviewer. Respond in minified JSON only.',
    'Schema: {"signal":"BUY|HOLD|SELL","confidence":0-100,"narrativeStrength":0-100,"reason":"<=180 chars","riskFlags":["..."]}',
    `Strategy profile: ${strategyName} (${strategyName === 'swing' ? 'longer-term established token swing setup' : 'short-term new-launch momentum setup'})`,
    'Use the headlines for narrative strength scoring. Be conservative when uncertain.',
    `Context: ${JSON.stringify(context)}`,
    `Headlines: ${JSON.stringify(headlines)}`,
  ].join('\n');
}

async function evaluateWithGroq(tokenData, technicalDetails, headlines) {
  if (!config.groq.apiKey) return null;
  if (Date.now() < modelBackoff.groq) return null;
  if (!checkAndTickQuota('groq')) return null;

  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey: config.groq.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

  try {
    const response = await groqClient.chat.completions.create({
      model: config.groq.model,
      temperature: 0.2,
      max_tokens: 180,
      messages: [
        { role: 'system', content: 'Return only JSON.' },
        { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
      ],
    }, {
      timeout: 12000,
    });

    const text = response?.choices?.[0]?.message?.content || '';
    const parsed = parseSignalPayload(text);
    return parsed ? { ...parsed, source: 'groq', model: config.groq.model } : null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.groq = Date.now() + backoffMs;
      logger.warn(`Groq rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      logger.warn(`Groq eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithGemini(tokenData, technicalDetails, headlines) {
  if (!config.gemini.apiKey) return null;
  if (Date.now() < modelBackoff.gemini) return null;
  if (!checkAndTickQuota('gemini')) return null;

  const model = config.gemini.model;

  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }

  const generativeModel = geminiClient.getGenerativeModel({ model });
  try {
    const result = await generativeModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{ text: buildEnsemblePrompt(tokenData, technicalDetails, headlines) }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 220,
      },
    });

    const text = result?.response?.text ? result.response.text() : '';
    const parsed = parseSignalPayload(text);
    return parsed ? { ...parsed, source: 'gemini', model } : null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|Too Many Requests|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.gemini = Date.now() + backoffMs;
      logger.warn(`Gemini rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      logger.warn(`Gemini eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

function applyBuyGuards(baseResult, technicalDetails) {
  if (!baseResult) return null;

  const final = {
    ...baseResult,
    riskFlags: Array.isArray(baseResult.riskFlags) ? [...new Set(baseResult.riskFlags)] : [],
  };

  if (final.signal === 'BUY' && String(technicalDetails.signal || '').toUpperCase() !== 'BUY') {
    final.signal = 'HOLD';
    final.confidence = Math.min(Number(final.confidence || 0), 60);
    final.reason = 'AI gate: technical signal not BUY';
    final.riskFlags = [...new Set([...(final.riskFlags || []), 'technical_gate'])];
  }

  const hasNarrativeStrength = Number.isFinite(Number(final.narrativeStrength));
  if (
    final.signal === 'BUY'
    && hasNarrativeStrength
    && Number(final.narrativeStrength) < Number(config.ai.narrativeMinScore || 65)
  ) {
    final.signal = 'HOLD';
    final.confidence = Math.min(Number(final.confidence || 0), 55);
    final.reason = `Narrative score ${final.narrativeStrength} below threshold ${config.ai.narrativeMinScore}`;
    final.riskFlags = [...new Set([...(final.riskFlags || []), 'narrative_gate'])];
  }

  return final;
}

async function evaluateToken(tokenData, technicalDetails) {
  const startedAt = Date.now();
  const strategyName = technicalDetails.strategy || 'momentum';
  const cachedResult = getCachedEvalResult(tokenData, strategyName);

  if (cachedResult) {
    logger.debug(`AI fallback cache hit for ${tokenData.symbol} [${strategyName}]`);
    return { ...cachedResult, fromCache: true };
  }

  let headlinesPromise = null;
  const getHeadlines = async () => {
    if (!headlinesPromise) {
      headlinesPromise = fetchCryptoNews(tokenData.symbol || '', 8)
        .then((items) => items.map((n) => n.title).filter(Boolean).slice(0, 8))
        .catch(() => []);
    }
    return headlinesPromise;
  };

  const providers = [
    {
      key: 'claude',
      run: async () => {
        const result = await evaluateWithClaude(tokenData, technicalDetails);
        return result ? { ...result, source: result.source || 'claude', model: result.model || 'anthropic' } : null;
      },
    },
    {
      key: 'groq',
      run: async () => {
        const result = await evaluateWithGroq(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
      },
    },
    {
      key: 'gemini',
      run: async () => {
        const result = await evaluateWithGemini(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
      },
    },
  ];

  const failedProviders = [];
  for (const provider of providers) {
    const result = await provider.run();
    if (!result) {
      failedProviders.push(provider.key);
      continue;
    }

    const final = applyBuyGuards({
      ...result,
      latencyMs: Date.now() - startedAt,
      failedProviders: [...failedProviders],
      fallbackChain: [...failedProviders, provider.key],
    }, technicalDetails);

    if (failedProviders.length > 0) {
      logger.warn(
        `AI fallback ${tokenData.symbol} [${strategyName}]: ` +
        `used=${provider.key} after=${failedProviders.join('->')} final=${final.signal}`,
      );
    } else {
      logger.debug(`AI validation ${tokenData.symbol} [${strategyName}]: used=${provider.key} final=${final.signal}`);
    }

    setCachedEvalResult(tokenData, strategyName, final);
    return final;
  }

  logger.warn(`AI fallback chain failed for ${tokenData.symbol} [${strategyName}]`);
  return null;
}

module.exports = {
  evaluateToken,
  getQuotaStats: () => ({
    groq: { count: dailyQuota.groq.count, limit: dailyQuota.groq.limit, resetsAt: new Date(dailyQuota.groq.resetAt).toISOString() },
    gemini: { count: dailyQuota.gemini.count, limit: dailyQuota.gemini.limit, resetsAt: new Date(dailyQuota.gemini.resetAt).toISOString() },
    evalCacheSize: evalResultCache.size,
    backoffUntil: {
      groq: modelBackoff.groq > Date.now() ? new Date(modelBackoff.groq).toISOString() : null,
      gemini: modelBackoff.gemini > Date.now() ? new Date(modelBackoff.gemini).toISOString() : null,
    },
  }),
};
