// agent.js
// Core agent interface for direct function call integration with the trading bot

const fs = require('fs');
const path = require('path');

class MarketAnalystAgent {
  constructor(bot) {
    this.bot = bot; // Reference to the main bot instance
    const dataDir = process.env.BOT_DATA_DIR || 'data';
    this.auditPath = path.join(bot?.projectRoot || process.cwd(), dataDir, 'agent-decisions.jsonl');
  }

  // Append a single decision to the audit log. Best-effort (sync to avoid race with caller return).
  _audit(action, payload) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), action, ...payload }) + '\n';
      fs.appendFileSync(this.auditPath, line, 'utf8');
    } catch (err) {
      try { this.bot?.logger?.debug?.(`[AGENT/audit] append failed: ${err.message}`); } catch (_) { /* swallow */ }
    }
  }

  // Decision API — every action funnels through _audit for tamper-evident review trail.
  buy(symbol, amount, reason = '') {
    this._audit('buy', { symbol, amount, reason });
    return this.bot.executeBuy({ symbol, amount, reason, source: 'agent' });
  }

  sell(symbol, amount, reason = '') {
    this._audit('sell', { symbol, amount, reason });
    return this.bot.executeSell({ symbol, amount, reason, source: 'agent' });
  }

  hold(symbol, reason = '') {
    this._audit('hold', { symbol, reason });
    return this.bot.executeHold({ symbol, reason, source: 'agent' });
  }

  setRisk(param, value) {
    this._audit('setRisk', { param, value });
    return this.bot.updateRiskParameter(param, value, 'agent');
  }

  pause(reason = '') {
    this._audit('pause', { reason });
    return this.bot.pauseTrading(reason, 'agent');
  }

  resume() {
    this._audit('resume', {});
    return this.bot.resumeTrading('agent');
  }

  updateFilter(filter, value) {
    this._audit('updateFilter', { filter, value });
    return this.bot.updateFilter(filter, value, 'agent');
  }

  log(message, level = 'info') {
    return this.bot.logger[level](`[AGENT] ${message}`);
  }

  requestHumanReview(context) {
    // Validate context shape before passing — bot.requestHumanReview may crash on malformed input.
    const safeContext = (context && typeof context === 'object') ? context : { raw: String(context) };
    this._audit('requestHumanReview', { context: safeContext });
    return this.bot.requestHumanReview(safeContext, 'agent');
  }
}

module.exports = MarketAnalystAgent;
