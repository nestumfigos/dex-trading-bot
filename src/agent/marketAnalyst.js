// src/agent/marketAnalyst.js
// Placeholder for the agent's core intelligence (LLM, strategies, learning, safety)

const MarketAnalystAgent = require('../agent');
const { fetchOHLCV } = require('../utils/ohlcv');
const { calculateIndicator } = require('../utils/ta');
const { fetchOnChainData } = require('../utils/onchain');

class MarketAnalyst extends MarketAnalystAgent {
  /**
   * @param {any} bot
   */
  constructor(bot) {
    super(bot);
    // Add state, models, or config here
  }

  /**
   * Fetch real-time OHLCV data for a symbol
   */
  /**
   * @param {string} symbol
   * @param {string} [interval]
   * @param {number} [limit]
   */
  async fetchOHLCV(symbol, interval = '1m', limit = 100) {
    return fetchOHLCV(symbol, interval, limit);
  }

  /**
   * Calculate a technical indicator using ta-lib
   */
  /**
   * @param {string} type
   * @param {any} params
   */
  async calculateIndicator(type, params) {
    return calculateIndicator(type, params);
  }

  /**
   * Fetch on-chain data for a given chain/address
   */
  /**
   * @param {string} chain
   * @param {string} address
   */
  async fetchOnChainData(chain, address) {
    return fetchOnChainData(chain, address);
  }

  /**
   * Analyze a chart image using a vision-capable model if available and free.
   * @param {Buffer|String} image - Image buffer or path/URL
   * @param {String} query - The analysis question or prompt
   * @returns {Promise<String>} - Analysis result or error message
   */
  /**
   * @param {Buffer|string} image
   * @param {string} [query]
   */
  async analyzeChartImage(image, query = 'Analyze this chart for trading signals.') {
    // Example: Integrate with vision model if available and free
    // Pseudocode for vision model integration
    if (process.env.VISION_MODEL === 'gpt-4o' || process.env.VISION_MODEL === 'claude-3.5' || process.env.VISION_MODEL === 'opus' || process.env.VISION_MODEL === 'grok') {
      if (process.env.VISION_MODEL_FREE === 'true') {
        // Replace with actual API call to vision model
        // e.g., return await callVisionModel(image, query);
        return '[Vision model analysis would be performed here if integrated]';
      } else {
        throw new Error('Vision model is not free to use. Skipping chart analysis.');
      }
    } else {
      throw new Error('No supported vision model available for chart analysis.');
    }
  }

  /**
   * @param {Array<any>} marketDataList
   * @param {any} botState
   */
  async decideAndAct(marketDataList, botState) {
    // Accepts an array of marketData objects, one per symbol
    const { getOhlcvSeries } = require('../utils/candles');
    const { momentumSignal } = require('../utils/indicators');
    const config = require('../../config');

    if (!Array.isArray(marketDataList)) {
      this.log('Input to decideAndAct must be an array of marketData objects.');
      return;
    }

    const results = [];
    for (const marketData of marketDataList) {
      const { symbol, chainKey, address, pairAddress, aiSignal, newsSignal, onchainSignal, sentimentSignal, riskOk } = marketData;
      if (!riskOk) {
        this.log(`[${symbol}] Risk check failed. No trade.`);
        results.push({ symbol, action: 'HOLD', reason: 'Risk check failed' });
        continue;
      }

      // Fetch OHLCV data for technical analysis
      let ohlcv = null;
      try {
        ohlcv = await getOhlcvSeries({ chainKey, address, pairAddress, interval: '15m', limit: 120 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`[${symbol}] OHLCV fetch error: ${msg}`);
        results.push({ symbol, action: 'HOLD', reason: 'OHLCV fetch error' });
        continue;
      }
      if (!ohlcv || !Array.isArray(ohlcv.candles) || ohlcv.candles.length < 30) {
        this.log(`[${symbol}] Insufficient OHLCV data.`);
        results.push({ symbol, action: 'HOLD', reason: 'Insufficient OHLCV data' });
        continue;
      }

      // Run technical indicators
      const priceHistory = ohlcv.closes;
      const volumeHistory = ohlcv.volumes;
      // @ts-ignore
      const stratCfg = config.strategies?.momentum || { emaFast: 8, emaSlow: 21, rsiPeriod: 14, rsiBuyThreshold: 45, rsiBuyMaxThreshold: 70, volumeSpikeMultiplier: 2 };
      const techResult = momentumSignal(priceHistory, volumeHistory, stratCfg);
      const technicalSignal = techResult.signal;
      const details = techResult.details || {};

      // Aggregate all signals
      const allStrongBuy = [aiSignal, technicalSignal, newsSignal, onchainSignal, sentimentSignal].every(s => s === 'BUY');
      const allStrongSell = [aiSignal, technicalSignal, newsSignal, onchainSignal, sentimentSignal].every(s => s === 'SELL');

      // Aggressive when justified: If technicals are extremely strong (e.g., momentum + volume spike + RSI breakout), increase risk
      let riskFraction = 0.01; // Default: 1% of capital
      let aggression = false;
      // Parse numeric values from details (from indicators.js)
      // Compute momentum if not present (fastEma - slowEma)
      // Always compute momentum from fastEma and slowEma
      let momentum = 0;
      if (typeof details.fastEma !== 'undefined' && typeof details.slowEma !== 'undefined') {
        momentum = Number(details.fastEma) - Number(details.slowEma);
      }
      const rsi = typeof details.rsi !== 'undefined' ? Number(details.rsi) : 0;
      const volumeSpike = typeof details.volumeSpike !== 'undefined' ? Number(details.volumeSpike) : 0;

      if (
        technicalSignal === 'BUY' &&
        momentum > 2 &&
        volumeSpike >= (stratCfg.volumeSpikeMultiplier || 2) &&
        rsi > 70
      ) {
        riskFraction = 0.05; // Up to 5% of capital if chart is extremely strong
        aggression = true;
      }
      if (
        technicalSignal === 'SELL' &&
        momentum < -2 &&
        volumeSpike >= (stratCfg.volumeSpikeMultiplier || 2) &&
        rsi < 30
      ) {
        riskFraction = 0.05;
        aggression = true;
      }
      const maxRisk = Math.max(riskFraction * (botState?.capital || 0), 10); // $10 min

      let action = 'HOLD';
      let reason = '';
      if (allStrongBuy) {
        action = 'BUY';
        reason = aggression
          ? 'Aggressive buy: chart and signals extremely strong'
          : 'All signals align (BUY)';
        this.log(`[${symbol}] ${reason}. Executing buy with risk ${riskFraction * 100}% of capital.`);
        await this.buy(symbol, maxRisk, reason);
      } else if (allStrongSell) {
        action = 'SELL';
        reason = aggression
          ? 'Aggressive sell: chart and signals extremely strong'
          : 'All signals align (SELL)';
        this.log(`[${symbol}] ${reason}. Executing sell with risk ${riskFraction * 100}% of capital.`);
        await this.sell(symbol, maxRisk, reason);
      } else {
        action = 'HOLD';
        reason = 'No consensus or weak signals. Staying disciplined.';
        this.log(`[${symbol}] ${reason} No trade.`);
      }

      // Structured output for this symbol
      results.push({
        symbol,
        action,
        reason,
        details: {
          aiSignal,
          technicalSignal,
          newsSignal,
          onchainSignal,
          sentimentSignal,
          riskOk,
          techResult,
          aggression,
          riskFraction,
        },
      });
    }

    // Optionally: return results for logging or further processing
    return results;
  }

  // Feedback/learning stub
  /**
   * @param {any} trade
   */
  onTradeOutcome(trade) {
    // If any loss, tighten criteria further
    if (trade && typeof trade.pnl === 'number' && trade.pnl < 0) {
      this.log('Loss detected. Tightening criteria.');
      // Example: could set an internal flag to require even more confirmation
      this.extraCautious = true;
    }
  }

  /**
   * Safety/override stub
   * @returns {boolean}
   */
  checkSafety() {
    // Hard safety: never allow >5% drawdown, max 1% risk per trade
    if (this.bot && typeof this.bot.getDrawdown === 'function' && this.bot.getDrawdown() > 0.05) {
      this.log('Drawdown exceeds 5%. Pausing trading.');
      this.pause('Max drawdown exceeded');
      return false;
    }
    return true;
  }
}

module.exports = MarketAnalyst;
