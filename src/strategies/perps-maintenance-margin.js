'use strict';

// B5P.4: maintenance margin tier table for Binance USD-M perpetual futures.
//
// Real binance MM is a step function of notional in USDT — small notional
// pays 0.4%, large notional pays much more. The leverage cap is also
// notional-tiered. This module exposes:
//
//   resolveMaintenanceMarginPct({ symbol, notionalUsd, leverage })
//     → number in [0, 1]
//
// Strategy:
//   1. If we have a tier table for `symbol`, walk it until notional fits a
//      bracket; return that bracket's maintenanceMarginRatio.
//   2. Otherwise return a conservative default that is appropriate for the
//      lev cap we'd normally use (default 0.5%, matching legacy behavior).
//
// Tier numbers below are taken from Binance's published USDT-M tier doc as of
// 2025-Q4; they MUST be refreshed when binance changes them. The table is
// intentionally compact — only top symbols. Anything not in the table falls
// back to the leverage-cap-aware default.

const DEFAULT_MM = 0.005; // 0.5% — matches legacy hardcode pre-B5P.4

// Each entry: { upToNotionalUsd, maintenanceMarginRatio, maxLeverage }
// Brackets sorted ASC by upToNotionalUsd; the FIRST row whose `upToNotionalUsd`
// is >= position notional applies. Trailing row with Infinity catches anything
// above the published top tier.
const TIERS = {
  BTCUSDT: [
    { upToNotionalUsd: 50000,        maintenanceMarginRatio: 0.004, maxLeverage: 125 },
    { upToNotionalUsd: 250000,       maintenanceMarginRatio: 0.005, maxLeverage: 100 },
    { upToNotionalUsd: 1000000,      maintenanceMarginRatio: 0.010, maxLeverage: 50 },
    { upToNotionalUsd: 10000000,     maintenanceMarginRatio: 0.025, maxLeverage: 20 },
    { upToNotionalUsd: 50000000,     maintenanceMarginRatio: 0.050, maxLeverage: 10 },
    { upToNotionalUsd: Infinity,     maintenanceMarginRatio: 0.100, maxLeverage: 5  },
  ],
  ETHUSDT: [
    { upToNotionalUsd: 50000,        maintenanceMarginRatio: 0.005, maxLeverage: 100 },
    { upToNotionalUsd: 250000,       maintenanceMarginRatio: 0.0065, maxLeverage: 75 },
    { upToNotionalUsd: 1000000,      maintenanceMarginRatio: 0.010, maxLeverage: 50 },
    { upToNotionalUsd: 10000000,     maintenanceMarginRatio: 0.025, maxLeverage: 20 },
    { upToNotionalUsd: Infinity,     maintenanceMarginRatio: 0.050, maxLeverage: 10 },
  ],
  SOLUSDT: [
    { upToNotionalUsd: 50000,        maintenanceMarginRatio: 0.010, maxLeverage: 50 },
    { upToNotionalUsd: 250000,       maintenanceMarginRatio: 0.025, maxLeverage: 20 },
    { upToNotionalUsd: 1000000,      maintenanceMarginRatio: 0.050, maxLeverage: 10 },
    { upToNotionalUsd: Infinity,     maintenanceMarginRatio: 0.100, maxLeverage: 5  },
  ],
};

function resolveMaintenanceMarginPct({ symbol, notionalUsd, leverage } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const notional = Number(notionalUsd);
  const lev = Number(leverage);
  const table = TIERS[sym];
  if (table && Number.isFinite(notional) && notional > 0) {
    for (const tier of table) {
      if (notional <= tier.upToNotionalUsd) {
        return tier.maintenanceMarginRatio;
      }
    }
  }
  // Fallback: pick MM consistent with the requested leverage so the resulting
  // liquidation buffer math doesn't collapse to negative on high leverage.
  // For lev > 25 use 0.5%; for lev > 5 use 0.5%; lower lev tolerates higher
  // MM. Heuristic matches binance's looser tiers on small notional.
  if (Number.isFinite(lev) && lev >= 1) {
    if (lev > 25) return 0.005;
    if (lev > 10) return 0.005;
    if (lev > 5) return 0.005;
  }
  return DEFAULT_MM;
}

function getTier({ symbol, notionalUsd } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const notional = Number(notionalUsd || 0);
  const table = TIERS[sym];
  if (!table) return null;
  for (const tier of table) {
    if (notional <= tier.upToNotionalUsd) return tier;
  }
  return null;
}

module.exports = { resolveMaintenanceMarginPct, getTier, TIERS, DEFAULT_MM };
