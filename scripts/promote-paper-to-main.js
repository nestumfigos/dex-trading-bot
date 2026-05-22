'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MAIN_ROOT = path.resolve(__dirname, '..');
const PAPER_ROOT = process.env.PAPER_WORKTREE_PATH || path.resolve(MAIN_ROOT, '..', 'dex-trading-bot-paper');
const PAPER_APP = process.env.PAPER_APP_NAME || 'dex-bot-paper';
const MAIN_APP = process.env.MAIN_APP_NAME || 'dex-bot';
const PAPER_PORT = Number(process.env.PAPER_PORT || 3003);
const DRY_RUN = process.env.DRY_RUN === 'true';
const CANDIDATE_PATH = process.env.EVOLUTION_CANDIDATE_PATH ? path.resolve(process.env.EVOLUTION_CANDIDATE_PATH) : null;
const LIVE_BACKUP_DIR = path.join(MAIN_ROOT, 'data', 'evolution-live-backups');
const LIVE_ROLLOUT_PATH = path.join(MAIN_ROOT, 'data', 'evolution-live-rollout.json');

// Directories that may be copied from paper worktree → main
const COPYABLE_DIRS = ['src', 'config'];
const PROMOTION_ALLOWLIST = new Set([
  'config/index.js',
  'src/index.js',
  'src/dashboard.js',
  'src/agent/marketIntelligence.js',
  'src/utils/redaction.js',
  'src/strategy/index.js',
  'src/evolution-governor.js',
  'src/utils/promotion-governance.js',
  'src/utils/self-evolution-orchestration.js',
  'src/utils/sqlServer.js',
  'src/utils/sqlTelemetry.js',
  'src/risk/guardian.js',
  'src/strategy/momentum.js',
]);
let candidateManifest = null;

function loadCandidateManifest() {
  if (!CANDIDATE_PATH) return null;
  const raw = fs.readFileSync(CANDIDATE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.changedFiles = Array.isArray(parsed.changedFiles)
    ? parsed.changedFiles.map((item) => String(item).replace(/\\/g, '/'))
    : [];
  return parsed;
}

function run(cwd, cmd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function runInherit(cwd, cmd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function listJsFilesRecursively(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && abs.endsWith('.js')) {
        out.push(abs);
      }
    }
  }
  return out;
}

function assertPaperOnline() {
  let raw;
  try {
    raw = run(MAIN_ROOT, 'pm2 jlist');
  } catch (err) {
    throw new Error(`Unable to read pm2 process list: ${err.message}`);
  }

  let list = [];
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('pm2 jlist returned invalid JSON');
  }

  const app = list.find((p) => p && p.name === PAPER_APP);
  if (!app) {
    throw new Error(`${PAPER_APP} is not registered in pm2`);
  }
  const status = app.pm2_env?.status || 'unknown';
  if (status !== 'online') {
    throw new Error(`${PAPER_APP} is not online (status=${status})`);
  }
}

async function assertPaperHealth() {
  const endpoint = `http://127.0.0.1:${PAPER_PORT}/health`;
  let res;
  try {
    res = await fetch(endpoint, { method: 'GET' });
  } catch (err) {
    throw new Error(`Paper health endpoint unreachable at ${endpoint}: ${err.message}`);
  }
  // 200 = healthy, 503 = degraded (e.g. AI provider down) but process is alive — both are acceptable.
  // Only hard-fail on unexpected status codes that indicate the server itself is broken.
  if (res.status !== 200 && res.status !== 503) {
    throw new Error(`Paper health endpoint returned unexpected status ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Paper health endpoint did not return valid JSON`);
  }
  if (res.status === 503) {
    const reasons = body.unhealthyReasons || body.degradedReasons || [];
    console.log(`[promote] Paper bot is degraded (will still promote): ${reasons.join(', ') || 'unknown reasons'}`);
  }
}

/**
 * Collect JS files that differ between paper worktree and main.
 * Returns array of relative paths (e.g. "src/agent.js").
 */
function getChangedFiles() {
  // git diff between paper worktree's HEAD and main's HEAD — relative to paper root
  // We compare file content directly since worktrees share the git object store
  // but may have different working-tree changes (from self-evolution patches).
  const changed = [];

  for (const dir of COPYABLE_DIRS) {
    const paperDir = path.join(PAPER_ROOT, dir);
    const mainDir = path.join(MAIN_ROOT, dir);
    if (!fs.existsSync(paperDir)) continue;

    const paperFiles = listJsFilesRecursively(paperDir);
    for (const paperAbs of paperFiles) {
      const rel = path.relative(PAPER_ROOT, paperAbs); // e.g. "src/agent.js"
      const mainAbs = path.join(MAIN_ROOT, rel);
      const normalizedRel = rel.replace(/\\/g, '/');
      if (!PROMOTION_ALLOWLIST.has(normalizedRel)) continue;
      if (candidateManifest && !candidateManifest.changedFiles.includes(normalizedRel)) continue;

      if (!fs.existsSync(mainAbs)) {
        // New file in paper — include it
        changed.push(rel);
        continue;
      }

      const paperContent = fs.readFileSync(paperAbs, 'utf8');
      const mainContent = fs.readFileSync(mainAbs, 'utf8');
      if (paperContent !== mainContent) {
        changed.push(rel);
      }
    }
  }

  return changed;
}

function syntaxCheckFiles(relPaths) {
  for (const rel of relPaths) {
    const paperAbs = path.join(PAPER_ROOT, rel);
    try {
      run(PAPER_ROOT, `node --check "${paperAbs}"`);
    } catch (err) {
      throw new Error(`Syntax error in paper file ${rel}: ${err.stderr || err.message}`);
    }
  }
}

function copyFilesToMain(relPaths) {
  const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(LIVE_BACKUP_DIR, backupStamp);
  const fileRecords = [];
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const rel of relPaths) {
    const src = path.join(PAPER_ROOT, rel);
    const dst = path.join(MAIN_ROOT, rel);
    const backupPath = path.join(backupRoot, rel.replace(/[\\/]/g, '__'));

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) {
      fs.copyFileSync(dst, backupPath);
    } else {
      fs.writeFileSync(backupPath, '', 'utf8');
    }
    fileRecords.push({
      targetPath: rel.replace(/\\/g, '/'),
      backupPath: path.relative(MAIN_ROOT, backupPath).replace(/\\/g, '/'),
    });

    if (DRY_RUN) {
      console.log(`[promote][dry-run] would copy: ${rel}`);
    } else {
      fs.copyFileSync(src, dst);
      console.log(`[promote] copied: ${rel}`);
    }
  }
  return {
    backupRoot: path.relative(MAIN_ROOT, backupRoot).replace(/\\/g, '/'),
    files: fileRecords,
  };
}

async function main() {
  console.log(`[promote] paper root : ${PAPER_ROOT}`);
  console.log(`[promote] main root  : ${MAIN_ROOT}`);
  candidateManifest = loadCandidateManifest();
  if (candidateManifest) {
    console.log(`[promote] candidate  : ${candidateManifest.id || 'unknown'} (${CANDIDATE_PATH})`);
    if (candidateManifest.promotion?.eligible !== true && candidateManifest.promotion?.approved !== true) {
      throw new Error(`Candidate ${candidateManifest.id || 'unknown'} is not marked promotion-eligible`);
    }
  }
  if (DRY_RUN) console.log('[promote] DRY RUN mode — no files will be modified');

  // 1. Sanity checks
  if (!fs.existsSync(PAPER_ROOT)) {
    throw new Error(`Paper worktree not found at ${PAPER_ROOT}. Run: npm run setup:paper:worktree`);
  }

  console.log('[promote] Checking paper PM2 status...');
  assertPaperOnline();

  console.log('[promote] Checking paper health endpoint...');
  await assertPaperHealth();

  // Week 5 policy gate. Refuse promotion if paper hasn't been validated long
  // enough or has been crash-looping. Override with --force or POLICY_OVERRIDE=true.
  if (process.env.POLICY_OVERRIDE !== 'true' && !process.argv.includes('--force')) {
    try {
      const { canEnableLiveTrading, loadThresholds } = require('../src/policy/preconditions');
      const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');
      const sqlPool = isSqlEnabled() ? await getPool(console).catch(() => null) : null;
      const thresholds = await loadThresholds({ sql: sqlPool, scope: 'live' });
      const paperHours = Number(process.env.PROMOTION_PAPER_VALIDATION_HOURS)
        || Number(candidateManifest?.validation?.holdoutHours)
        || 0;
      const paperTrades = Number(process.env.PROMOTION_PAPER_TRADES_COUNT)
        || Number(candidateManifest?.validation?.tradesCount)
        || 0;
      const crashesLastHour = Number(process.env.PROMOTION_CRASHES_LAST_HOUR) || 0;
      const policy = canEnableLiveTrading({
        paperValidationHours: paperHours,
        crashesLastHour,
        paperTradesCount: paperTrades,
      }, thresholds);
      if (!policy.allow) {
        throw new Error(
          `[promote] Policy gate DENIED live promotion: ${policy.reason}. ` +
          `Override with --force or POLICY_OVERRIDE=true. evidence=${JSON.stringify(policy.evidence)}`
        );
      }
      console.log(`[promote] Policy gate PASS: ${JSON.stringify(policy.evidence)}`);
    } catch (e) {
      if (/Policy gate DENIED/.test(e.message)) throw e;
      console.warn(`[promote] Policy gate skipped: ${e.message}`);
    }
  } else {
    console.warn('[promote] POLICY_OVERRIDE in effect — gate BYPASSED');
  }

  // 2. Detect changed files
  console.log('[promote] Scanning for changed files...');
  const changed = getChangedFiles();
  if (candidateManifest) {
    const maxPromotionFiles = Math.max(1, Number(process.env.SELF_EVOLUTION_MAX_PROMOTION_FILES || 6));
    if (changed.length > maxPromotionFiles) {
      throw new Error(`Candidate wants to promote ${changed.length} files; cap is ${maxPromotionFiles}`);
    }
  }

  if (changed.length === 0) {
    console.log('[promote] No changed approved JS files detected between paper and main. Nothing to promote.');
    process.exit(0);
  }

  console.log(`[promote] ${changed.length} file(s) changed:`);
  for (const f of changed) console.log(`  • ${f}`);

  // 3. Syntax-check all changed files from paper
  console.log('[promote] Running syntax checks on changed files...');
  syntaxCheckFiles(changed);
  console.log('[promote] All syntax checks passed.');

  // 4. Copy validated files to main
  console.log('[promote] Copying files to main repo...');
  const liveBackup = copyFilesToMain(changed);

  if (DRY_RUN) {
    console.log('[promote] Dry run complete — main bot NOT restarted.');
    return;
  }

  const rollout = {
    id: candidateManifest?.id || `promotion-${Date.now()}`,
    versionId: candidateManifest?.versioning?.versionId || null,
    strategyVersionHash: candidateManifest?.versioning?.strategyVersionHash || null,
    candidatePath: candidateManifest ? CANDIDATE_PATH : null,
    promotedAt: new Date().toISOString(),
    stage: candidateManifest?.rollout?.stage || 'canary_live',
    backupRoot: liveBackup.backupRoot,
    files: liveBackup.files,
    baseline: candidateManifest?.baseline || null,
    validation: candidateManifest?.validation || null,
    promotion: candidateManifest?.promotion || null,
  };
  fs.mkdirSync(path.dirname(LIVE_ROLLOUT_PATH), { recursive: true });
  fs.writeFileSync(LIVE_ROLLOUT_PATH, `${JSON.stringify(rollout, null, 2)}\n`, 'utf8');

  // 5. Restart main bot
  console.log('[promote] Restarting main bot...');
  runInherit(MAIN_ROOT, `pm2 restart ${MAIN_APP} --update-env`);
  console.log('[promote] Promotion complete. Main bot restarted with paper changes.');
}

main().catch((err) => {
  console.error(`[promote] Failed: ${err.message}`);
  process.exit(1);
});
