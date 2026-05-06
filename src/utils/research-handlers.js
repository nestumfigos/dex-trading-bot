function createResearchHandlers(deps = {}) {
  const {
    config,
    logger,
    marketState,
    strategy,
    exchanges,
    CHAIN_LABELS,
    normalizeChainKey,
    buildTokenKey,
    getTrackedTokens,
    getPortfolioSnapshot,
    getHistorySeries,
    getOhlcvSeries,
    runBacktest,
    runBacktestWithRegimes,
    runWalkForwardBacktest,
    runRegimeSpecificBacktest,
    runPortfolioBacktest,
    runPaperSimulation,
    runHyperopt,
    runValidation,
    buildBaseBacktestOptions,
    AITradeBrain,
    recordBrainSuccess,
    recordBrainFailure,
    refreshBrainAvailability,
    round,
  } = deps;

  function getResearchCoverageSnapshot(tokenAddress, chainKey) {
    const minBars = Math.max(30, Number(config.research?.minHistoryBars || 120));
    const priceBars = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress).length;
    const volumeBars = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress).length;
    const availableBars = Math.min(priceBars, volumeBars);
    return {
      ok: priceBars >= minBars && volumeBars >= minBars,
      minBars,
      priceBars,
      volumeBars,
      availableBars,
      missingBars: Math.max(0, minBars - availableBars),
    };
  }

  async function runBacktestRequest(payload) {
    const tokenAddress = String(payload.tokenAddress || '').trim();
    const chainKey = normalizeChainKey(payload.chain);
    const strategyName = String(payload.strategy || 'momentum').toLowerCase();
    const strategyCfg = config.strategies?.[strategyName] || config.strategies?.momentum;
    const backtestMode = String(payload.mode || 'standard').toLowerCase();

    if (!strategyCfg) {
      throw new Error(`Unknown backtest strategy: ${strategyName}`);
    }
    if (!tokenAddress && backtestMode !== 'portfolio') {
      return null;
    }

    const priceHistory = backtestMode !== 'portfolio' ? getHistorySeries(strategy.priceHistory, chainKey, tokenAddress) : [];
    const volumeHistory = backtestMode !== 'portfolio' ? getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress) : [];
    const baseOptions = {
      startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
      tradePct: Number(payload.tradePct || 0.05),
      riskSettings: config.risk,
      entrySlippagePct: Number(payload.entrySlippagePct ?? 0.8),
      exitSlippagePct: Number(payload.exitSlippagePct ?? 1.2),
      entryFeePct: Number(payload.entryFeePct ?? 0.15),
      exitFeePct: Number(payload.exitFeePct ?? 0.15),
      outageChancePct: Number(payload.outageChancePct ?? 0.5),
      ruinDrawdownLimitPct: Number(payload.ruinDrawdownLimitPct ?? config.backtest?.monteCarloRuinThresholdPct ?? config.risk?.dailyDrawdownLimitPct ?? 15),
      monteCarloRuns: Number(payload.monteCarloRuns ?? 2000),
      seed: Number(payload.seed || 1337),
      chainKey: chainKey || 'solana',
      strategySettings: strategyCfg,
      historyLength: Number(payload.historyLength || 200),
    };

    let result = null;
    switch (backtestMode) {
      case 'portfolio':
        result = runPortfolioBacktest((priceHist, volHist, stratSettings, opts) => runBacktest(priceHist, volHist, stratSettings, opts), baseOptions);
        break;
      case 'walk_forward':
        result = runWalkForwardBacktest(priceHistory, volumeHistory, strategyCfg, {
          ...baseOptions,
          trainPct: Number(payload.trainPct || 0.7),
          validatePct: Number(payload.validatePct || 0.15),
        });
        break;
      case 'regime':
        result = runRegimeSpecificBacktest(priceHistory, volumeHistory, strategyCfg, {
          ...baseOptions,
          targetRegime: String(payload.targetRegime || 'uptrend'),
          regimeWindowBars: Number(payload.regimeWindowBars || 20),
        });
        break;
      case 'regime_aware':
        result = runBacktestWithRegimes(priceHistory, volumeHistory, strategyCfg, {
          ...baseOptions,
          regimeWindowBars: Number(payload.regimeWindowBars || 20),
        });
        break;
      case 'standard':
      default:
        result = runBacktest(priceHistory, volumeHistory, strategyCfg, baseOptions);
    }

    if (!result) return null;
    const tracked = backtestMode !== 'portfolio' ? getTrackedTokens().find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase()) : null;
    const response = {
      tokenAddress: backtestMode === 'portfolio' ? 'portfolio_6_assets' : tokenAddress,
      symbol: backtestMode === 'portfolio' ? 'PORTFOLIO' : (tracked?.symbol || tokenAddress.slice(0, 10)),
      chain: backtestMode === 'portfolio' ? 'multi' : (tracked?.chain || null),
      strategy: strategyName,
      backtestMode,
      historyBars: backtestMode === 'portfolio' ? baseOptions.historyLength : priceHistory.length,
      generatedAt: new Date().toISOString(),
      ...result,
    };
    marketState.backtests.unshift(response);
    if (marketState.backtests.length > 10) marketState.backtests.pop();
    return response;
  }

  async function seedBacktestData(priceHistory, volumeHistory, tokenAddress, chain) {
    const { seedHistoricalData } = require('./backtest-utils');
    const result = seedHistoricalData(priceHistory, volumeHistory, tokenAddress, chain, strategy.priceHistory);
    if (result.success) {
      const key = `${String(chain).toLowerCase()}:${String(tokenAddress).toLowerCase()}`;
      strategy.volumeHistory = strategy.volumeHistory || {};
      strategy.volumeHistory[key] = volumeHistory.slice();
      logger.info(`Backtest data seeded for ${tokenAddress} on ${chain}: ${result.dataPoints} bars`);
    }
    return result;
  }

  async function ensureResearchHistory(tokenAddress, chainKey) {
    const targetBars = Math.max(120, Number(config.research?.targetHistoryBars || 240));
    const currentCoverage = getResearchCoverageSnapshot(tokenAddress, chainKey);
    const currentPrices = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress);
    const currentVolumes = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress);
    if (currentCoverage.ok) {
      return { ...currentCoverage, source: 'memory' };
    }

    const histKey = buildTokenKey(chainKey, tokenAddress);
    if (chainKey === 'kucoin' && exchanges.kucoin?.exchange?.fetchOHLCV) {
      try {
        const rows = await exchanges.kucoin.exchange.fetchOHLCV(tokenAddress, '1h', undefined, targetBars);
        const closes = Array.isArray(rows) ? rows.map((row) => Number(row?.[4] || 0)).filter((value) => Number.isFinite(value) && value > 0) : [];
        const volumes = Array.isArray(rows) ? rows.map((row) => Number(row?.[5] || 0)).filter((value) => Number.isFinite(value) && value >= 0) : [];
        if (closes.length >= currentCoverage.minBars && volumes.length >= currentCoverage.minBars) {
          strategy.priceHistory[histKey] = closes.slice(-targetBars);
          strategy.volumeHistory[histKey] = volumes.slice(-targetBars);
          return { ...getResearchCoverageSnapshot(tokenAddress, chainKey), source: 'kucoin_ohlcv' };
        }
      } catch (error) {
        logger.debug(`Research history fetch failed for ${tokenAddress} on ${chainKey}: ${error.message}`);
      }
    }

    try {
      const tracked = marketState.trackedTokens?.[histKey] || null;
      const ohlcv = await getOhlcvSeries({
        chainKey,
        address: tokenAddress,
        pairAddress: tracked?.pairAddress || '',
        interval: chainKey === 'solana' ? '1h' : '4h',
        limit: targetBars,
      });
      const closes = Array.isArray(ohlcv?.closes) ? ohlcv.closes.filter((value) => Number.isFinite(Number(value)) && Number(value) > 0) : [];
      const volumes = Array.isArray(ohlcv?.volumes) ? ohlcv.volumes.filter((value) => Number.isFinite(Number(value)) && Number(value) >= 0) : [];
      if (closes.length >= currentCoverage.minBars && volumes.length >= currentCoverage.minBars) {
        strategy.priceHistory[histKey] = closes.slice(-targetBars);
        strategy.volumeHistory[histKey] = volumes.slice(-targetBars);
        return { ...getResearchCoverageSnapshot(tokenAddress, chainKey), source: ohlcv?.source || 'external_ohlcv' };
      }
    } catch (error) {
      logger.debug(`External research history fetch failed for ${tokenAddress} on ${chainKey}: ${error.message}`);
    }

    return { ...getResearchCoverageSnapshot(tokenAddress, chainKey), source: 'insufficient' };
  }

  function buildInsufficientHistoryError(kind, tokenAddress, chainKey, coverage) {
    const error = new Error(`Insufficient backtest history for ${kind}`);
    error.code = 'INSUFFICIENT_HISTORY';
    error.tokenAddress = tokenAddress;
    error.chainKey = chainKey;
    error.historyCoverage = coverage;
    error.missingHistoryCount = Number(coverage?.missingBars || 0);
    return error;
  }

  async function runHyperoptRequest(payload) {
    const tokenAddress = String(payload.tokenAddress || '').trim();
    const chainKey = normalizeChainKey(payload.chain);
    const strategyName = String(payload.strategy || 'momentum').toLowerCase();
    if (!tokenAddress) throw new Error('tokenAddress is required for hyperopt');
    await ensureResearchHistory(tokenAddress, chainKey);
    const priceHistory = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress);
    const volumeHistory = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress);
    return runHyperopt({
      priceHistory,
      volumeHistory,
      strategyName,
      mode: payload.mode || 'walk_forward',
      paramGrid: payload.paramGrid || {},
      maxCandidates: payload.maxCandidates || 30,
      baseOptions: {
        ...buildBaseBacktestOptions({ ...payload, chainKey }),
        trainPct: Number(payload.trainPct || config.backtest?.walkForwardTrainPct || 0.7),
        validatePct: Number(payload.validatePct || config.backtest?.walkForwardValidatePct || 0.15),
        regimeWindowBars: Number(payload.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      },
    });
  }

  async function runValidationRequest(payload) {
    const tokenAddress = String(payload.tokenAddress || '').trim();
    const chainKey = normalizeChainKey(payload.chain);
    const strategyName = String(payload.strategy || 'momentum').toLowerCase();
    if (!tokenAddress) throw new Error('tokenAddress is required for validation');
    const coverage = await ensureResearchHistory(tokenAddress, chainKey);
    if (!coverage.ok) {
      throw buildInsufficientHistoryError('validation', tokenAddress, chainKey, coverage);
    }
    const priceHistory = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress);
    const volumeHistory = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress);
    return runValidation({
      priceHistory,
      volumeHistory,
      strategyName,
      mode: payload.mode || 'walk_forward',
      candidateParams: payload.candidateParams || {},
      baselineParams: payload.baselineParams || {},
      baseOptions: {
        ...buildBaseBacktestOptions({ ...payload, chainKey }),
        trainPct: Number(payload.trainPct || config.backtest?.walkForwardTrainPct || 0.7),
        validatePct: Number(payload.validatePct || config.backtest?.walkForwardValidatePct || 0.15),
        regimeWindowBars: Number(payload.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      },
    });
  }

  async function runPositionResearchRequest(payload) {
    const tokenAddress = String(payload.tokenAddress || '').trim();
    const chainKey = normalizeChainKey(payload.chain);
    const strategyName = String(payload.strategy || 'momentum').toLowerCase();
    if (!tokenAddress) throw new Error('tokenAddress is required for position research');
    const coverage = await ensureResearchHistory(tokenAddress, chainKey);
    if (!coverage.ok) {
      throw buildInsufficientHistoryError('validation', tokenAddress, chainKey, coverage);
    }
    const priceHistory = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress);
    const volumeHistory = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress);
    const basePayload = { ...payload, chainKey, strategy: strategyName };
    const validation = runValidation({
      priceHistory,
      volumeHistory,
      strategyName,
      mode: 'walk_forward',
      candidateParams: payload.candidateParams || {},
      baselineParams: payload.baselineParams || {},
      baseOptions: {
        ...buildBaseBacktestOptions(basePayload),
        trainPct: Number(payload.trainPct || config.backtest?.walkForwardTrainPct || 0.7),
        validatePct: Number(payload.validatePct || config.backtest?.walkForwardValidatePct || 0.15),
        regimeWindowBars: Number(payload.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      },
    });
    const hyperopt = runHyperopt({
      priceHistory,
      volumeHistory,
      strategyName,
      mode: 'walk_forward',
      paramGrid: payload.paramGrid || {},
      maxCandidates: payload.maxCandidates || 18,
      baseOptions: {
        ...buildBaseBacktestOptions(basePayload),
        trainPct: Number(payload.trainPct || config.backtest?.walkForwardTrainPct || 0.7),
        validatePct: Number(payload.validatePct || config.backtest?.walkForwardValidatePct || 0.15),
        regimeWindowBars: Number(payload.regimeWindowBars || config.backtest?.regimeWindowBars || 20),
      },
    });
    const response = {
      ok: true,
      tokenAddress,
      chain: chainKey,
      strategy: strategyName,
      source: String(payload.source || 'manual'),
      historyCoverage: coverage,
      generatedAt: new Date().toISOString(),
      validation,
      hyperopt,
    };
    marketState.backtests.unshift({
      generatedAt: response.generatedAt,
      scenario: `research:${strategyName}`,
      tradeCount: Number(validation?.candidate?.metrics?.tradeCount || 0),
      totalReturn: Number(validation?.candidate?.metrics?.totalReturn || 0),
      winRate: Number(validation?.candidate?.metrics?.winRate || 0),
    });
    if (marketState.backtests.length > 10) marketState.backtests.pop();
    return response;
  }

  function getResearchTargets() {
    const positions = Array.isArray(getPortfolioSnapshot({ compact: false })?.positions)
      ? getPortfolioSnapshot({ compact: false }).positions
      : [];
    const tracked = getTrackedTokens({ compact: false })
      .filter((token) => token && token.address && token.chainKey && (token.finalSignal === 'BUY' || token.hasOpenPosition))
      .sort((left, right) => Number(right.liquidityUsd || 0) - Number(left.liquidityUsd || 0));

    const merged = [];
    const seen = new Set();
    for (const position of positions) {
      const key = `${String(position.chainKey || position.chain || '').toLowerCase()}:${String(position.address || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        symbol: position.symbol,
        address: position.address,
        chainKey: normalizeChainKey(position.chainKey || position.chain),
        strategy: position.strategy || 'momentum',
        source: 'open_position',
      });
    }
    for (const token of tracked) {
      const key = `${String(token.chainKey || token.chain || '').toLowerCase()}:${String(token.address || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        symbol: token.symbol,
        address: token.address,
        chainKey: normalizeChainKey(token.chainKey || token.chain),
        strategy: token.strategy || 'momentum',
        source: token.hasOpenPosition ? 'open_position' : 'tracked_signal',
      });
    }
    return merged
      .map((target) => ({
        ...target,
        historyCoverage: getResearchCoverageSnapshot(target.address, target.chainKey),
      }))
      .sort((left, right) => {
        const leftOpen = left.source === 'open_position' ? 1 : 0;
        const rightOpen = right.source === 'open_position' ? 1 : 0;
        if (leftOpen !== rightOpen) return rightOpen - leftOpen;
        const leftReady = left.historyCoverage?.ok ? 1 : 0;
        const rightReady = right.historyCoverage?.ok ? 1 : 0;
        if (leftReady !== rightReady) return rightReady - leftReady;
        const leftMissing = Number(left.historyCoverage?.missingBars || 0);
        const rightMissing = Number(right.historyCoverage?.missingBars || 0);
        return leftMissing - rightMissing;
      });
  }

  async function runSimulationRequest(payload) {
    const result = runPaperSimulation({
      scenario: String(payload.scenario || 'bull'),
      periods: Number(payload.periods || 160),
      startPrice: Number(payload.startPrice || 1),
      baseVolume: Number(payload.baseVolume || 100000),
      seed: payload.seed || `sim-${Date.now()}`,
      strategySettings: config.strategy,
      riskSettings: config.risk,
      startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
      tradePct: Number(payload.tradePct || 0.05),
    });
    if (!result) return null;
    const response = { generatedAt: new Date().toISOString(), ...result };
    marketState.simulations.unshift({
      generatedAt: response.generatedAt,
      scenario: response.scenario,
      tradeCount: response.tradeCount,
      totalReturn: response.totalReturn,
      winRate: response.winRate,
    });
    if (marketState.simulations.length > 10) marketState.simulations.pop();
    return response;
  }

  async function previewAiSignal(payload) {
    const chainKey = normalizeChainKey(payload.chain);
    const tokenAddress = String(payload.tokenAddress || '').trim();
    const strategyName = String(payload.strategy || 'momentum').toLowerCase();
    if (!chainKey || !tokenAddress || !exchanges[chainKey]) return null;

    const tokenData = await exchanges[chainKey].getTokenData(tokenAddress);
    if (!tokenData) return null;

    tokenData.address = tokenData.address || tokenAddress;
    tokenData.chainKey = chainKey;
    tokenData.chain = CHAIN_LABELS[chainKey];
    tokenData.strategyKey = buildTokenKey(chainKey, tokenData.address);

    const evaluation = await strategy.evaluateForStrategy(tokenData.strategyKey, strategyName, tokenData);
    if (!evaluation.details) evaluation.details = {};
    let aiDecision = null;

    if (config.anthropic.enabled && config.anthropic.apiKey) {
      aiDecision = await AITradeBrain.evaluateToken(tokenData, {
        ...evaluation.details,
        signal: evaluation.signal,
        strategy: strategyName,
        confidenceFloor: Number(config.strategies?.[strategyName]?.aiConfidenceFloor || config.risk.aiConfidenceFloor || 70),
      });
      if (aiDecision) recordBrainSuccess(tokenData, aiDecision);
      else recordBrainFailure('AI preview unavailable');
    } else {
      refreshBrainAvailability();
    }

    return {
      token: {
        symbol: tokenData.symbol,
        address: tokenData.address,
        chain: tokenData.chain,
        price: round(tokenData.price, 8),
        liquidityUsd: round(tokenData.liquidityUsd || 0),
        volume24h: round(tokenData.volume24h || 0),
        priceChange24h: round(tokenData.priceChange24h || 0, 2),
      },
      technical: {
        signal: evaluation.signal,
        details: evaluation.details,
      },
      ai: aiDecision,
    };
  }

  return {
    runBacktestRequest,
    seedBacktestData,
    ensureResearchHistory,
    runHyperoptRequest,
    runValidationRequest,
    runPositionResearchRequest,
    getResearchTargets,
    getResearchCoverageSnapshot,
    runSimulationRequest,
    previewAiSignal,
  };
}

module.exports = { createResearchHandlers };
