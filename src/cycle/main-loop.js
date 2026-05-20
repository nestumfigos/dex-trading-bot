'use strict';

/**
 * Main loop scheduler — pure module, dep-injected (Week 9 cycle split).
 *
 * Owns interval timer lifecycle for all cycle dispatchers:
 *   - momentumScan, swingScan (entry detection)
 *   - momentumExit, swingExit (exit checks per strategy)
 *   - realtimeStop (sub-minute trailing/stop safety net)
 *   - swingWatchlistRefresh (24h default)
 *   - walletBalanceRefresh (60s default)
 *   - bscNativePriceRefresh (45s default)
 *   - selfEvolution (180min default, conditional)
 *   - marketIntelligence (30min default, conditional)
 *   - ML/RL training (via ml-training-scheduler.register)
 *   - oracle stop watchers
 *
 * State pattern: caller passes a `state` object containing timer handle slots
 * (one per timer). Module mutates state.<timer> = setInterval(...). This keeps
 * timer state observable from caller (health checks at /api/status) without
 * round-trip getters.
 *
 * Behavior preserved byte-identical from src/index.js inline restartLoopSchedulers
 * + clearLoopSchedulers + setLoopLocks + stopSchedulersForSafeMode.
 *
 * Lifecycle:
 *   - restartLoopSchedulers({state, deps}) — clear + (re)create all timers + boot cycles
 *   - clearLoopSchedulers({state, deps})  — stop all + dispose ml-scheduler hook
 *   - setLoopLocks({loopLocks, enabled, refreshScanInFlightFlag})
 *   - stopSchedulersForSafeMode({state, loopLocks, deps, ...}) — clear + set all locks true
 *
 * Safe-mode awareness: restartLoopSchedulers checks portfolio.safeMode and
 * falls through to stopSchedulersForSafeMode if set, then logs + returns.
 */

function clearLoopSchedulers({ state, deps }) {
  if (!state) throw new Error('clearLoopSchedulers: state required');
  if (!deps) throw new Error('clearLoopSchedulers: deps required');

  if (typeof deps.stopOracleStopWatchers === 'function') {
    try { deps.stopOracleStopWatchers(); } catch (_) {}
  }

  const TIMER_KEYS = [
    'scanTimer',
    'momentumScanTimer',
    'swingScanTimer',
    'momentumExitTimer',
    'swingExitTimer',
    'realtimeStopTimer',
    'swingWatchlistRefreshTimer',
    'walletBalanceRefreshTimer',
    'bscNativePriceRefreshTimer',
    'selfEvolutionTimer',
    'intelligenceTimer',
    'rlTrainingTimer',
  ];

  for (const key of TIMER_KEYS) {
    const t = state[key];
    if (t) {
      try { clearInterval(t); } catch (_) {}
    }
    state[key] = null;
  }

  // Dispose ml-training-scheduler timers (RL paper training, RL online updater,
  // ML auto-training, weekly retraining) so restart cycle doesn't leak timers.
  if (typeof state.mlTrainingSchedulerDispose === 'function') {
    try { state.mlTrainingSchedulerDispose(); } catch (_) {}
    state.mlTrainingSchedulerDispose = null;
  }
}

function setLoopLocks({ loopLocks, enabled, refreshScanInFlightFlag }) {
  if (!loopLocks) throw new Error('setLoopLocks: loopLocks required');
  Object.keys(loopLocks).forEach((key) => {
    loopLocks[key] = Boolean(enabled);
  });
  if (typeof refreshScanInFlightFlag === 'function') refreshScanInFlightFlag();
}

function stopSchedulersForSafeMode({ state, deps, loopLocks, refreshScanInFlightFlag }) {
  clearLoopSchedulers({ state, deps });
  setLoopLocks({ loopLocks, enabled: true, refreshScanInFlightFlag });
}

function restartLoopSchedulers({ state, deps, loopLocks, refreshScanInFlightFlag }) {
  if (!state) throw new Error('restartLoopSchedulers: state required');
  if (!deps) throw new Error('restartLoopSchedulers: deps required');
  if (!loopLocks) throw new Error('restartLoopSchedulers: loopLocks required');

  const {
    portfolio,
    config,
    logger,
    runStrategyScanCycle,
    runStrategyExitCycle,
    runRealtimeRiskStopCycle,
    refreshSwingWatchlists,
    updateWalletBalance,
    refreshBscNativePrice,
    runSelfEvolutionCycle,
    runMarketIntelligenceCycle,
    evictStuckPositions,
    startOracleStopWatchers,
    mlTrainingSchedulerRegister,   // factory: ({ logger, ctx }) => disposer
    mlTrainingSchedulerCtx,        // ctx object to pass through
  } = deps;

  clearLoopSchedulers({ state, deps });

  if (portfolio.safeMode) {
    stopSchedulersForSafeMode({ state, deps, loopLocks, refreshScanInFlightFlag });
    logger.warn('Loop schedulers paused: safe mode is active');
    return;
  }

  setLoopLocks({ loopLocks, enabled: false, refreshScanInFlightFlag });

  const momentumScanMs    = Math.max(60_000,        Number(config.bot.momentumScanIntervalSeconds || 75) * 1000);
  const swingScanMs       = Math.max(10 * 60_000,   Number(config.bot.swingScanIntervalMinutes || 15) * 60_000);
  const bullFlagScanMs    = Math.max(60_000,        Number(config.bot.bullFlagScanIntervalSeconds || 90) * 1000);
  const momentumExitMs    = Math.max(5 * 60_000,    Number(config.bot.momentumExitCheckMinutes || 15) * 60_000);
  const swingExitMs       = Math.max(30 * 60_000,   Number(config.bot.swingExitCheckMinutes || 60) * 60_000);
  const swingRefreshMs    = Math.max(6 * 60 * 60_000, Number(config.bot.swingWatchlistRefreshHours || 24) * 60 * 60_000);
  const realtimeStopMs    = Math.max(2_000,         Number(config.risk?.realtimeStopCheckSeconds || 8) * 1000);
  const selfEvolutionMs   = Math.max(10 * 60_000,   Number(config.selfEvolution?.intervalMinutes || 180) * 60_000);

  state.momentumScanTimer = setInterval(() => {
    runStrategyScanCycle('momentum').catch((error) => logger.error(`Momentum scan loop error: ${error.message}`));
  }, momentumScanMs);
  // Keep a handle in scanTimer for backward compatibility with state/debug expectations.
  state.scanTimer = state.momentumScanTimer;

  state.swingScanTimer = setInterval(() => {
    runStrategyScanCycle('swing').catch((error) => logger.error(`Swing scan loop error: ${error.message}`));
  }, swingScanMs);

  if (config.strategies?.spot_day_bull_flag?.enabled) {
    state.bullFlagScanTimer = setInterval(() => {
      runStrategyScanCycle('spot_day_bull_flag').catch((error) => logger.error(`Bull-flag scan loop error: ${error.message}`));
    }, bullFlagScanMs);
  }

  state.momentumExitTimer = setInterval(() => {
    runStrategyExitCycle('momentum').catch((error) => logger.error(`Momentum exit loop error: ${error.message}`));
  }, momentumExitMs);

  state.swingExitTimer = setInterval(() => {
    runStrategyExitCycle('swing').catch((error) => logger.error(`Swing exit loop error: ${error.message}`));
  }, swingExitMs);

  if (config.risk?.realtimeStopLossEnabled !== false) {
    state.realtimeStopTimer = setInterval(() => {
      runRealtimeRiskStopCycle().catch((error) => logger.error(`Realtime stop loop error: ${error.message}`));
    }, realtimeStopMs);
  }

  state.swingWatchlistRefreshTimer = setInterval(() => {
    refreshSwingWatchlists().catch((error) => logger.error(`Swing watchlist refresh loop error: ${error.message}`));
  }, swingRefreshMs);

  const walletBalanceRefreshMs = Math.max(30_000, Number(config.bot.walletBalanceRefreshSeconds || 60) * 1000);
  state.walletBalanceRefreshTimer = setInterval(() => {
    updateWalletBalance().catch((error) => logger.error(`Wallet balance refresh loop error: ${error.message}`));
  }, walletBalanceRefreshMs);

  const bscNativePriceRefreshMs = Math.max(15_000, Number(config.risk?.nativePriceRefreshSeconds || 45) * 1000);
  state.bscNativePriceRefreshTimer = setInterval(() => {
    refreshBscNativePrice().catch((error) => logger.warn(`BSC native price refresh loop error: ${error.message}`));
  }, bscNativePriceRefreshMs);

  if (config.selfEvolution?.enabled === true && typeof runSelfEvolutionCycle === 'function') {
    state.selfEvolutionTimer = setInterval(() => {
      runSelfEvolutionCycle().catch((error) => logger.error(`Self-evolution scheduler error: ${error.message}`));
    }, selfEvolutionMs);
  }

  // Market intelligence cycle: every 30 minutes by default
  const intelligenceMs = Math.max(15 * 60_000, Number(process.env.INTELLIGENCE_INTERVAL_MINUTES || 30) * 60_000);
  if (process.env.INTELLIGENCE_ENABLED !== 'false' && typeof runMarketIntelligenceCycle === 'function') {
    state.intelligenceTimer = setInterval(() => {
      runMarketIntelligenceCycle().catch((error) => logger.error(`Intelligence scheduler error: ${error.message}`));
    }, intelligenceMs);
  }

  // ML/RL training scheduler (Week 9.1, 2026-05-18). Register paper-RL training,
  // RL online updater (5min Q-table updates), ML auto-training (6h), weekly
  // retraining (Sunday 02:15 UTC). Initial fires for paper-RL (90s) +
  // ML auto-training (5min) handled by module.
  if (typeof mlTrainingSchedulerRegister === 'function') {
    state.mlTrainingSchedulerDispose = mlTrainingSchedulerRegister({
      logger,
      ctx: mlTrainingSchedulerCtx,
    });
  }

  // Boot cycles immediately.
  if (typeof evictStuckPositions === 'function') evictStuckPositions();
  runStrategyScanCycle('momentum').catch((error) => logger.error(`Initial momentum scan failed: ${error.message}`));
  runStrategyScanCycle('swing').catch((error) => logger.error(`Initial swing scan failed: ${error.message}`));
  if (config.strategies?.spot_day_bull_flag?.enabled) {
    runStrategyScanCycle('spot_day_bull_flag').catch((error) => logger.error(`Initial bull-flag scan failed: ${error.message}`));
  }
  runStrategyExitCycle('momentum').catch((error) => logger.error(`Initial momentum exit check failed: ${error.message}`));
  runStrategyExitCycle('swing').catch((error) => logger.error(`Initial swing exit check failed: ${error.message}`));
  if (config.risk?.realtimeStopLossEnabled !== false) {
    runRealtimeRiskStopCycle().catch((error) => logger.error(`Initial realtime stop check failed: ${error.message}`));
  }
  if (config.selfEvolution?.enabled === true && typeof runSelfEvolutionCycle === 'function') {
    // Delay initial self-evolution by 2 min to avoid Groq rate-limit collision at startup
    setTimeout(() => {
      runSelfEvolutionCycle().catch((error) => logger.error(`Initial self-evolution cycle failed: ${error.message}`));
    }, 2 * 60_000);
  }
  // Boot intelligence cycle immediately (non-blocking)
  if (process.env.INTELLIGENCE_ENABLED !== 'false' && typeof runMarketIntelligenceCycle === 'function') {
    setTimeout(() => {
      runMarketIntelligenceCycle().catch((error) => logger.error(`Initial intelligence cycle failed: ${error.message}`));
    }, 3 * 60_000); // 3-min delay so startup Groq calls don't rate-limit intelligence
  }

  // Initial paper-RL training (90s), initial ML auto-training (5min), and
  // weekly retraining schedule (Sunday 02:15 UTC) all handled by
  // ml-training-scheduler.register() above (Week 9.1, 2026-05-18).

  setTimeout(() => {
    refreshBscNativePrice().catch((error) => logger.warn(`Initial BSC native price refresh failed: ${error.message}`));
  }, 5_000);

  if (typeof startOracleStopWatchers === 'function') startOracleStopWatchers();
}

module.exports = {
  restartLoopSchedulers,
  clearLoopSchedulers,
  setLoopLocks,
  stopSchedulersForSafeMode,
};
