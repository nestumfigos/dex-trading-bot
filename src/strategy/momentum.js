'use strict';
const config = require('../../config');
const { momentumSignal, ema, rsi } = require('../utils/indicators');
const { getNetBuyFlowUsd } = require('../utils/onchain/buyflow');
const { getOhlcvSeries } = require('../utils/candles');

const DEFAULT_CANDLE_INTERVAL = {
  swing: '1h',
  momentum: '15m',
};

class MomentumStrategy {
  constructor() {
    this.priceHistory = {};
    this.volumeHistory = {};
    this.historySource = {};
    this.refreshSettings();
  }

  refreshSettings() {
    this.historyLength = Math.max(config.strategy.emaSlow + 5, 30);
    // Multi-timeframe lengths (simplified: short/medium/long based on history depth)
    this.timeframes = {
      short: Math.max(10, config.strategy.emaFast + 5),    // Fast signals, precise entries
      medium: Math.max(20, config.strategy.emaSlow + 5),   // Trend confirmation
      long: Math.max(40, config.strategy.emaSlow + 10),    // Long-term trend
    };
  }

  recordTick(tokenAddress, price, volume) {
    // When candle-backed history is active for a token, avoid mixing tick snapshots into it.
    if (this.historySource[tokenAddress] === 'candles') {
      return;
    }

    if (!this.priceHistory[tokenAddress]) {
      this.priceHistory[tokenAddress] = [];
      this.volumeHistory[tokenAddress] = [];
    }

    this.priceHistory[tokenAddress].push(price);
    this.volumeHistory[tokenAddress].push(volume);

    if (this.priceHistory[tokenAddress].length > this.timeframes.long) {
      this.priceHistory[tokenAddress].shift();
      this.volumeHistory[tokenAddress].shift();
    }
  }

  clearHistory(tokenAddress) {
    delete this.priceHistory[tokenAddress];
    delete this.volumeHistory[tokenAddress];
    delete this.historySource[tokenAddress];
  }

  async refreshHistoryFromCandles(historyKey, tokenMeta = {}, strategyName = 'momentum') {
    const strategyCfg = config.strategies?.[strategyName] || {};
    const interval = String(strategyCfg.candleInterval || DEFAULT_CANDLE_INTERVAL[strategyName] || '15m');
    const minBars = Math.max(Number(strategyCfg.emaSlow || 21) + 5, 30);
    const lookbackBars = Math.max(minBars, Number(strategyCfg.candleLookbackBars || 120));

    try {
      const series = await getOhlcvSeries({
        chainKey: tokenMeta.chainKey || tokenMeta.chain,
        address: tokenMeta.address,
        pairAddress: tokenMeta.pairAddress,
        interval,
        limit: lookbackBars,
      });

      if (!series || !Array.isArray(series.closes) || series.closes.length < minBars) {
        return false;
      }

      this.priceHistory[historyKey] = series.closes.slice(-lookbackBars);
      this.volumeHistory[historyKey] = (Array.isArray(series.volumes) ? series.volumes : []).slice(-lookbackBars);
      this.historySource[historyKey] = 'candles';
      return true;
    } catch (error) {
      return false;
    }
  }

  isExcludedAsset(tokenMeta = {}) {
    const symbol = String(tokenMeta.symbol || '').toLowerCase();
    const name = String(tokenMeta.name || '').toLowerCase();
    const text = `${symbol} ${name}`;
    const excludedPatterns = [
      /\busdt\b/, /\busdc\b/, /\bdai\b/, /\bbusd\b/, /\busd\b/,
      /\bwrapped\b/, /\bweth\b/, /\bwbtc\b/, /\bwbnb\b/, /\bsteth\b/,
      /\blp\b/, /\bpair\b/, /liquidity provider/,
    ];
    return excludedPatterns.some((rx) => rx.test(text));
  }

  getBuySellStats(tokenMeta = {}) {
    const buyTx10m = Number(tokenMeta.buyTx10m || 0);
    const sellTx10m = Number(tokenMeta.sellTx10m || 0);
    const buyTx1h = Number(tokenMeta.buyTx1h || 0);
    const sellTx1h = Number(tokenMeta.sellTx1h || 0);
    const txCountFirstHour = Number(tokenMeta.txCountFirstHour || (buyTx1h + sellTx1h));
    const tx10mTotal = buyTx10m + sellTx10m;
    const buyRatio10mPct = Number(tokenMeta.buyRatio10mPct || (tx10mTotal > 0 ? (buyTx10m / tx10mTotal) * 100 : 0));
    const sellRatio10mPct = tx10mTotal > 0 ? (sellTx10m / tx10mTotal) * 100 : 0;

    return {
      buyTx10m,
      sellTx10m,
      buyTx1h,
      sellTx1h,
      txCountFirstHour,
      buyRatio10mPct,
      sellRatio10mPct,
      uniqueBuyers10m: Number(tokenMeta.uniqueBuyers10m || 0),
    };
  }

  /**
   * Determine which strategies should evaluate this token based on its characteristics.
   * Returns { swing: boolean, momentum: boolean, reasons: string[] }
   */
  determineApplicableStrategies(tokenMeta = {}) {
    const applicable = { swing: false, momentum: false };

    const listingAgeDays = Number(tokenMeta.listingAgeDays || 0);
    const liquidity = Number(tokenMeta.liquidityUsd || 0);
    const volume24h = Number(tokenMeta.volume24h || 0);
    const priceChange24h = Number(tokenMeta.priceChange24h || 0);
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();

    const swingCfg = config.strategies?.swing || {};
    const momentumCfg = config.strategies?.momentum || {};

    // Strategy A: Swing Trading (established tokens)
    if (swingCfg.enabled !== false) {
      const minLiq = swingCfg.minLiquidityUsd || 500000;
      const minAge = swingCfg.minTokenAgeDays || 7;
      const minVol = swingCfg.min24hVolumeUsd || 100000;
      const isLegit = Boolean(tokenMeta.coingeckoId || tokenMeta.listedOnCoinGecko || tokenMeta.listedOnCoinMarketCap || String(tokenMeta.chain || '').toLowerCase() === 'kucoin');
      const excluded = swingCfg.excludeStableWrappedLp !== false && this.isExcludedAsset(tokenMeta);

      if (listingAgeDays >= minAge && liquidity >= minLiq && volume24h >= minVol && (!swingCfg.requireCoinGeckoOrCmc || isLegit) && !excluded) {
        applicable.swing = true;
      }
    }

    // Strategy B: Momentum Trading supports both lanes:
    // - New-launch momentum (age + flow checks)
    // - KuCoin universal momentum (age-agnostic CEX momentum)
    if (momentumCfg.enabled !== false) {
      const launchMinLiq = chainKey === 'kucoin'
        ? Number(momentumCfg.kucoinLaunchMinLiquidityUsd || 10000)
        : Number(momentumCfg.minLiquidityUsd || 10000);
      const maxLiq = momentumCfg.maxLiquidityUsd || 500000;
      const maxAge = momentumCfg.maxTokenAgeDays || 0.25; // 6 hours
      const buySell = this.getBuySellStats(tokenMeta);
      const minTxCountFirstHour = Number(momentumCfg.minTxCountFirstHour || 50);
      const minBuyRatioPct10m = Number(momentumCfg.minBuyRatioPct10m || 60);
      const kucoinUniversalEnabled = chainKey === 'kucoin' && momentumCfg.kucoinUniversalEnabled !== false;
      const kucoinMinLiq = Number(momentumCfg.kucoinUniversalMinLiquidityUsd || 100000);
      const kucoinMinVol24h = Number(momentumCfg.kucoinUniversalMin24hVolumeUsd || 1000000);
      const kucoinMinAbsChange24h = Number(momentumCfg.kucoinUniversalMinAbsPriceChange24hPct || 4);

      const launchLaneApplicable = (
        listingAgeDays <= maxAge
        && liquidity >= launchMinLiq
        && liquidity <= maxLiq
        && buySell.txCountFirstHour >= minTxCountFirstHour
        && buySell.buyRatio10mPct >= minBuyRatioPct10m
      );

      const kucoinUniversalApplicable = kucoinUniversalEnabled
        && liquidity >= kucoinMinLiq
        && volume24h >= kucoinMinVol24h
        && Math.abs(priceChange24h) >= kucoinMinAbsChange24h;

      if (launchLaneApplicable || kucoinUniversalApplicable) {
        applicable.momentum = true;
      }
    }

    return applicable;
  }

  /**
   * Evaluate a token for a specific strategy, using strategy-specific parameters.
   * strategyName: 'swing' or 'momentum'
   */
  async evaluateForStrategy(tokenAddress, strategyName, tokenMeta = {}) {
    if (strategyName !== 'swing' && strategyName !== 'momentum') {
      throw new Error(`Invalid strategy: ${strategyName}`);
    }

    const strategyCfg = config.strategies?.[strategyName];
    if (!strategyCfg) {
      return { signal: 'HOLD', details: { error: `No config for strategy ${strategyName}` } };
    }

    const rawAddress = String(tokenMeta.address || tokenAddress || '').includes(':')
      ? String(tokenMeta.address || tokenAddress).split(':').pop()
      : String(tokenMeta.address || tokenAddress || '');
    const historyKey = String(tokenMeta.strategyKey || tokenAddress || '');
    await this.refreshHistoryFromCandles(historyKey, {
      ...tokenMeta,
      address: rawAddress,
    }, strategyName);

    const prices = this.priceHistory[historyKey] || [];
    const volumes = this.volumeHistory[historyKey] || [];
    const externalReasons = [];
    const priceChange24hPct = Number(tokenMeta.priceChange24h || 0);
    const volume24h = Number(tokenMeta.volume24h || 0);
    const liquidityUsd = Number(tokenMeta.liquidityUsd || 0);

    const extremeMoveCandidate = strategyName === 'momentum'
      && strategyCfg.extremeMoveEnabled !== false
      && Math.abs(priceChange24hPct) >= Number(strategyCfg.extremeMoveMinAbsPriceChange24hPct || 200)
      && volume24h >= Number(strategyCfg.extremeMoveMin24hVolumeUsd || 50000)
      && liquidityUsd >= Number(strategyCfg.extremeMoveMinLiquidityUsd || 30000);

    // Use strategy-specific history requirement
    const historyNeeded = Math.max(strategyCfg.emaSlow + 5, 30);
    const hasFullHistory = prices.length >= historyNeeded;
    if (!hasFullHistory && !extremeMoveCandidate) {
      return { signal: 'INSUFFICIENT_DATA', details: { bars: prices.length, required: historyNeeded, strategy: strategyName } };
    }

    // Build strategy-specific parameters for momentum signal calculation
    const strategyParams = {
      emaFast: strategyCfg.emaFast,
      emaSlow: strategyCfg.emaSlow,
      rsiPeriod: strategyCfg.rsiPeriod,
      rsiBuyThreshold: strategyCfg.rsiBuyThreshold,
      volumeSpikeMultiplier: strategyCfg.volumeSpikeMultiplier,
      lowVolVolumeSpikeMultiplier: strategyCfg.lowVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier,
      highVolVolumeSpikeMultiplier: strategyCfg.highVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier,
      breakoutLookback: strategyCfg.breakoutLookback,
      breakoutBufferPct: strategyCfg.breakoutBufferPct,
    };

    let realizedVolPct = 0;
    let marketRegime = 'normal';
    let dynamicVolumeSpikeMultiplier = Number(
      strategyParams.lowVolVolumeSpikeMultiplier || strategyParams.volumeSpikeMultiplier || 1
    );
    const signals = {
      short: { signal: 'HOLD', details: {} },
      medium: { signal: 'HOLD', details: {} },
      long: { signal: 'HOLD', details: {} },
    };

    if (hasFullHistory) {
      // Calculate volatility
      const recentPrices = prices.slice(-20);
      const returns = recentPrices.slice(1).map((p, i) => {
        const prev = recentPrices[i] || 0;
        return prev > 0 ? (p - prev) / prev : 0;
      });
      const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const variance = returns.length
        ? returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
        : 0;
      realizedVolPct = Math.sqrt(variance) * 100;
      marketRegime = realizedVolPct > 4 ? 'high_volatility' : 'normal';
      dynamicVolumeSpikeMultiplier = marketRegime === 'high_volatility'
        ? (strategyParams.highVolVolumeSpikeMultiplier || strategyParams.volumeSpikeMultiplier)
        : (strategyParams.lowVolVolumeSpikeMultiplier || strategyParams.volumeSpikeMultiplier);

      // Evaluate each timeframe with strategy-specific parameters
      const dynamicStrategy = { ...strategyParams, volumeSpikeMultiplier: dynamicVolumeSpikeMultiplier };

      // Each timeframe must have at least emaSlow+5 bars, otherwise momentumSignal
      // will always return INSUFFICIENT_DATA (slow EMA cannot be computed).
      const baseBars = Math.max(Number(strategyParams.emaSlow || 21) + 5, 30);
      const timeframes = {
        short: baseBars,
        medium: baseBars + 10,
        long: baseBars + 20,
      };

      Object.entries(timeframes).forEach(([tf, length]) => {
        const tfPrices = prices.slice(-length);
        const tfVolumes = volumes.slice(-length);
        signals[tf] = momentumSignal(tfPrices, tfVolumes, dynamicStrategy);
      });
    }

    const shortSignal = signals.short.signal;
    const mediumSignal = signals.medium.signal;
    const longSignal = signals.long.signal;
    const shortRsi = Number(signals.short?.details?.rsi || Number.NaN);
    const shortVolumeSpike = Number(signals.short?.details?.volumeSpike || Number.NaN);
    const mediumRsi = Number(signals.medium?.details?.rsi || Number.NaN);

    const rsiBuyMin = Number(strategyCfg.rsiBuyThreshold || 45);
    const rsiBuyMax = Number(strategyCfg.rsiBuyMaxThreshold || 65);
    const inRsiBuyZone = Number.isFinite(shortRsi) && shortRsi >= rsiBuyMin && shortRsi <= rsiBuyMax;
    const hasVolumeSpike = Number.isFinite(shortVolumeSpike) && shortVolumeSpike >= dynamicVolumeSpikeMultiplier;

    const breakoutWindow = prices.slice(-(strategyParams.breakoutLookback + 1));
    const latestPrice = Number(prices[prices.length - 1] || 0);
    const priorHigh = breakoutWindow.length > 1
      ? Math.max(...breakoutWindow.slice(0, -1).map((v) => Number(v || 0)))
      : latestPrice;
    const breakoutConfirmed = latestPrice > priorHigh * (1 + strategyParams.breakoutBufferPct);

    const trendWindow = prices.slice(-Math.min(prices.length, 35));
    const trendStart = Number(trendWindow[0] || 0);
    const trendUp = trendStart > 0 ? latestPrice > trendStart : false;

    const buySell = this.getBuySellStats(tokenMeta);
    const topHoldersPct = Number(tokenMeta.topHoldersPct || 0);
    const liquidityChange24hPct = Number(tokenMeta.liquidityChange24hPct || 0);
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();
    const strictSolanaOnchainChecks = chainKey === 'solana' && strategyCfg.strictSolanaOnchainChecks !== false;

    // Determine final signal
    let finalSignal = 'HOLD';
    let confidence = 0;
    let netBuyFlowUsd10m = null;
    let triggerTimeframe = null;
    let technicalBlocked = false;

    if (strategyName === 'swing') {
      const hasLegitimacy = Boolean(tokenMeta.coingeckoId || tokenMeta.listedOnCoinGecko || tokenMeta.listedOnCoinMarketCap || String(tokenMeta.chain || '').toLowerCase() === 'kucoin');
      if (strategyCfg.requireCoinGeckoOrCmc && !hasLegitimacy) externalReasons.push('Not listed on CoinGecko/CoinMarketCap');
      if (strategyCfg.excludeStableWrappedLp !== false && this.isExcludedAsset(tokenMeta)) externalReasons.push('Stablecoin/wrapped/LP token excluded');
      if (!trendUp) externalReasons.push('7-day trend is not upward');
      if (liquidityChange24hPct < -5) externalReasons.push('Liquidity trend is shrinking');

      const buySetup = longSignal === 'BUY' && mediumSignal === 'BUY' && shortSignal === 'BUY' && inRsiBuyZone && hasVolumeSpike && breakoutConfirmed;
      if (buySetup && externalReasons.length === 0) {
        finalSignal = 'BUY';
        confidence = 1.0;
        triggerTimeframe = 'swing_trend_alignment';
      } else if (longSignal === 'SELL' || mediumSignal === 'SELL') {
        finalSignal = 'SELL';
        confidence = 0.8;
      } else {
        technicalBlocked = true;
      }
    } else {
      // Momentum: fast setup on very new launches.
      if (topHoldersPct > Number(strategyCfg.maxTopHoldersPct || 60)) externalReasons.push(`Top holders ${topHoldersPct.toFixed(1)}% > ${strategyCfg.maxTopHoldersPct}%`);
      const bypassMicrostructureChecks = Boolean(extremeMoveCandidate && strategyCfg.extremeMoveBypassMicrostructureChecks !== false);

      if (!bypassMicrostructureChecks && buySell.txCountFirstHour < Number(strategyCfg.minTxCountFirstHour || 50)) {
        externalReasons.push(`Transactions first hour ${buySell.txCountFirstHour} < ${strategyCfg.minTxCountFirstHour}`);
      }
      if (!bypassMicrostructureChecks && buySell.buyRatio10mPct < Number(strategyCfg.minBuyRatioPct10m || 60)) {
        externalReasons.push(`Buy ratio 10m ${buySell.buyRatio10mPct.toFixed(1)}% < ${strategyCfg.minBuyRatioPct10m}%`);
      }
      const hasUniqueBuyerData = tokenMeta.uniqueBuyers10m !== undefined && tokenMeta.uniqueBuyers10m !== null && tokenMeta.uniqueBuyers10m !== '';
      if (!bypassMicrostructureChecks && !hasUniqueBuyerData && strictSolanaOnchainChecks) {
        externalReasons.push('Unique buyers 10m unavailable (strict Solana momentum mode)');
      } else if (!bypassMicrostructureChecks && hasUniqueBuyerData && buySell.uniqueBuyers10m < Number(strategyCfg.minUniqueBuyers10m || 20)) {
        externalReasons.push(`Unique buyers 10m ${buySell.uniqueBuyers10m} < ${strategyCfg.minUniqueBuyers10m}`);
      }
      if (Boolean(tokenMeta.isHoneypot)) externalReasons.push('GoPlus flagged token');

      if (!bypassMicrostructureChecks) {
        netBuyFlowUsd10m = await getNetBuyFlowUsd(rawAddress, tokenMeta.chainKey || tokenMeta.chain);
        const minNetBuyFlowUsd = Number(strategyCfg.minNetBuyFlowUsd || 15000);
        if (!Number.isFinite(netBuyFlowUsd10m) && strictSolanaOnchainChecks) {
          externalReasons.push('Net buy flow 10m unavailable (strict Solana momentum mode)');
        } else if (Number.isFinite(netBuyFlowUsd10m) && netBuyFlowUsd10m < minNetBuyFlowUsd) {
          externalReasons.push(`Net buy flow $${Math.round(netBuyFlowUsd10m)} < $${Math.round(minNetBuyFlowUsd)}`);
        }
      }

      const buySetup = longSignal === 'BUY' && mediumSignal === 'BUY' && shortSignal === 'BUY' && inRsiBuyZone && hasVolumeSpike;
      const extremeMinBars = Math.max(3, Number(strategyCfg.extremeMoveMinHistoryBars || 8));
      const recentStartIndex = Math.max(0, prices.length - extremeMinBars);
      const recentStartPrice = Number(prices[recentStartIndex] || 0);
      const recentMovePct = recentStartPrice > 0 && Number.isFinite(latestPrice)
        ? ((latestPrice - recentStartPrice) / recentStartPrice) * 100
        : 0;

      const extremeVolumeSpike = (() => {
        if (volumes.length < 2) return Number.NaN;
        const prev = volumes.slice(0, -1);
        const avg = prev.reduce((sum, v) => sum + Number(v || 0), 0) / prev.length;
        if (!Number.isFinite(avg) || avg <= 0) return Number.NaN;
        return Number(volumes[volumes.length - 1] || 0) / avg;
      })();

      const extremeBuySetup = extremeMoveCandidate
        && prices.length >= extremeMinBars
        && recentMovePct >= Number(strategyCfg.extremeMoveMinRecentPct || 8)
        && (!Number.isFinite(extremeVolumeSpike) || extremeVolumeSpike >= Number(strategyCfg.extremeMoveMinVolumeSpike || 1.1));

      if ((buySetup || extremeBuySetup) && externalReasons.length === 0) {
        finalSignal = 'BUY';
        confidence = extremeBuySetup && !buySetup ? 0.85 : 1.0;
        triggerTimeframe = extremeBuySetup && !buySetup ? 'extreme_24h_momentum' : 'momentum_breakout';
      } else if (shortSignal === 'SELL' || mediumSignal === 'SELL') {
        finalSignal = 'SELL';
        confidence = 0.75;
      } else {
        technicalBlocked = true;
      }
    }

    return {
      signal: finalSignal,
      details: {
        fastEma: signals.short?.details?.fastEma ?? null,
        slowEma: signals.short?.details?.slowEma ?? null,
        rsi: signals.short?.details?.rsi ?? null,
        volumeSpike: signals.short?.details?.volumeSpike ?? null,
        short: { signal: signals.short?.signal || 'HOLD', ...(signals.short?.details || {}) },
        medium: { signal: signals.medium?.signal || 'HOLD', ...(signals.medium?.details || {}) },
        long: { signal: signals.long?.signal || 'HOLD', ...(signals.long?.details || {}) },
        confidence,
        strategy: strategyName,
        triggerTimeframe,
        breakoutConfirmed,
        netBuyFlowUsd10m,
        rsiBuyMin,
        rsiBuyMax,
        mediumRsi,
        buyRatio10mPct: buySell.buyRatio10mPct,
        sellRatio10mPct: buySell.sellRatio10mPct,
        txCountFirstHour: buySell.txCountFirstHour,
        uniqueBuyers10m: buySell.uniqueBuyers10m,
        topHoldersPct,
        liquidityChange24hPct,
        priceChange24hPct,
        extremeMoveCandidate,
        externalReasons,
        technicalBlocked,
        marketRegime,
        realizedVolPct,
      },
    };
  }

  evaluateExitForStrategy(tokenAddress, strategyName, tokenMeta = {}, position = {}) {
    const strategyCfg = config.strategies?.[strategyName] || {};
    const prices = this.priceHistory[tokenAddress] || [];
    if (prices.length < Math.max(Number(strategyCfg.emaSlow || 21) + 2, 25)) {
      return { shouldExit: false, reason: null, details: { insufficientData: true } };
    }

    const fastPeriod = Number(strategyCfg.emaFast || 9);
    const slowPeriod = Number(strategyCfg.emaSlow || 21);
    const rsiPeriod = Number(strategyCfg.rsiPeriod || 14);

    const fast = ema(prices, fastPeriod);
    const slow = ema(prices, slowPeriod);
    const prevFast = ema(prices.slice(0, -1), fastPeriod);
    const prevSlow = ema(prices.slice(0, -1), slowPeriod);
    const rsiValue = rsi(prices, rsiPeriod);
    const emaCrossDown = Number.isFinite(prevFast) && Number.isFinite(prevSlow) && Number.isFinite(fast) && Number.isFinite(slow)
      ? prevFast > prevSlow && fast < slow
      : false;

    const buySell = this.getBuySellStats(tokenMeta);
    const entryTime = new Date(position.openedAt || position.createdAt || Date.now()).getTime();
    const minutesInTrade = Math.max(0, (Date.now() - entryTime) / 60000);

    const entryLiquidity = Number(position.entryLiquidityUsd || 0);
    const currentLiquidity = Number(tokenMeta.liquidityUsd || 0);
    const liquidityDropPct = entryLiquidity > 0
      ? ((entryLiquidity - currentLiquidity) / entryLiquidity) * 100
      : 0;

    const entryTopHoldersPct = Number(position.entryTopHoldersPct || 0);
    const currentTopHoldersPct = Number(tokenMeta.topHoldersPct || 0);
    const holderJumpPct = currentTopHoldersPct - entryTopHoldersPct;

    if (strategyName === 'swing') {
      if (emaCrossDown) return { shouldExit: true, reason: 'EMA_CROSSDOWN_SWING', details: { emaCrossDown, rsiValue } };
      if (Number.isFinite(rsiValue) && rsiValue > Number(strategyCfg.rsiExitThreshold || 78)) return { shouldExit: true, reason: 'RSI_OVERBOUGHT_SWING', details: { rsiValue } };
      if (liquidityDropPct >= Number(strategyCfg.liquidityDropExitPct || 30)) return { shouldExit: true, reason: 'LIQUIDITY_DROP_SWING', details: { liquidityDropPct } };
      if (holderJumpPct >= Number(strategyCfg.holderConcentrationJumpPct || 8)) return { shouldExit: true, reason: 'HOLDER_CONCENTRATION_SWING', details: { holderJumpPct } };
      return { shouldExit: false, reason: null, details: { emaCrossDown, rsiValue, liquidityDropPct, holderJumpPct, minutesInTrade } };
    }

    if (minutesInTrade >= Number(strategyCfg.maxHoldMinutes || 240)) return { shouldExit: true, reason: 'MOMENTUM_MAX_HOLD_TIME', details: { minutesInTrade } };
    if (buySell.sellRatio10mPct > Number(strategyCfg.maxSellRatioPct10m || 60)) return { shouldExit: true, reason: 'SELL_PRESSURE_MOMENTUM', details: { sellRatio10mPct: buySell.sellRatio10mPct } };
    if (liquidityDropPct >= Number(strategyCfg.liquidityDropExitPct || 20)) return { shouldExit: true, reason: 'LIQUIDITY_DROP_MOMENTUM', details: { liquidityDropPct } };
    if (holderJumpPct >= Number(strategyCfg.holderConcentrationJumpPct || 6)) return { shouldExit: true, reason: 'HOLDER_CONCENTRATION_MOMENTUM', details: { holderJumpPct } };
    if (emaCrossDown) return { shouldExit: true, reason: 'EMA_CROSSDOWN_MOMENTUM', details: { emaCrossDown, rsiValue } };

    return {
      shouldExit: false,
      reason: null,
      details: {
        emaCrossDown,
        rsiValue,
        minutesInTrade,
        liquidityDropPct,
        sellRatio10mPct: buySell.sellRatio10mPct,
        holderJumpPct,
      },
    };
  }

  getHistoryLength(tokenAddress) {
    return (this.priceHistory[tokenAddress] || []).length;
  }
}

module.exports = MomentumStrategy;
