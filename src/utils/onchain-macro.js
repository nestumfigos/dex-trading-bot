'use strict';

const axios = require('axios');

const CACHE = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cacheGet(key) {
  const cached = CACHE.get(key);
  return cached && cached.expiresAt > Date.now() ? cached.value : null;
}

function cacheSet(key, value, ttlMs) {
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function fetchStablecoinSupply({ ttlMs = 10 * 60_000 } = {}) {
  const cacheKey = 'defillama:stablecoins';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const response = await axios.get('https://stablecoins.llama.fi/stablecoins', { timeout: 10_000 });
  const rows = Array.isArray(response.data?.peggedAssets) ? response.data.peggedAssets : [];
  const totalSupplyUsd = rows.reduce((sum, row) => sum + Number(row.circulating?.peggedUSD || row.circulating?.peggedUsd || 0), 0);
  return cacheSet(cacheKey, {
    source: 'defillama_stablecoins',
    totalSupplyUsd,
    assetCount: rows.length,
  }, ttlMs);
}

function deriveOnchainMacroFeatures(tokenData = {}, external = {}) {
  const activeAddresses = Number(tokenData.activeAddresses || tokenData.activeAddressCount || 0);
  const exchangeInflowUsd = Number(tokenData.exchangeInflowUsd || external.exchangeInflowUsd || 0);
  const exchangeOutflowUsd = Number(tokenData.exchangeOutflowUsd || external.exchangeOutflowUsd || 0);
  const whaleNetFlowUsd = Number(tokenData.whaleNetFlowUsd || tokenData.whaleAccumulationUsd || external.whaleNetFlowUsd || 0);
  const mvrv = Number(tokenData.mvrv || tokenData.realizedCapMvrv || external.mvrv || 0);
  const stablecoinSupplyUsd = Number(external.stablecoinSupplyUsd || 0);
  const flowDenom = Math.max(1, Math.abs(exchangeInflowUsd) + Math.abs(exchangeOutflowUsd));
  const exchangeFlowScore = clamp((exchangeOutflowUsd - exchangeInflowUsd) / flowDenom, -1, 1);
  const whaleAccumulationScore = clamp(whaleNetFlowUsd / Math.max(10_000, Math.abs(whaleNetFlowUsd)), -1, 1);
  const participationScore = clamp(Math.log10(Math.max(1, activeAddresses)) / 6, 0, 1);
  const mvrvRiskScore = mvrv > 0 ? clamp((mvrv - 1) / 4, 0, 1) : 0;

  return {
    activeAddresses,
    exchangeInflowUsd,
    exchangeOutflowUsd,
    whaleNetFlowUsd,
    stablecoinSupplyUsd,
    mvrv,
    exchangeFlowScore,
    whaleAccumulationScore,
    participationScore,
    mvrvRiskScore,
    onchainMacroScore: clamp(
      0.5
      + (exchangeFlowScore * 0.18)
      + (whaleAccumulationScore * 0.16)
      + ((participationScore - 0.5) * 0.14)
      - (mvrvRiskScore * 0.12),
      0,
      1
    ),
  };
}

async function getOnchainMacroSnapshot(tokenData = {}, options = {}) {
  const stablecoins = options.includeStablecoins === false
    ? null
    : await fetchStablecoinSupply().catch(() => null);
  return deriveOnchainMacroFeatures(tokenData, {
    stablecoinSupplyUsd: stablecoins?.totalSupplyUsd || 0,
  });
}

module.exports = {
  deriveOnchainMacroFeatures,
  fetchStablecoinSupply,
  getOnchainMacroSnapshot,
};
