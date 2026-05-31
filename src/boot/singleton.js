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
// LIVE pid after a 500ms Atomics.wait grace, this process exits(0) so PM2 /
// start.bat doesn't flag it as crash.
//
// Sibling-takeover: if a lock is held by a DEAD pid, take it over.
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
// hits `max_restarts` (default 10), marks the app `errored`. Workaround:
// delay the exit past `min_uptime + buffer` so pm2 treats it as a normal
// post-online shutdown and keeps autorestarting until the sibling is gone,
// without ever marking the app errored.
//
// Read PM2_MIN_UPTIME_MS env (pm2 sets it as integer ms when the app config
// uses `min_uptime`) and default to 10s + 5s buffer when not present.
function pm2DelayedExitMs() {
  if (!process.env.pm_id) return 0; // not running under pm2
  const fromEnv = Number(process.env.PM2_MIN_UPTIME_MS);
  const base = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10000;
  return base + 5000;
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
  const pidPayload = JSON.stringify({
    pid: process.pid,
    profile,
    port,
    startedAt: new Date().toISOString(),
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

  // Generic acquire: either writes the lock or calls process.exit(0) on duplicate.
  //
  // TOCTOU note (2026-05-31): the takeover path (unlink → wx-write) is racy
  // when two processes both decide the prior pid is dead. Both unlink, both
  // attempt wx-write, the loser throws EEXIST and crashes the whole bot
  // (observed 151× restart loop on paper sibling 2026-05-30/31). Fix:
  // bounded retry loop that re-runs the full liveness+takeover decision
  // rather than just blindly re-writing — if the winner is a live sibling,
  // we exit(0) like any other duplicate; if it's another dead-pid takeover
  // attempt, we keep racing until one of us wins.
  const MAX_ACQUIRE_ATTEMPTS = 5;
  const acquireLock = (lockPath, scope) => {
    for (let attempt = 1; attempt <= MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        fsSync.writeFileSync(lockPath, pidPayload, { flag: 'wx' });
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      try {
        const existing = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
        if (existing?.pid && isPidAlive(existing.pid)) {
          // Sibling alive — duplicate spawn race. Sleep then re-check.
          const sleepSab = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(sleepSab, 0, 0, graceMs);
          if (pidExists(existing.pid)) {
            const delayMs = pm2DelayedExitMs();
            const suffix = delayMs > 0
              ? ` (pm2-spawn detected; sleeping ${delayMs}ms before exit so pm2 doesn't count this as failed-startup)`
              : '';
            logger.warn(
              `Another ${profile} runtime is active (${scope} lock held by pid=${existing.pid}, ` +
              `port=${existing.port || 'unknown'}). Exiting duplicate process ${process.pid} cleanly.${suffix}`
            );
            if (delayMs > 0) {
              const exitSab = new Int32Array(new SharedArrayBuffer(4));
              Atomics.wait(exitSab, 0, 0, delayMs);
            }
            process.exit(0);
          }
          logger.info(`Sibling pid ${existing.pid} released ${scope} lock — taking over.`);
        }
      } catch (_) { /* unreadable; replace below */ }
      try { fsSync.unlinkSync(lockPath); } catch (_) {}
      try {
        fsSync.writeFileSync(lockPath, pidPayload, { flag: 'wx' });
        return;
      } catch (writeError) {
        if (writeError?.code !== 'EEXIST') throw writeError;
        // Lost the takeover race to another concurrent acquirer. Re-evaluate
        // whether the new holder is alive (could be a real sibling we should
        // defer to) instead of blindly clobbering. Small backoff to avoid
        // a tight CPU-burn race.
        const backoffSab = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(backoffSab, 0, 0, Math.min(50 * attempt, 250));
      }
    }
    throw new Error(
      `acquireRuntimeSingleton: failed to acquire ${scope} lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts`
    );
  };

  fsSync.mkdirSync(dataDirAbs, { recursive: true });
  acquireLock(profileLockPath, 'profile');  // FIRST — blocks cross-port duplicates
  acquireLock(portLockPath, 'port');        // SECOND — port-specific guard

  const release = () => {
    for (const lockPath of [portLockPath, profileLockPath]) {
      try {
        const existing = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
        if (Number(existing?.pid) === process.pid) {
          fsSync.unlinkSync(lockPath);
        }
      } catch (_) {}
    }
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
