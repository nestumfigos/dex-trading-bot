'use strict';

/**
 * Reconciliation cycle — pure module, dep-injected.
 *
 * Two reconcilers:
 *   - reconcileExecutionJournal — polls EVM (BSC + Base) confirmed txs to
 *     finality; flags reorg/dropped state and sets balanceDriftHalt if a
 *     receipt disappears after the confirmation window.
 *   - reconcileWalletPositions — walks each exchange's wallet positions,
 *     reconciles vs portfolio.positions, repairs stale price/qty/cost on
 *     tracked positions, auto-adopts unmanaged wallet positions (KuCoin by
 *     default), prunes dust + state-only positions (esp KuCoin manual drift),
 *     and clears stale stuckPositions flags.
 *
 * reconcileWalletPositions writes:
 *   portfolio.positions (mutations + deletions)
 *   portfolio.strategies[s].positions (mirror)
 *   portfolio.stuckPositions (cleanup)
 *   portfolio.stateReconciliation = { lastRunAt, discrepancies }
 *   portfolio.untrackedWalletPositions
 *   portfolio.untrackedWalletPositionValueUsdByChain
 *   portfolio.untrackedWalletPositionValueUsd
 *   marketState.trackedTokens[*].hasOpenPosition
 *
 * Env knobs:
 *   RECONCILE_ADOPT_UNMANAGED          (default 'true')  global adoption switch
 *   RECONCILE_ADOPT_UNMANAGED_DEX      (default 'false') include DEX chains
 *   RECONCILE_ADOPT_MIN_VALUE_USD      (default '5')     adoption minimum
 *
 * Usage:
 *   const { create } = require('./cycle/reconciliation');
 *   const recon = create({
 *     portfolio, exchanges, marketState, config, logger,
 *     normalizeChainKey, buildTokenKey,
 *     findRecoverableKucoinBuyFill, restoreKucoinRecoveredBuy,
 *     releaseLiquiditySentinel, strategy,
 *     setExecutionJournalState,
 *     ensureStatsShape, refreshPerformanceMetrics, recordPortfolioSnapshot,
 *   });
 *   await recon.reconcileExecutionJournal();
 *   await recon.reconcileWalletPositions();
 */

function create({
  portfolio,
  exchanges,
  marketState,
  config,
  logger,
  normalizeChainKey,
  buildTokenKey,
  findRecoverableKucoinBuyFill,
  restoreKucoinRecoveredBuy,
  releaseLiquiditySentinel,
  strategy,
  setExecutionJournalState,
  ensureStatsShape,
  refreshPerformanceMetrics,
  recordPortfolioSnapshot,
} = {}) {
  if (!portfolio) throw new Error('reconciliation.create: portfolio required');
  if (!exchanges) throw new Error('reconciliation.create: exchanges required');
  if (typeof normalizeChainKey !== 'function') throw new Error('reconciliation.create: normalizeChainKey required');
  if (typeof setExecutionJournalState !== 'function') throw new Error('reconciliation.create: setExecutionJournalState required');

  async function reconcileExecutionJournal() {
    const journal = portfolio.executionJournal || {};
    const entries = Object.values(journal).filter((row) => row && row.status === 'confirmed');
    if (!entries.length) return;

    for (const entry of entries) {
      const chain = normalizeChainKey(entry.chainKey || entry.chain);
      if (chain !== 'bsc' && chain !== 'base') continue;
      const provider = exchanges?.[chain]?.provider;
      if (!provider) continue;

      try {
        const receipt = await provider.getTransactionReceipt(entry.txid);
        if (!receipt) {
          const ageMs = Date.now() - Date.parse(entry.updatedAt || entry.createdAt || '');
          if (Number.isFinite(ageMs) && ageMs > 10 * 60 * 1000) {
            setExecutionJournalState(entry.txid, {
              status: 'reorg_or_dropped',
              reason: 'receipt not found after confirmation window',
            });
            logger.error('Execution journal detected potential reorg/dropped tx', {
              txid: entry.txid,
              chain,
              reason: 'receipt not found after confirmation window',
            });
            portfolio.balanceDriftHalt = true;
          }
          continue;
        }

        const currentBlock = await provider.getBlockNumber();
        const blockNumber = Number(receipt.blockNumber || entry.blockNumber || 0);
        if (!Number.isFinite(blockNumber) || blockNumber <= 0) continue;
        const confirmations = Math.max(0, currentBlock - blockNumber + 1);
        const required = Math.max(1, Number(entry.requiredConfirmations || 2));
        setExecutionJournalState(entry.txid, { blockNumber, confirmations });

        if (confirmations >= required) {
          setExecutionJournalState(entry.txid, {
            status: 'finalized',
            finalizedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        logger.debug(`Execution journal reconciliation error (${chain} ${entry.txid}): ${error.message}`);
      }
    }
  }

  async function reconcileWalletPositions() {
    if (!config) throw new Error('reconcileWalletPositions: config required');
    if (typeof buildTokenKey !== 'function') throw new Error('reconcileWalletPositions: buildTokenKey required');

    const discrepancies = [];
    const untrackedWalletPositions = [];
    const untrackedWalletPositionValueUsdByChain = {};
    const dustThresholdUsd = Math.max(0, Number(config.risk?.reconciliationDustUsd || 5));
    let prunedStateOnlyPositions = 0;
    let recoveredWalletBuys = 0;
    let clearedStuckPositions = 0;

    await Promise.allSettled(Object.entries(exchanges).map(async ([chainName, exchange]) => {
      if (!exchange || typeof exchange.getWalletPositions !== 'function') {
        return;
      }

      let walletPositions = [];
      try {
        walletPositions = await exchange.getWalletPositions(dustThresholdUsd);
      } catch (error) {
        const fetchFailure = {
          chain: chainName,
          type: 'wallet_position_fetch_failed',
          details: error.message,
        };
        discrepancies.push(fetchFailure);
        logger.error('State reconciliation mismatch', {
          reason: 'unrecovered position detected',
          ...fetchFailure,
        });
        return;
      }

      const stateKeys = new Set(
        Object.entries(portfolio.positions || {})
          .filter(([, position]) => normalizeChainKey(position?.chainKey || position?.chain) === chainName)
          .map(([positionKey]) => positionKey)
      );

      const walletPositionByKey = new Map(
        (Array.isArray(walletPositions) ? walletPositions : [])
          .map((position) => [buildTokenKey(chainName, position?.address || position?.symbol || ''), position])
          .filter(([key]) => !key.endsWith(':'))
      );
      const walletKeys = new Set(walletPositionByKey.keys());

      // Refresh price/value on already-tracked positions whose state may have stale data
      // (e.g. positions that were adopted with currentPrice=0 because the ticker lookup
      // failed at that moment). Without this, the dashboard shows them at $0 forever.
      for (const key of walletKeys) {
        if (!stateKeys.has(key)) continue;
        const walletPos = walletPositionByKey.get(key) || {};
        const tracked = portfolio.positions?.[key];
        if (!tracked) continue;
        const livePrice = Number(walletPos.lastPrice || 0);
        const liveQty = Number(walletPos.quantity || 0);
        const liveValue = Number(walletPos.valueUsd || 0);
        if (livePrice > 0) {
          if (!Number.isFinite(Number(tracked.currentPrice)) || Number(tracked.currentPrice) <= 0) {
            tracked.currentPrice = livePrice;
          }
          if (!Number.isFinite(Number(tracked.entryPrice)) || Number(tracked.entryPrice) <= 0) {
            tracked.entryPrice = livePrice;
            tracked.highestPrice = livePrice;
            tracked.stopLoss = livePrice * (1 - Number(config.risk?.stopLossPct || 8) / 100);
            logger.warn(`[Reconciliation] Repaired ${tracked.symbol} entryPrice (was 0): now $${livePrice}`);
          }
        }
        if (liveQty > 0 && (!Number.isFinite(Number(tracked.quantity)) || Number(tracked.quantity) <= 0)) {
          tracked.quantity = liveQty;
        }
        if (liveValue > 0 && (!Number.isFinite(Number(tracked.costBasisUsd)) || Number(tracked.costBasisUsd) <= 0)) {
          tracked.costBasisUsd = liveValue;
          tracked.initialSizeUsd = tracked.initialSizeUsd || liveValue;
        }
      }

      for (const key of walletKeys) {
        if (stateKeys.has(key)) continue;
        const walletPosition = walletPositionByKey.get(key) || {};
        if (chainName === 'kucoin' && typeof findRecoverableKucoinBuyFill === 'function' && typeof restoreKucoinRecoveredBuy === 'function') {
          const recoveredFill = await findRecoverableKucoinBuyFill(exchange, walletPosition).catch(() => null);
          if (recoveredFill && (await restoreKucoinRecoveredBuy(walletPosition, recoveredFill))) {
            stateKeys.add(key);
            recoveredWalletBuys += 1;
            continue;
          }
        }
        const entry = {
          chain: chainName,
          type: 'wallet_untracked_position',
          key,
          symbol: walletPosition.symbol || null,
          address: walletPosition.address || null,
          quantity: Number(walletPosition.quantity || 0),
          valueUsd: Number(walletPosition.valueUsd || 0),
        };

        // Optional auto-adoption: turn the unmanaged wallet position into a tracked
        // position so the exit logic (stop loss, trailing, stale-drift) applies. We
        // can't recover the real entry price, so we synthesize one from current price
        // and flag the position as `adoptedFromWallet=true` for downstream visibility.
        // Enable with RECONCILE_ADOPT_UNMANAGED=true (default true on KuCoin since
        // that's where reconciliation is reliable; off for DEX chains where partial
        // wallet info can produce false adoptions).
        const adoptionEnabledGlobally = String(process.env.RECONCILE_ADOPT_UNMANAGED || 'true').toLowerCase() !== 'false';
        const adoptionEnabledForChain = chainName === 'kucoin' || String(process.env.RECONCILE_ADOPT_UNMANAGED_DEX || 'false').toLowerCase() === 'true';
        const minAdoptionValueUsd = Number(process.env.RECONCILE_ADOPT_MIN_VALUE_USD || 5);
        const valueUsd = Number(walletPosition.valueUsd || 0);
        const qty = Number(walletPosition.quantity || 0);
        // Prefer the wallet's reported lastPrice (already validated by the exchange adapter).
        // Fall back to value/qty division only as a sanity check.
        const lastPrice = Number(walletPosition.lastPrice || 0);
        const currentPrice = lastPrice > 0
          ? lastPrice
          : (qty > 0 && valueUsd > 0 ? valueUsd / qty : 0);
        let adopted = false;
        // Skip adoption when price is unknown — adopting a position with currentPrice=0
        // breaks every downstream calc (PnL, stop loss, exit thresholds).
        if (currentPrice <= 0) {
          logger.warn(`[Reconciliation] Skipping adoption of ${walletPosition.symbol}: no valid price available`);
        } else if (adoptionEnabledGlobally && adoptionEnabledForChain && qty > 0 && valueUsd >= minAdoptionValueUsd) {
          try {
            const strategyName = 'momentum';
            // PENGU pattern fix (2026-05-18): adopted positions synthesize entry=current
            // price, so any small dip after adoption trips the standard 8% stopLoss.
            // Use wider stop (default 18%) for adopted positions to give them runway
            // to recover before bot exits with synthetic loss. Override via
            // RECONCILE_ADOPT_STOP_LOSS_PCT env.
            const baseStopLossPct = Number(config.risk?.stopLossPct || 8);
            const adoptedStopLossPct = Number(process.env.RECONCILE_ADOPT_STOP_LOSS_PCT || 18);
            const stopLossPctRisk = Math.max(baseStopLossPct, adoptedStopLossPct);
            portfolio.positions[key] = {
              key,
              address: walletPosition.address || walletPosition.symbol || key,
              chain: chainName,
              chainKey: chainName,
              strategyKey: key,
              strategy: strategyName,
              symbol: walletPosition.symbol || key,
              entryPrice: currentPrice,
              currentPrice,
              quantity: qty,
              initialSizeUsd: valueUsd,
              costBasisUsd: valueUsd,
              requestedEntryUsd: valueUsd,
              filledEntryUsd: valueUsd,
              requestedEntryQuantity: qty,
              filledEntryQuantity: qty,
              entryFillDiscrepancyPct: 0,
              stopLoss: currentPrice * (1 - stopLossPctRisk / 100),
              takeProfit: currentPrice * 1.25,
              openedAt: new Date().toISOString(),
              txid: null,
              entryBlockNumber: null,
              entryConfirmations: null,
              entryPrivateRouteUsed: false,
              signalSource: 'wallet_adoption',
              triggerTimeframe: null,
              brainArchetype: 'adopted',
              brainProfileKey: null,
              discoveryLane: null,
              aiReason: 'adopted_from_wallet_reconciliation',
              aiConfidence: 0,
              patternAnalysis: null,
              pairAddress: walletPosition.pairAddress || null,
              entryLiquidityUsd: 0,
              entryTopHoldersPct: null,
              entryBuyRatioPct10m: 0,
              entryRecentWindowMinutes: null,
              entryBuyRatioRecentPct: null,
              entryHolderCount: 0,
              entryRsi: 0,
              entryVolumeSpike: 0,
              tokenAgeBucket: 'unknown',
              marketRegime: 'unknown',
              highestPrice: currentPrice,
              antiPatternInfo: { adoptedFromWallet: true },
              trailingStop: null,
              tierLocalHigh: currentPrice,
              triggeredSellTiers: {},
              tierDelayedAt: {},
              partialFillRetry: false,
              exitInProgress: false,
              realizedPnlByTier: {},
              realizedPnl: 0,
              adoptedFromWallet: true,
              adoptedAt: new Date().toISOString(),
            };
            if (!portfolio.strategies?.[strategyName]) {
              portfolio.strategies = portfolio.strategies || {};
              portfolio.strategies[strategyName] = portfolio.strategies[strategyName] || {
                positions: {},
                stats: { wins: 0, losses: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, closedTrades: 0, consecutiveLosses: 0, consecutiveWins: 0, maxConsecutiveLosses: 0 },
                trades: [],
              };
            }
            portfolio.strategies[strategyName].positions[key] = portfolio.positions[key];
            stateKeys.add(key);
            adopted = true;
            logger.warn(`[Reconciliation] Adopted unmanaged position ${entry.symbol} (${chainName}) qty=${qty.toFixed(6)} value=$${valueUsd.toFixed(2)} — now subject to stop-loss / stale-drift / strategy exits`);
          } catch (adoptErr) {
            logger.warn(`[Reconciliation] Adoption of ${entry.symbol} failed: ${adoptErr.message}`);
          }
        }

        if (adopted) {
          entry.adopted = true;
          // Adopted positions are now tracked — don't show them as "unmanaged" on the
          // dashboard or contribute to untracked totals. Keep an audit entry in discrepancies
          // so the adoption shows up in the reconciliation log, but skip the unmanaged buckets.
          discrepancies.push(entry);
          logger.warn('State reconciliation: adopted unmanaged position', { ...entry });
        } else {
          discrepancies.push(entry);
          untrackedWalletPositions.push(entry);
          untrackedWalletPositionValueUsdByChain[chainName] = Number(untrackedWalletPositionValueUsdByChain[chainName] || 0) + Number(walletPosition.valueUsd || 0);
          logger.error('State reconciliation mismatch', {
            reason: 'unrecovered position detected',
            ...entry,
          });
        }
      }

      stateKeys.forEach((key) => {
        if (walletKeys.has(key)) return;
        const stalePosition = portfolio.positions?.[key];
        const staleQty = Number(stalePosition?.quantity || 0);
        const stalePrice = Number(stalePosition?.currentPrice || stalePosition?.entryPrice || 0);
        const staleValueUsd = staleQty > 0 && stalePrice > 0
          ? staleQty * stalePrice
          : Number(stalePosition?.initialSizeUsd || stalePosition?.costBasisUsd || 0);
        const strategyName = String(stalePosition?.strategy || 'momentum').toLowerCase();

        if (stalePosition && Number.isFinite(staleValueUsd) && staleValueUsd > 0 && staleValueUsd <= dustThresholdUsd) {
          delete portfolio.positions[key];
          if (portfolio.strategies?.[strategyName]?.positions) {
            delete portfolio.strategies[strategyName].positions[key];
          }
          if (typeof releaseLiquiditySentinel === 'function') releaseLiquiditySentinel(chainName, stalePosition.pairAddress);
          if (strategy && typeof strategy.clearHistory === 'function') strategy.clearHistory(stalePosition.strategyKey || key);
          prunedStateOnlyPositions += 1;
          logger.info('Removed dust state-only position from local state', {
            chain: chainName,
            key,
            symbol: stalePosition.symbol,
            valueUsd: Number(staleValueUsd.toFixed(4)),
            dustThresholdUsd,
          });
          return;
        }

        const entry = {
          chain: chainName,
          type: 'state_only_position',
          key,
        };
        discrepancies.push(entry);
        logger.error('State reconciliation mismatch', {
          reason: 'unrecovered position detected',
          ...entry,
        });

        // KuCoin can drift when users manually trade outside the bot.
        // If an in-state KuCoin position is absent from live wallet holdings, prune it.
        if (chainName === 'kucoin') {
          if (stalePosition) {
            delete portfolio.positions[key];
            if (portfolio.strategies?.[strategyName]?.positions) {
              delete portfolio.strategies[strategyName].positions[key];
            }
            if (typeof releaseLiquiditySentinel === 'function') releaseLiquiditySentinel(chainName, stalePosition.pairAddress);
            if (strategy && typeof strategy.clearHistory === 'function') strategy.clearHistory(stalePosition.strategyKey || key);
            prunedStateOnlyPositions += 1;
            logger.warn('Removed stale KuCoin position from local state', {
              reason: 'state-only KuCoin position pruned',
              key,
              symbol: stalePosition.symbol,
              address: stalePosition.address,
            });
          }
        }
      });

      const stuckEntries = Object.entries(portfolio.stuckPositions || {})
        .filter(([, meta]) => normalizeChainKey(meta?.chainKey) === chainName);

      for (const [stuckKey, meta] of stuckEntries) {
        if (walletKeys.has(stuckKey)) continue;
        if (portfolio.positions?.[stuckKey]) continue;
        delete portfolio.stuckPositions[stuckKey];
        clearedStuckPositions += 1;
        logger.info('Cleared stale stuck-position flag after wallet reconciliation', {
          chain: chainName,
          key: stuckKey,
          symbol: meta?.symbol || null,
          address: meta?.address || null,
        });
      }

      if (marketState && marketState.trackedTokens) {
        Object.values(marketState.trackedTokens).forEach((tracked) => {
          if (normalizeChainKey(tracked?.chainKey || tracked?.chain) !== chainName) return;
          const trackedKey = buildTokenKey(chainName, tracked?.address || '');
          tracked.hasOpenPosition = Boolean(portfolio.positions?.[trackedKey]);
        });
      }
    }));

    if (prunedStateOnlyPositions > 0) {
      if (typeof ensureStatsShape === 'function') ensureStatsShape();
      if (typeof refreshPerformanceMetrics === 'function') refreshPerformanceMetrics();
      if (typeof recordPortfolioSnapshot === 'function') recordPortfolioSnapshot('reconcile_prune');
    }

    if (recoveredWalletBuys > 0) {
      if (typeof refreshPerformanceMetrics === 'function') refreshPerformanceMetrics();
      if (typeof recordPortfolioSnapshot === 'function') recordPortfolioSnapshot('reconcile_recover_buy');
    }

    if (clearedStuckPositions > 0) {
      if (typeof recordPortfolioSnapshot === 'function') recordPortfolioSnapshot('reconcile_clear_stuck');
    }

    portfolio.stateReconciliation = {
      lastRunAt: new Date().toISOString(),
      discrepancies,
    };
    portfolio.untrackedWalletPositions = untrackedWalletPositions;
    portfolio.untrackedWalletPositionValueUsdByChain = untrackedWalletPositionValueUsdByChain;
    portfolio.untrackedWalletPositionValueUsd = Object.values(untrackedWalletPositionValueUsdByChain)
      .reduce((sum, value) => sum + Number(value || 0), 0);
  }

  return { reconcileExecutionJournal, reconcileWalletPositions };
}

module.exports = { create };
