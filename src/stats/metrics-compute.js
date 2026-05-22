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

function recordPortfolioSnapshot({ portfolio, telemetry, getSnapshot, reason, maxHistory = 240 }) {
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

  if (portfolio.pnlHistory.length > maxHistory) {
    portfolio.pnlHistory.shift();
  }
  return point;
}

module.exports = {
  defaultStatsShape,
  ensureStatsShape,
  refreshPerformanceMetrics,
  recordPortfolioSnapshot,
};
