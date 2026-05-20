'use strict';

// Pure helpers + slippage recorder extracted from src/index.js (Week 12 A.1).
// recordSlippageSample needs portfolio/logger/ensureStatsShape -> factory wraps it.

function calcSlippageBps(expectedPrice, realizedPrice) {
  const expected = Number(expectedPrice || 0);
  const realized = Number(realizedPrice || 0);
  if (!Number.isFinite(expected) || !Number.isFinite(realized) || expected <= 0 || realized <= 0) {
    return null;
  }
  return Math.abs(((realized - expected) / expected) * 10000);
}

function extractExecutionPriceUsd(txResult, fallbackPrice) {
  const candidates = [
    txResult?.executedPriceUsd,
    txResult?.avgPrice,
    txResult?.averagePrice,
    txResult?.price,
    txResult?.limitPrice,
    fallbackPrice,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length ? candidates[0] : Number(fallbackPrice || 0);
}

function extractFilledBaseQty(txResult, fallbackQty = 0) {
  const candidates = [
    txResult?.filledBaseQty,
    txResult?.filledQuantity,
    txResult?.filledQty,
    txResult?.executedBaseQty,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  if (candidates.length) return candidates[0];
  return Number(fallbackQty || 0);
}

function extractFilledQuoteUsd(txResult, fallbackUsd = 0) {
  const candidates = [
    txResult?.filledQuoteUsd,
    txResult?.filledQuoteQty,
    txResult?.executedQuoteUsd,
    txResult?.cost,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  if (candidates.length) return candidates[0];
  return Number(fallbackUsd || 0);
}

function calcDiscrepancyPct(requestedValue, filledValue) {
  const requested = Number(requestedValue || 0);
  const filled = Number(filledValue || 0);
  if (!Number.isFinite(requested) || requested <= 0 || !Number.isFinite(filled) || filled <= 0) {
    return null;
  }
  return ((filled - requested) / requested) * 100;
}

function createSlippageRecorder({ portfolio, logger, ensureStatsShape }) {
  return function recordSlippageSample(strategyName, slippageBps) {
    const bps = Number(slippageBps);
    if (!Number.isFinite(bps)) return;

    ensureStatsShape();
    portfolio.stats.totalSlippageBps += bps;
    portfolio.stats.slippageSamples += 1;

    const strategyStats = portfolio.strategies?.[strategyName]?.stats;
    if (!strategyStats) {
      logger.warn(`recordSlippageSample: missing strategy stats bucket for ${strategyName}`);
      return;
    }

    strategyStats.totalSlippageBps += bps;
    strategyStats.slippageSamples += 1;
  };
}

module.exports = {
  calcSlippageBps,
  extractExecutionPriceUsd,
  extractFilledBaseQty,
  extractFilledQuoteUsd,
  calcDiscrepancyPct,
  createSlippageRecorder,
};
