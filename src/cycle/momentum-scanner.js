'use strict';

const STABLE_OR_QUASI_STABLE_BASES = new Set([
  'USDC',
  'DAI',
  'TUSD',
  'FDUSD',
  'USDP',
  'USDJ',
  'PYUSD',
  'EUR',
  'EURT',
]);

const LEVERAGED_BASE_RE = /(?:3L|3S|2L|2S|UP|DOWN|BULL|BEAR)$/i;

function normalizeKucoinSymbol(token) {
  const raw = String(token || '').trim().toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.includes('/') ? raw : `${raw}/USDT`;
}

function rankKucoinBullFlagCandidates(tokens = [], exchange = {}) {
  const tickerCache = exchange?.tickerCache || {};
  return [...new Set(tokens)]
    .map((token, originalIndex) => {
      const symbol = normalizeKucoinSymbol(token);
      const base = symbol.replace('/USDT', '');
      const ticker = tickerCache[symbol] || tickerCache[token] || {};
      const quoteVolume = Number(ticker.quoteVolume || ticker.quoteVolumeUsd || 0);
      const percentage = Number(ticker.percentage ?? ticker.changePct ?? 0);
      const positiveChange = Math.max(0, Number.isFinite(percentage) ? percentage : 0);
      const absoluteChange = Math.abs(Number.isFinite(percentage) ? percentage : 0);
      const liquidityScore = quoteVolume > 0 ? Math.log10(quoteVolume + 1) * 20 : 0;
      const score = liquidityScore + (positiveChange * 8) + (absoluteChange * 1.5);
      return { token, symbol, base, quoteVolume, score, originalIndex };
    })
    .filter((item) => item.symbol.endsWith('/USDT'))
    .filter((item) => !STABLE_OR_QUASI_STABLE_BASES.has(item.base))
    .filter((item) => !LEVERAGED_BASE_RE.test(item.base))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.quoteVolume !== left.quoteVolume) return right.quoteVolume - left.quoteVolume;
      return left.originalIndex - right.originalIndex;
    })
    .map((item) => item.token);
}

// 2026-08-03: volume-ranked scan universe (fixes the 30-day entry freeze).
//
// PROBLEM: getRotatingScanWindow walked the KuCoin universe blind — 40 of
// ~583 tokens per cycle, cursor-ordered. But the universe is dominated by
// dust: median 24h volume $51k, only 12.5% of names clear $500k. So ~80% of
// every scan slice died at `prefilter_volume_below_min` before any strategy
// logic ran, and the handful of survivors rarely cleared the downstream
// confirmation stack. Result: zero entries fleet-wide for 30 days.
//
// FIX: rank by 24h quote volume and drop names below the strategy's own
// volume floor BEFORE the rotation cursor sees the list. The cursor then
// walks the qualifying subset — so every scanned token can actually trade,
// while rotation still gives breadth across the eligible universe (better
// than a static top-N, which would only ever show the same 40 names and
// miss a mid-tier token waking up).
//
// This loosens NO strategy gate. It only stops wasting scan slots on names
// the volume floor was always going to reject.
//
// Safety: cold ticker cache (startup) or a too-small qualifying set falls
// back to volume-sorted full list rather than returning an empty universe —
// scanning something beats scanning nothing. Disable with
// KUCOIN_VOLUME_RANKED_SCAN=false.
function rankKucoinByVolume(tokens = [], exchange = {}, { minVolumeUsd = 0, minCandidates = 40 } = {}) {
  const tickerCache = exchange?.tickerCache || {};
  const scored = [...new Set(tokens)]
    .map((token, originalIndex) => {
      const symbol = normalizeKucoinSymbol(token);
      const base = symbol.replace('/USDT', '');
      const ticker = tickerCache[symbol] || tickerCache[token] || {};
      const quoteVolume = Number(ticker.quoteVolume || ticker.quoteVolumeUsd || 0);
      return { token, symbol, base, quoteVolume, originalIndex };
    })
    .filter((item) => item.symbol.endsWith('/USDT'))
    .filter((item) => !STABLE_OR_QUASI_STABLE_BASES.has(item.base))
    .filter((item) => !LEVERAGED_BASE_RE.test(item.base))
    .sort((left, right) => {
      if (right.quoteVolume !== left.quoteVolume) return right.quoteVolume - left.quoteVolume;
      return left.originalIndex - right.originalIndex;
    });

  if (!scored.length) return [...new Set(tokens)];

  // Cold cache guard: if we have no volume data at all, ranking is
  // meaningless — hand back the original order untouched.
  if (!scored.some((item) => item.quoteVolume > 0)) return [...new Set(tokens)];

  const qualifying = minVolumeUsd > 0
    ? scored.filter((item) => item.quoteVolume >= minVolumeUsd)
    : scored;

  // Never starve the scanner: if the floor leaves too few names to fill a
  // cycle, top up with the next-highest-volume tokens (they still get
  // rejected downstream, but the scan keeps moving and the log shows why).
  const selected = qualifying.length >= minCandidates
    ? qualifying
    : scored.slice(0, Math.max(minCandidates, qualifying.length));

  return selected.map((item) => item.token);
}

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
      let candidateTokens = [...new Set([
        ...newListings,
        ...catalystPriority,
        ...allTokens,
      ])];
      let volumeRankStats = null;
      if (chainName === 'kucoin' && strategyName === 'spot_day_bull_flag') {
        candidateTokens = rankKucoinBullFlagCandidates(candidateTokens, exchange);
      } else if (chainName === 'kucoin' && process.env.KUCOIN_VOLUME_RANKED_SCAN !== 'false') {
        // 2026-08-03: rank + volume-floor the universe before the rotation
        // cursor sees it (see rankKucoinByVolume for the full rationale).
        // Uses the strategy's OWN floor so live ($5M) and paper ($500k)
        // each get a correctly-sized eligible set.
        const strategyCfg = config?.strategies?.[strategyName] || {};
        const minVolumeUsd = Number(strategyCfg.min24hVolumeUsd || 0);
        const before = candidateTokens.length;
        candidateTokens = rankKucoinByVolume(candidateTokens, exchange, {
          minVolumeUsd,
          minCandidates: Math.max(20, Number(config?.bot?.kucoinMaxTokensPerCycle || 40)),
        });
        volumeRankStats = { before, after: candidateTokens.length, minVolumeUsd };
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
        const rankNote = volumeRankStats
          ? `volume-ranked ${volumeRankStats.after}/${volumeRankStats.before} eligible >= $${Math.round(volumeRankStats.minVolumeUsd).toLocaleString()}`
          : 'rotating full universe';
        logger.info(`KuCoin momentum scan window: ${scanTokens.length}/${candidateTokens.length} this cycle (${rankNote})`);
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

module.exports = { createMomentumScanner, rankKucoinByVolume };
