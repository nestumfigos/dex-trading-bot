'use strict';

// Exit recorder (2026-07-08): paper restarts ~8x/day with NO stderr and rss
// far below the heap ceiling (max 586MB observed vs 4GB limit) — the old
// OOM theory is falsified. Something ends the process silently. This module
// records every way the process can die into data/exit-log.jsonl with a
// SYNCHRONOUS append (the only write primitive guaranteed to land during
// the 'exit' event), so the next investigation reads facts, not guesses.
//
// Each JSONL line: { ts, kind, code|signal|reason, uptimeSec, rssMb,
//                    lastSignal, pid }
// kinds:
//   exit               normal/abnormal process exit (code)
//   signal             SIGINT/SIGTERM/SIGHUP/SIGBREAK received
//   uncaughtException  fatal uncaught (message + stack head)
//   unhandledRejection fatal unhandled rejection (message)
//   beforeExit         event loop drained naturally (rare for a bot — a
//                      timer leak/clear bug would surface here)
//
// grep the file, correlate timestamps with pm2 restarts:
//   - exit code 0 + signal null + no preceding uncaught = something called
//     process.exit(0) (e.g. singleton duplicate path)
//   - signal SIGINT/SIGTERM = pm2 (or operator) initiated
//   - no line at all for a restart = SIGKILL / OS kill (can't be trapped)

const fsSync = require('fs');
const path = require('path');

function startExitRecorder({ dataDirAbs, profile = 'unknown', logger = console } = {}) {
  if (!dataDirAbs) throw new Error('startExitRecorder: dataDirAbs required');
  const logPath = path.join(dataDirAbs, 'exit-log.jsonl');
  const startedAt = Date.now();
  let lastSignal = null;

  function record(kind, extra = {}) {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        kind,
        profile,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        lastSignal,
        ...extra,
      });
      fsSync.appendFileSync(logPath, line + '\n');
    } catch (_) { /* recorder must never throw */ }
  }

  // SIGINT/SIGTERM: record only — boot/lifecycle owns graceful shutdown for
  // these and registering an extra listener does not block it.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      lastSignal = sig;
      record('signal', { signal: sig });
    });
  }
  // SIGHUP/SIGBREAK: nothing else handles these, and a record-only listener
  // would SUPPRESS their default terminate — masking the exact kill path
  // we're hunting. Record, then terminate on the next tick with the
  // conventional 128+signal exit code so pm2 still sees a death.
  for (const [sig, code] of [['SIGHUP', 129], ['SIGBREAK', 149]]) {
    try {
      process.on(sig, () => {
        lastSignal = sig;
        record('signal', { signal: sig });
        setImmediate(() => process.exit(code));
      });
    } catch (_) { /* unsupported on some platforms */ }
  }

  // Fatal paths: record FIRST (listeners run in registration order, so
  // wiring this module early puts the record before any handler that exits).
  process.on('uncaughtException', (error) => {
    record('uncaughtException', {
      message: String(error?.message || error).slice(0, 300),
      stackHead: String(error?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 400),
    });
  });
  process.on('unhandledRejection', (reason) => {
    record('unhandledRejection', { message: String(reason?.message || reason).slice(0, 300) });
  });

  process.on('beforeExit', (code) => record('beforeExit', { code }));
  process.on('exit', (code) => record('exit', { code }));

  record('boot');
  logger.info(`[exit-recorder] armed -> ${logPath}`);
  return { logPath };
}

module.exports = { startExitRecorder };
