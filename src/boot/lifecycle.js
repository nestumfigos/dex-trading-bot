'use strict';

/**
 * boot/lifecycle.js — graceful shutdown + signal handlers.
 *
 * Pure factory. Dep-injected so it works in test (no live exchanges).
 * Fixes the SIGINT race introduced when both boot/singleton AND inline handlers
 * fired on Ctrl-C; we now route through one path with lock-manager hooks.
 *
 * Usage in index.js:
 *   const { createLifecycle } = require('./boot/lifecycle');
 *   const lifecycle = createLifecycle({
 *     logger,
 *     wsDiscovery,
 *     getDashboardServer: () => dashboardServer,
 *     getDashboardWss:    () => dashboardWss,
 *     telemetry,
 *     saveState,
 *     lockManager: require('../state/lock-manager'),
 *   });
 *   lifecycle.installSignalHandlers();
 *   // expose shutdownAndExit to other modules (error-handlers etc):
 *   const shutdownAndExit = lifecycle.shutdownAndExit;
 */

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;
const DEFAULT_HOOK_TIMEOUT_MS = 2000;

function createLifecycle(deps = {}) {
  const {
    logger,
    wsDiscovery,
    getDashboardServer = () => null,
    getDashboardWss = () => null,
    telemetry,
    saveState,
    lockManager = null,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS,
  } = deps;

  if (!logger || typeof logger.info !== 'function') {
    throw new Error('createLifecycle: logger required');
  }

  let shutdownInProgress = false;
  let lockManagerDrained = false;

  async function withTimeout(label, fn, ms) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
        }),
      ]);
    } catch (err) {
      logger.warn(`[lifecycle] ${label} failed: ${err.message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function shutdownAndExit(exitCode, reason, error = null) {
    if (shutdownInProgress) {
      process.exit(exitCode);
      return;
    }
    shutdownInProgress = true;

    if (error) {
      logger.error(reason, {
        reason,
        error: error.message,
        stack: error.stack,
      });
    } else {
      logger.info(reason);
    }

    // Hard timeout backstop — never hang shutdown beyond shutdownTimeoutMs
    const hardKill = setTimeout(() => {
      try { logger.warn(`[lifecycle] hard timeout ${shutdownTimeoutMs}ms — forcing exit`); } catch (_) {}
      process.exit(exitCode);
    }, shutdownTimeoutMs);
    if (typeof hardKill.unref === 'function') hardKill.unref();

    const drainLockManager = async () => {
      if (lockManagerDrained) return;
      lockManagerDrained = true;
      if (lockManager && typeof lockManager.drain === 'function') {
        await withTimeout('lockManager.drain', () => lockManager.drain({ logger, timeoutMs: hookTimeoutMs }), hookTimeoutMs + 500);
      }
    };

    if (wsDiscovery && typeof wsDiscovery.stop === 'function') {
      await withTimeout('wsDiscovery.stop', () => wsDiscovery.stop(), hookTimeoutMs);
    }

    const dashboardServer = getDashboardServer();
    const dashboardWss = getDashboardWss();
    if (dashboardServer) {
      await withTimeout('dashboard close', async () => {
        if (dashboardWss && typeof dashboardWss.clients?.forEach === 'function') {
          dashboardWss.clients.forEach((client) => {
            if (client.readyState === 1) {
              try { client.close(); } catch (_) {}
            }
          });
        }
        await new Promise((resolve) => {
          try {
            dashboardServer.close(() => {
              try { logger.debug('Dashboard server closed'); } catch (_) {}
              resolve();
            });
          } catch (_) { resolve(); }
        });
      }, hookTimeoutMs);
    }

    // Release singleton locks immediately after the listening server is closed.
    // Slow telemetry/state cleanup must not hold PM2 replacement handoff hostage.
    await drainLockManager();

    if (telemetry && typeof telemetry.endRun === 'function') {
      await withTimeout('telemetry.endRun', () => telemetry.endRun({ exitReason: reason }), hookTimeoutMs);
    }
    if (telemetry && typeof telemetry.flush === 'function') {
      await withTimeout('telemetry.flush', () => telemetry.flush(), hookTimeoutMs);
    }
    if (saveState) {
      await withTimeout('saveState', () => saveState(), hookTimeoutMs);
    }

    // Drain any late-registered cleanup hooks once more, no-op for singleton.
    await drainLockManager();

    clearTimeout(hardKill);
    process.exit(exitCode);
  }

  let signalsInstalled = false;
  function installSignalHandlers() {
    if (signalsInstalled) return;
    signalsInstalled = true;
    process.on('SIGINT', () => {
      shutdownAndExit(0, 'Shutting down, saving state...').catch(() => process.exit(1));
    });
    process.on('SIGTERM', () => {
      shutdownAndExit(0, 'Received SIGTERM, saving state before exit...').catch(() => process.exit(1));
    });
    try { logger.info('[boot/lifecycle] signal handlers installed (SIGINT, SIGTERM)'); } catch (_) {}
  }

  return {
    shutdownAndExit,
    installSignalHandlers,
    isShuttingDown: () => shutdownInProgress,
  };
}

module.exports = { createLifecycle };
