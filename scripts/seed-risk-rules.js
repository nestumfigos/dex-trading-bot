#!/usr/bin/env node
'use strict';

// Seed dbo.risk_rules from the pre-trade contract gate catalog.
// Idempotent UPSERT. Re-run after adding a gate to publish it to the DB
// without overwriting human edits to severity/enabled.
//
// Usage:
//   node scripts/seed-risk-rules.js --dry-run
//   node scripts/seed-risk-rules.js                 # both live + paper + global
//   node scripts/seed-risk-rules.js --scope=live    # one scope
//   node scripts/seed-risk-rules.js --force         # overwrite human edits

require('dotenv').config();

const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');
const { GATE_CATALOG } = require('../src/risk/pre-trade-contract');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const FORCE = args.includes('--force');
const SCOPE_ARG = (args.find((a) => a.startsWith('--scope=')) || '').split('=')[1] || null;

async function upsertRule(pool, { name, scope, severity, description }) {
  const req = pool.request();
  req.input('name',        sql.NVarChar(64),  name);
  req.input('scope',       sql.NVarChar(32),  scope);
  req.input('severity',    sql.NVarChar(16),  severity);
  req.input('description', sql.NVarChar(512), description);
  req.input('source',      sql.NVarChar(64),  'seed');

  // FORCE = overwrite severity/enabled too. Default = INSERT only if missing.
  const updateClause = FORCE
    ? `
      UPDATE SET
        severity    = src.severity,
        description = src.description,
        source      = src.source,
        updated_at  = SYSUTCDATETIME()`
    : `
      UPDATE SET
        description = src.description,
        updated_at  = SYSUTCDATETIME()`;

  await req.query(`
    MERGE dbo.risk_rules AS tgt
    USING (SELECT @name AS name, @scope AS scope, @severity AS severity,
                  @description AS description, @source AS source) AS src
       ON tgt.name = src.name AND tgt.scope = src.scope
    WHEN MATCHED THEN
${updateClause}
    WHEN NOT MATCHED THEN
      INSERT (name, scope, severity, enabled, description, source)
      VALUES (src.name, src.scope, src.severity, 1, src.description, src.source);
  `);
}

async function seedScope(pool, scope) {
  console.log(`[seed-risk-rules] ${scope}: ${GATE_CATALOG.length} gates → risk_rules`);

  for (const g of GATE_CATALOG) {
    const severity = 'block'; // all gates default to block; ops can downgrade per scope
    if (DRY) {
      console.log(`  [DRY] ${g.name} (severity=${severity})`);
      continue;
    }
    try {
      await upsertRule(pool, { name: g.name, scope, severity, description: g.description });
      console.log(`  ✓ ${g.name}`);
    } catch (e) {
      console.error(`  ✗ ${g.name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  if (!isSqlEnabled()) {
    console.error('[seed-risk-rules] SQL not configured (SQL_CONNECTION_STRING). Aborting.');
    process.exit(2);
  }

  const pool = await getPool();
  const scopes = SCOPE_ARG ? [SCOPE_ARG] : ['live', 'paper', 'global'];

  for (const scope of scopes) {
    try {
      await seedScope(pool, scope);
    } catch (e) {
      console.error(`[seed-risk-rules] ${scope}: failed: ${e.message}`);
      process.exitCode = 1;
    }
  }

  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(`[seed-risk-rules] fatal: ${e?.stack || e}`);
  process.exit(1);
});
