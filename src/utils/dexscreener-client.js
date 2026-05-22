'use strict';

const axios = require('axios');
const logger = require('./logger');

// Global DexScreener client with shared throttle, circuit breaker, and response cache.
// See live bot for full rationale.

const DEFAULT_MIN_INTERVAL_MS = Number(process.env.DEXSCREENER_MIN_INTERVAL_MS || 250);
const DEFAULT_TIMEOUT_MS = Number(process.env.DEXSCREENER_TIMEOUT_MS || 10_000);
const DEFAULT_CACHE_TTL_MS = Number(process.env.DEXSCREENER_CACHE_TTL_MS || 60_000);
const DEFAULT_FAIL_THRESHOLD = Number(process.env.DEXSCREENER_FAIL_THRESHOLD || 5);
const DEFAULT_CIRCUIT_OPEN_MS = Number(process.env.DEXSCREENER_CIRCUIT_OPEN_MS || 60_000);

let lastCallAt = 0;
let inFlight = Promise.resolve();
const cache = new Map();
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function getCached(url, ttlMs) {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlMs) {
    cache.delete(url);
    return null;
  }
  return entry.data;
}

function setCached(url, data) {
  cache.set(url, { data, fetchedAt: Date.now() });
  if (cache.size > 5000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, 1000);
    for (const [k] of oldest) cache.delete(k);
  }
}

async function throttledFetch(url, options = {}) {
  const ttlMs = Number.isFinite(Number(options.cacheTtlMs)) ? Number(options.cacheTtlMs) : DEFAULT_CACHE_TTL_MS;
  const allowStaleOnFailure = options.allowStaleOnFailure !== false;

  if (ttlMs > 0) {
    const cached = getCached(url, ttlMs);
    if (cached) return cached;
  }

  if (isCircuitOpen()) {
    if (allowStaleOnFailure) {
      const stale = cache.get(url);
      if (stale) return stale.data;
    }
    return null;
  }

  const myTurn = inFlight.then(async () => {
    const minInterval = Number.isFinite(Number(options.minIntervalMs)) ? Number(options.minIntervalMs) : DEFAULT_MIN_INTERVAL_MS;
    const wait = Math.max(0, lastCallAt + minInterval - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    try {
      const res = await axios.get(url, {
        timeout: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS),
        headers: options.headers || {},
      });
      consecutiveFailures = 0;
      const data = res.data;
      if (ttlMs > 0) setCached(url, data);
      return data;
    } catch (err) {
      consecutiveFailures += 1;
      const status = Number(err.response?.status || 0);
      if (status === 429 || consecutiveFailures >= DEFAULT_FAIL_THRESHOLD) {
        circuitOpenUntil = Date.now() + DEFAULT_CIRCUIT_OPEN_MS;
        logger.warn(`[DexScreener] circuit open for ${(DEFAULT_CIRCUIT_OPEN_MS / 1000).toFixed(0)}s — status=${status} failures=${consecutiveFailures}`);
      }
      if (allowStaleOnFailure) {
        const stale = cache.get(url);
        if (stale) return stale.data;
      }
      throw err;
    }
  });

  inFlight = myTurn.catch(() => {});
  return myTurn;
}

function getStats() {
  return {
    cacheSize: cache.size,
    consecutiveFailures,
    circuitOpenUntil,
    isCircuitOpen: isCircuitOpen(),
    lastCallAt,
  };
}

module.exports = {
  throttledFetch,
  getStats,
  isCircuitOpen,
};
