'use strict';

const { canIncreasePositionSize } = require('../policy/preconditions');

class PositionSizingEngine {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
  }

  /**
   * Calculates position size using smaller-iterations approach:
   * Start small, add if winning, reduce risk profile
   */
  calculateSmallIterationSize(tokenData, portfolio, strategy = 'momentum') {
    const baseSize = this.config.risk?.maxPositionSizePct || 3;
    const availableBalance = this.getAvailableBalance(portfolio);

    if (availableBalance <= 0) return 0;

    const baseUsdSize = (availableBalance * baseSize) / 100;
    const initialIterationPct = 0.25; // Start with 25% of normal size
    let iterationSize = baseUsdSize * initialIterationPct;

    const tokenMetrics = {
      rsi: Number(tokenData?.rsi) || 50,
      volumeSpike: Number(tokenData?.volumeSpike || 0),
      buyRatio: Number(tokenData?.buyRatioRecentPct || 0),
      priceChange24h: Number(tokenData?.priceChange24h || 0),
      confidence: Number(tokenData?.confidence || 0.5),
    };

    const recentTrades = this.getRecentTradesForSymbol(portfolio, tokenData?.symbol);
    const winRate = recentTrades.length > 0
      ? (recentTrades.filter((t) => t.pnl > 0).length / recentTrades.length) * 100
      : 50;

    const iteration = this.getIterationNumber(portfolio, tokenData?.symbol);
    let iterationMultiplier = this.getIterationMultiplier(iteration, winRate);

    // Week 5 policy gate: refuse to scale up past 1.0× during loss streaks /
    // sub-30% WR (pure sync gate; uses DEFAULTS — DB hot-reload deferred).
    if (iterationMultiplier > 1.0) {
      const consecutiveLosses = Number(portfolio?.stats?.consecutiveLosses) || 0;
      const policy = canIncreasePositionSize({ consecutiveLosses, winRate });
      if (!policy.allow) {
        if (this.logger && typeof this.logger.debug === 'function') {
          this.logger.debug(`[position-sizing/policy] cap multiplier ${iterationMultiplier.toFixed(2)}→1.0 for ${tokenData?.symbol}: ${policy.reason}`);
        }
        iterationMultiplier = 1.0;
      }
    }

    iterationSize *= iterationMultiplier;

    // Confidence-based scaling
    const confidenceScaling = this.getConfidenceScaling(tokenMetrics.confidence);
    iterationSize *= confidenceScaling;

    // Risk-on demand scaling (scale up in strong conditions, down in weak)
    const marketRegimeScaling = this.getMarketRegimeScaling(
      portfolio,
      tokenMetrics
    );
    iterationSize *= marketRegimeScaling;

    // Hard floors and ceilings
    const minSize = this.getMinPositionSize(portfolio);
    const maxSize = baseUsdSize * 0.75; // Cap at 75% of normal max

    return Math.max(minSize, Math.min(maxSize, iterationSize));
  }

  /**
   * Calculate scaling based on historical win rate
   * Increase size after wins, decrease after losses
   */
  getIterationMultiplier(iterationNumber, winRatePct) {
    const recentWinRate = Math.min(100, Math.max(0, winRatePct));

    if (iterationNumber === 1) return 1.0; // First iteration: base size

    if (iterationNumber === 2) {
      // Second iteration: scale based on first trade outcome
      return recentWinRate > 55 ? 1.5 : (recentWinRate > 45 ? 1.0 : 0.7);
    }

    if (iterationNumber >= 3) {
      // Subsequent iterations: scale based on overall win rate
      if (recentWinRate > 65) return 2.0;
      if (recentWinRate > 55) return 1.5;
      if (recentWinRate > 45) return 1.0;
      if (recentWinRate > 35) return 0.7;
      return 0.4;
    }

    return 1.0;
  }

  /**
   * Scale position size based on AI confidence
   */
  getConfidenceScaling(confidence) {
    if (confidence >= 0.85) return 1.3; // High confidence: scale up
    if (confidence >= 0.75) return 1.15;
    if (confidence >= 0.65) return 1.0;
    if (confidence >= 0.50) return 0.85;
    if (confidence >= 0.40) return 0.65;
    return 0.4; // Low confidence: scale way down
  }

  /**
   * Scale based on market regime and portfolio health
   */
  getMarketRegimeScaling(portfolio, metrics) {
    const recentTrades = Object.values(portfolio.closedTrades || {})
      .filter((t) => Date.now() - (t.closedAt || 0) < 24 * 3600 * 1000)
      .slice(-20);

    const drawdown = this.calculateDrawdown(portfolio);
    const recentWinRate = recentTrades.length > 0
      ? (recentTrades.filter((t) => (t.pnl || 0) > 0).length / recentTrades.length) * 100
      : 50;

    // Drawdown penalty
    if (drawdown > 15) return 0.3; // Heavy drawdown: drastically reduce
    if (drawdown > 10) return 0.5;
    if (drawdown > 5) return 0.7;

    // Hot streak bonus
    if (recentWinRate > 70 && recentTrades.length >= 5) return 1.4;
    if (recentWinRate > 60 && recentTrades.length >= 5) return 1.2;

    // Cold streak penalty
    if (recentWinRate < 30 && recentTrades.length >= 5) return 0.4;
    if (recentWinRate < 40 && recentTrades.length >= 5) return 0.6;

    // Normal market scaling: RSI and volume conditions
    const rsiMomentum = Math.abs(metrics.rsi - 50) / 50;
    const volumeBonus = metrics.volumeSpike > 1.5 ? 1.1 : 1.0;

    return (0.85 + rsiMomentum * 0.3) * volumeBonus;
  }

  /**
   * Get the iteration number for a symbol (how many times have we entered?)
   *
   * Counts completed SELL trades for the symbol + 1 (the next iteration about to open).
   * Tolerates `portfolio.closedTrades` being either an array, an object map, or a
   * numeric count — only the trades ledger is used to derive per-symbol history.
   */
  getIterationNumber(portfolio, symbol) {
    if (!symbol) return 1;
    const closedForSymbol = this.getRecentTradesForSymbol(portfolio, symbol);
    return closedForSymbol.length + 1;
  }

  /**
   * Get recent SELL trades for a symbol (completed iterations).
   *
   * Reads from `portfolio.trades` (the unified trade ledger) so that this works
   * even when `closedTrades` is stored as a numeric counter rather than an array.
   */
  getRecentTradesForSymbol(portfolio, symbol) {
    if (!symbol) return [];
    const cutoffMs = 14 * 24 * 3600 * 1000;
    const now = Date.now();
    const trades = Array.isArray(portfolio?.trades) ? portfolio.trades : [];
    return trades
      .filter((trade) => {
        if (!trade || trade.symbol !== symbol) return false;
        if (String(trade.type || '').toUpperCase() !== 'SELL') return false;
        const ts = trade.timestamp ? Date.parse(trade.timestamp) : (trade.closedAt || 0);
        if (!Number.isFinite(ts) || ts <= 0) return true;
        return (now - ts) < cutoffMs;
      })
      .slice(-10);
  }

  /**
   * Calculate current drawdown
   */
  calculateDrawdown(portfolio) {
    const parsedPeak = Number(portfolio.peakBalance);
    const parsedCurrent = Number(portfolio.balance);
    const currentBalance = Number.isFinite(parsedCurrent) ? parsedCurrent : 10000;
    const peakBalance = Number.isFinite(parsedPeak) && parsedPeak > 0
      ? parsedPeak
      : (currentBalance > 0 ? currentBalance : 10000);

    if (peakBalance <= 0) return 0;
    return ((peakBalance - currentBalance) / peakBalance) * 100;
  }

  /**
   * Get available balance for trading.
   *
   * `portfolio.balance` already represents free cash — positions have been
   * debited from it at entry — so subtracting `costBasisUsd` again here would
   * double-count open exposure and stall the sizing engine after a few buys.
   * Only the explicit safety reserve is withheld.
   */
  getAvailableBalance(portfolio) {
    const parsedBalance = Number(portfolio.balance);
    const totalBalance = Number.isFinite(parsedBalance) ? parsedBalance : 10000;
    const reservePercent = Number(this.config.risk?.minBalanceCoverage ?? 0.5);
    const reservedAmount = (totalBalance * reservePercent) / 100;
    return Math.max(0, totalBalance - reservedAmount);
  }

  /**
   * Get minimum position size
   */
  getMinPositionSize(portfolio) {
    const minSizeUsd = this.config.risk?.minPositionSizeUsd || 5;
    const parsedBalance = Number(portfolio.balance);
    const totalBalance = Number.isFinite(parsedBalance) ? parsedBalance : 10000;
    return Math.max(minSizeUsd, totalBalance * 0.001); // At least 0.1% of balance
  }

  /**
   * Suggest order scaling:
   * Return an array of order sizes for smaller iterations
   */
  suggestIterationSizes(baseSize, maxIterations = 3) {
    const sizes = [];
    let cumulativeSize = 0;

    for (let i = 1; i <= maxIterations; i++) {
      const multiplier = (1 / maxIterations) * i;
      const size = baseSize * multiplier;

      if (cumulativeSize + size <= baseSize * 1.5) {
        sizes.push(Math.round(size * 100) / 100);
        cumulativeSize += size;
      }
    }

    return sizes;
  }

  /**
   * Calculate pyramid sizing (larger as conviction grows)
   */
  calculatePyramidSizing(initialSize, profitPct, hasConfluenceSignal = false) {
    const baseScaling = profitPct / 100; // Scale with profit %

    if (!hasConfluenceSignal) {
      return initialSize;
    }

    if (profitPct > 10) {
      return initialSize * 1.8; // Up to 1.8x if profitable + confluence
    }
    if (profitPct > 5) {
      return initialSize * 1.4;
    }
    if (profitPct > 2) {
      return initialSize * 1.2;
    }

    return initialSize;
  }

  /**
   * Calculate reduce sizing (smaller exits to de-risk)
   */
  calculateReduceSizing(position) {
    const profitTarget = Number(this.config.risk?.takeProfitPct || 25);
    const currentProfit = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;

    if (currentProfit >= profitTarget * 0.8) {
      return Math.round(position.quantity * 0.4); // Take 40% off at 80% of TP
    }

    if (currentProfit >= profitTarget * 0.5) {
      return Math.round(position.quantity * 0.25); // Take 25% off at 50% of TP
    }

    return 0; // Don't reduce yet
  }
}

module.exports = PositionSizingEngine;
