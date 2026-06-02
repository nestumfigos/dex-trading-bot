'use strict';

/**
 * Exit cycle dispatchers — pure module, dep-injected (Week 9 cycle split).
 *
 * Two cycles iterate open positions and route them through exit logic:
 *
 *   - runStrategyExitCycle(strategyName)
 *     Per-strategy (momentum / Backes). Fetches fresh token data per
 *     position, falls back to cached trackedTokens (max 10min stale) if
 *     market data unavailable, then delegates to checkExitConditions
 *     (which calls the pure decideExitAction module).
 *
 *   - runRealtimeRiskStopCycle()
 *     Cross-strategy fast safety net. Per-chain daily-loss halt enforcement
 *     first, then trailing/stop-loss check against oracle or exchange price
 *     per position. Also enforces disasterStopPct floor (default 25%) so
 *     misconfigured stopLoss never causes catastrophic loss.
 *
 * Reentrancy: each cycle guards with loopLocks[name] = true/false.
 * Lock keys: 'momentumExit', 'swingExit', 'realtimeStop'.
 *
 * Behavior preserved byte-identical from src/index.js inline versions.
 *
 * Usage:
 *   const { create } = require('./cycle/exit-pass');
 *   const exitPass = create({ ... 17 deps ... });
 *   await exitPass.runStrategyExitCycle('momentum');
 *   await exitPass.runRealtimeRiskStopCycle();
 */

function getExitLockKey(strategyName) {
  if (strategyName === 'spot_day_bull_flag') return 'bullFlagExit';
  if (strategyName === 'momentum') return 'momentumExit';
  return `${strategyName}Exit`;
}

function create({
  // state
  portfolio,
  marketState,
  loopLocks,
  loopLastCompletedAt,
  // config + risk
  config,
  risk,
  CHAIN_LABELS,
  // exchanges + helpers
  exchanges,
  isExchangeAvailable,
  // key + chain helpers
  normalizeChainKey,
  buildTokenKey,
  // tick tracking
  recordStrategyTick,
  refreshTrackedOpenPositionSnapshot,
  // exit primitives
  evictStuckPositions,
  checkExitConditions,
  executeSell,
  applyTrailingStopState,
  shouldDelayBorderlineStop,
  getOraclePriceUsdForPosition,
  withTimeout,
  // logging
  logger,
} = {}) {
  if (!portfolio) throw new Error('exit-pass.create: portfolio required');
  if (!loopLocks) throw new Error('exit-pass.create: loopLocks required');
  if (typeof checkExitConditions !== 'function') throw new Error('exit-pass.create: checkExitConditions required');
  if (typeof executeSell !== 'function') throw new Error('exit-pass.create: executeSell required');

  async function runStrategyExitCycle(strategyName) {
    const lockKey = getExitLockKey(strategyName);
    if (loopLocks[lockKey]) {
      return;
    }

    loopLocks[lockKey] = true;
    try {
      if (portfolio.safeMode) {
        return;
      }

      // Free slots held by positions that have been stuck (unsellable) for too long
      if (typeof evictStuckPositions === 'function') evictStuckPositions();

      const strategyStats = portfolio.strategies?.[strategyName]?.stats || null;
      const cycleExitStats = {
        attempted: 0,
        skipped: 0,
        errors: 0,
        completed: 0,
      };

      // Reset stale-data skip counter unconditionally so a cycle with no positions clears stale alerts.
      if (strategyStats) {
        strategyStats.skippedExitChecks = 0;
      }

      const positions = Object.values(portfolio.positions || {}).filter(
        (position) => String(position?.strategy || 'momentum') === strategyName
      );

      if (!positions.length) {
        return;
      }

      logger.info(`Running ${strategyName} exit checks for ${positions.length} open positions`);

      await Promise.allSettled(positions.map(async (position) => {
        try {
          cycleExitStats.attempted += 1;
          const chainName = normalizeChainKey(position.chainKey || position.chain);
          const exchange = exchanges[chainName];
          if (!exchange || !isExchangeAvailable(chainName)) {
            return;
          }

          let tokenData = await exchange.getTokenData(position.address).catch(() => null);
          if (!tokenData || !tokenData.price) {
            // Attempt stale-price fallback from trackedTokens (max 10-minute age)
            const tokenKey = position.strategyKey || buildTokenKey(chainName, position.address);
            const cached = marketState.trackedTokens[`${chainName}:${String(position.address || '').toLowerCase()}`];
            const cacheAgeMs = cached?.lastScannedAt ? (Date.now() - new Date(cached.lastScannedAt).getTime()) : Infinity;
            if (cached && Number.isFinite(Number(cached.price)) && Number(cached.price) > 0 && cacheAgeMs < 600000) {
              logger.warn('Exit check using stale cached price — stop-loss/trailing-stop only', {
                strategy: strategyName,
                chain: chainName,
                symbol: position.symbol || null,
                address: position.address,
                reason: 'using stale cached price for exit check',
                cacheAgeMs,
              });
              tokenData = {
                price: Number(cached.price),
                symbol: cached.symbol || position.symbol,
                address: position.address,
                chain: CHAIN_LABELS[chainName],
                chainKey: chainName,
                strategyKey: tokenKey,
                volume24h: 0,
                liquidityUsd: 0,
                _stale: true,
              };
            } else {
              logger.warn('Exit check skipped: market data unavailable', {
                strategy: strategyName,
                chain: chainName,
                symbol: position.symbol || null,
                address: position.address,
                reason: 'market data unavailable',
              });
              cycleExitStats.skipped += 1;
              if (strategyStats) {
                strategyStats.skippedExitChecks =
                  Number(strategyStats.skippedExitChecks || 0) + 1;
              }
              return;
            }
          }

          tokenData.address = tokenData.address || position.address;
          tokenData.chainKey = chainName;
          tokenData.chain = CHAIN_LABELS[chainName];
          tokenData.strategyKey = position.strategyKey || buildTokenKey(chainName, tokenData.address);

          if (typeof recordStrategyTick === 'function') {
            recordStrategyTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));
          }
          if (typeof refreshTrackedOpenPositionSnapshot === 'function') {
            refreshTrackedOpenPositionSnapshot(chainName, tokenData, position);
          }

          if (position.partialFillRetry) {
            logger.warn(`Retrying exit for partially filled position ${position.symbol || position.address} on ${chainName}`);
            await executeSell(chainName, exchange, tokenData, position, 1, 'PARTIAL_FILL_RETRY');
            return;
          }

          await checkExitConditions(chainName, exchange, tokenData, position, { staleData: Boolean(tokenData._stale) });
          cycleExitStats.completed += 1;
        } catch (error) {
          cycleExitStats.errors += 1;
          if (strategyStats) {
            strategyStats.skippedExitChecks =
              Number(strategyStats.skippedExitChecks || 0) + 1;
            strategyStats.exitErrorCount =
              Number(strategyStats.exitErrorCount || 0) + 1;
          }
          logger.error(`Exit check failed`, {
            strategy: strategyName,
            chain: position?.chainKey || position?.chain,
            symbol: position?.symbol,
            address: position?.address,
            reason: error.message,
          });
        }
      }));

      // Self-heal degradation counters after clean exit cycles.
      if (strategyStats) {
        const hadCleanCycle = cycleExitStats.errors === 0 && cycleExitStats.skipped === 0 && cycleExitStats.completed > 0;
        if (hadCleanCycle) {
          strategyStats.exitErrorCount = 0;
        } else if (cycleExitStats.errors === 0 && Number(strategyStats.exitErrorCount || 0) > 0) {
          strategyStats.exitErrorCount = Math.max(0, Number(strategyStats.exitErrorCount || 0) - 1);
        }
      }

      loopLastCompletedAt[lockKey] = Date.now();
    } catch (error) {
      logger.error(`${strategyName} exit cycle failed: ${error.message}`);
    } finally {
      loopLocks[lockKey] = false;
    }
  }

  async function runRealtimeRiskStopCycle() {
    if (loopLocks.realtimeStop) {
      return;
    }

    loopLocks.realtimeStop = true;
    try {
      if (config.risk?.realtimeStopLossEnabled === false) {
        return;
      }

      const positions = Object.values(portfolio.positions || {});
      if (!positions.length) {
        loopLastCompletedAt.realtimeStop = Date.now();
        return;
      }

      const chainsInBook = [...new Set(positions.map((p) => normalizeChainKey(p.chainKey || p.chain)))];
      for (const chainName of chainsInBook) {
        const chainRisk = risk.checkPerChainDailyLoss(chainName);
        if (!chainRisk.allowed) {
          logger.warn(`CHAIN DAILY LOSS HALT on ${chainName}: ${chainRisk.reason}`);
          const chainPositions = positions.filter((p) => normalizeChainKey(p.chainKey || p.chain) === chainName);
          for (const position of chainPositions) {
            if (position.exitInProgress) continue;
            const exchange = exchanges[chainName];
            if (!exchange || !isExchangeAvailable(chainName)) continue;
            const fallbackToken = {
              address: position.address,
              symbol: position.symbol,
              chainKey: chainName,
              chain: CHAIN_LABELS[chainName],
              strategyKey: position.strategyKey || buildTokenKey(chainName, position.address),
              price: Number(position.currentPrice || position.entryPrice || 0),
              volume24h: 0,
            };
            await executeSell(chainName, exchange, fallbackToken, position, 1, 'CHAIN_DAILY_LOSS_HALT');
          }
        }
      }

      const fetchTimeoutMs = Math.max(1000, Number(config.risk?.realtimeStopFetchTimeoutMs || 6000));

      await Promise.allSettled(positions.map(async (position) => {
        try {
          if (!position || position.exitInProgress) {
            return;
          }

          const chainName = normalizeChainKey(position.chainKey || position.chain);
          const exchange = exchanges[chainName];
          if (!exchange || !isExchangeAvailable(chainName)) {
            return;
          }

          const oraclePriceUsd = typeof getOraclePriceUsdForPosition === 'function'
            ? await getOraclePriceUsdForPosition(position, chainName).catch(() => null)
            : null;
          let tokenData = null;

          if (Number.isFinite(Number(oraclePriceUsd)) && Number(oraclePriceUsd) > 0) {
            tokenData = {
              address: position.address,
              symbol: position.symbol,
              chainKey: chainName,
              chain: CHAIN_LABELS[chainName],
              strategyKey: position.strategyKey || buildTokenKey(chainName, position.address),
              price: Number(oraclePriceUsd),
              volume24h: 0,
              _oracle: true,
            };
          } else {
            tokenData = await withTimeout(
              exchange.getTokenData(position.address),
              fetchTimeoutMs,
              `Realtime stop price fetch timed out for ${position.address}`
            ).catch(() => null);

            if (!tokenData || !Number.isFinite(Number(tokenData.price)) || Number(tokenData.price) <= 0) {
              return;
            }

            tokenData.address = tokenData.address || position.address;
            tokenData.chainKey = chainName;
            tokenData.chain = CHAIN_LABELS[chainName];
            tokenData.strategyKey = position.strategyKey || buildTokenKey(chainName, tokenData.address);
          }

          if (typeof recordStrategyTick === 'function') {
            recordStrategyTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));
          }

          const strategyName = position.strategy || 'momentum';
          const strategyCfg = config.strategies?.[strategyName] || {};
          const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
          const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
          applyTrailingStopState(position, tokenData.price, trailingStartMultiplier, trailingStopPct);

          if (position.trailingStop && tokenData.price <= position.trailingStop) {
            if (shouldDelayBorderlineStop(position, tokenData.price, position.trailingStop, tokenData._oracle ? 'ORACLE_TRAILING_STOP' : 'FAST_TRAILING_STOP')) {
              return;
            }
            logger.warn(`FAST TRAILING STOP triggered for ${tokenData.symbol}: price ${Number(tokenData.price).toFixed(8)} <= stop ${Number(position.trailingStop).toFixed(8)}${tokenData._oracle ? ' (oracle)' : ''}`);
            await executeSell(chainName, exchange, tokenData, position, 1, tokenData._oracle ? 'ORACLE_TRAILING_STOP' : 'FAST_TRAILING_STOP');
            return;
          }

          if (tokenData.price <= position.stopLoss) {
            // PENGU pattern fix (2026-05-18): suppress FAST_STOP_LOSS for first
            // RECONCILE_ADOPT_STOP_GRACE_HOURS hours on adopted positions. Adoption
            // synthesizes entry=current price; any small adverse move instantly
            // trips stop. Grace period lets price find true direction first.
            // Default 4h; disable via RECONCILE_ADOPT_STOP_GRACE_HOURS=0.
            if (position.adoptedFromWallet) {
              const graceHours = Number(process.env.RECONCILE_ADOPT_STOP_GRACE_HOURS || 4);
              if (graceHours > 0) {
                const adoptedAtMs = Date.parse(position.adoptedAt || position.openedAt || '') || 0;
                const ageHours = adoptedAtMs > 0 ? (Date.now() - adoptedAtMs) / 3_600_000 : Infinity;
                if (ageHours < graceHours) {
                  logger.info(`[AdoptGrace] suppressing FAST_STOP_LOSS for ${tokenData.symbol} (age ${ageHours.toFixed(2)}h < ${graceHours}h grace)`);
                  return;
                }
              }
            }
            if (shouldDelayBorderlineStop(position, tokenData.price, position.stopLoss, tokenData._oracle ? 'ORACLE_STOP_LOSS' : 'FAST_STOP_LOSS')) {
              return;
            }
            logger.warn(`FAST STOP LOSS triggered for ${tokenData.symbol}: price ${Number(tokenData.price).toFixed(8)} <= stop ${Number(position.stopLoss).toFixed(8)}${tokenData._oracle ? ' (oracle)' : ''}`);
            await executeSell(chainName, exchange, tokenData, position, 1, tokenData._oracle ? 'ORACLE_STOP_LOSS' : 'FAST_STOP_LOSS');
            return;
          }

          // Disaster-floor safety net: if a position drops more than disasterStopPct from entry,
          // exit immediately even if the configured stopLoss is misconfigured/missing.
          // This prevents catastrophic losses when stopLoss never gets set or is set wrong.
          const disasterStopPct = Number(config.risk?.disasterStopPct || 25);
          const entryPrice = Number(position.entryPrice || 0);
          if (entryPrice > 0 && tokenData.price > 0) {
            const lossPct = ((entryPrice - tokenData.price) / entryPrice) * 100;
            if (lossPct >= disasterStopPct) {
              logger.warn(`DISASTER STOP triggered for ${tokenData.symbol}: down ${lossPct.toFixed(2)}% from entry (>= ${disasterStopPct}%)`);
              await executeSell(chainName, exchange, tokenData, position, 1, 'DISASTER_STOP');
            }
          }
        } catch (error) {
          logger.debug(`Realtime stop check error: ${error.message}`);
        }
      }));

      loopLastCompletedAt.realtimeStop = Date.now();
    } catch (error) {
      logger.error(`Realtime stop cycle failed: ${error.message}`);
    } finally {
      loopLocks.realtimeStop = false;
    }
  }

  return { runStrategyExitCycle, runRealtimeRiskStopCycle };
}

module.exports = { create };
