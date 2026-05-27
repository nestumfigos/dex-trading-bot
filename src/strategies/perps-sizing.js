'use strict';

const { resolveMaintenanceMarginPct } = require('./perps-maintenance-margin');

function finitePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

// B1P.3: minimum liquidation buffer multiple. Spec PERPS_BOOTSTRAP D.8 requires
// liquidationBufferPct >= 2.0. Enforced inside calculatePaperPosition so it
// refuses to return a position object that breaches the floor — making downstream
// gates (paper-perps-adapter, perps-gates) redundant defense, not sole defense.
const MIN_LIQUIDATION_BUFFER_MULTIPLE = 2.0;

function calculatePaperPosition({
  equityUsd,
  riskPct,
  entryPrice,
  stopPrice,
  leverage = 1,
  maintenanceMarginPct = null,
  side = 'long',
  symbol = null,
  notionalUsdHint = null,
  marginMode = 'isolated',
  markPrice = null,
  minLiquidationBufferMultiple = MIN_LIQUIDATION_BUFFER_MULTIPLE,
} = {}) {
  // B5P.6: cross-margin assertion. Defensive duplicate of perps-gates check —
  // we refuse to even build a sized position object under cross. Avoids any
  // chance that a future caller skips the gate and passes the result straight
  // into adapter.openPosition.
  if (marginMode !== 'isolated') {
    throw new Error('marginMode must be isolated (cross not supported)');
  }
  const equity = finitePositive(equityUsd, 'equityUsd');
  const entry = finitePositive(entryPrice, 'entryPrice');
  const stop = finitePositive(stopPrice, 'stopPrice');
  const lev = finitePositive(leverage, 'leverage');
  const riskFraction = finitePositive(riskPct, 'riskPct') / 100;
  // B5P.5: use markPrice for stop-distance and sizing math when the caller
  // supplied a fresh markPrice. Falls back to entryPrice if unavailable —
  // legacy behavior preserved when paper-driver has no WS markPrice feed.
  const referencePrice = (Number.isFinite(Number(markPrice)) && Number(markPrice) > 0)
    ? Number(markPrice)
    : entry;
  const stopDistancePct = Math.abs(referencePrice - stop) / referencePrice;
  if (stopDistancePct <= 0) throw new Error('stopPrice must differ from referencePrice');
  if ((side === 'long' && stop >= referencePrice) || (side === 'short' && stop <= referencePrice)) {
    throw new Error('stopPrice is on the wrong side of referencePrice');
  }
  // B5P.4: per-symbol maintenance margin. If the caller passed an explicit
  // value, validate it (preserve legacy reject-on-malformed behavior). Only
  // when MM is null/undefined (caller deferred to us) do we look up the
  // leverage-tier-aware default for `symbol` and candidate notional.
  let maintenance;
  if (maintenanceMarginPct === null || maintenanceMarginPct === undefined) {
    const tentativeNotional = (equity * riskFraction) / stopDistancePct;
    maintenance = resolveMaintenanceMarginPct({
      symbol,
      notionalUsd: Number(notionalUsdHint) > 0 ? Number(notionalUsdHint) : tentativeNotional,
      leverage: lev,
    });
  } else {
    maintenance = Number(maintenanceMarginPct);
  }
  if (!Number.isFinite(maintenance) || maintenance < 0 || maintenance >= 1) {
    throw new Error('maintenanceMarginPct must be finite and between 0 and 1');
  }
  const liquidationMove = (1 / lev) - maintenance;
  if (liquidationMove <= 0) throw new Error('maintenance margin leaves no liquidation buffer');
  const notionalUsd = (equity * riskFraction) / stopDistancePct;
  const marginUsd = notionalUsd / lev;
  // B5P.5: liquidation price anchored at the reference (mark when available).
  const liquidationPrice = side === 'long'
    ? referencePrice * (1 - liquidationMove)
    : referencePrice * (1 + liquidationMove);
  const liquidationBufferMultiple = Math.abs(liquidationPrice - entry) / Math.abs(stop - entry);
  // B1P.3: pre-open hard floor. Refuse to return any sized position that breaches the
  // liquidation-buffer spec floor (default 2.0×). Caller surfaces the rejection reason.
  if (!Number.isFinite(liquidationBufferMultiple) || liquidationBufferMultiple < minLiquidationBufferMultiple) {
    throw new Error(`liquidation_buffer_below_${minLiquidationBufferMultiple}x_stop`);
  }
  return {
    side,
    equityUsd: equity,
    entryPrice: entry,
    stopPrice: stop,
    referencePrice,            // B5P.5: surface which price drove sizing
    markPriceUsed: referencePrice !== entry,
    leverage: lev,
    marginMode,
    maintenanceMarginPct: maintenance,
    riskUsd: equity * riskFraction,
    notionalUsd,
    marginUsd,
    liquidationPrice,
    liquidationBufferMultiple,
  };
}

module.exports = { calculatePaperPosition };
