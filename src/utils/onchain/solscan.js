// Solscan API utility for free on-chain metrics (TVL, whale tracking).
// B3.api.4: routed through getWithRetry for 429 + 5xx + network resilience.
const { getWithRetry } = require('../http-retry');

const SOLSCAN_BASE = 'https://public-api.solscan.io';

// Get token holders (top holders for whale tracking)
async function getTokenHolders(tokenAddress, limit = 10) {
  const url = `${SOLSCAN_BASE}/token/holders`;
  try {
    const res = await getWithRetry(url, {
      params: { tokenAddress, offset: 0, limit },
      timeout: 10000,
      label: 'solscan:getTokenHolders',
    });
    return res.data || [];
  } catch (_) {
    return [];
  }
}

// Get token info (TVL, supply, etc.)
async function getTokenInfo(tokenAddress) {
  const url = `${SOLSCAN_BASE}/token/meta?tokenAddress=${tokenAddress}`;
  try {
    const res = await getWithRetry(url, { timeout: 10000, label: 'solscan:getTokenInfo' });
    return res.data || null;
  } catch (_) {
    return null;
  }
}

module.exports = { getTokenHolders, getTokenInfo };
