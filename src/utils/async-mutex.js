'use strict';

/**
 * Distributed AsyncMutex — file-lock outer guard + in-process FIFO queue.
 *
 * - Cross-process safety via proper-lockfile (stale-detection, retries).
 * - In-process ordering via promise-chain queue (FIFO acquire).
 * - Graceful degrade: if file-lock acquire fails, falls back to in-process only
 *   with a warning. Single-process correctness preserved.
 *
 * Extracted from src/index.js Day 7 follow-up. Per-bot lock file location
 * derived from `BOT_DATA_DIR` + `BOT_PROFILE` env, so live + paper bots
 * never share a lock target.
 *
 * Usage:
 *   const { createAsyncMutex } = require('./utils/async-mutex');
 *   const mutex = createAsyncMutex({ logger, projectRoot: __dirname + '/..' });
 *   const release = await mutex.lock();
 *   try { ... } finally { release(); }
 */

const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

function resolveLockFilePath(projectRoot, explicitProfile = null) {
  const dataDir = process.env.BOT_DATA_DIR || 'data';
  // Prefer caller-supplied profile so the index.js BOT_PROFILE derivation (which
  // handles PAPER_TRADING-only setups) is respected even if process.env.BOT_PROFILE
  // is unset. Falls back to env, then 'bot' generic.
  const profile = String(explicitProfile || process.env.BOT_PROFILE || 'bot').toLowerCase();
  return path.resolve(projectRoot, dataDir, `.position-${profile}.lock`);
}

function ensureLockTarget(lockFilePath) {
  try {
    fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    if (!fs.existsSync(lockFilePath)) {
      fs.writeFileSync(lockFilePath, '', 'utf8');
    }
  } catch (_) { /* best-effort */ }
}

class AsyncMutex {
  constructor({ logger, lockFilePath, lockOpts = {} } = {}) {
    this.logger = logger || console;
    this.lockFilePath = lockFilePath;
    this.lockOpts = {
      retries: { retries: 50, factor: 1.3, minTimeout: 50, maxTimeout: 500 },
      stale: 30000,
      realpath: false,
      ...lockOpts,
    };
    this._queue = Promise.resolve();
  }

  async lock() {
    let releaseFileLock = null;
    if (this.lockFilePath) {
      try {
        releaseFileLock = await lockfile.lock(this.lockFilePath, this.lockOpts);
      } catch (err) {
        try {
          this.logger.warn(`AsyncMutex: file-lock acquire failed (${err?.message || err}) — degrading to in-process only`);
        } catch (_) { /* logger may not have warn */ }
      }
    }
    let release;
    const releasePromise = new Promise((res) => { release = res; });
    const prev = this._queue;
    this._queue = prev.then(() => releasePromise).catch(() => {});
    const inProcessRelease = await prev.then(() => release);
    return () => {
      inProcessRelease();
      if (releaseFileLock) {
        Promise.resolve(releaseFileLock()).catch(() => {});
      }
    };
  }
}

function createAsyncMutex({ logger, projectRoot, profile = null } = {}) {
  const lockFilePath = projectRoot ? resolveLockFilePath(projectRoot, profile) : null;
  if (lockFilePath) ensureLockTarget(lockFilePath);
  return new AsyncMutex({ logger, lockFilePath });
}

module.exports = {
  AsyncMutex,
  createAsyncMutex,
  resolveLockFilePath,
  ensureLockTarget,
};
