'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  MILESTONES,
  buildV2RoadmapReadinessReport,
} = require('../scripts/v2-roadmap-readiness');

function makeFs(files) {
  const normalized = new Map(
    Object.entries(files).map(([filePath, content]) => [path.normalize(filePath), content]),
  );
  return {
    existsSync(filePath) {
      return normalized.has(path.normalize(filePath));
    },
    readFileSync(filePath) {
      const key = path.normalize(filePath);
      if (!normalized.has(key)) throw new Error(`missing ${filePath}`);
      return normalized.get(key);
    },
  };
}

function filesForAllMilestones(roots) {
  const files = {};
  for (const milestone of MILESTONES) {
    for (const [profile, relativePath, contains] of milestone.checks) {
      files[path.join(roots[profile], relativePath)] = contains || 'present';
    }
  }
  return files;
}

test('v2 roadmap readiness reports 100 percent when all foundation artifacts exist', () => {
  const roots = {
    live: 'C:\\repo\\live',
    paper: 'C:\\repo\\paper',
    perps: 'C:\\repo\\perps',
  };
  const report = buildV2RoadmapReadinessReport({
    roots,
    fsLike: makeFs(filesForAllMilestones(roots)),
    now: () => '2026-06-12T00:00:00.000Z',
  });

  assert.equal(report.ok, true);
  assert.equal(report.completionPct, 100);
  assert.equal(report.earnedWeight, report.totalWeight);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.scope, 'v2_foundation');
});

test('v2 roadmap readiness identifies missing milestone artifacts without hiding detail', () => {
  const roots = {
    live: 'C:\\repo\\live',
    paper: 'C:\\repo\\paper',
    perps: 'C:\\repo\\perps',
  };
  const files = filesForAllMilestones(roots);
  delete files[path.join(roots.perps, 'src/telemetry/perps-sql-telemetry.js')];

  const report = buildV2RoadmapReadinessReport({
    roots,
    fsLike: makeFs(files),
  });

  assert.equal(report.ok, false);
  assert.ok(report.completionPct < 100);
  const blocker = report.blockers.find((item) => item.id === 'perps_sql_authority');
  assert.ok(blocker);
  assert.equal(blocker.failedChecks.length, 1);
  assert.equal(blocker.failedChecks[0].path, 'src/telemetry/perps-sql-telemetry.js');
  assert.equal(blocker.failedChecks[0].reason, 'file_missing');
});

test('v2 roadmap readiness treats required content markers as real checks', () => {
  const roots = {
    live: 'C:\\repo\\live',
    paper: 'C:\\repo\\paper',
    perps: 'C:\\repo\\perps',
  };
  const files = filesForAllMilestones(roots);
  files[path.join(roots.live, 'scripts/v2-platform-smoke.js')] = 'missing metric marker';

  const report = buildV2RoadmapReadinessReport({
    roots,
    fsLike: makeFs(files),
  });

  const blocker = report.blockers.find((item) => item.id === 'observability');
  assert.ok(blocker);
  assert.equal(blocker.failedChecks[0].path, 'scripts/v2-platform-smoke.js');
  assert.equal(blocker.failedChecks[0].reason, 'content_missing');
});
