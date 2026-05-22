'use strict';

/**
 * Health canary scheduler — pure module, dep-injected.
 *
 * Registers a periodic canary tick (default 15min) + first run at boot+60s.
 * Also touches agent-memory.json every 10min so the memory_mtime check passes
 * when SQL is primary (save() returns early on SQL success without writing file).
 *
 * Independent of safe mode: canary must run even when bot loops are paused so
 * operators see check status regardless. See incident 2026-05-17 (stuck safeMode
 * persisted in SQL snapshot, blocked all scan loops, masked canary registration).
 *
 * Usage:
 *   const { register } = require('./cycle/canary-scheduler');
 *   const dispose = register({ logger, ctx: { ... } });
 *   // dispose() to clear intervals (tests)
 */

const fs = require('fs');
const { createWindow, createAnomalyAlerter } = require('../utils/anomaly-detector');

let _registered = false;

function register({ logger, ctx }) {
  if (_registered) return () => {};
  if (process.env.HEALTH_CANARY_ENABLED === 'false') return () => {};
  _registered = true;

  const { runHealthCanary } = require('./health-canary');
  const { getPool } = require('../utils/sqlServer');
  const memoryPath = ctx.memoryPath;
  const canaryMs = Math.max(60_000, Number(process.env.HEALTH_CANARY_INTERVAL_MS || 15 * 60_000));
  const dailyPnlWindow = createWindow(Number(process.env.DAILY_PNL_ANOMALY_WINDOW || 30));
  const dailyPnlAlerter = typeof ctx.sendHealthAlert === 'function'
    ? createAnomalyAlerter({
      sendAlert: (msg) => ctx.sendHealthAlert(msg).catch(() => {}),
      logger,
      cooldownMs: Number(process.env.DAILY_PNL_ANOMALY_COOLDOWN_MS || 60 * 60_000),
    })
    : null;

  const fireCanary = async () => {
    try {
      const ptPool = await getPool(logger).catch(() => null);
      if (dailyPnlAlerter && typeof ctx.getDailyPnlUsd === 'function') {
        const dailyPnlUsd = Number(ctx.getDailyPnlUsd());
        if (Number.isFinite(dailyPnlUsd)) {
          const anomaly = dailyPnlAlerter.check(
            'daily_pnl_usd',
            dailyPnlUsd,
            dailyPnlWindow.snapshot(),
            {
              minSamples: Number(process.env.DAILY_PNL_ANOMALY_MIN_SAMPLES || 8),
              sigmaThreshold: Number(process.env.DAILY_PNL_ANOMALY_SIGMA || 3),
            },
          );
          dailyPnlWindow.push(dailyPnlUsd);
          if (anomaly.fired) logger.warn(`[health-canary] daily PnL anomaly fired: ${dailyPnlUsd}`);
        }
      }
      const result = await runHealthCanary({
        memoryPath,
        bootTimeMs: ctx.bootTimeMs,
        memorySnapshot: ctx.getMemorySnapshot?.(),
        sql: ptPool,
        aiCircuits: { primary: ctx.aiCircuit },
        dataDir: ctx.dataDir,
        positions: ctx.getPositions?.(),
        restartCountLastHour: Number(process.env.RESTART_COUNT_LAST_HOUR) || 0,
        scope: ctx.scope,
        botVersion: process.env.BOT_VERSION || null,
        logger,
        telegram: typeof ctx.sendHealthAlert === 'function'
          ? { sendMessage: (msg) => ctx.sendHealthAlert(msg).catch(() => {}) }
          : null,
      });
      logger.info(`[health-canary] ${result.overallStatus} (${result.fails} fails, ${result.warns} warns) in ${result.totalMs}ms`);
    } catch (err) {
      logger.warn(`[health-canary] run failed: ${err?.message || err}`);
    }
  };

  const touchMemFile = async () => {
    try { const now = new Date(); await fs.promises.utimes(memoryPath, now, now); }
    catch { /* ignore */ }
  };

  const tickHandle = setInterval(fireCanary, canaryMs);
  const firstFireHandle = setTimeout(fireCanary, 60_000);
  const touchHandle = setInterval(touchMemFile, 10 * 60_000);
  logger.info(`[health-canary] scheduler registered (interval=${canaryMs}ms, first run in 60s)`);

  return function dispose() {
    clearInterval(tickHandle);
    clearTimeout(firstFireHandle);
    clearInterval(touchHandle);
    _registered = false;
  };
}

module.exports = { register };
