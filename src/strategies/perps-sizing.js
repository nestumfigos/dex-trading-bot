'use strict';

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
  maintenanceMarginPct = 0.005,
  side = 'long',
  minLiquidationBufferMultiple = MIN_LIQUIDATION_BUFFER_MULTIPLE,
} = {}) {
  const equity = finitePositive(equityUsd, 'equityUsd');
  const entry = finitePositive(entryPrice, 'entryPrice');
  const stop = finitePositive(stopPrice, 'stopPrice');
  const lev = finitePositive(leverage, 'leverage');
  const riskFraction = finitePositive(riskPct, 'riskPct') / 100;
  const stopDistancePct = Math.abs(entry - stop) / entry;
  if (stopDistancePct <= 0) throw new Error('stopPrice must differ from entryPrice');
  if ((side === 'long' && stop >= entry) || (side === 'short' && stop <= entry)) {
    throw new Error('stopPrice is on the wrong side of entryPrice');
  }
  const maintenance = Number(maintenanceMarginPct);
  if (!Number.isFinite(maintenance) || maintenance < 0 || maintenance >= 1) {
    throw new Error('maintenanceMarginPct must be finite and between 0 and 1');
  }
  const liquidationMove = (1 / lev) - maintenance;
  if (liquidationMove <= 0) throw new Error('maintenance margin leaves no liquidation buffer');
  const notionalUsd = (equity * riskFraction) / stopDistancePct;
  const marginUsd = notionalUsd / lev;
  const liquidationPrice = side === 'long'
    ? entry * (1 - liquidationMove)
    : entry * (1 + liquidationMove);
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
    leverage: lev,
    riskUsd: equity * riskFraction,
    notionalUsd,
    marginUsd,
    liquidationPrice,
    liquidationBufferMultiple,
  };
}

module.exports = { calculatePaperPosition };
