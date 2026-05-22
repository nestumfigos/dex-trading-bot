'use strict';

/**
 * Polygon.io market confirmation provider.
 *
 * Degraded-mode stub: returns null when POLYGON_API_KEY is absent or feature disabled.
 * Restored 2026-05-22 after misidentified-as-dead deletion broke paper feature pipeline.
 * Original full implementation lived only on disk (untracked) and was lost; this stub
 * preserves the .catch(()=>null) interface contract at the call site.
 *
 * To re-enable, implement the real Polygon REST call against /v2/aggs and return:
 *   { confirmsMomentum: boolean, priceChangeDiffPct: number, volume24hUsd: number }
 */

const axios = require('axios');

const ENABLED = process.env.POLYGON_ENABLED !== 'false' && Boolean(process.env.POLYGON_API_KEY || '');
const BASE_URL = process.env.POLYGON_BASE_URL || 'https://api.polygon.io';
const SNAPSHOT_TTL_MS = Number(process.env.POLYGON_SNAPSHOT_TTL_MS || 30_000);

const cache = new Map(); // symbol -> { value, ts }

function normalizeTicker(symbol) {
  return String(symbol || '').toUpperCase().split('/')[0].split('-')[0].trim();
}

async function getPolygonConfirmation(symbol, opts = {}) {
  if (!ENABLED) return null;
  const ticker = normalizeTicker(symbol);
  if (!ticker) return null;
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) return cached.value;

  try {
    const url = `${BASE_URL}/v2/aggs/ticker/X:${ticker}USD/prev?apiKey=${process.env.POLYGON_API_KEY}`;
    const res = await axios.get(url, { timeout: 3000 });
    const row = res.data?.results?.[0];
    if (!row) {
      cache.set(ticker, { value: null, ts: Date.now() });
      return null;
    }
    const prevClose = Number(row.c || 0);
    const livePrice = Number(opts.price || 0);
    const priceChangeDiffPct = prevClose > 0 && livePrice > 0
      ? ((livePrice - prevClose) / prevClose) * 100 - Number(opts.priceChange24hPct || 0)
      : 0;
    const confirmsMomentum = prevClose > 0 && livePrice > prevClose && Math.abs(priceChangeDiffPct) < 5;
    const result = {
      confirmsMomentum,
      priceChangeDiffPct,
      volume24hUsd: Number(row.v || 0) * prevClose,
      provider: 'polygon',
    };
    cache.set(ticker, { value: result, ts: Date.now() });
    return result;
  } catch (_) {
    cache.set(ticker, { value: null, ts: Date.now() });
    return null;
  }
}

module.exports = { getPolygonConfirmation };
