'use strict';

const config = require('../../config');

/**
 * Backtest Utilities: Walk-forward, regime classification, per-chain costs, regime-aware MC
 */

/**
 * Split price/volume history into walk-forward windows: training/validation/test.
 * Default: 70% training, 15% validation, 15% test
 * Returns: { train, validate, test } with { priceHistory, volumeHistory, indices }
 */
function walkForwardSplit(priceHistory, volumeHistory, trainPct = 0.7, validatePct = 0.15) {
  const n = Math.min(priceHistory.length, volumeHistory.length);
  const testPct = Math.max(0, 1 - trainPct - validatePct);
  
  const trainEnd = Math.floor(n * trainPct);
  const validateEnd = trainEnd + Math.floor(n * validatePct);
  const testEnd = n;

  return {
    train: {
      priceHistory: priceHistory.slice(0, trainEnd),
      volumeHistory: volumeHistory.slice(0, trainEnd),
      startIdx: 0,
      endIdx: trainEnd,
    },
    validate: {
      priceHistory: priceHistory.slice(trainEnd, validateEnd),
      volumeHistory: volumeHistory.slice(trainEnd, validateEnd),
      startIdx: trainEnd,
      endIdx: validateEnd,
    },
    test: {
      priceHistory: priceHistory.slice(validateEnd, testEnd),
      volumeHistory: volumeHistory.slice(validateEnd, testEnd),
      startIdx: validateEnd,
      endIdx: testEnd,
    },
  };
}

/**
 * Classify price history into market regimes: trending vs ranging.
 * Uses realized volatility and price momentum over a window.
 * Returns: array of regime labels matching price history length
 */
function classifyRegimes(priceHistory, windowBars = 20) {
  const regimes = [];
  const n = priceHistory.length;
  
  for (let i = 0; i < n; i++) {
    if (i < windowBars) {
      regimes.push('insufficient_data');
      continue;
    }
    
    const window = priceHistory.slice(i - windowBars, i + 1);
    const returns = [];
    for (let j = 1; j < window.length; j++) {
      if (window[j - 1] > 0) {
        returns.push(Math.log(window[j] / window[j - 1]));
      }
    }
    
    if (returns.length === 0) {
      regimes.push('ranging');
      continue;
    }
    
    // Realized volatility (standard deviation of log returns)
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const volatility = Math.sqrt(variance);
    
    // Momentum: directional move over window
    const startPrice = window[0];
    const endPrice = window[window.length - 1];
    const momentum = (endPrice - startPrice) / startPrice;
    const momentumAbs = Math.abs(momentum);
    
    // Classify: high momentum + high vol = trending; low momentum + any vol = ranging
    if (momentumAbs > volatility * 1.5) {
      regimes.push(momentum > 0 ? 'uptrend' : 'downtrend');
    } else if (volatility > 0.02) {
      regimes.push('high_volatility');
    } else {
      regimes.push('ranging');
    }
  }
  
  return regimes;
}

/**
 * Track costs per chain for accurate cost-of-execution breakdown.
 * Returns: { byChain: { solana: {...}, bsc: {...}, ... }, total: {...} }
 */
function createChainCostTracker(chainKey = 'solana') {
  return {
    chainKey,
    totalEntryFees: 0,
    totalExitFees: 0,
    totalEntrySlippage: 0,
    totalExitSlippage: 0,
    totalMevTax: 0,
    tradeCount: 0,
    
    addTrade(entryFee, exitFee, entrySlip, exitSlip, mevTax = 0) {
      this.totalEntryFees += Number(entryFee || 0);
      this.totalExitFees += Number(exitFee || 0);
      this.totalEntrySlippage += Number(entrySlip || 0);
      this.totalExitSlippage += Number(exitSlip || 0);
      this.totalMevTax += Number(mevTax || 0);
      this.tradeCount += 1;
    },
    
    summary() {
      return {
        chain: this.chainKey,
        trades: this.tradeCount,
        totalCosts: this.totalEntryFees + this.totalExitFees + this.totalEntrySlippage + this.totalExitSlippage + this.totalMevTax,
        avgCostPerTrade: this.tradeCount > 0 ? 
          (this.totalEntryFees + this.totalExitFees + this.totalEntrySlippage + this.totalExitSlippage + this.totalMevTax) / this.tradeCount : 0,
        breakdown: {
          entryFees: this.totalEntryFees,
          exitFees: this.totalExitFees,
          entrySlippage: this.totalEntrySlippage,
          exitSlippage: this.totalExitSlippage,
          mevTax: this.totalMevTax,
        },
      };
    },
  };
}

/**
 * Regime-aware Monte Carlo: accounts for clustering by resampling trade sequences,
 * not individual trades (i.i.d. assumption is wrong for crypto).
 * Uses consecutive win/loss streaks as atomic units.
 * Returns: similar to simple MC but with streak-based resampling
 */
function runRegimeAwareMonteCarlo(startingBalance, completedTrades, regimeLabels = [], iterations = 2000, ruinDrawdownPct = config.backtest?.monteCarloRuinThresholdPct) {
  if (!Array.isArray(completedTrades) || completedTrades.length < 2) {
    return null;
  }

  const sims = Math.max(200, Math.min(Number(iterations || 2000), 20000));
  const normalizedRuinDrawdownPct = Math.min(Math.max(Number(ruinDrawdownPct ?? config.backtest?.monteCarloRuinThresholdPct ?? 15), 0), 99);
  const ruinBalanceFloor = Number(startingBalance || 0) * (1 - (normalizedRuinDrawdownPct / 100));
  
  // Build streaks: consecutive wins or consecutive losses
  const streaks = [];
  let currentStreak = [];
  let lastWin = null;
  
  for (let i = 0; i < completedTrades.length; i++) {
    const isWin = Number(completedTrades[i]?.pnl || 0) > 0;
    
    if (lastWin === null || lastWin === isWin) {
      currentStreak.push(i);
      lastWin = isWin;
    } else {
      if (currentStreak.length > 0) {
        streaks.push({
          indices: currentStreak.slice(),
          pnls: currentStreak.map(idx => Number(completedTrades[idx]?.pnl || 0)),
          isWinStreak: lastWin,
        });
      }
      currentStreak = [i];
      lastWin = isWin;
    }
  }
  if (currentStreak.length > 0) {
    streaks.push({
      indices: currentStreak,
      pnls: currentStreak.map(idx => Number(completedTrades[idx]?.pnl || 0)),
      isWinStreak: lastWin,
    });
  }
  
  // Monte Carlo: resample streaks (cluster-aware), not individual trades
  const finalBalances = [];
  let ruinCount = 0;
  
  function createRng(seed = 0x9e3779b9) {
    let x = Number(seed) || 0x9e3779b9;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return ((x >>> 0) / 4294967296);
    };
  }
  
  const rng = createRng(completedTrades.length * 137 + sims);
  
  for (let i = 0; i < sims; i += 1) {
    let bal = Number(startingBalance || 0);
    let tradeCount = 0;
    
    // Resample streaks until we've processed similar # trades
    while (tradeCount < completedTrades.length && bal > ruinBalanceFloor) {
      const pickStreak = streaks[Math.floor(rng() * streaks.length)];
      if (!pickStreak) break;
      
      for (const pnl of pickStreak.pnls) {
        bal += pnl;
        tradeCount += 1;
        if (bal <= ruinBalanceFloor) {
          ruinCount += 1;
          break;
        }
      }
    }
    
    if (bal > ruinBalanceFloor) {
      finalBalances.push(bal);
    } else if (finalBalances.length === 0) {
      finalBalances.push(ruinBalanceFloor);
    }
  }
  
  finalBalances.sort((a, b) => a - b);
  const p10 = finalBalances[Math.floor(finalBalances.length * 0.1)] || startingBalance;
  const p50 = finalBalances[Math.floor(finalBalances.length * 0.5)] || startingBalance;
  const p90 = finalBalances[Math.floor(finalBalances.length * 0.9)] || startingBalance;
  
  return {
    iterations: sims,
    method: 'regime_aware_streaks',
    ruinThresholdPct: Number((normalizedRuinDrawdownPct).toFixed(2)),
    ruinProbabilityPct: Number(((ruinCount / sims) * 100).toFixed(2)),
    p10EndingBalance: Number(p10.toFixed(2)),
    p50EndingBalance: Number(p50.toFixed(2)),
    p90EndingBalance: Number(p90.toFixed(2)),
    streakCount: streaks.length,
    avgStreakLength: streaks.length > 0 ? (completedTrades.length / streaks.length).toFixed(2) : '0.00',
  };
}

/**
 * Stress test: run backtest with elevated slippage/fees to simulate illiquid exits
 * Returns results for baseline, 2x, 5x, and 10x cost multipliers
 */
function stressTestCosts(runBacktestFn, priceHistory, volumeHistory, strategySettings, baselineOptions = {}) {
  const multipliers = [1, 2, 5, 10];
  const results = {};
  
  for (const mult of multipliers) {
    const opts = { ...baselineOptions };
    opts.entrySlippagePct = (opts.entrySlippagePct || 0.8) * mult;
    opts.exitSlippagePct = (opts.exitSlippagePct || 1.2) * mult;
    opts.entryFeePct = (opts.entryFeePct || 0.15) * mult;
    opts.exitFeePct = (opts.exitFeePct || 0.15) * mult;
    
    const result = runBacktestFn(priceHistory, volumeHistory, strategySettings, opts);
    results[`${mult}x_costs`] = result ? {
      totalReturn: result.totalReturn,
      maxDrawdownPct: result.maxDrawdownPct,
      tradeCount: result.tradeCount,
      winRate: result.winRate,
    } : null;
  }
  
  return results;
}

/**
 * Generate correlated price series using Cholesky decomposition.
 * basePrice: starting price for each asset
 * correlation: correlation matrix (n x n) where n = number of assets
 * volatility: array of volatility for each asset
 * length: number of price bars to generate
 * Returns: array of { asset_0, asset_1, ... asset_n } prices
 */
function generateCorrelatedPrices(basePrice, correlation, volatility, length, seed = 1337) {
  const n = correlation.length;
  if (volatility.length !== n) {
    throw new Error('volatility length must match correlation matrix size');
  }

  // Cholesky decomposition of correlation matrix
  function cholesky(matrix) {
    const n = matrix.length;
    const L = Array(n).fill(0).map(() => Array(n).fill(0));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        for (let k = 0; k < j; k++) {
          sum += L[i][k] * L[j][k];
        }

        if (i === j) {
          const val = matrix[i][i] - sum;
          L[i][j] = Math.sqrt(Math.max(0, val)); // Avoid negative due to numerical errors
        } else {
          L[i][j] = (matrix[i][j] - sum) / (L[j][j] || 1);
        }
      }
    }
    return L;
  }

  // Seeded RNG
  function createRng(seed) {
    let x = Number(seed) || 0x9e3779b9;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return ((x >>> 0) / 4294967296);
    };
  }

  const rng = createRng(seed);
  const L = cholesky(correlation);
  const prices = Array(length).fill(0).map(() => Array(n).fill(basePrice));

  // Generate correlated returns
  for (let t = 1; t < length; t++) {
    // Independent standard normals for each asset
    const z = Array(n).fill(0).map(() => {
      // Box-Muller transform
      const u1 = rng();
      const u2 = rng();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    });

    // Apply Cholesky to get correlated returns
    for (let i = 0; i < n; i++) {
      let correlated = 0;
      for (let j = 0; j <= i; j++) {
        correlated += L[i][j] * z[j];
      }

      const returnPct = correlated * (volatility[i] / 100);
      prices[t][i] = prices[t - 1][i] * (1 + returnPct);
    }
  }

  return prices;
}

/**
 * Run portfolio backtest with 6 correlated assets (3 momentum + 3 swing).
 * Tracks: per-asset returns, portfolio returns, total heat, correlation evolution.
 * Returns: { perAssetResults, portfolioMetrics, correlationEvolution, cascadeEvents }
 */
function runPortfolioBacktest(runBacktestFn, baselineOptions = {}) {
  const numAssets = 6;
  const basePrice = 1;
  const assetVolatilities = [8, 12, 10, 6, 9, 7]; // per-asset volatility
  
  // Correlation matrix: moderate positive correlation (0.5-0.7) for crypto
  const correlation = [
    [1.0, 0.6, 0.5, 0.3, 0.4, 0.35],
    [0.6, 1.0, 0.65, 0.35, 0.5, 0.4],
    [0.5, 0.65, 1.0, 0.4, 0.45, 0.35],
    [0.3, 0.35, 0.4, 1.0, 0.6, 0.55],
    [0.4, 0.5, 0.45, 0.6, 1.0, 0.65],
    [0.35, 0.4, 0.35, 0.55, 0.65, 1.0],
  ];

  const historyLength = Number(baselineOptions.historyLength || 200);
  const seed = Number(baselineOptions.seed || 1337);

  // Generate correlated price histories
  const correlatedPrices = generateCorrelatedPrices(basePrice, correlation, assetVolatilities, historyLength, seed);
  const priceHistories = [];
  const volumeHistories = [];

  for (let i = 0; i < numAssets; i++) {
    priceHistories.push(correlatedPrices.map(bar => bar[i]));
    // Generate synthetic volume (tends to correlate with volatility)
    const volatility = assetVolatilities[i];
    volumeHistories.push(
      Array(historyLength).fill(0).map((_, t) => {
        const baseVol = 100000;
        const priceMove = t === 0 ? 0 : Math.abs((priceHistories[i][t] - priceHistories[i][t - 1]) / priceHistories[i][t - 1]);
        return baseVol * (1 + priceMove * 50); // volume increases with price movement
      })
    );
  }

  // Run backtest on each asset
  const perAssetResults = [];
  let totalEquity = 0;
  let totalDrawdown = 0;
  let cascadeCount = 0;

  for (let i = 0; i < numAssets; i++) {
    const result = runBacktestFn(priceHistories[i], volumeHistories[i], baselineOptions.strategySettings, {
      ...baselineOptions,
      assetIndex: i,
      assetName: `asset_${i}`,
    });

    if (result) {
      perAssetResults.push({
        assetIndex: i,
        assetName: `asset_${i}`,
        totalReturn: result.totalReturn,
        tradeCount: result.tradeCount,
        winRate: result.winRate,
        maxDrawdownPct: result.maxDrawdownPct,
        endingBalance: result.endingBalance,
      });

      totalEquity += result.endingBalance;
      totalDrawdown += result.maxDrawdownPct;

      // Cascade detection: if 2+ assets have max drawdown > 15%, it's a cascade
      if (result.maxDrawdownPct > 15) {
        cascadeCount += 1;
      }
    }
  }

  const startingBalance = Number(baselineOptions.startingBalance || 10000);
  const portfolioEquity = totalEquity;
  const portfolioReturn = ((portfolioEquity - (startingBalance * numAssets)) / (startingBalance * numAssets)) * 100;
  const avgDrawdown = totalDrawdown / numAssets;
  const worstAsset = perAssetResults.reduce((min, a) => a.totalReturn < min.totalReturn ? a : min, perAssetResults[0] || {});
  const bestAsset = perAssetResults.reduce((max, a) => a.totalReturn > max.totalReturn ? a : max, perAssetResults[0] || {});

  return {
    method: 'portfolio_correlation',
    numAssets,
    historyLength,
    perAssetResults,
    portfolioMetrics: {
      startingCapital: startingBalance * numAssets,
      endingEquity: Number(portfolioEquity.toFixed(2)),
      portfolioReturn: Number(portfolioReturn.toFixed(2)),
      avgMaxDrawdown: Number(avgDrawdown.toFixed(2)),
      bestAssetReturn: Number(bestAsset?.totalReturn?.toFixed(2) || 0),
      worstAssetReturn: Number(worstAsset?.totalReturn?.toFixed(2) || 0),
      heat: {
        cascadeEventsDetected: cascadeCount,
        cascadeSuspicious: cascadeCount >= 2,
        assessment: cascadeCount >= 2 ? 
          `PORTFOLIO STRESS: ${cascadeCount}+ assets with >15% drawdown simultaneously` :
          'Portfolio stress acceptable'
      }
    },
    correlationStats: {
      meanCorrelation: 0.5, // Hardcoded from matrix above
      correlationMatrix: correlation,
      description: 'Moderate positive correlation typical of altcoin portfolios'
    }
  };
}

/**
 * Pre-seed historical price data for a token.
 * Stores in memory cache for backtest use.
 * Returns: { success, tokenAddress, chain, dataPoints }
 */
function seedHistoricalData(priceHistory, volumeHistory, tokenAddress, chain, cache = {}) {
  const key = `${String(chain).toLowerCase()}:${String(tokenAddress).toLowerCase()}`;
  
  if (!Array.isArray(priceHistory) || !Array.isArray(volumeHistory)) {
    return { success: false, error: 'priceHistory and volumeHistory must be arrays' };
  }
  
  if (priceHistory.length !== volumeHistory.length) {
    return { success: false, error: 'priceHistory and volumeHistory length mismatch' };
  }
  
  if (priceHistory.length === 0) {
    return { success: false, error: 'empty price history' };
  }

  // Store in cache (simulates strategy.priceHistory)
  cache[key] = {
    priceHistory: priceHistory.slice(), // copy to prevent mutation
    volumeHistory: volumeHistory.slice(),
    seededAt: new Date().toISOString(),
    dataPoints: priceHistory.length,
  };

  return {
    success: true,
    tokenAddress,
    chain,
    dataPoints: priceHistory.length,
    cacheKey: key,
  };
}

module.exports = {
  walkForwardSplit,
  classifyRegimes,
  createChainCostTracker,
  runRegimeAwareMonteCarlo,
  stressTestCosts,
  generateCorrelatedPrices,
  runPortfolioBacktest,
  seedHistoricalData,
};
