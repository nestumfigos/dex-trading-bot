'use strict';

const { ORDER_STATES } = require('./order-lifecycle');

function buildExecutionTradingEvents(lifecycle = {}, {
  botProfile = null,
  strategy = null,
  symbol = null,
  severity = 'info',
} = {}) {
  const intent = lifecycle.intent || {};
  const common = {
    botProfile: botProfile || intent.botProfile || null,
    strategy: strategy || intent.strategy || null,
    symbol: symbol || intent.symbol || null,
    severity,
    correlationId: lifecycle.idempotencyKey || lifecycle.intentId || null,
  };
  const payloadBase = {
    intentId: lifecycle.intentId || null,
    idempotencyKey: lifecycle.idempotencyKey || null,
    state: lifecycle.state || null,
    exchangeOrderId: lifecycle.exchangeOrderId || null,
    intent,
  };
  const events = [];

  if (lifecycle.submittedAt || lifecycle.exchangeOrderId) {
    events.push({
      eventName: 'order.submitted',
      occurredAt: lifecycle.submittedAt || lifecycle.updatedAt || lifecycle.createdAt,
      payload: {
        ...payloadBase,
        submittedAt: lifecycle.submittedAt || null,
      },
      ...common,
    });
  }

  for (const fill of Array.isArray(lifecycle.fills) ? lifecycle.fills : []) {
    events.push({
      eventName: lifecycle.state === ORDER_STATES.FILLED || lifecycle.state === ORDER_STATES.RECONCILED
        ? 'fill.confirmed'
        : 'fill.partial',
      occurredAt: fill.filledAt || lifecycle.updatedAt || lifecycle.createdAt,
      payload: {
        ...payloadBase,
        fill,
        filledQuantity: lifecycle.filledQuantity || 0,
        filledQuoteUsd: lifecycle.filledQuoteUsd || 0,
        feeUsd: lifecycle.feeUsd || 0,
        avgFillPrice: lifecycle.avgFillPrice || null,
      },
      ...common,
    });
  }

  if (lifecycle.state === ORDER_STATES.REJECTED) {
    events.push({
      eventName: 'order.rejected',
      occurredAt: lifecycle.terminalAt || lifecycle.updatedAt || lifecycle.createdAt,
      payload: { ...payloadBase, reason: lifecycle.rejectReason || null },
      ...common,
      severity: 'warn',
    });
  } else if (lifecycle.state === ORDER_STATES.CANCELED) {
    events.push({
      eventName: 'order.canceled',
      occurredAt: lifecycle.terminalAt || lifecycle.updatedAt || lifecycle.createdAt,
      payload: { ...payloadBase, reason: lifecycle.cancelReason || null },
      ...common,
    });
  }

  if (lifecycle.reconciledAt || lifecycle.reconciliation) {
    events.push({
      eventName: 'order.reconciled',
      occurredAt: lifecycle.reconciledAt || lifecycle.terminalAt || lifecycle.updatedAt || lifecycle.createdAt,
      payload: {
        ...payloadBase,
        reconciledAt: lifecycle.reconciledAt || null,
        reconciliation: lifecycle.reconciliation || null,
        filledQuantity: lifecycle.filledQuantity || 0,
        filledQuoteUsd: lifecycle.filledQuoteUsd || 0,
        feeUsd: lifecycle.feeUsd || 0,
        avgFillPrice: lifecycle.avgFillPrice || null,
      },
      ...common,
      severity: lifecycle.reconciliation?.status === 'mismatch' ? 'warn' : common.severity,
    });
  }

  if (events.length === 0) {
    events.push({
      eventName: 'order.lifecycle',
      occurredAt: lifecycle.updatedAt || lifecycle.createdAt,
      payload: payloadBase,
      ...common,
    });
  }

  return events;
}

module.exports = {
  buildExecutionTradingEvents,
};
