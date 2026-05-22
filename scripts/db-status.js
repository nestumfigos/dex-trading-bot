#!/usr/bin/env node
'use strict';

// Migration history + table inventory + drift detection.
//
// Usage:
//   node scripts/db-status.js
//   node scripts/db-status.js --json

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');

const JSON_OUT = process.argv.includes('--json');
const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

function fileSha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

async function main() {
  if (!isSqlEnabled()) { console.error('[db-status] SQL not configured.'); process.exit(2); }
  const pool = await getPool();

  // Applied migrations
  const r = await pool.request().query(`
    SELECT version, name, checksum, applied_at, applied_by, duration_ms
      FROM dbo.schema_migrations
     ORDER BY version
  `);
  const applied = r.recordset || [];

  // Filesystem migrations
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  // Cross-reference: drift, missing applied, missing on disk
  const drift = [];
  const fileSet = new Set(files);
  for (const a of applied) {
    const fname = `${a.version}_${a.name}.sql`;
    const onDisk = fileSet.has(fname);
    if (!onDisk) {
      drift.push({ version: a.version, kind: 'missing_on_disk', detail: fname });
      continue;
    }
    const liveSha = fileSha256(path.join(MIGRATIONS_DIR, fname));
    if (a.checksum && a.checksum !== liveSha) {
      drift.push({ version: a.version, kind: 'checksum_drift', detail: `db=${a.checksum.slice(0, 12)} disk=${liveSha.slice(0, 12)}` });
    }
  }
  const appliedSet = new Set(applied.map((a) => a.version));
  for (const f of files) {
    const ver = f.slice(0, 4);
    if (!appliedSet.has(ver)) {
      drift.push({ version: ver, kind: 'pending', detail: f });
    }
  }

  // Table inventory
  const tables = await pool.request().query(`
    SELECT t.name AS table_name,
           SUM(p.rows) AS row_count
      FROM sys.tables t
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
     WHERE t.schema_id = SCHEMA_ID('dbo')
     GROUP BY t.name
     ORDER BY t.name
  `);

  if (JSON_OUT) {
    console.log(JSON.stringify({ applied, drift, tables: tables.recordset }, null, 2));
    process.exit(0);
  }

  console.log(`\n[db-status] ${applied.length} applied / ${files.length} on disk\n`);
  console.log('  VER   NAME                            APPLIED_AT          DUR     STATUS');
  console.log('  ----- ------------------------------- ------------------- ------- --------');
  for (const a of applied) {
    const fname = `${a.version}_${a.name}.sql`;
    const onDisk = fileSet.has(fname);
    let status = 'OK';
    if (!onDisk) status = 'MISSING_DISK';
    else if (a.checksum) {
      const liveSha = fileSha256(path.join(MIGRATIONS_DIR, fname));
      if (a.checksum !== liveSha) status = 'DRIFT';
    }
    const when = new Date(a.applied_at).toISOString().slice(0, 19).replace('T', ' ');
    console.log(`  ${a.version} ${String(a.name).padEnd(31).slice(0, 31)} ${when} ${String(a.duration_ms || '?').padStart(5)}ms ${status}`);
  }
  for (const f of files) {
    const ver = f.slice(0, 4);
    if (!appliedSet.has(ver)) {
      const name = f.slice(5, -4);
      console.log(`  ${ver} ${name.padEnd(31).slice(0, 31)} (pending)                              PENDING`);
    }
  }

  if (drift.length > 0) {
    console.log(`\n[db-status] ⚠ ${drift.length} drift / pending`);
    for (const d of drift) console.log(`  • ${d.version} ${d.kind}: ${d.detail}`);
  }

  console.log(`\n[db-status] table inventory:`);
  console.log('  TABLE                                    ROWS');
  console.log('  ---------------------------------------- --------');
  for (const t of (tables.recordset || [])) {
    console.log(`  ${String(t.table_name).padEnd(40)} ${String(t.row_count || 0).padStart(8)}`);
  }

  process.exit(drift.some((d) => d.kind === 'checksum_drift' || d.kind === 'missing_on_disk') ? 1 : 0);
}

main().catch((e) => { console.error(`[db-status] fatal: ${e?.stack || e}`); process.exit(1); });
