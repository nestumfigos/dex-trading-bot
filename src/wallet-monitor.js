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
  }

  async sendPnlUpdate() {
    const currentBalance = this.portfolio.balance;
    const currentPnl = currentBalance - this.sessionStartBalance;
    const pnlChange = currentPnl - this.lastPnl;

    if (Math.abs(pnlChange) >= 10) { // Only send updates for significant changes
      const pnlPct = this.sessionStartBalance > 0
        ? (currentPnl / this.sessionStartBalance) * 100
        : 0;
      const message = `💰 PNL Update: $${currentPnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | Balance: $${currentBalance.toFixed(2)}`;
      await sendAlert(message);
      this.lastPnl = currentPnl;
    }
  }

  async checkBalance() {
    const currentBalance = this.portfolio.balance;
    const balanceChange = currentBalance - this.lastBalance;

    if (Math.abs(balanceChange) >= 5) { // Significant balance change
      const changePct = this.lastBalance > 0
        ? (balanceChange / this.lastBalance) * 100
        : 0;
      const message = `⚖️ Balance Change: ${balanceChange >= 0 ? '+' : ''}$${balanceChange.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%) | New: $${currentBalance.toFixed(2)}`;
      await sendAlert(message);
      this.lastBalance = currentBalance;
    }
  }

  async monitor() {
    await this.sendPnlUpdate();
    await this.checkBalance();
  }
}

module.exports = WalletMonitor;