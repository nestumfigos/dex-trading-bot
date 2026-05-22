#!/usr/bin/env node
'use strict';

/**
 * SQL Express has a 10GB-per-DB hard limit. The Agent database hit this and started
 * rejecting inserts ("filegroup full"). This script frees space by:
 *   1. Identifying the largest tables
 *   2. Deleting rows older than the configured retention window
 *   3. Reclaiming space via DBCC SHRINKFILE so newly freed pages are usable
 *
 * Defaults are safe: only telemetry/log tables are pruned, and trade ledger /
 * positions / lessons / strategy versions are NEVER touched.
 *
 * Usage: node scripts/sql-cleanup.js [--days=14] [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const sql = require('mssql');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const hoursArg = args.find((a) => a.startsWith('--hours='));
const daysArg = args.find((a) => a.startsWith('--days='));
const RETENTION_HOURS = hoursArg
  ? parseInt(hoursArg.split('=')[1], 10)
  : (daysArg ? parseInt(daysArg.split('=')[1], 10) * 24 : 24);

// Per-table retention overrides for high-churn telemetry. These are aggressive because
// SQL Express is capped at 10GB and signal-class tables saturate it within ~36 hours.
// Trade ledger, positions, lessons are NEVER touched — they're the historical record.
const PRUNE_TABLES = [
  { table: 'dbo.signals',                 tsColumn: 'ts',  label: 'signals',                  retentionHours: 12 },
  { table: 'dbo.model_predictions',       tsColumn: 'ts',  label: 'model predictions',        retentionHours: 24 },
  { table: 'dbo.model_feature_store',     tsColumn: 'ts',  label: 'model feature store',      retentionHours: 24 },
  { table: 'dbo.multi_agent_decisions',   tsColumn: 'ts',  label: 'hybrid route decisions',   retentionHours: 24 },
  { table: 'dbo.sentiment_snapshots',     tsColumn: 'ts',  label: 'sentiment snapshots',      retentionHours: 24 },
  { table: 'dbo.decision_log',            tsColumn: 'ts',  label: 'decision log',             retentionHours: 72 },
  { table: 'dbo.bot_state_snapshots',     tsColumn: 'ts',  label: 'state snapshots',          retentionHours: 48 },
  { table: 'dbo.bot_pnl_history',         tsColumn: 'ts',  label: 'pnl history',              retentionHours: 168 },
  { table: 'dbo.position_snapshots',      tsColumn: 'ts',  label: 'position snapshots',       retentionHours: 168 },
  { table: 'dbo.self_evolution_history',  tsColumn: 'ts',  label: 'evolution history',        retentionHours: 168 },
];

async function main() {
  const conn = String(process.env.SQL_CONNECTION_STRING || '').trim();
  if (!conn) {
    console.error('SQL_CONNECTION_STRING is empty.');
    process.exit(1);
  }

  console.log(`SQL cleanup — default retention ${RETENTION_HOURS}h, per-table overrides apply, dry-run=${dryRun}`);
  // Default connect, then bump per-pool requestTimeout. Default 15s isn't enough for
  // batch deletes on a 10GB DB so we lift to 10 min.
  const REQUEST_TIMEOUT_MS = 600000;
  const pool = await sql.connect(conn);
  if (pool && pool.config) {
    pool.config.requestTimeout = REQUEST_TIMEOUT_MS;
  }

  // Show current size before
  const sizeBefore = await pool.request().query(`
    SELECT name, size * 8.0 / 1024 AS size_mb
    FROM sys.database_files WHERE type_desc = 'ROWS'
  `);
  console.log(`\nBefore: ${sizeBefore.recordset[0]?.size_mb?.toFixed(0)}MB`);

  // Show top 10 tables by row count
  const topTables = await pool.request().query(`
    SELECT TOP 10
      s.name + '.' + t.name AS full_name,
      SUM(p.rows) AS row_count
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
    GROUP BY s.name, t.name
    ORDER BY SUM(p.rows) DESC
  `);
  console.log('\nLargest tables (by row count):');
  console.table(topTables.recordset);

  let totalDeleted = 0;
  for (const { table, tsColumn, label, retentionHours } of PRUNE_TABLES) {
    const hours = Number.isFinite(retentionHours) ? retentionHours : RETENTION_HOURS;
    try {
      const countReq = new sql.Request(pool);
      countReq.input('hours', sql.Int, hours);
      const countQ = await countReq.query(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${tsColumn} < DATEADD(hour, -@hours, SYSUTCDATETIME())`);
      const cnt = Number(countQ.recordset[0]?.cnt || 0);
      if (cnt === 0) {
        console.log(`  ${label}: 0 rows older than ${hours}h, skipping`);
        continue;
      }
      console.log(`  ${label}: ${cnt} rows older than ${hours}h ${dryRun ? '(dry-run, not deleted)' : '...'}`);
      if (dryRun) continue;

      let deleted = 0;
      let batch;
      do {
        const delReq = new sql.Request(pool);
        delReq.input('hours', sql.Int, hours);
        batch = await delReq.query(`DELETE TOP (5000) FROM ${table} WHERE ${tsColumn} < DATEADD(hour, -@hours, SYSUTCDATETIME())`);
        deleted += batch.rowsAffected[0] || 0;
      } while ((batch.rowsAffected[0] || 0) > 0);
      totalDeleted += deleted;
      console.log(`    ✔ deleted ${deleted}`);
    } catch (err) {
      console.warn(`    ✗ ${label} failed: ${err.message}`);
    }
  }

  if (!dryRun && totalDeleted > 0) {
    console.log('\nReclaiming space (DBCC SHRINKFILE)...');
    try {
      const shrinkReq = new sql.Request(pool);
      await shrinkReq.query(`DBCC SHRINKFILE (N'Agent', 8000)`); // target 8GB
      console.log('  ✔ shrink complete');
    } catch (err) {
      console.warn(`  shrink failed: ${err.message}`);
    }
  }

  const sizeAfter = await pool.request().query(`
    SELECT name, size * 8.0 / 1024 AS size_mb
    FROM sys.database_files WHERE type_desc = 'ROWS'
  `);
  console.log(`\nAfter: ${sizeAfter.recordset[0]?.size_mb?.toFixed(0)}MB`);
  console.log(`Total rows deleted: ${totalDeleted}`);

  await pool.close();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(2);
});
