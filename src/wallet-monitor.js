'use strict';
const config = require('../config');
const logger = require('./utils/logger');
const { sendAlert } = require('./telegram');

class WalletMonitor {
  constructor(portfolio) {
    this.portfolio = portfolio;
    this.lastBalance = portfolio.balance;
    this.lastPnl = 0;
    this.sessionStartBalance = portfolio.balance;
    this.sessionStartedAt = new Date().toISOString();
    // Milestone thresholds already alerted (avoid spam)
    this.alertedPnlMilestones = new Set();
    this.lastPositionCount = 0;
    this.consecutiveLossAlertedAt = null;
  }

  formatDuration(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  async sendPnlUpdate() {
    const currentBalance = this.portfolio.balance;
    const currentPnl = currentBalance - this.sessionStartBalance;
    const pnlChange = currentPnl - this.lastPnl;

    // Alert on significant PnL changes (>=$10)
    if (Math.abs(pnlChange) >= 10) {
      const pnlPct = this.sessionStartBalance > 0
        ? (currentPnl / this.sessionStartBalance) * 100
        : 0;
      const sessionMs = Date.now() - Date.parse(this.sessionStartedAt);
      const message =
        `💰 <b>PnL Update</b>\n` +
        `Session: ${pnlPct >= 0 ? '+' : ''}$${currentPnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n` +
        `Balance: $${currentBalance.toFixed(2)} | Runtime: ${this.formatDuration(sessionMs)}`;
      await sendAlert(message);
      this.lastPnl = currentPnl;
    }

    // Alert on PnL milestones: every 5% return from session start
    if (this.sessionStartBalance > 0) {
      const pnlPct = (currentPnl / this.sessionStartBalance) * 100;
      const milestoneStep = 5; // every 5%
      const milestone = Math.floor(Math.abs(pnlPct) / milestoneStep) * milestoneStep;
      if (milestone >= milestoneStep) {
        const milestoneKey = `${pnlPct >= 0 ? '+' : '-'}${milestone}`;
        if (!this.alertedPnlMilestones.has(milestoneKey)) {
          this.alertedPnlMilestones.add(milestoneKey);
          const icon = pnlPct >= 0 ? '🚀' : '📉';
          await sendAlert(
            `${icon} <b>PnL Milestone: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%</b>\n` +
            `Balance: $${currentBalance.toFixed(2)}`
          );
        }
      }
    }
  }

  async checkBalance() {
    const currentBalance = this.portfolio.balance;
    const balanceChange = currentBalance - this.lastBalance;

    if (Math.abs(balanceChange) >= 5) {
      const changePct = this.lastBalance > 0
        ? (balanceChange / this.lastBalance) * 100
        : 0;
      logger.info(
        `Balance update: ${balanceChange >= 0 ? '+' : ''}$${balanceChange.toFixed(2)} ` +
        `(${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%) → $${currentBalance.toFixed(2)}`
      );
      this.lastBalance = currentBalance;
    }
  }

  async checkConsecutiveLosses() {
    const consecutiveLosses = this.portfolio.stats?.consecutiveLosses || 0;
    const alertThreshold = Math.max(3, Number(config.risk?.consecutiveLossAlertThreshold || 4));
    if (consecutiveLosses >= alertThreshold) {
      const now = Date.now();
      const lastAlertMs = this.consecutiveLossAlertedAt ? Date.now() - this.consecutiveLossAlertedAt : Infinity;
      if (lastAlertMs > 60 * 60 * 1000) { // max once per hour
        this.consecutiveLossAlertedAt = now;
        await sendAlert(
          `⚠️ <b>${consecutiveLosses} Consecutive Losses</b>\n` +
          `Consider reviewing strategy parameters.\n` +
          `Gross Loss: $${(this.portfolio.stats?.grossLoss || 0).toFixed(2)}`
        );
      }
    } else {
      this.consecutiveLossAlertedAt = null;
    }
  }

  async checkPositionChanges() {
    const positionCount = Object.keys(this.portfolio.positions || {}).length;
    if (positionCount !== this.lastPositionCount) {
      this.lastPositionCount = positionCount;
    }
  }

  async monitor() {
    await this.sendPnlUpdate();
    await this.checkBalance();
    await this.checkConsecutiveLosses();
    await this.checkPositionChanges();
  }
}

module.exports = WalletMonitor;