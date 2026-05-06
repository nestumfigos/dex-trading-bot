const KuCoinExchange = require('../src/exchanges/kucoin');
const config = require('../config');

(async () => {
  try {
    const kucoin = new KuCoinExchange();
    await kucoin.initialize();

    console.log('Testing refreshTickers...');
    await kucoin.refreshTickers();
    console.log('Tickers:', kucoin.tickerCache);

    console.log('Testing getNewListings...');
    const newListings = await kucoin.getNewListings();
    console.log('New Listings:', newListings);
  } catch (error) {
    console.error('Error during testing:', error);
  }
})();