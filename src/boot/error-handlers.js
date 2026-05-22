'use strict';

// Process-level error handlers. Wraps uncaughtException + unhandledRejection
// with the error taxonomy: transient (EADDRINUSE / ECONNRESET / ETIMEDOUT / EPIPE
// / EHOSTUNREACH) → log + continue. Anything else → shutdownAndExit(1).
//
// Currently src/index.js inlines the same logic (lines ~9355–9390 as of
// 2026-05-16). Wire-up plan: call installErrorHandlers({ logger, shutdownAndExit })
// from index.js after both are constructed, then delete the inline blocks.
// Defer wire-up until paper 24h canary validates.
//
// Usage:
//   const { installErrorHandlers } = require('./boot/error-handlers');
//   installErrorHandlers({ logger, shutdownAndExit });

const { isTransient, NON_FATAL_NODE_CODES } = require('../errors');

let installed = false;

function describeError(err) {
  return {
    message: err?.message || String(err),
    stack: err?.stack || '',
    code: err?.code || null,
    name: err?.name || 'Error',
  };
}

function installErrorHandlers({ logger = console, shutdownAndExit } = {}) {
  if (installed) {
    logger.warn('[boot/error-handlers] already installed — skipping double install');
    return;
  }
  if (typeof shutdownAndExit !== 'function') {
    throw new Error('installErrorHandlers requires { shutdownAndExit }');
  }

  process.on('uncaughtException', (error) => {
    const info = describeError(error);
    if (isTransient(error)) {
      logger.warn(`[uncaughtException] transient ${info.code || info.name} ignored: ${info.message}`);
      return;
    }
    console.error('UNCAUGHT EXCEPTION DETAILS:', info.message);
    console.error('Stack:', info.stack);
    logger.error('Uncaught exception — runtime crash recovery engaged', {
      reason: info.message,
      stack: info.stack,
      code: info.code,
    });
    shutdownAndExit(1, 'Uncaught exception — runtime crash recovery engaged', error).catch(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const info = describeError(error);
    if (isTransient(error)) {
      logger.warn(`[unhandledRejection] transient ${info.code || info.name} ignored: ${info.message}`);
      return;
    }
    logger.error('Unhandled promise rejection — runtime crash recovery engaged', {
      reason: info.message,
      stack: info.stack,
      code: info.code,
    });
    shutdownAndExit(1, 'Unhandled promise rejection — runtime crash recovery engaged', error).catch(() => {
      process.exit(1);
    });
  });

  installed = true;
  logger.info(`[boot/error-handlers] installed (transient codes: ${[...NON_FATAL_NODE_CODES].join(',')})`);
}

function _resetForTesting() { installed = false; }

module.exports = { installErrorHandlers, _resetForTesting };
