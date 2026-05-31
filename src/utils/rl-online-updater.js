'use strict';

class RLOnlineUpdater {
  constructor({ logger, config }) {
    this.logger = logger;
    this.config = config;
    this.qTable = new Map(); // state -> action -> q-value
    this.stateVisitCounts = new Map();
    this.experienceBuffer = [];
    this.maxBufferSize = 1000;
    this.learningRate = config.rl?.onlineLearningRate || 0.1;
    this.discountFactor = config.rl?.discountFactor || 0.95;
    this.explorationRate = config.rl?.explorationRate || 0.1;
  }

  /**
   * Update Q-values based on a completed trade outcome
   */
  /**
   * Update Q-values based on a completed trade outcome.
   *
   * B1.7: by default the call only BUFFERS the update; it does NOT touch the
   * live Q-table. An offline batch validator must confirm the update before it
   * is applied. To re-enable direct live updates set `config.rl.onlineUpdatesEnabled = true`
   * (do this ONLY after a shadow-validation pipeline is in place — uncritical
   * online updates against live Q-values were corrupting the policy on a
   * single unlucky trade sequence).
   */
  updateFromTrade(tradeOutcome) {
    if (!tradeOutcome || !(tradeOutcome.symbol || tradeOutcome.symbols) || !Number.isFinite(Number(tradeOutcome.pnl))) {
      return;
    }

    try {
      const state = this.encodeState(tradeOutcome);
      const action = this.encodeAction(tradeOutcome);
      const reward = this.computeReward(tradeOutcome);
      const nextState = this.encodeNextState(tradeOutcome);

      // Always record into experience buffer (used by future batch replay).
      this.recordExperience({ state, action, reward, nextState, ...tradeOutcome });

      // Always buffer into pending-validations queue for offline review.
      this._bufferPendingUpdate({
        state,
        action,
        reward,
        nextState,
        ts: Date.now(),
        symbols: tradeOutcome.symbols || [tradeOutcome.symbol],
        pnl: Number(tradeOutcome.pnl || 0),
        sizeUsd: Number(tradeOutcome.sizeUsd || 0),
        strategy: tradeOutcome.strategy || 'unknown',
      });

      const onlineEnabled = this.config?.rl?.onlineUpdatesEnabled === true;
      if (onlineEnabled) {
        this.updateQValue(state, action, reward, nextState);
        if (tradeOutcome.pnl > 0) {
          this.logger?.debug(
            `[RLOnline] LIVE Q-update applied: ${state} -> ${action} | reward=${reward.toFixed(2)} | PnL=$${tradeOutcome.pnl.toFixed(2)}`
          );
        }
      } else {
        this.logger?.debug(
          `[RLOnline] SHADOW buffered (online disabled): ${state} -> ${action} | reward=${reward.toFixed(2)} | PnL=$${tradeOutcome.pnl.toFixed(2)}`
        );
      }
    } catch (err) {
      this.logger?.warn(`[RLOnline] Failed to update from trade: ${err.message}`);
    }
  }

  /**
   * B1.7: queue update for offline validation. Persists to a JSONL file so
   * an external batch reviewer can apply only validated entries to the live
   * Q-table on a confirmed cadence.
   */
  _bufferPendingUpdate(entry) {
    if (!Array.isArray(this.pendingUpdates)) this.pendingUpdates = [];
    this.pendingUpdates.push(entry);
    const cap = Math.max(100, Number(this.maxBufferSize || 1000) * 2);
    while (this.pendingUpdates.length > cap) {
      this.pendingUpdates.shift();
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(process.cwd(), 'data');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const file = path.join(dir, 'rl-pending-validations.jsonl');
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (_) {
      // Best-effort persistence — never block the trade loop on disk I/O failures.
    }
  }

  getPendingUpdates() {
    return Array.isArray(this.pendingUpdates) ? this.pendingUpdates.slice() : [];
  }

  clearPendingUpdates() {
    this.pendingUpdates = [];
  }

  /**
   * Encode state from trade context
   */
  encodeState(tradeOutcome) {
    const winRate = this.calculateWinRate();
    const drawdown = this.calculateDrawdown(tradeOutcome.portfolio || {});
    const volatility = tradeOutcome.volatilityClass || 'normal';
    const momentum = this.classifyMomentum(tradeOutcome.priceChange24h || 0);

    return `wr:${Math.round(winRate / 10) * 10}|dd:${Math.round(drawdown)}|vol:${volatility}|mom:${momentum}`;
  }

  /**
   * Encode action taken in trade
   */
  encodeAction(tradeOutcome) {
    const sizeClass = this.classifySize(tradeOutcome.sizeUsd || 0, tradeOutcome.portfolio || {});
    const confidence = Math.round((tradeOutcome.confidence || 0.5) * 10) / 10;
    const strategy = tradeOutcome.strategy || 'momentum';

    return `strat:${strategy}|size:${sizeClass}|conf:${confidence}`;
  }

  /**
   * Encode next state (what state we'd be in after this trade)
   */
  encodeNextState(tradeOutcome) {
    const updatedWinRate = this.calculateUpdatedWinRate(tradeOutcome.pnl > 0);
    const updatedDrawdown = this.calculateUpdatedDrawdown(tradeOutcome.pnl, tradeOutcome.portfolio || {});
    const volatility = tradeOutcome.volatilityClass || 'normal';
    const momentum = this.classifyMomentum(tradeOutcome.priceChange24h || 0);

    return `wr:${Math.round(updatedWinRate / 10) * 10}|dd:${Math.round(updatedDrawdown)}|vol:${volatility}|mom:${momentum}`;
  }

  /**
   * Compute reward signal from trade outcome
   */
  computeReward(tradeOutcome) {
    const pnl = Number(tradeOutcome.pnl || 0);
    const pnlPercent = pnl / Math.max(1, Number(tradeOutcome.sizeUsd || 1));

    let reward = pnlPercent * 100; // Base reward from PnL %

    // Bonus for winning trades
    if (pnl > 0) {
      reward += 5; // +5 for any win
      if (pnlPercent > 0.20) reward += 10; // +10 for >20% win
      if (pnlPercent > 0.50) reward += 15; // +15 for >50% win
    } else {
      // Penalty for losing trades
      reward -= 3; // -3 for any loss
      if (pnlPercent < -0.10) reward -= 10; // -10 for >10% loss
    }

    // Reward for risk management
    if (tradeOutcome.holdMinutes < 60) {
      reward += 2; // +2 for quick exits
    }

    if (tradeOutcome.confidence > 0.8) {
      reward += (tradeOutcome.confidence - 0.8) * 20; // Scale by high confidence
    }

    // B2.13: drawdown penalty. Previous reward shape rewarded PnL % and quick
    // exits with no proportional penalty for cumulative drawdown. Reward-hacking
    // policies that maximize per-trade PnL while letting account drawdown drift
    // toward the kill-switch threshold passed evaluation. Penalize current
    // portfolio drawdown_pct (already exposed via calculateDrawdown) so the
    // policy converges on risk-adjusted PnL, not raw PnL.
    const currentDrawdownPct = this.calculateDrawdown(tradeOutcome.portfolio || {});
    if (Number.isFinite(currentDrawdownPct) && currentDrawdownPct > 0) {
      // Coefficient 0.15: a 20% account drawdown shaves 3 points off reward —
      // enough to flip a marginal win into a neutral signal, large losses become
      // strongly negative once drawdown stacks. Tune via rl.drawdownPenaltyCoef
      // if/when available on config.
      const drawdownPenaltyCoef = Number(tradeOutcome.drawdownPenaltyCoef ?? 0.15);
      reward -= currentDrawdownPct * drawdownPenaltyCoef;
    }

    return Math.max(-100, Math.min(100, reward)); // Clamp
  }

  /**
   * Update Q-value using Q-learning formula
   */
  updateQValue(state, action, reward, nextState) {
    const stateKey = `${state}:${action}`;
    const currentQ = this.getQ(state, action);
    const maxNextQ = this.getMaxQ(nextState);

    const newQ = currentQ + this.learningRate * (reward + this.discountFactor * maxNextQ - currentQ);

    this.setQ(state, action, newQ);

    // Track visits
    const visitKey = state;
    this.stateVisitCounts.set(visitKey, (this.stateVisitCounts.get(visitKey) || 0) + 1);
  }

  /**
   * Get Q-value for state-action pair
   */
  getQ(state, action) {
    const stateMap = this.qTable.get(state) || new Map();
    return stateMap.get(action) || 0;
  }

  /**
   * Set Q-value for state-action pair
   */
  setQ(state, action, value) {
    if (!this.qTable.has(state)) {
      this.qTable.set(state, new Map());
    }
    this.qTable.get(state).set(action, value);
  }

  /**
   * Get maximum Q-value for a state
   */
  getMaxQ(state) {
    const stateMap = this.qTable.get(state);
    if (!stateMap || stateMap.size === 0) return 0;

    return Math.max(...Array.from(stateMap.values()));
  }

  /**
   * Choose action using epsilon-greedy policy
   */
  chooseAction(state, availableActions = []) {
    if (Math.random() < this.explorationRate && availableActions.length > 0) {
      return availableActions[Math.floor(Math.random() * availableActions.length)];
    }

    const stateMap = this.qTable.get(state) || new Map();
    let bestAction = availableActions[0] || 'default';
    let bestValue = -Infinity;

    for (const action of availableActions) {
      const value = stateMap.get(action) || 0;
      if (value > bestValue) {
        bestValue = value;
        bestAction = action;
      }
    }

    return bestAction;
  }

  /**
   * Record experience for offline analysis
   */
  recordExperience(experience) {
    this.experienceBuffer.push({
      ...experience,
      timestamp: new Date().toISOString(),
    });

    if (this.experienceBuffer.length > this.maxBufferSize) {
      this.experienceBuffer.shift();
    }
  }

  /**
   * Calculate current win rate
   */
  calculateWinRate() {
    if (this.experienceBuffer.length === 0) return 50;

    const wins = this.experienceBuffer.filter((e) => e.pnl > 0).length;
    return (wins / this.experienceBuffer.length) * 100;
  }

  /**
   * Calculate drawdown from portfolio
   */
  calculateDrawdown(portfolio) {
    const parsedCurrent = Number(portfolio.balance);
    const parsedPeak = Number(portfolio.peakBalance);
    const currentBalance = Number.isFinite(parsedCurrent) && parsedCurrent >= 0 ? parsedCurrent : null;
    const peakBalance = Number.isFinite(parsedPeak) && parsedPeak > 0
      ? parsedPeak
      : (currentBalance > 0 ? currentBalance : 0);

    if (currentBalance === null) return peakBalance > 0 ? 100 : 0;
    if (peakBalance <= 0) return 0;
    return Math.max(0, ((peakBalance - currentBalance) / peakBalance) * 100);
  }

  /**
   * Calculate updated win rate if trade outcome is applied
   */
  calculateUpdatedWinRate(isWin) {
    const currentWins = this.experienceBuffer.filter((e) => e.pnl > 0).length;
    const newWins = isWin ? currentWins + 1 : currentWins;
    const newTotal = this.experienceBuffer.length + 1;

    return (newWins / Math.max(1, newTotal)) * 100;
  }

  /**
   * Calculate updated drawdown
   */
  calculateUpdatedDrawdown(pnl, portfolio) {
    const parsedCurrent = Number(portfolio.balance);
    const parsedPeak = Number(portfolio.peakBalance);
    const currentBalance = Number.isFinite(parsedCurrent) && parsedCurrent >= 0 ? parsedCurrent : null;
    const baselineCurrent = currentBalance ?? 0;
    const newBalance = baselineCurrent + Number(pnl || 0);
    const peakBalance = Number.isFinite(parsedPeak) && parsedPeak > 0
      ? parsedPeak
      : (baselineCurrent > 0 ? baselineCurrent : 0);

    if (peakBalance <= 0) return 0;
    return Math.max(0, ((peakBalance - newBalance) / peakBalance) * 100);
  }

  /**
   * Classify size tier
   */
  classifySize(sizeUsd, portfolio) {
    const parsedBalance = Number(portfolio.balance);
    const balance = Number.isFinite(parsedBalance) && parsedBalance > 0 ? parsedBalance : null;
    if (balance === null) return Number(sizeUsd) > 0 ? 'large' : 'small';
    const sizePct = (sizeUsd / balance) * 100;

    if (sizePct > 5) return 'large';
    if (sizePct > 2) return 'medium';
    return 'small';
  }

  /**
   * Classify momentum
   */
  classifyMomentum(priceChange24h) {
    const change = Number(priceChange24h || 0);

    if (change > 20) return 'extreme_up';
    if (change > 10) return 'strong_up';
    if (change > 3) return 'moderate_up';
    if (change < -20) return 'extreme_down';
    if (change < -10) return 'strong_down';
    if (change < -3) return 'moderate_down';
    return 'neutral';
  }

  /**
   * Export Q-table for analysis/saving
   */
  exportQTable() {
    const exported = {};

    for (const [state, actionMap] of this.qTable.entries()) {
      exported[state] = {};
      for (const [action, value] of actionMap.entries()) {
        exported[state][action] = value;
      }
    }

    return {
      qTable: exported,
      stateVisits: Object.fromEntries(this.stateVisitCounts),
      learningRate: this.learningRate,
      explorationRate: this.explorationRate,
      bufferSize: this.experienceBuffer.length,
    };
  }

  /**
   * Import Q-table from saved state
   */
  importQTable(exportedData) {
    if (exportedData?.qTable) {
      this.qTable.clear();

      for (const [state, actionMap] of Object.entries(exportedData.qTable)) {
        const stateMapInst = new Map();
        for (const [action, value] of Object.entries(actionMap)) {
          stateMapInst.set(action, value);
        }
        this.qTable.set(state, stateMapInst);
      }
    }

    if (exportedData?.stateVisits) {
      this.stateVisitCounts.clear();
      for (const [state, count] of Object.entries(exportedData.stateVisits)) {
        this.stateVisitCounts.set(state, count);
      }
    }

    this.logger?.info(`[RLOnline] Imported Q-table with ${this.qTable.size} states`);
  }

  /**
   * Get Q-table statistics
   */
  getStats() {
    return {
      stateCount: this.qTable.size,
      actionCount: Array.from(this.qTable.values()).reduce((sum, m) => sum + m.size, 0),
      experienceCount: this.experienceBuffer.length,
      avgQValue: this.calculateAvgQValue(),
      maxQValue: this.calculateMaxQValue(),
    };
  }

  /**
   * Calculate average Q-value
   */
  calculateAvgQValue() {
    let sum = 0;
    let count = 0;

    for (const stateMap of this.qTable.values()) {
      for (const value of stateMap.values()) {
        sum += value;
        count += 1;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  /**
   * Calculate max Q-value
   */
  calculateMaxQValue() {
    let maxValue = -Infinity;

    for (const stateMap of this.qTable.values()) {
      for (const value of stateMap.values()) {
        maxValue = Math.max(maxValue, value);
      }
    }

    return Number.isFinite(maxValue) ? maxValue : 0;
  }
}

module.exports = RLOnlineUpdater;
