'use strict';

// KuCoin exchange-side stop orders (2026-07-06 audit-4 roadmap item).
//
// WHY: ledger data shows loop-detected stops fill at -5..-8% against a 4.0%
// configured stop — the 8s realtime loop plus market-order latency eats
// 1.5-3.5% per stop on fast dumps (51 stops = -$3,079 on the analyzed paper
// window; stops are the entire loss side of the book). A server-side
// stop-market order triggers at the stop level on the exchange itself.
//
// DESIGN: an idempotent reconciler instead of threading order placement
// through every buy/sell code path. Every ensure-cycle (default 60s):
//   1. For each open live KuCoin position: place a stop-market sell if none
//      exists; cancel+replace if qty or stop level drifted.
//   2. Adopt fills: if a tracked stop order filled on the exchange, the
//      position is already sold — hand the fill to the caller so normal
//      sell finalization (PnL, ledger, telemetry) runs with reason
//      EXCHANGE_STOP_FILLED, and never double-sell.
//   3. Sweep orphans: cancel tracked stop orders whose position is gone.
//
// The pre-sell hook (cancelBeforeManualSell) is the one integration point in
// the sell path: loop-driven exits cancel the resting stop first; if the
// cancel discovers the stop already filled, the caller adopts that fill
// instead of market-selling a second time.
//
// SAFETY: default OFF (KUCOIN_EXCHANGE_STOPS_ENABLED=true to arm). Never
// enabled in paper mode — paper validates the concept via
// PAPER_SIM_EXCHANGE_STOPS in the fill simulator instead. All exchange
// errors are caught and surfaced as {ok:false} results; a failed placement
// leaves the existing loop-stop protection unchanged (strictly additive).

const STOP_REPLACE_QTY_DRIFT_PCT = 1; // replace when position qty drifts >1%
const STOP_REPLACE_PRICE_DRIFT_PCT = 0.1; // replace when stop level drifts >0.1%

function pctDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return Infinity;
  return Math.abs(x - y) / y * 100;
}

// Pure decision helper (unit-testable): does the resting stop order still
// match the position, or must it be replaced?
function stopNeedsReplace({ position, trackedStop }) {
  if (!trackedStop) return { place: true };
  const qtyDrift = pctDiff(position.quantity, trackedStop.quantity);
  if (qtyDrift > STOP_REPLACE_QTY_DRIFT_PCT) {
    return { replace: true, reason: 'qty_drift', qtyDrift };
  }
  const priceDrift = pctDiff(position.stopLoss, trackedStop.stopPrice);
  if (priceDrift > STOP_REPLACE_PRICE_DRIFT_PCT) {
    return { replace: true, reason: 'stop_price_drift', priceDrift };
  }
  return { ok: true };
}

function createKucoinStopOrderManager({
  exchange,
  logger = console,
  config = {},
  isEnabledEnv = () => process.env.KUCOIN_EXCHANGE_STOPS_ENABLED === 'true',
} = {}) {
  if (!exchange) throw new Error('createKucoinStopOrderManager: exchange required');

  // txid -> { orderId, symbol, stopPrice, quantity, placedAt }
  const tracked = new Map();

  function isEnabled() {
    return isEnabledEnv() && !config.paperTrading;
  }

  async function placeStop(positionKey, position) {
    const symbol = exchange.normalizeSymbol(position.symbol || position.address);
    const stopPrice = Number(position.stopLoss);
    const quantity = Number(position.quantity);
    if (!(stopPrice > 0) || !(quantity > 0)) {
      return { ok: false, reason: 'invalid_stop_or_qty', stopPrice, quantity };
    }
    try {
      const amount = Number(exchange.exchange.amountToPrecision(symbol, quantity));
      const px = Number(exchange.exchange.priceToPrecision(symbol, stopPrice));
      const order = await exchange.exchange.createOrder(symbol, 'market', 'sell', amount, undefined, {
        stopPrice: px,
        stop: 'loss',
        clientOid: `stop-${positionKey}-${Date.now().toString(36)}`,
      });
      tracked.set(positionKey, {
        orderId: order?.id,
        symbol,
        stopPrice: px,
        quantity: amount,
        placedAt: Date.now(),
      });
      logger.info(`[kucoin-stops] placed stop ${symbol} qty=${amount} @ ${px} (order=${order?.id})`);
      return { ok: true, orderId: order?.id };
    } catch (error) {
      logger.warn(`[kucoin-stops] placeStop failed for ${symbol}: ${error?.message || error}`);
      return { ok: false, reason: 'place_failed', error: String(error?.message || error) };
    }
  }

  async function fetchStopOrder(entry) {
    return exchange.exchange.fetchOrder(entry.orderId, entry.symbol, { stop: true });
  }

  async function cancelStop(positionKey) {
    const entry = tracked.get(positionKey);
    if (!entry) return { ok: true, absent: true };
    try {
      await exchange.exchange.cancelOrder(entry.orderId, entry.symbol, { stop: true });
      tracked.delete(positionKey);
      logger.info(`[kucoin-stops] cancelled stop ${entry.symbol} (order=${entry.orderId})`);
      return { ok: true };
    } catch (error) {
      // Cancel can fail because the stop already TRIGGERED — check before
      // treating it as an error; caller must adopt the fill, not re-sell.
      try {
        const order = await fetchStopOrder(entry);
        const status = String(order?.status || '').toLowerCase();
        if (status === 'closed' || Number(order?.filled || 0) > 0) {
          tracked.delete(positionKey);
          return { ok: false, filled: true, order };
        }
      } catch (_) { /* fall through */ }
      logger.warn(`[kucoin-stops] cancelStop failed for ${entry.symbol}: ${error?.message || error}`);
      return { ok: false, reason: 'cancel_failed', error: String(error?.message || error) };
    }
  }

  // Pre-sell hook: call before any loop-driven market sell of a kucoin
  // position. Returns { proceed: true } when the market sell may go ahead,
  // or { proceed: false, adoptedFill } when the exchange stop already sold
  // the position (caller finalizes with the adopted fill; never re-sells).
  async function cancelBeforeManualSell(positionKey) {
    if (!isEnabled() || !tracked.has(positionKey)) return { proceed: true };
    const result = await cancelStop(positionKey);
    if (result.filled) {
      const order = result.order || {};
      return {
        proceed: false,
        adoptedFill: {
          txid: order.id || `stop_fill_${Date.now()}`,
          simulated: false,
          executedPriceUsd: Number(order.average || order.price || 0),
          filledBaseQty: Number(order.filled || 0),
          filledQuoteUsd: Number(order.cost || 0),
          hasExchangeFilledData: Number(order.filled || 0) > 0,
          exchangeStopFill: true,
        },
      };
    }
    // Cancel failed for another reason: do NOT proceed with a blind market
    // sell (double-sell risk if the stop triggers mid-flight). The next
    // ensure-cycle retries; the loop exit fires again next tick.
    if (!result.ok && !result.absent) {
      return { proceed: false, retry: true, reason: result.reason };
    }
    return { proceed: true };
  }

  // Reconciler: call on an interval with the CURRENT open positions map
  // ({ positionKey -> position }). Returns adopted fills for positions the
  // exchange already closed so the caller can run sell finalization.
  async function ensureStops(openKucoinPositions = {}) {
    if (!isEnabled()) return { adoptedFills: [] };
    const adoptedFills = [];

    // 1) adopt fills + place/replace for live positions
    for (const [positionKey, position] of Object.entries(openKucoinPositions)) {
      const entry = tracked.get(positionKey);
      if (entry) {
        let order = null;
        try { order = await fetchStopOrder(entry); } catch (_) { /* transient */ }
        const status = String(order?.status || '').toLowerCase();
        if (order && (status === 'closed' || Number(order.filled || 0) > 0)) {
          tracked.delete(positionKey);
          adoptedFills.push({ positionKey, order });
          continue;
        }
        if (order && status === 'canceled') {
          // Someone cancelled it out-of-band — re-place below.
          tracked.delete(positionKey);
        }
      }
      const decision = stopNeedsReplace({ position, trackedStop: tracked.get(positionKey) });
      if (decision.place) {
        await placeStop(positionKey, position);
      } else if (decision.replace) {
        logger.info(`[kucoin-stops] replacing stop for ${position.symbol}: ${decision.reason}`);
        const cancel = await cancelStop(positionKey);
        if (cancel.filled) {
          adoptedFills.push({ positionKey, order: cancel.order });
          continue;
        }
        if (cancel.ok || cancel.absent) await placeStop(positionKey, position);
      }
    }

    // 2) orphan sweep: tracked stops whose position no longer exists
    for (const positionKey of [...tracked.keys()]) {
      if (!openKucoinPositions[positionKey]) {
        await cancelStop(positionKey);
      }
    }

    return { adoptedFills };
  }

  return {
    isEnabled,
    ensureStops,
    cancelBeforeManualSell,
    // exposed for tests / observability
    _tracked: tracked,
  };
}

module.exports = { createKucoinStopOrderManager, stopNeedsReplace };
