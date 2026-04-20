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

  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey: config.groq.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }

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
}

async function evaluateWithGemini(tokenData, technicalDetails, headlines) {
  if (!config.gemini.apiKey) return null;

  const model = config.gemini.model;

  if (!geminiClient) {
    geminiClient = new GoogleGenerativeAI(config.gemini.apiKey);
  }

  const generativeModel = geminiClient.getGenerativeModel({ model });
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
}

function signalFromResults(results) {
  const out = [];
  results.forEach((item) => {
    if (item.status === 'fulfilled' && item.value && VALID_SIGNALS.has(item.value.signal)) {
      out.push(item.value);
    }
  });
  return out;
}

async function evaluateToken(tokenData, technicalDetails) {
  const startedAt = Date.now();

  const headlines = await fetchCryptoNews(tokenData.symbol || '', 8)
    .then((items) => items.map((n) => n.title).filter(Boolean).slice(0, 8))
    .catch(() => []);

  const [claudeResult, sideResults] = await Promise.all([
    evaluateWithClaude(tokenData, technicalDetails),
    Promise.allSettled([
      evaluateWithGroq(tokenData, technicalDetails, headlines),
      evaluateWithGemini(tokenData, technicalDetails, headlines),
    ]),
  ]);

  if (!claudeResult) {
    return null;
  }

  const peers = signalFromResults(sideResults);
  const peerSignals = peers.map((item) => item.signal);
  const narrativeCandidates = peers
    .map((item) => Number(item.narrativeStrength || 0))
    .filter((value) => Number.isFinite(value));
  const narrativeStrength = narrativeCandidates.length
    ? Math.round(narrativeCandidates.reduce((a, b) => a + b, 0) / narrativeCandidates.length)
    : 0;

  let final = {
    ...claudeResult,
    source: 'ensemble',
    narrativeStrength,
    peerSignals,
    peerModels: peers.map((p) => `${p.source}:${p.model}`),
  };

  if (
    final.signal === 'BUY' &&
    peers.length >= 2 &&
    peerSignals.every((s) => s !== 'BUY')
  ) {
    final.signal = 'HOLD';
    final.confidence = Math.min(Number(final.confidence || 0), 60);
    final.reason = 'Ensemble override: secondary models did not confirm BUY';
    final.riskFlags = [...new Set([...(final.riskFlags || []), 'ensemble_veto'])];
  }

  if (final.signal === 'BUY' && String(technicalDetails.signal || '').toUpperCase() !== 'BUY') {
    final.signal = 'HOLD';
    final.confidence = Math.min(Number(final.confidence || 0), 60);
    final.reason = 'Narrative gate: technical signal not BUY';
    final.riskFlags = [...new Set([...(final.riskFlags || []), 'technical_gate'])];
  }

  if (final.signal === 'BUY' && narrativeStrength < Number(config.ai.narrativeMinScore || 65)) {
    final.signal = 'HOLD';
    final.confidence = Math.min(Number(final.confidence || 0), 55);
    final.reason = `Narrative score ${narrativeStrength} below threshold ${config.ai.narrativeMinScore}`;
    final.riskFlags = [...new Set([...(final.riskFlags || []), 'narrative_gate'])];
  }

  final.latencyMs = Date.now() - startedAt;

  logger.debug(
    `AI ensemble ${tokenData.symbol} [${technicalDetails.strategy || 'momentum'}]: claude=${claudeResult.signal} peers=${peerSignals.join(',') || '-'} ` +
    `narrative=${narrativeStrength} final=${final.signal}`
  );

  return final;
}

module.exports = { evaluateToken };
