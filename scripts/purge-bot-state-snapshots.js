#!/usr/bin/env node
'use strict';

// B6.purge-bss: delete bot_state_snapshots older than `--days` (default 14)
// then shrink the data file so SQL Express has room to apply pending
// migrations. Safe by default — dry-run unless --apply is passed.

require('dotenv').config();
const { getPool, sql } = require('../src/utils/sqlServer');

(async () => {
  const apply = process.argv.includes('--apply');
  const daysIdx = process.argv.indexOf('--days');
  const retainDays = daysIdx >= 0 ? Number(process.argv[daysIdx + 1]) : 14;
  process.env.SQL_ENABLED = 'true';
  const pool = await getPool(console);
  if (!pool) throw new Error('SQL pool unavailable');

  console.log(`[purge-bss] retainDays=${retainDays} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  // Pre-stats.
  const preRows = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.bot_state_snapshots`);
  const preSize = await pool.request().query(`
    SELECT SUM(a.total_pages) * 8 / 1024 AS total_mb
    FROM sys.tables t
    INNER JOIN sys.indexes i ON t.object_id = i.object_id
    INNER JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
    INNER JOIN sys.allocation_units a ON p.partition_id = a.container_id
    WHERE t.name = 'bot_state_snapshots';
  `);
  console.log(`[purge-bss] pre: rows=${preRows.recordset[0].n} totalMB=${preSize.recordset[0].total_mb}`);

  // Count to delete.
  const cutoffSql = `
    DECLARE @cutoff DATETIME2 = DATEADD(day, -@retainDays, SYSUTCDATETIME());
    SELECT COUNT(*) AS n FROM dbo.bot_state_snapshots
     WHERE ts < @cutoff;
  `;
  let candidate;
  try {
    candidate = await pool.request().input('retainDays', sql.Int, retainDays).query(cutoffSql);
  } catch (err) {
    // Fall back to a likely timestamp column name if the above didn't match.
    candidate = await pool.request().input('retainDays', sql.Int, retainDays).query(`
      DECLARE @cutoff DATETIME2 = DATEADD(day, -@retainDays, SYSUTCDATETIME());
      SELECT COUNT(*) AS n FROM dbo.bot_state_snapshots
       WHERE ts < @cutoff;
    `);
  }
  console.log(`[purge-bss] candidates older than ${retainDays}d: ${candidate.recordset[0].n}`);

  if (!apply) {
    console.log('[purge-bss] DRY-RUN. Re-run with --apply to delete + shrink.');
    process.exit(0);
  }

  // Delete in batches of 500 to keep individual transactions short on the
  // large state_json blobs (some rows are >1MB). Each request gets a 120s
  // timeout to survive the I/O cost of removing the data pages.
  const BATCH = 500;
  let totalDeleted = 0;
  while (true) {
    const req = pool.request();
    req.timeout = 120000;
    req.input('retainDays', sql.Int, retainDays);
    req.input('batchSize', sql.Int, BATCH);
    const r = await req.query(`
      DECLARE @cutoff DATETIME2 = DATEADD(day, -@retainDays, SYSUTCDATETIME());
      DELETE TOP (@batchSize) FROM dbo.bot_state_snapshots
       WHERE ts < @cutoff;
      SELECT @@ROWCOUNT AS n;
    `);
    const n = r.recordset[0].n;
    totalDeleted += n;
    console.log(`[purge-bss] deleted batch n=${n} runningTotal=${totalDeleted}`);
    if (n < BATCH) break;
  }
  console.log(`[purge-bss] DELETE done. total=${totalDeleted}`);

  // Shrink the data file to reclaim freed pages. SHRINKFILE on a 7+GB delete
  // can take several minutes; bump request timeout to 10 min.
  console.log('[purge-bss] shrinking data file (this can take several minutes)...');
  const shrinkReq = pool.request();
  shrinkReq.timeout = 600000;
  await shrinkReq.query(`DBCC SHRINKFILE (Agent, 0) WITH NO_INFOMSGS;`);

  // Post-stats.
  const postRows = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.bot_state_snapshots`);
  const postSize = await pool.request().query(`
    SELECT size * 8 / 1024 AS total_mb FROM sys.database_files WHERE name = 'Agent';
  `);
  console.log(`[purge-bss] post: rows=${postRows.recordset[0].n} dbFileMB=${postSize.recordset[0].total_mb}`);
  process.exit(0);
})().catch((err) => {
  console.error(`[purge-bss] FAILED: ${err.message}`);
  process.exit(1);
});
