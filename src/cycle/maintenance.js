'use strict';

/**
 * Cycle maintenance utilities — pure module, dep-injected (Week 9.5 cycle split).
 *
 * Three independent maintenance routines:
 *
 *   - evictStuckPositions({...})
 *     Removes positions stuck (unsellable) for > STUCK_POSITION_EVICTION_HOURS
 *     (default 2h). Moves to portfolio.untrackedWalletPositions so value stays
 *     visible on dashboard. Also clears stale stuck flags for keys whose
 *     positions are already gone.
 *
 *   - refreshSwingWatchlists({...})
 *     Pulls latest discovery feeds per chain (KuCoin + optionally DEX chains
 *     that support swing), filters via strategy.determineApplicableStrategies,
 *     accepted tokens added to module-scope watchlists (capped at 120/chain).
 *     Reentrancy guarded by loopLocks.swingRefresh.
 *
 *   - runSqlAutoPrune(log)
 *     Deletes high-churn telemetry rows older than per-table retention
 *     (12h-72h). Keeps SQL Express under 10GB limit. Best-effort: per-table
 *     errors logged at debug, never throw.
 *
 * Behavior preserved byte-identical from src/index.js inline versions.
 *
 * Usage:
 *   const m = require('./cycle/maintenance');
 *   const evict = m.createEvictStuckPositions({ portfolio, logger, saveState });
 *   const refresh = m.createRefreshSwingWatchlists({ ...8 deps });
 *   await m.runSqlAutoPrune(logger);
 */

function createEvictStuckPositions({ portfolio, logger, saveState }) {
  if (!portfolio) throw new Error('createEvictStuckPositions: portfolio required');
  if (!logger) throw new Error('createEvictStuckPositions: logger required');

  return function evictStuckPositions() {
    const STUCK_EVICTION_HOURS = Number(process.env.STUCK_POSITION_EVICTION_HOURS || 2);
    const nowMs = Date.now();
    const stuck = portfolio.stuckPositions || {};
    let evicted = 0;
    for (const [key, meta] of Object.entries(stuck)) {
      if (!portfolio.positions?.[key]) {
        delete portfolio.stuckPositions[key];
        logger.info(`[StuckEvict] Cleared stale stuck flag for ${meta.symbol} (${key}) because no in-state position remains.`);
        continue;
      }
      const stuckMs = nowMs - Date.parse(meta.stuckAt || 0);
      if (stuckMs < STUCK_EVICTION_HOURS * 3_600_000) continue;
      const pos = portfolio.positions[key];
      // Move to untrackedWalletPositions so the value is still visible on the dashboard
      if (!portfolio.untrackedWalletPositions) portfolio.untrackedWalletPositions = {};
      portfolio.untrackedWalletPositions[key] = {
        symbol: meta.symbol,
        chainKey: meta.chainKey,
        address: meta.address,
        estimatedValueUsd: meta.estimatedValueUsd,
        reason: 'stuck_evicted',
        evictedAt: new Date().toISOString(),
        originalPosition: pos,
      };
      delete portfolio.positions[key];
      evicted++;
      logger.warn(
        `[StuckEvict] Evicted ${meta.symbol} (${key}) from positions after ${(stuckMs / 3_600_000).toFixed(1)}h stuck. ` +
        `EstValue ~$${Number(meta.estimatedValueUsd || 0).toFixed(2)}. Slot freed.`
      );
    }
    if (evicted > 0 && typeof saveState === 'function') {
      saveState();
    }
    return evicted;
  };
}

function createRefreshSwingWatchlists({
  loopLocks,
  logger,
  config,
  exchanges,
  watchlists,
  scanStatus,
  strategy,
  supportsSwingOnChain,
  isExchangeAvailable,
}) {
  if (!loopLocks) throw new Error('createRefreshSwingWatchlists: loopLocks required');
  if (!exchanges) throw new Error('createRefreshSwingWatchlists: exchanges required');
  if (!watchlists) throw new Error('createRefreshSwingWatchlists: watchlists required');

  return async function refreshSwingWatchlists() {
    if (loopLocks.swingRefresh) {
      return;
    }

    loopLocks.swingRefresh = true;
    try {
      logger.info('Refreshing swing watchlists from discovery feeds');
      const perChainLimit = 120;

      await Promise.allSettled(Object.entries(exchanges).map(async ([chainName, exchange]) => {
        if (typeof supportsSwingOnChain === 'function' && !supportsSwingOnChain(chainName)) return;
        if (typeof isExchangeAvailable === 'function' && !isExchangeAvailable(chainName)) return;
        if (typeof exchange.getNewTokens !== 'function') {
          logger.warn(`refreshSwingWatchlists: ${chainName} has no getNewTokens method, skipping`);
          return;
        }
        const discovered = await exchange.getNewTokens();
        const candidates = discovered.slice(0, 80);
        const accepted = [];

        for (const address of candidates) {
          try {
            const token = await exchange.getTokenData(address);
            if (!token || !token.price) continue;
            const applicable = strategy.determineApplicableStrategies({
              ...token,
              chainKey: chainName,
            });
            if (applicable.swing) {
              accepted.push(token.address || address);
            }
          } catch (err) {
            logger.debug(`Watchlist refresh token error on ${chainName}: addr=${address}, ${err.message}`);
            if (scanStatus && scanStatus[chainName]) {
              scanStatus[chainName].suppressedTokenErrors = (scanStatus[chainName].suppressedTokenErrors || 0) + 1;
              const maxSuppressed = Math.max(1, Number(config?.risk?.maxSuppressedTokenErrors || 10));
              if (scanStatus[chainName].suppressedTokenErrors === maxSuppressed) {
                logger.warn(`suppressedTokenErrors threshold reached on ${chainName} this cycle`, {
                  chain: chainName,
                  suppressedTokenErrors: scanStatus[chainName].suppressedTokenErrors,
                  threshold: maxSuppressed,
                });
              }
            }
          }
        }

        const merged = [...new Set([...(watchlists[chainName] || []), ...accepted])].slice(0, perChainLimit);
        watchlists[chainName] = merged;
        logger.info(`Swing watchlist ${chainName}: ${watchlists[chainName].length} tokens after refresh`);
      }));
    } catch (error) {
      logger.error(`Swing watchlist refresh failed: ${error.message}`);
    } finally {
      loopLocks.swingRefresh = false;
    }
  };
}

async function runSqlAutoPrune(log) {
  const { getPool } = require('../utils/sqlServer');
  const sql = require('mssql');
  const pool = await getPool(log).catch(() => null);
  if (!pool) return;
  // Format: [table, hours, tsColumn]
  const PRUNE = [
    ['dbo.signals',                12,        'ts'],
    ['dbo.model_predictions',      24,        'ts'],
    ['dbo.model_feature_store',    24,        'ts'],
    ['dbo.multi_agent_decisions',  24,        'ts'],
    ['dbo.sentiment_snapshots',    24,        'ts'],
    ['dbo.bot_state_snapshots',    48,        'ts'],
    ['dbo.decision_log',           72,        'ts'],
    // Week 11.7a — 30d retention sweeps
    ['dbo.trade_rejections',       720,       'rejected_at'],   // 30d
    ['dbo.ai_decisions',           720,       'decided_at'],    // 30d
    ['dbo.health_checks',          720,       'ts'],            // 30d
  ];
  let totalDeleted = 0;
  for (const [table, hours, tsCol] of PRUNE) {
    try {
      let batch;
      let deleted = 0;
      do {
        const req = new sql.Request(pool);
        req.input('hours', sql.Int, hours);
        batch = await req.query(`DELETE TOP (5000) FROM ${table} WHERE ${tsCol} < DATEADD(hour, -@hours, SYSUTCDATETIME())`);
        deleted += batch.rowsAffected[0] || 0;
      } while ((batch.rowsAffected[0] || 0) > 0);
      if (deleted > 0) {
        totalDeleted += deleted;
        log.info(`[SQL prune] ${table}: removed ${deleted} rows older than ${hours}h`);
      }
    } catch (err) {
      log.debug(`[SQL prune] ${table} skipped: ${err.message}`);
    }
  }
  if (totalDeleted > 0) {
    log.info(`[SQL prune] cycle complete, total ${totalDeleted} rows deleted`);
  }
  return totalDeleted;
}

module.exports = {
  createEvictStuckPositions,
  createRefreshSwingWatchlists,
  runSqlAutoPrune,
};
