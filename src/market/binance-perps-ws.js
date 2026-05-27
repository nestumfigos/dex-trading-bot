'use strict';

// B5P.2: Binance USD-M perps public WebSocket consumer.
//
// Subscribes to per-symbol `markPriceUpdate` streams. Each push delivers
// markPrice, indexPrice, estimatedSettlePrice, lastFundingRate, and
// nextFundingTime. The cached values are exposed via `getLatest(symbol)`
// so risk-buffer trackers and the sizing path can pull live mark prices
// without re-querying REST.
//
// Public stream URL pattern:
//   wss://fstream.binance.com/ws/<symbol>@markPrice@1s
// Combined streams supported via:
//   wss://fstream.binance.com/stream?streams=btcusdt@markPrice@1s/ethusdt@markPrice@1s
//
// Reconnect strategy: exponential backoff 500ms → 8s, jitter, max 8 attempts
// per "session"; subscriptions re-issued on reconnect.

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 8;

function createBinancePerpsWsConsumer({
  WebSocketCtor = (typeof WebSocket !== 'undefined' ? WebSocket : null),
  baseUrl = 'wss://fstream.binance.com',
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (typeof WebSocketCtor !== 'function') {
    // Node 18+ ships global WebSocket; older runtimes require an injected ctor
    // (e.g. `ws` package). Throw early so callers know to inject one.
    throw new Error('WebSocket ctor unavailable — inject `WebSocketCtor` (e.g. `require("ws")`).');
  }

  /** @type {Map<string, {markPrice:number, indexPrice:number, fundingRate:number, nextFundingTimeMs:number, ts:number}>} */
  const latest = new Map();
  /** @type {Set<string>} */
  const subscribed = new Set();
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let closing = false;

  function buildUrl() {
    if (subscribed.size === 0) return null;
    const streams = Array.from(subscribed).map((s) => `${s.toLowerCase()}@markPrice@1s`).join('/');
    return `${baseUrl}/stream?streams=${streams}`;
  }

  function applyMarkPricePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    const symbol = String(payload.s || payload.symbol || '').toUpperCase();
    if (!symbol) return;
    const markPrice = Number(payload.p ?? payload.markPrice);
    const indexPrice = Number(payload.i ?? payload.indexPrice);
    const fundingRate = Number(payload.r ?? payload.lastFundingRate);
    const nextFundingTimeMs = Number(payload.T ?? payload.nextFundingTime);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    latest.set(symbol, {
      markPrice,
      indexPrice: Number.isFinite(indexPrice) && indexPrice > 0 ? indexPrice : null,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
      nextFundingTimeMs: Number.isFinite(nextFundingTimeMs) ? nextFundingTimeMs : null,
      ts: Number(now()),
    });
  }

  function handleMessage(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    // Combined-stream payload: { stream, data }
    if (parsed?.data && parsed?.stream) {
      applyMarkPricePayload(parsed.data);
      return;
    }
    // Single-stream payload: data directly
    applyMarkPricePayload(parsed);
  }

  function scheduleReconnect() {
    if (closing) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger?.error?.(`[binance-perps-ws] reconnect attempts exhausted (${reconnectAttempts}); WS feed dark until next subscribe()`);
      return;
    }
    reconnectAttempts += 1;
    const exp = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** (reconnectAttempts - 1)));
    const delay = Math.floor(Math.random() * exp);
    logger?.warn?.(`[binance-perps-ws] reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; openSocket(); }, delay);
  }

  function openSocket() {
    const url = buildUrl();
    if (!url) return; // nothing subscribed
    try {
      ws = new WebSocketCtor(url);
    } catch (err) {
      logger?.warn?.(`[binance-perps-ws] ctor failed: ${err.message}`);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectAttempts = 0;
      logger?.info?.(`[binance-perps-ws] connected; streams=${subscribed.size}`);
    };
    ws.onmessage = (evt) => handleMessage(typeof evt.data === 'string' ? evt.data : String(evt.data));
    ws.onerror = (err) => {
      logger?.warn?.(`[binance-perps-ws] socket error: ${err?.message || 'unknown'}`);
    };
    ws.onclose = () => {
      ws = null;
      if (!closing) scheduleReconnect();
    };
  }

  function closeSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
      ws = null;
    }
  }

  function subscribe(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    let added = 0;
    for (const sym of list) {
      const upper = String(sym || '').toUpperCase();
      if (!upper) continue;
      if (!subscribed.has(upper)) { subscribed.add(upper); added += 1; }
    }
    if (added > 0) {
      // Reopen socket with the updated stream list. Binance combined-stream
      // URLs are fixed at connect-time; can't add streams on the fly.
      closeSocket();
      openSocket();
    }
    return added;
  }

  function unsubscribe(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    let removed = 0;
    for (const sym of list) {
      const upper = String(sym || '').toUpperCase();
      if (subscribed.has(upper)) { subscribed.delete(upper); latest.delete(upper); removed += 1; }
    }
    if (removed > 0) {
      closeSocket();
      if (subscribed.size > 0) openSocket();
    }
    return removed;
  }

  function getLatest(symbol) {
    const upper = String(symbol || '').toUpperCase();
    return latest.get(upper) || null;
  }

  function getLatestMarkPrice(symbol) {
    return getLatest(symbol)?.markPrice ?? null;
  }

  function getStatus() {
    return {
      connected: Boolean(ws),
      streams: Array.from(subscribed),
      cached: Array.from(latest.keys()),
      reconnectAttempts,
    };
  }

  function close() {
    closing = true;
    closeSocket();
  }

  return {
    subscribe,
    unsubscribe,
    getLatest,
    getLatestMarkPrice,
    getStatus,
    close,
  };
}

module.exports = { createBinancePerpsWsConsumer };
