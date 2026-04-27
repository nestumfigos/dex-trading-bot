'use strict';
const config = require('../../config');
const { momentumSignal, ema, rsi, volumeSpike, adx } = require('../utils/indicators');
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

  recordTick(tokenAddress, price, volume = 0) {
    if (!Number.isFinite(price) || price <= 0) {
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
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();

    try {
      if (chainKey === 'kucoin') {
        const ccxtCandles = await this.fetchKuCoinCcxtCandles(tokenMeta.symbol, interval, lookbackBars);
        if (ccxtCandles && ccxtCandles.closes && ccxtCandles.closes.length >= minBars) {
          this.priceHistory[historyKey] = ccxtCandles.closes.slice(-lookbackBars);
          this.volumeHistory[historyKey] = (Array.isArray(ccxtCandles.volumes) ? ccxtCandles.volumes : []).slice(-lookbackBars);
          this.historySource[historyKey] = 'ccxt_kucoin';
          return true;
        }
        return false;
      }

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
    } catch (_error) {
      return false;
    }
  }

  async fetchKuCoinCcxtCandles(symbol, interval, limit) {
    try {
      // Try to use KuCoin exchange if available globally
      if (!global.kucoinExchange) {
        const ccxt = require('ccxt');
        global.kucoinExchange = new ccxt.kucoin({
          enableRateLimit: true,
          options: {
            defaultType: 'spot',
          },
        });
      }

      const exchange = global.kucoinExchange;
      if (!exchange) return null;

      // Parse interval for CCXT (e.g., '15m' → '15m')
      const timeframe = interval; // CCXT uses same format: 1m, 5m, 15m, 1h, 4h, 1d

      // Construct pair - handle symbol that might already have /USDT or not
      let pair = String(symbol || '').trim().toUpperCase();
      if (!pair.includes('/')) {
        pair = `${pair}/USDT`;
      }

      // Fetch OHLCV candles
      const ohlcvData = await exchange.fetchOHLCV(pair, timeframe, undefined, limit);
      if (!ohlcvData || ohlcvData.length === 0) return null;

      // Normalize to { closes, volumes }
      return {
        closes: ohlcvData.map(candle => Number(candle[4])), // close price is index 4
        volumes: ohlcvData.map(candle => Number(candle[5])), // volume is index 5
        highs: ohlcvData.map(candle => Number(candle[2])),
        lows: ohlcvData.map(candle => Number(candle[3])),
      };
    } catch (error) {
      return null;
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

  getBscDiscoveryLane(tokenMeta = {}) {
    const lane = String(
      tokenMeta.discoveryLane
      || tokenMeta.entryLane
      || tokenMeta.bscDiscoveryLane
      || ''
    ).trim().toLowerCase();
    if (lane === 'core' || lane === 'exploration' || lane === 'borderline') {
      return lane;
    }
    return null;
  }

  getBuySellStats(tokenMeta = {}) {
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();
    const fallbackBscWindowMinutes = Math.max(1, Number(config.strategies?.momentum?.bscRecentTxWindowMinutes || 5));
    const recentWindowMinutes = Math.max(1, Number(
      tokenMeta.recentTxWindowMinutes
      || tokenMeta.buyTxWindowMinutes
      || (chainKey === 'bsc' ? fallbackBscWindowMinutes : 10)
    ));
    const buyTxRecent = Number(
      tokenMeta.buyTxRecent
      ?? (chainKey === 'bsc' ? (tokenMeta.buyTx5m ?? tokenMeta.buyTx10m) : tokenMeta.buyTx10m)
      ?? 0
    );
    const sellTxRecent = Number(
      tokenMeta.sellTxRecent
      ?? (chainKey === 'bsc' ? (tokenMeta.sellTx5m ?? tokenMeta.sellTx10m) : tokenMeta.sellTx10m)
      ?? 0
    );
    const recentTxTotal = buyTxRecent + sellTxRecent;
    const buyRatioRecentPct = Number(
      tokenMeta.buyRatioRecentPct
      || (recentTxTotal > 0 ? (buyTxRecent / recentTxTotal) * 100 : 0)
    );
    const sellRatioRecentPct = recentTxTotal > 0 ? (sellTxRecent / recentTxTotal) * 100 : 0;
    const uniqueBuyersRecent = Number(
      tokenMeta.uniqueBuyersRecent
      ?? (chainKey === 'bsc' ? (tokenMeta.uniqueBuyers5m ?? tokenMeta.uniqueBuyers10m) : tokenMeta.uniqueBuyers10m)
      ?? 0
    );
    const buyTx10m = Number(tokenMeta.buyTx10m || 0);
    const sellTx10m = Number(tokenMeta.sellTx10m || 0);
    const buyTx1h = Number(tokenMeta.buyTx1h || 0);
    const sellTx1h = Number(tokenMeta.sellTx1h || 0);
    const txCountFirstHour = Number(tokenMeta.txCountFirstHour || (buyTx1h + sellTx1h));
    const tx10mTotal = buyTx10m + sellTx10m;
    const buyRatio10mPct = Number(tokenMeta.buyRatio10mPct || (tx10mTotal > 0 ? (buyTx10m / tx10mTotal) * 100 : buyRatioRecentPct));
    const sellRatio10mPct = tx10mTotal > 0 ? (sellTx10m / tx10mTotal) * 100 : 0;

    return {
      buyTxRecent,
      sellTxRecent,
      recentWindowMinutes,
      recentWindowLabel: `${recentWindowMinutes}m`,
      buyRatioRecentPct,
      sellRatioRecentPct,
      uniqueBuyersRecent,
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
    const applicable = { swing: false, momentum: false, momentumLane: null };

    const listingAgeDays = Number(tokenMeta.listingAgeDays || 0);
    const liquidity = Number(tokenMeta.liquidityUsd || 0);
    const volume24h = Number(tokenMeta.volume24h || 0);
    const priceChange24h = Number(tokenMeta.priceChange24h || 0);
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();

    const swingCfg = config.strategies?.swing || {};
    const momentumCfg = config.strategies?.momentum || {};
    const swingAllowedChains = new Set(['kucoin']);

    // Strategy A: Swing Trading (established tokens)
    if (swingCfg.enabled !== false && swingAllowedChains.has(chainKey)) {
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
      const maxAge = momentumCfg.maxTokenAgeDays || 1.0;
      const buySell = this.getBuySellStats(tokenMeta);
      const minTxCountFirstHour = Number(momentumCfg.minTxCountFirstHour || 50);
      const minBuyRatioRecentPct = chainKey === 'bsc'
        ? Number(momentumCfg.bscMinBuyRatioPct5m || momentumCfg.minBuyRatioPct10m || 60)
        : Number(momentumCfg.minBuyRatioPct10m || 60);
      const minUniqueBuyersRecent = chainKey === 'bsc'
        ? Number(momentumCfg.bscMinUniqueBuyers5m || momentumCfg.minUniqueBuyers10mBsc || 3)
        : Number(momentumCfg.minUniqueBuyers10m || 20);
      const kucoinUniversalEnabled = chainKey === 'kucoin' && momentumCfg.kucoinUniversalEnabled !== false;
      const kucoinMinLiq = Number(momentumCfg.kucoinUniversalMinLiquidityUsd || 100000);
      const kucoinMinVol24h = Number(momentumCfg.kucoinUniversalMin24hVolumeUsd || 1000000);
      const kucoinMinAbsChange24h = Number(momentumCfg.kucoinUniversalMinAbsPriceChange24hPct || 4);
      const bscDiscoveryLane = this.getBscDiscoveryLane(tokenMeta);
      const bscCoreMinLiquidityUsd = Number(
        momentumCfg.bscCoreMinLiquidityUsd
        || config.discovery?.bscCoreMinLiquidityUsd
        || config.discovery?.bscTopUniverseMinLiquidityUsd
        || 150000
      );
      const bscCoreMinVol24h = Number(
        momentumCfg.bscCoreMin24hVolumeUsd
        || config.discovery?.bscCoreMinVolume24hUsd
        || config.discovery?.bscTopUniverseMinVolume24hUsd
        || 500000
      );
      const bscCoreMinAbsChange24h = Number(momentumCfg.bscCoreMinAbsPriceChange24hPct || 2);
      const bscExplorationEnabled = chainKey === 'bsc' && config.discovery?.bscExplorationEnabled !== false;
      const bscExplorationMinLiquidityUsd = Number(
        momentumCfg.bscExplorationMinLiquidityUsd
        || config.discovery?.bscExplorationMinLiquidityUsd
        || 85000
      );
      const bscExplorationMinVol24h = Number(
        momentumCfg.bscExplorationMin24hVolumeUsd
        || config.discovery?.bscExplorationMinVolume24hUsd
        || 150000
      );
      const bscExplorationMinAbsChange24h = Number(momentumCfg.bscExplorationMinAbsPriceChange24hPct || 1);
      const bscBorderlineEnabled = chainKey === 'bsc'
        && (momentumCfg.bscBorderlineEnabled || config.discovery?.bscBorderlineEnabled);
      const bscBorderlineMinLiquidityUsd = Number(
        momentumCfg.bscBorderlineMinLiquidityUsd
        || config.discovery?.bscBorderlineMinLiquidityUsd
        || 65000
      );
      const bscBorderlineMinVol24h = Number(
        momentumCfg.bscBorderlineMin24hVolumeUsd
        || config.discovery?.bscBorderlineMinVolume24hUsd
        || 125000
      );
      const bscBorderlineMinAbsChange24h = Number(momentumCfg.bscBorderlineMinAbsPriceChange24hPct || 3);
      const bscBorderlineMinBuyRatioRecentPct = Number(momentumCfg.bscBorderlineMinBuyRatioPct5m || 60);
      const bscBorderlineMinUniqueBuyersRecent = Number(momentumCfg.bscBorderlineMinUniqueBuyers5m || 5);

      // First-hour tx count is only a meaningful signal while the token is still fresh (< 6h).
      // For older tokens the first-hour data is stale history, so we skip the gate.
      const isFreshToken = listingAgeDays <= 0.25;
      const txFirstHourOk = !isFreshToken || buySell.txCountFirstHour >= minTxCountFirstHour;

      const launchLaneApplicable = (
        listingAgeDays <= maxAge
        && liquidity >= launchMinLiq
        && liquidity <= maxLiq
        && txFirstHourOk
        && buySell.buyRatioRecentPct >= minBuyRatioRecentPct
      );

      const kucoinUniversalApplicable = kucoinUniversalEnabled
        && liquidity >= kucoinMinLiq
        && volume24h >= kucoinMinVol24h
        && Math.abs(priceChange24h) >= kucoinMinAbsChange24h;

      const bscCoreApplicable = chainKey === 'bsc'
        && (
          bscDiscoveryLane === 'core'
          || (
            liquidity >= bscCoreMinLiquidityUsd
            && volume24h >= bscCoreMinVol24h
            && Math.abs(priceChange24h) >= bscCoreMinAbsChange24h
            && buySell.buyRatioRecentPct >= minBuyRatioRecentPct
            && buySell.uniqueBuyersRecent >= minUniqueBuyersRecent
          )
        );
      const bscExplorationApplicable = chainKey === 'bsc'
        && bscExplorationEnabled
        && (
          bscDiscoveryLane === 'exploration'
          || (
            liquidity >= bscExplorationMinLiquidityUsd
            && volume24h >= bscExplorationMinVol24h
            && Math.abs(priceChange24h) >= bscExplorationMinAbsChange24h
            && buySell.buyRatioRecentPct >= minBuyRatioRecentPct
            && buySell.uniqueBuyersRecent >= minUniqueBuyersRecent
          )
        );
      const bscBorderlineApplicable = chainKey === 'bsc'
        && bscBorderlineEnabled
        && (
          bscDiscoveryLane === 'borderline'
          || (
            liquidity >= bscBorderlineMinLiquidityUsd
            && volume24h >= bscBorderlineMinVol24h
            && Math.abs(priceChange24h) >= bscBorderlineMinAbsChange24h
            && buySell.buyRatioRecentPct >= bscBorderlineMinBuyRatioRecentPct
            && buySell.uniqueBuyersRecent >= bscBorderlineMinUniqueBuyersRecent
          )
        );

      if (launchLaneApplicable || kucoinUniversalApplicable || bscCoreApplicable || bscExplorationApplicable || bscBorderlineApplicable) {
        applicable.momentum = true;
        if (chainKey === 'bsc') {
          applicable.momentumLane = bscDiscoveryLane
            || (bscCoreApplicable ? 'core' : (bscExplorationApplicable ? 'exploration' : 'borderline'));
        }
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
    const chainKey = String(tokenMeta.chainKey || tokenMeta.chain || '').toLowerCase();
    const isKucoin = chainKey === 'kucoin';
    const isBsc = chainKey === 'bsc';
    const bscDiscoveryLane = this.getBscDiscoveryLane(tokenMeta);

    const extremeMoveCandidate = strategyName === 'momentum'
      && strategyCfg.extremeMoveEnabled !== false
      && Math.abs(priceChange24hPct) >= Number(strategyCfg.extremeMoveMinAbsPriceChange24hPct || 200)
      && volume24h >= Number(strategyCfg.extremeMoveMin24hVolumeUsd || 50000)
      && liquidityUsd >= Number(strategyCfg.extremeMoveMinLiquidityUsd || 30000);

    // Use strategy-specific history requirement
    // For momentum, use a much lower requirement to catch very new tokens
    const momHistoryNeeded = strategyName === 'momentum'
      ? Math.max(
        Number(strategyCfg.emaSlow || 21) + 2,
        Number(strategyCfg.rsiPeriod || 14) + 1,
        Number(strategyCfg.volumeBaselineMinBars || 12)
      )
      : Math.max(strategyCfg.emaSlow + 5, 30);
    const hasFullHistory = prices.length >= momHistoryNeeded;
    if (!hasFullHistory && !extremeMoveCandidate) {
      return { signal: 'INSUFFICIENT_DATA', details: { bars: prices.length, required: momHistoryNeeded, strategy: strategyName } };
    }

    // Build strategy-specific parameters for momentum signal calculation
    const strategyParams = {
      emaFast: strategyCfg.emaFast,
      emaSlow: strategyCfg.emaSlow,
      rsiPeriod: strategyCfg.rsiPeriod,
      rsiBuyThreshold: isKucoin
        ? Number(strategyCfg.kucoinRsiBuyThreshold || strategyCfg.rsiBuyThreshold)
        : Number(strategyCfg.rsiBuyThreshold),
      rsiBuyMaxThreshold: isKucoin
        ? Number(strategyCfg.kucoinRsiBuyMaxThreshold || strategyCfg.rsiBuyMaxThreshold)
        : Number(strategyCfg.rsiBuyMaxThreshold),
      volumeSpikeMultiplier: isKucoin
        ? Number(strategyCfg.kucoinVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier)
        : Number(strategyCfg.volumeSpikeMultiplier),
      volumeBaselineMethod: strategyCfg.volumeBaselineMethod || 'median',
      volumeBaselineMinBars: Number(strategyCfg.volumeBaselineMinBars || 12),
      lowVolVolumeSpikeMultiplier: isKucoin
        ? Number(strategyCfg.kucoinVolumeSpikeMultiplier || strategyCfg.lowVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier)
        : Number(strategyCfg.lowVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier),
      highVolVolumeSpikeMultiplier: isKucoin
        ? Number(strategyCfg.kucoinVolumeSpikeMultiplier || strategyCfg.highVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier)
        : Number(strategyCfg.highVolVolumeSpikeMultiplier || strategyCfg.volumeSpikeMultiplier),
      breakoutLookback: strategyCfg.breakoutLookback,
      breakoutBufferPct: strategyCfg.breakoutBufferPct,
      allowTrendContinuation: strategyName === 'momentum',
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
      const baseBars = strategyName === 'momentum'
        ? Math.max(
          Number(strategyParams.emaSlow || 21) + 2,
          Number(strategyParams.rsiPeriod || 14) + 1,
          Number(strategyParams.volumeBaselineMinBars || 12)
        )
        : Math.max(Number(strategyParams.emaSlow || 21) + 5, 30);
      const timeframes = {
        short: baseBars,
        medium: baseBars + (strategyName === 'momentum' ? 4 : 10),
        long: baseBars + (strategyName === 'momentum' ? 10 : 20),
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

    const rsiBuyMin = Number(strategyParams.rsiBuyThreshold || 45);
    const rsiBuyMax = Number(strategyParams.rsiBuyMaxThreshold || 65);
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
    const adxValue = adx(prices, Number(strategyCfg.adxPeriod || 14));
    const strictSolanaOnchainChecks = chainKey === 'solana' && strategyCfg.strictSolanaOnchainChecks !== false;

    // Determine final signal
    let finalSignal = 'HOLD';
    let confidence = 0;
    let netBuyFlowUsd10m = null;
    let triggerTimeframe = null;
    let technicalBlocked = false;
    let drawdownFromRecentAthPct = null;

    if (strategyName === 'swing') {
      const hasLegitimacy = Boolean(tokenMeta.coingeckoId || tokenMeta.listedOnCoinGecko || tokenMeta.listedOnCoinMarketCap || String(tokenMeta.chain || '').toLowerCase() === 'kucoin');
      const athLookbackBars = Math.max(20, Number(strategyCfg.swingAthLookbackBars || 120));
      const athWindow = prices.slice(-Math.min(prices.length, athLookbackBars));
      const recentAth = athWindow.length ? Math.max(...athWindow.map((v) => Number(v || 0))) : latestPrice;
      drawdownFromRecentAthPct = recentAth > 0 ? ((recentAth - latestPrice) / recentAth) * 100 : 0;
      const maxDrawdownFromRecentAthPct = Math.max(0, Number(strategyCfg.maxDrawdownFromRecentAthPct || 35));

      if (strategyCfg.requireCoinGeckoOrCmc && !hasLegitimacy) externalReasons.push('Not listed on CoinGecko/CoinMarketCap');
      if (strategyCfg.excludeStableWrappedLp !== false && this.isExcludedAsset(tokenMeta)) externalReasons.push('Stablecoin/wrapped/LP token excluded');
      if (strategyCfg.adxEnabled !== false && (!Number.isFinite(adxValue) || adxValue < Number(strategyCfg.minAdx || 18))) {
        externalReasons.push(`ADX ${Number.isFinite(adxValue) ? adxValue.toFixed(1) : 'n/a'} < ${Number(strategyCfg.minAdx || 18)}`);
      }
      if (!trendUp) externalReasons.push('7-day trend is not upward');
      if (liquidityChange24hPct < -5) externalReasons.push('Liquidity trend is shrinking');
      if (drawdownFromRecentAthPct > maxDrawdownFromRecentAthPct) {
        externalReasons.push(`Price ${drawdownFromRecentAthPct.toFixed(1)}% below recent ATH > ${maxDrawdownFromRecentAthPct}%`);
      }

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
      const bypassMicrostructureChecks = isKucoin
        || Boolean(extremeMoveCandidate && strategyCfg.extremeMoveBypassMicrostructureChecks !== false);

      // Only enforce first-hour tx gate for fresh tokens (< 6h); for older tokens the data is stale.
      const isFreshLaunch = Number(tokenMeta.listingAgeDays || 0) <= 0.25;
      if (!bypassMicrostructureChecks && isFreshLaunch && buySell.txCountFirstHour < Number(strategyCfg.minTxCountFirstHour || 50)) {
        externalReasons.push(`Transactions first hour ${buySell.txCountFirstHour} < ${strategyCfg.minTxCountFirstHour}`);
      }
      const minBuyRatioRecentPct = isBsc
        ? Number(strategyCfg.bscMinBuyRatioPct5m || strategyCfg.minBuyRatioPct10m || 60)
        : Number(strategyCfg.minBuyRatioPct10m || 60);
      if (!bypassMicrostructureChecks && buySell.buyRatioRecentPct < minBuyRatioRecentPct) {
        externalReasons.push(`Buy ratio ${buySell.recentWindowLabel} ${buySell.buyRatioRecentPct.toFixed(1)}% < ${minBuyRatioRecentPct}%`);
      }
      // BSC: uniqueBuyers10m is proxied by buy-tx-count (DexScreener has no wallet-level data).
      // Use a lower threshold for BSC so the gate still catches zero-activity tokens.
      const hasUniqueBuyerData = buySell.uniqueBuyersRecent !== undefined && buySell.uniqueBuyersRecent !== null && buySell.uniqueBuyersRecent !== '';
      const uniqueBuyersThreshold = chainKey === 'bsc'
        ? Number(strategyCfg.bscMinUniqueBuyers5m || strategyCfg.minUniqueBuyers10mBsc || 3)
        : Number(strategyCfg.minUniqueBuyers10m || 20);
      if (!bypassMicrostructureChecks && !hasUniqueBuyerData && strictSolanaOnchainChecks) {
        externalReasons.push(`Unique buyers ${buySell.recentWindowLabel} unavailable (strict Solana momentum mode)`);
      } else if (!bypassMicrostructureChecks && hasUniqueBuyerData && buySell.uniqueBuyersRecent < uniqueBuyersThreshold) {
        externalReasons.push(`Unique buyers ${buySell.recentWindowLabel} ${buySell.uniqueBuyersRecent} < ${uniqueBuyersThreshold}`);
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

      // MOMENTUM: Relaxed multi-timeframe requirement — short + medium is sufficient for BUY (long may be unavailable for new tokens)
      const buySetup = (shortSignal === 'BUY' && mediumSignal === 'BUY') && inRsiBuyZone && hasVolumeSpike;
      const extremeMinBars = Math.max(3, Number(strategyCfg.extremeMoveMinHistoryBars || 8));
      const recentStartIndex = Math.max(0, prices.length - extremeMinBars);
      const recentStartPrice = Number(prices[recentStartIndex] || 0);
      const recentMovePct = recentStartPrice > 0 && Number.isFinite(latestPrice)
        ? ((latestPrice - recentStartPrice) / recentStartPrice) * 100
        : 0;

      const extremeVolumeSpike = volumeSpike(volumes, {
        method: strategyCfg.extremeMoveVolumeBaselineMethod || strategyParams.volumeBaselineMethod || 'median',
        minBars: Number(strategyCfg.extremeMoveVolumeBaselineMinBars || strategyParams.volumeBaselineMinBars || 12),
      });

      const extremeBuySetup = extremeMoveCandidate
        && prices.length >= extremeMinBars
        && recentMovePct >= Number(strategyCfg.extremeMoveMinRecentPct || 8)
        && Number.isFinite(extremeVolumeSpike)
        && extremeVolumeSpike >= Number(strategyCfg.extremeMoveMinVolumeSpike || 1.1);

      const kucoinRelaxedSetup = isKucoin
        && inRsiBuyZone
        && trendUp
        && shortSignal !== 'SELL'
        && mediumSignal !== 'SELL';
      const bscRelaxedSetup = isBsc
        && strategyCfg.bscRelaxedContinuationEnabled !== false
        && mediumSignal === 'BUY'
        && shortSignal !== 'SELL'
        && inRsiBuyZone
        && Number.isFinite(shortVolumeSpike)
        && shortVolumeSpike >= Number(strategyCfg.bscRelaxedVolumeSpikeMultiplier || 1.2)
        && buySell.buyRatioRecentPct >= Number(strategyCfg.bscRelaxedMinBuyRatioPct5m || strategyCfg.bscMinBuyRatioPct5m || 45)
        && liquidityUsd >= Number(strategyCfg.bscRelaxedMinLiquidityUsd || 100000)
        && !Boolean(tokenMeta.isHoneypot)
        && tokenMeta.roundTripFrictionPassed !== false
        && tokenMeta.privateRouteVerified !== false;

      if ((buySetup || extremeBuySetup || kucoinRelaxedSetup || bscRelaxedSetup) && externalReasons.length === 0) {
        finalSignal = 'BUY';
        if (extremeBuySetup && !buySetup && !kucoinRelaxedSetup && !bscRelaxedSetup) {
          confidence = 0.85;
          triggerTimeframe = 'extreme_24h_momentum';
        } else if (kucoinRelaxedSetup && !buySetup && !extremeBuySetup && !bscRelaxedSetup) {
          confidence = 0.7;
          triggerTimeframe = 'kucoin_relaxed_momentum';
        } else if (bscRelaxedSetup && !buySetup && !extremeBuySetup && !kucoinRelaxedSetup) {
          confidence = 0.78;
          triggerTimeframe = 'bsc_relaxed_continuation';
        } else {
          confidence = 1.0;
          triggerTimeframe = 'momentum_breakout';
        }
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
        discoveryLane: bscDiscoveryLane,
        breakoutConfirmed,
        netBuyFlowUsd10m,
        rsiBuyMin,
        rsiBuyMax,
        mediumRsi,
        recentWindowMinutes: buySell.recentWindowMinutes,
        recentWindowLabel: buySell.recentWindowLabel,
        buyRatioRecentPct: buySell.buyRatioRecentPct,
        sellRatioRecentPct: buySell.sellRatioRecentPct,
        buyRatio10mPct: buySell.buyRatio10mPct,
        sellRatio10mPct: buySell.sellRatio10mPct,
        txCountFirstHour: buySell.txCountFirstHour,
        uniqueBuyersRecent: buySell.uniqueBuyersRecent,
        uniqueBuyers10m: buySell.uniqueBuyers10m,
        topHoldersPct,
        liquidityChange24hPct,
        adx: Number.isFinite(adxValue) ? Number(adxValue.toFixed(2)) : null,
        drawdownFromRecentAthPct,
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
      if (emaCrossDown) return { shouldExit: true, reason: 'EMA_CROSSDOWN_SWING', details: { emaCrossDown, rsiValue, fast, slow } };
      if (Number.isFinite(rsiValue) && rsiValue > Number(strategyCfg.rsiExitThreshold || 78)) return { shouldExit: true, reason: 'RSI_OVERBOUGHT_SWING', details: { rsiValue, fast, slow } };
      if (liquidityDropPct >= Number(strategyCfg.liquidityDropExitPct || 30)) return { shouldExit: true, reason: 'LIQUIDITY_DROP_SWING', details: { liquidityDropPct, fast, slow } };
      if (holderJumpPct >= Number(strategyCfg.holderConcentrationJumpPct || 8)) return { shouldExit: true, reason: 'HOLDER_CONCENTRATION_SWING', details: { holderJumpPct, fast, slow } };
      return { shouldExit: false, reason: null, details: { emaCrossDown, rsiValue, liquidityDropPct, holderJumpPct, minutesInTrade, fast, slow } };
    }

    if (buySell.sellRatio10mPct > Number(strategyCfg.maxSellRatioPct10m || 60)) return { shouldExit: true, reason: 'SELL_PRESSURE_MOMENTUM', details: { sellRatio10mPct: buySell.sellRatio10mPct } };
    if (liquidityDropPct >= Number(strategyCfg.liquidityDropExitPct || 20)) return { shouldExit: true, reason: 'LIQUIDITY_DROP_MOMENTUM', details: { liquidityDropPct } };
    if (holderJumpPct >= Number(strategyCfg.holderConcentrationJumpPct || 6)) return { shouldExit: true, reason: 'HOLDER_CONCENTRATION_MOMENTUM', details: { holderJumpPct } };
    if (emaCrossDown) return { shouldExit: true, reason: 'EMA_CROSSDOWN_MOMENTUM', details: { emaCrossDown, rsiValue, fast, slow } };

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
        fast,
        slow,
      },
    };
  }

  getHistoryLength(tokenAddress) {
    return (this.priceHistory[tokenAddress] || []).length;
  }
}

module.exports = MomentumStrategy;
