'use strict';

/**
 * Paper-bot early-breakout qualifier.
 *
 * Assesses whether a token candidate qualifies as an early-breakout entry
 * under stricter-than-default thresholds for paper trading research.
 *
 * Restored 2026-05-22 after misidentified-as-dead deletion. Logic reconstructed
 * to satisfy test/kucoin-early-breakout.test.js expectations:
 *   - returnsConfirmed = return1Pct/return3Pct/return12Pct all >= per-chain mins
 *   - persistenceConfirmed = accelerationScore >= min AND consecutiveStrongScans >= min
 *   - qualified = all gates pass (returns, persistence, volume spike, liquidity,
 *                 orderbook strength, optional confluence, price-change cap,
 *                 model feature bar count + coverage tier)
 */

const DEFAULT_ALLOWED_COVERAGE = ['usable', 'good', 'excellent'];

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function assessPaperEarlyBreakout({
  chainName,
  strategyName,
  tokenData = {},
  evaluation = {},
  featureSnapshot = {},
  momentumState = {},
  settingsByChain = {},
} = {}) {
  const chainKey = String(chainName || '').toLowerCase();
  const settings = settingsByChain?.[chainKey] || null;
  const baseFail = (reason) => ({
    qualified: false,
    chain: chainKey,
    strategy: strategyName || null,
    reason,
    checks: {
      returnsConfirmed: false,
      persistenceConfirmed: false,
      volumeConfirmed: false,
      liquidityConfirmed: false,
      orderbookConfirmed: false,
      confluenceConfirmed: false,
      coverageConfirmed: false,
    },
  });

  if (!settings || settings.enabled === false) {
    return baseFail('disabled_for_chain');
  }

  const r1 = safeNum(featureSnapshot.return1Pct);
  const r3 = safeNum(featureSnapshot.return3Pct);
  const r12 = safeNum(featureSnapshot.return12Pct);
  const returnsConfirmed = r1 >= safeNum(settings.minReturn1Pct)
    && r3 >= safeNum(settings.minReturn3Pct)
    && r12 >= safeNum(settings.minReturn12Pct);

  const accel = safeNum(momentumState.accelerationScore);
  const streak = safeNum(momentumState.consecutiveStrongScans);
  const persistenceConfirmed = accel >= safeNum(settings.minAccelerationScore)
    && streak >= safeNum(settings.minConsecutiveStrongScans);

  const details = evaluation.details || {};
  const volumeSpike = safeNum(details.volumeSpike);
  const volumeConfirmed = volumeSpike >= safeNum(settings.minVolumeSpike);

  const liquidityUsd = safeNum(tokenData.liquidityUsd);
  const liquidityConfirmed = liquidityUsd >= safeNum(settings.minLiquidityUsd);

  const orderbook = details.orderbookAnalysis || {};
  const orderbookSignalStrength = safeNum(orderbook.signalStrength);
  const orderbookConfirmed = Boolean(orderbook.isBullish)
    && orderbookSignalStrength >= safeNum(settings.minOrderbookSignalStrength);

  const confluence = details.confluenceAnalysis || null;
  const confluenceConfirmed = !confluence
    || (safeNum(confluence.alignmentScore) >= safeNum(settings.minConfluenceScore)
        && (!confluence.signal || String(confluence.signal).toUpperCase() === 'BUY'));

  const priceChange24h = safeNum(tokenData.priceChange24h);
  const maxCap = safeNum(settings.maxPriceChange24hPct, Infinity);
  const withinPriceCap = priceChange24h <= maxCap;

  const featureBars = safeNum(details.modelFeatureBars);
  const allowedCoverage = Array.isArray(settings.allowedCoverage) && settings.allowedCoverage.length > 0
    ? settings.allowedCoverage
    : DEFAULT_ALLOWED_COVERAGE;
  const coverage = String(details.modelFeatureCoverage || '').toLowerCase();
  const coverageConfirmed = featureBars >= safeNum(settings.minFeatureBars)
    && (allowedCoverage.length === 0 || allowedCoverage.includes(coverage));

  const qualified = returnsConfirmed
    && persistenceConfirmed
    && volumeConfirmed
    && liquidityConfirmed
    && orderbookConfirmed
    && confluenceConfirmed
    && withinPriceCap
    && coverageConfirmed;

  return {
    qualified,
    chain: chainKey,
    strategy: strategyName || null,
    reason: qualified ? null : 'gate_failed',
    checks: {
      returnsConfirmed,
      persistenceConfirmed,
      volumeConfirmed,
      liquidityConfirmed,
      orderbookConfirmed,
      confluenceConfirmed,
      coverageConfirmed,
      withinPriceCap,
    },
    metrics: {
      return1Pct: r1,
      return3Pct: r3,
      return12Pct: r12,
      accelerationScore: accel,
      consecutiveStrongScans: streak,
      volumeSpike,
      liquidityUsd,
      orderbookSignalStrength,
      priceChange24h,
      featureBars,
      coverage,
    },
  };
}

module.exports = { assessPaperEarlyBreakout };
