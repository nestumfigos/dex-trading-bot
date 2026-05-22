'use strict';

class ShadowStrategyValidator {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.shadowRuns = new Map();
    this.maxTrackedRuns = 10;
    this.minSamplesForValidation = 5;
  }

  /**
   * Start shadow evaluation of a proposed mutation
   */
  startShadowRun(mutationId, proposedChanges, baselineStrategy = {}) {
    const shadowRunId = `shadow_${mutationId}_${Date.now()}`;

    const shadowRun = {
      id: shadowRunId,
      mutationId,
      proposedChanges,
      baselineStrategy,
      startedAt: new Date().toISOString(),
      shadowTrades: [],
      shadowStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        avgPnlPct: 0,
        maxWin: 0,
        maxLoss: 0,
      },
      liveStats: {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        avgPnlPct: 0,
        maxWin: 0,
        maxLoss: 0,
      },
      divergences: [],
      validationStatus: 'running',
      validationScores: {},
    };

    this.shadowRuns.set(shadowRunId, shadowRun);

    // Cleanup old runs
    if (this.shadowRuns.size > this.maxTrackedRuns) {
      const oldest = Array.from(this.shadowRuns.entries())
        .sort((a, b) => new Date(a[1].startedAt) - new Date(b[1].startedAt))[0];
      if (oldest) {
        this.shadowRuns.delete(oldest[0]);
      }
    }

    this.logger?.info(`[Shadow] Started shadow run: ${shadowRunId} for mutation ${mutationId}`);
    return shadowRunId;
  }

  /**
   * Record a live trade outcome
   */
  recordLiveTradeOutcome(shadowRunId, tradeData) {
    const shadowRun = this.shadowRuns.get(shadowRunId);
    if (!shadowRun) return;

    const trade = {
      symbol: tradeData.symbol,
      timestamp: tradeData.timestamp || new Date().toISOString(),
      entryPrice: tradeData.entryPrice,
      exitPrice: tradeData.exitPrice,
      pnl: tradeData.pnl || 0,
      pnlPct: tradeData.pnlPct || 0,
      duration: tradeData.duration || 0,
      strategy: tradeData.strategy,
      confidence: tradeData.confidence || 0.5,
      isWin: tradeData.pnl >= 0,
    };

    // Update live stats
    shadowRun.liveStats.trades += 1;
    shadowRun.liveStats.totalPnl += trade.pnl;

    if (trade.isWin) {
      shadowRun.liveStats.wins += 1;
      shadowRun.liveStats.maxWin = Math.max(shadowRun.liveStats.maxWin, trade.pnl);
    } else {
      shadowRun.liveStats.losses += 1;
      shadowRun.liveStats.maxLoss = Math.min(shadowRun.liveStats.maxLoss, trade.pnl);
    }

    shadowRun.liveStats.totalPnlPct += trade.pnlPct;
    shadowRun.liveStats.avgPnlPct = shadowRun.liveStats.totalPnlPct / shadowRun.liveStats.trades;
  }

  /**
   * Simulate the same trade with shadow/proposed parameters
   */
  simulateShadowTradeOutcome(shadowRunId, liveTradeData) {
    const shadowRun = this.shadowRuns.get(shadowRunId);
    if (!shadowRun) return null;

    const { proposedChanges } = shadowRun;

    // Apply proposed parameter mutations
    let simulatedEntryPrice = liveTradeData.entryPrice;
    let simulatedExitPrice = liveTradeData.exitPrice;
    let simulatedConfidence = liveTradeData.confidence || 0.5;

    // Example mutations (customize based on your evolution strategy)
    if (proposedChanges.rsiThresholdDelta) {
      // Shadow might reject the trade if RSI would be out of bounds with new threshold
      const newThreshold = 45 + (proposedChanges.rsiThresholdDelta || 0);
      const rsi = liveTradeData.rsi || 50;
      if (Math.abs(rsi - newThreshold) > 15) {
        return null; // Shadow strategy would skip this trade
      }
    }

    if (proposedChanges.confidenceFloor) {
      // Higher confidence floor might filter out lower-confidence trades
      if (simulatedConfidence < proposedChanges.confidenceFloor) {
        return null;
      }
      // But if we keep it, confidence boost adds edge
      simulatedConfidence *= (1 + proposedChanges.confidenceBoost || 0);
    }

    if (proposedChanges.slippageBpsReduction) {
      // Better execution (lower slippage) improves entry/exit
      const slippageImprovement = (proposedChanges.slippageBpsReduction / 10000) * simulatedEntryPrice;
      simulatedEntryPrice -= slippageImprovement;
      simulatedExitPrice += slippageImprovement;
    }

    if (proposedChanges.exitDelayMs !== undefined) {
      // Faster exits might catch momentum better or avoid reversals
      const exitQualityScaling = proposedChanges.exitDelayMs < 30_000 ? 1.05 : 0.98;
      simulatedExitPrice *= exitQualityScaling;
    }

    // Calculate simulated PnL
    const simulatedPnl = simulatedExitPrice - simulatedEntryPrice;
    const simulatedPnlPct = (simulatedPnl / simulatedEntryPrice) * 100;

    const shadowTrade = {
      symbol: liveTradeData.symbol,
      timestamp: liveTradeData.timestamp || new Date().toISOString(),
      entryPrice: simulatedEntryPrice,
      exitPrice: simulatedExitPrice,
      pnl: simulatedPnl,
      pnlPct: simulatedPnlPct,
      isWin: simulatedPnl >= 0,
      divergenceFromLive: simulatedPnlPct - (liveTradeData.pnlPct || 0),
    };

    // Update shadow stats
    shadowRun.shadowTrades.push(shadowTrade);
    shadowRun.shadowStats.trades += 1;
    shadowRun.shadowStats.totalPnl += shadowTrade.pnl;

    if (shadowTrade.isWin) {
      shadowRun.shadowStats.wins += 1;
      shadowRun.shadowStats.maxWin = Math.max(shadowRun.shadowStats.maxWin, shadowTrade.pnl);
    } else {
      shadowRun.shadowStats.losses += 1;
      shadowRun.shadowStats.maxLoss = Math.min(shadowRun.shadowStats.maxLoss, shadowTrade.pnl);
    }

    shadowRun.shadowStats.totalPnlPct += shadowTrade.pnlPct;
    shadowRun.shadowStats.avgPnlPct = shadowRun.shadowStats.totalPnlPct / shadowRun.shadowStats.trades;

    // Track significant divergences
    if (Math.abs(shadowTrade.divergenceFromLive) > 5) {
      shadowRun.divergences.push({
        symbol: shadowTrade.symbol,
        divergencePct: shadowTrade.divergenceFromLive,
        timestamp: shadowTrade.timestamp,
      });
    }

    return shadowTrade;
  }

  /**
   * Finalize shadow run and determine if mutation is valid
   */
  finalizeShadowRun(shadowRunId) {
    const shadowRun = this.shadowRuns.get(shadowRunId);
    if (!shadowRun) return null;

    if (shadowRun.shadowStats.trades < this.minSamplesForValidation) {
      shadowRun.validationStatus = 'insufficient_data';
      this.logger?.warn(`[Shadow] Insufficient samples (${shadowRun.shadowStats.trades}) for validation`);
      return shadowRun;
    }

    const validation = this.validateMutation(shadowRun);
    shadowRun.validationScores = validation.scores;
    shadowRun.validationStatus = validation.isValid ? 'valid' : 'invalid';
    shadowRun.validationReason = validation.reason;

    this.logger?.info(
      `[Shadow] ${shadowRunId} validation: ${validation.isValid ? 'APPROVED' : 'REJECTED'} | Score=${validation.overallScore}%`
    );

    return shadowRun;
  }

  /**
   * Validate if shadow mutation improved strategy
   */
  validateMutation(shadowRun) {
    const live = shadowRun.liveStats;
    const shadow = shadowRun.shadowStats;

    const scores = {
      winRateImprovement: 0,
      pnlImprovement: 0,
      riskReduction: 0,
      consistency: 0,
    };

    // Win rate improvement
    const livWinRate = live.trades > 0 ? (live.wins / live.trades) * 100 : 50;
    const shadowWinRate = shadow.trades > 0 ? (shadow.wins / shadow.trades) * 100 : 50;
    const winRateDelta = shadowWinRate - livWinRate;

    if (winRateDelta > 5) {
      scores.winRateImprovement = Math.min(100, 50 + winRateDelta * 5);
    } else if (winRateDelta < -5) {
      scores.winRateImprovement = Math.max(0, 50 + winRateDelta * 5);
    } else {
      scores.winRateImprovement = 50; // Neutral
    }

    // PnL improvement
    const livePnLImprovement = shadow.totalPnl - live.totalPnl;
    const livePnLImprovementPct = live.totalPnl !== 0
      ? (livePnLImprovement / Math.abs(live.totalPnl)) * 100
      : (livePnLImprovement > 0 ? 100 : 0);

    if (livePnLImprovementPct > 10) {
      scores.pnlImprovement = 95;
    } else if (livePnLImprovementPct > 5) {
      scores.pnlImprovement = 80;
    } else if (livePnLImprovementPct > 0) {
      scores.pnlImprovement = 65;
    } else if (livePnLImprovementPct > -5) {
      scores.pnlImprovement = 50;
    } else {
      scores.pnlImprovement = Math.max(0, 50 + livePnLImprovementPct * 5);
    }

    // Risk reduction (lower max loss)
    const liveMaxLoss = live.maxLoss || 0;
    const shadowMaxLoss = shadow.maxLoss || 0;
    const riskReduction = liveMaxLoss - shadowMaxLoss;

    if (riskReduction > 0) {
      scores.riskReduction = Math.min(100, 50 + (riskReduction / Math.abs(liveMaxLoss || 1)) * 50);
    } else {
      scores.riskReduction = 50 - Math.abs(riskReduction / Math.abs(liveMaxLoss || 1)) * 30;
    }

    // Consistency (lower std dev in outcomes)
    const liveDev = this.calculateStdDev(shadowRun.shadowTrades.map((t) => t.pnlPct) || []);
    const shadowDev = this.calculateStdDev(
      shadowRun.liveStats.trades > 0
        ? [shadowRun.liveStats.totalPnlPct / shadowRun.liveStats.trades]
        : []
    );

    if (liveDev > shadowDev) {
      scores.consistency = Math.min(100, 70 + (liveDev - shadowDev) * 2);
    } else {
      scores.consistency = Math.max(20, 70 - (shadowDev - liveDev) * 2);
    }

    // Overall score (weighted average)
    const overallScore = (scores.winRateImprovement * 0.25
      + scores.pnlImprovement * 0.35
      + scores.riskReduction * 0.25
      + scores.consistency * 0.15);

    const isValid = overallScore > 60 && (livePnLImprovementPct >= 0 || winRateDelta >= 3);

    return {
      scores,
      overallScore: Math.round(overallScore),
      isValid,
      reason: isValid
        ? `Shadow outperformed: PnL+${livePnLImprovementPct.toFixed(1)}%, WR+${winRateDelta.toFixed(1)}%`
        : `Shadow underperformed: PnL${livePnLImprovementPct.toFixed(1)}%, WR${winRateDelta.toFixed(1)}%`,
    };
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(values) {
    if (values.length === 0) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Get shadow run status
   */
  getShadowRunStatus(shadowRunId) {
    return this.shadowRuns.get(shadowRunId) || null;
  }

  /**
   * Get all active shadow runs
   */
  getActiveShadowRuns() {
    return Array.from(this.shadowRuns.values()).filter((r) => r.validationStatus === 'running');
  }
}

module.exports = ShadowStrategyValidator;
