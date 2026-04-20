// Solscan API utility for free on-chain metrics (TVL, whale tracking)
const axios = require('axios');

const SOLSCAN_BASE = 'https://public-api.solscan.io';

// Get token holders (top holders for whale tracking)
async function getTokenHolders(tokenAddress, limit = 10) {
  const url = `${SOLSCAN_BASE}/token/holders`;
  const res = await axios.get(url, {
    params: { tokenAddress, offset: 0, limit },
    timeout: 10000,
  });
  return res.data || [];
}

// Get token info (TVL, supply, etc.)
async function getTokenInfo(tokenAddress) {
  const url = `${SOLSCAN_BASE}/token/meta?tokenAddress=${tokenAddress}`;
  const res = await axios.get(url, { timeout: 10000 });
  return res.data || null;
}

module.exports = { getTokenHolders, getTokenInfo };