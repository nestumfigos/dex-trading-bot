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
    const minSources = Math.max(2, num(cfg.minFreshSources, 2));
    const maxSourceAgeMs = num(cfg.maxSourceAgeMs, 120_000);

    const liquidityUsd = num(tokenData.liquidityUsd);
    if (liquidityUsd < minLiquidityUsd) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['liquidity_below_solana_floor'], liquidityUsd } };
    }
    const expectedSlippagePct = num(tokenData.expectedSlippagePct ?? (num(tokenData.expectedSlippageBps) / 100));
    if (expectedSlippagePct > maxSlippagePct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['slippage_above_solana_cap'], expectedSlippagePct } };
    }
    const topHoldersPct = num(tokenData.topHoldersPct);
    if (topHoldersPct > maxTop10HoldersPct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['top10_holder_concentration_above_max'], topHoldersPct } };
    }
    const buyRatio = num(tokenData.buyRatioRecentPct ?? tokenData.buyRatio10mPct);
    if (buyRatio < minBuyRatioPct) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['buy_flow_ratio_below_min'], buyRatioRecentPct: buyRatio } };
    }
    if (sourceCount(tokenData) < minSources || staleSource(tokenData, maxSourceAgeMs)) {
      return { signal: 'HOLD', details: { setupType: 'solana_bull_flag_v2', scannerReasons: ['fresh_multisource_data_required'], sourceCount: sourceCount(tokenData) } };
    }

    const result = await base.evaluate(tokenData, { config: { ...cfg, enabledChains: ['solana'] }, chainKey: 'solana' });
    return {
      signal: result.signal,
      details: {
        ...result.details,
        setupType: 'solana_bull_flag_v2',
        structureType: result.signal === 'BUY' ? 'solana_bull_flag_v2' : null,
        maxSlippagePct,
        topHoldersPct,
        buyRatioRecentPct: buyRatio,
        sourceCount: sourceCount(tokenData),
      },
    };
  }

  return { evaluate };
}

module.exports = { createSolanaBullFlagEvaluator };
