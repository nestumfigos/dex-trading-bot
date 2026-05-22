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

  const isPidAlive = (pid) => {
    try { process.kill(Number(pid), 0); return true; } catch (_) { return false; }
  };

  // Generic acquire: either writes the lock or calls process.exit(0) on duplicate.
  const acquireLock = (lockPath, scope) => {
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
        if (isPidAlive(existing.pid)) {
          logger.warn(
            `Another ${profile} runtime is active (${scope} lock held by pid=${existing.pid}, ` +
            `port=${existing.port || 'unknown'}). Exiting duplicate process ${process.pid} cleanly.`
          );
          process.exit(0);
        }
        logger.info(`Sibling pid ${existing.pid} released ${scope} lock — taking over.`);
      }
    } catch (_) { /* unreadable; replace below */ }
    try { fsSync.unlinkSync(lockPath); } catch (_) {}
    fsSync.writeFileSync(lockPath, pidPayload, { flag: 'wx' });
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

module.exports = { acquireRuntimeSingleton };
