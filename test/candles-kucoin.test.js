'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const KuCoinExchange = require('../src/exchanges/kucoin');
const { getOhlcvSeries, setKucoinOhlcvProvider } = require('../src/utils/candles');

test('KuCoin getKlines parses REST candle rows into OHLCV shape', async () => {
  const kucoin = new KuCoinExchange();
  const nowSec = Math.floor(Date.now() / 1000);
  let params;
  kucoin.exchange = {
    markets: { 'BTC/USDT': {} },
    async publicGetMarketCandles(request) {
      params = request;
      return {
        data: [
          [String(nowSec - 3 * 86400), '100', '105', '110', '95', '123.45', '12962.25'],
        ],
      };
    },
  };
  kucoin.symbols = ['BTC/USDT'];

  const candles = await kucoin.getKlines('BTC/USDT', '1day', 10);

  assert.equal(params.symbol, 'BTC-USDT');
  assert.equal(params.type, '1day');
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0], {
    timestamp: nowSec - 3 * 86400,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 123.45,
  });
});

test('getOhlcvSeries uses the KuCoin provider for kucoin chain', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const calls = [];
  setKucoinOhlcvProvider({
    async getKlines(symbol, interval, limit) {
      calls.push({ symbol, interval, limit });
      return [
        { timestamp: nowSec - 120, open: 1, high: 2, low: 0.9, close: 1.5, volume: 10 },
        { timestamp: nowSec - 60, open: 1.5, high: 2.2, low: 1.4, close: 2, volume: 12 },
      ];
    },
  });

  try {
    const series = await getOhlcvSeries({
      chainKey: 'kucoin',
      address: 'BTC/USDT',
      interval: '1day',
      limit: 42,
    });

    assert.deepEqual(calls, [{ symbol: 'BTC/USDT', interval: '1day', limit: 42 }]);
    assert.equal(series.source, 'kucoin');
    assert.deepEqual(series.closes, [1.5, 2]);
    assert.deepEqual(series.volumes, [10, 12]);
    assert.equal(series.candles.length, 2);
  } finally {
    setKucoinOhlcvProvider(null);
  }
});
