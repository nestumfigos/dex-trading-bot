#!/usr/bin/env node
'use strict';

// B6.migration-runner: Phase-B migration helper.
//
// Phase B added two SQL migrations:
//   M0025 _schema_version singleton pin
//   M0026 regime_patterns IX with WHERE active=1
//
// This script wraps the standard migrate() runner with a Phase-B-specific
// pre-check: it ensures the live DB is at or below 0024 before applying, and
// emits a clear "you're already up to date" message when 0026 is already
// recorded. Safe to re-run.
//
// Usage:
//   node scripts/apply-phase-b-migrations.js
//   node scripts/apply-phase-b-migrations.js --dry-run

require('dotenv').config();

const { migrate, status, assertCriticalTables } = require('../src/utils/migrations');

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const logger = console;
  process.env.SQL_ENABLED = 'true';
  try {
    logger.info('[apply-phase-b] pre-check status…');
    const pre = await status({ logger });
    const appliedVersions = (pre.applied || []).map((a) => a.version);
    const has0025 = appliedVersions.includes('0025');
    const has0026 = appliedVersions.includes('0026');
    if (has0025 && has0026) {
      logger.info('[apply-phase-b] both M0025 and M0026 already applied — nothing to do.');
      process.exit(0);
    }
    logger.info(`[apply-phase-b] applying Phase B migrations${dryRun ? ' (dry-run)' : ''}…`);
    const result = await migrate({ logger, dryRun });
    logger.info(`[apply-phase-b] applied=${result.applied.length} skipped=${result.skipped.length}`);
    if (!dryRun) {
      logger.info('[apply-phase-b] verifying critical tables…');
      await assertCriticalTables({ logger });
      logger.info('[apply-phase-b] DONE.');
    }
    process.exit(0);
  } catch (err) {
    logger.error(`[apply-phase-b] FAILED: ${err.message}`);
    process.exit(1);
  }
})();
