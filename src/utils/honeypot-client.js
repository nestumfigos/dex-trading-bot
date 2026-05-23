'use strict';

const axios = require('axios');
const logger = require('./logger');

// honeypot.is wrapper with circuit breaker and 24h response cache.
// The public API silently rate-limits at ~50 req/min and times out aggressively under load.
// Without this, every BSC token eval triggered an 8s timeout cascade during outages.

const cache = new Map();
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
let lastCallAt = 0;
// 2026-05-23: dedupe circuit-open warn so flapping circuit doesn't spam logs.
let circuitWarnedForWindowUntil = 0;

const DEFAULT_TIMEOUT_MS = Number(process.env.HONEYPOT_TIMEOUT_MS || 12_000);
const DEFAULT_CACHE_TTL_MS = Number(process.env.HONEYPOT_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const DEFAULT_MIN_INTERVAL_MS = Number(process.env.HONEYPOT_MIN_INTERVAL_MS || 200);
const FAIL_THRESHOLD = Number(process.env.HONEYPOT_FAIL_THRESHOLD || 3);
const CIRCUIT_OPEN_MS = Number(process.env.HONEYPOT_CIRCUIT_OPEN_MS || 5 * 60_000);

function getCached(addr, chainId) {
  const k = `${chainId}:${addr.toLowerCase()}`;
  const entry = cache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > DEFAULT_CACHE_TTL_MS) {
    cache.delete(k);
    return null;
  }
  return entry.data;
}

function setCached(addr, chainId, data) {
  const k = `${chainId}:${addr.toLowerCase()}`;
  cache.set(k, { data, fetchedAt: Date.now() });
  if (cache.size > 5000) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt).slice(0, 1000);
    for (const [k2] of oldest) cache.delete(k2);
  }
}

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

async function checkHoneypot(tokenAddress, chainId = 56) {
  if (!tokenAddress) return null;
  const cached = getCached(tokenAddress, chainId);
  if (cached) return cached;

  if (isCircuitOpen()) {
    logger.debug(`[honeypot.is] circuit open, skipping ${tokenAddress}`);
    return null;
  }

  // Light throttle
  const wait = Math.max(0, lastCallAt + DEFAULT_MIN_INTERVAL_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  try {
    const res = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${tokenAddress}&chainID=${chainId}`,
      { timeout: DEFAULT_TIMEOUT_MS }
    );
    consecutiveFailures = 0;
    setCached(tokenAddress, chainId, res.data);
    return res.data;
  } catch (err) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAIL_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      if (Date.now() >= circuitWarnedForWindowUntil) {
        logger.warn(`[honeypot.is] circuit open for ${(CIRCUIT_OPEN_MS / 1000).toFixed(0)}s after ${consecutiveFailures} failures`);
        circuitWarnedForWindowUntil = circuitOpenUntil;
      }
    }
    return null;
  }
}

function getStats() {
  return {
    cacheSize: cache.size,
    consecutiveFailures,
    circuitOpenUntil,
    isOpen: isCircuitOpen(),
  };
}

module.exports = { checkHoneypot, getStats, isCircuitOpen };
