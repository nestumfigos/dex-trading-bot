// DeFiLlama API utility for free TVL and protocol data.
// B3.api.4: routed through getWithRetry → 429 + 5xx + network errors are now
// retried with exponential backoff. Previously every transient blip surfaced
// as null and (worse) consecutive blips after a 429 risked an IP ban.
const { getWithRetry } = require('../http-retry');

const DEFILLAMA_BASE = 'https://api.llama.fi';

// Get TVL for a protocol or chain
async function getProtocolTVL(protocolSlug) {
  const url = `${DEFILLAMA_BASE}/protocol/${protocolSlug}`;
  try {
    const res = await getWithRetry(url, { timeout: 10000, label: 'defillama:getProtocolTVL' });
    return res.data?.tvl || null;
  } catch (_) {
    return null;
  }
}

// Get TVL for a token (if supported)
async function getTokenTVL(tokenAddress, chain = 'solana') {
  const url = `${DEFILLAMA_BASE}/tvl/${chain}/${tokenAddress}`;
  try {
    const res = await getWithRetry(url, { timeout: 10000, label: 'defillama:getTokenTVL' });
    return res.data?.tvl || null;
  } catch (_) {
    return null;
  }
}

// Get yield data for a protocol
async function getProtocolYields(protocolSlug) {
  const url = `${DEFILLAMA_BASE}/yields/${protocolSlug}`;
  try {
    const res = await getWithRetry(url, { timeout: 10000, label: 'defillama:getProtocolYields' });
    return res.data || [];
  } catch (_) {
    return [];
  }
}

// Get stablecoin analytics (all chains)
async function getStablecoins() {
  const url = `${DEFILLAMA_BASE}/stablecoins`;
  try {
    const res = await getWithRetry(url, { timeout: 10000, label: 'defillama:getStablecoins' });
    return res.data || [];
  } catch (_) {
    return [];
  }
}

module.exports = { getProtocolTVL, getTokenTVL, getProtocolYields, getStablecoins };
