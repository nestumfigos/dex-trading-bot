'use strict';

// Extracted from src/index.js (Week 12 A.14).
// Decides whether to rotate the weakest open momentum position into a stronger
// candidate. Sells weakest via executeSell. Read-only otherwise.

function createMomentumRotator(deps) {
  const {
    config,
    logger,
    portfolio,
    marketState,
    exchanges,
    CHAIN_LABELS,
    round,
    normalizeChainKey,
    normalizeConfidencePercent,
    normalizeRotationVolumeSpike,
    buildMomentumMetrics,
    buildMomentumState,
    scoreMomentumCandidate,
    scoreOpenMomentumPosition,
    refreshTrackedOpenPositionSnapshot,
    withTimeout,
    getExecuteSell,
  } = deps;

  async function tryRotateForStrongerMomentum(candidateTokenData, strategyName, evaluationDetails = {}, options = {}) {
    if (String(strategyName || '').toLowerCase() !== 'momentum') {
      return { rotated: false, reason: 'rotation only supported for momentum strategy' };
    }

    const blockCode = String(options.blockCode || '').toLowerCase();
    const sameChainOnly = Boolean(options.sameChainOnly);
    if (blockCode === 'portfolio_heat' && config.execution?.heatAwareMomentumRotationEnabled === false) {
      return {
        rotated: false,
        reason: 'candidate stronger but heat-rotation disabled',
        context: { blockCode, sameChainOnly: true },
      };
    }

    const openStrategyPositions = Object.values(portfolio.positions || {}).filter(
      (position) => String(position?.strategy || 'momentum').toLowerCase() === 'momentum'
    );
    if (!openStrategyPositions.length) {
      return { rotated: false, reason: 'no momentum positions available for rotation' };
    }

    const candidateKey = `${normalizeChainKey(candidateTokenData?.chainKey || candidateTokenData?.chain)}:${String(candidateTokenData?.address || '').toLowerCase()}`;
    const candidateTracked = marketState.trackedTokens?.[candidateKey] || null;
    const candidateMomentumState = candidateTracked?.momentumState || buildMomentumState(null, buildMomentumMetrics(candidateTokenData, evaluationDetails));
    const candidateScore = scoreMomentumCandidate(candidateTokenData, evaluationDetails);
    const minScoreEdge = Math.max(1, Number(config.execution?.momentumRotationMinScoreEdge || 12));
    const maxRotationLossPct = Math.abs(Number(config.execution?.momentumRotationMaxLossPct || 4));
    const requiredPersistenceScans = Math.max(2, Number(config.execution?.momentumRotationPersistenceScans || 2));
    const minAccelerationScore = Number(config.execution?.momentumRotationMinAccelerationScore || 2);

    const rankedCandidates = openStrategyPositions
      .filter((position) => {
        if (!sameChainOnly) return true;
        return normalizeChainKey(position.chainKey || position.chain) === normalizeChainKey(candidateTokenData?.chainKey || candidateTokenData?.chain);
      });
    const ranked = (await Promise.all(rankedCandidates.map(async (position) => {
        const positionChain = normalizeChainKey(position.chainKey || position.chain);
        const positionExchange = exchanges[positionChain];
        let freshTokenData = null;
        if (positionExchange) {
          freshTokenData = await withTimeout(
            positionExchange.getTokenData(position.address),
            Math.max(1500, Number(config.risk?.tokenDataFetchTimeoutMs || 5000)),
            `Rotation score data fetch timed out for ${position.symbol || position.address}`
          ).catch(() => null);
        }
        if (freshTokenData?.price) {
          freshTokenData.address = freshTokenData.address || position.address;
          freshTokenData.chainKey = positionChain;
          freshTokenData.chain = CHAIN_LABELS[positionChain];
          refreshTrackedOpenPositionSnapshot(positionChain, freshTokenData, position);
        }
        const scored = scoreOpenMomentumPosition(position, freshTokenData);
        return {
          position,
          score: scored.score,
          pnlPct: scored.pnlPct,
          weakening: scored.weakening,
          healthy: scored.healthy,
          accelerationScore: scored.accelerationScore,
          consecutiveStrongScans: scored.consecutiveStrongScans,
          components: scored.components,
        };
      })))
      .filter((entry) => entry.pnlPct >= -maxRotationLossPct)
      .sort((a, b) => {
        if (a.pnlPct !== b.pnlPct) return a.pnlPct - b.pnlPct;
        return a.score - b.score;
      });

    const weakest = ranked[0];
    if (!weakest) {
      return {
        rotated: false,
        reason: sameChainOnly
          ? 'candidate stronger but no same-chain position eligible for heat rotation'
          : 'no eligible momentum position available for rotation',
        context: {
          candidateScore: round(candidateScore, 2),
          candidateAccelerationScore: candidateMomentumState.accelerationScore,
          candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
        },
      };
    }

    if (candidateScore < (weakest.score + minScoreEdge)) {
      return {
        rotated: false,
        reason: `candidate not stronger enough than weakest position (${candidateScore.toFixed(1)} vs ${(weakest.score + minScoreEdge).toFixed(1)} required)`,
        context: {
          candidateScore: round(candidateScore, 2),
          weakestScore: round(weakest.score, 2),
          weakestPnlPct: round(weakest.pnlPct, 2),
          weakestSymbol: weakest.position?.symbol || weakest.position?.address || null,
          weakestComponents: weakest.components || null,
          candidateComponents: {
            priceChange24h: round(Math.abs(Number(candidateTokenData?.priceChange24h || 0)), 2),
            confidence: round(normalizeConfidencePercent(evaluationDetails?.confidence ?? candidateTokenData?.confidence ?? 0), 2),
            volumeSpike: round(normalizeRotationVolumeSpike(evaluationDetails?.volumeSpike ?? candidateTokenData?.volumeSpike ?? 0), 3),
            accelerationScore: round(Number(candidateMomentumState.accelerationScore || 0), 2),
            consecutiveStrongScans: Number(candidateMomentumState.consecutiveStrongScans || 0),
          },
        },
      };
    }

    if (Number(candidateMomentumState.accelerationScore || 0) < minAccelerationScore) {
      return {
        rotated: false,
        reason: `candidate stronger but acceleration still weak (${Number(candidateMomentumState.accelerationScore || 0).toFixed(1)})`,
        context: {
          candidateScore: round(candidateScore, 2),
          candidateAccelerationScore: candidateMomentumState.accelerationScore,
          candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
          weakestScore: round(weakest.score, 2),
        },
      };
    }

    if (Number(candidateMomentumState.consecutiveStrongScans || 0) < requiredPersistenceScans) {
      return {
        rotated: false,
        reason: `candidate stronger but not persistent yet (${Number(candidateMomentumState.consecutiveStrongScans || 0)}/${requiredPersistenceScans} strong scans)`,
        context: {
          candidateScore: round(candidateScore, 2),
          candidateAccelerationScore: candidateMomentumState.accelerationScore,
          candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
          weakestScore: round(weakest.score, 2),
        },
      };
    }

    const weakestOpenedAtMs = Date.parse(weakest.position.openedAt || '') || 0;
    const weakestHoursHeld = weakestOpenedAtMs > 0 ? (Date.now() - weakestOpenedAtMs) / 3_600_000 : 0;
    const weakestIsStale = weakestHoursHeld >= 4 && weakest.pnlPct <= 0;
    if ((!weakest.weakening || weakest.healthy) && !weakestIsStale) {
      return {
        rotated: false,
        reason: 'candidate stronger but weakest current position still healthy',
        context: {
          candidateScore: round(candidateScore, 2),
          weakestScore: round(weakest.score, 2),
          weakestPnlPct: round(weakest.pnlPct, 2),
          weakestAccelerationScore: round(weakest.accelerationScore, 2),
          weakestConsecutiveStrongScans: weakest.consecutiveStrongScans,
        },
      };
    }

    const weakestChain = normalizeChainKey(weakest.position.chainKey || weakest.position.chain);
    const weakestExchange = exchanges[weakestChain];
    if (!weakestExchange) {
      return { rotated: false, reason: 'rotation venue unavailable for weakest position' };
    }

    const exitTokenData = await withTimeout(
      weakestExchange.getTokenData(weakest.position.address),
      Math.max(1500, Number(config.risk?.tokenDataFetchTimeoutMs || 5000)),
      `Rotation sell data fetch timed out for ${weakest.position.symbol || weakest.position.address}`
    ).catch(() => null);

    const fallbackExitToken = {
      symbol: weakest.position.symbol,
      address: weakest.position.address,
      chainKey: weakestChain,
      chain: CHAIN_LABELS[weakestChain],
      price: Number(weakest.position.currentPrice || weakest.position.entryPrice || 0),
    };

    try {
      logger.info(
        `Momentum rotation: replacing ${weakest.position.symbol || weakest.position.address} ` +
        `(score=${weakest.score.toFixed(1)}, pnl=${weakest.pnlPct.toFixed(2)}%) with ` +
        `${candidateTokenData.symbol} (score=${candidateScore.toFixed(1)})`
      );
      const executeSell = getExecuteSell();
      await executeSell(
        weakestChain,
        weakestExchange,
        exitTokenData || fallbackExitToken,
        weakest.position,
        1,
        'ROTATE_STRONGER_MOMENTUM'
      );
      return {
        rotated: true,
        reason: 'rotated into stronger momentum candidate',
        context: {
          candidateScore: round(candidateScore, 2),
          weakestScore: round(weakest.score, 2),
          weakestPnlPct: round(weakest.pnlPct, 2),
        },
      };
    } catch (error) {
      logger.warn(`Momentum rotation failed: ${error.message}`);
      return {
        rotated: false,
        reason: `rotation attempt failed: ${error.message}`,
        context: {
          candidateScore: round(candidateScore, 2),
          weakestScore: round(weakest.score, 2),
        },
      };
    }
  }

  return { tryRotateForStrongerMomentum };
}

module.exports = { createMomentumRotator };
