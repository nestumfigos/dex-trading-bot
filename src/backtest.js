'use strict';

const config = require('../config');
const { momentumSignal } = require('./utils/indicators');

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function buildEquityPoint(index, price, cash, position, startingBalance) {
  const positionValue = position ? position.quantity * price : 0;
  const equity = cash + positionValue;
  return {
    index,
    price: round(price, 6),
    cash: round(cash),
    positionValue: round(positionValue),
    equity: round(equity),
    pnl: round(equity - startingBalance),
  };
}

function runBacktest(priceHistory, volumeHistory, strategySettings, options = {}) {
  const riskSettings = options.riskSettings || config.risk;
  const startingBalance = Number(options.startingBalance || 10000);
  const tradePct = Number(options.tradePct || 0.05);

  if (!Array.isArray(priceHistory) || !Array.isArray(volumeHistory)) {
    return null;
  }

  if (priceHistory.length !== volumeHistory.length || priceHistory.length < strategySettings.emaSlow + 5) {
    return null;
  }

  let cash = startingBalance;
  let position = null;
  let maxEquity = startingBalance;
  let maxDrawdownPct = 0;

  const executions = [];
  const completedTrades = [];
  const equityCurve = [];

  function updateDrawdown(price, index) {
    const point = buildEquityPoint(index, price, cash, position, startingBalance);
    maxEquity = Math.max(maxEquity, point.equity);
    if (maxEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((maxEquity - point.equity) / maxEquity) * 100);
    }
    equityCurve.push(point);
  }

  function closePosition(price, index, fraction, reason) {
    if (!position || fraction <= 0) {
      return;
    }

    const qtyToSell = position.quantity * fraction;
    const costPerUnit = position.quantity > 0 ? position.remainingCost / position.quantity : 0;
    const costBasis = costPerUnit * qtyToSell;
    const proceeds = qtyToSell * price;
    const pnl = proceeds - costBasis;

    cash += proceeds;
    position.quantity -= qtyToSell;
    position.remainingCost -= costBasis;
    position.realizedPnl += pnl;
    position.realizedValue += proceeds;

    executions.push({
      side: 'SELL',
      reason,
      index,
      price: round(price, 6),
      quantity: round(qtyToSell, 6),
      value: round(proceeds),
      pnl: round(pnl),
      remainingQuantity: round(position.quantity, 6),
    });

    if (position.quantity <= 0.000001 || fraction >= 0.999999) {
      completedTrades.push({
        entryIndex: position.entryIndex,
        exitIndex: index,
        entryPrice: round(position.entryPrice, 6),
        exitPrice: round(price, 6),
        investedUsd: round(position.investedUsd),
        exitValue: round(position.realizedValue),
        pnl: round(position.realizedPnl),
        returnPct: round((position.realizedPnl / position.investedUsd) * 100),
        holdingBars: index - position.entryIndex,
        reasons: position.reasons.concat(reason),
      });
      position = null;
    }
  }

  for (let i = 0; i < priceHistory.length; i += 1) {
    const price = Number(priceHistory[i]);
    const prices = priceHistory.slice(0, i + 1);
    const volumes = volumeHistory.slice(0, i + 1);
    const result = momentumSignal(prices, volumes, strategySettings);
    const signal = result.signal;

    if (position) {
      const profitPct = (price - position.entryPrice) / position.entryPrice;

      if (price <= position.stopLoss) {
        closePosition(price, i, 1, 'STOP_LOSS');
      } else {
        let tierTriggered = false;

        for (let tierIndex = 0; tierIndex < strategySettings.sellTiers.length; tierIndex += 1) {
          const tier = strategySettings.sellTiers[tierIndex];
          if (position.triggeredTiers[tierIndex]) {
            continue;
          }
          if (profitPct >= tier.profitMultiplier - 1) {
            position.triggeredTiers[tierIndex] = true;
            position.reasons.push(`SELL_TIER_${tierIndex + 1}`);
            closePosition(price, i, tier.sellPct, `SELL_TIER_${tierIndex + 1}`);
            tierTriggered = true;
            break;
          }
        }

        if (!tierTriggered && position) {
          if (price >= position.takeProfit) {
            closePosition(price, i, 1, 'TAKE_PROFIT');
          } else if (signal === 'SELL') {
            closePosition(price, i, 1, 'TECHNICAL_SELL');
          }
        }
      }
    }

    if (!position && signal === 'BUY') {
      const sizeUsd = Math.min(cash * tradePct, cash);
      if (sizeUsd > 0) {
        cash -= sizeUsd;
        position = {
          entryIndex: i,
          entryPrice: price,
          investedUsd: sizeUsd,
          quantity: sizeUsd / price,
          remainingCost: sizeUsd,
          realizedPnl: 0,
          realizedValue: 0,
          stopLoss: price * (1 - (riskSettings.stopLossPct || 8) / 100),
          takeProfit: price * (1 + (riskSettings.takeProfitPct || 25) / 100),
          triggeredTiers: {},
          reasons: ['BUY'],
        };

        executions.push({
          side: 'BUY',
          reason: 'TECHNICAL_BUY',
          index: i,
          price: round(price, 6),
          quantity: round(position.quantity, 6),
          value: round(sizeUsd),
        });
      }
    }

    updateDrawdown(price, i);
  }

  if (position) {
    const finalPrice = Number(priceHistory[priceHistory.length - 1]);
    closePosition(finalPrice, priceHistory.length - 1, 1, 'END_OF_TEST');
    updateDrawdown(finalPrice, priceHistory.length - 1);
  }

  const endingBalance = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingBalance;
  const totalReturn = ((endingBalance - startingBalance) / startingBalance) * 100;
  const winCount = completedTrades.filter((trade) => trade.pnl > 0).length;
  const lossCount = completedTrades.filter((trade) => trade.pnl <= 0).length;
  const winRate = completedTrades.length ? (winCount / completedTrades.length) * 100 : null;

  return {
    startingBalance: round(startingBalance),
    endingBalance: round(endingBalance),
    totalReturn: round(totalReturn),
    tradeCount: completedTrades.length,
    executionCount: executions.length,
    wins: winCount,
    losses: lossCount,
    winRate: winRate === null ? null : round(winRate, 1),
    maxDrawdownPct: round(maxDrawdownPct, 2),
    openPosition: Boolean(position),
    trades: completedTrades,
    executions,
    equityCurve,
  };
}

module.exports = { runBacktest };
