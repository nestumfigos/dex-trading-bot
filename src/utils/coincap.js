// CoinCap API utility for free price/market data
const axios = require('axios');

const COINCAP_BASE = 'https://api.coincap.io/v2';

// Get price and market data for a token by symbol (e.g., 'BTC', 'ETH')
async function getCoinCapAsset(symbol) {
  const res = await axios.get(`${COINCAP_BASE}/assets/${symbol.toLowerCase()}`);
  return res.data?.data || null;
}

// Get top N assets by market cap
async function getTopAssets(limit = 20) {
  const res = await axios.get(`${COINCAP_BASE}/assets`, { params: { limit } });
  return res.data?.data || [];
}

module.exports = { getCoinCapAsset, getTopAssets };