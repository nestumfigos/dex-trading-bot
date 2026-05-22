const test = require('node:test');
const assert = require('node:assert/strict');

const KuCoinExchange = require('../src/exchanges/kucoin');
const config = require('../config');

test('KuCoin buy preflight rejects orders below exchange minimum amount', async () => {
  const previousPaperTrading = config.paperTrading;
  config.paperTrading = false;
  try {
    const kucoin = new KuCoinExchange();
    kucoin.exchange = {
      market: () => ({ limits: { amount: { min: 10 }, cost: { min: 1 } } }),
      markets: {},
      costToPrecision: (_symbol, value) => String(value),
      priceToPrecision: (_symbol, value) => String(value),
      amountToPrecision: (_symbol, value) => String(value),
      fetchBalance: async () => ({ USDT: { free: 100 } }),
      createOrder: async () => {
        throw new Error('createOrder should not be called for below-minimum buy');
      },
    };
    kucoin.getTopOfBook = async () => ({ bestAsk: 1 });

    await assert.rejects(
      () => kucoin.executeBuy('ABC/USDT', 5, { strategyName: 'momentum' }),
      /estimated qty .* < baseMinSize/
    );
  } finally {
    config.paperTrading = previousPaperTrading;
  }
});

test('KuCoin sell preflight rejects dust exits that are below quote minimum', async () => {
  const previousPaperTrading = config.paperTrading;
  config.paperTrading = false;
  try {
    const kucoin = new KuCoinExchange();
    kucoin.exchange = {
      market: () => ({ limits: { amount: { min: 10 }, cost: { min: 1 } } }),
      markets: {},
      costToPrecision: (_symbol, value) => String(value),
      priceToPrecision: (_symbol, value) => String(value),
      amountToPrecision: (_symbol, value) => String(value),
      createOrder: async () => {
        throw new Error('createOrder should not be called for unexitable dust');
      },
    };
    kucoin.getTopOfBook = async () => ({ bestBid: 0.01 });

    await assert.rejects(
      () => kucoin.executeSell('ABC/USDT', 1),
      /position too small to exit via API/
    );
  } finally {
    config.paperTrading = previousPaperTrading;
  }
});
