const axios = require('axios');

// Fetch OHLCV data from a generic API (e.g., Binance, KuCoin, etc.)
async function fetchOHLCV(symbol, interval = '1m', limit = 100) {
  // Example: Binance API endpoint
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url);
  // Format: [timestamp, open, high, low, close, volume, ...]
  return data.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

module.exports = { fetchOHLCV };