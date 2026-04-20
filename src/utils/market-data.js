'use strict';

const axios = require('axios');
const config = require('../../config');
const logger = require('./logger');
const { getQuoteBySymbol } = require('./coinmarketcap');

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const STABLE_SYMBOLS = new Set(['usd', 'usdc', 'usdt', 'busd', 'dai', 'fdusd', 'usde']);

function getNativeAssets() {
  return {
    solana: {
      coingeckoId: 'solana',
      coinMarketCapSymbol: 'SOL',
      dexscreenerChainId: 'solana',
      dexscreenerTokenAddress: WRAPPED_SOL_MINT,
    },
    ethereum: {
      coingeckoId: 'ethereum',
      coinMarketCapSymbol: 'ETH',
      dexscreenerChainId: 'base',
      dexscreenerTokenAddress: config.base?.weth,
    },
    binancecoin: {
      coingeckoId: 'binancecoin',
      coinMarketCapSymbol: 'BNB',
      dexscreenerChainId: 'bsc',
      dexscreenerTokenAddress: config.bsc?.wbnb,
    },
  };
}

function getProviderOrder() {
  const configured = Array.isArray(config.marketData?.nativePriceProviders)
    ? config.marketData.nativePriceProviders
    : [];
  return configured.length > 0 ? configured : ['coingecko', 'dexscreener', 'coinmarketcap'];
}

function pickDexScreenerPair(pairs, expectedChainId) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    return null;
  }

  const scored = pairs
    .filter((pair) => String(pair?.chainId || '').toLowerCase() === expectedChainId)
    .map((pair) => {
      const liquidityUsd = Number(pair?.liquidity?.usd || 0);
      const quoteSymbol = String(pair?.quoteToken?.symbol || '').toLowerCase();
      const baseSymbol = String(pair?.baseToken?.symbol || '').toLowerCase();
      const stableBonus = STABLE_SYMBOLS.has(quoteSymbol) || STABLE_SYMBOLS.has(baseSymbol) ? 1_000_000_000 : 0;
      return { pair, score: stableBonus + liquidityUsd };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.pair || null;
}

async function getCoinGeckoNativePrice(asset) {
  const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
    params: {
      ids: asset.coingeckoId,
      vs_currencies: 'usd',
    },
    timeout: 10000,
  });
  const price = Number(response.data?.[asset.coingeckoId]?.usd || 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid CoinGecko price for ${asset.coingeckoId}`);
  }
  return { price, source: 'coingecko' };
}

async function getDexScreenerNativePrice(asset) {
  if (!asset.dexscreenerTokenAddress) {
    throw new Error('missing DexScreener token address');
  }

  const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${asset.dexscreenerTokenAddress}`, {
    timeout: 10000,
  });
  const rows = Array.isArray(response.data?.pairs) ? response.data.pairs : [];
  const pair = pickDexScreenerPair(rows, String(asset.dexscreenerChainId || '').toLowerCase());
  const price = Number(pair?.priceUsd || 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid DexScreener price for ${asset.coingeckoId}`);
  }
  return { price, source: 'dexscreener' };
}

async function getCoinMarketCapNativePrice(asset) {
  const quote = await getQuoteBySymbol(asset.coinMarketCapSymbol);
  const price = Number(quote?.price || 0);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`invalid CoinMarketCap price for ${asset.coinMarketCapSymbol}`);
  }
  return { price, source: 'coinmarketcap' };
}

async function getNativeAssetPrice(assetKey) {
  const asset = getNativeAssets()[String(assetKey || '').toLowerCase()];
  if (!asset) {
    throw new Error(`unsupported native asset: ${assetKey}`);
  }

  const providers = getProviderOrder();
  let lastError = null;

  for (const provider of providers) {
    try {
      if (provider === 'coingecko') {
        return await getCoinGeckoNativePrice(asset);
      }
      if (provider === 'dexscreener') {
        return await getDexScreenerNativePrice(asset);
      }
      if (provider === 'coinmarketcap') {
        const quote = await getCoinMarketCapNativePrice(asset);
        if (quote) return quote;
      }
    } catch (error) {
      lastError = error;
      logger.debug(`Native price provider ${provider} failed for ${assetKey}: ${error.message}`);
    }
  }

  throw lastError || new Error(`no native price providers succeeded for ${assetKey}`);
}

module.exports = {
  getNativeAssetPrice,
};