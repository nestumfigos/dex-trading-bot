'use strict';

const { randomUUID } = require('crypto');

// B1P.8: idempotency. Every reduce-only exit carries a clientOrderId. Caller may
// supply one (for retry-safe replay of the same logical exit) or accept a fresh
// UUID. Live binance-perps adapter must forward this value as `newClientOrderId`
// so retries on 429/5xx do not double-fill.
function buildReduceOnlyExit({ position, notionalUsd, price, reason = 'MANUAL_EXIT', clientOrderId = null } = {}) {
  if (!position || !position.id) throw new Error('position is required');
  const remaining = Number(position.remainingNotionalUsd || 0);
  const requested = Number(notionalUsd || remaining);
  const closeNotionalUsd = Math.min(requested, remaining);
  if (!Number.isFinite(closeNotionalUsd) || closeNotionalUsd <= 0) {
    throw new Error('exit notional must be positive and within the open position');
  }
  const exitPrice = Number(price);
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) throw new Error('exit price must be positive');
  return {
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    reduceOnly: true,
    closeNotionalUsd,
    price: exitPrice,
    reason,
    clientOrderId: clientOrderId || `reduce-${position.id}-${randomUUID()}`,
  };
}

module.exports = { buildReduceOnlyExit };
