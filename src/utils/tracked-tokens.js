'use strict';

// Extracted from src/index.js (Week 12 A.5).
// Tracked-token state mutators: signals feed, momentum metrics/state, snapshots,
// buy-failure and trade-block tagging, and compact serializers for dashboard use.

function createTrackedTokens(deps) {
  const {
    marketState,
    portfolio,
    config,
    strategy,
    telemetry,
    CHAIN_LABELS,
    normalizeChainKey,
    buildTokenKey,
    round,
    normalizeConfidencePercent,
    getAiDecisionCacheStatus,
  } = deps;

  function toCompactTrackedToken(token) {
    return {
      key: token.key,
      symbol: token.symbol,
      address: token.address,
      chain: token.chain,
      chainKey: token.chainKey,
      strategy: token.strategy,
      discoveryLane: token.discoveryLane || null,
      price: token.price,
      liquidityUsd: token.liquidityUsd,
      priceChange24h: token.priceChange24h,
      historyBars: token.historyBars,
      technicalSignal: token.technicalSignal,
      finalSignal: token.finalSignal,
      aiReason: token.aiReason || '',
      aiVerificationStatus: token.aiVerificationStatus || 'none',
      aiVerificationQueuedAt: token.aiVerificationQueuedAt || null,
      notBoughtReason: token.notBoughtReason || '',
      lastBuyFailure: token.lastBuyFailure || '',
      lastBuyFailureAt: token.lastBuyFailureAt || null,
      riskFlags: Array.isArray(token.riskFlags) ? token.riskFlags : [],
      indicators: {
        rsi: token.indicators?.rsi ?? null,
        volumeSpike: token.indicators?.volumeSpike ?? null,
        buyRatioRecentPct: token.indicators?.buyRatioRecentPct ?? null,
        netBuyFlowUsd10m: token.indicators?.netBuyFlowUsd10m ?? null,
        shortSignal: token.indicators?.shortSignal ?? null,
        mediumSignal: token.indicators?.mediumSignal ?? null,
        longSignal: token.indicators?.longSignal ?? null,
        recentWindowLabel: token.indicators?.recentWindowLabel ?? null,
      },
      momentumState: token.momentumState || null,
      rotationContext: token.rotationContext || null,
      hasOpenPosition: token.hasOpenPosition,
      signalSource: token.signalSource,
      lastSignalAt: token.lastSignalAt,
      lastScannedAt: token.lastScannedAt,
    };
  }

  function toCompactSignal(signal) {
    return {
      timestamp: signal.timestamp,
      symbol: signal.symbol,
      address: signal.address,
      chain: signal.chain,
      strategy: signal.strategy || null,
      discoveryLane: signal.discoveryLane || null,
      price: signal.price,
      technicalSignal: signal.technicalSignal,
      finalSignal: signal.finalSignal,
      aiReason: signal.aiReason || '',
      signalSource: signal.signalSource || signal.source || '',
      aiVerificationStatus: signal.aiVerificationStatus || 'none',
      notBoughtReason: signal.notBoughtReason || '',
      lastBuyFailure: signal.lastBuyFailure || '',
      lastBuyFailureAt: signal.lastBuyFailureAt || null,
      rsi: signal.rsi,
      volumeSpike: signal.volumeSpike,
      source: signal.source || signal.signalSource,
    };
  }

  function getTrackedTokens(options = {}) {
    const rawLimit = Number(options.limit);
    const compact = options.compact === true;
    const allTokens = Object.values(marketState.trackedTokens)
      .sort((a, b) => new Date(b.lastScannedAt || 0) - new Date(a.lastScannedAt || 0));
    const tokens = Number.isFinite(rawLimit) && rawLimit > 0
      ? allTokens.slice(0, rawLimit)
      : allTokens;

    return compact ? tokens.map(toCompactTrackedToken) : tokens;
  }

  function recordSignalEvent(entry) {
    marketState.signals.unshift(entry);
    if (marketState.signals.length > 1000) {
      marketState.signals.splice(1000);
    }
  }

  function summarizeBuyFailureReason(message) {
    const raw = String(message || '').trim();
    const value = raw.toLowerCase();
    if (!raw) return 'buy execution failed';
    if (value.includes('insufficient funds')) return 'insufficient funds';
    if (value.includes('transaction reverted') || value.includes('buy transaction reverted') || value.includes('swap reverted')) {
      return 'swap reverted';
    }
    if (
      value.includes('private tx')
      || value.includes('private rpc')
      || value.includes('private route')
      || value.includes('mev protection required')
    ) {
      return 'private route unavailable';
    }
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
  }

  function recordBuyFailureState(chainName, tokenData, errorMessage) {
    const key = `${chainName}:${String(tokenData?.address || '').toLowerCase()}`;
    const previous = marketState.trackedTokens[key];
    const reason = summarizeBuyFailureReason(errorMessage);
    const timestamp = new Date().toISOString();

    if (previous) {
      marketState.trackedTokens[key] = {
        ...previous,
        notBoughtReason: reason,
        lastBuyFailure: reason,
        lastBuyFailureAt: timestamp,
      };
    }

    const recentSignal = marketState.signals.find((entry) => (
      String(entry?.address || '').toLowerCase() === String(tokenData?.address || '').toLowerCase()
      && normalizeChainKey(entry?.chainKey || entry?.chain) === normalizeChainKey(chainName)
    ));

    if (recentSignal) {
      recentSignal.notBoughtReason = reason;
      recentSignal.lastBuyFailure = reason;
      recentSignal.lastBuyFailureAt = timestamp;
    }
  }

  function recordTradeBlockState(chainName, tokenData, strategyName, technicalSignal, signalSource, blockReason, extra = {}) {
    const reason = String(blockReason || '').trim();
    const timestamp = new Date().toISOString();
    const key = `${chainName}:${String(tokenData?.address || '').toLowerCase()}`;
    const previous = marketState.trackedTokens[key];

    const snapshotReason = reason || previous?.notBoughtReason || '';
    if (previous) {
      marketState.trackedTokens[key] = {
        ...previous,
        strategy: strategyName || previous.strategy || null,
        technicalSignal: technicalSignal || previous.technicalSignal || null,
        finalSignal: previous.finalSignal || 'HOLD',
        signalSource: signalSource || previous.signalSource || '',
        notBoughtReason: snapshotReason,
        riskFlags: Array.isArray(extra.riskFlags) && extra.riskFlags.length
          ? extra.riskFlags
          : (Array.isArray(previous.riskFlags) ? previous.riskFlags : []),
        rotationContext: extra.rotationContext || previous.rotationContext || null,
        lastScannedAt: timestamp,
      };
    }

    const recentSignal = marketState.signals.find((entry) => (
      String(entry?.address || '').toLowerCase() === String(tokenData?.address || '').toLowerCase()
      && normalizeChainKey(entry?.chainKey || entry?.chain) === normalizeChainKey(chainName)
    ));
    if (recentSignal) {
      recentSignal.notBoughtReason = snapshotReason;
      if (Array.isArray(extra.riskFlags) && extra.riskFlags.length) {
        recentSignal.riskFlags = extra.riskFlags;
      }
      if (extra.rotationContext) {
        recentSignal.rotationContext = extra.rotationContext;
      }
    }
  }

  function buildMomentumMetrics(tokenData = {}, technicalDetails = {}) {
    return {
      priceChange24h: Number(tokenData?.priceChange24h || technicalDetails?.priceChange24h || 0),
      buyRatioRecentPct: Number(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || tokenData?.buyRatioRecentPct || 0),
      volumeSpike: Number(technicalDetails?.volumeSpike || tokenData?.volumeSpike || 0),
      confidence: normalizeConfidencePercent(technicalDetails?.confidence ?? tokenData?.confidence ?? 0),
      netBuyFlowUsd10m: Number(technicalDetails?.netBuyFlowUsd10m || tokenData?.netBuyFlowUsd10m || 0),
    };
  }

  function isStrongMomentumSnapshot(metrics = {}) {
    return Number(metrics.priceChange24h || 0) > 0
      && Number(metrics.buyRatioRecentPct || 0) >= 52
      && Number(metrics.volumeSpike || 0) >= 1.1
      && Number(metrics.netBuyFlowUsd10m || 0) > 0;
  }

  function normalizeRotationVolumeSpike(value) {
    const spike = Number(value || 0);
    if (!Number.isFinite(spike) || spike <= 0) return 0;
    if (spike <= 10) return spike;
    return Math.min(10, 1 + (Math.log10(spike) * 3));
  }

  function buildMomentumState(previousToken = null, metrics = {}) {
    const historyLimit = Math.max(3, Number(config.execution?.momentumRotationHistoryLimit || 5));
    const previousHistory = Array.isArray(previousToken?.momentumState?.history)
      ? previousToken.momentumState.history
      : [];
    const entry = {
      ts: new Date().toISOString(),
      priceChange24h: round(metrics.priceChange24h || 0, 2),
      buyRatioRecentPct: round(metrics.buyRatioRecentPct || 0, 2),
      volumeSpike: round(metrics.volumeSpike || 0, 3),
      confidence: round(normalizeConfidencePercent(metrics.confidence || 0), 2),
      netBuyFlowUsd10m: round(metrics.netBuyFlowUsd10m || 0, 2),
      strong: isStrongMomentumSnapshot(metrics),
    };
    const history = previousHistory.concat(entry).slice(-historyLimit);
    const current = history[history.length - 1] || entry;
    const prior = history[history.length - 2] || null;
    const deltaPriceChange24h = prior ? Number(current.priceChange24h || 0) - Number(prior.priceChange24h || 0) : 0;
    const deltaVolumeSpike = prior ? Number(current.volumeSpike || 0) - Number(prior.volumeSpike || 0) : 0;
    const deltaBuyRatioRecentPct = prior ? Number(current.buyRatioRecentPct || 0) - Number(prior.buyRatioRecentPct || 0) : 0;
    const deltaNetBuyFlowUsd10m = prior ? Number(current.netBuyFlowUsd10m || 0) - Number(prior.netBuyFlowUsd10m || 0) : 0;
    const accelerationScore =
      (deltaPriceChange24h * 0.8)
      + (deltaVolumeSpike * 8)
      + (deltaBuyRatioRecentPct * 0.9)
      + Math.max(-12, Math.min(12, deltaNetBuyFlowUsd10m / 2500));

    let consecutiveStrongScans = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (!history[i]?.strong) break;
      consecutiveStrongScans += 1;
    }

    return {
      history,
      deltaPriceChange24h: round(deltaPriceChange24h, 2),
      deltaVolumeSpike: round(deltaVolumeSpike, 3),
      deltaBuyRatioRecentPct: round(deltaBuyRatioRecentPct, 2),
      deltaNetBuyFlowUsd10m: round(deltaNetBuyFlowUsd10m, 2),
      accelerationScore: round(accelerationScore, 2),
      consecutiveStrongScans,
      strongNow: Boolean(current.strong),
    };
  }

  function updateTrackedToken(chainName, tokenData, evaluation, options = {}) {
    const recordSignal = options.recordSignal !== false;
    const key = `${chainName}:${String(tokenData.address || '').toLowerCase()}`;
    const previous = marketState.trackedTokens[key];
    const aiCacheStatus = getAiDecisionCacheStatus(tokenData, evaluation.strategy || 'momentum');
    const momentumMetrics = buildMomentumMetrics(tokenData, evaluation.details || {});
    const momentumState = buildMomentumState(previous, momentumMetrics);
    const snapshot = {
      key,
      symbol: tokenData.symbol,
      address: tokenData.address,
      chain: tokenData.chain,
      chainKey: chainName,
      strategy: evaluation.strategy || null,
      discoveryLane: tokenData.discoveryLane || evaluation.details?.discoveryLane || null,
      price: round(tokenData.price, 8),
      liquidityUsd: round(tokenData.liquidityUsd || 0),
      liquidityChange24hPct: round(tokenData.liquidityChange24hPct || 0, 2),
      volume24h: round(tokenData.volume24h || 0),
      priceChange24h: round(tokenData.priceChange24h || 0, 2),
      priceChange7d: round(tokenData.priceChange7d || 0, 2),
      holderCount: Number(tokenData.holderCount || 0),
      topHoldersPct: round(tokenData.topHoldersPct || 0, 2),
      listingDate: tokenData.listingDate || null,
      listedOnCoinGecko: Boolean(tokenData.coingeckoId || tokenData.listedOnCoinGecko),
      listedOnCoinMarketCap: Boolean(tokenData.listedOnCoinMarketCap),
      buyTx10m: Number(tokenData.buyTx10m || 0),
      sellTx10m: Number(tokenData.sellTx10m || 0),
      buyTx1h: Number(tokenData.buyTx1h || 0),
      sellTx1h: Number(tokenData.sellTx1h || 0),
      uniqueBuyers10m: Number(tokenData.uniqueBuyers10m || 0),
      historyBars: strategy.getHistoryLength(tokenData.strategyKey || buildTokenKey(chainName, tokenData.address)),
      technicalSignal: evaluation.technicalSignal,
      finalSignal: evaluation.finalSignal,
      signalSource: evaluation.signalSource,
      aiReason: evaluation.aiReason || '',
      aiConfidence: evaluation.aiConfidence || 0,
      aiVerificationStatus: evaluation.details?.aiVerificationStatus || aiCacheStatus.status || 'none',
      aiVerificationQueuedAt: aiCacheStatus.queuedAt || null,
      notBoughtReason: evaluation.notBoughtReason || '',
      lastBuyFailure: evaluation.lastBuyFailure || previous?.lastBuyFailure || '',
      lastBuyFailureAt: evaluation.lastBuyFailureAt || previous?.lastBuyFailureAt || null,
      riskFlags: evaluation.riskFlags || [],
      indicators: {
        fastEma: evaluation.details.fastEma ?? null,
        slowEma: evaluation.details.slowEma ?? null,
        rsi: evaluation.details.rsi ?? null,
        volumeSpike: evaluation.details.volumeSpike ?? null,
        buyRatioRecentPct: evaluation.details.buyRatioRecentPct ?? evaluation.details.buyRatio10mPct ?? null,
        netBuyFlowUsd10m: evaluation.details.netBuyFlowUsd10m ?? null,
        shortSignal: evaluation.details.short?.signal || null,
        mediumSignal: evaluation.details.medium?.signal || null,
        longSignal: evaluation.details.long?.signal || null,
        confidence: evaluation.details.confidence || 0,
        triggerTimeframe: evaluation.details.triggerTimeframe || null,
        recentWindowLabel: evaluation.details.recentWindowLabel || null,
      },
      momentumState,
      rotationContext: evaluation.details?.rotationContext || null,
      hasOpenPosition: Boolean(portfolio.positions[buildTokenKey(chainName, tokenData.address)]),
      lastScannedAt: new Date().toISOString(),
    };

    marketState.trackedTokens[key] = snapshot;

    const shouldLog = !previous
      || previous.finalSignal !== snapshot.finalSignal
      || previous.signalSource !== snapshot.signalSource
      || snapshot.finalSignal === 'BUY'
      || snapshot.finalSignal === 'SELL';

    if (recordSignal && shouldLog) {
      recordSignalEvent({
        timestamp: snapshot.lastScannedAt,
        symbol: snapshot.symbol,
        address: snapshot.address,
        chain: snapshot.chain,
        chainKey: snapshot.chainKey,
        strategy: snapshot.strategy,
        discoveryLane: snapshot.discoveryLane,
        price: snapshot.price,
        technicalSignal: snapshot.technicalSignal,
        finalSignal: snapshot.finalSignal,
        signalSource: snapshot.signalSource,
        aiReason: snapshot.aiReason,
        aiConfidence: snapshot.aiConfidence,
        aiVerificationStatus: snapshot.aiVerificationStatus,
        rsi: snapshot.indicators.rsi,
        volumeSpike: snapshot.indicators.volumeSpike,
      });

      telemetry.logSignal(snapshot, {
        gate: evaluation?.details || null,
        rejectReasons: evaluation?.details?.externalReasons || evaluation?.notBoughtReason || null,
      });
    }
  }

  function refreshTrackedOpenPositionSnapshot(chainName, tokenData, position = {}) {
    const key = `${chainName}:${String(tokenData?.address || position?.address || '').toLowerCase()}`;
    const previous = marketState.trackedTokens[key] || {};
    const previousIndicators = previous?.indicators || {};
    const metrics = buildMomentumMetrics(tokenData, {
      confidence: previousIndicators.confidence || 0,
      volumeSpike: tokenData?.volumeSpike ?? previousIndicators.volumeSpike ?? 0,
      buyRatioRecentPct: tokenData?.buyRatioRecentPct ?? tokenData?.buyRatio10mPct ?? previousIndicators.buyRatioRecentPct ?? 0,
      netBuyFlowUsd10m: tokenData?.netBuyFlowUsd10m ?? previousIndicators.netBuyFlowUsd10m ?? 0,
    });
    const momentumState = buildMomentumState(previous, metrics);

    marketState.trackedTokens[key] = {
      ...previous,
      key,
      symbol: tokenData?.symbol || position?.symbol || previous?.symbol || '',
      address: tokenData?.address || position?.address || previous?.address || '',
      chain: CHAIN_LABELS[chainName],
      chainKey: chainName,
      strategy: position?.strategy || previous?.strategy || 'momentum',
      price: round(tokenData?.price || previous?.price || 0, 8),
      volume24h: round(tokenData?.volume24h || previous?.volume24h || 0),
      priceChange24h: round(tokenData?.priceChange24h || previous?.priceChange24h || 0, 2),
      signalSource: previous?.signalSource || 'position_monitor',
      finalSignal: previous?.finalSignal || 'OPEN',
      aiReason: previous?.aiReason || '',
      aiConfidence: normalizeConfidencePercent(previous?.aiConfidence || 0),
      aiVerificationStatus: previous?.aiVerificationStatus || 'none',
      aiVerificationQueuedAt: previous?.aiVerificationQueuedAt || null,
      notBoughtReason: '',
      lastBuyFailure: previous?.lastBuyFailure || '',
      lastBuyFailureAt: previous?.lastBuyFailureAt || null,
      riskFlags: previous?.riskFlags || [],
      indicators: {
        ...previousIndicators,
        confidence: normalizeConfidencePercent(previousIndicators.confidence || 0),
        volumeSpike: round(metrics.volumeSpike || 0, 3),
        buyRatioRecentPct: round(metrics.buyRatioRecentPct || 0, 2),
        netBuyFlowUsd10m: round(metrics.netBuyFlowUsd10m || 0, 2),
      },
      momentumState,
      rotationContext: null,
      hasOpenPosition: true,
      lastScannedAt: new Date().toISOString(),
    };
  }

  return {
    toCompactTrackedToken,
    toCompactSignal,
    getTrackedTokens,
    recordSignalEvent,
    summarizeBuyFailureReason,
    recordBuyFailureState,
    recordTradeBlockState,
    buildMomentumMetrics,
    isStrongMomentumSnapshot,
    normalizeRotationVolumeSpike,
    buildMomentumState,
    updateTrackedToken,
    refreshTrackedOpenPositionSnapshot,
  };
}

module.exports = { createTrackedTokens };
