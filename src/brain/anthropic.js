'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
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

  const startedAt = Date.now();

  try {
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

    const text = extractTextContent(response.data?.content);
    const parsed = parseAiResponse(text);

    if (!parsed) {
      logger.warn(`Anthropic response could not be parsed into a signal: ${text}`);
      return null;
    }

    return applySafetyOverrides(tokenData, technicalDetails, {
      ...parsed,
      model: response.data?.model || config.anthropic.model,
      latencyMs: Date.now() - startedAt,
      usage: response.data?.usage || null,
      raw: text,
    });
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.warn(`Anthropic evaluation failed: ${details}`);
    return null;
  }
}

module.exports = { evaluateToken };
