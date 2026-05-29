'use strict';

// K4: KuCoin Futures public WebSocket consumer.
//
// Interface mirrors createBinancePerpsWsConsumer so src/index.js can swap
// providers transparently:
//   subscribe(canonicalSymbols), unsubscribe(...), getLatest(canonical),
//   getLatestMarkPrice(canonical), getStatus(), close()
//
// Protocol differences vs. Binance fstream:
//   1. Bootstrap: POST /api/v1/bullet-public -> { token, instanceServers:[{endpoint, pingInterval}] }
//   2. Connect to `${endpoint}?token=${token}&connectId=${uuid}`.
//   3. Send subscribe message after open: { id, type:"subscribe",
//      topic:"/contract/instrument:XBTUSDTM", privateChannel:false, response:true }
//   4. Server pushes { type:"message", topic, data:{ markPrice, indexPrice, ... } }.
//   5. Client must heartbeat `{ id, type:"ping" }` every pingInterval ms.
//
// We use the `/contract/instrument:{symbol}` topic for mark/index price; it is
// the closest KuCoin equivalent to Binance markPrice@1s. Funding rate is also
// delivered on this topic (fundingFeeRate field). Topic supports multiple
// symbols via comma-separated suffix: `/contract/instrument:XBTUSDTM,ETHUSDTM`.

const { toKucoinSymbol, fromKucoinSymbol } = require('../utils/perps-symbols');

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 8;
const DEFAULT_PING_INTERVAL_MS = 18000; // KuCoin default; overridden by bullet response

function uuidish() {
  // KuCoin only requires a unique connectId per session; the format is free
  // (numeric epoch + random suffix is sufficient and avoids a crypto dep).
  return `${Date.now()}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function createKucoinPerpsWsConsumer({
  WebSocketCtor = (typeof WebSocket !== 'undefined' ? WebSocket : null),
  fetchFn = global.fetch,
  bulletUrl = 'https://api-futures.kucoin.com/api/v1/bullet-public',
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('WebSocket ctor unavailable — inject WebSocketCtor (e.g. require("ws")).');
  }
  if (typeof fetchFn !== 'function') {
    throw new Error('fetchFn is required for KuCoin bullet endpoint.');
  }

  /** @type {Map<string, {markPrice:number, indexPrice:number, fundingRate:number, nextFundingTimeMs:number, ts:number}>} */
  const latest = new Map(); // keyed by CANONICAL symbol (BTCUSDT)
  /** @type {Set<string>} */
  const subscribed = new Set(); // canonical
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  let messageCounter = 0;
  let closing = false;

  async function fetchBullet() {
    const response = await fetchFn(bulletUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`KuCoin bullet-public HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.code !== '200000' || !body.data?.token || !Array.isArray(body.data.instanceServers)) {
      throw new Error(`KuCoin bullet-public invalid response (code=${body?.code})`);
    }
    const instance = body.data.instanceServers[0];
    if (!instance?.endpoint) throw new Error('KuCoin bullet-public missing instanceServers[0].endpoint');
    return {
      token: body.data.token,
      endpoint: instance.endpoint,
      pingInterval: Number(instance.pingInterval) || DEFAULT_PING_INTERVAL_MS,
    };
  }

  function applyInstrumentPayload(canonical, data) {
    if (!data || typeof data !== 'object') return;
    const markPrice = Number(data.markPrice);
    const indexPrice = Number(data.indexPrice);
    // KuCoin futures funding cadence is 8h with `fundingFeeRate` + `nextFundingTime`
    // on the instrument topic. Field names sometimes vary by version; accept both.
    const fundingRate = Number(data.fundingFeeRate ?? data.fundingRate);
    const nextFundingTimeMs = Number(data.nextFundingTime);
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    latest.set(canonical, {
      markPrice,
      indexPrice: Number.isFinite(indexPrice) && indexPrice > 0 ? indexPrice : null,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
      nextFundingTimeMs: Number.isFinite(nextFundingTimeMs) ? nextFundingTimeMs : null,
      ts: Number(now()),
    });
  }

  function parseTopicSymbol(topic) {
    // Topic shapes:
    //   /contract/instrument:XBTUSDTM           -> XBTUSDTM
    //   /contract/instrument:XBTUSDTM,ETHUSDTM  -> first; per-symbol payload carries `.symbol` too
    if (typeof topic !== 'string') return null;
    const colonIdx = topic.indexOf(':');
    if (colonIdx < 0) return null;
    const suffix = topic.slice(colonIdx + 1);
    return suffix.split(',')[0] || null;
  }

  function handleMessage(raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return; }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.type === 'message') {
      // Prefer payload.symbol when present (multi-symbol topic case).
      const kucoinSymbol = String(parsed.data?.symbol || parseTopicSymbol(parsed.topic) || '').toUpperCase();
      if (!kucoinSymbol) return;
      let canonical = null;
      try { canonical = fromKucoinSymbol(kucoinSymbol); } catch (_) { return; }
      applyInstrumentPayload(canonical, parsed.data);
    }
    // ack/welcome/pong frames intentionally ignored
  }

  function clearPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function startPing() {
    clearPing();
    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return; // not OPEN
      try {
        ws.send(JSON.stringify({ id: `ping-${++messageCounter}`, type: 'ping' }));
      } catch (_err) { /* next reconnect cycle will repair */ }
    }, Math.max(5000, pingIntervalMs - 2000));
    if (pingTimer.unref) pingTimer.unref();
  }

  function sendSubscribeFrames() {
    if (!ws || ws.readyState !== 1 || subscribed.size === 0) return;
    const kucoinSymbols = Array.from(subscribed)
      .map((canonical) => {
        try { return toKucoinSymbol(canonical); } catch (_) { return null; }
      })
      .filter(Boolean);
    if (kucoinSymbols.length === 0) return;
    // KuCoin permits comma-separated symbols on a single topic frame.
    // For very large universes, chunk to keep frames under the 200KB limit.
    const CHUNK = 80;
    for (let i = 0; i < kucoinSymbols.length; i += CHUNK) {
      const chunk = kucoinSymbols.slice(i, i + CHUNK);
      const frame = {
        id: `sub-${++messageCounter}`,
        type: 'subscribe',
        topic: `/contract/instrument:${chunk.join(',')}`,
        privateChannel: false,
        response: true,
      };
      try { ws.send(JSON.stringify(frame)); }
      catch (err) { logger?.warn?.(`[kucoin-perps-ws] subscribe send failed: ${err.message}`); }
    }
  }

  function scheduleReconnect() {
    if (closing) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger?.error?.(`[kucoin-perps-ws] reconnect attempts exhausted (${reconnectAttempts}); WS feed dark until next subscribe()`);
      return;
    }
    reconnectAttempts += 1;
    const exp = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** (reconnectAttempts - 1)));
    const delay = Math.floor(Math.random() * exp);
    logger?.warn?.(`[kucoin-perps-ws] reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; openSocket().catch(() => {}); }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  async function openSocket() {
    if (subscribed.size === 0) return;
    let bullet;
    try { bullet = await fetchBullet(); }
    catch (err) {
      logger?.warn?.(`[kucoin-perps-ws] bullet fetch failed: ${err.message}`);
      scheduleReconnect();
      return;
    }
    pingIntervalMs = bullet.pingInterval;
    const url = `${bullet.endpoint}?token=${encodeURIComponent(bullet.token)}&connectId=${uuidish()}`;
    try {
      ws = new WebSocketCtor(url);
    } catch (err) {
      logger?.warn?.(`[kucoin-perps-ws] ctor failed: ${err.message}`);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      reconnectAttempts = 0;
      logger?.info?.(`[kucoin-perps-ws] connected; subscribing ${subscribed.size} symbols`);
      sendSubscribeFrames();
      startPing();
    };
    ws.onmessage = (evt) => handleMessage(typeof evt.data === 'string' ? evt.data : String(evt.data));
    ws.onerror = (err) => {
      logger?.warn?.(`[kucoin-perps-ws] socket error: ${err?.message || 'unknown'}`);
    };
    ws.onclose = () => {
      clearPing();
      ws = null;
      if (!closing) scheduleReconnect();
    };
  }

  function closeSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearPing();
    if (ws) {
      try { ws.close(); } catch (_) { /* ignore */ }
      ws = null;
    }
  }

  function subscribe(canonicalSymbols) {
    const list = Array.isArray(canonicalSymbols) ? canonicalSymbols : [canonicalSymbols];
    let added = 0;
    for (const sym of list) {
      const upper = String(sym || '').toUpperCase();
      if (!upper) continue;
      try { toKucoinSymbol(upper); } catch (_) { continue; } // reject non-USDT
      if (!subscribed.has(upper)) { subscribed.add(upper); added += 1; }
    }
    if (added > 0) {
      if (ws && ws.readyState === 1) {
        sendSubscribeFrames();
      } else {
        openSocket().catch(() => {});
      }
    }
    return added;
  }

  function unsubscribe(canonicalSymbols) {
    const list = Array.isArray(canonicalSymbols) ? canonicalSymbols : [canonicalSymbols];
    let removed = 0;
    for (const sym of list) {
      const upper = String(sym || '').toUpperCase();
      if (subscribed.has(upper)) { subscribed.delete(upper); latest.delete(upper); removed += 1; }
    }
    if (removed > 0 && ws && ws.readyState === 1) {
      // Send explicit unsubscribe frames so the server stops pushing.
      const kucoinSymbols = list
        .map((sym) => { try { return toKucoinSymbol(String(sym).toUpperCase()); } catch (_) { return null; } })
        .filter(Boolean);
      if (kucoinSymbols.length > 0) {
        try {
          ws.send(JSON.stringify({
            id: `unsub-${++messageCounter}`,
            type: 'unsubscribe',
            topic: `/contract/instrument:${kucoinSymbols.join(',')}`,
            privateChannel: false,
            response: true,
          }));
        } catch (err) { logger?.warn?.(`[kucoin-perps-ws] unsubscribe send failed: ${err.message}`); }
      }
    }
    return removed;
  }

  function getLatest(canonicalSymbol) {
    const upper = String(canonicalSymbol || '').toUpperCase();
    return latest.get(upper) || null;
  }

  function getLatestMarkPrice(canonicalSymbol) {
    return getLatest(canonicalSymbol)?.markPrice ?? null;
  }

  function getStatus() {
    return {
      connected: Boolean(ws),
      streams: Array.from(subscribed),
      cached: Array.from(latest.keys()),
      reconnectAttempts,
      pingIntervalMs,
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

module.exports = { createKucoinPerpsWsConsumer };
