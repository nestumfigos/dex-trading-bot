'use strict';
const ccxt = require('ccxt');
const config = require('../../config');
const logger = require('../utils/logger');
const { getTokenMetrics } = require('../utils/coingecko');

const LEVERAGED_TOKEN_PATTERN = /3L|3S|5L|5S|10L|10S|BEAR|BULL|UP|DOWN/i;

class KuCoinExchange {
  constructor(cache) {
    this.name = 'KuCoin (CEX)';
    this.exchange = null;
    this.symbols = [];
    this.tickerCache = {};
    this.lastTickerRefresh = 0;
    this.cache = cache;
    this.obDepthCache = new Map(); // symbol -> { liquidityUsd, fetchedAt }
    this.lastDepthWarmAt = 0;
    this._knownSymbols = new Set();
  }

  async initialize() {
    try {
      this.exchange = new ccxt.kucoin({
        apiKey: config.kucoin.apiKey,
        secret: config.kucoin.apiSecret,
        password: config.kucoin.apiPassphrase,
        sandbox: config.kucoin.sandbox,
        enableRateLimit: true,
      });
      await this.exchange.loadMarkets();
      this.symbols = Object.keys(this.exchange.markets).filter((s) => s.endsWith('/USDT'));
      if (this._knownSymbols.size === 0) {
        this.symbols.forEach((s) => this._knownSymbols.add(s));
      }
      logger.info(`KuCoin initialized with ${this.symbols.length} USDT pairs`);
    } catch (err) {
      logger.error(`KuCoin initialization failed: ${err.message}`);
      this.exchange = null;
      throw err;
    }
  }

  async refreshTickers() {
    if (!this.exchange) {
      logger.warn('KuCoin exchange not initialized, skipping ticker refresh');
      return;
    }

    try {
      const symbols = this.symbols;
      let tickers = {};

      try {
        tickers = await this.exchange.fetchTickers(symbols);
      } catch (err) {
        logger.warn(`KuCoin fetchTickers(symbols) failed: ${err.message}`);
        tickers = await this.exchange.fetchTickers();
      }

      this.tickerCache = tickers || {};
      this.lastTickerRefresh = Date.now();
      logger.debug(`KuCoin tickers refreshed: ${Object.keys(this.tickerCache).length}`);
    } catch (err) {
      logger.warn(`KuCoin refreshTickers failed: ${err.message}`);
    }
  }

  async getTicker(symbol) {
    if (!this.tickerCache[symbol] || Date.now() - this.lastTickerRefresh > 60_000) {
      await this.refreshTickers();
    }
    return this.tickerCache[symbol];
  }

  async getTokenData(symbol) {
    if (!this.exchange) {
      logger.error('KuCoin exchange not initialized');
      return null;
    }

    const cacheKey = `token:${symbol}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) return cached;

    try {
      const ticker = await this.getTicker(symbol);
      if (!ticker || !ticker.last) {
        return null;
      }

      const tokenSymbol = symbol.replace('/USDT', '');
      const metrics = await getTokenMetrics(tokenSymbol, 'kucoin', tokenSymbol);

      // Compute order-book depth as a liquidity proxy; fall back to volume * 0.05 if unavailable.
      // Results are cached for 30 s to avoid firing a fetchOrderBook call on every scan cycle.
      const OB_DEPTH_TTL_MS = 30_000;
      const volume24hUsd = Number(ticker.quoteVolume || 0);
      let liquidityUsd = 0;
      const cachedDepth = this.obDepthCache.get(symbol);
      if (cachedDepth && Date.now() - cachedDepth.fetchedAt < OB_DEPTH_TTL_MS) {
        liquidityUsd = cachedDepth.liquidityUsd;
      } else {
        try {
          const orderBook = await this.exchange.fetchOrderBook(symbol, 20);
          const topBids = (orderBook?.bids || []).slice(0, 10);
          liquidityUsd = topBids.reduce((sum, [price, amount]) => sum + Number(price) * Number(amount), 0);
          if (liquidityUsd <= 0) throw new Error('empty bids');
          this.obDepthCache.set(symbol, { liquidityUsd, fetchedAt: Date.now() });
        } catch (obErr) {
          liquidityUsd = volume24hUsd * 0.05;
          logger.debug(`KuCoin order-book depth unavailable for ${symbol} (${obErr.message}), falling back to volume*0.05`);
        }
      }

      const result = {
        address: symbol,
        symbol: tokenSymbol,
        name: tokenSymbol,
        price: ticker.last,
        liquidityUsd,
        volume24hUsd,
        liquidityChange24hPct: 0,
        volume24h: volume24hUsd,
        priceChange24h: Number(ticker.percentage || 0),
        priceChange7d: 0,
        buyTx10m: 0,
        sellTx10m: 0,
        buyTx1h: 0,
        sellTx1h: 0,
        txCountFirstHour: 0,
        uniqueBuyers10m: 0,
        isHoneypot: false,
        honeypotReason: '',
        buyTax: 0,
        sellTax: 0,
        topHoldersPct: 0,
        teamWalletUnlocked: false,
        listingAgeDays: 30,
        listingDate: null,
        chain: 'KuCoin',
        pairAddress: symbol,
        sentimentUpPct: metrics?.sentimentUpPct || null,
        sentimentDownPct: metrics?.sentimentDownPct || null,
        communityScore: metrics?.communityScore || null,
        developerScore: metrics?.developerScore || null,
        publicInterestScore: metrics?.publicInterestScore || null,
        coingeckoId: metrics?.coingeckoId || null,
        listedOnCoinGecko: Boolean(metrics?.coingeckoId),
        listedOnCoinMarketCap: true,
      };

      await this.cache?.set(cacheKey, result, 60);
      return result;
    } catch (err) {
      logger.error(`KuCoin getTokenData failed for ${symbol}: ${err.message}`);
      return null;
    }
  }

  async getAmountOut(amountInUsdt, symbol) {
    const ticker = await this.getTicker(symbol);
    const price = ticker?.last || 0;
    return price > 0 ? amountInUsdt / price : 0;
  }

  async getTopOfBook(symbol) {
    const orderBook = await this.exchange.fetchOrderBook(symbol, 5);
    const bestAsk = Number(orderBook?.asks?.[0]?.[0] || 0);
    const bestBid = Number(orderBook?.bids?.[0]?.[0] || 0);
    if (!bestAsk || !bestBid) {
      throw new Error(`Order book unavailable for ${symbol}`);
    }
    return { bestAsk, bestBid };
  }

  async executeBuy(symbol, usdtAmount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] KuCoin BUY ${symbol} with ${usdtAmount} USDT`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const maxSlippagePct = Math.max(0.1, Number(config.execution.kucoinMaxSlippagePct || 1.2));
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const { bestAsk } = await this.getTopOfBook(symbol);
          const slippagePct = maxSlippagePct + (attempt - 1) * 0.25;
          const limitPriceRaw = bestAsk * (1 + slippagePct / 100);
          const limitPrice = Number(this.exchange.priceToPrecision(symbol, limitPriceRaw));
          const baseAmountRaw = Number(usdtAmount) / limitPrice;
          const baseAmount = Number(this.exchange.amountToPrecision(symbol, baseAmountRaw));

          if (!baseAmount || !limitPrice) {
            throw new Error(`Invalid order sizing for ${symbol}`);
          }

          const order = await this.exchange.createOrder(symbol, 'limit', 'buy', baseAmount, limitPrice, {
            timeInForce: 'IOC',
          });

          const filled = Number(order?.filled || 0);
          if (filled <= 0) {
            throw new Error(`BUY IOC not filled for ${symbol}`);
          }

          const avgPrice = Number(order?.average || order?.avgPrice || limitPrice || 0);
          const cost = Number(order?.cost || (filled * avgPrice) || 0);

          logger.info(`KuCoin BUY order filled: ${order.id} (limit=${limitPrice}, filled=${filled})`);
          return {
            txid: order.id,
            simulated: false,
            limitPrice,
            executedPriceUsd: avgPrice,
            filledBaseQty: filled,
            filledQuoteUsd: cost,
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`KuCoin BUY retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('KuCoin BUY failed after retries');
    } catch (err) {
      logger.error(`KuCoin executeBuy failed: ${err.message}`);
      throw err;
    }
  }

  async executeSell(symbol, amount) {
    if (config.paperTrading) {
      logger.info(`[PAPER] KuCoin SELL ${symbol} amount ${amount}`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const maxSlippagePct = Math.max(0.1, Number(config.execution.kucoinMaxSlippagePct || 1.2));
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const { bestBid } = await this.getTopOfBook(symbol);
          const slippagePct = maxSlippagePct + (attempt - 1) * 0.25;
          const limitPriceRaw = bestBid * (1 - slippagePct / 100);
          const limitPrice = Number(this.exchange.priceToPrecision(symbol, limitPriceRaw));
          const sellAmount = Number(this.exchange.amountToPrecision(symbol, Number(amount)));

          if (!sellAmount || !limitPrice) {
            throw new Error(`Invalid sell sizing for ${symbol}`);
          }

          const order = await this.exchange.createOrder(symbol, 'limit', 'sell', sellAmount, limitPrice, {
            timeInForce: 'IOC',
          });

          const filled = Number(order?.filled || 0);
          if (filled <= 0) {
            throw new Error(`SELL IOC not filled for ${symbol}`);
          }

          const avgPrice = Number(order?.average || order?.avgPrice || limitPrice || 0);
          const cost = Number(order?.cost || (filled * avgPrice) || 0);

          logger.info(`KuCoin SELL order filled: ${order.id} (limit=${limitPrice}, filled=${filled})`);
          return {
            txid: order.id,
            simulated: false,
            limitPrice,
            executedPriceUsd: avgPrice,
            filledBaseQty: filled,
            filledQuoteUsd: cost,
          };
        } catch (error) {
          if (attempt >= retries) throw error;
          logger.warn(`KuCoin SELL retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('KuCoin SELL failed after retries');
    } catch (err) {
      logger.error(`KuCoin executeSell failed: ${err.message}`);
      throw err;
    }
  }

  async getBalance(asset = 'USDT') {
    if (!this.exchange) {
      logger.warn('KuCoin exchange not initialized, cannot fetch balance');
      return 0;
    }

    try {
      const balance = await this.exchange.fetchBalance();
      const free = balance[asset]?.free || 0;
      logger.debug(`KuCoin balance for ${asset}: ${free}`);
      return free;
    } catch (err) {
      logger.error(`KuCoin getBalance failed: ${err.message}`);
      return 0;
    }
  }

  async warmDepthCacheForTopSymbols(topN = 20) {
    if (!this.exchange) return;

    const symbols = Object.entries(this.tickerCache || {})
      .filter(([, ticker]) => ticker && ticker.last && ticker.quoteVolume)
      .sort(([, left], [, right]) => Number(right.quoteVolume || 0) - Number(left.quoteVolume || 0))
      .slice(0, Math.max(1, Number(topN || 20)))
      .map(([symbol]) => symbol);

    const OB_DEPTH_TTL_MS = 30_000;
    for (const symbol of symbols) {
      const cachedDepth = this.obDepthCache.get(symbol);
      if (cachedDepth && Date.now() - cachedDepth.fetchedAt < OB_DEPTH_TTL_MS) {
        continue;
      }

      try {
        const orderBook = await this.exchange.fetchOrderBook(symbol, 20);
        const topBids = (orderBook?.bids || []).slice(0, 10);
        const liquidityUsd = topBids.reduce((sum, [price, amount]) => sum + Number(price) * Number(amount), 0);
        if (liquidityUsd > 0) {
          this.obDepthCache.set(symbol, { liquidityUsd, fetchedAt: Date.now() });
        }
      } catch (_) {
        // Ignore warm-up misses and allow downstream fallback.
      }
    }
  }

  async getWalletPositions() {
    return [];
  }

  getSymbols() {
    return this.symbols;
  }

  async getSwingCandidates() {
    const candidates = [];
    const filtered = candidates.filter((sym) => !LEVERAGED_TOKEN_PATTERN.test(sym.replace('/USDT', '')));
    logger.debug(`KuCoin leveraged-token filter excluded ${candidates.length - filtered.length} symbols this cycle`);
    return filtered;
  }

  async getNewListings() {
    if (!this.exchange) return [];
    if (this._knownSymbols.size === 0) return [];
    try {
      await this.exchange.loadMarkets(true);
      const currentSymbols = Object.keys(this.exchange.markets).filter((s) => s.endsWith('/USDT'));
      const newSymbols = currentSymbols.filter((s) => {
        if (this._knownSymbols.has(s)) return false;
        return !LEVERAGED_TOKEN_PATTERN.test(s.replace('/USDT', ''));
      });
      currentSymbols.forEach((s) => this._knownSymbols.add(s));
      if (newSymbols.length > 0) {
        logger.info(`KuCoin new listings detected: ${newSymbols.join(', ')} (${newSymbols.length} new)`);
      }
      return newSymbols;
    } catch (err) {
      logger.warn(`KuCoin getNewListings failed: ${err.message}`);
      return [];
    }
  }

  async getNewTokens() {
    if (!this.tickerCache || Object.keys(this.tickerCache).length === 0) {
      await this.refreshTickers();
    }

    const depthWarmIntervalMs = 60_000;
    if (Date.now() - this.lastDepthWarmAt >= depthWarmIntervalMs) {
      await this.warmDepthCacheForTopSymbols(20);
      this.lastDepthWarmAt = Date.now();
    }

    const OB_DEPTH_TTL_MS = 30_000;

    const candidates = Object.entries(this.tickerCache)
      .filter(([, ticker]) => ticker && ticker.last && ticker.quoteVolume)
      .map(([symbol, ticker]) => {
        const cachedDepth = this.obDepthCache.get(symbol);
        const hasFreshDepth = cachedDepth && (Date.now() - cachedDepth.fetchedAt < OB_DEPTH_TTL_MS);
        return {
          symbol,
          liquidityUsd: hasFreshDepth
            ? Number(cachedDepth.liquidityUsd || 0)
            : Number(ticker.quoteVolume || 0) * Number(ticker.last || 0),
        };
      })
      .filter((item) => item.liquidityUsd >= config.risk.minLiquidityUsd)
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .slice(0, 200)
      .map((item) => item.symbol);

    const filtered = candidates.filter((sym) => !LEVERAGED_TOKEN_PATTERN.test(sym.replace('/USDT', '')));
    const excludedCount = candidates.length - filtered.length;
    if (excludedCount > 0) {
      logger.debug(`KuCoin leveraged-token filter excluded ${excludedCount} symbols this cycle`);
    }
    return filtered;
  }
}

module.exports = KuCoinExchange;