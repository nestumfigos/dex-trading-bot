'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const config = require('../config');

test('CoinPaprika context validates ticker shape and exposes market context', async () => {
  const originalGet = axios.get;
  const originalEnabled = config.coinpaprika.enabled;
  config.coinpaprika.enabled = true;
  axios.get = async () => ({
    status: 200,
    data: [
      {
        id: 'abc-token',
        name: 'ABC Token',
        symbol: 'ABC',
        rank: 123,
        quotes: {
          USD: {
            price: 1.05,
            market_cap: 10_000_000,
            volume_24h: 2_500_000,
            percent_change_1h: 1,
            percent_change_24h: 8,
            percent_change_7d: 15,
          },
        },
      },
    ],
  });
  try {
    const { getCoinPaprikaContext } = require('../src/utils/coinpaprika-market');
    const context = await getCoinPaprikaContext('ABC/USDT', { price: 1, priceChange24hPct: 7 });
    assert.equal(context.available, true);
    assert.equal(context.confirmsMomentum, true);
    assert.equal(context.rank, 123);
    assert.equal(context.volume24hUsd, 2_500_000);
  } finally {
    axios.get = originalGet;
    config.coinpaprika.enabled = originalEnabled;
  }
});

test('CoinMarketCap context returns unavailable instead of throwing on provider failure', async () => {
  const originalGet = axios.get;
  const originalEnabled = config.coinmarketcap.enabled;
  const originalKey = config.coinmarketcap.apiKey;
  config.coinmarketcap.enabled = true;
  config.coinmarketcap.apiKey = 'test-key';
  axios.get = async () => {
    throw new Error('rate limited');
  };
  try {
    const { getCoinMarketCapContext } = require('../src/utils/coinmarketcap');
    const context = await getCoinMarketCapContext('XYZ', { price: 1, priceChange24hPct: 3 });
    assert.equal(context.available, false);
    assert.equal(context.confirmsMomentum, false);
    assert.match(context.reason, /rate limited/);
  } finally {
    axios.get = originalGet;
    config.coinmarketcap.enabled = originalEnabled;
    config.coinmarketcap.apiKey = originalKey;
  }
});
