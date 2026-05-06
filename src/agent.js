// agent.js
// Core agent interface for direct function call integration with the trading bot

class MarketAnalystAgent {
  constructor(bot) {
    this.bot = bot; // Reference to the main bot instance
  }

  // Decision API
  buy(symbol, amount, reason = '') {
    return this.bot.executeBuy({ symbol, amount, reason, source: 'agent' });
  }

  sell(symbol, amount, reason = '') {
    return this.bot.executeSell({ symbol, amount, reason, source: 'agent' });
  }

  hold(symbol, reason = '') {
    return this.bot.executeHold({ symbol, reason, source: 'agent' });
  }

  setRisk(param, value) {
    return this.bot.updateRiskParameter(param, value, 'agent');
  }

  pause(reason = '') {
    return this.bot.pauseTrading(reason, 'agent');
  }

  resume() {
    return this.bot.resumeTrading('agent');
  }

  updateFilter(filter, value) {
    return this.bot.updateFilter(filter, value, 'agent');
  }

  log(message, level = 'info') {
    return this.bot.logger[level](`[AGENT] ${message}`);
  }

  requestHumanReview(context) {
    return this.bot.requestHumanReview(context, 'agent');
  }
}

module.exports = MarketAnalystAgent;
