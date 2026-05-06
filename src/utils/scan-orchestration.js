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
      const candidateTokens = [...new Set([
        ...newListings,
        ...catalystPriority,
        ...allTokens,
      ])];
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
        logger.info(`KuCoin momentum scan window: ${scanTokens.length}/${candidateTokens.length} this cycle (rotating full universe)`);
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
            await processToken(chainName, exchange, tokenAddress, {
              forcedStrategies: [strategyName],
              scanStrategy: strategyName,
            });
          } catch (error) {
            logger.error(`Error processing ${tokenAddress} on ${chainName}/${strategyName}: ${error.message}`);
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
        ['solana', 'bsc', 'kucoin'].forEach((chainName) => {
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
