'use strict';

const fs = require('fs').promises;
const path = require('path');
const config = require('../../config');

const LOG_DIR = path.resolve(__dirname, '../../logs');
const TIMESTAMP_PREFIX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/;

let maintenanceInFlight = false;

function getRetentionMs() {
  const retentionHours = Math.max(1, Number(config.bot?.nonTradeLogRetentionHours || 24));
  return retentionHours * 60 * 60 * 1000;
}

function getLogCleanupIntervalMs() {
  const intervalMinutes = Math.max(5, Number(config.bot?.logCleanupIntervalMinutes || 60));
  return intervalMinutes * 60 * 1000;
}

function getTradeRetentionMs() {
  const retentionDays = Math.max(1, Number(config.bot?.tradeLogRetentionDays || 30));
  return retentionDays * 24 * 60 * 60 * 1000;
}

function getTradeLogMaxBytes() {
  const maxMb = Math.max(1, Number(config.bot?.tradeLogMaxSizeMb || 20));
  return maxMb * 1024 * 1024;
}

function isPermanentTradeLog(fileName = '') {
  return /trade/i.test(String(fileName));
}

function isRotatedTradeLog(fileName = '') {
  return /^trades-.*\.log(\.gz)?$/i.test(String(fileName));
}

function buildArchiveName(prefix = 'trades-legacy') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}.log`;
}

function parseEntryTimestampMs(line = '') {
  const match = String(line).match(TIMESTAMP_PREFIX);
  if (!match) {
    return null;
  }

  const parsed = Date.parse(match[1].replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

async function pruneTextLogFile(filePath, cutoffMs) {
  const raw = await fs.readFile(filePath, 'utf8');
  if (!raw) {
    return { pruned: false };
  }

  const lines = raw.split(/\r?\n/);
  const keptLines = [];
  let keepCurrentEntry = false;

  for (const line of lines) {
    const timestampMs = parseEntryTimestampMs(line);
    if (timestampMs !== null) {
      keepCurrentEntry = timestampMs >= cutoffMs;
    }

    if (keepCurrentEntry) {
      keptLines.push(line);
    }
  }

  const nextRaw = keptLines.length ? `${keptLines.join('\n')}\n` : '';
  if (nextRaw === raw) {
    return { pruned: false };
  }

  await fs.writeFile(filePath, nextRaw, 'utf8');
  return { pruned: true };
}

async function cleanupNonTradeLogs(logger = null) {
  if (maintenanceInFlight) {
    return { ok: true, skipped: true, prunedFiles: 0 };
  }

  maintenanceInFlight = true;
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    const cutoffMs = Date.now() - getRetentionMs();
    const tradeCutoffMs = Date.now() - getTradeRetentionMs();
    const tradeMaxBytes = getTradeLogMaxBytes();
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    let prunedFiles = 0;
    let prunedTradeFiles = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(LOG_DIR, entry.name);

      if (isRotatedTradeLog(entry.name)) {
        const stats = await fs.stat(filePath);
        if (stats.mtimeMs < tradeCutoffMs) {
          await fs.unlink(filePath);
          prunedTradeFiles += 1;
        }
        continue;
      }

      if (/^trades\.log$/i.test(entry.name)) {
        const stats = await fs.stat(filePath);
        if (stats.size > tradeMaxBytes) {
          await fs.rename(filePath, path.join(LOG_DIR, buildArchiveName()));
          prunedTradeFiles += 1;
        }
        continue;
      }

      if (!/\.log$/i.test(entry.name) || isPermanentTradeLog(entry.name)) {
        continue;
      }

      const result = await pruneTextLogFile(filePath, cutoffMs);
      if (result.pruned) {
        prunedFiles += 1;
      }
    }

    if (logger && prunedFiles > 0) {
      logger.info(`Log cleanup complete: pruned ${prunedFiles} non-trade log file(s) older than ${config.bot?.nonTradeLogRetentionHours || 24}h`);
    }
    if (logger && prunedTradeFiles > 0) {
      logger.info(`Trade log cleanup complete: archived/pruned ${prunedTradeFiles} trade log file(s)`);
    }

    return { ok: true, skipped: false, prunedFiles, prunedTradeFiles };
  } catch (error) {
    if (logger) {
      logger.warn(`Log cleanup skipped: ${error.message}`);
    }
    return { ok: false, skipped: false, reason: error.message, prunedFiles: 0, prunedTradeFiles: 0 };
  } finally {
    maintenanceInFlight = false;
  }
}

module.exports = {
  cleanupNonTradeLogs,
  getLogCleanupIntervalMs,
};
