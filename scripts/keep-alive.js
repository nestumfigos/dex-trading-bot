#!/usr/bin/env node
'use strict';

// LIVE bot keep-alive watcher (spot repo). Mirrors paper/scripts/keep-alive.js.
//
// Why this exists: the LIVE bot has been dying silently when the IDE session
// resumes after long inactivity (paper showed identical behavior). Stderr stays
// empty, no SIGTERM trail, no V8 OOM trace — likely external SIGKILL from
// Windows session-cleanup. Until root cause is fixed, this watcher polls
// /health on the configured port and respawns the bot on 3 consecutive
// failures.
//
// Launch (detached, NOT auto-start on boot):
//   Start-Process node 'scripts/keep-alive.js' -WindowStyle Hidden -PassThru
//
// Single-instance: writes a lock file with its own PID. Second invocation
// exits if an alive lock-owner is detected. Lock cleared on graceful exit.
//
// Env:
//   LIVE_KEEPALIVE_PORT          (default 3002)
//   LIVE_KEEPALIVE_POLL_MS       (default 30000)
//   LIVE_KEEPALIVE_FAIL_THRESHOLD (default 3)
//   LIVE_KEEPALIVE_BOOT_GRACE_MS (default 60000)  — skip checks while booting
//   NODE_OPTIONS                  — forwarded to spawned live process

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(REPO_ROOT, 'logs', 'keep-alive.log');
const LOCK_PATH = path.join(REPO_ROOT, 'logs', 'keep-alive.lock');
const STDOUT_PATH = path.join(REPO_ROOT, 'logs', 'stdout.log');
const STDERR_PATH = path.join(REPO_ROOT, 'logs', 'stderr.log');

const PORT = Number(process.env.LIVE_KEEPALIVE_PORT || 3002);
const POLL_MS = Number(process.env.LIVE_KEEPALIVE_POLL_MS || 30000);
const FAIL_THRESHOLD = Number(process.env.LIVE_KEEPALIVE_FAIL_THRESHOLD || 3);
const BOOT_GRACE_MS = Number(process.env.LIVE_KEEPALIVE_BOOT_GRACE_MS || 60000);

function log(message) {
  const line = `[${new Date().toISOString()}] [keep-alive-live pid=${process.pid}] ${message}`;
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (_) { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log(line);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const existingPid = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
    if (Number.isFinite(existingPid) && existingPid > 0) {
      try {
        process.kill(existingPid, 0); // alive check
        log(`another keep-alive already running pid=${existingPid}; exiting`);
        process.exit(0);
      } catch (_err) {
        log(`stale lock from pid=${existingPid}; reclaiming`);
      }
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => {
    try {
      const current = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
      if (current === process.pid) fs.unlinkSync(LOCK_PATH);
    } catch (_err) { /* ignore */ }
  });
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: PORT,
      path: '/health',
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function spawnLive() {
  log('spawning live bot ...');
  // Direct node spawn — no PowerShell intermediate. The previous PS detour
  // had intermittent silent failures (the helper log stayed empty across
  // multiple watcher invocations). Empirically on Win10/11, child_process.spawn
  // with windowsHide:true and stdio set to file descriptors detaches cleanly
  // with no console flash. The PS chain (spawn → powershell.exe → .ps1 →
  // Start-Process → node.exe) had at least three failure points.
  const nodeOptions = process.env.NODE_OPTIONS
    || '--max-old-space-size=4096 --heapsnapshot-near-heap-limit=3 --trace-warnings';
  let out, err;
  try {
    out = fs.openSync(STDOUT_PATH, 'a');
    err = fs.openSync(STDERR_PATH, 'a');
  } catch (e) {
    log(`spawnLive: failed to open log fds: ${e.message}`);
    return;
  }
  const env = {
    ...process.env,
    BOT_PROFILE: 'live',
    PORT: String(PORT),
    NODE_ENV: 'production',
    NODE_OPTIONS: nodeOptions,
  };
  try {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', out, err],
      detached: true,
      windowsHide: true,
    });
    child.unref();
    log(`spawned live bot pid=${child.pid}`);
  } catch (e) {
    log(`spawnLive: child_process.spawn failed: ${e.message}`);
  } finally {
    try { fs.closeSync(out); } catch (_) {}
    try { fs.closeSync(err); } catch (_) {}
  }
}

(async function main() {
  acquireLock();
  log(`watcher start port=${PORT} pollMs=${POLL_MS} failThreshold=${FAIL_THRESHOLD}`);

  let consecutiveFails = 0;
  let lastSpawnAt = 0;
  const initialUp = await healthCheck();
  if (!initialUp) {
    lastSpawnAt = Date.now();
    spawnLive();
    log(`waiting ${BOOT_GRACE_MS}ms boot grace before polling`);
    await new Promise((r) => setTimeout(r, BOOT_GRACE_MS));
  } else {
    log('live already healthy on initial check; watching');
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { log(`watcher received ${sig}; exiting (live NOT killed)`); process.exit(0); });
  }

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const ok = await healthCheck();
    if (ok) {
      if (consecutiveFails > 0) log(`recovered after ${consecutiveFails} failed checks`);
      consecutiveFails = 0;
      continue;
    }
    consecutiveFails += 1;
    log(`health check FAILED (${consecutiveFails}/${FAIL_THRESHOLD})`);
    if (consecutiveFails >= FAIL_THRESHOLD) {
      const sinceSpawn = Date.now() - lastSpawnAt;
      if (sinceSpawn < BOOT_GRACE_MS) {
        log(`skipping respawn — still within boot grace (${sinceSpawn}ms < ${BOOT_GRACE_MS}ms)`);
        continue;
      }
      lastSpawnAt = Date.now();
      spawnLive();
      consecutiveFails = 0;
      log(`waiting ${BOOT_GRACE_MS}ms boot grace before next poll`);
      await new Promise((r) => setTimeout(r, BOOT_GRACE_MS));
    }
  }
})().catch((err) => {
  log(`watcher fatal: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
