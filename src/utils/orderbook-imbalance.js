'use strict';

class OrderBookImbalanceAnalyzer {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.cache = new Map();
    this.cacheTtlMs = 5000; // 5s cache for orderbook data
  }

  /**
   * Analyzes bid/ask imbalance from an orderbook.
   * Returns imbalance ratio: positive = more buy pressure, negative = more sell pressure
   * Range: -1.0 to +1.0 where +1 = all bids, 0 = balanced, -1 = all asks
   */
  calculateImbalance(bids = [], asks = []) {
    if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
      return null;
    }

    try {
      const bidVolume = bids.reduce((sum, [price, qty]) => sum + (Number(qty) || 0), 0);
      const askVolume = asks.reduce((sum, [price, qty]) => sum + (Number(qty) || 0), 0);
      const totalVolume = bidVolume + askVolume;

      if (totalVolume <= 0) return null;

      const bidRatio = bidVolume / totalVolume;
      const askRatio = askVolume / totalVolume;

      return bidRatio - askRatio;
    } catch (err) {
      this.logger?.warn(`[OrderBook] Error calculating imbalance: ${err.message}`);
      return null;
    }
  }

  /**
   * Calculates depth imbalance at different price levels.
   * Measures how much volume is within certain % of best bid/ask.
   */
  calculateDepthImbalance(bids = [], asks = []) {
    if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
      return { imbalance: null, bidDepth: 0, askDepth: 0 };
    }

    try {
      const bestBid = Number(bids[0]?.[0]) || 0;
      const bestAsk = Number(asks[0]?.[0]) || 0;

      if (bestBid <= 0 || bestAsk <= 0) return { imbalance: null, bidDepth: 0, askDepth: 0 };

      const bidSpread = bestBid * 0.01; // 1% of best bid
      const askSpread = bestAsk * 0.01;

      const nearBidVolume = bids
        .filter(([price]) => Number(price) >= bestBid - bidSpread)
        .reduce((sum, [, qty]) => sum + (Number(qty) || 0), 0);

      const nearAskVolume = asks
        .filter(([price]) => Number(price) <= bestAsk + askSpread)
        .reduce((sum, [, qty]) => sum + (Number(qty) || 0), 0);

      const totalNearVolume = nearBidVolume + nearAskVolume;

      if (totalNearVolume <= 0) {
        return { imbalance: null, bidDepth: 0, askDepth: 0 };
      }

      const depthImbalance = (nearBidVolume - nearAskVolume) / totalNearVolume;

      return {
        imbalance: depthImbalance,
        bidDepth: nearBidVolume,
        askDepth: nearAskVolume,
        spread: ((bestAsk - bestBid) / bestBid) * 100,
      };
    } catch (err) {
      this.logger?.warn(`[OrderBook] Error calculating depth imbalance: ${err.message}`);
      return { imbalance: null, bidDepth: 0, askDepth: 0 };
    }
  }

  /**
   * Fetches orderbook from Jupiter (Solana) or other exchanges
   */
  async fetchOrderbook(symbol, chain, exchange) {
    const cacheKey = `${chain}:${symbol}:${exchange}`;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      let bids = [];
      let asks = [];

      if (chain === 'solana' && exchange === 'jupiter') {
        const routeData = await this.fetchJupiterRoute(symbol);
        if (routeData?.routePlan) {
          ({ bids, asks } = this.parseJupiterOrderbook(routeData));
        }
      } else if (chain === 'bsc' && exchange === 'pancakeswap') {
        ({ bids, asks } = await this.fetchPancakeswapOrderbook(symbol));
      } else if (chain === 'kucoin' && exchange === 'kucoin') {
        ({ bids, asks } = await this.fetchKuCoinOrderbook(symbol));
      }

      const data = { bids, asks, timestamp: Date.now() };
      this.cache.set(cacheKey, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      this.logger?.warn(`[OrderBook] Failed to fetch ${chain}/${symbol}: ${err.message}`);
      return { bids: [], asks: [] };
    }
  }

  async fetchJupiterRoute(tokenSymbol) {
    try {
      const endpoint = 'https://api.jup.ag/quote?outputMint=EPjFWaLb3odcccccccccccccccccccccccccccccccccc&inputMint=So11111111111111111111111111111111111111112&amount=1000000';
      const res = await (await import('axios')).default.get(endpoint, { timeout: 5000 });
      return res.data;
    } catch (err) {
      return null;
    }
  }

  parseJupiterOrderbook(routeData) {
    const bids = [];
    const asks = [];
    try {
      if (routeData?.routePlan) {
        routeData.routePlan.forEach((step) => {
          if (step.inAmount && step.outAmount) {
            const price = Number(step.outAmount) / Number(step.inAmount);
            asks.push([price, Number(step.inAmount)]);
          }
        });
      }
    } catch (err) {
      this.logger?.debug(`[OrderBook] Parse error: ${err.message}`);
    }
    return { bids, asks };
  }

  async fetchPancakeswapOrderbook(tokenSymbol) {
    // Pancakeswap doesn't have traditional orderbook, return empty
    return { bids: [], asks: [] };
  }

  async fetchKuCoinOrderbook(tokenSymbol) {
    try {
      const pair = `${tokenSymbol}-USDT`;
      const endpoint = `https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=${pair}`;
      const res = await (await import('axios')).default.get(endpoint, { timeout: 5000 });
      const { data } = res.data;
      return {
        bids: (data?.bids || []).map(([price, qty]) => [Number(price), Number(qty)]),
        asks: (data?.asks || []).map(([price, qty]) => [Number(price), Number(qty)]),
      };
    } catch (err) {
      return { bids: [], asks: [] };
    }
  }

  /**
   * Get buy signal strength from orderbook imbalance (0-100)
   * Threshold: imbalance > 0.15 = bullish signal
   */
  getBuySignalStrength(depthImbalance) {
    if (!Number.isFinite(depthImbalance)) return 0;

    const imbalance = Math.max(-1, Math.min(1, depthImbalance));

    if (imbalance <= 0) return 0;

    if (imbalance >= 0.3) return 100;
    if (imbalance >= 0.25) return 85;
    if (imbalance >= 0.20) return 70;
    if (imbalance >= 0.15) return 55;
    if (imbalance >= 0.10) return 40;
    if (imbalance >= 0.05) return 25;

    return Math.round(imbalance * 250);
  }

  /**
   * Analyze orderbook and return buy signal quality
   */
  async analyzeOrderbook(symbol, chain, exchange = null) {
    const orderbook = await this.fetchOrderbook(symbol, chain, exchange);
    const imbalance = this.calculateImbalance(orderbook.bids, orderbook.asks);
    const depth = this.calculateDepthImbalance(orderbook.bids, orderbook.asks);
    const signalStrength = this.getBuySignalStrength(depth.imbalance);

    return {
      imbalance,
      depthImbalance: depth.imbalance,
      bidDepth: depth.bidDepth,
      askDepth: depth.askDepth,
      spread: depth.spread || 0,
      signalStrength: Math.round(signalStrength),
      isBullish: signalStrength >= 55,
    };
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = OrderBookImbalanceAnalyzer;
