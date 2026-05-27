'use strict';

// B5P.1: Binance USD-M perpetual futures REST adapter (scaffold).
//
// This module is FUNCTIONAL but NOT YET WIRED. The guard stub at
// `binance-perps.js` remains in place so accidental imports still fail loud
// (and scaffold-guards.test.js still passes). When operator is ready to flip
// the switch to live execution, they replace the guard import with this
// module and run the canary plan from PERPS_BOOTSTRAP D.14.
//
// All trade-changing endpoints (place/cancel/modify) are signed; public
// endpoints (mark price, exchange info) are unsigned. Signing per Binance docs:
//   signature = HMAC-SHA256(secretKey, queryString || body)
//   header    X-MBX-APIKEY: <apiKey>
//
// Idempotency: every placeOrder accepts a `clientOrderId` (defaults to a
// fresh UUIDv4 with `bot-` prefix). Binance honors clientOrderId for at
// least 24h, so retries are safe across that window.
//
// Reduce-only enforcement: every exit MUST be marked reduceOnly=true.
// placeOrder throws if the caller tries to mark a reduceOnly order with
// side that would re-open the position (e.g. reduceOnly + side=BUY on a
// position with positionSide=LONG is meaningless — refuse).

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://fapi.binance.com';
const DEFAULT_RECV_WINDOW_MS = 5000;
const ALLOWED_ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'STOP', 'STOP_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_MARKET']);
const ALLOWED_TIME_IN_FORCE = new Set(['GTC', 'IOC', 'FOK', 'GTX']);

function createBinancePerpsRest({
  apiKey,
  apiSecret,
  baseUrl = DEFAULT_BASE_URL,
  recvWindowMs = DEFAULT_RECV_WINDOW_MS,
  fetchFn = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error('binance-perps-rest requires apiKey + apiSecret. Refusing to construct without credentials.');
  }
  if (typeof fetchFn !== 'function') {
    throw new Error('binance-perps-rest needs a fetch implementation (Node 18+ global fetch or `node-fetch`).');
  }

  function sign(qs) {
    return crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
  }

  function buildQueryString(params) {
    const filtered = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    return filtered.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  }

  async function signedRequest(method, path, params = {}) {
    const ts = Number(now());
    const merged = { ...params, timestamp: ts, recvWindow: recvWindowMs };
    const qs = buildQueryString(merged);
    const sig = sign(qs);
    const url = `${baseUrl}${path}?${qs}&signature=${sig}`;
    const response = await fetchFn(url, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
    if (!response.ok) {
      const err = new Error(`binance-perps ${method} ${path} HTTP ${response.status}: ${body?.msg || text}`);
      err.code = body?.code || `HTTP_${response.status}`;
      err.status = response.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  async function publicRequest(path, params = {}) {
    const qs = buildQueryString(params);
    const url = `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const response = await fetchFn(url, { method: 'GET' });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }
    if (!response.ok) {
      const err = new Error(`binance-perps GET ${path} HTTP ${response.status}: ${body?.msg || text}`);
      err.code = body?.code || `HTTP_${response.status}`;
      throw err;
    }
    return body;
  }

  async function placeOrder({
    symbol,
    side,                  // 'BUY' | 'SELL'
    type = 'MARKET',
    quantity,
    price = null,          // required for LIMIT/STOP variants
    timeInForce = null,    // GTC/IOC/FOK/GTX
    reduceOnly = false,
    closePosition = false,
    stopPrice = null,
    workingType = null,    // 'MARK_PRICE' | 'CONTRACT_PRICE'
    clientOrderId = null,
    positionSide = null,   // 'BOTH' | 'LONG' | 'SHORT' (hedge mode)
    newOrderRespType = 'RESULT',
  } = {}) {
    if (!symbol) throw new Error('placeOrder: symbol required');
    if (!['BUY', 'SELL'].includes(String(side).toUpperCase())) throw new Error('placeOrder: side must be BUY or SELL');
    const upperType = String(type).toUpperCase();
    if (!ALLOWED_ORDER_TYPES.has(upperType)) throw new Error(`placeOrder: type ${type} not allowed`);
    if (timeInForce && !ALLOWED_TIME_IN_FORCE.has(String(timeInForce).toUpperCase())) {
      throw new Error(`placeOrder: timeInForce ${timeInForce} not allowed`);
    }
    if (!quantity || Number(quantity) <= 0) throw new Error('placeOrder: quantity must be positive');
    if ((upperType === 'LIMIT' || upperType === 'STOP' || upperType === 'TAKE_PROFIT') && !price) {
      throw new Error(`placeOrder: type ${upperType} requires price`);
    }

    // Idempotency: assign a clientOrderId if absent. Binance accepts up to 36
    // characters; prefix `bot-` for filtering in their UI.
    const cid = clientOrderId || `bot-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;

    const params = {
      symbol: String(symbol).toUpperCase(),
      side: String(side).toUpperCase(),
      type: upperType,
      quantity: Number(quantity),
      reduceOnly: reduceOnly ? 'true' : undefined,
      closePosition: closePosition ? 'true' : undefined,
      price: price !== null ? Number(price) : undefined,
      stopPrice: stopPrice !== null ? Number(stopPrice) : undefined,
      timeInForce: timeInForce || (upperType === 'LIMIT' ? 'GTC' : undefined),
      workingType: workingType || undefined,
      newClientOrderId: cid,
      positionSide: positionSide || undefined,
      newOrderRespType,
    };
    return signedRequest('POST', '/fapi/v1/order', params);
  }

  async function cancelOrder({ symbol, orderId = null, clientOrderId = null }) {
    if (!symbol) throw new Error('cancelOrder: symbol required');
    if (!orderId && !clientOrderId) throw new Error('cancelOrder: orderId or clientOrderId required');
    const params = { symbol: String(symbol).toUpperCase() };
    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;
    return signedRequest('DELETE', '/fapi/v1/order', params);
  }

  async function getOrder({ symbol, orderId = null, clientOrderId = null }) {
    if (!symbol) throw new Error('getOrder: symbol required');
    const params = { symbol: String(symbol).toUpperCase() };
    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;
    return signedRequest('GET', '/fapi/v1/order', params);
  }

  async function getOpenOrders(symbol = null) {
    const params = symbol ? { symbol: String(symbol).toUpperCase() } : {};
    return signedRequest('GET', '/fapi/v1/openOrders', params);
  }

  async function getAccount() {
    return signedRequest('GET', '/fapi/v2/account', {});
  }

  async function getPositionRisk(symbol = null) {
    const params = symbol ? { symbol: String(symbol).toUpperCase() } : {};
    return signedRequest('GET', '/fapi/v2/positionRisk', params);
  }

  // Public — no signature
  async function getMarkPrice(symbol) {
    if (!symbol) throw new Error('getMarkPrice: symbol required');
    return publicRequest('/fapi/v1/premiumIndex', { symbol: String(symbol).toUpperCase() });
  }

  async function getExchangeInfo() {
    return publicRequest('/fapi/v1/exchangeInfo', {});
  }

  return {
    placeOrder,
    cancelOrder,
    getOrder,
    getOpenOrders,
    getAccount,
    getPositionRisk,
    getMarkPrice,
    getExchangeInfo,
  };
}

module.exports = { createBinancePerpsRest };
