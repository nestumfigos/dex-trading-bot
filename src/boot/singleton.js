'use strict';

// Runtime singleton: ensures only one bot process per profile is alive,
// regardless of which port it binds.
//
// Two-tier lockfile (2026-05-17 fix for ghost-on-different-port bug where
// paper@3001 + paper@3003 both ran simultaneously because the original
// per-(profile, port) lock didn't catch them):
//   runtime-<profile>.lock         — one bot per profile (the real guard)
//   runtime-<profile>-<port>.lock  — port-specific (compat / diagnostics)
//
// Acquisition order: profile lock FIRST, then port lock. If either holds a
// LIVE pid after a 500ms Atomics.wait grace, non-PM2 duplicates exit(0) so
// start.bat doesn't flag them as crashes. PM2 replacement processes for the
// same profile+port wait for the previous holder and can forcibly replace a
// stale old holder after a bounded grace window; this avoids Windows PM2
// restart storms where an orphaned old ProcessContainerFork keeps the port.
//
// Sibling-takeover: if a lock is held by a DEAD pid, take it over.
// Active holders refresh `heartbeatAt`; PM2 replacement logs fresh heartbeats
// but still performs a bounded same-port takeover so PM2 can regain ownership
// of an orphaned process without looping forever.
//
// Signal-handling: if `lockManager` is passed, release is registered as a
// cleanup hook there (drained by boot/lifecycle on SIGINT/SIGTERM through the
// graceful shutdown path). Without lockManager, falls back to direct
// process.on('SIGINT'|'SIGTERM') sync release + exit (legacy behavior — kept
// for tests + standalone use). `process.on('exit')` is always installed as a
// final-chance fallback.
//
// Returns { release, lockPath, profileLockPath, pid }.

const fsSync = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// PID-reuse-safe liveness. process.kill(pid, 0) only proves SOME process owns
// that pid; the OS recycles pids, so a dead bot's pid can resurface as an
// unrelated process (observed 2026-05-30: msedgewebview2.exe reusing a dead
// bot's pid), which read as "alive" and locked the whole fleet out of startup.
// We additionally confirm the held pid is a node (bot) process.
//
// classifyProcessProbe is pure (unit-testable without spawning):
//   true  = probe shows a node process  (treat as a live sibling — defer)
//   false = probe shows another process (recycled pid — stale, take over)
//   null  = couldn't tell               (caller stays conservative: alive)
function classifyProcessProbe(platform, probeOutput) {
  const text = String(probeOutput || '');
  if (!text.trim()) return null;
  if (platform === 'win32') {
    // tasklist /FO CSV: "<image>","<pid>",...  No quoted image => not found.
    const m = text.match(/^\s*"([^"]+)"/m);
    if (!m) return null;
    return /^node(\.exe)?$/i.test(m[1].trim());
  }
  // ps -o comm= : the executable name owning the pid.
  return /\bnode\b/i.test(text);
}

function probePidProcess(pid) {
  if (process.platform === 'win32') {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
  return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// 2026-05-31 (cycle-2 follow-up): pm2-Windows quirk handler. When pm2 spawns
// us (signaled by `process.env.pm_id`) and we detect a live sibling holds
// the lock, a naive `process.exit(0)` fires BEFORE pm2's `min_uptime`
// threshold (default 10s) elapses → pm2 counts the exit as a failed startup,
// hits `max_restarts` (default 10), marks the app `errored`. Workaround for
// true duplicates: delay the exit past `min_uptime + buffer`. For same-port
// replacement races, wait/replace in-process instead of exiting, otherwise
// pm2 respawns forever while the old orphan keeps serving the port.
//
// Read PM2_MIN_UPTIME_MS env (pm2 sets it as integer ms when the app config
// uses `min_uptime`) and default to 10s + 5s buffer when not present.
function pm2DelayedExitMs() {
  if (!process.env.pm_id) return 0; // not running under pm2
  const fromEnv = Number(process.env.PM2_MIN_UPTIME_MS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10000;
  return base + 5000;
}

function sleepSync(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, n);
}

function parseNonNegativeMs(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function parseTimestampMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

function acquireRuntimeSingleton({
  dataDirAbs,
  profile,
  port,
  logger = console,
  graceMs = 500,
  lockManager = null,
} = {}) {
  if (!dataDirAbs) throw new Error('acquireRuntimeSingleton: dataDirAbs required');
  if (!profile) throw new Error('acquireRuntimeSingleton: profile required');
  if (port == null) throw new Error('acquireRuntimeSingleton: port required');

  const profileLockPath = path.join(dataDirAbs, `runtime-${profile}.lock`);
  const portLockPath    = path.join(dataDirAbs, `runtime-${profile}-${port}.lock`);
  const startedAt = new Date().toISOString();
  const lockPayloadJson = () => JSON.stringify({
    pid: process.pid,
    profile,
    port,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    pmId: process.env.pm_id || null,
  });

  const pidExists = (pid) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try { process.kill(n, 0); return true; } catch (_) { return false; }
  };

  // Full check: pid exists AND is a node (bot) process. The process probe
  // (tasklist/ps) is the slow part, so the post-grace liveness re-check below
  // uses the cheap pidExists() instead — identity can't change in ~50ms, only
  // liveness. This keeps at most ONE probe per lock acquisition.
  const isPidAlive = (pid) => {
    if (!pidExists(pid)) return false;
    let probe = '';
    try { probe = probePidProcess(Number(pid)); } catch (_) { return true; }
    const verdict = classifyProcessProbe(process.platform, probe);
    return verdict === null ? true : verdict;
  };

  const readLockPayload = (lockPath) => {
    try { return JSON.parse(fsSync.readFileSync(lockPath, 'utf8')); } catch (_) { return null; }
  };

  const heartbeatAgeMs = (payload) => {
    const heartbeatTs = parseTimestampMs(payload?.heartbeatAt);
    if (heartbeatTs == null) return null;
    return Math.max(0, Date.now() - heartbeatTs);
  };

  const isFreshHeartbeat = (payload, staleMs) => {
    const age = heartbeatAgeMs(payload);
    return age != null && age <= staleMs;
  };

  const shouldUsePm2ReplacementPath = (existing) => {
    if (!process.env.pm_id) return false;
    if (!existing || Number(existing.pid) === process.pid) return false;
    return String(existing.profile || '') === String(profile)
      && Number(existing.port) === Number(port);
  };

  const replacementLeasePath = () => path.join(dataDirAbs, `runtime-${profile}-${port}.replace.lock`);

  const tryAcquireReplacementLease = (scope, targetPid, ttlMs) => {
    const leasePath = replacementLeasePath(scope);
    const payload = {
      pid: process.pid,
      targetPid: Number(targetPid),
      profile,
      port,
      scope,
      acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        fsSync.writeFileSync(leasePath, JSON.stringify(payload), { flag: 'wx' });
        return { acquired: true, leasePath };
      } catch (error) {
        if (error?.code !== 'EEXIST') return { acquired: false, leasePath };
      }
      const existing = readLockPayload(leasePath);
      const age = existing ? Math.max(0, Date.now() - (parseTimestampMs(existing.acquiredAt) || 0)) : ttlMs + 1;
      if (existing?.pid && pidExists(existing.pid) && age <= ttlMs) {
        return { acquired: false, leasePath };
      }
      try { fsSync.unlinkSync(leasePath); } catch (_) {}
    }
    return { acquired: false, leasePath };
  };

  const releaseReplacementLease = (leasePath) => {
    try {
      const existing = readLockPayload(leasePath);
      if (Number(existing?.pid) === process.pid) fsSync.unlinkSync(leasePath);
    } catch (_) {}
  };

  const waitForPm2Replacement = (lockPath, scope, existing) => {
    if (!shouldUsePm2ReplacementPath(existing)) return 'duplicate';

    const defaultReplaceMs = 20000;
    const replaceAfterMs = parseNonNegativeMs('PM2_SINGLETON_REPLACE_AFTER_MS', defaultReplaceMs);
    const sigtermGraceMs = parseNonNegativeMs('PM2_SINGLETON_SIGTERM_GRACE_MS', 5000);
    const pollMs = Math.max(50, parseNonNegativeMs('PM2_SINGLETON_POLL_MS', 500));
    const freshHeartbeatLogMs = Math.max(0, parseNonNegativeMs('PM2_SINGLETON_FRESH_HEARTBEAT_LOG_MS', 5000));
    const staleHeartbeatMs = Math.max(
      pollMs * 2,
      parseNonNegativeMs('PM2_SINGLETON_STALE_HEARTBEAT_MS', Math.max(replaceAfterMs, 120000))
    );

    if (replaceAfterMs <= 0) return 'duplicate';

    const leaseTtlMs = Math.max(replaceAfterMs + sigtermGraceMs + 5000, staleHeartbeatMs);
    const lease = tryAcquireReplacementLease(scope, existing.pid, leaseTtlMs);
    if (!lease.acquired) {
      logger.warn(
        `PM2 replacement ${process.pid} found another replacement owner for ${profile} ` +
        `pid=${existing.pid} (${scope} lock); exiting duplicate.`
      );
      return 'duplicate';
    }

    try {
      logger.warn(
        `PM2 replacement ${process.pid} waiting for previous ${profile} runtime ` +
        `pid=${existing.pid} (${scope} lock, port=${existing.port}) for up to ${replaceAfterMs}ms.`
      );

      const started = Date.now();
      let lastFreshHeartbeatLogAt = 0;
      while (Date.now() - started < replaceAfterMs) {
        sleepSync(Math.min(pollMs, Math.max(1, replaceAfterMs - (Date.now() - started))));
        if (!pidExists(existing.pid)) return 'takeover';
        const current = readLockPayload(lockPath);
        if (!current || Number(current.pid) !== Number(existing.pid)) return 'retry';
        if (isFreshHeartbeat(current, staleHeartbeatMs)) {
          const now = Date.now();
          if (!lastFreshHeartbeatLogAt || freshHeartbeatLogMs <= 0 || now - lastFreshHeartbeatLogAt >= freshHeartbeatLogMs) {
            lastFreshHeartbeatLogAt = now;
            logger.warn(
              `PM2 replacement ${process.pid} saw fresh ${profile} heartbeat from ` +
              `pid=${existing.pid}; waiting for graceful release before forced replacement.`
            );
          }
        }
      }

      const current = readLockPayload(lockPath);
      if (!current || Number(current.pid) !== Number(existing.pid)) return 'retry';
      if (!pidExists(existing.pid)) return 'takeover';

      logger.warn(
        `PM2 replacement ${process.pid} replacing stale previous ${profile} runtime ` +
        `pid=${existing.pid} after ${replaceAfterMs}ms.`
      );
      try { process.kill(Number(existing.pid), 'SIGTERM'); } catch (_) {}
      sleepSync(sigtermGraceMs);
      if (!pidExists(existing.pid)) return 'takeover';

      logger.warn(`Previous ${profile} runtime pid=${existing.pid} survived SIGTERM; forcing termination.`);
      try { process.kill(Number(existing.pid), 'SIGKILL'); } catch (_) {}
      sleepSync(1000);
      if (!pidExists(existing.pid)) return 'takeover';

      return 'duplicate';
    } finally {
      releaseReplacementLease(lease.leasePath);
    }
  };

  const heldLockPaths = [];
  const rememberHeldLock = (lockPath) => {
    if (!heldLockPaths.includes(lockPath)) heldLockPaths.push(lockPath);
  };
  const releaseHeldLocks = () => {
    for (const lockPath of [...heldLockPaths].reverse()) {
      try {
        const existing = readLockPayload(lockPath);
        if (Number(existing?.pid) === process.pid) fsSync.unlinkSync(lockPath);
      } catch (_) {}
    }
  };

  // Generic acquire: either writes the lock or calls process.exit(0) on duplicate.
  //
  // TOCTOU note (2026-05-31): the takeover path (unlink → wx-write) is racy
  // when two paper processes both decide the prior pid is dead. Both unlink,
  // both attempt wx-write, the loser throws EEXIST and crashes the whole bot
  // (observed 151× restart loop on 2026-05-30/31). Fix: bounded retry loop
  // that re-runs the full liveness+takeover decision rather than just blindly
  // re-writing — if the winner is a live sibling, we exit(0) like any other
  // duplicate; if it's another dead-pid takeover attempt, we keep racing
  // until one of us wins.
  const MAX_ACQUIRE_ATTEMPTS = 5;
  const acquireLock = (lockPath, scope) => {
    for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        fsSync.writeFileSync(lockPath, lockPayloadJson(), { flag: 'wx' });
        rememberHeldLock(lockPath);
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      try {
        const existing = readLockPayload(lockPath);
        if (existing?.pid && isPidAlive(existing.pid)) {
          // Sibling alive — duplicate spawn race. Sleep then re-check.
          sleepSync(graceMs);
          if (pidExists(existing.pid)) {
            const pm2ReplacementResult = waitForPm2Replacement(lockPath, scope, existing);
            if (pm2ReplacementResult === 'retry') {
              continue;
            }
            if (pm2ReplacementResult === 'takeover') {
              logger.info(`Previous ${profile} runtime pid ${existing.pid} released ${scope} lock — taking over.`);
            } else {
            const delayMs = pm2DelayedExitMs();
            const suffix = delayMs > 0
              ? ` (pm2-spawn detected; sleeping ${delayMs}ms before exit so pm2 doesn't count this as failed-startup)`
              : '';
            logger.warn(
              `Another ${profile} runtime is active (${scope} lock held by pid=${existing.pid}, ` +
              `port=${existing.port || 'unknown'}). Exiting duplicate process ${process.pid} cleanly.${suffix}`
            );
              if (delayMs > 0) {
                releaseHeldLocks();
                sleepSync(delayMs);
              } else {
                releaseHeldLocks();
              }
              process.exit(0);
            }
          }
          logger.info(`Sibling pid ${existing.pid} released ${scope} lock — taking over.`);
        }
      } catch (_) { /* unreadable; replace below */ }
      try { fsSync.unlinkSync(lockPath); } catch (_) {}
      try {
        fsSync.writeFileSync(lockPath, lockPayloadJson(), { flag: 'wx' });
        rememberHeldLock(lockPath);
        return;
      } catch (writeError) {
        if (writeError?.code !== 'EEXIST') throw writeError;
        // Lost the takeover race to another concurrent acquirer. Re-evaluate
        // whether the new holder is alive (could be a real sibling we should
        // defer to) instead of blindly clobbering. Small backoff to avoid
        // a tight CPU-burn race.
        sleepSync(Math.min(50 * attempt, 250));
      }
    }
    throw new Error(
      `acquireRuntimeSingleton: failed to acquire ${scope} lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts`
    );
  };

  fsSync.mkdirSync(dataDirAbs, { recursive: true });
  acquireLock(profileLockPath, 'profile');  // FIRST — blocks cross-port duplicates
  acquireLock(portLockPath, 'port');        // SECOND — port-specific guard

  const heartbeatIntervalMs = Math.max(1000, parseNonNegativeMs('SINGLETON_HEARTBEAT_INTERVAL_MS', 15000));
  const refreshHeartbeat = () => {
    const now = new Date().toISOString();
    for (const lockPath of [profileLockPath, portLockPath]) {
      try {
        const existing = readLockPayload(lockPath);
        if (Number(existing?.pid) !== process.pid) continue;
        existing.heartbeatAt = now;
        fsSync.writeFileSync(lockPath, JSON.stringify(existing));
      } catch (_) {}
    }
  };
  const heartbeatTimer = setInterval(refreshHeartbeat, heartbeatIntervalMs);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  const release = () => {
    try { clearInterval(heartbeatTimer); } catch (_) {}
    releaseHeldLocks();
  };

  // Final-chance fallback: process is exiting (after lifecycle ran or hard-exit).
  process.on('exit', release);

  if (lockManager && typeof lockManager.register === 'function') {
    // Lifecycle path: lifecycle drains hooks on SIGINT/SIGTERM. No direct
    // signal binding here — avoids the historic SIGINT race where the sync
    // release+exit beat shutdownAndExit's async drain.
    lockManager.register(`singleton:${profile}:${port}`, release);
  } else {
    // Legacy fallback (no lifecycle integration).
    process.on('SIGINT', () => { release(); process.exit(0); });
    process.on('SIGTERM', () => { release(); process.exit(0); });
  }

  // Keep `lockPath` for backwards compat — points to the port-specific lock.
  return { release, lockPath: portLockPath, profileLockPath, pid: process.pid };
}

module.exports = { acquireRuntimeSingleton, classifyProcessProbe };
