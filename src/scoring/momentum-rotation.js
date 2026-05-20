'use strict';

// Extracted from src/index.js (Week 12 A.9a).
// Scores momentum BUY candidates and open momentum positions for rotation decisions.

function createMomentumScoring(deps) {
  const {
    config,
    marketState,
    round,
    normalizeChainKey,
    normalizeConfidencePercent,
    buildMomentumMetrics,
    buildMomentumState,
    normalizeRotationVolumeSpike,
  } = deps;

  function scoreMomentumCandidate(tokenData = {}, technicalDetails = {}) {
    const metrics = buildMomentumMetrics(tokenData, technicalDetails);
    const trackedKey = `${normalizeChainKey(tokenData?.chainKey || tokenData?.chain)}:${String(tokenData?.address || '').toLowerCase()}`;
    const tracked = marketState.trackedTokens?.[trackedKey] || null;
    const momentumState = tracked?.momentumState || buildMomentumState(null, metrics);
    const priceChange24h = Math.abs(Number(metrics.priceChange24h || 0));
    const buyRatioRecentPct = Number(metrics.buyRatioRecentPct || 0);
    const volumeSpike = normalizeRotationVolumeSpike(metrics.volumeSpike || 0);
    const confidence = normalizeConfidencePercent(metrics.confidence || 0);
    const netBuyFlowUsd10m = Number(metrics.netBuyFlowUsd10m || 0);
    let score =
      (priceChange24h * 0.8)
      + (Math.max(0, buyRatioRecentPct - 50) * 1.1)
      + (Math.max(0, volumeSpike) * 6)
      + (Math.log10(Math.max(1, netBuyFlowUsd10m + 1)) * 5)
      + (confidence * 0.2);
    score += Math.max(0, Number(momentumState.accelerationScore || 0)) * 1.2;
    score += Math.max(0, Number(momentumState.consecutiveStrongScans || 0) - 1) * 6;
    if (priceChange24h >= Number(config.execution?.momentumRotationExtendedMovePct || 30)
      && Number(momentumState.deltaVolumeSpike || 0) <= 0
      && Number(momentumState.deltaBuyRatioRecentPct || 0) <= 0) {
      score -= 12;
    }
    return Number.isFinite(score) ? score : 0;
  }

  function scoreOpenMomentumPosition(position = {}, currentTokenData = null) {
    const trackedKey = `${normalizeChainKey(position.chainKey || position.chain)}:${String(position.address || '').toLowerCase()}`;
    const tracked = marketState.trackedTokens?.[trackedKey] || {};
    const liveMetrics = currentTokenData ? buildMomentumMetrics(currentTokenData, tracked?.indicators || {}) : null;
    const currentPrice = Number(position.currentPrice || tracked.price || position.entryPrice || 0);
    const entryPrice = Number(position.entryPrice || 0);
    const pnlPct = entryPrice > 0 && currentPrice > 0
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : 0;
    const priceChange24h = Math.abs(Number(liveMetrics?.priceChange24h ?? tracked.priceChange24h ?? 0));
    const confidence = normalizeConfidencePercent(liveMetrics?.confidence ?? tracked?.indicators?.confidence ?? 0);
    const volumeSpike = normalizeRotationVolumeSpike(liveMetrics?.volumeSpike ?? tracked?.indicators?.volumeSpike ?? 0);
    const momentumState = liveMetrics ? buildMomentumState(tracked, liveMetrics) : (tracked?.momentumState || {});
    const accelerationScore = Number(momentumState.accelerationScore || 0);
    const consecutiveStrongScans = Number(momentumState.consecutiveStrongScans || 0);
    const weakening = accelerationScore < 0
      && (
        Number(momentumState.deltaVolumeSpike || 0) < 0
        || Number(momentumState.deltaBuyRatioRecentPct || 0) < 0
        || Number(momentumState.deltaNetBuyFlowUsd10m || 0) < 0
      );
    const healthyPnlPct = Number(config.execution?.momentumRotationHealthyPnlPct || 2);
    const healthy = pnlPct >= healthyPnlPct && accelerationScore >= 0 && consecutiveStrongScans >= 2;
    let score = (priceChange24h * 0.75)
      + (pnlPct * 0.4)
      + (confidence * 0.2)
      + (Math.max(0, volumeSpike) * 5)
      + (Math.max(-10, accelerationScore) * 0.8)
      + (Math.max(0, consecutiveStrongScans - 1) * 4);
    const posOpenedAtMs = Date.parse(position?.openedAt || '') || 0;
    const posHoursHeld = posOpenedAtMs > 0 ? (Date.now() - posOpenedAtMs) / 3_600_000 : 0;
    if (posHoursHeld > 4 && pnlPct <= 0) {
      score -= Math.min(20, (posHoursHeld - 4) * 1.5);
    }
    return {
      score: Number.isFinite(score) ? score : 0,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
      weakening,
      healthy,
      accelerationScore,
      consecutiveStrongScans,
      components: {
        priceChange24h: round(priceChange24h, 2),
        pnlPct: round(pnlPct, 2),
        confidence: round(confidence, 2),
        volumeSpike: round(volumeSpike, 3),
        accelerationScore: round(accelerationScore, 2),
        consecutiveStrongScans,
      },
    };
  }

  return { scoreMomentumCandidate, scoreOpenMomentumPosition };
}

module.exports = { createMomentumScoring };
