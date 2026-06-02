'use strict';

/**
 * Per-chain scan dispatcher (Week 16.1 extraction from src/index.js).
 * Mirrors live commit. Body identical to prior inline implementation; this
 * module exists for testability + readability. All collaborators dep-injected.
 */

function createMomentumScanner(deps = {}) {
  const {
    logger,
    config,
    marketState,
    scanStatus,
    filterStatsState,
    isExchangeAvailable,
    getStrategyScanStatus,
    syncChainScanStatus,
    refreshKucoinCatalystCache,
    getPrioritizedKucoinCatalystPairs,
    getTokensForStrategy,
    getBscDiscoveryRankSummary,
    getRotatingScanWindow,
    recordExchangeSuccess,
    recordExchangeFailure,
    processToken,
    withTimeout,
    sleep,
  } = deps;

  if (typeof logger?.info !== 'function') throw new Error('momentum-scanner: logger required');
  if (typeof isExchangeAvailable !== 'function') throw new Error('momentum-scanner: isExchangeAvailable required');
  if (typeof getStrategyScanStatus !== 'function') throw new Error('momentum-scanner: getStrategyScanStatus required');
  if (typeof processToken !== 'function') throw new Error('momentum-scanner: processToken required');

  async function scanChain(chainName, exchange, strategyName = 'momentum', options = {}) {
    const status = getStrategyScanStatus(chainName, strategyName);
    const cycleStats = options.cycleStats || filterStatsState?.currentCycle?.[strategyName] || null;

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
    if (scanStatus?.[chainName]) scanStatus[chainName].suppressedTokenErrors = 0;
    syncChainScanStatus(chainName);

    for (const key of Object.keys(marketState?.trackedTokens || {})) {
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

      const catalystPriority = (chainName === 'kucoin' && strategyName === 'momentum' && config?.risk?.catalystEnabled !== false)
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

      let batchSize = Math.max(4, Number(config?.bot?.dexBatchSize || 12));
      if (chainName === 'kucoin') {
        batchSize = Math.max(4, Number(config?.bot?.kucoinBatchSize || 12));
      } else if (chainName === 'solana') {
        batchSize = Math.max(2, Number(config?.bot?.solanaBatchSize || 8));
      } else if (chainName === 'base') {
        batchSize = Math.max(2, Number(config?.bot?.baseBatchSize || 8));
      }
      const batchDelayMs = chainName === 'kucoin'
        ? Math.max(200, Number(config?.bot?.kucoinBatchDelayMs || 700))
        : 500;
      const tokenProcessTimeoutMs = chainName === 'kucoin'
        ? Math.max(1000, Number(config?.bot?.kucoinTokenProcessTimeoutMs || 60_000))
        : null;

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
            const processPromise = processToken(chainName, exchange, tokenAddress, {
              forcedStrategies: options.forceStrategyPerScan === true ? [strategyName] : null,
              scanStrategy: strategyName,
              deadlineAtMs: tokenProcessTimeoutMs ? Date.now() + tokenProcessTimeoutMs : null,
            });
            if (tokenProcessTimeoutMs && typeof withTimeout === 'function') {
              await withTimeout(
                processPromise,
                tokenProcessTimeoutMs,
                `KuCoin token evaluation timed out for ${tokenAddress} after ${tokenProcessTimeoutMs}ms`,
              );
            } else {
              await processPromise;
            }
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

  return { scanChain };
}

module.exports = { createMomentumScanner };
