'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LIVE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOTS = Object.freeze({
  live: LIVE_ROOT,
  paper: path.resolve(LIVE_ROOT, '..', 'dex-trading-bot-paper'),
  perps: path.resolve(LIVE_ROOT, '..', 'dex-trading-bot-perps'),
});

const MILESTONES = Object.freeze([
  {
    id: 'shared_core_contracts',
    label: 'Shared core contracts exist across all profiles',
    weight: 10,
    checks: [
      ['live', 'packages/core/index.js'],
      ['live', 'packages/core/risk/risk-contract.js'],
      ['live', 'packages/core/execution/order-lifecycle.js'],
      ['live', 'packages/core/governance/promotion-gates.js'],
      ['paper', 'packages/core/index.js'],
      ['perps', 'packages/core/index.js'],
    ],
  },
  {
    id: 'sql_control_plane',
    label: 'V2 SQL control plane and governance migrations exist',
    weight: 12,
    checks: [
      ['live', 'db/migrations/0027_v2_control_plane.sql'],
      ['live', 'db/migrations/0028_ai_governance.sql'],
      ['live', 'db/migrations/0029_perps_control_plane_views.sql'],
      ['live', 'db/rollbacks/0027_v2_control_plane.sql'],
      ['live', 'db/rollbacks/0028_ai_governance.sql'],
      ['live', 'db/rollbacks/0029_perps_control_plane_views.sql'],
    ],
  },
  {
    id: 'perps_sql_authority',
    label: 'Perps writes and restores through the shared SQL control plane',
    weight: 10,
    checks: [
      ['perps', 'src/telemetry/perps-sql-telemetry.js'],
      ['perps', 'src/runtime/perps-sql-restore.js'],
      ['perps', 'scripts/backfill-perps-sql-telemetry.js'],
      ['perps', 'scripts/restore-perps-state-from-sql.js'],
      ['perps', 'test/perps-sql-telemetry.test.js'],
      ['perps', 'test/perps-sql-restore.test.js'],
    ],
  },
  {
    id: 'risk_execution_hardening',
    label: 'Risk, execution, reconciliation, funding, and canary safety are hardened',
    weight: 12,
    checks: [
      ['live', 'src/risk/v2-risk-audit.js'],
      ['live', 'test/risk/v2-risk-audit.test.js'],
      ['perps', 'src/exchanges/binance-perps-execution-adapter.js'],
      ['perps', 'src/exchanges/binance-perps-reconciliation.js'],
      ['perps', 'src/exchanges/binance-perps-funding.js'],
      ['perps', 'src/risk/perps-live-canary-policy.js'],
    ],
  },
  {
    id: 'config_and_runtime_safety',
    label: 'Config provenance, parity, singleton ownership, and startup guards are enforced',
    weight: 8,
    checks: [
      ['live', 'src/config/schema.js'],
      ['live', 'scripts/pm2-safe-restart.js'],
      ['live', 'test/config-schema.test.js'],
      ['perps', 'src/runtime/perps-singleton.js'],
      ['perps', 'scripts/pm2-safe-restart.js'],
      ['perps', 'ecosystem.config.js'],
    ],
  },
  {
    id: 'observability',
    label: 'Dashboard, SQL reports, smoke checks, and Prometheus readiness metrics are present',
    weight: 10,
    checks: [
      ['live', 'src/dashboard.js'],
      ['paper', 'src/dashboard.js'],
      ['live', 'scripts/v2-platform-smoke.js', 'trading_bot_perps_live_readiness_gate_passed'],
      ['live', 'packages/core/telemetry/prometheus.js', 'buildReadinessGateMetrics'],
      ['perps', 'src/server.js', 'buildReadinessGateMetrics'],
      ['live', 'test/dashboard-v2-report.test.js'],
      ['live', 'test/v2-platform-smoke.test.js'],
    ],
  },
  {
    id: 'ai_governance',
    label: 'AI/self-evolution proposals are governed by evidence and promotion gates',
    weight: 8,
    checks: [
      ['live', 'packages/core/governance/mutation-proposal.js'],
      ['live', 'packages/core/governance/promotion-gates.js'],
      ['live', 'src/utils/promotion-governance.js'],
      ['live', 'src/utils/self-evolution-orchestration.js'],
      ['live', 'test/promotion-governance.test.js'],
      ['live', 'test/self-evolution-regressions.test.js'],
    ],
  },
  {
    id: 'docker_ci_baseline',
    label: 'Docker Compose and CI smoke baselines exist for repeatable deployment',
    weight: 8,
    checks: [
      ['live', 'docker-compose.v2.yml'],
      ['live', '.github/workflows/v2-smoke.yml'],
      ['paper', '.github/workflows/v2-smoke.yml'],
      ['perps', '.github/workflows/v2-smoke.yml'],
      ['live', 'test/docker-compose-v2.test.js'],
      ['live', 'test/v2-ci-workflow.test.js'],
    ],
  },
  {
    id: 'test_coverage',
    label: 'Focused V2 test suites exist for core, telemetry, risk, routing, and perps lifecycle',
    weight: 10,
    checks: [
      ['live', 'test/core-contracts.test.js'],
      ['live', 'test/sql-telemetry-regression.test.js'],
      ['live', 'test/strategy-routing-audit.test.js'],
      ['paper', 'test/core-contracts.test.js'],
      ['perps', 'test/core-contracts.test.js'],
      ['perps', 'test/paper-milestone.test.js'],
      ['perps', 'test/traderxo-paper-strategy.test.js'],
    ],
  },
  {
    id: 'documentation',
    label: 'V2 architecture, developer workflow, Docker, and release guidance are documented',
    weight: 8,
    checks: [
      ['live', 'docs/TRADING_BOT_INFRASTRUCTURE.md', 'paper_perps'],
      ['live', 'docs/V2_DEVELOPER_WORKFLOW.md', 'perps readiness Prometheus metrics'],
      ['live', 'docs/V2_DOCKER_COMPOSE.md', 'trading_bot_perps_live_readiness_gates_blocked'],
      ['live', 'docs/V2_RELEASE_CHECKLIST.md'],
    ],
  },
  {
    id: 'release_governance',
    label: 'A single release-readiness gate scores and reports V2 foundation completion',
    weight: 4,
    checks: [
      ['live', 'scripts/v2-roadmap-readiness.js'],
      ['live', 'test/v2-roadmap-readiness.test.js'],
      ['live', 'package.json', 'ops:v2-roadmap'],
      ['live', 'docs/V2_RELEASE_CHECKLIST.md', 'npm run ops:v2-roadmap'],
    ],
  },
]);

function fileExists(root, relativePath, fsLike = fs) {
  return fsLike.existsSync(path.join(root, relativePath));
}

function fileIncludes(root, relativePath, needle, fsLike = fs) {
  if (!needle) return true;
  const fullPath = path.join(root, relativePath);
  if (!fsLike.existsSync(fullPath)) return false;
  return fsLike.readFileSync(fullPath, 'utf8').includes(needle);
}

function evaluateMilestone(milestone, {
  roots = DEFAULT_ROOTS,
  fsLike = fs,
} = {}) {
  const checks = milestone.checks.map(([profile, relativePath, contains]) => {
    const root = roots[profile];
    const exists = Boolean(root && fileExists(root, relativePath, fsLike));
    const contentOk = exists && fileIncludes(root, relativePath, contains, fsLike);
    return {
      profile,
      path: relativePath,
      contains: contains || null,
      passed: exists && contentOk,
      reason: !root ? 'profile_root_missing' : (!exists ? 'file_missing' : (!contentOk ? 'content_missing' : null)),
    };
  });
  const passed = checks.every((check) => check.passed);
  return {
    id: milestone.id,
    label: milestone.label,
    weight: milestone.weight,
    passed,
    earnedWeight: passed ? milestone.weight : 0,
    checks,
  };
}

function buildV2RoadmapReadinessReport({
  roots = DEFAULT_ROOTS,
  fsLike = fs,
  now = () => new Date().toISOString(),
} = {}) {
  const milestones = MILESTONES.map((milestone) => evaluateMilestone(milestone, { roots, fsLike }));
  const totalWeight = milestones.reduce((sum, item) => sum + item.weight, 0);
  const earnedWeight = milestones.reduce((sum, item) => sum + item.earnedWeight, 0);
  const completionPct = totalWeight > 0 ? Number(((earnedWeight / totalWeight) * 100).toFixed(2)) : 0;
  const blockers = milestones
    .filter((milestone) => !milestone.passed)
    .map((milestone) => ({
      id: milestone.id,
      label: milestone.label,
      failedChecks: milestone.checks.filter((check) => !check.passed),
    }));
  return {
    ok: blockers.length === 0,
    generatedAt: now(),
    scope: 'v2_foundation',
    completionPct,
    earnedWeight,
    totalWeight,
    milestones,
    blockers,
    note: 'This scores V2 infrastructure foundation completion. Trading promotion/live-readiness evidence remains governed separately by strategy and perps readiness gates.',
  };
}

function runPlatformSmoke({
  root = LIVE_ROOT,
  execFile = execFileSync,
} = {}) {
  try {
    const stdout = execFile(process.execPath, [path.join(root, 'scripts', 'v2-platform-smoke.js')], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? null,
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : error.message,
    };
  }
}

function parseArgs(argv) {
  return {
    json: argv.includes('--json'),
    runtime: argv.includes('--runtime'),
  };
}

function printHumanReport(report, runtimeSmoke = null) {
  const rows = report.milestones.map((milestone) => ({
    milestone: milestone.id,
    weight: milestone.weight,
    passed: milestone.passed,
  }));
  console.log(`V2 foundation completion: ${report.completionPct}% (${report.earnedWeight}/${report.totalWeight})`);
  console.table(rows);
  if (runtimeSmoke) {
    console.log(`Runtime platform smoke: ${runtimeSmoke.ok ? 'PASS' : 'FAIL'}`);
  }
  if (report.blockers.length) {
    console.error(JSON.stringify(report.blockers, null, 2));
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = buildV2RoadmapReadinessReport();
  const runtimeSmoke = args.runtime ? runPlatformSmoke() : null;
  const ok = report.ok && (!runtimeSmoke || runtimeSmoke.ok);
  if (args.json) {
    console.log(JSON.stringify({ ...report, runtimeSmoke: runtimeSmoke ? { ok: runtimeSmoke.ok } : null }, null, 2));
  } else {
    printHumanReport(report, runtimeSmoke);
  }
  if (!ok) process.exitCode = 1;
  return { report, runtimeSmoke, ok };
}

if (require.main === module) {
  main();
}

module.exports = {
  MILESTONES,
  DEFAULT_ROOTS,
  evaluateMilestone,
  buildV2RoadmapReadinessReport,
  runPlatformSmoke,
  main,
};
