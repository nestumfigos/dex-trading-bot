'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAIN_ROOT = path.resolve(__dirname, '..');
const MAIN_APP = process.env.MAIN_APP_NAME || 'dex-bot';
const ROLLOUT_PATH = path.join(MAIN_ROOT, 'data', 'evolution-live-rollout.json');

function runInherit(cwd, cmd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function main() {
  if (!fs.existsSync(ROLLOUT_PATH)) {
    throw new Error(`No rollout file found at ${ROLLOUT_PATH}`);
  }
  const rollout = JSON.parse(fs.readFileSync(ROLLOUT_PATH, 'utf8'));
  if (!Array.isArray(rollout.files) || !rollout.files.length) {
    throw new Error('Rollout file does not contain restorable files');
  }

  for (const file of rollout.files.slice().reverse()) {
    if (!file?.backupPath || !file?.targetPath) continue;
    const backupPath = path.resolve(MAIN_ROOT, file.backupPath);
    const targetPath = path.resolve(MAIN_ROOT, file.targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(backupPath, targetPath);
    console.log(`[rollback] restored ${file.targetPath}`);
  }

  rollout.rollback = {
    executedAt: new Date().toISOString(),
    reason: process.env.ROLLBACK_REASON || 'automatic_live_rollback',
  };
  fs.writeFileSync(ROLLOUT_PATH, `${JSON.stringify(rollout, null, 2)}\n`, 'utf8');
  runInherit(MAIN_ROOT, `pm2 restart ${MAIN_APP} --update-env`);
  console.log('[rollback] live bot restarted after rollback');
}

try {
  main();
} catch (error) {
  console.error(`[rollback] Failed: ${error.message}`);
  process.exit(1);
}
