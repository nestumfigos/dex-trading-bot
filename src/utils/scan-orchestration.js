function createScanOrchestration(deps = {}) {
  const {
    logger,
    config,
    exchanges,
    marketState,
    scanStatus,
    filterStatsState,
    loopLocks,
    loopLastCompletedAt,
    getStrategyScanStatus,
    isExchangeAvailable,
    syncChainScanStatus,
    getTokensForStrategy,
    refreshKucoinCatalystCache,
    getPrioritizedKucoinCatalystPairs,
    getBscDiscoveryRankSummary,
    getRotatingScanWindow,
    sleep,
    processToken,
    withTimeout,
    recordExchangeSuccess,
    recordExchangeFailure,
    isWithinTradingWindow,
    startFilterCycle,
    finalizeFilterCycle,
    isStrategyScanEnabled,
    recordPortfolioSnapshot,
    saveState,
    refreshScanInFlightFlag,
    shouldPauseKucoinEntryScans,
  } = deps;

  function normalizeKucoinSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase().replace('-', '/');
  }

  function getKucoinTicker(exchange, symbol) {
    const normalized = normalizeKucoinSymbol(symbol);
    return exchange?.tickerCache?.[normalized]
      || exchange?.tickerCache?.[normalized.replace('/', '-')]
      || exchange?.tickerCache?.[symbol]
      || null;
  }

  function rankKucoinCandidates(candidateTokens, exchange, priorityTokens = []) {
    const candidates = [...new Set((Array.isArray(candidateTokens) ? candidateTokens : [])
      .map((token) => normalizeKucoinSymbol(token))
      .filter(Boolean))];
    if (!candidates.length) return [];

    const prioritySet = new Set((Array.isArray(priorityTokens) ? priorityTokens : [])
      .map((token) => normalizeKucoinSymbol(token))
      .filter(Boolean));
    const rankedScanLimit = Math.max(40, Math.min(150, Number(config.bot?.kucoinRankedScanLimit || 90)));
    const perCycleCap = Math.max(20, Math.min(150, Number(config.bot?.kucoinMaxTokensPerCycle || rankedScanLimit)));
    const limit = Math.min(rankedScanLimit, perCycleCap);

    const ranked = candidates
      .map((symbol) => {
        const ticker = getKucoinTicker(exchange, symbol);
        const quoteVolume = Number(ticker?.quoteVolume || ticker?.quoteVolumeUsd || ticker?.volValue || 0);
        const changePct = Number(ticker?.percentage || ticker?.changeRate || ticker?.priceChangePercent || 0);
        const last = Number(ticker?.last || ticker?.close || 0);
        const hasPriority = prioritySet.has(symbol);
        const positiveMomentum = Number.isFinite(changePct) ? Math.max(0, Math.min(25, changePct)) : 0;
        const score = (hasPriority ? 1e15 : 0)
          + Math.log10(Math.max(1, quoteVolume)) * 1000
          + positiveMomentum * 20
          + (last > 0 ? 1 : 0);
        return { symbol, score, quoteVolume, hasPriority };
      })
      .sort((left, right) => right.score - left.score);

    const selected = ranked.slice(0, limit).map((item) => item.symbol);
    logger.info(
      `KuCoin ranked fast scan: ${selected.length}/${candidates.length} candidates ` +
      `(limit=${limit}, priority=${ranked.filter((item) => item.hasPriority).length})`
    );
    return selected;
  }

  function prefilterKucoinMomentumCandidates(candidateTokens, exchange, priorityTokens = []) {
    const enabled = config.bot?.kucoinFastPrefilterEnabled !== false;
    const normalizedCandidates = [...new Set((Array.isArray(candidateTokens) ? candidateTokens : [])
      .map((token) => normalizeKucoinSymbol(token))
      .filter(Boolean))];
    if (!enabled || !normalizedCandidates.length) {
      return normalizedCandidates;
    }

    const prioritySet = new Set((Array.isArray(priorityTokens) ? priorityTokens : [])
      .map((token) => normalizeKucoinSymbol(token))
      .filter(Boolean));
    const prefilterLimit = Math.max(8, Math.min(60, Number(config.bot?.kucoinFastPrefilterLimit || 24)));
    const breakoutReserve = Math.max(0, Math.min(prefilterLimit, Number(config.bot?.kucoinFastPrefilterBreakoutReserve || 8)));
    const explorationReserve = Math.max(0, Math.min(prefilterLimit, Number(config.bot?.kucoinFastPrefilterExplorationReserve || 4)));
    const minQuoteVolumeUsd = Math.max(0, Number(config.bot?.kucoinFastPrefilterMinQuoteVolumeUsd || 750000));
    const minAbsChangePct = Math.max(0, Number(config.bot?.kucoinFastPrefilterMinAbsChangePct || 1.2));
    const stableLikePattern = /^(USDC|USDT|USDE|FDUSD|TUSD|PYUSD|DAI|BUSD|USD1|USDD|PAXG|XAUT)\/USDT$/i;
    const trackedBreakouts = Object.values(marketState.trackedTokens || {})
      .filter((entry) => String(entry?.chainKey || entry?.chain || '').toLowerCase() === 'kucoin')
      .map((entry) => {
        const symbol = normalizeKucoinSymbol(entry?.address || (entry?.symbol ? `${entry.symbol}/USDT` : ''));
        const state = entry?.momentumState || {};
        const indicators = entry?.indicators || {};
        const accelerationScore = Number(state.accelerationScore || 0);
        const consecutiveStrongScans = Number(state.consecutiveStrongScans || 0);
        const volumeSpike = Number(indicators.volumeSpike || entry?.volumeSpike || 0);
        const priceChange24h = Math.abs(Number(entry?.priceChange24h || 0));
        const eligible = symbol
          && normalizedCandidates.includes(symbol)
          && !stableLikePattern.test(symbol)
          && (
            consecutiveStrongScans >= 1
            || accelerationScore >= Number(config.strategies?.momentum?.kucoinEarlyBreakoutMinAccelerationScore || 0.6)
            || volumeSpike >= Number(config.strategies?.momentum?.kucoinEarlyBreakoutMinVolumeSpike || 1.35)
          );
        const score = (consecutiveStrongScans * 500)
          + (Math.max(0, accelerationScore) * 120)
          + (Math.max(0, volumeSpike) * 90)
          + Math.min(40, priceChange24h) * 10;
        return { symbol, eligible, score };
      })
      .filter((item) => item.eligible)
      .sort((left, right) => right.score - left.score)
      .slice(0, breakoutReserve)
      .map((item) => item.symbol);

    const ranked = normalizedCandidates
      .map((symbol) => {
        const ticker = getKucoinTicker(exchange, symbol);
        const quoteVolume = Number(ticker?.quoteVolume || ticker?.quoteVolumeUsd || ticker?.volValue || 0);
        const changePct = Number(ticker?.percentage || ticker?.changeRate || ticker?.priceChangePercent || 0);
        const last = Number(ticker?.last || ticker?.close || 0);
        const absChangePct = Math.abs(changePct);
        const hasPriority = prioritySet.has(symbol);
        const stableLike = stableLikePattern.test(symbol);
        const passesLiquidity = quoteVolume >= minQuoteVolumeUsd;
        const passesMove = absChangePct >= minAbsChangePct;
        const eligible = hasPriority || (!stableLike && last > 0 && passesLiquidity && passesMove);
        const score = (hasPriority ? 1e15 : 0)
          + Math.log10(Math.max(1, quoteVolume)) * 1000
          + Math.min(40, Math.max(0, absChangePct) * 15)
          + (changePct > 0 ? 150 : 0)
          + (last > 0 ? 1 : 0);
        return { symbol, eligible, hasPriority, stableLike, quoteVolume, absChangePct, score };
      })
      .filter((item) => item.eligible)
      .sort((left, right) => right.score - left.score);
    const rankedSymbols = new Set(ranked.map((item) => item.symbol));
    const exploration = normalizedCandidates
      .filter((symbol) => !rankedSymbols.has(symbol) && !trackedBreakouts.includes(symbol))
      .map((symbol) => {
        const ticker = getKucoinTicker(exchange, symbol);
        const quoteVolume = Number(ticker?.quoteVolume || ticker?.quoteVolumeUsd || ticker?.volValue || 0);
        const changePct = Number(ticker?.percentage || ticker?.changeRate || ticker?.priceChangePercent || 0);
        const last = Number(ticker?.last || ticker?.close || 0);
        const stableLike = stableLikePattern.test(symbol);
        const eligible = !stableLike && last > 0 && Number.isFinite(changePct) && changePct > 0;
        const score = Math.min(12, Math.max(0, changePct)) * 100
          + Math.log10(Math.max(1, quoteVolume)) * 50
          + Math.random();
        return { symbol, eligible, score };
      })
      .filter((item) => item.eligible)
      .sort((left, right) => right.score - left.score)
      .slice(0, explorationReserve)
      .map((item) => item.symbol);

    const selected = [
      ...trackedBreakouts,
      ...exploration,
      ...ranked.map((item) => item.symbol),
    ].filter((symbol, index, arr) => symbol && arr.indexOf(symbol) === index)
      .slice(0, prefilterLimit);
    logger.info(
      `KuCoin fast prefilter: ${selected.length}/${normalizedCandidates.length} candidates ` +
      `(limit=${prefilterLimit}, breakoutReserve=${trackedBreakouts.length}, explorationReserve=${exploration.length}, minVol=$${Math.round(minQuoteVolumeUsd)}, minMove=${minAbsChangePct}%, priority=${ranked.filter((item) => item.hasPriority).length})`
    );
    return selected.length ? selected : normalizedCandidates.slice(0, Math.min(prefilterLimit, normalizedCandidates.length));
  }

  async function scanChain(chainName, exchange, strategyName = 'momentum', options = {}) {
    const status = getStrategyScanStatus(chainName, strategyName);
    const cycleStats = options.cycleStats || filterStatsState.currentCycle?.[strategyName] || null;

    if (!isExchangeAvailable(chainName)) {
      status.status = 'degraded';
      status.currentToken = 'skipped (exchange unavailable)';
      status.currentPair = '-';
      status.lastUpdate = new Date().toISOString();
      syncChainScanStatus(chainName);
      return;
    }

    logger.info(`Scanning ${exchange.name} for ${strategyName} strategy...`);
    status.status = 'scanning';
    status.currentToken = 'discovering tokens';
    status.currentPair = '-';
    status.tokensScanned = 0;
    status.discoveredTokens = 0;
    status.evaluatedTokens = 0;
    status.laneSummary = null;
    status.lastUpdate = new Date().toISOString();
    scanStatus[chainName].suppressedTokenErrors = 0;
    syncChainScanStatus(chainName);

    for (const key of Object.keys(marketState.trackedTokens || {})) {
      if (key.startsWith(`${chainName}:`)) {
        marketState.trackedTokens[key].finalSignal = 'SCANNING';
      }
    }

    try {
      if (chainName === 'kucoin' && typeof exchange.refreshTickers === 'function') {
        await exchange.refreshTickers();
      }

      const newListings = (chainName === 'kucoin' && typeof exchange.getNewListings === 'function')
        ? await exchange.getNewListings().catch(() => [])
        : [];

      const catalystPriority = (chainName === 'kucoin' && strategyName === 'momentum' && config.risk?.catalystEnabled !== false)
        ? await refreshKucoinCatalystCache(exchange).catch((error) => {
          logger.warn(`KuCoin catalyst refresh failed: ${error.message}`);
          return getPrioritizedKucoinCatalystPairs();
        })
        : [];

      const allTokens = await getTokensForStrategy(chainName, exchange, strategyName, {
        onBscBaseCount: (count) => {
          if (chainName !== 'bsc') return;
          status.discoveredTokens = Number(count || 0);
          status.currentToken = 'ranking bsc core + exploration';
          status.currentPair = '-';
          status.lastUpdate = new Date().toISOString();
          syncChainScanStatus(chainName);
        },
      });
      let candidateTokens = [...new Set([
        ...newListings,
        ...catalystPriority,
        ...allTokens,
      ])];
      if (chainName === 'kucoin') {
        candidateTokens = rankKucoinCandidates(candidateTokens, exchange, [
          ...newListings,
          ...catalystPriority,
        ]);
        if (strategyName === 'momentum') {
          candidateTokens = prefilterKucoinMomentumCandidates(candidateTokens, exchange, [
            ...newListings,
            ...catalystPriority,
          ]);
        }
      }
      status.discoveredTokens = candidateTokens.length;

      if (candidateTokens.length === 0) {
        status.currentToken = `no ${strategyName} candidates`;
        status.currentPair = '-';
        status.lastUpdate = new Date().toISOString();
        syncChainScanStatus(chainName);
        logger.info(`No ${strategyName} candidates on ${chainName}; skipping token evaluation this cycle`);
        recordExchangeSuccess(chainName);
        return;
      }

      if (chainName === 'bsc' && strategyName === 'momentum') {
        status.laneSummary = getBscDiscoveryRankSummary();
        syncChainScanStatus(chainName);
      }

      const scanTokens = getRotatingScanWindow(candidateTokens, chainName, strategyName);

      const batchSize = chainName === 'kucoin'
        ? Math.max(4, Number(config.bot?.kucoinBatchSize || 12))
        : 50;
      const batchDelayMs = chainName === 'kucoin'
        ? Math.max(200, Number(config.bot?.kucoinBatchDelayMs || 700))
        : 500;

      if (chainName === 'kucoin' && strategyName === 'momentum') {
        logger.info(`KuCoin momentum scan window: ${scanTokens.length}/${candidateTokens.length} this cycle (ranked fast universe)`);
      }

      for (let i = 0; i < scanTokens.length; i += batchSize) {
        const batch = scanTokens.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (tokenAddress) => {
          status.currentToken = tokenAddress;
          status.currentPair = '-';
          status.tokensScanned += 1;
          status.evaluatedTokens += 1;
          if (cycleStats) {
            cycleStats.evaluated += 1;
          }
          status.lastUpdate = new Date().toISOString();
          syncChainScanStatus(chainName);

          try {
            const processPromise = processToken(chainName, exchange, tokenAddress, {
              forcedStrategies: [strategyName],
              scanStrategy: strategyName,
            });
            if (chainName === 'kucoin') {
              const tokenTimeoutMs = Math.max(3_000, Number(config.bot?.kucoinTokenProcessTimeoutMs || 60_000));
              await withTimeout(
                processPromise,
                tokenTimeoutMs,
                `token ${tokenAddress} processing timed out`
              );
            } else {
              await processPromise;
            }
          } catch (error) {
            const isKucoinDeferredTimeout = chainName === 'kucoin'
              && /processing timed out/i.test(String(error?.message || ''));
            if (isKucoinDeferredTimeout) {
              status.deferredTokens = Number(status.deferredTokens || 0) + 1;
              scanStatus[chainName].deferredTokenEvaluations = Number(scanStatus[chainName].deferredTokenEvaluations || 0) + 1;
              logger.debug(`KuCoin ${strategyName} evaluation deferred for ${tokenAddress}: ${error.message}`);
              return;
            }
            logger.error(`Error processing ${tokenAddress} on ${chainName}/${strategyName}: ${error.message}\n${error.stack || ''}`);
          }
        }));

        await sleep(batchDelayMs);
      }
      recordExchangeSuccess(chainName);
    } catch (error) {
      status.status = 'error';
      recordExchangeFailure(chainName, error.message);
      logger.error(`Scan failed on ${chainName}: ${error.message}`);
    } finally {
      status.status = 'idle';
      status.currentToken = '-';
      status.currentPair = '-';
      status.lastUpdate = new Date().toISOString();
      syncChainScanStatus(chainName);
    }
  }

  async function runStrategyScanCycle(strategyName) {
    const lockKey = strategyName === 'swing' ? 'swingScan' : 'momentumScan';
    if (loopLocks[lockKey]) {
      return;
    }

    if (!isWithinTradingWindow()) {
      logger.debug(`[${strategyName}] Outside trading window - skipping entry scan`);
      return;
    }

    startFilterCycle(strategyName);
    const cycleStats = filterStatsState.currentCycle?.[strategyName] || null;
    const discoveryTimeoutMs = Math.max(15_000, Number(config.bot?.scanDiscoveryTimeoutMs || 120_000));
    const chainDiscoveryTimeoutMs = {
      solana: Math.max(15_000, Number(config.bot?.solanaScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
      bsc: Math.max(15_000, Number(config.bot?.bscScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
      base: Math.max(15_000, Number(config.bot?.baseScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
      kucoin: Math.max(15_000, Number(config.bot?.kucoinScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
    };
    const stateSaveTimeoutMs = Math.max(5_000, Number(config.bot?.stateSaveTimeoutMs || 20_000));

    loopLocks[lockKey] = true;
    refreshScanInFlightFlag();
    try {
      if (strategyName === 'momentum') {
        const chainScans = [
          ['solana', exchanges.solana],
          ['bsc', exchanges.bsc],
          ['base', exchanges.base],
          ['kucoin', exchanges.kucoin],
        ].filter(([chainName]) => isStrategyScanEnabled(chainName, strategyName));

        await Promise.allSettled(
          chainScans.map(([chainName, exchange]) => withTimeout(
            scanChain(chainName, exchange, strategyName, { cycleStats }),
            chainDiscoveryTimeoutMs[chainName] || discoveryTimeoutMs,
            `${chainName} ${strategyName} scan timed out after ${chainDiscoveryTimeoutMs[chainName] || discoveryTimeoutMs}ms`
          ))
        ).then((results) => {
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              const [chainName] = chainScans[index];
              logger.error(`${chainName} ${strategyName} scan failed`, {
                reason: result.reason?.message || String(result.reason || 'unknown_error'),
              });
            }
          });
        });
      } else if (strategyName === 'swing' && isStrategyScanEnabled('kucoin', strategyName)) {
        await withTimeout(
          scanChain('kucoin', exchanges.kucoin, strategyName, { cycleStats }),
          chainDiscoveryTimeoutMs.kucoin,
          `kucoin ${strategyName} scan timed out after ${chainDiscoveryTimeoutMs.kucoin}ms`
        ).catch((error) => {
          logger.error(`kucoin ${strategyName} scan failed`, { reason: error.message });
        });
      }

      recordPortfolioSnapshot(`scan_${strategyName}`);
      await withTimeout(
        saveState(),
        stateSaveTimeoutMs,
        `saveState timed out after ${stateSaveTimeoutMs}ms`
      );
      loopLastCompletedAt[lockKey] = Date.now();
    } finally {
      finalizeFilterCycle(strategyName);

      if (strategyName === 'momentum') {
        ['solana', 'bsc', 'base', 'kucoin'].forEach((chainName) => {
          if (isStrategyScanEnabled(chainName, strategyName)) {
            const status = getStrategyScanStatus(chainName, strategyName);
            status.status = 'idle';
            status.currentToken = '-';
            status.lastUpdate = new Date().toISOString();
            syncChainScanStatus(chainName);
          }
        });
      } else if (strategyName === 'swing' && isStrategyScanEnabled('kucoin', strategyName)) {
        const status = getStrategyScanStatus('kucoin', strategyName);
        status.status = 'idle';
        status.currentToken = '-';
        status.lastUpdate = new Date().toISOString();
        syncChainScanStatus('kucoin');
      }

      loopLocks[lockKey] = false;
      refreshScanInFlightFlag();
    }
  }

  async function runDetachedKucoinMomentumScan(cycleStats = null) {
    if (loopLocks.kucoinMomentumScan) {
      return;
    }

    if (!isWithinTradingWindow()) {
      return;
    }

    const kucoinScanGate = shouldPauseKucoinEntryScans();
    if (kucoinScanGate.paused) {
      logger.info(
        `KuCoin momentum entry scan paused: ${kucoinScanGate.reason}. ` +
        `Resuming warm-up ${(kucoinScanGate.msUntilReset / 60000).toFixed(0)}m before daily reset.`
      );
      return;
    }

    loopLocks.kucoinMomentumScan = true;
    refreshScanInFlightFlag();
    try {
      await scanChain('kucoin', exchanges.kucoin, 'momentum', { cycleStats });
    } finally {
      loopLocks.kucoinMomentumScan = false;
      refreshScanInFlightFlag();
    }
  }

  return {
    scanChain,
    runStrategyScanCycle,
    runDetachedKucoinMomentumScan,
  };
}

module.exports = { createScanOrchestration };
