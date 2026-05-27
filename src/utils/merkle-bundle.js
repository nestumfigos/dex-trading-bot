'use strict';

/**
 * Merkle.io BSC Bundle execution — MEV-protected swap delivery for BSC.
 *
 * Mirrors the Jito-on-Solana pattern but uses Merkle.io's BSC bundle relay
 * (similar to Flashbots on ETH).
 *
 * Key differences from public mempool:
 *   - Tx is NEVER visible in public mempool → MEV bots can't see/sandwich it
 *   - Bundle is atomic — all txs land in same block or none land
 *   - Refund on failure — if bundle doesn't land in target block, no gas paid
 *
 * Endpoints used (in failover order):
 *   1. Merkle.io relay  (https://pool.merkle.io/relay)        — bundle support, free tier
 *   2. 48 Club          (https://rpc-bsc.48.club)             — validator-direct private mempool
 *   3. bloXroute        (https://bsc.rpc.blxrbdn.com)         — private mempool
 *
 * Mode A — sendBundle (preferred): atomic bundle via JSON-RPC eth_sendBundle
 * Mode B — sendPrivateRawTransaction: per-tx private send (fallback when bundle unsupported)
 */

const axios = require('axios');

const DEFAULT_RELAYS = [
  {
    name: 'merkle',
    url: 'https://pool.merkle.io/relay',
    bundleMethod: 'eth_sendBundle',
    privateMethod: 'eth_sendPrivateRawTransaction',
  },
  {
    name: '48club',
    url: 'https://rpc-bsc.48.club',
    bundleMethod: null, // validator-direct private mempool, no bundle API
    privateMethod: 'eth_sendRawTransaction',
  },
  {
    name: 'bloxroute',
    url: 'https://bsc.rpc.blxrbdn.com',
    bundleMethod: null,
    privateMethod: 'eth_sendRawTransaction',
  },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRelays() {
  const raw = String(process.env.MERKLE_RELAYS || '').trim();
  if (!raw) return DEFAULT_RELAYS;
  // CSV format: "name1|url1,name2|url2,..." or just URLs (uses default name=custom)
  const parsed = raw.split(',').map((entry) => {
    const [name, url] = entry.split('|').map((s) => s.trim());
    return {
      name: name || 'custom',
      url: url || name,
      bundleMethod: 'eth_sendBundle',
      privateMethod: 'eth_sendPrivateRawTransaction',
    };
  }).filter((r) => r.url);
  return parsed.length > 0 ? parsed : DEFAULT_RELAYS;
}

function getApiKey() {
  return String(process.env.MERKLE_API_KEY || '').trim();
}

// ── Per-relay success tracking ──────────────────────────────────────────────
// Last 20 attempts per relay → used by adaptive ordering so the most-reliable
// relay is tried first next time.
const MAX_HISTORY = 20;
const relayState = new Map(); // relayName → [{ ok, ts }, ...]

// B4.api.8: outcome recording is now phased.
//   - recordRelayOutcome(name, ok)           — submission accepted (HTTP 200 +
//                                                bundleHash). This is the
//                                                fastest signal but does NOT
//                                                imply the bundle landed.
//   - recordRelayLandedOutcome(name, ok)     — bundle confirmed included in a
//                                                block via pollBundleStatus +
//                                                merkle_bundleStats. Optional —
//                                                callers MAY skip if they don't
//                                                wait for inclusion.
//   - getRelayScore                          — when "landed" data exists for
//                                                a relay, weights landed > accepted.
//                                                Otherwise falls back to legacy
//                                                accepted-only score.
function recordRelayOutcome(relayName, ok) {
  const arr = relayState.get(relayName) || [];
  arr.push({ ok: Boolean(ok), ts: Date.now(), kind: 'accepted' });
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  relayState.set(relayName, arr);
}

function recordRelayLandedOutcome(relayName, ok) {
  const arr = relayState.get(relayName) || [];
  arr.push({ ok: Boolean(ok), ts: Date.now(), kind: 'landed' });
  if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  relayState.set(relayName, arr);
}

function getRelayScore(relayName) {
  const arr = relayState.get(relayName) || [];
  if (arr.length === 0) return 0.5; // unknown → middle
  // B4.api.8: prefer "landed" outcomes when present (5x weight). Falls back to
  // accepted-only score when no landed data is available — matches legacy
  // behavior for callers that haven't wired pollBundleStatus yet.
  const landed = arr.filter((h) => h.kind === 'landed');
  if (landed.length > 0) {
    const accepted = arr.filter((h) => h.kind === 'accepted');
    const landedWeight = 5;
    const acceptedWins = accepted.filter((h) => h.ok).length;
    const landedWins = landed.filter((h) => h.ok).length;
    const num = (acceptedWins) + (landedWins * landedWeight);
    const den = (accepted.length) + (landed.length * landedWeight);
    return den > 0 ? num / den : 0.5;
  }
  const wins = arr.filter((h) => h.ok).length;
  return wins / arr.length;
}

function orderedRelays() {
  // Sort by recent success rate descending, with random tiebreak
  return shuffle(getRelays()).sort((a, b) => getRelayScore(b.name) - getRelayScore(a.name));
}

function getRelayStats() {
  const out = {};
  for (const relay of getRelays()) {
    const arr = relayState.get(relay.name) || [];
    const wins = arr.filter((h) => h.ok).length;
    out[relay.name] = {
      attempts: arr.length,
      successes: wins,
      successRate: arr.length > 0 ? Number((wins / arr.length * 100).toFixed(1)) : null,
    };
  }
  return out;
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
async function jsonRpc(url, method, params, { timeoutMs = 8000, apiKey = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  const payload = { jsonrpc: '2.0', id: 1, method, params };
  const res = await axios.post(url, payload, { headers, timeout: timeoutMs });
  return res.data;
}

/**
 * Send a single signed BSC raw transaction via private mempool.
 * Falls through relays in priority order until one accepts.
 *
 * @param {string} signedRawTx  hex string starting with 0x
 * @param {object} logger
 * @returns {{ ok, relay, txHash, error }}
 */
async function sendPrivateRawTransaction({ signedRawTx, logger = console }) {
  if (!signedRawTx || typeof signedRawTx !== 'string' || !signedRawTx.startsWith('0x')) {
    return { ok: false, error: 'signedRawTx must be 0x-prefixed hex string' };
  }
  const apiKey = getApiKey();
  const relays = orderedRelays();
  let lastError = null;

  for (let i = 0; i < relays.length; i += 1) {
    const relay = relays[i];
    const method = relay.privateMethod || 'eth_sendRawTransaction';
    try {
      const body = await jsonRpc(relay.url, method, [signedRawTx], { apiKey });
      if (body && body.result) {
        recordRelayOutcome(relay.name, true);
        logger.info(`[Merkle] Private tx accepted by ${relay.name} → txHash=${body.result}`);
        return { ok: true, relay: relay.name, txHash: body.result, error: null };
      }
      const errMsg = body?.error?.message || 'no result field';
      lastError = `${relay.name}: ${errMsg}`;
      recordRelayOutcome(relay.name, false);
      logger.warn(`[Merkle] ${relay.name} rejected: ${errMsg}`);
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
      lastError = `${relay.name}: ${status || 'network'} ${err.message}${body ? ' — ' + body : ''}`;
      recordRelayOutcome(relay.name, false);
      logger.warn(`[Merkle] ${relay.name} error: ${lastError}`);
    }
  }

  return { ok: false, relay: null, txHash: null, error: lastError || 'all relays failed' };
}

/**
 * Send a true atomic bundle (multi-tx) via eth_sendBundle.
 * Only relays with bundle support are attempted. For single-tx scenarios this is overkill —
 * use sendPrivateRawTransaction instead.
 *
 * @param {string[]} signedTxs           array of 0x-prefixed signed raw txs
 * @param {number}   targetBlockNumber   block number we want the bundle to land in (optional)
 * @returns {{ ok, relay, bundleHash, error }}
 */
async function sendBundle({ signedTxs, targetBlockNumber = null, logger = console }) {
  if (!Array.isArray(signedTxs) || signedTxs.length === 0) {
    return { ok: false, error: 'signedTxs array required' };
  }
  if (!signedTxs.every((t) => typeof t === 'string' && t.startsWith('0x'))) {
    return { ok: false, error: 'all txs must be 0x-prefixed hex strings' };
  }

  const apiKey = getApiKey();
  const relays = orderedRelays().filter((r) => r.bundleMethod);
  if (relays.length === 0) {
    return { ok: false, error: 'no bundle-capable relays configured' };
  }

  let lastError = null;
  for (let i = 0; i < relays.length; i += 1) {
    const relay = relays[i];
    try {
      const params = [{
        txs: signedTxs,
        blockNumber: targetBlockNumber ? `0x${Number(targetBlockNumber).toString(16)}` : undefined,
        minTimestamp: 0,
        maxTimestamp: 0,
        revertingTxHashes: [],
      }];
      const body = await jsonRpc(relay.url, relay.bundleMethod, params, { apiKey });
      if (body && (body.result || body.result === '')) {
        recordRelayOutcome(relay.name, true);
        const bundleHash = body.result?.bundleHash || body.result || '';
        logger.info(`[Merkle] Bundle accepted by ${relay.name} → bundleHash=${bundleHash}`);
        // B5.8: fire-and-forget landed check. Poll for inclusion in the
        // background and record the terminal outcome against the relay's
        // landed-score. Failure or timeout records ok=false. Does not block
        // the caller because submission-accepted is the primary success
        // signal — landed-score is for future relay ranking.
        const relayName = relay.name;
        const relayUrl = relay.url;
        (async () => {
          try {
            const pollResult = await pollBundleStatus({ bundleHash, relayUrl, logger });
            recordRelayLandedOutcome(relayName, pollResult?.status === 'included' || pollResult?.status === 'landed');
          } catch (pollErr) {
            recordRelayLandedOutcome(relayName, false);
            logger.debug?.(`[Merkle] landed-check failed for ${relayName}: ${pollErr.message}`);
          }
        })();
        return { ok: true, relay: relay.name, bundleHash, error: null };
      }
      const errMsg = body?.error?.message || 'no result field';
      lastError = `${relay.name}: ${errMsg}`;
      recordRelayOutcome(relay.name, false);
      logger.warn(`[Merkle] ${relay.name} bundle rejected: ${errMsg}`);
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
      lastError = `${relay.name}: ${status || 'network'} ${err.message}${body ? ' — ' + body : ''}`;
      recordRelayOutcome(relay.name, false);
      logger.warn(`[Merkle] ${relay.name} bundle error: ${lastError}`);
    }
  }

  return { ok: false, relay: null, bundleHash: null, error: lastError || 'all bundle relays failed' };
}

/**
 * Poll Merkle.io for bundle inclusion status. Returns terminal state once the
 * bundle is included, dropped, or the timeout elapses.
 *
 * Uses Merkle's `merkle_bundleStats` JSON-RPC method when available.
 * Falls back to RPC `eth_getTransactionByHash` polling against the constituent
 * tx hashes when the bundle method is unavailable on the relay.
 *
 * @returns {{ status, blockNumber, attempts, error }}
 */
async function pollBundleStatus({ bundleHash, txHashes = [], relayUrl = '', timeoutMs = 30000, intervalMs = 2000, logger = console, fallbackProvider = null }) {
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    attempts += 1;

    // Method 1: Merkle's bundle-stats endpoint (when bundleHash is known and relay supports it)
    if (bundleHash && relayUrl) {
      try {
        const body = await jsonRpc(relayUrl, 'merkle_bundleStats', [bundleHash], { apiKey: getApiKey(), timeoutMs: 5000 });
        if (body && body.result) {
          if (body.result.included || body.result.status === 'included') {
            logger.info(`[Merkle] Bundle ${bundleHash} included (block=${body.result.blockNumber || '?'})`);
            return { status: 'included', blockNumber: body.result.blockNumber || null, attempts, error: null };
          }
          if (body.result.dropped || body.result.status === 'dropped') {
            return { status: 'dropped', attempts, error: body.result.reason || 'dropped by relay' };
          }
        }
      } catch (_) {
        // Falls through to tx-hash polling
      }
    }

    // Method 2: poll constituent tx hashes via fallbackProvider (always works)
    if (txHashes.length > 0 && fallbackProvider) {
      try {
        const results = await Promise.all(txHashes.map((h) => fallbackProvider.getTransactionReceipt(h).catch(() => null)));
        const allIncluded = results.every((r) => r && r.status !== undefined);
        if (allIncluded) {
          const blockNumber = results[0]?.blockNumber;
          logger.info(`[Merkle] Bundle txs all included at block=${blockNumber}`);
          return { status: 'included', blockNumber, attempts, error: null };
        }
        const anyReverted = results.some((r) => r && r.status === 0);
        if (anyReverted) {
          return { status: 'reverted', attempts, error: 'one or more bundle txs reverted' };
        }
      } catch (err) {
        logger.debug(`[Merkle] tx-receipt poll error: ${err.message}`);
      }
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 'timeout', attempts, error: `no inclusion within ${timeoutMs}ms` };
}

module.exports = {
  sendPrivateRawTransaction,
  sendBundle,
  recordRelayLandedOutcome, // B4.api.8: callers wiring pollBundleStatus should call this with the terminal status
  pollBundleStatus,
  getRelayStats,
  getRelays,
  DEFAULT_RELAYS,
};
