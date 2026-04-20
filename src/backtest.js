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

function createRng(seed = 0x9e3779b9) {
  let x = Number(seed) || 0x9e3779b9;
  return () => {
    // xorshift32
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296);
  };
}

function runMonteCarloTradePnl(startingBalance, tradePnls, iterations = 2000) {
  if (!Array.isArray(tradePnls) || tradePnls.length < 2) {
    return null;
  }

  const sims = Math.max(200, Math.min(Number(iterations || 2000), 20000));
  const rng = createRng(tradePnls.length * 97 + sims);
  const finalBalances = [];
  let ruinCount = 0;

  for (let i = 0; i < sims; i += 1) {
    let bal = Number(startingBalance || 0);
    const sampleCount = tradePnls.length;
    for (let j = 0; j < sampleCount; j += 1) {
      const pick = tradePnls[Math.floor(rng() * tradePnls.length)];
      bal += Number(pick || 0);
      if (bal <= startingBalance * 0.7) {
        ruinCount += 1;
        break;
      }
    }
    finalBalances.push(bal);
  }

  finalBalances.sort((a, b) => a - b);
  const p10 = finalBalances[Math.floor(finalBalances.length * 0.1)] || startingBalance;
  const p50 = finalBalances[Math.floor(finalBalances.length * 0.5)] || startingBalance;
  const p90 = finalBalances[Math.floor(finalBalances.length * 0.9)] || startingBalance;

  return {
    iterations: sims,
    ruinThresholdPct: 30,
    ruinProbabilityPct: round((ruinCount / sims) * 100, 2),
    p10EndingBalance: round(p10),
    p50EndingBalance: round(p50),
    p90EndingBalance: round(p90),
  };
}

function runBacktest(priceHistory, volumeHistory, strategySettings, options = {}) {
  const riskSettings = options.riskSettings || config.risk;
  const startingBalance = Number(options.startingBalance || 10000);
  const tradePct = Number(options.tradePct || 0.05);
  const entrySlippagePct = Math.max(0, Number(options.entrySlippagePct ?? 0.8));
  const exitSlippagePct = Math.max(0, Number(options.exitSlippagePct ?? 1.2));
  const entryFeePct = Math.max(0, Number(options.entryFeePct ?? 0.15));
  const exitFeePct = Math.max(0, Number(options.exitFeePct ?? 0.15));
  const outageChancePct = Math.max(0, Math.min(95, Number(options.outageChancePct ?? 0)));
  const rng = createRng(Number(options.seed || 1337));

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
    const slippedPrice = price * (1 - exitSlippagePct / 100);
    const grossProceeds = qtyToSell * slippedPrice;
    const proceeds = grossProceeds * (1 - exitFeePct / 100);
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
      slippedPrice: round(slippedPrice, 6),
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
    const outageActive = rng() < (outageChancePct / 100);
    const price = Number(priceHistory[i]);
    const prices = priceHistory.slice(0, i + 1);
    const volumes = volumeHistory.slice(0, i + 1);
    const result = momentumSignal(prices, volumes, strategySettings);
    const signal = result.signal;

    if (position && !outageActive) {
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

    if (!position && signal === 'BUY' && !outageActive) {
      const sizeUsd = Math.min(cash * tradePct, cash);
      if (sizeUsd > 0) {
        const slippedEntryPrice = price * (1 + entrySlippagePct / 100);
        const netAfterFeesUsd = sizeUsd * (1 - entryFeePct / 100);
        cash -= sizeUsd;
        position = {
          entryIndex: i,
          entryPrice: slippedEntryPrice,
          investedUsd: sizeUsd,
          quantity: netAfterFeesUsd / slippedEntryPrice,
          remainingCost: sizeUsd,
          realizedPnl: 0,
          realizedValue: 0,
          stopLoss: slippedEntryPrice * (1 - (riskSettings.stopLossPct || 8) / 100),
          takeProfit: slippedEntryPrice * (1 + (riskSettings.takeProfitPct || 25) / 100),
          triggeredTiers: {},
          reasons: ['BUY'],
        };

        executions.push({
          side: 'BUY',
          reason: 'TECHNICAL_BUY',
          index: i,
          price: round(price, 6),
          slippedPrice: round(slippedEntryPrice, 6),
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
  const monteCarlo = runMonteCarloTradePnl(startingBalance, completedTrades.map((t) => Number(t.pnl || 0)), Number(options.monteCarloRuns || 2000));

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
    assumptions: {
      entrySlippagePct: round(entrySlippagePct, 3),
      exitSlippagePct: round(exitSlippagePct, 3),
      entryFeePct: round(entryFeePct, 3),
      exitFeePct: round(exitFeePct, 3),
      outageChancePct: round(outageChancePct, 3),
    },
    monteCarlo,
    openPosition: Boolean(position),
    trades: completedTrades,
    executions,
    equityCurve,
  };
}

module.exports = { runBacktest };
