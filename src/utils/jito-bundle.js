'use strict';

/**
 * Jito Bundle execution for Solana — MEV-protected swap delivery.
 *
 * A "bundle" is an atomic group of transactions sent together to a Jito block engine.
 * Either ALL land in the same block, or NONE — preventing sandwich attacks and partial fills.
 *
 * Bundle = [tip transaction, swap transaction]
 *   - tip transaction: transfers SOL to one of Jito's tip accounts (incentive for inclusion)
 *   - swap transaction: the prebuilt Jupiter swap, signed by user
 *
 * Multi-region failover: tries NY, Amsterdam, Frankfurt, Tokyo block engines.
 *
 * Adapted from the Python solders implementation in Old/Sol_/jupiter_swap.py.
 */

const axios = require('axios');
const {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} = require('@solana/web3.js');

// Default Jito mainnet block-engine endpoints (multi-region for latency + redundancy)
const DEFAULT_ENDPOINTS = [
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Jito tip accounts — published, rotated regularly by Jito Foundation.
// These are the canonical mainnet tip accounts as of 2025.
const DEFAULT_TIP_ACCOUNTS = [
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKwqKNWKkC5wPdSSdeBnizKZ6jT',
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Dynamic Tip Sizing ─────────────────────────────────────────────────────
// Goal: pay the LOWEST tip that gets bundles accepted. Bump only on rejection.
// Hard cap prevents runaway costs during meme manias.
//
// State held in module scope (per-process). Rolling window of last 10 attempts.
const MAX_HISTORY = 10;
const tipState = {
  history: [], // [{ ok: bool, tip: number, ts: number }]
  currentTip: null, // lazy-init from env
  lastAdjustedAt: 0,
};

function getTipFloor() {
  return Math.max(1, Number(process.env.JITO_TIP_LAMPORTS || 250000));
}

function getTipCap() {
  // Default cap = 4x floor. Worst case ~$0.16/trade at 250k floor.
  const explicit = Number(process.env.JITO_TIP_MAX_LAMPORTS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return getTipFloor() * 4;
}

function isAdaptiveEnabled() {
  // Default ON. Set JITO_TIP_DYNAMIC=false to disable.
  return process.env.JITO_TIP_DYNAMIC !== 'false';
}

function getCurrentAdaptiveTip() {
  const floor = getTipFloor();
  if (tipState.currentTip == null) tipState.currentTip = floor;
  // Auto-decay after 30 min of inactivity (mania ended)
  if (Date.now() - tipState.lastAdjustedAt > 30 * 60_000 && tipState.currentTip > floor) {
    tipState.currentTip = floor;
    tipState.lastAdjustedAt = Date.now();
  }
  // Snap into bounds in case env changed
  return Math.max(floor, Math.min(getTipCap(), tipState.currentTip));
}

function recordTipOutcome({ ok, tip }) {
  const now = Date.now();
  tipState.history.push({ ok: Boolean(ok), tip: Number(tip || 0), ts: now });
  if (tipState.history.length > MAX_HISTORY) {
    tipState.history = tipState.history.slice(-MAX_HISTORY);
  }
  if (!isAdaptiveEnabled()) return;

  const floor = getTipFloor();
  const cap = getTipCap();
  const recent5 = tipState.history.slice(-5);
  const recentRejects5 = recent5.filter((h) => !h.ok).length;
  const recent10 = tipState.history.slice(-10);
  const recentRejects10 = recent10.filter((h) => !h.ok).length;

  // BUMP UP: 3+ rejections in last 5 → +25% (capped)
  if (recentRejects5 >= 3 && tipState.currentTip < cap) {
    const bumped = Math.min(cap, Math.ceil(tipState.currentTip * 1.25));
    if (bumped > tipState.currentTip) {
      tipState.currentTip = bumped;
      tipState.lastAdjustedAt = now;
    }
  }
  // STEP DOWN: 10/10 accepted in window → -10% toward floor
  else if (recent10.length >= 10 && recentRejects10 === 0 && tipState.currentTip > floor) {
    const shrunk = Math.max(floor, Math.floor(tipState.currentTip * 0.9));
    if (shrunk < tipState.currentTip) {
      tipState.currentTip = shrunk;
      tipState.lastAdjustedAt = now;
    }
  }
}

function getTipStats() {
  return {
    currentTip: getCurrentAdaptiveTip(),
    floor: getTipFloor(),
    cap: getTipCap(),
    adaptive: isAdaptiveEnabled(),
    historySize: tipState.history.length,
    recentAcceptRate: tipState.history.length > 0
      ? Number((tipState.history.filter((h) => h.ok).length / tipState.history.length * 100).toFixed(1))
      : null,
  };
}

function getEndpoints() {
  const raw = String(process.env.JITO_ENDPOINTS || '').trim();
  if (!raw) return DEFAULT_ENDPOINTS;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ENDPOINTS;
}

function getTipAccounts() {
  const raw = String(process.env.JITO_TIP_ACCOUNTS || '').trim();
  if (!raw) return DEFAULT_TIP_ACCOUNTS;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_TIP_ACCOUNTS;
}

/**
 * Build a signed tip transaction transferring `tipLamports` from `wallet` to a random Jito tip account.
 * Re-uses the swap transaction's recentBlockhash so both txs land in the same window.
 */
function buildSignedTipTransaction({ wallet, recentBlockhash, tipLamports }) {
  const tipAccountList = getTipAccounts();
  const tipAccount = new PublicKey(tipAccountList[Math.floor(Math.random() * tipAccountList.length)]);
  const transferIx = SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: tipAccount,
    lamports: Math.max(1, Number(tipLamports)),
  });
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash,
    instructions: [transferIx],
  }).compileToV0Message();
  const tipTx = new VersionedTransaction(message);
  tipTx.sign([wallet]);
  return tipTx;
}

/**
 * Send a bundle (array of base64-encoded signed transactions) to Jito.
 * Multi-region failover: tries each endpoint until one accepts.
 * Returns { ok: bool, endpoint: string|null, bundleId: string|null, error: string|null }
 */
async function sendBundle({ bundleBase64, logger = console }) {
  const endpoints = shuffle(getEndpoints());
  let lastError = null;

  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [bundleBase64],
      };
      const res = await axios.post(endpoint, payload, {
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' },
      });
      const body = res.data;
      if (body && body.result) {
        logger.info(`[Jito] Bundle accepted by ${endpoint} → bundleId=${body.result}`);
        return { ok: true, endpoint, bundleId: body.result, error: null };
      }
      const errMsg = body?.error?.message || 'no result field';
      lastError = `${endpoint}: ${errMsg}`;
      logger.warn(`[Jito] Endpoint ${endpoint} returned non-success: ${errMsg}`);
      // Rate-limited? Brief backoff before next region
      if (/rate.?limit/i.test(errMsg)) {
        await new Promise((r) => setTimeout(r, 750 + i * 250));
      }
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '';
      lastError = `${endpoint}: ${status || 'network'} ${err.message}${body ? ' — ' + body : ''}`;
      logger.warn(`[Jito] Endpoint ${endpoint} failed: ${lastError}`);
    }
  }

  return { ok: false, endpoint: null, bundleId: null, error: lastError || 'all endpoints failed' };
}

/**
 * High-level: take an already-signed swap VersionedTransaction and submit it as a Jito bundle.
 * - Builds the tip transaction using the swap's recentBlockhash.
 * - Bundles [tip, swap] (tip first → block engine sees the incentive immediately).
 * - Returns { ok, bundleId, endpoint, swapSignature, error }.
 *
 * Caller still gets the swapSignature back for monitoring (confirmTransaction etc.).
 */
async function submitSwapAsBundle({ wallet, signedSwapTx, tipLamports, logger = console }) {
  if (!wallet || !signedSwapTx) {
    return { ok: false, error: 'wallet and signedSwapTx required' };
  }
  // Pull recentBlockhash from the swap tx so both txs land in the same window
  const recentBlockhash = signedSwapTx.message.recentBlockhash;
  if (!recentBlockhash) {
    return { ok: false, error: 'swap tx has no recentBlockhash' };
  }

  // Determine actual tip: caller can override with explicit tipLamports,
  // otherwise use the adaptive tip (bounded by floor/cap).
  const explicitTip = Number(tipLamports);
  const useAdaptive = !Number.isFinite(explicitTip) || explicitTip <= 0;
  const effectiveTip = useAdaptive ? getCurrentAdaptiveTip() : explicitTip;

  let tipTx;
  try {
    tipTx = buildSignedTipTransaction({ wallet, recentBlockhash, tipLamports: effectiveTip });
  } catch (err) {
    return { ok: false, error: `tip tx build failed: ${err.message}` };
  }

  const tipB64 = Buffer.from(tipTx.serialize()).toString('base64');
  const swapB64 = Buffer.from(signedSwapTx.serialize()).toString('base64');
  const bundle = [tipB64, swapB64];

  const result = await sendBundle({ bundleBase64: bundle, logger });

  // Feed outcome into adaptive tip controller (only when adaptive is engaged)
  if (useAdaptive) {
    recordTipOutcome({ ok: result.ok, tip: effectiveTip });
    const stats = getTipStats();
    logger.info(
      `[Jito/AdaptiveTip] outcome=${result.ok ? 'ok' : 'reject'} usedTip=${effectiveTip} ` +
      `→ next=${stats.currentTip} (floor=${stats.floor}, cap=${stats.cap}, accept=${stats.recentAcceptRate ?? 'n/a'}%)`
    );
  }

  // Extract swap signature for caller (so they can confirm it independently)
  let swapSignature = null;
  try {
    swapSignature = signedSwapTx.signatures && signedSwapTx.signatures.length > 0
      ? require('bs58').encode(signedSwapTx.signatures[0])
      : null;
  } catch (_) {
    swapSignature = null;
  }

  return { ...result, swapSignature, tipLamports: effectiveTip };
}

/**
 * Poll Jito for bundle status. Returns terminal state once the bundle is Landed,
 * Failed, or the timeout elapses.
 *
 * Bundle states reported by Jito:
 *   - Pending          (submitted, not yet processed)
 *   - Landed           (✅ accepted into block; landed_slot populated)
 *   - Failed           (❌ rejected — probably outbid)
 *   - Invalid          (❌ malformed)
 *
 * Endpoint used: any of the regional block engines accept getBundleStatuses.
 *
 * @returns {{ status, landedSlot, attempts, error }}
 */
// B3.api.7: bounded poll. Previously only `timeoutMs` capped the loop; if the
// endpoint returned garbage forever we kept ramming it (no per-attempt sleep
// floor either — could DDoS the relay). Add a hard maxAttempts ceiling
// (default 15) so a hung endpoint stops being hammered even before timeoutMs.
async function pollBundleStatus({ bundleId, endpoint, timeoutMs = 30000, intervalMs = 2000, maxAttempts = 15, logger = console }) {
  if (!bundleId) return { status: 'unknown', error: 'no bundleId' };
  const url = (endpoint || getEndpoints()[0]).replace('/bundles', '/getBundleStatuses');
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs && attempts < maxAttempts) {
    attempts += 1;
    try {
      const payload = {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      };
      const res = await axios.post(url, payload, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });
      const value = res.data?.result?.value || [];
      const entry = value[0];
      if (entry?.confirmation_status === 'finalized' || entry?.confirmation_status === 'confirmed') {
        logger.info(`[Jito] Bundle ${bundleId} → ${entry.confirmation_status} (slot=${entry.slot})`);
        return { status: 'landed', landedSlot: entry.slot, attempts, error: null };
      }
      if (entry?.err && Object.keys(entry.err).length > 0) {
        return { status: 'failed', attempts, error: JSON.stringify(entry.err) };
      }
      // Still pending — wait
    } catch (err) {
      // Don't fail-fast on transient errors — keep polling until timeout
      logger.debug(`[Jito] getBundleStatuses transient error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 'timeout', attempts, error: `no terminal state within ${timeoutMs}ms` };
}

module.exports = {
  submitSwapAsBundle,
  sendBundle,
  pollBundleStatus,
  buildSignedTipTransaction,
  getCurrentAdaptiveTip,
  getTipStats,
  recordTipOutcome,
  DEFAULT_ENDPOINTS,
  DEFAULT_TIP_ACCOUNTS,
};
