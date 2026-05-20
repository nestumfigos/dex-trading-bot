'use strict';

// Extracted from src/index.js (Week 12 A.11).
// Runs ML/sentiment/regime/hybrid review of a candidate. Mutates evaluation.details
// in place and returns the snapshots produced.

function createIntelligentModelReview(deps) {
  const {
    config,
    logger,
    strategy,
    modelRegistry,
    rlPolicyManager,
    fetchTokenSentiment,
    buildFeatureSnapshot,
    computeRegime,
    runHybridDecision,
  } = deps;

  async function applyIntelligentModelReview({
    chainName,
    tokenKey,
    tokenData,
    strategyName,
    evaluation,
    exchange,
  }) {
    if (!config.ml?.enabled && !config.sentimentEngine?.enabled && !config.hybridAgent?.enabled && !config.rl?.enabled) {
      return null;
    }
    const baseConfidence = Number(evaluation?.details?.confidence || 0);
    const strongMomentum = Number(tokenData?.priceChange24h || 0) >= 3 || Number(evaluation?.details?.volumeSpike || 0) >= 1.2;
    const shouldRun = evaluation?.signal === 'BUY' || baseConfidence >= 60 || strongMomentum;
    if (!shouldRun) {
      return null;
    }

    const localPriceHistory = strategy.priceHistory?.[tokenKey] || [];
    const localVolumeHistory = strategy.volumeHistory?.[tokenKey] || [];
    const sentimentSnapshot = config.sentimentEngine?.enabled !== false
      ? await fetchTokenSentiment({
        symbol: tokenData.symbol,
        chainKey: chainName,
        tokenData,
        logger,
        modelRegistry,
      }).catch((error) => {
        logger.debug(`Sentiment snapshot skipped for ${tokenData.symbol}: ${error.message}`);
        return null;
      })
      : null;

    const featureSnapshot = await buildFeatureSnapshot({
      chainName,
      tokenData,
      strategyName,
      evaluation,
      localPriceHistory,
      localVolumeHistory,
      sentimentSnapshot,
    }).catch((error) => {
      logger.debug(`Feature snapshot skipped for ${tokenData.symbol}: ${error.message}`);
      return null;
    });

    if (featureSnapshot) {
      modelRegistry.recordFeatureSnapshot(featureSnapshot).catch((error) => {
        logger.debug(`Feature snapshot persistence failed for ${tokenData.symbol}: ${error.message}`);
      });
      evaluation.details.modelFeatureCoverage = featureSnapshot.coverage;
      evaluation.details.modelFeatureBars = featureSnapshot.barCount;
      evaluation.details.modelFeatureSource = featureSnapshot.source;
      evaluation.details.featureSnapshot = featureSnapshot.features;
    }

    if (sentimentSnapshot) {
      evaluation.details.sentimentSnapshot = {
        signal: sentimentSnapshot.signal,
        confidence: sentimentSnapshot.confidence,
        aggregateScore: sentimentSnapshot.aggregateScore,
        newsCount: sentimentSnapshot.newsCount,
        redditCount: sentimentSnapshot.redditCount,
      };
    }

    if (chainName === 'kucoin' && typeof exchange?.getOrderBookImbalance === 'function') {
      const obSym = tokenData.address || `${String(tokenData.symbol).toUpperCase()}/USDT`;
      const imbalance = await exchange.getOrderBookImbalance(obSym).catch(() => null);
      if (imbalance) {
        evaluation.details.bookImbalance = {
          ratio: Number(imbalance.ratio.toFixed(3)),
          skewPct: Number(imbalance.skewPct.toFixed(2)),
          bidUsd: Math.round(imbalance.bidUsd),
          askUsd: Math.round(imbalance.askUsd),
        };
      }
    }

    const liveRegime = localPriceHistory && localPriceHistory.length >= 22
      ? computeRegime(localPriceHistory, localVolumeHistory || [])
      : { label: 'unknown', family: 'unknown', confidence: 0, realizedVol: 0, momentum: 0 };
    if (!evaluation.details.marketRegime) {
      evaluation.details.marketRegime = liveRegime.label;
    }
    evaluation.details.regimeFamily = liveRegime.family;
    evaluation.details.regimeConfidence = liveRegime.confidence;
    if (!Number.isFinite(evaluation.details.realizedVolPct) || evaluation.details.realizedVolPct === 0) {
      evaluation.details.realizedVolPct = liveRegime.realizedVol;
    }

    if (config.risk?.regimeAdaptiveParamsEnabled !== false) {
      const realizedVol = Number(liveRegime.realizedVol || evaluation.details.realizedVolPct || 0);
      let regimeAdjustments = null;
      if (realizedVol >= 5) {
        regimeAdjustments = {
          regime: 'high_vol',
          rsiBuyMinDelta: -5,
          rsiBuyMaxDelta: +5,
          volumeSpikeMultiplierFactor: 0.85,
          confidenceFloorDelta: +5,
        };
      } else if (realizedVol >= 2) {
        regimeAdjustments = {
          regime: 'medium_vol',
          rsiBuyMinDelta: 0,
          rsiBuyMaxDelta: 0,
          volumeSpikeMultiplierFactor: 1.0,
          confidenceFloorDelta: 0,
        };
      } else if (realizedVol > 0) {
        regimeAdjustments = {
          regime: 'low_vol',
          rsiBuyMinDelta: +3,
          rsiBuyMaxDelta: -3,
          volumeSpikeMultiplierFactor: 1.15,
          confidenceFloorDelta: -3,
        };
      }
      if (regimeAdjustments) {
        evaluation.details.regimeAdaptiveAdjustments = regimeAdjustments;
      }
    }

    const hybridDecision = featureSnapshot && config.hybridAgent?.enabled !== false
      ? await runHybridDecision({
        registry: modelRegistry,
        rlPolicyManager,
        logger,
        tokenData,
        strategyName,
        evaluation,
        featureSnapshot,
        sentimentSnapshot,
      }).catch((error) => {
        logger.debug(`Hybrid decision skipped for ${tokenData.symbol}: ${error.message}`);
        return null;
      })
      : null;

    if (hybridDecision) {
      evaluation.details.hybridDecision = {
        taskClass: hybridDecision.taskClass,
        regimeFamily: hybridDecision.regimeFamily,
        finalSignal: hybridDecision.finalSignal,
        confidence: hybridDecision.confidence,
        aggregateScore: hybridDecision.aggregateScore,
        route: hybridDecision.route,
      };
      evaluation.details.mlPredictions = hybridDecision.predictions || [];

      if (
        config.hybridAgent?.allowDirectEntryFromHybrid !== false
        && evaluation.signal !== 'BUY'
        && hybridDecision.finalSignal === 'BUY'
        && Number(hybridDecision.confidence || 0) >= Number(config.hybridAgent?.minConfidence || 0.28)
        && Number(hybridDecision.aggregateScore || 0) >= Number(config.ml?.directBuyThreshold || 0.68)
      ) {
        evaluation.signal = 'BUY';
        evaluation.details.hybridPromotedSignal = true;
        evaluation.details.hybridReason = 'hybrid_direct_entry';
      }

      if (
        config.hybridAgent?.allowVetoFromHybrid !== false
        && evaluation.signal === 'BUY'
        && hybridDecision.finalSignal !== 'BUY'
        && Number(hybridDecision.aggregateScore || 0) <= Number(config.ml?.vetoThreshold || 0.42)
      ) {
        evaluation.signal = 'HOLD';
        evaluation.details.hybridVetoedSignal = true;
        evaluation.details.hybridReason = 'hybrid_veto';
        evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'hybrid_veto'])];
      }

      const aiPrimaryEnabled = process.env.AI_PRIMARY_MODE === 'true' || config.execution?.aiPrimaryDecisionEnabled === true;
      const aiConfidence = Number(hybridDecision?.confidence || evaluation.details?.aiConfidence || 0);
      const aiPrimaryThreshold = Number(config.execution?.aiPrimaryConfidenceThreshold || 0.80);

      if (
        aiPrimaryEnabled
        && evaluation.signal === 'HOLD'
        && hybridDecision?.finalSignal === 'BUY'
        && aiConfidence >= aiPrimaryThreshold
      ) {
        evaluation.signal = 'BUY';
        evaluation.details.aiPrimaryOverride = true;
        evaluation.details.aiPrimaryReason = `AI confidence ${(aiConfidence * 100).toFixed(0)}% >= ${(aiPrimaryThreshold * 100).toFixed(0)}% threshold`;
        logger.info(`[AI-Primary] Override to BUY for ${tokenData.symbol}: ${evaluation.details.aiPrimaryReason}`);
      }
    }

    return {
      sentimentSnapshot,
      featureSnapshot,
      hybridDecision,
    };
  }

  return { applyIntelligentModelReview };
}

module.exports = { createIntelligentModelReview };
