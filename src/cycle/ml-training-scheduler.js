'use strict';

/**
 * ML / RL training scheduler — pure module, dep-injected.
 *
 * Owns three independent timers:
 *   1. Paper-RL training (every config.rl.trainingIntervalMinutes, ≥ 15m)
 *      — paper mode only, when rl.enabled !== false and paperTrainingEnabled !== false
 *   2. RL online updater (every 5 min) — Q-table updates from recently closed trades
 *      — when rl.enabled !== false (live + paper)
 *   3. ML auto-training (every config.ml.autoTrainingIntervalMinutes, ≥ 60m)
 *      — when ml.autoTrainingEnabled !== false
 *   4. Weekly ML retraining (Sunday 02:15 UTC, self-rescheduling)
 *      — when ml.weeklyRetrainingEnabled !== false OR ML_WEEKLY_RETRAINING_ENABLED=true
 *
 * Also fires a 90s post-boot delayed initial paper-RL training (when applicable)
 * and a 5min post-boot delayed initial ML auto-training.
 *
 * Usage:
 *   const { register } = require('./cycle/ml-training-scheduler');
 *   const dispose = register({ logger, ctx: {
 *     config, portfolio, modelRegistry, rlOnlineUpdater,
 *     trainPaperRlPolicy, sendHeartbeat, sendErrorAlert,
 *   }});
 */

// Each register() call creates fresh timers + returns its own disposer. Caller
// MUST dispose() the previous handle before re-registering (e.g. during
// restartLoopSchedulers + safe-mode recovery). Multiple concurrent registers
// will leak timers — caller's responsibility to track + dispose.

function register({ logger, ctx }) {
  const {
    config,
    portfolio,
    modelRegistry,
    rlOnlineUpdater,
    trainPaperRlPolicy,
    sendHeartbeat,
    sendErrorAlert,
  } = ctx;

  const timers = [];

  // 1. Paper-RL training timer
  if (config.paperTrading === true && config.rl?.enabled !== false && config.rl?.paperTrainingEnabled !== false) {
    const rlTrainingMs = Math.max(15 * 60_000, Number(config.rl?.trainingIntervalMinutes || 45) * 60_000);
    const t = setInterval(() => {
      Promise.resolve(trainPaperRlPolicy?.())
        .catch((err) => logger.error(`Paper RL training scheduler error: ${err?.message || err}`));
    }, rlTrainingMs);
    timers.push(t);
    // Initial fire 90s post-boot
    const t0 = setTimeout(() => {
      Promise.resolve(trainPaperRlPolicy?.())
        .catch((err) => logger.error(`Initial paper RL training failed: ${err?.message || err}`));
    }, 90_000);
    timers.push(t0);
    logger.info(`[ml-training-scheduler] paper-RL training: every ${rlTrainingMs}ms (first run in 90s)`);
  }

  // 2. RL online updater
  if (config.rl?.enabled !== false && rlOnlineUpdater) {
    const t = setInterval(async () => {
      try {
        const recentClosed = Object.values(portfolio.closedTrades || {})
          .filter((tr) => Date.now() - (tr.closedAt || 0) < 10 * 60_000)
          .slice(-20);

        for (const trade of recentClosed) {
          if (trade._rlOnlineProcessed) continue;
          const tradeOutcome = {
            symbol: trade.symbol,
            symbols: [trade.symbol],
            chain: trade.chain,
            strategy: trade.strategy,
            pnl: trade.realizedPnl || 0,
            sizeUsd: trade.initialSizeUsd || 0,
            confidence: trade.aiConfidence || 0.5,
            priceChange24h: trade.priceChange24h || 0,
            holdMinutes: (trade.closedAt - trade.entryAt) / 60_000 || 0,
            portfolio,
            volatilityClass: portfolio.volatilityClass || 'normal',
          };
          rlOnlineUpdater.updateFromTrade(tradeOutcome);
          trade._rlOnlineProcessed = true;
        }

        const stats = rlOnlineUpdater.getStats?.();
        if (stats && stats.stateCount > 0) {
          logger.debug(`[RLOnline] Q-table: ${stats.stateCount} states, ${stats.actionCount} actions, avg Q=${Number(stats.avgQValue || 0).toFixed(2)}`);
        }
      } catch (err) {
        logger.debug(`RL online update error: ${err?.message || err}`);
      }
    }, 5 * 60_000);
    timers.push(t);
  }

  // 3. ML auto-training
  if (config.ml?.autoTrainingEnabled !== false && modelRegistry?.runAutoTraining) {
    const mlMs = Math.max(60 * 60_000, Number(config.ml?.autoTrainingIntervalMinutes || 360) * 60_000);
    const t = setInterval(() => {
      modelRegistry.runAutoTraining().catch((err) => logger.error(`ML auto-training scheduler error: ${err?.message || err}`));
    }, mlMs);
    timers.push(t);
    // Initial fire 5min post-boot
    const t0 = setTimeout(() => {
      modelRegistry.runAutoTraining().catch((err) => logger.error(`Initial ML auto-training failed: ${err?.message || err}`));
    }, 5 * 60_000);
    timers.push(t0);
    logger.info(`[ml-training-scheduler] ML auto-training: every ${mlMs}ms (first run in 5min)`);
  }

  // 4. Weekly retraining (Sunday 02:15 UTC, self-rescheduling)
  let weeklyTimer = null;
  const weeklyEnabled = config.ml?.weeklyRetrainingEnabled !== false || process.env.ML_WEEKLY_RETRAINING_ENABLED === 'true';
  if (weeklyEnabled) {
    const scheduleWeekly = () => {
      try {
        const now = new Date();
        const scheduledDayOfWeek = 0; // Sunday
        const scheduledHour = 2;
        const scheduledMinute = 15;
        const nextRun = new Date(now);
        const daysUntilSunday = (scheduledDayOfWeek - nextRun.getUTCDay() + 7) % 7;
        nextRun.setUTCDate(nextRun.getUTCDate() + daysUntilSunday);
        nextRun.setUTCHours(scheduledHour, scheduledMinute, 0, 0);
        if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 7);
        const delayMs = nextRun.getTime() - now.getTime();
        logger.info(`[Weekly Retraining] Scheduled for ${nextRun.toISOString()} (in ${(delayMs / 3600000).toFixed(1)} hours)`);

        weeklyTimer = setTimeout(async () => {
          logger.info('[Weekly Retraining] Starting weekly model retraining cycle...');
          try {
            const result = await (modelRegistry?.runWeeklyRetraining?.()
              || modelRegistry?.runAutoTraining?.().catch((err) => {
                logger.error(`Weekly retraining failed: ${err?.message || err}`);
                return null;
              }));
            if (result) {
              logger.info('[Weekly Retraining] Cycle completed successfully');
              sendHeartbeat?.('✅ Weekly model retraining completed').catch(() => {});
            }
          } catch (err) {
            logger.error(`[Weekly Retraining] Cycle failed: ${err?.message || err}`);
            sendErrorAlert?.(`Weekly model retraining failed: ${err?.message || err}`).catch(() => {});
          }
          scheduleWeekly(); // self-reschedule next week
        }, delayMs);
      } catch (err) {
        logger.warn(`[Weekly Retraining] Setup failed: ${err?.message || err}`);
      }
    };
    scheduleWeekly();
  }

  return function dispose() {
    for (const t of timers) {
      try { clearInterval(t); clearTimeout(t); } catch (_) {}
    }
    if (weeklyTimer) { try { clearTimeout(weeklyTimer); } catch (_) {} }
  };
}

module.exports = { register };
