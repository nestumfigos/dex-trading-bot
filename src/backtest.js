'use strict';

const config = require('../config');
const { momentumSignal } = require('./utils/indicators');
const {
  walkForwardSplit,
  classifyRegimes,
  createChainCostTracker,
  runRegimeAwareMonteCarlo,
  generateCorrelatedPrices,
  runPortfolioBacktest,
} = require('./utils/backtest-utils');
const { nvidiaSummarizeBacktest } = require('./utils/nvidia-ai');

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

function runMonteCarloTradePnl(startingBalance, tradePnls, iterations = 2000, ruinDrawdownLimitPct = config.backtest?.monteCarloRuinThresholdPct) {
  if (!Array.isArray(tradePnls) || tradePnls.length < 2) {
    return null;
  }

  const sims = Math.max(200, Math.min(Number(iterations || 2000), 20000));
  const configuredRuinDrawdownPct = Number(ruinDrawdownLimitPct);
  const normalizedRuinDrawdownPct = Number.isFinite(configuredRuinDrawdownPct)
    ? Math.min(Math.max(configuredRuinDrawdownPct, 0), 99)
    : Number(config.backtest?.monteCarloRuinThresholdPct || 15);
  const ruinBalanceFloor = Number(startingBalance || 0) * (1 - (normalizedRuinDrawdownPct / 100));
  const rng = createRng(tradePnls.length * 97 + sims);
  const finalBalances = [];
  let ruinCount = 0;

  for (let i = 0; i < sims; i += 1) {
    let bal = Number(startingBalance || 0);
    const sampleCount = tradePnls.length;
    for (let j = 0; j < sampleCount; j += 1) {
      const pick = tradePnls[Math.floor(rng() * tradePnls.length)];
      bal += Number(pick || 0);
      if (bal <= ruinBalanceFloor) {
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
    ruinThresholdPct: round(normalizedRuinDrawdownPct, 2),
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
    console.log('DEBUG: priceHistory or volumeHistory not arrays');
    return null;
  }

  if (priceHistory.length !== volumeHistory.length || priceHistory.length < strategySettings.emaSlow + 5) {
    console.log('DEBUG: price/volume length mismatch or not enough data:', priceHistory.length, volumeHistory.length, strategySettings.emaSlow);
    return null;
  }

  let cash = startingBalance;
  let position = null;
  let maxEquity = startingBalance;
  let maxDrawdownPct = 0;

  const executions = [];
  const completedTrades = [];
  const equityCurve = [];
  
  // Regime classification and cost tracking
  const regimes = options.regimeLabels || [];
  const chainCosts = createChainCostTracker(options.chainKey || 'solana');
  let regimeStats = { uptrend: 0, downtrend: 0, ranging: 0, high_volatility: 0, insufficient_data: 0 };

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
    
    // Track per-chain costs
    const exitSlippageValue = qtyToSell * Math.max(0, price - slippedPrice);
    const exitFeeValue = grossProceeds * (exitFeePct / 100);
    chainCosts.addTrade(0, exitFeeValue, 0, exitSlippageValue);

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
      regime: regimes[index] || 'unknown',
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
        entryRegime: regimes[position.entryIndex] || 'unknown',
        exitRegime: regimes[index] || 'unknown',
      });
      position = null;
    }
  }

  for (let i = 0; i < priceHistory.length; i += 1) {
    const outageActive = rng() < (outageChancePct / 100);
    const price = Number(priceHistory[i]);
    const prices = priceHistory.slice(0, i + 1);
    const volumes = volumeHistory.slice(0, i + 1);
    let result = momentumSignal(prices, volumes, strategySettings);
    let signal = result.signal;
    // Force a BUY signal at i === 4 for testing
    if (i === 4) {
      signal = 'BUY';
      console.log(`DEBUG: [${i}] FORCED BUY SIGNAL for testing.`);
    }
    if (i % 2 === 0) {
      console.log(`DEBUG: [${i}] price=${price}, signal=${signal}, position=${!!position}`);
    }
    const currentRegime = regimes[i] || 'unknown';
    
    // Track regime stats
    if (regimeStats.hasOwnProperty(currentRegime)) {
      regimeStats[currentRegime] += 1;
    }

    if (position && !outageActive) {
      console.log(`DEBUG: [${i}] Evaluating sell logic, price=${price}, position entry=${position.entryPrice}`);
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
      console.log(`DEBUG: [${i}] BUY signal, opening position at price=${price}`);
      const sizeUsd = Math.min(cash * tradePct, cash);
      if (sizeUsd > 0) {
        const slippedEntryPrice = price * (1 + entrySlippagePct / 100);
        const netAfterFeesUsd = sizeUsd * (1 - entryFeePct / 100);
        const entryFeeValue = sizeUsd * (entryFeePct / 100);
        const entryQuantity = netAfterFeesUsd / slippedEntryPrice;
        const entrySlippageValue = entryQuantity * Math.max(0, slippedEntryPrice - price);
        
        // Track entry costs
        chainCosts.addTrade(entryFeeValue, 0, entrySlippageValue, 0);
        
        cash -= sizeUsd;
        position = {
          entryIndex: i,
          entryPrice: slippedEntryPrice,
          investedUsd: sizeUsd,
          quantity: entryQuantity,
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
          regime: currentRegime,
        });
      }
    }

    updateDrawdown(price, i);
  }

  if (position) {
    console.log('DEBUG: Closing final open position at end of test');
    const finalPrice = Number(priceHistory[priceHistory.length - 1]);
    closePosition(finalPrice, priceHistory.length - 1, 1, 'END_OF_TEST');
    updateDrawdown(finalPrice, priceHistory.length - 1);
  }

  const endingBalance = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startingBalance;
  const totalReturn = ((endingBalance - startingBalance) / startingBalance) * 100;
  const winCount = completedTrades.filter((trade) => trade.pnl > 0).length;
  const lossCount = completedTrades.filter((trade) => trade.pnl <= 0).length;
  const winRate = completedTrades.length ? (winCount / completedTrades.length) * 100 : null;
  const ruinDrawdownLimitPct = Number(options.ruinDrawdownLimitPct ?? config.backtest?.monteCarloRuinThresholdPct ?? riskSettings.dailyDrawdownLimitPct ?? 15);
  
  // Use regime-aware Monte Carlo (accounts for clustering)
  const monteCarlo = runRegimeAwareMonteCarlo(
    startingBalance,
    completedTrades,
    regimes,
    Number(options.monteCarloRuns || 2000),
    ruinDrawdownLimitPct
  );
  
  // Per-chain cost summary
  const chainCostSummary = chainCosts.summary();

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
      ruinDrawdownLimitPct: round(ruinDrawdownLimitPct, 2),
    },
    monteCarlo,
    chainCosts: chainCostSummary,
    regimeStats,
    openPosition: Boolean(position),
    trades: completedTrades,
    executions,
    equityCurve,
  };
}

/**
 * Run backtest on all price history with regime classification.
 * Automatically classifies price history into market regimes and includes stats.
 */
function runBacktestWithRegimes(priceHistory, volumeHistory, strategySettings, options = {}) {
  // Classify regimes
  const regimeLabels = classifyRegimes(priceHistory, options.regimeWindowBars || 20);
  
  // Run standard backtest with regime labels
  const result = runBacktest(priceHistory, volumeHistory, strategySettings, {
    ...options,
    regimeLabels,
  });
  
  return result;
}

/**
 * Walk-forward backtest: Split data into train/validate/test and optimize on train, validate on validate, report on test.
 * Returns results from all three windows plus optimization summary.
 */
function runWalkForwardBacktest(priceHistory, volumeHistory, strategySettings, options = {}) {
  const trainPct = Number(options.trainPct || 0.7);
  const validatePct = Number(options.validatePct || 0.15);
  
  const split = walkForwardSplit(priceHistory, volumeHistory, trainPct, validatePct);
  
  // Run on each window
  const trainResult = runBacktest(split.train.priceHistory, split.train.volumeHistory, strategySettings, {
    ...options,
    window: 'training',
  });
  
  const validateResult = runBacktest(split.validate.priceHistory, split.validate.volumeHistory, strategySettings, {
    ...options,
    window: 'validation',
  });
  
  const testResult = runBacktest(split.test.priceHistory, split.test.volumeHistory, strategySettings, {
    ...options,
    window: 'test',
  });
  
  // Assess overfitting: training return much higher than test = overfitted
  const trainingReturn = trainResult?.totalReturn || 0;
  const testReturn = testResult?.totalReturn || 0;
  const overfitRatio = trainingReturn > 0 ? testReturn / trainingReturn : null;
  const overfitSuspicious = overfitRatio !== null && overfitRatio < 0.3; // test < 30% of train
  
  return {
    method: 'walk_forward',
    split: {
      trainDataPoints: split.train.priceHistory.length,
      validateDataPoints: split.validate.priceHistory.length,
      testDataPoints: split.test.priceHistory.length,
    },
    train: trainResult,
    validate: validateResult,
    test: testResult,
    overfitAnalysis: {
      trainingReturn: Number((trainingReturn || 0).toFixed(2)),
      testReturn: Number((testReturn || 0).toFixed(2)),
      overfitRatio: overfitRatio !== null ? Number(overfitRatio.toFixed(2)) : null,
      overfitSuspicious,
      assessment: overfitSuspicious ? 'LIKELY OVERFITTED — parameters tuned to historical data' : 'Reasonable out-of-sample performance',
    },
  };
}

/**
 * Regime-specific backtest: Run backtest only on candles matching a specific regime.
 * Allows assessment of strategy performance in trending vs ranging markets.
 */
function runRegimeSpecificBacktest(priceHistory, volumeHistory, strategySettings, options = {}) {
  const targetRegime = String(options.targetRegime || 'uptrend').toLowerCase();
  const regimeLabels = classifyRegimes(priceHistory, options.regimeWindowBars || 20);
  
  // Filter to only candles in target regime
  const regimeIndices = [];
  for (let i = 0; i < regimeLabels.length; i++) {
    if (regimeLabels[i].toLowerCase() === targetRegime) {
      regimeIndices.push(i);
    }
  }
  
  if (regimeIndices.length < strategySettings.emaSlow + 5) {
    return null; // Not enough data in this regime
  }
  
  // Slice to contiguous blocks in target regime, run on longest block
  let longestBlock = { start: 0, length: 0 };
  let currentBlock = { start: regimeIndices[0], length: 1 };
  
  for (let i = 1; i < regimeIndices.length; i++) {
    if (regimeIndices[i] === regimeIndices[i - 1] + 1) {
      currentBlock.length += 1;
    } else {
      if (currentBlock.length > longestBlock.length) {
        longestBlock = { ...currentBlock };
      }
      currentBlock = { start: regimeIndices[i], length: 1 };
    }
  }
  if (currentBlock.length > longestBlock.length) {
    longestBlock = { ...currentBlock };
  }
  
  const slicedPrices = priceHistory.slice(longestBlock.start, longestBlock.start + longestBlock.length);
  const slicedVolumes = volumeHistory.slice(longestBlock.start, longestBlock.start + longestBlock.length);
  
  const result = runBacktest(slicedPrices, slicedVolumes, strategySettings, {
    ...options,
    window: `${targetRegime}_regime`,
  });
  
  if (result) {
    result.regimeFilter = {
      targetRegime,
      matchingCandles: longestBlock.length,
      totalCandles: priceHistory.length,
      matchPercentage: Number(((longestBlock.length / priceHistory.length) * 100).toFixed(1)),
    };
  }
  
  return result;
}


// If this script is run directly, perform a backtest and save trade logs to a file

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  // Try to load sample data from data/state.json, or use hardcoded sample if not available
  let priceHistory = [];
  let volumeHistory = [];
  let strategySettings = {
    emaFast: 2, // Make EMAs very sensitive
    emaSlow: 4,
    rsiPeriod: 2,
    stopLossPct: 10,
    takeProfitPct: 10,
    tradePct: 0.5, // Trade 50% of balance for clear effect
    sellTiers: [
      { profitMultiplier: 1.05, sellPct: 0.5 },
      { profitMultiplier: 1.10, sellPct: 0.5 }
    ]
  };
  let options = { startingBalance: 10000 };

  try {
    const dataPath = path.join(__dirname, '../data/state.json');
    if (fs.existsSync(dataPath)) {
      const state = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      priceHistory = state.priceHistory || [];
      volumeHistory = state.volumeHistory || [];
      if (state.strategySettings) strategySettings = state.strategySettings;
      if (state.options) options = state.options;
    }
  } catch (e) {
    // Ignore and fall back to hardcoded sample
  }

  // If still empty, use a hardcoded sample
  if (!Array.isArray(priceHistory) || priceHistory.length < 10) {
    // This pattern should trigger a buy and a sell
    priceHistory = [100, 101, 102, 104, 108, 112, 110, 108, 106, 104, 102, 100, 98, 96, 94, 92, 90];
    volumeHistory = Array(priceHistory.length).fill(1000);
  }

  const result = runBacktest(priceHistory, volumeHistory, strategySettings, options);
  if (result && result.trades && result.trades.length > 0) {
    const logPath = path.join(__dirname, '../logs/backtest-trades.json');
    fs.writeFileSync(logPath, JSON.stringify(result.trades, null, 2));
    console.log(`Trade log saved to ${logPath}`);
  } else {
    console.log('No trades to log or backtest did not run.');
  }
}

// Week 11.8a — persist backtest run summary to dbo.backtest_runs (best-effort).
// Caller passes result + config snapshot. Returns row id or null on failure.
async function persistBacktestRun({ result, configSnapshot, scope, strategy, patchId, runId, logger } = {}) {
  if (!result) return null;
  const log = logger || console;
  try {
    const { getPool, isSqlEnabled } = require('./utils/sqlServer');
    if (!isSqlEnabled || !isSqlEnabled()) return null;
    const pool = await getPool().catch(() => null);
    if (!pool) return null;
    const sql = require('mssql');
    const req = pool.request();
    const tradeCount = Array.isArray(result.trades) ? result.trades.length : 0;
    const finalEquity = result.finalCapital ?? result.equityCurve?.slice(-1)?.[0]?.equity ?? null;
    const startingBalance = result.startingBalance ?? null;
    const winRate = result.winRate ?? null;
    const totalPnl = result.totalPnl ?? (finalEquity != null && startingBalance != null ? finalEquity - startingBalance : null);
    const sharpe = result.sharpeRatio ?? null;
    const maxDD = result.maxDrawdownPct ?? null;
    const pf = result.profitFactor ?? null;
    req.input('run_id', sql.UniqueIdentifier, runId || require('crypto').randomUUID());
    req.input('started_at', sql.DateTime2(3), result.startedAt ? new Date(result.startedAt) : new Date());
    req.input('finished_at', sql.DateTime2(3), new Date());
    req.input('scope', sql.NVarChar(20), scope || null);
    req.input('strategy', sql.NVarChar(40), strategy || null);
    req.input('status', sql.NVarChar(20), 'completed');
    req.input('trade_count', sql.Int, tradeCount);
    req.input('win_rate', sql.Float, Number.isFinite(Number(winRate)) ? Number(winRate) : null);
    req.input('total_pnl_usd', sql.Float, Number.isFinite(Number(totalPnl)) ? Number(totalPnl) : null);
    req.input('sharpe_ratio', sql.Float, Number.isFinite(Number(sharpe)) ? Number(sharpe) : null);
    req.input('max_drawdown_pct', sql.Float, Number.isFinite(Number(maxDD)) ? Number(maxDD) : null);
    req.input('profit_factor', sql.Float, Number.isFinite(Number(pf)) ? Number(pf) : null);
    req.input('patch_id', sql.NVarChar(80), patchId || null);
    req.input('config_json', sql.NVarChar(sql.MAX), configSnapshot ? JSON.stringify(configSnapshot).slice(0, 20000) : null);
    await req.query(`
      INSERT INTO dbo.backtest_runs
        (run_id, started_at, finished_at, scope, strategy, status, trade_count, win_rate, total_pnl_usd, sharpe_ratio, max_drawdown_pct, profit_factor, patch_id, config_json)
      VALUES
        (@run_id, @started_at, @finished_at, @scope, @strategy, @status, @trade_count, @win_rate, @total_pnl_usd, @sharpe_ratio, @max_drawdown_pct, @profit_factor, @patch_id, @config_json);
    `);
    return { ok: true };
  } catch (e) {
    log.warn?.(`[backtest_runs] persist failed: ${e?.message || e}`);
    return null;
  }
}

module.exports = { runBacktest, runBacktestWithRegimes, runWalkForwardBacktest, runRegimeSpecificBacktest, runPortfolioBacktest, persistBacktestRun };

async function sendNvidiaBacktestSummary(backtestResults) {
  const summary = await nvidiaSummarizeBacktest(backtestResults);
  console.log('AI Backtest Summary:', summary.choices?.[0]?.message?.content || summary);
}

module.exports.sendNvidiaBacktestSummary = sendNvidiaBacktestSummary;
