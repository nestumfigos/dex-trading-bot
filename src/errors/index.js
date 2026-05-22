'use strict';

// Error taxonomy. Boot + runtime use these to decide retry vs exit.
//
// Conventions:
// - TransientError → log + continue (or retry). Never crash the process.
// - FatalError → log + shutdownAndExit(1). Operator must investigate.
// - .retryable boolean for fast checks in callers.
// - .code mirrors Node error codes where they exist (EADDRINUSE, ECONNRESET).

class TransientError extends Error {
  constructor(message, { code = null, cause = null } = {}) {
    super(message);
    this.name = 'TransientError';
    this.retryable = true;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

class FatalError extends Error {
  constructor(message, { code = null, cause = null } = {}) {
    super(message);
    this.name = 'FatalError';
    this.retryable = false;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

class ConfigError extends FatalError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ConfigError';
  }
}

class PortBindError extends TransientError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'EADDRINUSE' });
    this.name = 'PortBindError';
  }
}

class ExchangeError extends TransientError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ExchangeError';
  }
}

class SqlError extends TransientError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'SqlError';
  }
}

// Known node error codes that must NEVER crash the process. Dashboard / exchange
// sockets retry internally; bubbling these up is what caused the EADDRINUSE
// crash-loop in 2026-05-16. Keep this list narrow — broad ignore = silent bugs.
const NON_FATAL_NODE_CODES = new Set([
  'EADDRINUSE',   // dashboard port held by sibling
  'ECONNRESET',   // exchange ws drop
  'ETIMEDOUT',    // upstream slow
  'EPIPE',        // peer closed mid-write
  'EHOSTUNREACH', // transient DNS / network
]);

function isTransient(err) {
  if (!err) return false;
  if (err instanceof TransientError) return true;
  if (err.retryable === true) return true;
  if (err.code && NON_FATAL_NODE_CODES.has(err.code)) return true;
  return false;
}

function isFatal(err) {
  if (!err) return false;
  if (err instanceof FatalError) return true;
  if (err.retryable === false) return true;
  return !isTransient(err);
}

module.exports = {
  TransientError,
  FatalError,
  ConfigError,
  PortBindError,
  ExchangeError,
  SqlError,
  NON_FATAL_NODE_CODES,
  isTransient,
  isFatal,
};
