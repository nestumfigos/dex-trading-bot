// CryptoCompare API utility for free price/news/social data
const axios = require('axios');

const CRYPTOCOMPARE_BASE = 'https://min-api.cryptocompare.com/data';

// Get price for a symbol pair (e.g., 'BTC', 'USD')
async function getPrice(symbol, currency = 'USD') {
  const res = await axios.get(`${CRYPTOCOMPARE_BASE}/price`, {
    params: { fsym: symbol.toUpperCase(), tsyms: currency.toUpperCase() },
  });
  return res.data?.[currency.toUpperCase()] || null;
}

// Get latest news (free tier)
async function getNews(limit = 10) {
  const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
    params: { lang: 'EN', lTs: Math.floor(Date.now() / 1000), sortOrder: 'latest', limit },
  });
  return res.data?.Data || [];
}

module.exports = { getPrice, getNews };