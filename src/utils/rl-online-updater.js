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
  updateFromTrade(tradeOutcome) {
    if (!tradeOutcome || !tradeOutcome.symbols || !tradeOutcome.pnl) {
      return;
    }

    try {
      const state = this.encodeState(tradeOutcome);
      const action = this.encodeAction(tradeOutcome);
      const reward = this.computeReward(tradeOutcome);
      const nextState = this.encodeNextState(tradeOutcome);

      this.updateQValue(state, action, reward, nextState);
      this.recordExperience({ state, action, reward, nextState, ...tradeOutcome });

      if (tradeOutcome.pnl > 0) {
        this.logger?.debug(
          `[RLOnline] Updated Q-table: ${state} -> ${action} | reward=${reward.toFixed(2)} | PnL=$${tradeOutcome.pnl.toFixed(2)}`
        );
      }
    } catch (err) {
      this.logger?.warn(`[RLOnline] Failed to update from trade: ${err.message}`);
    }
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
      if (pnlPercent > 20) reward += 10; // +10 for >20% win
      if (pnlPercent > 50) reward += 15; // +15 for >50% win
    } else {
      // Penalty for losing trades
      reward -= 3; // -3 for any loss
      if (pnlPercent < -10) reward -= 10; // -10 for >10% loss
    }

    // Reward for risk management
    if (tradeOutcome.holdMinutes < 60) {
      reward += 2; // +2 for quick exits
    }

    if (tradeOutcome.confidence > 0.8) {
      reward += (tradeOutcome.confidence - 0.8) * 20; // Scale by high confidence
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
    const peakBalance = portfolio.peakBalance || portfolio.balance || 10000;
    const currentBalance = portfolio.balance || 10000;

    if (peakBalance <= 0) return 0;
    return ((peakBalance - currentBalance) / peakBalance) * 100;
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
    const newBalance = (portfolio.balance || 10000) + pnl;
    const peakBalance = portfolio.peakBalance || portfolio.balance || 10000;

    if (peakBalance <= 0) return 0;
    return Math.max(0, ((peakBalance - newBalance) / peakBalance) * 100);
  }

  /**
   * Classify size tier
   */
  classifySize(sizeUsd, portfolio) {
    const balance = portfolio.balance || 10000;
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
