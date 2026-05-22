'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAIN_ROOT = path.resolve(__dirname, '..');
const PAPER_ROOT = process.env.PAPER_WORKTREE_PATH || path.resolve(MAIN_ROOT, '..', 'dex-trading-bot-paper');

function run(cwd, cmd) {
  return execSync(cmd, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function runInherit(cwd, cmd) {
  execSync(cmd, {
    cwd,
    stdio: 'inherit',
  });
}

function ensureGitRepo() {
  try {
    run(MAIN_ROOT, 'git rev-parse --is-inside-work-tree');
  } catch (err) {
    throw new Error(`Main directory is not a git repo: ${err.message}`);
  }
}

function ensureWorktree() {
  if (fs.existsSync(PAPER_ROOT)) {
    let isValid = false;
    try {
      run(PAPER_ROOT, 'git rev-parse --git-dir');
      isValid = true;
    } catch (_) {
      isValid = false;
    }

    if (!isValid) {
      repairOrRecreateWorktree();
    }
    return;
  }

  fs.mkdirSync(path.dirname(PAPER_ROOT), { recursive: true });
  runInherit(MAIN_ROOT, `git worktree add "${PAPER_ROOT}" --detach HEAD`);
}

function repairOrRecreateWorktree() {
  console.warn('[paper-worktree] Worktree directory exists but is broken - attempting repair...');

  try {
    runInherit(MAIN_ROOT, 'git worktree repair');
    run(PAPER_ROOT, 'git rev-parse --git-dir');
    console.log('[paper-worktree] Worktree repaired via git worktree repair');
    return;
  } catch (_) {
    console.warn('[paper-worktree] git worktree repair insufficient - falling back to full recreate');
  }

  try { runInherit(MAIN_ROOT, 'git worktree prune'); } catch (_) { /* best effort */ }
  try { fs.rmSync(PAPER_ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }

  runInherit(MAIN_ROOT, `git worktree add "${PAPER_ROOT}" --detach HEAD`);
  console.log('[paper-worktree] Worktree recreated from scratch');
}

function ensureDotEnv() {
  const src = path.join(MAIN_ROOT, '.env');
  const dst = path.join(PAPER_ROOT, '.env');
  if (!fs.existsSync(src) || fs.existsSync(dst)) return;
  fs.copyFileSync(src, dst);
}

function ensureDependencies() {
  const nodeModules = path.join(PAPER_ROOT, 'node_modules');
  if (fs.existsSync(nodeModules)) return;
  runInherit(PAPER_ROOT, 'npm install');
}

function main() {
  ensureGitRepo();
  ensureWorktree();
  ensureDotEnv();
  ensureDependencies();
  console.log(`[paper-worktree] Ready at ${PAPER_ROOT}`);
}

try {
  main();
} catch (err) {
  console.error(`[paper-worktree] Failed: ${err.message}`);
  process.exit(1);
}
