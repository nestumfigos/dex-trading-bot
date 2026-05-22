'use strict';

const { checkHoneypot } = require('../utils/honeypot-client');
const { throttledFetch } = require('../utils/dexscreener-client');

function num(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pickBscPair(payload) {
  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  return pairs.find((pair) => String(pair?.chainId || '').toLowerCase() === 'bsc') || pairs[0] || null;
}

function normalizeTax(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 1 && numeric <= 100 ? numeric : numeric * 100;
}

function extractHoneypotSafety(honeypot = null) {
  if (!honeypot) {
    return { isHoneypot: false, buyTaxPct: null, sellTaxPct: null, source: null };
  }
  const simulation = honeypot.simulationResult || honeypot.simulation || {};
  return {
    isHoneypot: Boolean(honeypot.isHoneypot || honeypot.honeypotResult?.isHoneypot),
    buyTaxPct: normalizeTax(simulation.buyTax ?? honeypot.buyTax ?? honeypot.buy_tax),
    sellTaxPct: normalizeTax(simulation.sellTax ?? honeypot.sellTax ?? honeypot.sell_tax),
    source: honeypot ? 'honeypot-client' : null,
  };
}

function extractDexSafety(pair = null) {
  if (!pair) {
    return { liquidityUsd: null, liquidityLockedUsd: null, price: null, priceChange60mPct: null, volume24hUsd: null, netBuyFlowUsd10m: null, source: null };
  }
  const liquidityUsd = num(pair?.liquidity?.usd, null);
  const buys5m = num(pair?.txns?.m5?.buys, 0);
  const sells5m = num(pair?.txns?.m5?.sells, 0);
  const netBuyFlowUsd10m = num(pair?.volume?.m5, 0) * ((buys5m - sells5m) / Math.max(1, buys5m + sells5m));
  return {
    liquidityUsd,
    liquidityLockedUsd: liquidityUsd,
    price: num(pair?.priceUsd, null),
    priceChange60mPct: num(pair?.priceChange?.h1, null),
    volume24hUsd: num(pair?.volume?.h24, null),
    netBuyFlowUsd10m,
    source: pair ? 'dexscreener-client' : null,
  };
}

async function checkBscFlowSafety(tokenData = {}, options = {}) {
  const cfg = options.config || {};
  const address = String(tokenData.address || tokenData.tokenAddress || '').trim();
  const maxTaxPct = num(cfg.maxTaxPct, 5);
  const minLiquidityUsd = num(cfg.minLiquidityUsd, 50_000);
  const minLockedLiquidityUsd = num(cfg.minLockedLiquidityUsd, minLiquidityUsd);
  const reasons = [];

  const checkHoneypotFn = options.checkHoneypot || checkHoneypot;
  const fetchDexScreener = options.fetchDexScreener || throttledFetch;

  let hp = null;
  let dexPair = null;
  if (address) {
    hp = await checkHoneypotFn(address, 56).catch(() => null);
    const dexPayload = await fetchDexScreener(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`,
      { cacheTtlMs: num(cfg.dexscreenerCacheTtlMs, 60_000), allowStaleOnFailure: true },
    ).catch(() => null);
    dexPair = pickBscPair(dexPayload);
  }

  const hpSafety = extractHoneypotSafety(hp);
  const dexSafety = extractDexSafety(dexPair);
  const enriched = {
    ...tokenData,
    isHoneypot: Boolean(tokenData.isHoneypot || tokenData.honeypot || hpSafety.isHoneypot),
    honeypot: Boolean(tokenData.honeypot || tokenData.isHoneypot || hpSafety.isHoneypot),
    buyTaxPct: num(tokenData.buyTaxPct ?? tokenData.buyTax, hpSafety.buyTaxPct ?? 0),
    sellTaxPct: num(tokenData.sellTaxPct ?? tokenData.sellTax, hpSafety.sellTaxPct ?? 0),
    liquidityUsd: num(tokenData.liquidityUsd, dexSafety.liquidityUsd ?? 0),
    liquidityLockedUsd: num(tokenData.liquidityLockedUsd ?? tokenData.lockedLiquidityUsd, dexSafety.liquidityLockedUsd ?? tokenData.liquidityUsd ?? 0),
    price: num(tokenData.price, dexSafety.price ?? 0),
    priceChange60mPct: num(tokenData.priceChange60mPct ?? tokenData.priceChange1hPct, dexSafety.priceChange60mPct ?? 0),
    volume24hUsd: num(tokenData.volume24hUsd ?? tokenData.volume24h, dexSafety.volume24hUsd ?? 0),
    netBuyFlowUsd10m: num(tokenData.netBuyFlowUsd10m, dexSafety.netBuyFlowUsd10m ?? 0),
    safetySources: [hpSafety.source, dexSafety.source].filter(Boolean),
  };

  if (!address) reasons.push('missing_bsc_token_address');
  if (enriched.isHoneypot) reasons.push('honeypot_detected');
  if (enriched.buyTaxPct >= maxTaxPct || enriched.sellTaxPct >= maxTaxPct) reasons.push('tax_above_max');
  if (enriched.liquidityUsd < minLiquidityUsd) reasons.push('liquidity_below_min');
  if (enriched.liquidityLockedUsd < minLockedLiquidityUsd) reasons.push('locked_liquidity_below_min');

  return {
    ok: reasons.length === 0,
    reasons,
    tokenData: enriched,
    metrics: {
      buyTaxPct: enriched.buyTaxPct,
      sellTaxPct: enriched.sellTaxPct,
      liquidityUsd: enriched.liquidityUsd,
      liquidityLockedUsd: enriched.liquidityLockedUsd,
      sources: enriched.safetySources,
    },
  };
}

module.exports = {
  checkBscFlowSafety,
  extractDexSafety,
  extractHoneypotSafety,
  pickBscPair,
};
