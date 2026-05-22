'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { trackAi } = require('../ai/decision-tracker');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
let anthropicBackoffUntil = 0;
const VALID_SIGNALS = new Set(['BUY', 'HOLD', 'SELL']);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractTextContent(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return '';
  }

  return contentBlocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function parseAiResponse(text) {
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    const signal = String(parsed.signal || '').toUpperCase();
    if (!VALID_SIGNALS.has(signal)) {
      return null;
    }

    return {
      signal,
      confidence: clamp(Number(parsed.confidence || 0), 0, 100),
      reason: String(parsed.reason || '').trim(),
      riskFlags: Array.isArray(parsed.riskFlags)
        ? parsed.riskFlags.map((item) => String(item))
        : [],
    };
  } catch (error) {
    const fallbackSignal = text.split(/[\s,:]+/)[0].toUpperCase();
    if (!VALID_SIGNALS.has(fallbackSignal)) {
      return null;
    }

    return {
      signal: fallbackSignal,
      confidence: 0,
      reason: text.trim(),
      riskFlags: [],
    };
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

function buildPrompt(tokenData, technicalDetails) {
  // Compose dynamic market context
  const context = {
    symbol: tokenData.symbol,
    address: tokenData.address,
    chain: tokenData.chain,
    price: tokenData.price,
    liquidityUsd: tokenData.liquidityUsd,
    volume24h: tokenData.volume24h,
    priceChange24h: tokenData.priceChange24h,
    tvl: tokenData.tvl || null,
    topHoldersPct: tokenData.topHoldersPct || null,
    sentimentUpPct: tokenData.sentimentUpPct || null,
    sentimentDownPct: tokenData.sentimentDownPct || null,
    communityScore: tokenData.communityScore || null,
    developerScore: tokenData.developerScore || null,
    publicInterestScore: tokenData.publicInterestScore || null,
    volatility: technicalDetails.volatility || null,
    listingAgeHours: tokenData.listingAgeDays ? tokenData.listingAgeDays * 24 : null,
    buyTax: tokenData.buyTax || null,
    sellTax: tokenData.sellTax || null,
    isHoneypot: Boolean(tokenData.isHoneypot),
    mlPriceAnomaly: technicalDetails.ml?.priceAnomaly || false,
    mlVolumeAnomaly: technicalDetails.ml?.volumeAnomaly || false,
    mlMASignal: technicalDetails.ml?.maSignal || 0,
    marketRegime: technicalDetails.marketRegime || null,
    dynamicVolumeSpikeMultiplier: technicalDetails.dynamicVolumeSpikeMultiplier || null,
    operatorKnowledge: Array.isArray(technicalDetails.operatorKnowledge)
      ? technicalDetails.operatorKnowledge.slice(0, 8)
      : [],
    walletClustering: buildWalletClusteringContext(tokenData, technicalDetails),
  };
  const technical = {
    signal: technicalDetails.signal || 'HOLD',
    fastEma: technicalDetails.fastEma || null,
    slowEma: technicalDetails.slowEma || null,
    rsi: technicalDetails.rsi || null,
    volumeSpike: technicalDetails.volumeSpike || null,
    emaCrossUp: Boolean(technicalDetails.emaCrossUp),
    emaCrossDown: Boolean(technicalDetails.emaCrossDown),
  };
  return [
    'You are a strict risk-first decision engine for an automated crypto trading bot.',
    'Output MUST be valid minified JSON only. No markdown, no prose outside JSON.',
    'Schema: {"signal":"BUY|HOLD|SELL","confidence":0-100,"reason":"<=160 chars","riskFlags":["comma-separated concise flags"]}',
    'Decision policy:',
    '1) Prioritize capital preservation over trade frequency.',
    '2) If data quality is weak, output HOLD.',
    '3) If listingAgeHours < 6, concentration is high, or anomalies are present, bias to HOLD unless setup is exceptional.',
    '4) Use SELL only for clear deterioration/overbought reversal signals.',
    '5) Confidence must reflect uncertainty and be conservative on volatile/new tokens.',
    'Market context:',
    JSON.stringify(context),
    'Technical indicators:',
    JSON.stringify(technical),
  ].join('\n');
}

function applySafetyOverrides(tokenData, technicalDetails, aiResult) {
  const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
  const topHoldersPct = Number(tokenData.topHoldersPct || 0);
  const hasAnomaly = Boolean(technicalDetails.ml?.priceAnomaly || technicalDetails.ml?.volumeAnomaly);

  if (aiResult.signal === 'BUY') {
    if (Boolean(tokenData.isHoneypot) || topHoldersPct >= 80 || hasAnomaly) {
      return {
        ...aiResult,
        signal: 'HOLD',
        confidence: Math.min(aiResult.confidence, 35),
        reason: 'Risk override: anomaly, concentration, or honeypot risk',
        riskFlags: [...new Set([...(aiResult.riskFlags || []), 'risk_override'])],
      };
    }

    if (listingAgeHours > 0 && listingAgeHours < 6) {
      return {
        ...aiResult,
        confidence: Math.min(aiResult.confidence, 55),
        riskFlags: [...new Set([...(aiResult.riskFlags || []), 'new_launch'])],
      };
    }
  }

  return aiResult;
}

async function evaluateToken(tokenData, technicalDetails) {
  if (!config.anthropic?.enabled || !config.anthropic?.apiKey) {
    return null;
  }
  if (Date.now() < anthropicBackoffUntil) {
    return null;
  }

  const startedAt = Date.now();

  try {
    let parsedRef = null;
    let rawText = '';
    let modelUsed = null;
    let usage = null;

    const wrappedResult = await trackAi(
      {
        provider: 'anthropic',
        model: config.anthropic.model || 'claude-3-5-haiku-20241022',
        purpose: 'trade_signal',
        symbol: tokenData?.symbol,
        chain: tokenData?.chain,
        scope: String(process.env.BOT_PROFILE || 'global').toLowerCase(),
        strategy: tokenData?.strategy || null,
        promptName: 'anthropic_trade_signal',
        promptVersion: 1,
        botVersion: process.env.BOT_VERSION || null,
      },
      async () => {
        const response = await axios.post(
          ANTHROPIC_URL,
          {
            model: config.anthropic.model || 'claude-3-5-haiku-20241022',
            max_tokens: 180,
            temperature: Number(config.anthropic.temperature || 0.2),
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: buildPrompt(tokenData, technicalDetails),
                  },
                ],
              },
            ],
          },
          {
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.anthropic.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            timeout: 20000,
          }
        );
        rawText = extractTextContent(response.data?.content);
        parsedRef = parseAiResponse(rawText);
        modelUsed = response.data?.model || config.anthropic.model;
        usage = response.data?.usage || null;
        return {
          signal: parsedRef?.signal || null,
          confidence: parsedRef?.confidence,
          requestTokens: usage?.input_tokens,
          responseTokens: usage?.output_tokens,
          responseExcerpt: rawText,
        };
      },
      { getPool: () => require('../utils/sqlServer').getPool(logger).catch(() => null), logger },
    );

    if (!parsedRef) {
      logger.warn(`Anthropic response could not be parsed into a signal: ${rawText}`);
      return null;
    }

    return applySafetyOverrides(tokenData, technicalDetails, {
      ...parsedRef,
      model: modelUsed,
      latencyMs: Date.now() - startedAt,
      usage,
      raw: rawText,
    });
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : (err.message || 'unknown error');
    const status = Number(err.response?.status || 0);
    const lowBalance = /credit balance is too low|insufficient|billing|payment required/i.test(details);
    const authIssue = status === 401 || status === 403;
    const rateLimited = status === 429 || /rate.?limit|too many requests|quota/i.test(details);

    if (lowBalance) {
      anthropicBackoffUntil = Date.now() + (6 * 60 * 60 * 1000);
      logger.warn('Anthropic disabled for 21600s due to low/invalid credits.');
    } else if (authIssue) {
      anthropicBackoffUntil = Date.now() + (30 * 60 * 1000);
      logger.warn('Anthropic disabled for 1800s due to auth error (401/403).');
    } else if (rateLimited) {
      anthropicBackoffUntil = Date.now() + (5 * 60 * 1000);
      logger.warn('Anthropic rate-limited; backing off 300s.');
    } else {
      logger.warn(`Anthropic evaluation failed: ${details}`);
    }
    return null;
  }
}

function getBackoffStatus() {
  const now = Date.now();
  return {
    backoffUntil: anthropicBackoffUntil > now ? new Date(anthropicBackoffUntil).toISOString() : null,
    backoffSecondsRemaining: anthropicBackoffUntil > now ? Math.ceil((anthropicBackoffUntil - now) / 1000) : 0,
  };
}

module.exports = { evaluateToken, getBackoffStatus };
