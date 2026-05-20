'use strict';

// Extracted from src/index.js (Week 12 A.4).
// Encapsulates async AI decision queue: cache key building, TTL, freshness,
// candidate scoring/dedup, in-flight pumping, and queueing for refresh.

function createAiDecisionQueue(deps) {
  const {
    config,
    aiCircuit,
    AITradeBrain,
    normalizeChainKey,
    round,
    logger,
    recordBrainSuccess,
    recordBrainFailure,
    normalizeConfidencePercent,
  } = deps;

  const aiDecisionCache = new Map();
  const aiDecisionQueue = new Map();
  let aiDecisionInFlightKey = null;

  function buildAiDecisionCacheKey(tokenData, strategyName) {
    const chainKey = normalizeChainKey(tokenData?.chainKey || tokenData?.chain || 'unknown');
    const address = String(tokenData?.address || '').toLowerCase();
    return `${chainKey}:${address}:${String(strategyName || 'momentum').toLowerCase()}`;
  }

  function getAiDecisionCacheTtlMs(strategyName) {
    const strategy = String(strategyName || '').toLowerCase();
    if (strategy === 'momentum') {
      return Math.max(1000, Number(config.ai?.momentumDecisionCacheMs || 300000));
    }
    if (strategy === 'swing') {
      return Math.max(1000, Number(config.ai?.swingDecisionCacheMs || 1800000));
    }
    return Math.max(1000, Number(config.ai?.decisionCacheMs || 300000));
  }

  function hasFreshAiDecision(entry, strategyName) {
    if (!entry || !entry.decision || !Number.isFinite(Number(entry.updatedAt))) {
      return false;
    }
    return (Date.now() - Number(entry.updatedAt)) <= getAiDecisionCacheTtlMs(strategyName || entry?.strategy);
  }

  function scoreAiDecisionCandidate(tokenData, technicalDetails = {}) {
    const triggerTimeframe = String(technicalDetails?.triggerTimeframe || '').toLowerCase();
    const discoveryLane = String(tokenData?.discoveryLane || technicalDetails?.discoveryLane || '').toLowerCase();
    const confidence = normalizeConfidencePercent(technicalDetails?.confidence || 0);
    const volumeSpike = Number(technicalDetails?.volumeSpike || 0);
    const buyRatioRecentPct = Number(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || 0);
    const netBuyFlowUsd = Number(technicalDetails?.netBuyFlowUsd10m || 0);
    const liquidityUsd = Number(tokenData?.liquidityUsd || 0);
    const priceChange24h = Math.abs(Number(tokenData?.priceChange24h || 0));
    const rsiValue = Number(technicalDetails?.rsi || 0);

    let score = confidence;
    score += Math.min(60, Math.max(0, volumeSpike) * 12);
    score += Math.min(35, Math.max(0, buyRatioRecentPct) * 0.45);
    score += Math.min(25, Math.log10(Math.max(1, liquidityUsd)) * 4);
    score += Math.min(20, Math.log10(Math.max(1, netBuyFlowUsd + 1)) * 8);
    score += Math.min(20, priceChange24h * 0.12);

    if (technicalDetails?.breakoutConfirmed) score += 15;
    if (triggerTimeframe === 'extreme_24h_momentum') score += 40;
    if (triggerTimeframe === 'momentum_breakout') score += 28;
    if (triggerTimeframe === 'bsc_relaxed_continuation') score += 22;
    if (triggerTimeframe === 'kucoin_relaxed_momentum') score += 18;
    if (discoveryLane === 'core') score += 8;
    if (discoveryLane === 'exploration') score += 3;
    if (Number.isFinite(rsiValue) && rsiValue >= 50 && rsiValue <= 72) score += 10;

    return Number.isFinite(score) ? score : 0;
  }

  function removeAiDecisionQueueCandidate(tokenData, strategyName) {
    const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
    aiDecisionQueue.delete(cacheKey);
  }

  function cacheAiDecisionCandidate(tokenData, technicalDetails, strategyName, options = {}) {
    const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
    const existing = aiDecisionCache.get(cacheKey) || {};
    const nowIso = new Date().toISOString();
    aiDecisionCache.set(cacheKey, {
      ...existing,
      candidate: {
        symbol: tokenData?.symbol || existing?.candidate?.symbol || '',
        address: tokenData?.address || existing?.candidate?.address || '',
        chain: tokenData?.chain || existing?.candidate?.chain || '',
        chainKey: normalizeChainKey(tokenData?.chainKey || tokenData?.chain || existing?.candidate?.chainKey || 'unknown'),
        strategy: String(strategyName || existing?.candidate?.strategy || 'momentum').toLowerCase(),
        discoveryLane: tokenData?.discoveryLane || technicalDetails?.discoveryLane || existing?.candidate?.discoveryLane || null,
        triggerTimeframe: technicalDetails?.triggerTimeframe || existing?.candidate?.triggerTimeframe || null,
        technicalSignal: technicalDetails?.signal || technicalDetails?.technicalSignal || existing?.candidate?.technicalSignal || null,
        price: round(tokenData?.price || existing?.candidate?.price || 0, 8),
        liquidityUsd: round(tokenData?.liquidityUsd || existing?.candidate?.liquidityUsd || 0),
        priceChange24h: round(tokenData?.priceChange24h || existing?.candidate?.priceChange24h || 0, 2),
        buyRatioRecentPct: round(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || existing?.candidate?.buyRatioRecentPct || 0, 2),
        volumeSpike: round(technicalDetails?.volumeSpike || existing?.candidate?.volumeSpike || 0, 2),
        source: options.source || existing?.candidate?.source || 'buy_candidate',
        queuedAt: existing?.candidate?.queuedAt || nowIso,
        lastQueuedAt: nowIso,
      },
    });
  }

  function getAiDecisionCacheStatus(tokenData, strategyName) {
    const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
    const entry = aiDecisionCache.get(cacheKey);
    if (!entry) {
      return { status: 'none', queuedAt: null, decision: null };
    }
    if (entry.inFlight) {
      return {
        status: 'pending',
        queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
        decision: entry.decision || null,
      };
    }
    if (hasFreshAiDecision(entry)) {
      return {
        status: 'ready',
        queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
        decision: entry.decision,
      };
    }
    if (aiDecisionQueue.has(cacheKey) || entry.candidate) {
      return {
        status: 'queued',
        queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
        decision: null,
      };
    }
    return { status: 'none', queuedAt: null, decision: null };
  }

  function getCachedAiDecision(tokenData, strategyName) {
    const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
    const entry = aiDecisionCache.get(cacheKey);
    return hasFreshAiDecision(entry, strategyName) ? entry.decision : null;
  }

  function pumpAiDecisionQueue() {
    if (aiDecisionInFlightKey || !config.anthropic.enabled || Date.now() < aiCircuit.cooldownUntil) {
      return;
    }

    const nextEntry = [...aiDecisionQueue.entries()]
      .sort((left, right) => {
        const priorityDelta = Number(right[1]?.priority || 0) - Number(left[1]?.priority || 0);
        if (priorityDelta !== 0) return priorityDelta;
        return Date.parse(left[1]?.queuedAt || 0) - Date.parse(right[1]?.queuedAt || 0);
      })[0];

    if (!nextEntry) {
      return;
    }

    const [cacheKey, queued] = nextEntry;
    const existing = aiDecisionCache.get(cacheKey) || {};
    aiDecisionInFlightKey = cacheKey;

    const request = AITradeBrain.evaluateToken(queued.tokenData, queued.technicalDetails)
      .then((aiDecision) => {
        const latest = aiDecisionCache.get(cacheKey) || existing;
        aiDecisionQueue.delete(cacheKey);
        aiDecisionCache.set(cacheKey, {
          ...latest,
          decision: aiDecision || latest.decision || null,
          updatedAt: Date.now(),
          inFlight: null,
        });
        if (aiDecision && aiDecision.signal) {
          aiCircuit.failures = 0;
          recordBrainSuccess(queued.tokenData, aiDecision);
        } else if (config.anthropic.apiKey) {
          const anyProviderEnabled = typeof AITradeBrain.hasAnyEnabledProvider === 'function'
            ? AITradeBrain.hasAnyEnabledProvider()
            : !!(config.anthropic.enabled && config.anthropic.apiKey);
          if (anyProviderEnabled) {
            aiCircuit.failures += 1;
            if (aiCircuit.failures >= config.bot.aiFailureThreshold) {
              aiCircuit.cooldownUntil = Date.now() + (config.bot.aiFailureCooldownSeconds * 1000);
              aiCircuit.failures = 0;
              recordBrainFailure(`AI circuit opened for ${config.bot.aiFailureCooldownSeconds}s`);
            } else {
              recordBrainFailure('AI response unavailable');
            }
          }
        }
        return aiDecision;
      })
      .catch((error) => {
        const latest = aiDecisionCache.get(cacheKey) || existing;
        aiDecisionQueue.delete(cacheKey);
        aiDecisionCache.set(cacheKey, {
          ...latest,
          decision: latest.decision || null,
          updatedAt: Number(latest.updatedAt || 0),
          inFlight: null,
        });
        recordBrainFailure(error.message || 'AI async refresh failed');
        return null;
      })
      .finally(() => {
        aiDecisionInFlightKey = null;
        pumpAiDecisionQueue();
      });

    aiDecisionCache.set(cacheKey, {
      ...existing,
      decision: existing.decision || null,
      updatedAt: Number(existing.updatedAt || 0),
      inFlight: request,
    });
  }

  function queueAiDecisionRefresh(tokenData, technicalDetails, strategyName) {
    const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
    if (String(technicalDetails?.signal || technicalDetails?.technicalSignal || '').toUpperCase() !== 'BUY') {
      removeAiDecisionQueueCandidate(tokenData, strategyName);
      return;
    }

    cacheAiDecisionCandidate(tokenData, technicalDetails, strategyName, { source: 'async_refresh' });
    const existing = aiDecisionCache.get(cacheKey) || {};
    if (existing.inFlight || hasFreshAiDecision(existing) || !config.anthropic.enabled || Date.now() < aiCircuit.cooldownUntil) {
      return;
    }

    aiDecisionQueue.set(cacheKey, {
      tokenData: { ...tokenData },
      technicalDetails: { ...technicalDetails },
      strategyName,
      priority: scoreAiDecisionCandidate(tokenData, technicalDetails),
      queuedAt: new Date().toISOString(),
    });

    pumpAiDecisionQueue();
  }

  return {
    buildAiDecisionCacheKey,
    getAiDecisionCacheTtlMs,
    hasFreshAiDecision,
    scoreAiDecisionCandidate,
    removeAiDecisionQueueCandidate,
    cacheAiDecisionCandidate,
    getAiDecisionCacheStatus,
    getCachedAiDecision,
    pumpAiDecisionQueue,
    queueAiDecisionRefresh,
    _internal: { aiDecisionCache, aiDecisionQueue },
  };
}

module.exports = { createAiDecisionQueue };
