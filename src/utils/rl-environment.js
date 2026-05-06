'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class TradingGymEnvironment {
  constructor(series = [], options = {}) {
    this.series = Array.isArray(series) ? series : [];
    this.options = {
      feePct: Number(options.feePct || 0.1),
      drawdownPenalty: Number(options.drawdownPenalty || 0.35),
      churnPenalty: Number(options.churnPenalty || 0.05),
      holdBonus: Number(options.holdBonus || 0.01),
    };
    this.reset();
  }

  reset() {
    this.index = 0;
    this.position = 0;
    this.entryPrice = 0;
    this.balance = 1;
    this.peakBalance = 1;
    return this.getState();
  }

  getState() {
    return this.series[this.index] || null;
  }

  step(action = 'HOLD') {
    const current = this.series[this.index] || {};
    const next = this.series[this.index + 1] || current;
    const currentPrice = Number(current?.price || current?.features?.price || 0);
    const nextPrice = Number(next?.price || next?.features?.price || currentPrice);
    let reward = 0;

    if (action === 'BUY' && this.position === 0 && currentPrice > 0) {
      this.position = 1;
      this.entryPrice = currentPrice;
      reward -= this.options.feePct / 100;
    } else if (action === 'SELL' && this.position === 1 && currentPrice > 0 && this.entryPrice > 0) {
      const pnlPct = ((currentPrice - this.entryPrice) / this.entryPrice) * 100;
      reward += pnlPct / 100;
      reward -= this.options.feePct / 100;
      this.position = 0;
      this.entryPrice = 0;
    } else if (action !== 'HOLD') {
      reward -= this.options.churnPenalty;
    }

    if (this.position === 1 && currentPrice > 0 && nextPrice > 0) {
      reward += ((nextPrice - currentPrice) / currentPrice);
      reward += this.options.holdBonus * Math.sign(nextPrice - currentPrice);
    }

    this.balance += reward;
    this.peakBalance = Math.max(this.peakBalance, this.balance);
    const drawdown = this.peakBalance > 0 ? (this.peakBalance - this.balance) / this.peakBalance : 0;
    reward -= drawdown * this.options.drawdownPenalty;

    this.index += 1;
    const done = this.index >= this.series.length - 1;
    return {
      nextState: this.getState(),
      reward: clamp(reward, -2, 2),
      done,
      info: {
        position: this.position,
        balance: this.balance,
        drawdown,
      },
    };
  }
}

module.exports = {
  TradingGymEnvironment,
};
