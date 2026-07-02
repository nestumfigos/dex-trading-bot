'use strict';

const { createHash } = require('crypto');

const ORDER_STATES = Object.freeze({
  CREATED: 'created',
  QUOTED: 'quoted',
  SUBMITTED: 'submitted',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELED: 'canceled',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  RECONCILED: 'reconciled',
});

const TERMINAL_ORDER_STATES = new Set([
  ORDER_STATES.FILLED,
  ORDER_STATES.CANCELED,
  ORDER_STATES.REJECTED,
  ORDER_STATES.EXPIRED,
  ORDER_STATES.RECONCILED,
]);

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function buildOrderIdempotencyKey(intent = {}) {
  const payload = {
    botProfile: intent.botProfile,
    strategy: intent.strategy,
    symbol: intent.symbol,
    side: intent.side,
    marketType: intent.marketType,
    orderType: intent.orderType,
    quantity: intent.quantity ?? null,
    quoteUsd: intent.quoteUsd ?? null,
    reduceOnly: Boolean(intent.reduceOnly),
    correlationId: intent.metadata?.correlationId || intent.metadata?.signalId || null,
  };
  return createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 32);
}

function normalizeFill(fill = {}) {
  const quantity = Number(fill.quantity ?? fill.qty ?? 0);
  const quoteUsd = Number(fill.quoteUsd ?? fill.notionalUsd ?? 0);
  const price = Number(fill.price ?? 0);
  return {
    fillId: String(fill.fillId || fill.id || `${Date.now()}`),
    quantity: Number.isFinite(quantity) ? quantity : 0,
    quoteUsd: Number.isFinite(quoteUsd) ? quoteUsd : 0,
    price: Number.isFinite(price) ? price : null,
    feeUsd: Number.isFinite(Number(fill.feeUsd)) ? Number(fill.feeUsd) : 0,
    slippageBps: Number.isFinite(Number(fill.slippageBps)) ? Number(fill.slippageBps) : null,
    filledAt: fill.filledAt || fill.ts || new Date().toISOString(),
    raw: fill,
  };
}

function createOrderLifecycle({
  intent,
  idempotencyKey = null,
  now = () => new Date(),
} = {}) {
  if (!intent || typeof intent !== 'object') throw new Error('intent is required');
  return {
    intentId: String(intent.intentId || intent.id || buildOrderIdempotencyKey(intent)),
    idempotencyKey: idempotencyKey || intent.idempotencyKey || buildOrderIdempotencyKey(intent),
    state: ORDER_STATES.CREATED,
    intent: { ...intent },
    fills: [],
    filledQuantity: 0,
    filledQuoteUsd: 0,
    feeUsd: 0,
    avgFillPrice: null,
    createdAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    submittedAt: null,
    terminalAt: null,
    exchangeOrderId: null,
    rejectReason: null,
    cancelReason: null,
  };
}

function appendFill(lifecycle, fill) {
  const normalized = normalizeFill(fill);
  const existing = Array.isArray(lifecycle.fills) ? lifecycle.fills : [];
  const fills = existing.some((item) => String(item.fillId) === String(normalized.fillId))
    ? existing
    : [...existing, normalized];
  const filledQuantity = fills.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const filledQuoteUsd = fills.reduce((sum, item) => sum + Number(item.quoteUsd || 0), 0);
  const feeUsd = fills.reduce((sum, item) => sum + Number(item.feeUsd || 0), 0);
  const requestedQuantity = Number(lifecycle.intent?.quantity || 0);
  const fillRatio = requestedQuantity > 0 ? Math.min(1, filledQuantity / requestedQuantity) : null;
  return {
    ...lifecycle,
    fills,
    filledQuantity,
    filledQuoteUsd,
    feeUsd,
    avgFillPrice: filledQuantity > 0 ? filledQuoteUsd / filledQuantity : null,
    fillRatio,
  };
}

function applyOrderLifecycleEvent(lifecycle = {}, event = {}) {
  const type = String(event.type || event.state || '').trim().toLowerCase();
  const isReconciliationEvent = ['reconciled', 'reconcile', 'reconciliation'].includes(type);
  if (TERMINAL_ORDER_STATES.has(lifecycle.state) && !isReconciliationEvent) {
    return { ...lifecycle, ignoredEvent: event.type || event.state || null };
  }
  const now = event.ts || event.at || new Date().toISOString();
  let next = { ...lifecycle, updatedAt: now };

  if (type === 'quoted') {
    next.state = ORDER_STATES.QUOTED;
    next.quote = event.quote || null;
  } else if (type === 'submitted') {
    next.state = ORDER_STATES.SUBMITTED;
    next.submittedAt = event.submittedAt || now;
    next.exchangeOrderId = event.exchangeOrderId || event.orderId || next.exchangeOrderId;
  } else if (type === 'partial_fill' || type === 'partially_filled') {
    next = appendFill(next, event.fill || event);
    next.state = ORDER_STATES.PARTIALLY_FILLED;
  } else if (type === 'fill' || type === 'filled') {
    if (event.fill || event.quantity || event.quoteUsd || event.notionalUsd) {
      next = appendFill(next, event.fill || event);
    }
    next.state = ORDER_STATES.FILLED;
    next.terminalAt = now;
  } else if (type === 'canceled' || type === 'cancelled') {
    next.state = ORDER_STATES.CANCELED;
    next.cancelReason = event.reason || null;
    next.terminalAt = now;
  } else if (type === 'rejected') {
    next.state = ORDER_STATES.REJECTED;
    next.rejectReason = event.reason || null;
    next.terminalAt = now;
  } else if (type === 'expired') {
    next.state = ORDER_STATES.EXPIRED;
    next.terminalAt = now;
  } else if (isReconciliationEvent) {
    const expectedQuantity = Number(event.expectedQuantity ?? lifecycle.intent?.quantity ?? 0);
    const actualQuantity = Number(event.actualQuantity ?? event.filledQuantity ?? lifecycle.filledQuantity ?? 0);
    const expectedQuoteUsd = Number(event.expectedQuoteUsd ?? lifecycle.intent?.quoteUsd ?? 0);
    const actualQuoteUsd = Number(event.actualQuoteUsd ?? event.filledQuoteUsd ?? lifecycle.filledQuoteUsd ?? 0);
    const quantityDiff = Number.isFinite(actualQuantity - expectedQuantity) ? actualQuantity - expectedQuantity : null;
    const quoteDiffUsd = Number.isFinite(actualQuoteUsd - expectedQuoteUsd) ? actualQuoteUsd - expectedQuoteUsd : null;
    const quantityDiffPct = expectedQuantity > 0 && quantityDiff != null ? (quantityDiff / expectedQuantity) * 100 : null;
    const quoteDiffPct = expectedQuoteUsd > 0 && quoteDiffUsd != null ? (quoteDiffUsd / expectedQuoteUsd) * 100 : null;
    const status = event.status || (
      (quantityDiffPct != null && Math.abs(quantityDiffPct) > 0.01)
      || (quoteDiffPct != null && Math.abs(quoteDiffPct) > 0.01)
        ? 'mismatch'
        : 'matched'
    );
    next = {
      ...next,
      state: ORDER_STATES.RECONCILED,
      reconciledAt: event.reconciledAt || now,
      terminalAt: event.reconciledAt || now,
      reconciliation: {
        status,
        reason: event.reason || null,
        expectedQuantity: Number.isFinite(expectedQuantity) ? expectedQuantity : null,
        actualQuantity: Number.isFinite(actualQuantity) ? actualQuantity : null,
        expectedQuoteUsd: Number.isFinite(expectedQuoteUsd) ? expectedQuoteUsd : null,
        actualQuoteUsd: Number.isFinite(actualQuoteUsd) ? actualQuoteUsd : null,
        quantityDiff,
        quoteDiffUsd,
        quantityDiffPct,
        quoteDiffPct,
        source: event.source || null,
      },
    };
  } else {
    next.lastUnknownEvent = event;
  }
  return next;
}

module.exports = {
  ORDER_STATES,
  TERMINAL_ORDER_STATES,
  buildOrderIdempotencyKey,
  normalizeFill,
  createOrderLifecycle,
  applyOrderLifecycleEvent,
};
