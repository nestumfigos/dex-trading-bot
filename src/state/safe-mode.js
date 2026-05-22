'use strict';

/**
 * Safe-mode state machine — pure module, dep-injected.
 *
 * Safe mode is set when state load fails or unrecoverable error occurs. It
 * pauses all trading loops via stopSchedulers callback. Clearing reverses
 * those side effects.
 *
 * Regression for 2026-05-17 incident: safeMode=true persisted to SQL snapshot,
 * every restart reloaded it, bot stayed paused indefinitely until admin clear
 * was invoked via /api/admin/safe-mode/clear.
 *
 * Usage:
 *   const sm = require('./state/safe-mode');
 *   await sm.enter({
 *     reason: 'state unrecoverable',
 *     portfolio, logger,
 *     stopSchedulers: stopSchedulersForSafeMode,
 *     onPersistError: setStatePersistenceError,
 *     onAlert: sendSafeModeAlert,
 *     onReconcile: reconcileWalletPositions,
 *   });
 *
 *   sm.clear({
 *     portfolio,
 *     onPersistError: setStatePersistenceError,
 *     onLoopLocks: setLoopLocks,
 *   });
 */

async function enter({ reason, portfolio, logger, stopSchedulers, onPersistError, onAlert, onReconcile }) {
  if (!portfolio) throw new Error('enter: portfolio required');
  portfolio.safeMode = true;
  if (typeof onPersistError === 'function') onPersistError(true);
  if (typeof stopSchedulers === 'function') stopSchedulers();
  if (logger) logger.error('Safe mode enabled', { reason: reason || 'safe mode activated' });
  if (typeof onAlert === 'function') {
    try { await onAlert(reason || 'safe mode activated'); }
    catch (e) { if (logger) logger.error(`Safe mode alert error: ${e.message}`); }
  }
  if (typeof onReconcile === 'function') {
    try { await onReconcile(); }
    catch (e) { if (logger) logger.error(`Safe mode reconciliation error: ${e.message}`); }
  }
}

function clear({ portfolio, onPersistError, onLoopLocks }) {
  if (!portfolio) throw new Error('clear: portfolio required');
  const wasActive = Boolean(portfolio.safeMode);
  portfolio.safeMode = false;
  if (typeof onPersistError === 'function') onPersistError(false);
  if (typeof onLoopLocks === 'function') onLoopLocks(false);
  return { wasActive };
}

function isActive(portfolio) {
  return Boolean(portfolio?.safeMode);
}

module.exports = { enter, clear, isActive };
