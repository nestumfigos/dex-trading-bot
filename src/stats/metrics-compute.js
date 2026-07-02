'use strict';

const { getImplementedStrategyNames } = require('../strategies/deployment');

/**
 * Performance metrics computation — pure, dep-injected.
 *
 * Functions:
 *   - defaultStatsShape()              -> fresh stats object
 *   - ensureStatsShape(portfolio)      -> normalizes portfolio.stats + per-strategy
 *   - refreshPerformanceMetrics(portfolio) -> recomputes avgs / expectancy / profit factor
 *   - recordPortfolioSnapshot({ portfolio, telemetry, getSnapshot, reason })
 *
 * All operate on the portfolio object (mutating). No closure refs.
 */

function defaultStatsShape() {
  return {
    executions: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    totalSlippageBps: 0,
    slippageSamples: 0,
    avgSlippageBps: 0,
    skippedExitChecks: 0,
    exitErrorCount: 0,
  };
}

function ensureStatsShape(portfolio) {
  if (!portfolio) throw new Error('ensureStatsShape: portfolio required');

  portfolio.stats = {
    ...defaultStatsShape(),
    ...(portfolio.stats || {}),
  };

  portfolio.strategies = portfolio.strategies || {};
  const implementedStrategies = new Set(getImplementedStrategyNames());
  const positionStrategies = new Set(
    Object.values(portfolio.positions || {}).map((position) => String(position?.strategy || 'momentum'))
  );
  Object.keys(portfolio.strategies).forEach((strategyName) => {
    if (!implementedStrategies.has(strategyName) && !positionStrategies.has(strategyName)) {
      delete portfolio.strategies[strategyName];
    }
  });
  const strategyNames = new Set([
    ...implementedStrategies,
    ...positionStrategies,
  ]);
  strategyNames.forEach((strategyName) => {
    portfolio.strategies[strategyName] = portfolio.strategies[strategyName] || {};
    portfolio.strategies[strategyName].positions = {};
    portfolio.strategies[strategyName].trades = Array.isArray(portfolio.strategies[strategyName].trades)
      ? portfolio.strategies[strategyName].trades
      : [];
    portfolio.strategies[strategyName].stats = {
      ...defaultStatsShape(),
      ...(portfolio.strategies[strategyName].stats || {}),
    };
  });

  Object.entries(portfolio.positions || {}).forEach(([positionKey, position]) => {
    const strategyName = String(position?.strategy || 'momentum');
    if (!portfolio.strategies[strategyName]) return;
    portfolio.strategies[strategyName].positions[positionKey] = position;
  });
}

function refreshPerformanceMetrics(portfolio) {
  if (!portfolio) throw new Error('refreshPerformanceMetrics: portfolio required');
  ensureStatsShape(portfolio);

  const closedTrades = Number(portfolio.stats.closedTrades || 0);
  const wins = Number(portfolio.stats.wins || 0);
  const losses = Number(portfolio.stats.losses || 0);
  const grossProfit = Number(portfolio.stats.grossProfit || 0);
  const grossLoss = Number(portfolio.stats.grossLoss || 0);

  portfolio.stats.avgWinUsd = wins > 0 ? grossProfit / wins : 0;
  portfolio.stats.avgLossUsd = losses > 0 ? grossLoss / losses : 0;

  const winRate = closedTrades > 0 ? (wins / closedTrades) : 0;
  const lossRate = closedTrades > 0 ? (losses / closedTrades) : 0;
  portfolio.stats.expectancyUsd = (winRate * portfolio.stats.avgWinUsd) - (lossRate * portfolio.stats.avgLossUsd);

  if (grossLoss > 0) {
    portfolio.stats.profitFactor = grossProfit / grossLoss;
  } else {
    // null = "no losses yet" (mathematically undefined, not infinite)
    portfolio.stats.profitFactor = grossProfit > 0 ? null : 0;
  }

  const slippageSamples = Number(portfolio.stats.slippageSamples || 0);
  portfolio.stats.avgSlippageBps = slippageSamples > 0
    ? Number(portfolio.stats.totalSlippageBps || 0) / slippageSamples
    : 0;

  Object.keys(portfolio.strategies || {}).forEach((strategyName) => {
    const stats = portfolio.strategies?.[strategyName]?.stats;
    if (!stats) return;

    const sClosed = Number(stats.closedTrades || 0);
    const sWins = Number(stats.wins || 0);
    const sLosses = Number(stats.losses || 0);
    const sGrossProfit = Number(stats.grossProfit || 0);
    const sGrossLoss = Number(stats.grossLoss || 0);

    stats.avgWinUsd = sWins > 0 ? sGrossProfit / sWins : 0;
    stats.avgLossUsd = sLosses > 0 ? sGrossLoss / sLosses : 0;

    const sWinRate = sClosed > 0 ? (sWins / sClosed) : 0;
    const sLossRate = sClosed > 0 ? (sLosses / sClosed) : 0;
    stats.expectancyUsd = (sWinRate * stats.avgWinUsd) - (sLossRate * stats.avgLossUsd);

    if (sGrossLoss > 0) {
      stats.profitFactor = sGrossProfit / sGrossLoss;
    }

    const sSlipSamples = Number(stats.slippageSamples || 0);
    stats.avgSlippageBps = sSlipSamples > 0
      ? Number(stats.totalSlippageBps || 0) / sSlipSamples
      : 0;
  });
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePriceSeries(values, limit = 60) {
  return (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(-Math.max(2, Number(limit) || 60));
}

function calcReturns(prices) {
  const series = normalizePriceSeries(prices, prices?.length || 60);
  const returns = [];
  for (let i = 1; i < series.length; i += 1) {
    returns.push(Math.log(series[i] / series[i - 1]));
  }
  return returns;
}

function pearson(a, b) {
  const n = Math.min(Array.isArray(a) ? a.length : 0, Array.isArray(b) ? b.length : 0);
  if (n < 2) return null;
  const left = a.slice(-n);
  const right = b.slice(-n);
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denomLeft = 0;
  let denomRight = 0;
  for (let i = 0; i < n; i += 1) {
    const dl = left[i] - meanLeft;
    const dr = right[i] - meanRight;
    numerator += dl * dr;
    denomLeft += dl * dl;
    denomRight += dr * dr;
  }
  const denom = Math.sqrt(denomLeft * denomRight);
  return denom > 0 ? numerator / denom : null;
}

function candidateHistoryKeys(position = {}) {
  const chainKey = String(position.chainKey || position.chain || '').trim().toLowerCase();
  const address = String(position.address || '').trim().toLowerCase();
  const symbolRaw = String(position.symbol || '').trim();
  const symbolLower = symbolRaw.toLowerCase();
  const symbolUpper = symbolRaw.toUpperCase();
  return [
    position.strategyKey,
    chainKey && address ? `${chainKey}:${address}` : null,
    chainKey && symbolLower ? `${chainKey}:${symbolLower}` : null,
    chainKey && symbolUpper ? `${chainKey}:${symbolUpper}` : null,
    address || null,
    symbolLower || null,
    symbolUpper || null,
  ].filter(Boolean).map(String);
}

function resolvePriceHistory(position, priceHistories = {}) {
  for (const key of candidateHistoryKeys(position)) {
    if (Array.isArray(priceHistories[key])) return { key, prices: priceHistories[key] };
  }
  return null;
}

function buildExposureSnapshotRows({ snapshot = {}, reason = null, timestamp = null } = {}) {
  const ts = timestamp || new Date().toISOString();
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  return positions.map((position) => {
    const quantity = numberOrNull(position.quantity);
    const entryPrice = numberOrNull(position.entryPrice);
    const stopLoss = numberOrNull(position.stopLoss);
    const positionValueUsd = numberOrNull(position.positionValueUsd);
    const costBasisUsd = numberOrNull(position.costBasisUsd ?? position.initialSizeUsd);
    const riskUsd = (
      quantity != null
      && entryPrice != null
      && stopLoss != null
      && entryPrice > stopLoss
    )
      ? Math.max(0, (entryPrice - stopLoss) * quantity)
      : null;

    return {
      timestamp: ts,
      marketType: position.marketType || 'spot',
      symbol: position.symbol || null,
      strategy: position.strategy || 'momentum',
      exposureUsd: positionValueUsd,
      notionalUsd: costBasisUsd ?? positionValueUsd,
      riskUsd,
      leverage: numberOrNull(position.leverage),
      correlationBucket: position.correlationBucket || position.chainKey || position.symbol || null,
      details: {
        reason,
        chain: position.chain || null,
        chainKey: position.chainKey || null,
        address: position.address || null,
        entryPrice,
        currentPrice: numberOrNull(position.currentPrice),
        stopLoss,
        takeProfit: numberOrNull(position.takeProfit),
        unrealizedPnl: numberOrNull(position.unrealizedPnl),
        unrealizedPnlPct: numberOrNull(position.unrealizedPnlPct),
        estimatedRoundTripFeeUsd: numberOrNull(position.estimatedRoundTripFeeUsd),
      },
    };
  });
}

function buildCorrelationSnapshotRows({
  snapshot = {},
  priceHistories = {},
  reason = null,
  timestamp = null,
  lookbackBars = 60,
  minBars = 20,
} = {}) {
  const ts = timestamp || new Date().toISOString();
  const positions = Array.isArray(snapshot.positions) ? snapshot.positions : [];
  const withHistory = positions
    .map((position) => {
      const resolved = resolvePriceHistory(position, priceHistories);
      const prices = normalizePriceSeries(resolved?.prices, lookbackBars);
      return {
        position,
        historyKey: resolved?.key || null,
        prices,
        returns: calcReturns(prices),
      };
    })
    .filter((row) => row.historyKey && row.prices.length >= minBars && row.returns.length >= Math.max(2, minBars - 1));

  const rows = [];
  for (let i = 0; i < withHistory.length; i += 1) {
    for (let j = i + 1; j < withHistory.length; j += 1) {
      const left = withHistory[i];
      const right = withHistory[j];
      const correlation = pearson(left.returns, right.returns);
      if (!Number.isFinite(correlation)) continue;
      const assetA = left.position.symbol || left.position.address || left.historyKey;
      const assetB = right.position.symbol || right.position.address || right.historyKey;
      if (!assetA || !assetB || assetA === assetB) continue;
      rows.push({
        timestamp: ts,
        assetA,
        assetB,
        correlation,
        lookbackMinutes: null,
        source: 'strategy.priceHistory',
        details: {
          reason,
          lookbackBars,
          samples: Math.min(left.returns.length, right.returns.length),
          leftHistoryKey: left.historyKey,
          rightHistoryKey: right.historyKey,
          leftStrategy: left.position.strategy || null,
          rightStrategy: right.position.strategy || null,
        },
      });
    }
  }
  return rows;
}

function recordPortfolioSnapshot({
  portfolio,
  telemetry,
  getSnapshot,
  reason,
  maxHistory = 240,
  priceHistories = null,
  correlationLookbackBars = 60,
  correlationMinBars = 20,
}) {
  if (!portfolio) throw new Error('recordPortfolioSnapshot: portfolio required');
  if (typeof getSnapshot !== 'function') throw new Error('recordPortfolioSnapshot: getSnapshot required');

  const snapshot = getSnapshot();
  const point = {
    timestamp: new Date().toISOString(),
    cash: snapshot.cashBalance,
    equity: snapshot.equity,
    totalPnl: snapshot.totalPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
    reason,
  };
  portfolio.pnlHistory = Array.isArray(portfolio.pnlHistory) ? portfolio.pnlHistory : [];
  portfolio.pnlHistory.push(point);
  if (telemetry && typeof telemetry.logPnlPoint === 'function') {
    telemetry.logPnlPoint(point);
  }
  if (telemetry && typeof telemetry.logPortfolioExposureSnapshot === 'function') {
    buildExposureSnapshotRows({ snapshot, reason, timestamp: point.timestamp })
      .forEach((row) => telemetry.logPortfolioExposureSnapshot(row));
  }
  if (telemetry && typeof telemetry.logCorrelationSnapshot === 'function' && priceHistories) {
    buildCorrelationSnapshotRows({
      snapshot,
      priceHistories,
      reason,
      timestamp: point.timestamp,
      lookbackBars: correlationLookbackBars,
      minBars: correlationMinBars,
    }).forEach((row) => telemetry.logCorrelationSnapshot(row));
  }

  if (portfolio.pnlHistory.length > maxHistory) {
    portfolio.pnlHistory.shift();
  }
  return point;
}

module.exports = {
  defaultStatsShape,
  ensureStatsShape,
  refreshPerformanceMetrics,
  buildExposureSnapshotRows,
  buildCorrelationSnapshotRows,
  recordPortfolioSnapshot,
};
