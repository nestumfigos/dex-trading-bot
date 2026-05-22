'use strict';

/**
 * Health Canary — Week 4 / Track B.
 *
 * Pure dependency-injected probe suite. Runs 8 checks every interval
 * (default 15min via scheduler in src/index.js boot/lifecycle). Writes one
 * health_checks row per sub-check + one OVERALL row. Fires Telegram alert on
 * FAIL with check name + recovery hint.
 *
 * Check catalog:
 *   memory_mtime          — agent-memory.json mtime < 30 min ago
 *   counters_monotonic    — every MERGE_KEYS counter category not lower than last run
 *   sql_latency           — kvGet round-trip < 2000ms
 *   ai_circuit            — provider circuits closed (best-effort: at least 1 closed)
 *   lock_files            — no stale .lock or .pid files older than 1h in data/
 *   positions_intact      — open positions have finite entryPrice + currentPrice age < 60min
 *   restart_count         — < 3 process restarts in last hour (from telemetry log if available)
 *   disk_space            — data/ partition has > 500MB free
 *
 * Output: { overallStatus, results: [{ name, status, value, threshold, message, recoveryHint, durationMs }] }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RECOVERY_HINTS = Object.freeze({
  memory_mtime:       'Check writer loop in src/agent/agentMemory.js save(); ensure agentMemory.saveIfDirty fires per cycle',
  counters_monotonic: 'Counters regressed — investigate _mergeFromRemote and shape.js MERGE_KEYS coverage',
  sql_latency:        'Check sqlServer pool health + SQL_CONNECTION_STRING; consider running scripts/sql-cleanup.js',
  ai_circuit:         'All AI providers in cooldown; check API keys + rate limits',
  lock_files:         'Stale lock under data/ — investigate sibling process; clean up via boot/singleton release path',
  positions_intact:   'Position missing price data — verify exchange feed + sentinel sweep',
  restart_count:      'Frequent restarts — inspect logs for crash loop; check boot/error-handlers',
  disk_space:         'Free disk < 500MB — prune data/log/* and check artifacts/models/ size',
});

const STATUS = Object.freeze({ PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', SKIPPED: 'SKIPPED' });

let lastCountersSnapshot = null; // module-level mutable for monotonicity diff

function safeFinite(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

// ─── Individual checks ─────────────────────────────────────────────────────

async function checkMemoryMtime({ memoryPath, bootTimeMs }) {
  if (!memoryPath) return { status: STATUS.SKIPPED, message: 'memoryPath not provided' };
  try {
    const stat = await fs.promises.stat(memoryPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageMin = ageMs / 60000;
    const threshold = '< 4h or since boot';
    // Idle bot doesn't write. Only FAIL if mtime older than boot AND > 4h old.
    // If mtime > bootTime → writer ran since boot → healthy regardless of age.
    if (Number.isFinite(bootTimeMs) && stat.mtimeMs >= bootTimeMs) {
      return { status: STATUS.PASS, value: `${ageMin.toFixed(1)}min (post-boot)`, threshold };
    }
    return ageMin < 240
      ? { status: STATUS.PASS, value: `${ageMin.toFixed(1)}min`, threshold }
      : { status: STATUS.FAIL, value: `${ageMin.toFixed(1)}min`, threshold, message: 'memory writer not running' };
  } catch (err) {
    return { status: STATUS.FAIL, message: `stat failed: ${err.message}`, threshold: '< 4h' };
  }
}

function checkCountersMonotonic({ memorySnapshot }) {
  if (!memorySnapshot || typeof memorySnapshot !== 'object') {
    return { status: STATUS.SKIPPED, message: 'no snapshot' };
  }
  const counterKeys = ['symbolWinRates', 'regimeWinRates', 'chainPatterns', 'tokenAgePatterns', 'exitClassificationStats', 'indicatorPatterns'];
  const cur = {};
  for (const k of counterKeys) cur[k] = Object.keys(memorySnapshot[k] || {}).length;

  if (!lastCountersSnapshot) {
    lastCountersSnapshot = cur;
    return { status: STATUS.PASS, value: JSON.stringify(cur), threshold: 'baseline', message: 'first observation' };
  }

  const regressions = [];
  for (const k of counterKeys) {
    if (cur[k] < lastCountersSnapshot[k]) regressions.push(`${k}: ${lastCountersSnapshot[k]}→${cur[k]}`);
  }
  lastCountersSnapshot = cur;
  return regressions.length === 0
    ? { status: STATUS.PASS, value: JSON.stringify(cur), threshold: 'monotonic' }
    : { status: STATUS.FAIL, value: regressions.join('; '), threshold: 'monotonic', message: 'counter regressed' };
}

async function checkSqlLatency({ sql }) {
  if (!sql || typeof sql.request !== 'function') {
    return { status: STATUS.SKIPPED, message: 'SQL disabled' };
  }
  const t0 = Date.now();
  try {
    await sql.request().query('SELECT 1 AS x');
    const ms = Date.now() - t0;
    return ms < 2000
      ? { status: STATUS.PASS, value: `${ms}ms`, threshold: '< 2000ms' }
      : { status: STATUS.WARN, value: `${ms}ms`, threshold: '< 2000ms', message: 'slow SQL' };
  } catch (err) {
    return { status: STATUS.FAIL, value: `${Date.now() - t0}ms`, threshold: '< 2000ms', message: err.message };
  }
}

function checkAiCircuit({ aiCircuits }) {
  if (!aiCircuits || typeof aiCircuits !== 'object') {
    return { status: STATUS.SKIPPED, message: 'no aiCircuits provided' };
  }
  const now = Date.now();
  const closed = [];
  const open = [];
  for (const [name, c] of Object.entries(aiCircuits)) {
    if ((c?.cooldownUntil || 0) > now) open.push(name);
    else closed.push(name);
  }
  if (closed.length === 0) {
    return { status: STATUS.FAIL, value: `open=${open.join(',')}`, threshold: '≥1 closed', message: 'all AI providers in cooldown' };
  }
  return { status: open.length > 0 ? STATUS.WARN : STATUS.PASS, value: `closed=${closed.length}/${closed.length + open.length}`, threshold: '≥1 closed' };
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function checkLockFiles({ dataDir }) {
  if (!dataDir) return { status: STATUS.SKIPPED };
  try {
    const entries = await fs.promises.readdir(dataDir);
    const stale = [];
    for (const name of entries) {
      if (!/\.(lock|pid)$/i.test(name)) continue;
      const full = path.join(dataDir, name);
      try {
        const raw = await fs.promises.readFile(full, 'utf8');
        let pid = null;
        try { pid = JSON.parse(raw).pid; } catch { pid = parseInt(raw.trim(), 10); }
        if (Number.isFinite(pid) && pidAlive(pid)) continue; // lock held by live process — healthy
        stale.push(`${name}(pid=${pid}:dead)`);
      } catch { stale.push(`${name}(unreadable)`); }
    }
    return stale.length === 0
      ? { status: STATUS.PASS, value: '0 stale', threshold: 'pid alive' }
      : { status: STATUS.FAIL, value: stale.join(','), threshold: 'pid alive', message: 'orphan lock files' };
  } catch (err) {
    return { status: STATUS.FAIL, message: err.message };
  }
}

function checkPositionsIntact({ positions }) {
  if (!positions || typeof positions !== 'object') {
    return { status: STATUS.SKIPPED, message: 'no positions provided' };
  }
  const keys = Object.keys(positions);
  const broken = [];
  const now = Date.now();
  for (const k of keys) {
    const p = positions[k];
    if (!Number.isFinite(safeFinite(p?.entryPrice, NaN))) broken.push(`${k}:noEntry`);
    const priceTs = Number(p?.lastPriceTs || p?.lastUpdate || 0);
    if (priceTs > 0 && (now - priceTs) > 60 * 60_000) broken.push(`${k}:stalePrice`);
  }
  return broken.length === 0
    ? { status: STATUS.PASS, value: `${keys.length} ok`, threshold: 'all finite + fresh' }
    : { status: STATUS.FAIL, value: broken.join(','), threshold: 'all finite + fresh', message: 'position(s) broken' };
}

function checkRestartCount({ restartCountLastHour }) {
  if (!Number.isFinite(restartCountLastHour)) {
    return { status: STATUS.SKIPPED, message: 'no restart counter' };
  }
  return restartCountLastHour < 3
    ? { status: STATUS.PASS, value: String(restartCountLastHour), threshold: '< 3 / hour' }
    : { status: STATUS.FAIL, value: String(restartCountLastHour), threshold: '< 3 / hour', message: 'crash loop suspected' };
}

async function checkDiskSpace({ dataDir }) {
  // Node's statfs is not universally available; fall back to skip on error.
  try {
    if (typeof fs.promises.statfs === 'function') {
      const stats = await fs.promises.statfs(dataDir || os.tmpdir());
      const freeMb = (stats.bavail * stats.bsize) / (1024 * 1024);
      return freeMb > 500
        ? { status: STATUS.PASS, value: `${freeMb.toFixed(0)}MB`, threshold: '> 500MB' }
        : { status: STATUS.FAIL, value: `${freeMb.toFixed(0)}MB`, threshold: '> 500MB', message: 'disk space low' };
    }
    return { status: STATUS.SKIPPED, message: 'fs.statfs unavailable' };
  } catch (err) {
    return { status: STATUS.SKIPPED, message: err.message };
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

const CHECKS = Object.freeze([
  { name: 'memory_mtime',       run: checkMemoryMtime },
  { name: 'counters_monotonic', run: checkCountersMonotonic },
  { name: 'sql_latency',        run: checkSqlLatency },
  { name: 'ai_circuit',         run: checkAiCircuit },
  { name: 'lock_files',         run: checkLockFiles },
  { name: 'positions_intact',   run: checkPositionsIntact },
  { name: 'restart_count',      run: checkRestartCount },
  { name: 'disk_space',         run: checkDiskSpace },
]);

/**
 * Execute the canary. Returns aggregate + per-check results.
 *
 * @param {Object} ctx
 *   memoryPath, memorySnapshot, sql, aiCircuits, dataDir, positions,
 *   restartCountLastHour, scope, botVersion, logger, telegram
 */
async function runHealthCanary(ctx = {}) {
  const t0 = Date.now();
  const results = [];

  for (const c of CHECKS) {
    const subT0 = Date.now();
    let res;
    try {
      res = await c.run(ctx);
    } catch (err) {
      res = { status: STATUS.FAIL, message: `check threw: ${err.message}` };
    }
    results.push({
      name:        c.name,
      status:      res.status || STATUS.SKIPPED,
      value:       res.value || null,
      threshold:   res.threshold || null,
      message:     res.message || null,
      recoveryHint: res.status === STATUS.FAIL ? (RECOVERY_HINTS[c.name] || null) : null,
      durationMs:  Date.now() - subT0,
    });
  }

  const fails = results.filter((r) => r.status === STATUS.FAIL);
  const warns = results.filter((r) => r.status === STATUS.WARN);
  const overallStatus = fails.length > 0 ? STATUS.FAIL : (warns.length > 0 ? STATUS.WARN : STATUS.PASS);

  // Best-effort persistence
  if (ctx.sql && typeof ctx.sql.request === 'function') {
    persistResults({ sql: ctx.sql, scope: ctx.scope, botVersion: ctx.botVersion, overallStatus, results, logger: ctx.logger }).catch(() => {});
  }

  // Telegram alert on FAIL
  if (overallStatus === STATUS.FAIL && ctx.telegram && typeof ctx.telegram.sendMessage === 'function') {
    const summary = fails.map((f) => `  • ${f.name}: ${f.message || f.status} — ${f.recoveryHint || 'see runbook'}`).join('\n');
    try {
      await ctx.telegram.sendMessage(`🔴 *Health canary FAIL* (${ctx.scope || 'global'})\n${summary}`).catch((err) => {
        (ctx.logger || console).error(`[health-canary] telegram alert FAILED: ${err?.message || err} — original failure: ${summary}`);
      });
    } catch (sendErr) {
      (ctx.logger || console).error(`[health-canary] telegram alert threw: ${sendErr?.message || sendErr} — original failure: ${summary}`);
    }
  }

  return {
    overallStatus,
    results,
    fails: fails.length,
    warns: warns.length,
    totalMs: Date.now() - t0,
  };
}

async function persistResults({ sql, scope, botVersion, overallStatus, results, logger }) {
  for (const r of results) {
    try {
      const req = sql.request();
      req.input('scope',          scope || 'global');
      req.input('overall_status', overallStatus);
      req.input('check_name',     r.name);
      req.input('status',         r.status);
      req.input('value_observed', r.value ? String(r.value).slice(0, 256) : null);
      req.input('threshold',      r.threshold ? String(r.threshold).slice(0, 256) : null);
      req.input('message',        r.message ? String(r.message).slice(0, 1024) : null);
      req.input('recovery_hint',  r.recoveryHint ? String(r.recoveryHint).slice(0, 512) : null);
      req.input('duration_ms',    Number.isFinite(r.durationMs) ? r.durationMs : null);
      req.input('bot_version',    botVersion || null);
      await req.query(`
        INSERT INTO dbo.health_checks
          (scope, overall_status, check_name, status, value_observed, threshold, message, recovery_hint, duration_ms, bot_version)
        VALUES
          (@scope, @overall_status, @check_name, @status, @value_observed, @threshold, @message, @recovery_hint, @duration_ms, @bot_version);
      `);
    } catch (err) {
      if (logger && typeof logger.debug === 'function') logger.debug(`[health-canary] persist fail: ${err.message}`);
    }
  }
}

function _resetCountersForTest() { lastCountersSnapshot = null; }

module.exports = {
  runHealthCanary,
  CHECKS,
  RECOVERY_HINTS,
  STATUS,
  _resetCountersForTest,
  // Exposed for direct unit tests
  checkMemoryMtime,
  checkCountersMonotonic,
  checkSqlLatency,
  checkAiCircuit,
  checkLockFiles,
  checkPositionsIntact,
  checkRestartCount,
  checkDiskSpace,
};
