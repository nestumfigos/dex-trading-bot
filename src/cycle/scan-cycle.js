'use strict';

/**
 * Strategy scan-cycle dispatcher — pure module, dep-injected (Week 9.4 cycle split).
 *
 * Two cycles:
 *   - runStrategyScanCycle(strategyName)
 *     Per-strategy (momentum / swing) entry scanner. Iterates enabled chains,
 *     timeboxes each chain's scanChain() call, persists state + portfolio
 *     snapshot, releases scan-status indicators.
 *
 *     Momentum: scans solana + bsc + kucoin in parallel (Promise.allSettled).
 *     Swing: kucoin only (EMA(50/200) crossover doesn't fit DEX flow).
 *
 *   - runDetachedKucoinMomentumScan(cycleStats?)
 *     Standalone KuCoin momentum scan path used when the main loop is in
 *     swing-cycle window or paused. Respects shouldPauseKucoinEntryScans()
 *     for daily-reset warmup window + per-loss-streak halt.
 *
 * Reentrancy: each scan guards with loopLocks[name] = true/false. Lock keys:
 * 'momentumScan', 'swingScan', 'kucoinMomentumScan'.
 *
 * Trading window: returns early when !isWithinTradingWindow().
 *
 * Behavior preserved byte-identical from src/index.js inline versions.
 *
 * Usage:
 *   const { create } = require('./cycle/scan-cycle');
 *   const sc = create({ ... 17 deps ... });
 *   await sc.runStrategyScanCycle('momentum');
 *   await sc.runDetachedKucoinMomentumScan();
 */

function create({
  // state
  loopLocks,
  loopLastCompletedAt,
  filterStatsState,
  // config + helpers
  config,
  logger,
  refreshScanInFlightFlag,
  isWithinTradingWindow,
  shouldPauseKucoinEntryScans,
  withTimeout,
  // exchanges + per-chain
  exchanges,
  isStrategyScanEnabled,
  // scan body (stays in index.js for now)
  scanChain,
  // filter cycle lifecycle
  startFilterCycle,
  finalizeFilterCycle,
  // status indicators
  getStrategyScanStatus,
  syncChainScanStatus,
  // post-scan side effects
  recordPortfolioSnapshot,
  saveState,
} = {}) {
  if (!loopLocks) throw new Error('scan-cycle.create: loopLocks required');
  if (typeof isWithinTradingWindow !== 'function') throw new Error('scan-cycle.create: isWithinTradingWindow required');
  if (typeof scanChain !== 'function') throw new Error('scan-cycle.create: scanChain required');

  async function runStrategyScanCycle(strategyName) {
    const lockKey = strategyName === 'swing'
      ? 'swingScan'
      : strategyName === 'spot_day_bull_flag'
        ? 'bullFlagScan'
        : 'momentumScan';
    if (loopLocks[lockKey]) {
      return;
    }

    if (!isWithinTradingWindow()) {
      logger.debug(`[${strategyName}] Outside trading window — skipping entry scan`);
      return;
    }

    if (typeof startFilterCycle === 'function') startFilterCycle(strategyName);
    const cycleStats = filterStatsState?.currentCycle?.[strategyName] || null;
    const discoveryTimeoutMs = Math.max(15_000, Number(config.bot?.scanDiscoveryTimeoutMs || 120_000));
    const chainDiscoveryTimeoutMs = {
      solana: Math.max(15_000, Number(config.bot?.solanaScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
      bsc: Math.max(15_000, Number(config.bot?.bscScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
      kucoin: Math.max(15_000, Number(config.bot?.kucoinScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
    };
    const stateSaveTimeoutMs = Math.max(5_000, Number(config.bot?.stateSaveTimeoutMs || 20_000));

    loopLocks[lockKey] = true;
    if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
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
      } else if (strategyName === 'spot_day_bull_flag') {
        const chainScans = [
          ['kucoin', exchanges.kucoin],
          ['base', exchanges.base],
          ['bsc', exchanges.bsc],
        ].filter(([chainName]) => isStrategyScanEnabled(chainName, strategyName));

        if (chainScans.length) {
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
        }
      }

      if (typeof recordPortfolioSnapshot === 'function') recordPortfolioSnapshot(`scan_${strategyName}`);
      if (typeof saveState === 'function') {
        await withTimeout(
          saveState(),
          stateSaveTimeoutMs,
          `saveState timed out after ${stateSaveTimeoutMs}ms`
        );
      }
      loopLastCompletedAt[lockKey] = Date.now();
    } finally {
      if (typeof finalizeFilterCycle === 'function') finalizeFilterCycle(strategyName);

      // Set scan status back to idle for all chains
      if (strategyName === 'momentum') {
        ['solana', 'bsc', 'kucoin'].forEach((chainName) => {
          if (isStrategyScanEnabled(chainName, strategyName)) {
            const status = getStrategyScanStatus?.(chainName, strategyName);
            if (status) {
              status.status = 'idle';
              status.currentToken = '-';
              status.lastUpdate = new Date().toISOString();
              syncChainScanStatus?.(chainName);
            }
          }
        });
      } else if (strategyName === 'spot_day_bull_flag') {
        ['kucoin', 'base', 'bsc', 'solana'].forEach((chainName) => {
          if (isStrategyScanEnabled(chainName, strategyName)) {
            const status = getStrategyScanStatus?.(chainName, strategyName);
            if (status) {
              status.status = 'idle';
              status.currentToken = '-';
              status.lastUpdate = new Date().toISOString();
              syncChainScanStatus?.(chainName);
            }
          }
        });
      } else if (strategyName === 'swing') {
        if (isStrategyScanEnabled('kucoin', strategyName)) {
          const status = getStrategyScanStatus?.('kucoin', strategyName);
          if (status) {
            status.status = 'idle';
            status.currentToken = '-';
            status.lastUpdate = new Date().toISOString();
            syncChainScanStatus?.('kucoin');
          }
        }
      }

      loopLocks[lockKey] = false;
      if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
    }
  }

  async function runDetachedKucoinMomentumScan(cycleStats = null) {
    if (loopLocks.kucoinMomentumScan) {
      return;
    }

    if (!isWithinTradingWindow()) {
      return;
    }

    const kucoinScanGate = typeof shouldPauseKucoinEntryScans === 'function'
      ? shouldPauseKucoinEntryScans()
      : { paused: false };
    if (kucoinScanGate.paused) {
      logger.info(
        `KuCoin momentum entry scan paused: ${kucoinScanGate.reason}. ` +
        `Resuming warm-up ${(kucoinScanGate.msUntilReset / 60000).toFixed(0)}m before daily reset.`
      );
      return;
    }

    loopLocks.kucoinMomentumScan = true;
    if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
    try {
      await scanChain('kucoin', exchanges.kucoin, 'momentum', { cycleStats });
    } finally {
      loopLocks.kucoinMomentumScan = false;
      if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
    }
  }

  return { runStrategyScanCycle, runDetachedKucoinMomentumScan };
}

module.exports = { create };
