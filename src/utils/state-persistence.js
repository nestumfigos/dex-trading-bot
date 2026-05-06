const fs = require('fs').promises;

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

  async function persistSqlStateSnapshot(snapshotKind = 'periodic') {
    telemetry.logStateSnapshot({
      snapshot_kind: snapshotKind,
      ts: new Date().toISOString(),
      state: buildSerializableStatePayload(),
      market_state: marketState,
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

    const result = await telemetry.syncQueryableState({
      memoryScope: 'shared',
      learning: portfolio.learning || {},
      agentMemory: agentMemory?.data || {},
      strategyBrain: portfolio.learning?.strategyBrain || {},
      intelligence: portfolio.intelligence || null,
      selfEvolutionHistory,
    });

    if (!result?.ok) {
      logger.warn(`SQL queryable state sync failed: ${result?.reason || 'unknown'}`);
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
    let sqlSaveOk = false;
    let sqlSaveError = null;
    let diskSaveError = null;
    try {
      await fs.mkdir(DATA_DIR_ABS, { recursive: true });
      recordRuntimeDelta();
      const state = buildSerializableStatePayload();
      const marketStateSerialized = JSON.stringify(marketState);
      const serialized = JSON.stringify(state);
      try {
        await persistSqlStateSnapshot('save');
        sqlSaveOk = true;
      } catch (error) {
        sqlSaveError = error;
        logger.warn(`SQL state snapshot save failed: ${error.message}`);
      }

      try {
        await fs.writeFile(STATE_TMP_PATH, serialized);
        await fs.writeFile(MARKET_STATE_TMP_PATH, marketStateSerialized);
        await fs.rename(STATE_TMP_PATH, STATE_PATH);
        await fs.rename(MARKET_STATE_TMP_PATH, MARKET_STATE_PATH);
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
      logger.info(`Bot state saved (${sqlSaveOk ? 'sql-primary' : 'disk-fallback'})`);
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
      if (marketSaved) Object.assign(marketState, marketSaved);
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
        await fs.writeFile(STATE_TMP_PATH, checkpoint);
        await fs.writeFile(MARKET_STATE_TMP_PATH, marketCheckpoint);
        await fs.rename(STATE_TMP_PATH, STATE_PATH);
        await fs.rename(MARKET_STATE_TMP_PATH, MARKET_STATE_PATH);
        await fs.copyFile(STATE_PATH, STATE_BACKUP_PATH);
        await fs.copyFile(MARKET_STATE_PATH, MARKET_STATE_BACKUP_PATH);
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
