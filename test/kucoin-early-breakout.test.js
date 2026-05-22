'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessKucoinEarlyBreakout } = require('../src/utils/kucoin-early-breakout');

test('kucoin early breakout qualifies on short-horizon strength with persistence', () => {
  const result = assessKucoinEarlyBreakout({
    chainName: 'kucoin',
    strategyName: 'momentum',
    tokenData: {
      priceChange24h: 18,
      liquidityUsd: 250000,
      volume24h: 400000,
    },
    evaluation: {
      details: {
        volumeSpike: 1.9,
        orderbookAnalysis: { isBullish: true, signalStrength: 22 },
        confluenceAnalysis: { alignmentScore: 61, signal: 'BUY' },
      },
    },
    featureSnapshot: {
      return1Pct: 0.35,
      return3Pct: 1.2,
      return12Pct: 2.6,
    },
    momentumState: {
      accelerationScore: 3.5,
      consecutiveStrongScans: 2,
    },
    settings: {
      enabled: true,
      minReturn1Pct: 0.2,
      minReturn3Pct: 0.8,
      minReturn12Pct: 1.8,
      minVolumeSpike: 1.5,
      minAccelerationScore: 1.0,
      minConsecutiveStrongScans: 2,
      minLiquidityUsd: 100000,
      minOrderbookSignalStrength: 12,
      minConfluenceScore: 45,
      maxPriceChange24hPct: 55,
    },
  });

  assert.equal(result.qualified, true);
  assert.equal(result.checks.returnsConfirmed, true);
  assert.equal(result.checks.persistenceConfirmed, true);
});

test('kucoin early breakout rejects weak persistence even with positive returns', () => {
  const result = assessKucoinEarlyBreakout({
    chainName: 'kucoin',
    strategyName: 'momentum',
    tokenData: {
      priceChange24h: 15,
      liquidityUsd: 250000,
      volume24h: 400000,
    },
    evaluation: {
      details: {
        volumeSpike: 1.8,
        orderbookAnalysis: { isBullish: true, signalStrength: 18 },
      },
    },
    featureSnapshot: {
      return1Pct: 0.3,
      return3Pct: 1.0,
      return12Pct: 2.4,
    },
    momentumState: {
      accelerationScore: 2.2,
      consecutiveStrongScans: 1,
    },
    settings: {
      enabled: true,
      minReturn1Pct: 0.2,
      minReturn3Pct: 0.8,
      minReturn12Pct: 1.8,
      minVolumeSpike: 1.5,
      minAccelerationScore: 1.0,
      minConsecutiveStrongScans: 2,
      minLiquidityUsd: 100000,
      minOrderbookSignalStrength: 12,
      minConfluenceScore: 45,
      maxPriceChange24hPct: 55,
    },
  });

  assert.equal(result.qualified, false);
  assert.equal(result.checks.persistenceConfirmed, false);
});
