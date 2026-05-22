'use strict';

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assessKucoinEarlyBreakout({
  chainName,
  strategyName,
  tokenData = {},
  evaluation = {},
  featureSnapshot = {},
  momentumState = {},
  settings = {},
} = {}) {
  const enabled = settings.enabled !== false;
  const applicable = enabled
    && String(chainName || '').toLowerCase() === 'kucoin'
    && String(strategyName || '').toLowerCase() === 'momentum';
  if (!applicable) {
    return { qualified: false, confidence: 0, checks: { applicable: false, enabled } };
  }

  const priceChange24h = Math.abs(safeNumber(tokenData.priceChange24h, safeNumber(evaluation?.details?.priceChange24h, 0)));
  const return1Pct = safeNumber(featureSnapshot.return1Pct, 0);
  const return3Pct = safeNumber(featureSnapshot.return3Pct, 0);
  const return12Pct = safeNumber(featureSnapshot.return12Pct, 0);
  const volumeSpike = safeNumber(evaluation?.details?.volumeSpike, safeNumber(tokenData.volumeSpike, 0));
  const accelerationScore = safeNumber(momentumState.accelerationScore, 0);
  const consecutiveStrongScans = safeNumber(momentumState.consecutiveStrongScans, 0);
  const liquidityUsd = Math.max(
    safeNumber(tokenData.liquidityUsd, 0),
    safeNumber(tokenData.volume24h, 0),
    safeNumber(tokenData.quoteVolume, 0)
  );
  const orderbook = evaluation?.details?.orderbookAnalysis || null;
  const confluence = evaluation?.details?.confluenceAnalysis || null;

  const returnsConfirmed =
    return1Pct >= safeNumber(settings.minReturn1Pct, 0.2)
    && return3Pct >= safeNumber(settings.minReturn3Pct, 0.8)
    && return12Pct >= safeNumber(settings.minReturn12Pct, 1.8)
    && return12Pct >= return3Pct
    && return3Pct >= Math.max(return1Pct * safeNumber(settings.return3To1RatioFloor, 0.7), safeNumber(settings.minReturn3Pct, 0.8));

  const volumeConfirmed = volumeSpike >= safeNumber(settings.minVolumeSpike, 1.5);
  const accelerationConfirmed = accelerationScore >= safeNumber(settings.minAccelerationScore, 1.0);
  const persistenceConfirmed = consecutiveStrongScans >= safeNumber(settings.minConsecutiveStrongScans, 2);
  const liquidityConfirmed = liquidityUsd >= safeNumber(settings.minLiquidityUsd, 100000);
  const max24hMoveConfirmed = priceChange24h <= safeNumber(settings.maxPriceChange24hPct, 55);
  const orderbookConfirmed = !orderbook
    || (orderbook.isBullish === true && safeNumber(orderbook.signalStrength, 0) >= safeNumber(settings.minOrderbookSignalStrength, 12));
  const confluenceConfirmed = !confluence
    || safeNumber(confluence.alignmentScore, 0) >= safeNumber(settings.minConfluenceScore, 45)
    || String(confluence.signal || '').toUpperCase() === 'BUY';

  const qualified = returnsConfirmed
    && volumeConfirmed
    && accelerationConfirmed
    && persistenceConfirmed
    && liquidityConfirmed
    && max24hMoveConfirmed
    && orderbookConfirmed
    && confluenceConfirmed;

  const confidence = Math.max(0, Math.min(0.95,
    0.38
    + Math.min(0.12, return1Pct / 5)
    + Math.min(0.15, return3Pct / 10)
    + Math.min(0.12, return12Pct / 15)
    + Math.min(0.10, Math.max(0, volumeSpike - 1) * 0.20)
    + Math.min(0.10, accelerationScore / 15)
    + Math.min(0.08, Math.max(0, consecutiveStrongScans - 1) * 0.04)
    + (orderbookConfirmed ? 0.05 : 0)
    + (confluenceConfirmed ? 0.05 : 0)
  ));

  return {
    qualified,
    confidence,
    checks: {
      applicable: true,
      returnsConfirmed,
      volumeConfirmed,
      accelerationConfirmed,
      persistenceConfirmed,
      liquidityConfirmed,
      orderbookConfirmed,
      confluenceConfirmed,
      max24hMoveConfirmed,
      return1Pct,
      return3Pct,
      return12Pct,
      volumeSpike,
      accelerationScore,
      consecutiveStrongScans,
      liquidityUsd,
      priceChange24h,
      orderbookSignalStrength: safeNumber(orderbook?.signalStrength, 0),
      confluenceAlignmentScore: safeNumber(confluence?.alignmentScore, 0),
    },
  };
}

module.exports = {
  assessKucoinEarlyBreakout,
};
