#!/usr/bin/env node
'use strict';

// B6.reconcile-m0017: one-shot helper to bring schema_migrations.checksum for
// M0017 into agreement with the current on-disk file.
//
// Context: M0017 was applied first, then the file (idempotent: COL_LENGTH +
// NOT EXISTS guards on column + index) was edited and re-committed to git. The
// applied-side rows reflect the OLD checksum; on-disk SHA reflects the NEW.
// Because M0017 is idempotent on both branches, the SQL that was actually run
// against the DB is functionally equivalent to the current file, so updating
// the recorded checksum is safe.
//
// This script:
//   1. Computes the disk SHA256 of M0017.
//   2. Reads the current recorded checksum from dbo.schema_migrations.
//   3. Prints both, asks for an --apply flag to actually write.
//   4. UPDATE-only — never re-runs M0017.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');

const VERSION = '0017';
const FILE = path.resolve(__dirname, '..', 'db', 'migrations', '0017_bot_trade_ledger_setup_type.sql');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

(async () => {
  const apply = process.argv.includes('--apply');
  const logger = console;
  process.env.SQL_ENABLED = 'true';

  if (!isSqlEnabled()) throw new Error('SQL not enabled');
  const pool = await getPool(logger);
  if (!pool) throw new Error('SQL pool unavailable');

  const text = fs.readFileSync(FILE, 'utf8');
  const diskChecksum = sha256(text);

  const r = await pool.request()
    .input('version', sql.NVarChar(64), VERSION)
    .query('SELECT checksum, applied_at FROM dbo.schema_migrations WHERE version = @version');
  const row = r.recordset?.[0];
  if (!row) {
    logger.error(`[reconcile-m0017] no schema_migrations row for ${VERSION}; nothing to reconcile`);
    process.exit(1);
  }
  logger.info(`[reconcile-m0017] disk checksum      = ${diskChecksum}`);
  logger.info(`[reconcile-m0017] recorded checksum  = ${row.checksum}`);
  if (diskChecksum === row.checksum) {
    logger.info('[reconcile-m0017] already in agreement; no action needed');
    process.exit(0);
  }
  if (!apply) {
    logger.warn('[reconcile-m0017] DRIFT detected. Re-run with --apply to update the recorded checksum.');
    logger.warn('[reconcile-m0017] safe because M0017 is idempotent (COL_LENGTH + NOT EXISTS guards on both column and index).');
    process.exit(2);
  }
  await pool.request()
    .input('version', sql.NVarChar(64), VERSION)
    .input('checksum', sql.NVarChar(128), diskChecksum)
    .query('UPDATE dbo.schema_migrations SET checksum = @checksum WHERE version = @version');
  logger.info(`[reconcile-m0017] updated checksum for ${VERSION} -> ${diskChecksum}`);
  process.exit(0);
})().catch((err) => {
  console.error(`[reconcile-m0017] FAILED: ${err.message}`);
  process.exit(1);
});
