'use strict';

/**
 * Strategy scan-cycle dispatcher — pure module, dep-injected (Week 9.4 cycle split).
 *
 * Two cycles:
 *   - runStrategyScanCycle(strategyName)
 *     Per-strategy entry scanner. Iterates enabled chains,
 *     timeboxes each chain's scanChain() call, persists state + portfolio
 *     snapshot, releases scan-status indicators.
 *
 *     Momentum: scans solana + bsc + kucoin in parallel (Promise.allSettled).
 *     Paper-only strategies scan their configured chain only.
 *
 *   - runDetachedKucoinMomentumScan(cycleStats?)
 *     Standalone KuCoin momentum scan path used when the main loop is in
 *     swing-cycle window or paused. Respects shouldPauseKucoinEntryScans()
 *     for daily-reset warmup window + per-loss-streak halt.
 *
 * Reentrancy: each scan guards with loopLocks[name] = true/false.
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

const DEFAULT_SCAN_CHAINS = Object.freeze({
  momentum: ['solana', 'bsc', 'kucoin'],
  spot_day_bull_flag: ['kucoin'],
  backes_swing: ['kucoin'],
  bsc_flow_breakout: ['bsc'],
  base_dex_momentum_reclaim: ['base'],
  solana_bull_flag_v2: ['solana'],
});

function normalizeStrategyName(strategyName) {
  return String(strategyName || 'momentum').trim().toLowerCase();
}

function normalizeChains(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function getScanLockKey(strategyName) {
  if (strategyName === 'spot_day_bull_flag') return 'bullFlagScan';
  if (strategyName === 'momentum') return 'momentumScan';
  return `${strategyName}Scan`;
}

function getConfiguredScanChains(config, exchanges, isStrategyScanEnabled, strategyName) {
  const configured = normalizeChains(config?.strategies?.[strategyName]?.enabledChains);
  const defaults = DEFAULT_SCAN_CHAINS[strategyName] || [];
  const candidates = configured.length ? configured : defaults;
  return [...new Set(candidates)]
    .filter((chainName) => exchanges?.[chainName])
    .filter((chainName) => isStrategyScanEnabled(chainName, strategyName));
}

function create({
  // state
  loopLocks,
  loopLastCompletedAt,
  loopLastStartedAt,
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
    strategyName = normalizeStrategyName(strategyName);
    const lockKey = getScanLockKey(strategyName);
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
    if (loopLastStartedAt) loopLastStartedAt[lockKey] = Date.now();
    if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
    try {
      const chainScans = getConfiguredScanChains(config, exchanges, isStrategyScanEnabled, strategyName)
        .map((chainName) => [chainName, exchanges[chainName]]);

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

      getConfiguredScanChains(config, exchanges, isStrategyScanEnabled, strategyName).forEach((chainName) => {
        const status = getStrategyScanStatus?.(chainName, strategyName);
          if (status) {
            status.status = 'idle';
            status.currentToken = '-';
            status.lastUpdate = new Date().toISOString();
          syncChainScanStatus?.(chainName);
          }
      });

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
    if (loopLastStartedAt) loopLastStartedAt.kucoinMomentumScan = Date.now();
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
