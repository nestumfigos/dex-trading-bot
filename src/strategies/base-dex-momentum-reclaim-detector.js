'use strict';

const { detectBullFlag } = require('./bull-flag-detector');

function num(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function detectBaseDexMomentumReclaim({ tokenData = {}, candles = [], config = {} } = {}) {
  const liquidityUsd = num(tokenData.liquidityUsd);
  const volumeSpike = num(tokenData.volumeSpike ?? tokenData.volumeSpikeRatio);
  const minLiquidityUsd = num(config.minLiquidityUsd, 1_000_000);
  const minVolumeSpike = num(config.volumeSpikeMultiplier, 2.5);
  if (liquidityUsd < minLiquidityUsd) {
    return { qualifies: false, signal: 'HOLD', setupType: 'base_dex_momentum_reclaim', reasons: ['liquidity_below_base_floor'], liquidityUsd };
  }
  if (volumeSpike < minVolumeSpike) {
    return { qualifies: false, signal: 'HOLD', setupType: 'base_dex_momentum_reclaim', reasons: ['volume_expansion_below_base_floor'], volumeSpike };
  }

  const flag = Array.isArray(candles) && candles.length
    ? detectBullFlag(candles, {
      polePctMin: num(config.polePctMin, 5),
      breakoutVolMinRatio: minVolumeSpike,
      flagDepthMaxPct: num(config.flagDepthMaxPct, 50),
      latestVolumeMinRatio: 0,
      minSixtyMinuteMovePct: 0,
      maxSixtyMinuteMovePct: 0,
    })
    : { qualifies: false };
  if (flag.qualifies) {
    return {
      ...flag,
      signal: 'BUY',
      setupType: 'base_dex_momentum_reclaim',
      structureType: 'base_bull_flag',
      reasons: ['base_liquidity_floor', 'base_tighter_volume_expansion', 'bull_flag_breakout'],
    };
  }

  const supportPrice = num(tokenData.supportPrice || tokenData.localSupportPrice);
  const price = num(tokenData.price);
  const sweptSupport = num(tokenData.supportSweepPct) > 0 || (supportPrice > 0 && num(tokenData.low24h || tokenData.recentLow) < supportPrice * 0.995);
  const reclaimed = supportPrice > 0 ? price > supportPrice : tokenData.reclaimedSupport === true;
  if (sweptSupport && reclaimed) {
    return {
      qualifies: true,
      signal: 'BUY',
      setupType: 'base_dex_momentum_reclaim',
      structureType: 'base_support_reclaim',
      entryPrice: price,
      stopPrice: supportPrice > 0 ? supportPrice * 0.97 : null,
      targetPrice: price > 0 ? price * 1.3 : null,
      volumeExpansion: volumeSpike,
      reasons: ['base_liquidity_floor', 'support_sweep', 'volume_reclaim'],
    };
  }

  return { qualifies: false, signal: 'HOLD', setupType: 'base_dex_momentum_reclaim', reasons: ['no_base_flag_or_reclaim'] };
}

module.exports = { detectBaseDexMomentumReclaim };
