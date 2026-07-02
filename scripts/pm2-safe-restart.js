'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(command, args, options = {}) {
  const actualCommand = process.platform === 'win32' && command === 'pm2'
    ? 'cmd.exe'
    : command;
  const finalArgs = process.platform === 'win32' && command === 'pm2'
    ? ['/d', '/s', '/c', ['pm2', ...args].join(' ')]
    : args;
  const result = spawnSync(actualCommand, finalArgs, {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const err = new Error(`${command} ${args.join(' ')} failed with status ${result.status}${result.error ? `: ${result.error.message}` : ''}`);
    err.status = result.status;
    err.cause = result.error;
    throw err;
  }
}

function pidExists(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return;
  if (!pidExists(numeric)) return;
  try {
    process.kill(numeric, 'SIGTERM');
  } catch {}
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (!pidExists(numeric)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    process.kill(numeric, 'SIGKILL');
  } catch {}
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cleanupRuntimeLocks({ dataDir, profile }) {
  const absoluteDataDir = path.resolve(dataDir);
  fs.mkdirSync(absoluteDataDir, { recursive: true });
  const lockFiles = fs.readdirSync(absoluteDataDir)
    .filter((name) => name.startsWith(`runtime-${profile}`) && name.endsWith('.lock'))
    .map((name) => path.join(absoluteDataDir, name))
    .filter((file) => path.resolve(file).startsWith(absoluteDataDir));

  const ownerPids = new Set();
  for (const file of lockFiles) {
    const payload = readJson(file);
    if (payload && payload.pid) ownerPids.add(Number(payload.pid));
  }

  for (const pid of ownerPids) {
    killPid(pid);
  }

  for (const file of lockFiles) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

function main() {
  const appName = process.argv[2] || 'dex-bot';
  const profile = process.argv[3] || 'live';
  const port = process.argv[4] || process.env.PORT || '3002';
  const dataDir = process.env.BOT_DATA_DIR || 'data';

  console.log(`[pm2-safe-restart] stopping ${appName}`);
  run('pm2', ['stop', appName], { stdio: 'inherit' });

  console.log(`[pm2-safe-restart] cleaning runtime locks profile=${profile} port=${port}`);
  cleanupRuntimeLocks({ dataDir, profile });

  console.log(`[pm2-safe-restart] recreating ${appName} from ecosystem.config.js`);
  try {
    run('pm2', ['delete', appName], { stdio: 'inherit' });
  } catch (_) {}
  run('pm2', ['start', 'ecosystem.config.js', '--only', appName, '--env', 'production']);
}

if (require.main === module) {
  main();
}

module.exports = {
  cleanupRuntimeLocks,
};
