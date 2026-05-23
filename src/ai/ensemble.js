'use strict';

const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { evaluateToken: evaluateWithClaude } = require('../utils/anthropic');
const { fetchCryptoNews } = require('../utils/news');
const { trackAi } = require('./decision-tracker');

// Shared wrapper for ensemble provider calls. Captures latency/tokens/cost/signal
// into dbo.ai_decisions while preserving each provider's outer try/catch
// (rate-limit backoff). Tracker re-throws on API failure so backoff logic still fires.
function trackedEnsembleCall(meta, fn) {
  return trackAi(
    {
      ...meta,
      purpose: meta.purpose || 'ensemble_signal',
      scope: String(process.env.BOT_PROFILE || 'global').toLowerCase(),
      botVersion: process.env.BOT_VERSION || null,
    },
    fn,
    { getPool: () => require('../utils/sqlServer').getPool(logger).catch(() => null), logger },
  );
}

const VALID_SIGNALS = new Set(['BUY', 'HOLD', 'SELL']);

let groqClient = null;
let geminiClient = null;
let sambannovaClient = null;
let togetherClient = null;

// Per-model backoff: if a model returns 429, skip it until retryAfter expires
const modelBackoff = { groq: 0, gemini: 0, nvidia: 0, cerebras: 0, openrouter: 0, sambanova: 0, together: 0 };

// Per-provider consecutive failure tracking (B.3). Rate-limit and model-unavailable
// errors already trigger their own backoff and are NOT counted here. Only true API
// exceptions and parse-null count toward auto-disable.
const MAX_CONSECUTIVE_FAILS = 3;
const PROVIDER_FAIL_BACKOFF_MS = 10 * 60 * 1000;
const providerFailures = { groq: 0, gemini: 0, nvidia: 0, cerebras: 0, openrouter: 0, sambanova: 0, together: 0 };

function noteProviderSuccess(name) {
  if (providerFailures[name] > 0) {
    logger.info(`AI provider ${name} recovered after ${providerFailures[name]} consecutive fails`);
    providerFailures[name] = 0;
  }
}

function noteProviderFailure(name) {
  providerFailures[name] = (providerFailures[name] || 0) + 1;
  if (providerFailures[name] >= MAX_CONSECUTIVE_FAILS) {
    modelBackoff[name] = Date.now() + PROVIDER_FAIL_BACKOFF_MS;
    logger.warn(`AI provider ${name} auto-disabled for ${PROVIDER_FAIL_BACKOFF_MS / 60000}m after ${providerFailures[name]} consecutive non-rate-limit fails`);
    providerFailures[name] = 0;
  }
}

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

// 2026-05-23 W16.5: optional DB-driven template loader. When dbo.ai_prompts has
// an active row for 'ensemble_signal', use that. Otherwise fall back to inline
// builder below. Cached + safe — never throws. Sync peek + background prefetch
// keeps the call site synchronous (no async refactor of provider call paths).
const { getCachedPrompt: _getCachedPrompt, renderTemplate: _renderTemplate, prefetch: _prefetchPrompt } = require('./prompt-loader');
const ENSEMBLE_PROMPT_NAME = 'ensemble_signal';

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
    higherTimeframePatternBias: technicalDetails.patternAnalysis?.bias || null,
    higherTimeframePatterns: Array.isArray(technicalDetails.patternAnalysis?.detectedPatterns)
      ? technicalDetails.patternAnalysis.detectedPatterns.slice(0, 4)
      : [],
    supportResistance: technicalDetails.patternAnalysis?.supportResistance || null,
    divergenceChecks: technicalDetails.patternAnalysis?.divergenceChecks || null,
    operatorKnowledge: Array.isArray(technicalDetails.operatorKnowledge)
      ? technicalDetails.operatorKnowledge.slice(0, 8)
      : [],
    walletClustering: buildWalletClusteringContext(tokenData, technicalDetails),
  };

  const strategyKey = String(strategyName || '').toLowerCase();
  const longerTermProfile = strategyKey.includes('backes') || strategyKey.includes('swing');

  // W16.5: prefer DB template when active row is cached. Background-prefetch
  // when miss/stale so the next call has it. Falls back to inline string below.
  const scope = String(process.env.BOT_PROFILE || 'global').toLowerCase();
  const cachedRow = _getCachedPrompt(ENSEMBLE_PROMPT_NAME, { scope });
  if (cachedRow === undefined) {
    _prefetchPrompt(ENSEMBLE_PROMPT_NAME, { scope });
  } else if (cachedRow && cachedRow.template) {
    return _renderTemplate(cachedRow.template, {
      strategy: strategyName,
      symbol: tokenData.symbol,
      chain: tokenData.chain,
      longer_term: longerTermProfile ? 'longer-term established token setup' : 'short-term new-launch momentum setup',
      context_json: JSON.stringify(context),
      headlines_json: JSON.stringify(headlines),
    });
  }

  return [
    'You are a crypto market reviewer. Respond in minified JSON only.',
    'Schema: {"signal":"BUY|HOLD|SELL","confidence":0-100,"narrativeStrength":0-100,"reason":"<=180 chars","riskFlags":["..."]}',
    `Strategy profile: ${strategyName} (${longerTermProfile ? 'longer-term established token setup' : 'short-term new-launch momentum setup'})`,
    'Use the headlines for narrative strength scoring. Be conservative when uncertain.',
    'When higher-timeframe pattern context is present, prefer 4H/1D pattern confirmation only for established liquid tokens and never overrule clear bearish reversal evidence without strong support.',
    `Context: ${JSON.stringify(context)}`,
    `Headlines: ${JSON.stringify(headlines)}`,
  ].join('\n');
}

async function evaluateWithGroq(tokenData, technicalDetails, headlines) {
  if (config.groq?.enabled === false || !config.groq.apiKey) return null;
  if (Date.now() < modelBackoff.groq) return null;
  if (!checkAndTickQuota('groq')) return null;
  const configuredModel = String(config.groq.model || '').trim();
  const model = /deepseek-r1-distill-llama-70b/i.test(configuredModel)
    ? 'llama-3.3-70b-versatile'
    : configuredModel;

  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey: config.groq.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'groq', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'groq_ensemble', promptVersion: 1 },
      async () => {
        const response = await groqClient.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 180,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, { timeout: 12000 });
        const text = response?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response?.usage?.prompt_tokens,
          responseTokens: response?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('groq');
      return { ...wrapped._parsed, source: 'groq', model };
    }
    noteProviderFailure('groq');
    return null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    const isModelUnavailable = /decommissioned|no longer supported|model.*not found|invalid model/i.test(err.message || '');
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.groq = Date.now() + backoffMs;
      logger.warn(`Groq rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else if (isModelUnavailable) {
      modelBackoff.groq = Date.now() + (6 * 60 * 60 * 1000);
      logger.warn(`Groq model unavailable (${model}); backing off 21600s. Set GROQ_MODEL to a supported model.`);
    } else {
      noteProviderFailure('groq');
      logger.warn(`Groq eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithGemini(tokenData, technicalDetails, headlines) {
  if (config.gemini?.enabled === false || !config.gemini.apiKey) return null;
  if (Date.now() < modelBackoff.gemini) return null;
  if (!checkAndTickQuota('gemini')) return null;

  const model = config.gemini.model;

  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }

  const generativeModel = geminiClient.getGenerativeModel({ model });
  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'gemini', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'gemini_ensemble', promptVersion: 1 },
      async () => {
        const result = await generativeModel.generateContent({
          contents: [
            {
              role: 'user',
              parts: [{ text: buildEnsemblePrompt(tokenData, technicalDetails, headlines) }],
            },
          ],
          generationConfig: { temperature: 0.2, maxOutputTokens: 220 },
        });
        const text = result?.response?.text ? result.response.text() : '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: result?.response?.usageMetadata?.promptTokenCount,
          responseTokens: result?.response?.usageMetadata?.candidatesTokenCount,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('gemini');
      return { ...wrapped._parsed, source: 'gemini', model };
    }
    noteProviderFailure('gemini');
    return null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|Too Many Requests|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.gemini = Date.now() + backoffMs;
      logger.warn(`Gemini rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      noteProviderFailure('gemini');
      logger.warn(`Gemini eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithNvidia(tokenData, technicalDetails, headlines) {
  if (config.nvidia?.enabled === false) return null;
  const apiKey = config.nvidia?.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  if (Date.now() < modelBackoff.nvidia) return null;

  const model = config.nvidia?.model || 'deepseek-ai/deepseek-v4-pro';
  const apiUrl = config.nvidia?.apiUrl || 'https://integrate.api.nvidia.com/v1/chat/completions';

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'nvidia', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'nvidia_ensemble', promptVersion: 1 },
      async () => {
        const response = await axios.post(apiUrl, {
          model,
          temperature: 0.2,
          max_tokens: 220,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 });
        const text = response.data?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response.data?.usage?.prompt_tokens,
          responseTokens: response.data?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('nvidia');
      return { ...wrapped._parsed, source: 'nvidia', model };
    }
    noteProviderFailure('nvidia');
    return null;
  } catch (err) {
    const isRateLimit = err.response?.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      modelBackoff.nvidia = Date.now() + 5 * 60 * 1000;
      logger.warn(`NVIDIA rate-limited for ${tokenData.symbol}, backing off 5m`);
    } else {
      noteProviderFailure('nvidia');
      logger.warn(`NVIDIA eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithCerebras(tokenData, technicalDetails, headlines) {
  if (config.cerebras?.enabled === false || !config.cerebras?.apiKey) return null;
  if (Date.now() < modelBackoff.cerebras) return null;

  const model = config.cerebras.model || 'llama-3.3-70b';
  const apiUrl = config.cerebras.apiUrl || 'https://api.cerebras.ai/v1/chat/completions';

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'cerebras', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'cerebras_ensemble', promptVersion: 1 },
      async () => {
        const response = await axios.post(apiUrl, {
          model,
          temperature: 0.2,
          max_tokens: 220,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, { headers: { Authorization: `Bearer ${config.cerebras.apiKey}`, 'Content-Type': 'application/json' }, timeout: 12000 });
        const text = response.data?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response.data?.usage?.prompt_tokens,
          responseTokens: response.data?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('cerebras');
      return { ...wrapped._parsed, source: 'cerebras', model };
    }
    noteProviderFailure('cerebras');
    return null;
  } catch (err) {
    const isRateLimit = err.response?.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.cerebras = Date.now() + backoffMs;
      logger.warn(`Cerebras rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      noteProviderFailure('cerebras');
      logger.warn(`Cerebras eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithOpenRouter(tokenData, technicalDetails, headlines) {
  if (config.openrouter?.enabled === false || !config.openrouter?.apiKey) return null;
  if (Date.now() < modelBackoff.openrouter) return null;

  const model = config.openrouter.model || 'meta-llama/llama-3.3-70b-instruct:free';
  const apiUrl = config.openrouter.apiUrl || 'https://openrouter.ai/api/v1/chat/completions';

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'openrouter', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'openrouter_ensemble', promptVersion: 1 },
      async () => {
        const response = await axios.post(apiUrl, {
          model,
          temperature: 0.2,
          max_tokens: 220,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, {
          headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': config.openrouter.siteUrl || '',
            'X-Title': config.openrouter.siteName || 'dex-trading-bot',
          },
          timeout: 20000,
        });
        const text = response.data?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response.data?.usage?.prompt_tokens,
          responseTokens: response.data?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('openrouter');
      return { ...wrapped._parsed, source: 'openrouter', model };
    }
    noteProviderFailure('openrouter');
    return null;
  } catch (err) {
    const isRateLimit = err.response?.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      modelBackoff.openrouter = Date.now() + 5 * 60 * 1000;
      logger.warn(`OpenRouter rate-limited for ${tokenData.symbol}, backing off 5m`);
    } else {
      noteProviderFailure('openrouter');
      logger.warn(`OpenRouter eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithSambanova(tokenData, technicalDetails, headlines) {
  if (config.sambanova?.enabled === false || !config.sambanova?.apiKey) return null;
  if (Date.now() < modelBackoff.sambanova) return null;

  const model = config.sambanova.model || 'Meta-Llama-3.3-70B-Instruct';

  if (!sambannovaClient) {
    sambannovaClient = new OpenAI({
      apiKey: config.sambanova.apiKey,
      baseURL: 'https://api.sambanova.ai/v1',
    });
  }

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'sambanova', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'sambanova_ensemble', promptVersion: 1 },
      async () => {
        const response = await sambannovaClient.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 220,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, { timeout: 15000 });
        const text = response?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response?.usage?.prompt_tokens,
          responseTokens: response?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('sambanova');
      return { ...wrapped._parsed, source: 'sambanova', model };
    }
    noteProviderFailure('sambanova');
    return null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.sambanova = Date.now() + backoffMs;
      logger.warn(`SambaNova rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      noteProviderFailure('sambanova');
      logger.warn(`SambaNova eval failed for ${tokenData.symbol}: ${err.message}`);
    }
    return null;
  }
}

async function evaluateWithTogether(tokenData, technicalDetails, headlines) {
  if (config.together?.enabled === false || !config.together?.apiKey) return null;
  if (Date.now() < modelBackoff.together) return null;

  const model = config.together.model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

  if (!togetherClient) {
    togetherClient = new OpenAI({
      apiKey: config.together.apiKey,
      baseURL: 'https://api.together.xyz/v1',
    });
  }

  try {
    const wrapped = await trackedEnsembleCall(
      { provider: 'together', model, symbol: tokenData?.symbol, chain: tokenData?.chain, promptName: 'together_ensemble', promptVersion: 1 },
      async () => {
        const response = await togetherClient.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 220,
          messages: [
            { role: 'system', content: 'Return only JSON.' },
            { role: 'user', content: buildEnsemblePrompt(tokenData, technicalDetails, headlines) },
          ],
        }, { timeout: 15000 });
        const text = response?.choices?.[0]?.message?.content || '';
        const parsed = parseSignalPayload(text);
        return {
          signal: parsed?.signal || null,
          confidence: parsed?.confidence,
          requestTokens: response?.usage?.prompt_tokens,
          responseTokens: response?.usage?.completion_tokens,
          responseExcerpt: text,
          _parsed: parsed,
        };
      },
    );
    if (wrapped._parsed) {
      noteProviderSuccess('together');
      return { ...wrapped._parsed, source: 'together', model };
    }
    noteProviderFailure('together');
    return null;
  } catch (err) {
    const isRateLimit = err.status === 429 || /429|rate.?limit|quota/i.test(err.message);
    if (isRateLimit) {
      const backoffMs = parseRetryAfterMs(err.message);
      modelBackoff.together = Date.now() + backoffMs;
      logger.warn(`Together AI rate-limited for ${tokenData.symbol}, backing off ${Math.round(backoffMs / 1000)}s`);
    } else {
      noteProviderFailure('together');
      logger.warn(`Together AI eval failed for ${tokenData.symbol}: ${err.message}`);
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
      key: 'cerebras',
      run: async () => {
        const result = await evaluateWithCerebras(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
      },
    },
    {
      key: 'nvidia',
      run: async () => {
        const result = await evaluateWithNvidia(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
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
    {
      key: 'openrouter',
      run: async () => {
        const result = await evaluateWithOpenRouter(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
      },
    },
    {
      key: 'sambanova',
      run: async () => {
        const result = await evaluateWithSambanova(tokenData, technicalDetails, await getHeadlines());
        return result
          ? { ...result, riskFlags: [...new Set([...(result.riskFlags || []), 'fallback_provider'])] }
          : null;
      },
    },
    {
      key: 'together',
      run: async () => {
        const result = await evaluateWithTogether(tokenData, technicalDetails, await getHeadlines());
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

function hasAnyEnabledProvider() {
  // True if at least one AI provider has enabled=true AND an apiKey.
  // Anthropic uses opt-in (=== 'true'); others default-on unless *_ENABLED=false.
  const checks = [
    !!(config.anthropic?.enabled && config.anthropic?.apiKey),
    !!(config.groq?.enabled && config.groq?.apiKey),
    !!(config.gemini?.enabled && config.gemini?.apiKey),
    !!(config.nvidia?.enabled && (config.nvidia?.apiKey || process.env.NVIDIA_API_KEY)),
    !!(config.cerebras?.enabled && (config.cerebras?.apiKey || process.env.CEREBRAS_API_KEY)),
    !!(config.openrouter?.enabled && (config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY)),
    !!(config.sambanova?.enabled && (config.sambanova?.apiKey || process.env.SAMBANOVA_API_KEY)),
    !!(config.together?.enabled && (config.together?.apiKey || process.env.TOGETHER_API_KEY)),
  ];
  return checks.some(Boolean);
}

function getProviderHealth() {
  const now = Date.now();
  const out = {};
  for (const name of Object.keys(modelBackoff)) {
    out[name] = {
      consecutiveFailures: providerFailures[name] || 0,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILS,
      backoffUntil: modelBackoff[name] > now ? new Date(modelBackoff[name]).toISOString() : null,
      backoffSecondsRemaining: modelBackoff[name] > now ? Math.ceil((modelBackoff[name] - now) / 1000) : 0,
      autoDisableBackoffMinutes: PROVIDER_FAIL_BACKOFF_MS / 60000,
    };
  }
  return out;
}

module.exports = {
  evaluateToken,
  hasAnyEnabledProvider,
  getProviderHealth,
  getQuotaStats: () => ({
    groq: { count: dailyQuota.groq.count, limit: dailyQuota.groq.limit, resetsAt: new Date(dailyQuota.groq.resetAt).toISOString() },
    gemini: { count: dailyQuota.gemini.count, limit: dailyQuota.gemini.limit, resetsAt: new Date(dailyQuota.gemini.resetAt).toISOString() },
    evalCacheSize: evalResultCache.size,
    backoffUntil: {
      groq: modelBackoff.groq > Date.now() ? new Date(modelBackoff.groq).toISOString() : null,
      gemini: modelBackoff.gemini > Date.now() ? new Date(modelBackoff.gemini).toISOString() : null,
    },
    providerHealth: getProviderHealth(),
  }),
};
