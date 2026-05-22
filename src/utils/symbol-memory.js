'use strict';

class SymbolPnLMemory {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.symbolStats = new Map();
    this.maxDaysTracked = 14;
  }

  /**
   * Record trade outcome for a symbol
   */
  recordTrade(symbol, chain, strategyName, pnl, pnlPct, holdMinutes) {
    if (!symbol) return;

    const key = `${chain}:${symbol}`.toLowerCase();
    if (!this.symbolStats.has(key)) {
      this.symbolStats.set(key, {
        symbol,
        chain,
        trades: [],
        totalPnl: 0,
        wins: 0,
        losses: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        lastTradeAt: null,
        lastLossAt: null,
      });
    }

    const stats = this.symbolStats.get(key);
    const trade = {
      pnl: Number(pnl || 0),
      pnlPct: Number(pnlPct || 0),
      strategy: strategyName,
      timestamp: new Date().toISOString(),
      holdMinutes: holdMinutes || 0,
      isWin: pnl >= 0,
    };

    stats.trades.push(trade);
    stats.totalPnl += pnl;
    stats.lastTradeAt = trade.timestamp;

    if (trade.isWin) {
      stats.wins += 1;
      stats.consecutiveWins = (stats.consecutiveWins || 0) + 1;
      stats.consecutiveLosses = 0;
    } else {
      stats.losses += 1;
      stats.consecutiveLosses = (stats.consecutiveLosses || 0) + 1;
      stats.consecutiveWins = 0;
      stats.lastLossAt = trade.timestamp;
    }

    // Keep only last 50 trades per symbol
    if (stats.trades.length > 50) {
      stats.trades = stats.trades.slice(-50);
    }
  }

  /**
   * Get per-symbol win rate over lookback period
   */
  getSymbolWinRate(symbol, chain, daysLookback = 14) {
    const key = `${chain}:${symbol}`.toLowerCase();
    const stats = this.symbolStats.get(key);

    if (!stats || stats.trades.length === 0) {
      return null;
    }

    const cutoffTime = Date.now() - daysLookback * 24 * 3600 * 1000;
    const recentTrades = stats.trades.filter((t) => Date.parse(t.timestamp) > cutoffTime);

    if (recentTrades.length === 0) {
      return null;
    }

    const wins = recentTrades.filter((t) => t.isWin).length;
    return (wins / recentTrades.length) * 100;
  }

  /**
   * Get confidence penalty for repeated losses on a symbol
   * Returns additional confidence floor (in percentage points)
   */
  getSymbolPenalty(symbol, chain) {
    const key = `${chain}:${symbol}`.toLowerCase();
    const stats = this.symbolStats.get(key);

    if (!stats) {
      return 0; // No history, no penalty
    }

    const recentWinRate = this.getSymbolWinRate(symbol, chain, 14);

    // If symbol has lost 3+ times in 14 days, apply penalty
    const recentLosses = stats.trades
      .filter((t) => !t.isWin && Date.parse(t.timestamp) > Date.now() - 14 * 24 * 3600 * 1000)
      .length;

    if (recentLosses >= 3) {
      // Penalty scales with loss streak
      const basePenalty = 10; // Base +10pp confidence floor
      const streakBonus = Math.min(20, (stats.consecutiveLosses || 0) * 3); // Up to +20pp for streak

      return basePenalty + streakBonus;
    }

    // If symbol has poor win rate, apply lighter penalty
    if (recentWinRate !== null && recentWinRate < 35) {
      return 5; // +5pp confidence floor for weak performers
    }

    return 0; // No penalty
  }

  /**
   * Check if symbol is in "loss recovery" mode
   * True if it lost 3+ times and hasn't recovered yet
   */
  isInLossRecoveryMode(symbol, chain) {
    const penalty = this.getSymbolPenalty(symbol, chain);
    return penalty >= 10; // In recovery if penalty >= 10pp
  }

  /**
   * Get symbol statistics summary
   */
  getSymbolStats(symbol, chain) {
    const key = `${chain}:${symbol}`.toLowerCase();
    const stats = this.symbolStats.get(key);

    if (!stats) {
      return {
        symbol,
        chain,
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: null,
        totalPnl: 0,
        penalty: 0,
        inRecovery: false,
      };
    }

    const winRate = this.getSymbolWinRate(symbol, chain, 14);
    const penalty = this.getSymbolPenalty(symbol, chain);

    return {
      symbol,
      chain,
      trades: stats.trades.length,
      wins: stats.wins,
      losses: stats.losses,
      winRate: winRate ? Number(winRate.toFixed(1)) : null,
      totalPnl: Number(stats.totalPnl.toFixed(2)),
      consecutiveLosses: stats.consecutiveLosses || 0,
      lastTradeAt: stats.lastTradeAt,
      penalty,
      inRecovery: penalty >= 10,
    };
  }

  /**
   * Get worst-performing symbols (candidates to avoid)
   */
  getWorstPerformers(limit = 5) {
    const performers = Array.from(this.symbolStats.values())
      .map((stats) => ({
        symbol: stats.symbol,
        chain: stats.chain,
        trades: stats.trades.length,
        winRate: this.getSymbolWinRate(stats.symbol, stats.chain, 14),
        totalPnl: stats.totalPnl,
        consecutiveLosses: stats.consecutiveLosses || 0,
        penalty: this.getSymbolPenalty(stats.symbol, stats.chain),
      }))
      .filter((p) => p.trades >= 3) // Only symbols with enough history
      .sort((a, b) => {
        // Sort by: consecutive losses (desc) → win rate (asc) → total PnL (asc)
        if (b.consecutiveLosses !== a.consecutiveLosses) {
          return b.consecutiveLosses - a.consecutiveLosses;
        }
        if ((a.winRate || 50) !== (b.winRate || 50)) {
          return (a.winRate || 50) - (b.winRate || 50);
        }
        return a.totalPnl - b.totalPnl;
      })
      .slice(0, limit);

    return performers;
  }

  /**
   * Get all tracked symbols
   */
  getAllSymbols() {
    return Array.from(this.symbolStats.values()).map((stats) => ({
      symbol: stats.symbol,
      chain: stats.chain,
      trades: stats.trades.length,
      winRate: this.getSymbolWinRate(stats.symbol, stats.chain, 14),
      totalPnl: stats.totalPnl,
      penalty: this.getSymbolPenalty(stats.symbol, stats.chain),
    }));
  }

  /**
   * Clear old trades (older than 14 days)
   */
  pruneOldData() {
    const cutoffTime = Date.now() - this.maxDaysTracked * 24 * 3600 * 1000;

    for (const [key, stats] of this.symbolStats.entries()) {
      stats.trades = stats.trades.filter((t) => Date.parse(t.timestamp) > cutoffTime);

      // Remove symbol if no recent trades
      if (stats.trades.length === 0) {
        this.symbolStats.delete(key);
      }
    }
  }

  /**
   * Export memory for persistence
   */
  export() {
    const exported = {};

    for (const [key, stats] of this.symbolStats.entries()) {
      exported[key] = {
        symbol: stats.symbol,
        chain: stats.chain,
        trades: stats.trades.slice(-30), // Keep last 30
        totalPnl: stats.totalPnl,
        wins: stats.wins,
        losses: stats.losses,
      };
    }

    return exported;
  }

  /**
   * Import memory from saved state
   */
  import(exported) {
    if (!exported || typeof exported !== 'object') {
      return;
    }

    for (const [key, data] of Object.entries(exported)) {
      this.symbolStats.set(key, {
        symbol: data.symbol,
        chain: data.chain,
        trades: data.trades || [],
        totalPnl: data.totalPnl || 0,
        wins: data.wins || 0,
        losses: data.losses || 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        lastTradeAt: null,
        lastLossAt: null,
      });
    }

    this.logger?.info(`[SymbolMemory] Imported ${this.symbolStats.size} symbols`);
  }
}

module.exports = SymbolPnLMemory;
