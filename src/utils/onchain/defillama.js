// DeFiLlama API utility for free TVL and protocol data
const axios = require('axios');

const DEFILLAMA_BASE = 'https://api.llama.fi';

// Get TVL for a protocol or chain
async function getProtocolTVL(protocolSlug) {
  const url = `${DEFILLAMA_BASE}/protocol/${protocolSlug}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data?.tvl || null;
}

// Get TVL for a token (if supported)
async function getTokenTVL(tokenAddress, chain = 'solana') {
  const url = `${DEFILLAMA_BASE}/tvl/${chain}/${tokenAddress}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data?.tvl || null;
}

// Get yield data for a protocol
async function getProtocolYields(protocolSlug) {
  const url = `${DEFILLAMA_BASE}/yields/${protocolSlug}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data || [];
}

// Get stablecoin analytics (all chains)
async function getStablecoins() {
  const url = `${DEFILLAMA_BASE}/stablecoins`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data || [];
}

module.exports = { getProtocolTVL, getTokenTVL, getProtocolYields, getStablecoins };