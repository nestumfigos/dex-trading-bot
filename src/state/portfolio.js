'use strict';

/**
 * Portfolio factory — pure, config-driven (Week 10.1 state split).
 *
 * Constructs a fresh portfolio object with the canonical shape used throughout
 * src/index.js. After construction, state loading (state-persistence.js) may
 * overwrite fields with persisted snapshot data; this factory provides the
 * baseline shape so loaders can `Object.assign(portfolio, loaded)` safely.
 *
 * Stats baseline reuses metrics-compute.defaultStatsShape() so the schema
 * stays in lockstep with the compute layer (single source of truth).
 *
 * Usage:
 *   const { createPortfolio } = require('./state/portfolio');
 *   const portfolio = createPortfolio(config);
 *
 * Behavior preserved byte-identical from src/index.js inline literal.
 */

const { defaultStatsShape } = require('../stats/metrics-compute');
const { getImplementedStrategyNames } = require('../strategies/deployment');

function makeStrategyBuckets() {
  return Object.fromEntries(getImplementedStrategyNames().map((strategyName) => [
    strategyName,
    {
      positions: {},
      trades: [],
      stats: defaultStatsShape(),
    },
  ]));
}

function createPortfolio(config = {}) {
  const startingBalance = config.paperTrading ? Number(config.paperBalance || 0) : 0;

  return {
    startingBalance,
    balance: startingBalance,
    walletBalanceUsd: null,
    walletBalancesUsd: {
      solana: null,
      bsc: null,
      base: null,
      kucoin: null,
    },
    statePersistenceError: false,
    safeMode: false,
    saveFailureCount: 0,
    stateReconciliation: {
      lastRunAt: null,
      discrepancies: [],
    },
    balanceDrift: { amountUsd: 0, pct: 0 },
    balanceDriftHalt: false,
    executionJournal: {},
    positions: {}, // All open positions tracked by tokenKey
    trades: [],    // All trades

    // Separate tracking per strategy
    strategies: makeStrategyBuckets(),

    // Aggregate stats (both strategies combined)
    stats: defaultStatsShape(),
    learning: {
      badTokenMemory: {},
      sleevePerformance: {},
    },
    pnlHistory: [],
  };
}

module.exports = { createPortfolio };
