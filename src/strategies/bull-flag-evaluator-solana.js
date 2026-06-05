'use strict';

const { createBullFlagEvaluator } = require('./bull-flag-evaluator');
const { detectBullFlag } = require('./bull-flag-detector');

function num(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sourceCount(tokenData = {}) {
  if (Array.isArray(tokenData.dataSources)) return tokenData.dataSources.length;
  let count = 0;
  if (tokenData.birdeyeUpdatedAt || tokenData.birdeyeSource === true) count += 1;
  if (tokenData.dexscreenerUpdatedAt || tokenData.dexscreenerSource === true) count += 1;
  return count;
}

function staleSource(tokenData = {}, maxAgeMs) {
  const ages = [
    tokenData.birdeyeAgeMs,
    tokenData.dexscreenerAgeMs,
    tokenData.sourceAgeMs,
  ].map(Number).filter(Number.isFinite);
  return ages.length > 0 && Math.max(...ages) > maxAgeMs;
}

function createSolanaBullFlagEvaluator({ logger, fetchOhlcv, detector = detectBullFlag } = {}) {
  const base = createBullFlagEvaluator({ logger, fetchOhlcv, detectBullFlag: detector });

  async function evaluate(tokenData = {}, options = {}) {
    const cfg = options.config || {};
    const minLiquidityUsd = num(cfg.minLiquidityUsd, 500_000);
    const maxSlippagePct = num(cfg.maxSlippagePct, 1.5);
    const maxTop10HoldersPct = num(cfg.maxTop10HoldersPct, 30);
    const minBuyRatioPct = num(cfg.minBuyRatioRecentPct, 60);
    const minNetBuyFlowUsd = num(cfg.minNetBuyFlowUsd, 4000);
    const minSources = Math.max(1, num(cfg.minFreshSources, 2));
    const maxSourceAgeMs = num(cfg.maxSourceAgeMs, 120_000);
    const maxPriceImpactPct = num(cfg.maxPriceImpactPct, 1.8);

    const liquidityUsd = num(tokenData.liquidityUsd);
    if (liquidityUsd < minLiquidityUsd) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['liquidity_below_solana_floor'], liquidityUsd } };
    }
    const expectedSlippagePct = num(tokenData.expectedSlippagePct ?? (num(tokenData.expectedSlippageBps) / 100));
    if (expectedSlippagePct > maxSlippagePct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['slippage_above_solana_cap'], expectedSlippagePct } };
    }
    const expectedPriceImpactPct = num(tokenData.expectedPriceImpactPct ?? tokenData.priceImpactPct ?? tokenData.quotedPriceImpactPct);
    if (expectedPriceImpactPct > maxPriceImpactPct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['price_impact_above_solana_cap'], expectedPriceImpactPct } };
    }
    const topHoldersPct = num(tokenData.topHoldersPct);
    if (topHoldersPct > maxTop10HoldersPct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['top10_holder_concentration_above_max'], topHoldersPct } };
    }
    const buyRatio = num(tokenData.buyRatioRecentPct ?? tokenData.buyRatio10mPct);
    if (buyRatio < minBuyRatioPct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['buy_flow_ratio_below_min'], buyRatioRecentPct: buyRatio } };
    }
    const netBuyFlowUsd = num(tokenData.netBuyFlowUsd10m ?? tokenData.netBuyFlowUsd ?? tokenData.netBuyFlow5mUsd, NaN);
    if (!Number.isFinite(netBuyFlowUsd) || netBuyFlowUsd < minNetBuyFlowUsd) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['net_buy_flow_below_solana_min'], netBuyFlowUsd } };
    }
    if (sourceCount(tokenData) < minSources || staleSource(tokenData, maxSourceAgeMs)) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['fresh_multisource_data_required'], sourceCount: sourceCount(tokenData) } };
    }

    const result = await base.evaluate(
      {
        ...tokenData,
        expectedSlippageBps: Math.round(expectedSlippagePct * 100),
        expectedFeesBps: num(tokenData.expectedFeesBps ?? cfg.expectedFeesBps, 10),
      },
      {
        config: {
          ...cfg,
          setupType: 'solana_bull_flag_v2',
          enabledChains: ['solana'],
          minNetEdgePct: num(cfg.minNetEdgePct, 4),
          minRR: num(cfg.minRR, 2.2),
          maxStopDistancePct: num(cfg.maxStopDistancePct, 5),
          minSixtyMinuteMovePct: num(cfg.minSixtyMinuteMovePct, 5),
          maxSixtyMinuteMovePct: num(cfg.maxSixtyMinuteMovePct, 18),
          latestVolumeMinRatio: num(cfg.latestVolumeMinRatio, 1.8),
          latestVolumeLookbackCandles: num(cfg.latestVolumeLookbackCandles, 20),
          timeframes: Array.isArray(cfg.timeframes) && cfg.timeframes.length ? cfg.timeframes : ['15m', '5m'],
        },
        chainKey: 'solana',
      }
    );
    return {
      signal: result.signal,
      details: {
        ...result.details,
        setupType: 'solana_bull_flag_v2',
        structureType: result.signal === 'BUY' ? 'solana_bull_flag_v2' : null,
        maxSlippagePct,
        maxPriceImpactPct,
        expectedPriceImpactPct,
        topHoldersPct,
        buyRatioRecentPct: buyRatio,
        netBuyFlowUsd,
        sourceCount: sourceCount(tokenData),
      },
    };
  }

  return { evaluate };
}

module.exports = { createSolanaBullFlagEvaluator };
