'use strict';

const { randomUUID } = require('crypto');

const MARKET_TYPES = new Set(['spot', 'perp', 'dex', 'paper']);

function assertExecutionAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('execution adapter must be an object');
  if (!adapter.venue || typeof adapter.venue !== 'string') throw new Error('execution adapter venue is required');
  if (!MARKET_TYPES.has(adapter.marketType)) throw new Error(`unsupported marketType: ${adapter.marketType}`);
  for (const method of ['quote', 'submit', 'reconcile', 'cancel']) {
    if (typeof adapter[method] !== 'function') throw new Error(`execution adapter missing ${method}()`);
  }
  return adapter;
}

function createOrderIntent({
  intentId = randomUUID(),
  botProfile,
  strategy,
  symbol,
  side,
  marketType,
  orderType = 'market',
  quantity = null,
  quoteUsd = null,
  reduceOnly = false,
  metadata = {},
} = {}) {
  const normalizedSide = String(side || '').trim().toUpperCase();
  if (!botProfile) throw new Error('botProfile is required');
  if (!strategy) throw new Error('strategy is required');
  if (!symbol) throw new Error('symbol is required');
  if (!['BUY', 'SELL', 'LONG', 'SHORT', 'EXIT'].includes(normalizedSide)) throw new Error(`unsupported side: ${side}`);
  if (!MARKET_TYPES.has(marketType)) throw new Error(`unsupported marketType: ${marketType}`);
  if (quantity == null && quoteUsd == null) throw new Error('quantity or quoteUsd is required');
  return Object.freeze({
    intentId: String(intentId),
    botProfile: String(botProfile),
    strategy: String(strategy),
    symbol: String(symbol).toUpperCase(),
    side: normalizedSide,
    marketType,
    orderType: String(orderType).toLowerCase(),
    quantity: quantity == null ? null : Number(quantity),
    quoteUsd: quoteUsd == null ? null : Number(quoteUsd),
    reduceOnly: Boolean(reduceOnly),
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : {},
  });
}

module.exports = {
  MARKET_TYPES,
  assertExecutionAdapter,
  createOrderIntent,
};
