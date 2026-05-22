const fs = require('fs').promises;
const path = require('path');

function createStatePersistence(deps = {}) {
  const {
    logger,
    telemetry,
    portfolio,
    risk,
    strategy,
    marketState,
    config,
    BOT_PROFILE,
    BOT_DATA_DIR,
    DATA_DIR_ABS,
    STATE_PATH,
    MARKET_STATE_PATH,
    STATE_BACKUP_PATH,
    MARKET_STATE_BACKUP_PATH,
    STATE_TMP_PATH,
    MARKET_STATE_TMP_PATH,
    SELF_EVOLUTION_HISTORY_PATH,
    recordRuntimeDelta,
    setStatePersistenceError,
    getStatePersistenceError,
    getSaveFailureCount,
    setSaveFailureCount,
    agentMemory,
    ensureRuntimeStateShape,
    ensureLearningStateShape,
    ensureStatsShape,
    refreshPerformanceMetrics,
    normalizeChainKey,
    buildTokenKey,
    enterSafeMode,
  } = deps;

  let saveStateTail = Promise.resolve();

  function buildUniqueTmpPath(targetPath, baseTmpPath = null) {
    const tmpBase = baseTmpPath || `${targetPath}.tmp`;
    const nonce = Math.random().toString(16).slice(2);
    return `${tmpBase}.${process.pid}.${Date.now()}.${nonce}`;
  }

  async function writeAtomic(targetPath, content, baseTmpPath = null) {
    const tmpPath = buildUniqueTmpPath(targetPath, baseTmpPath);
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, targetPath);
  }

  function enqueueStateWrite(task) {
    const run = saveStateTail.catch(() => {}).then(task);
    saveStateTail = run.catch(() => {});
    return run;
  }

  function buildSerializableStatePayload() {
    return {
      portfolio,
      riskState: {
        dailyStartBalance: Number(risk.dailyStartBalance || 0),
        dailyResetDate: String(risk.dailyResetDate || ''),
        haltedToday: Boolean(risk.haltedToday),
      },
      strategyState: {
        priceHistory: strategy.priceHistory,
        volumeHistory: strategy.volumeHistory,
      },
    };
  }

  function limitObjectEntries(source = {}, limit = 500, scoreFn = null) {
    if (!source || typeof source !== 'object') return {};
    const entries = Object.entries(source);
    const sorted = typeof scoreFn === 'function'
      ? entries.sort((left, right) => scoreFn(right[1], right[0]) - scoreFn(left[1], left[0]))
      : entries;
    return Object.fromEntries(sorted.slice(0, Math.max(0, Number(limit || 0))));
  }

  function compactHistoryMap(historyMap = {}, perKeyLimit = 240, maxKeys = 600) {
    return limitObjectEntries(historyMap, maxKeys, (value) => (Array.isArray(value) ? value.length : 0))
      && Object.fromEntries(
        Object.entries(limitObjectEntries(historyMap, maxKeys, (value) => (Array.isArray(value) ? value.length : 0)))
          .map(([key, value]) => [key, Array.isArray(value) ? value.slice(-perKeyLimit) : value])
      );
  }

  function compactArray(value, limit = 100) {
    return Array.isArray(value) ? value.slice(-Math.max(0, Number(limit || 0))) : value;
  }

  function buildSqlPortfolioPayload() {
    const learning = portfolio.learning && typeof portfolio.learning === 'object'
      ? {
          badTokenMemory: limitObjectEntries(portfolio.learning.badTokenMemory || {}, 120, (entry) => Date.parse(entry?.lastSeen || entry?.updatedAt || 0) || 0),
          adaptiveSleeves: portfolio.learning.adaptiveSleeves || {},
          brainProfiles: limitObjectEntries(portfolio.learning.brainProfiles || {}, 120, (entry) => Number(entry?.samples || 0)),
          strategyBrain: {
            profiles: limitObjectEntries(portfolio.learning.strategyBrain?.profiles || {}, 120, (entry) => Number(entry?.samples || 0)),
            adjustments: limitObjectEntries(portfolio.learning.strategyBrain?.adjustments || {}, 80, (entry) => Date.parse(entry?.updatedAt || 0) || 0),
            knownArchetypes: compactArray(portfolio.learning.strategyBrain?.knownArchetypes, 80),
            mutations: compactArray(portfolio.learning.strategyBrain?.mutations, 40),
          },
        }
      : {};
    return {
      balance: portfolio.balance,
      startingBalance: portfolio.startingBalance,
      walletBalanceUsd: portfolio.walletBalanceUsd,
      deployedCapital: portfolio.deployedCapital,
      freeCash: portfolio.freeCash,
      walletBalancesUsd: portfolio.walletBalancesUsd,
      positions: portfolio.positions,
      stats: portfolio.stats,
      runtime: portfolio.runtime,
      risk: portfolio.risk,
      safeMode: portfolio.safeMode,
      balanceDrift: portfolio.balanceDrift,
      balanceDriftHalt: portfolio.balanceDriftHalt,
      statePersistenceError: portfolio.statePersistenceError,
      stateReconciliation: portfolio.stateReconciliation,
      trades: compactArray(portfolio.trades, Number(process.env.SQL_STATE_TRADE_LIMIT || 80)),
      recentTrades: compactArray(portfolio.recentTrades, Number(process.env.SQL_STATE_RECENT_TRADE_LIMIT || 80)),
      pnlHistory: compactArray(portfolio.pnlHistory, Number(process.env.SQL_STATE_PNL_HISTORY_LIMIT || 200)),
      executionJournal: compactArray(portfolio.executionJournal, Number(process.env.SQL_STATE_EXECUTION_JOURNAL_LIMIT || 80)),
      strategies: {},
      learning,
      intelligence: portfolio.intelligence
        ? {
            lastRunAt: portfolio.intelligence.lastRunAt,
            runCount: portfolio.intelligence.runCount,
            report: portfolio.intelligence.report
              ? {
                  macroSentiment: portfolio.intelligence.report.macroSentiment,
                  sentimentScore: portfolio.intelligence.report.sentimentScore,
                  summary: portfolio.intelligence.report.summary,
                }
              : null,
          }
        : null,
      _sqlCompact: true,
      _fullPortfolioOnDisk: true,
    };
  }

  function buildSqlStatePayload() {
    const fullState = buildSerializableStatePayload();
    const historyLimit = Math.max(10, Number(process.env.SQL_STATE_HISTORY_PER_KEY_LIMIT || 30));
    const historyKeyLimit = Math.max(25, Number(process.env.SQL_STATE_HISTORY_KEY_LIMIT || 120));
    return {
      ...fullState,
      portfolio: buildSqlPortfolioPayload(),
      strategyState: {
        priceHistory: compactHistoryMap(strategy.priceHistory, historyLimit, historyKeyLimit),
        volumeHistory: compactHistoryMap(strategy.volumeHistory, historyLimit, historyKeyLimit),
      },
    };
  }

  function buildSqlMarketStatePayload() {
    const trackedLimit = Math.max(25, Number(process.env.SQL_MARKET_STATE_TRACKED_TOKEN_LIMIT || 100));
    const trackedTokens = limitObjectEntries(marketState.trackedTokens || {}, trackedLimit, (entry) => {
      const lastSeen = Date.parse(entry?.lastScannedAt || entry?.updatedAt || entry?.timestamp || 0) || 0;
      const openBonus = entry?.hasOpenPosition ? 10_000_000_000_000 : 0;
      const buyBonus = String(entry?.finalSignal || '').toUpperCase() === 'BUY' ? 1_000_000_000_000 : 0;
      return openBonus + buyBonus + lastSeen;
    });
    return {
      ...marketState,
      trackedTokens,
      _sqlCompact: true,
      _fullMarketStateOnDisk: true,
      _trackedTokenCountOriginal: Object.keys(marketState.trackedTokens || {}).length,
      _trackedTokenCountStored: Object.keys(trackedTokens).length,
    };
  }

  async function persistSqlStateSnapshot(snapshotKind = 'periodic') {
    telemetry.logStateSnapshot({
      snapshot_kind: snapshotKind,
      ts: new Date().toISOString(),
      state: buildSqlStatePayload(),
      market_state: buildSqlMarketStatePayload(),
      stats: {
        profile: BOT_PROFILE,
        paperTrading: Boolean(config.paperTrading),
        saveFailureCount: Number(portfolio.saveFailureCount || getSaveFailureCount() || 0),
        statePersistenceError: Boolean(getStatePersistenceError() || portfolio.statePersistenceError),
      },
    });
    await telemetry.flush();
  }

  async function loadSelfEvolutionHistoryEntries(limit = 250) {
    try {
      const raw = await fs.readFile(SELF_EVOLUTION_HISTORY_PATH, 'utf8');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-Math.max(1, Number(limit || 250)))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      logger.warn(`Self-evolution history load for SQL sync failed: ${error.message}`);
      return [];
    }
  }

  async function syncQueryableSqlState() {
    if (String(process.env.SQL_ENABLED || '').toLowerCase() !== 'true') {
      return { ok: false, reason: 'sql_disabled' };
    }

    const selfEvolutionHistory = await loadSelfEvolutionHistoryEntries(
      Math.max(50, Number(process.env.SQL_SELF_EVOLUTION_HISTORY_LIMIT || 250))
    );

    const payload = {
      memoryScope: 'shared',
      learning: portfolio.learning || {},
      agentMemory: agentMemory?.data || {},
      strategyBrain: portfolio.learning?.strategyBrain || {},
      intelligence: portfolio.intelligence || null,
      selfEvolutionHistory,
    };

    const result = await telemetry.syncQueryableState(payload);

    if (!result?.ok) {
      logger.warn(`SQL queryable state sync failed: ${result?.reason || 'unknown'}`);
    }

    if (process.env.LEARNING_DISK_BACKUP_ENABLED !== 'false') {
      try {
        const backupPath = path.join(DATA_DIR_ABS, 'learning-backup.json');
        const tmpPath = `${backupPath}.tmp`;
        const compactPayload = JSON.stringify({
          ts: new Date().toISOString(),
          learning: payload.learning,
          agentMemory: payload.agentMemory,
          strategyBrain: payload.strategyBrain,
        });
        await fs.writeFile(tmpPath, compactPayload, 'utf8');
        await fs.rename(tmpPath, backupPath);
      } catch (err) {
        logger.debug(`[Backup] learning disk backup failed: ${err.message}`);
      }
    }

    return result;
  }

  async function tryLoadStateFromSqlSnapshot() {
    if (String(process.env.SQL_STATE_RESTORE_ENABLED || 'true').toLowerCase() === 'false') {
      return { ok: false, reason: 'sql_state_restore_disabled' };
    }
    try {
      const latest = await telemetry.getLatestStateSnapshot();
      if (!latest?.ok || !latest?.found || !latest.state || typeof latest.state !== 'object') {
        return { ok: false, reason: latest?.reason || 'not_found' };
      }
      return {
        ok: true,
        source: 'sql_snapshot',
        saved: latest.state,
        marketSaved: latest.marketState && typeof latest.marketState === 'object' ? latest.marketState : {},
        snapshotTs: latest.ts || null,
        snapshotKind: latest.snapshotKind || null,
      };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  async function saveState() {
    return enqueueStateWrite(async () => {
      let sqlSaveOk = false;
      let sqlSaveError = null;
      let diskSaveError = null;
      try {
        await fs.mkdir(DATA_DIR_ABS, { recursive: true });
        recordRuntimeDelta();
        const state = buildSerializableStatePayload();
        const marketStateSerialized = JSON.stringify(marketState);
        const serialized = JSON.stringify(state);
        if (String(process.env.SQL_ENABLED || '').toLowerCase() === 'true' && typeof telemetry?.isEnabled === 'function' && telemetry.isEnabled()) {
          try {
            await persistSqlStateSnapshot('save');
            sqlSaveOk = true;
          } catch (error) {
            sqlSaveError = error;
            logger.warn(`SQL state snapshot save failed: ${error.message}`);
          }
        }

        try {
          await writeAtomic(STATE_PATH, serialized, STATE_TMP_PATH);
          await writeAtomic(MARKET_STATE_PATH, marketStateSerialized, MARKET_STATE_TMP_PATH);
          await fs.copyFile(STATE_PATH, STATE_BACKUP_PATH);
          await fs.copyFile(MARKET_STATE_PATH, MARKET_STATE_BACKUP_PATH);
        } catch (error) {
          diskSaveError = error;
          logger.warn(`Disk state backup save failed: ${error.message}`);
        }

        if (!sqlSaveOk && diskSaveError) {
          throw sqlSaveError || diskSaveError;
        }

        setSaveFailureCount(0);
        portfolio.saveFailureCount = 0;
        setStatePersistenceError(false);
        logger.info(`Bot state saved (${sqlSaveOk ? 'sql-primary' : 'disk-primary'})`);
      } catch (error) {
        const nextFailureCount = Number(getSaveFailureCount() || 0) + 1;
        setSaveFailureCount(nextFailureCount);
        portfolio.saveFailureCount = nextFailureCount;
        setStatePersistenceError(true);
        logger.error('Failed to save state', {
          reason: error.message,
          statePersistenceError: getStatePersistenceError(),
          saveFailureCount: nextFailureCount,
        });
      }
    });
  }

  async function loadState() {
    try {
      let saved = null;
      let marketSaved = null;
      let restoreSource = 'disk';
      const sqlPreferred = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
      let restoredFromSql = null;
      let primaryError = null;
      let backupError = null;
      let marketPrimaryError = null;
      let marketBackupError = null;

      if (sqlPreferred) {
        restoredFromSql = await tryLoadStateFromSqlSnapshot();
        if (restoredFromSql.ok) {
          saved = restoredFromSql.saved;
          marketSaved = restoredFromSql.marketSaved;
          restoreSource = 'sql_snapshot';
          logger.info('Loaded runtime state from SQL snapshot', {
            source: 'dbo.bot_state_snapshots',
            snapshotKind: restoredFromSql.snapshotKind,
            snapshotTs: restoredFromSql.snapshotTs,
          });
        } else if (!['not_found', 'sql_disabled', 'sql_state_restore_disabled'].includes(restoredFromSql.reason)) {
          logger.warn('SQL state snapshot load failed; falling back to disk', {
            reason: restoredFromSql.reason,
          });
        }
      }

      if (!saved) {
        try {
          const data = await fs.readFile(STATE_PATH, 'utf8');
          saved = JSON.parse(data);
          restoreSource = 'disk_primary';
          logger.warn('Recovered runtime state from primary disk file', {
            source: STATE_PATH,
            reason: restoredFromSql?.reason || 'sql_unavailable',
          });
        } catch (error) {
          primaryError = error;
          const primaryMissing = primaryError?.code === 'ENOENT';
          if (!primaryMissing) {
            logger.error('Primary state load failed', {
              reason: primaryError.message,
              source: STATE_PATH,
            });
          }

          try {
            const backupData = await fs.readFile(STATE_BACKUP_PATH, 'utf8');
            saved = JSON.parse(backupData);
            restoreSource = 'disk_backup';
            logger.warn('Recovered runtime state from backup state file', {
              source: STATE_BACKUP_PATH,
              reason: primaryError.message,
            });
          } catch (error2) {
            backupError = error2;
            const backupMissing = backupError?.code === 'ENOENT';
            if (primaryMissing && backupMissing && !sqlPreferred) {
              restoredFromSql = await tryLoadStateFromSqlSnapshot();
              if (restoredFromSql.ok) {
                saved = restoredFromSql.saved;
                marketSaved = restoredFromSql.marketSaved;
                restoreSource = 'sql_snapshot_fallback';
                logger.warn('Recovered runtime state from SQL snapshot', {
                  source: 'dbo.bot_state_snapshots',
                  snapshotKind: restoredFromSql.snapshotKind,
                  snapshotTs: restoredFromSql.snapshotTs,
                });
              }
            }
            if (!saved) {
              logger.error('state unrecoverable', {
                reason: 'state unrecoverable',
                primaryError: primaryError.message,
                backupError: backupError.message,
                sqlFallbackError: restoredFromSql?.reason || null,
              });
              await enterSafeMode('state unrecoverable');
              return;
            }
          }
        }
      }

      if (!marketSaved) {
        try {
          const marketData = await fs.readFile(MARKET_STATE_PATH, 'utf8');
          marketSaved = JSON.parse(marketData);
        } catch (error) {
          marketPrimaryError = error;
          const marketMissing = marketPrimaryError?.code === 'ENOENT';
          if (!marketMissing) {
            logger.error('Market state load failed', {
              reason: marketPrimaryError.message,
              source: MARKET_STATE_PATH,
            });
          }

          try {
            const marketBackupData = await fs.readFile(MARKET_STATE_BACKUP_PATH, 'utf8');
            marketSaved = JSON.parse(marketBackupData);
            logger.warn('Recovered market state from backup', {
              source: MARKET_STATE_BACKUP_PATH,
              reason: marketPrimaryError.message,
            });
          } catch (error2) {
            marketBackupError = error2;
            const sqlMarketFallback = sqlPreferred ? restoredFromSql : await tryLoadStateFromSqlSnapshot();
            if (sqlMarketFallback?.ok && sqlMarketFallback.marketSaved) {
              marketSaved = sqlMarketFallback.marketSaved;
              logger.warn('Recovered market state from SQL snapshot', {
                source: 'dbo.bot_state_snapshots',
                snapshotKind: sqlMarketFallback.snapshotKind,
                snapshotTs: sqlMarketFallback.snapshotTs,
                reason: marketBackupError.message,
              });
            } else {
              logger.warn('Market state not available, will regenerate', {
                reason: marketBackupError.message,
                sqlFallbackError: sqlMarketFallback?.reason || null,
              });
              marketSaved = {};
            }
          }
        }
      }

      if (!saved || typeof saved !== 'object') {
        throw new Error('Loaded state payload is invalid');
      }

      if (saved.portfolio) Object.assign(portfolio, saved.portfolio);
      if (config?.paperTrading) {
        portfolio.walletBalanceUsd = null;
        portfolio.walletBalancesUsd = {
          solana: null,
          bsc: null,
          base: null,
          kucoin: null,
        };
        portfolio.balanceCoverageCount = null;
        portfolio.balanceDrift = { amountUsd: 0, pct: 0 };
        portfolio.balanceDriftHalt = false;
      }
      if (marketSaved) Object.assign(marketState, marketSaved);

      // Restore queryable learning state from SQL (agent memory, brain profiles, mutations).
      if (sqlPreferred && typeof telemetry?.loadQueryableState === 'function') {
        try {
          const queryable = await telemetry.loadQueryableState({ memoryScope: 'shared' });
          if (queryable?.ok) {
            if (agentMemory && agentMemory.data && queryable.agentMemory) {
              const am = queryable.agentMemory;
              if (Array.isArray(am.tradeLessons) && am.tradeLessons.length) agentMemory.data.tradeLessons = am.tradeLessons;
              if (Array.isArray(am.strategyDiscoveries) && am.strategyDiscoveries.length) agentMemory.data.strategyDiscoveries = am.strategyDiscoveries;
              if (am.tokenBlacklist && Object.keys(am.tokenBlacklist).length) agentMemory.data.tokenBlacklist = am.tokenBlacklist;
              if (am.tokenPreferences && Object.keys(am.tokenPreferences).length) agentMemory.data.tokenPreferences = am.tokenPreferences;
              if (Array.isArray(am.knowledgeBase) && am.knowledgeBase.length) agentMemory.data.knowledgeBase = am.knowledgeBase;
              if (Array.isArray(am.evolutionOutcomes) && am.evolutionOutcomes.length) agentMemory.data.evolutionOutcomes = am.evolutionOutcomes;
            }
            if (queryable.learning) {
              portfolio.learning = portfolio.learning || {};
              const ql = queryable.learning;
              if (ql.badTokenMemory && Object.keys(ql.badTokenMemory).length) portfolio.learning.badTokenMemory = { ...(portfolio.learning.badTokenMemory || {}), ...ql.badTokenMemory };
              if (ql.sleevePerformance && Object.keys(ql.sleevePerformance).length) portfolio.learning.sleevePerformance = { ...(portfolio.learning.sleevePerformance || {}), ...ql.sleevePerformance };
              if (ql.brainProfiles && Object.keys(ql.brainProfiles).length) portfolio.learning.brainProfiles = { ...(portfolio.learning.brainProfiles || {}), ...ql.brainProfiles };
              if (ql.strategyBrain) {
                portfolio.learning.strategyBrain = portfolio.learning.strategyBrain || {};
                const sb = ql.strategyBrain;
                if (sb.profiles && Object.keys(sb.profiles).length) portfolio.learning.strategyBrain.profiles = { ...(portfolio.learning.strategyBrain.profiles || {}), ...sb.profiles };
                if (sb.adjustments && Object.keys(sb.adjustments).length) portfolio.learning.strategyBrain.adjustments = { ...(portfolio.learning.strategyBrain.adjustments || {}), ...sb.adjustments };
                if (Array.isArray(sb.mutations) && sb.mutations.length) portfolio.learning.strategyBrain.mutations = sb.mutations;
                if (Array.isArray(sb.knownArchetypes) && sb.knownArchetypes.length) portfolio.learning.strategyBrain.knownArchetypes = sb.knownArchetypes;
              }
            }
            const lessons = queryable.agentMemory?.tradeLessons?.length || 0;
            const sbProfiles = Object.keys(queryable.learning?.strategyBrain?.profiles || {}).length;
            logger.info(`[Restore] Loaded learning from SQL: ${lessons} lessons, ${sbProfiles} brain profiles`);
          }
        } catch (err) {
          logger.warn(`[Restore] loadQueryableState threw: ${err.message}`);
        }
      }

      if (!marketState.evolution || typeof marketState.evolution !== 'object') {
        marketState.evolution = {
          activeExperiment: null,
          history: [],
          lastPromotion: null,
          lastRollback: null,
        };
      }
      if (marketState.trackedTokens && typeof marketState.trackedTokens === 'object') {
        for (const key of Object.keys(marketState.trackedTokens)) {
          const entry = marketState.trackedTokens[key];
          if (entry && entry.finalSignal === 'INSUFFICIENT DATA') {
            delete marketState.trackedTokens[key];
          }
        }
      }
      if (saved.riskState && typeof saved.riskState === 'object') {
        if (Number.isFinite(Number(saved.riskState.dailyStartBalance)) && Number(saved.riskState.dailyStartBalance) > 0) {
          risk.dailyStartBalance = Number(saved.riskState.dailyStartBalance);
        }
        if (typeof saved.riskState.dailyResetDate === 'string' && saved.riskState.dailyResetDate) {
          risk.dailyResetDate = saved.riskState.dailyResetDate;
        }
        if (typeof saved.riskState.haltedToday === 'boolean') {
          risk.haltedToday = saved.riskState.haltedToday;
        }
      }
      ensureRuntimeStateShape();
      ensureLearningStateShape();
      portfolio.runtime.lastTickMs = Date.now();
      if (saved.strategyState?.priceHistory && typeof saved.strategyState.priceHistory === 'object') {
        strategy.priceHistory = saved.strategyState.priceHistory;
      }
      if (saved.strategyState?.volumeHistory && typeof saved.strategyState.volumeHistory === 'object') {
        strategy.volumeHistory = saved.strategyState.volumeHistory;
      }

      if (portfolio.positions && typeof portfolio.positions === 'object') {
        const migrated = {};
        Object.entries(portfolio.positions).forEach(([key, pos]) => {
          const chainKey = pos?.chainKey || normalizeChainKey(pos?.chain);
          const address = pos?.address || key;
          const nextKey = key.includes(':') ? key : buildTokenKey(chainKey, address);
          migrated[nextKey] = {
            ...pos,
            key: nextKey,
            chainKey,
            address,
            strategyKey: pos?.strategyKey || nextKey,
            strategy: pos?.strategy || 'momentum',
          };
        });
        portfolio.positions = migrated;
      }

      ensureStatsShape();
      refreshPerformanceMetrics();
      setStatePersistenceError(false);

      try {
        await enqueueStateWrite(async () => {
          const checkpoint = JSON.stringify({
            portfolio,
            marketState,
            riskState: {
              dailyStartBalance: Number(risk.dailyStartBalance || 0),
              haltedToday: Boolean(risk.haltedToday),
            },
            strategyState: {
              priceHistory: strategy.priceHistory,
              volumeHistory: strategy.volumeHistory,
            },
          });
          const marketCheckpoint = JSON.stringify(marketState);
          await writeAtomic(STATE_PATH, checkpoint, STATE_TMP_PATH);
          await writeAtomic(MARKET_STATE_PATH, marketCheckpoint, MARKET_STATE_TMP_PATH);
          await fs.copyFile(STATE_PATH, STATE_BACKUP_PATH);
          await fs.copyFile(MARKET_STATE_PATH, MARKET_STATE_BACKUP_PATH);
        });
      } catch (checkpointError) {
        logger.error('State checkpoint update failed after load', {
          reason: checkpointError.message,
        });
      }

      logger.info(`Bot state loaded [source=${restoreSource}, profile=${BOT_PROFILE}, dataDir=${BOT_DATA_DIR}]`);
    } catch (error) {
      logger.error('Failed to load state', { reason: error.message });
      await enterSafeMode('loadState failure');
    }
  }

  return {
    buildSerializableStatePayload,
    persistSqlStateSnapshot,
    loadSelfEvolutionHistoryEntries,
    syncQueryableSqlState,
    tryLoadStateFromSqlSnapshot,
    saveState,
    loadState,
  };
}

module.exports = { createStatePersistence };
