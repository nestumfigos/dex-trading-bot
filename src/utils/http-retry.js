'use strict';

// B3.api.4: shared HTTP-retry helper.
//
// Single source of truth for "is this transient and worth retrying" across
// CoinPaprika, DeFiLlama, Solscan, etc. Phase A audit 08-external-apis.md #4
// flagged no 429 backoff anywhere → repeated IP bans. This helper centralizes
// the retry policy so adoption is one line per call site and the policy stays
// consistent.
//
// Retry semantics:
//   - 429 Too Many Requests   → respect Retry-After header if present, else
//                               exponential backoff with jitter
//   - 5xx                     → exponential backoff
//   - Network errors (ECONNRESET, ETIMEDOUT, etc.) → exponential backoff
//   - 4xx other than 429      → fail-fast (caller's bug)
//
// Caller passes the same options as axios.get; this wraps it. Caller MAY
// override `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `logger`, `label`.

const axios = require('axios');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  if (!error) return false;
  // Network-level errors — connect refused, timeout, reset, etc.
  const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);
  if (error.code && networkCodes.has(error.code)) return true;
  const status = error.response?.status;
  if (status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  return false;
}

function computeBackoffMs(attempt, baseDelayMs, maxDelayMs) {
  const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  // Full jitter — uniform [0, exp). Avoids thundering-herd on retry across
  // multiple concurrent callers that all 429'd at the same wall-clock tick.
  return Math.floor(Math.random() * exp);
}

function retryAfterMs(response) {
  const header = response?.headers?.['retry-after'];
  if (!header) return null;
  // Retry-After may be either seconds (integer) or an HTTP-date.
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

async function getWithRetry(url, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  logger = console,
  label = '',
  ...axiosOptions
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.get(url, axiosOptions);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= maxAttempts) {
        throw error;
      }
      const status = error.response?.status;
      const honoredDelay = status === 429 ? retryAfterMs(error.response) : null;
      const delay = honoredDelay ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
      const tag = label || url;
      logger?.warn?.(`[http-retry] ${tag} attempt=${attempt}/${maxAttempts} status=${status ?? error.code} delay=${delay}ms`);
      await sleep(delay);
    }
  }
  // Defensive — loop body always either returns or throws.
  throw lastError;
}

module.exports = { getWithRetry, isRetryableError, computeBackoffMs };
