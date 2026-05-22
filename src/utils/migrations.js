'use strict';

// Migration runner. Reads db/migrations/*.sql in numeric order, applies any not
// recorded in dbo.schema_migrations. Idempotent — re-running is safe.
//
// CLI: `npm run db:migrate` | `npm run db:rollback [version]` | `npm run db:status`
// Programmatic: require('./utils/migrations').migrate(logger)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getPool, isSqlEnabled, sql } = require('./sqlServer');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'db', 'migrations');
const ROLLBACKS_DIR = path.resolve(__dirname, '..', '..', 'db', 'rollbacks');
const FILE_RE = /^(\d{4,})_([a-z0-9_\-]+)\.sql$/i;

function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const m = f.match(FILE_RE);
      return {
        version: m[1],
        name: m[2],
        file: f,
        fullPath: path.join(dir, f),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version, 'en', { numeric: true }));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Split a .sql file on top-level `GO` batch separators (case-insensitive,
// whole-line). mssql client does not understand GO — we must split manually.
function splitBatches(sqlText) {
  const lines = sqlText.split(/\r?\n/);
  const batches = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*GO\s*(--.*)?$/i.test(line)) {
      const batch = current.join('\n').trim();
      if (batch) batches.push(batch);
      current = [];
    } else {
      current.push(line);
    }
  }
  const tail = current.join('\n').trim();
  if (tail) batches.push(tail);
  return batches;
}

async function ensureMigrationsTable(pool, logger) {
  // Bootstrap: if schema_migrations doesn't exist, apply 0000 directly so we
  // can record itself as the first applied migration.
  const probe = await pool.request().query(`
    SELECT CAST(COUNT(*) AS INT) AS cnt
    FROM sys.tables
    WHERE name = 'schema_migrations' AND schema_id = SCHEMA_ID('dbo');
  `);
  const exists = probe.recordset[0].cnt > 0;
  if (exists) return;

  const bootstrapFile = path.join(MIGRATIONS_DIR, '0000_init_schema_migrations.sql');
  if (!fs.existsSync(bootstrapFile)) {
    throw new Error(`Bootstrap migration missing: ${bootstrapFile}`);
  }
  logger.info('[migrations] bootstrap: creating dbo.schema_migrations');
  const sqlText = fs.readFileSync(bootstrapFile, 'utf8');
  for (const batch of splitBatches(sqlText)) {
    await pool.request().batch(batch);
  }
}

async function getAppliedVersions(pool) {
  const r = await pool.request().query(`
    SELECT version, name, checksum, applied_at
    FROM dbo.schema_migrations
    ORDER BY version;
  `);
  return r.recordset;
}

async function recordMigration(pool, mig, checksum, durationMs) {
  const req = pool.request();
  req.input('version', sql.NVarChar(64), mig.version);
  req.input('name', sql.NVarChar(256), mig.name);
  req.input('checksum', sql.NVarChar(128), checksum);
  req.input('duration_ms', sql.Int, durationMs);
  await req.query(`
    INSERT INTO dbo.schema_migrations (version, name, checksum, duration_ms)
    VALUES (@version, @name, @checksum, @duration_ms);
  `);
}

async function removeMigrationRecord(pool, version) {
  const req = pool.request();
  req.input('version', sql.NVarChar(64), version);
  await req.query(`DELETE FROM dbo.schema_migrations WHERE version = @version;`);
}

async function migrate({ logger = console, dryRun = false } = {}) {
  if (!isSqlEnabled()) {
    logger.warn('[migrations] SQL_ENABLED=false — nothing to do.');
    return { applied: [], skipped: [], dryRun };
  }
  const pool = await getPool(logger);
  if (!pool) throw new Error('SQL pool unavailable. Check SQL_CONNECTION_STRING.');

  await ensureMigrationsTable(pool, logger);

  const files = listMigrationFiles(MIGRATIONS_DIR);
  const applied = await getAppliedVersions(pool);
  const appliedMap = new Map(applied.map((r) => [r.version, r]));

  const toApply = [];
  const skipped = [];
  const checksumDrift = [];

  for (const mig of files) {
    const text = fs.readFileSync(mig.fullPath, 'utf8');
    const checksum = sha256(text);
    const prior = appliedMap.get(mig.version);
    if (prior) {
      if (prior.checksum !== checksum) {
        checksumDrift.push({ version: mig.version, name: mig.name, expected: prior.checksum, actual: checksum });
      }
      skipped.push(mig.version);
      continue;
    }
    toApply.push({ ...mig, text, checksum });
  }

  if (checksumDrift.length) {
    logger.error('[migrations] CHECKSUM DRIFT — applied migrations have been modified:');
    for (const d of checksumDrift) {
      logger.error(`  ${d.version}_${d.name}  applied=${d.expected.slice(0, 12)}  current=${d.actual.slice(0, 12)}`);
    }
    throw new Error(`Refusing to migrate: ${checksumDrift.length} applied migration(s) changed on disk.`);
  }

  if (!toApply.length) {
    logger.info(`[migrations] up to date (${skipped.length} already applied)`);
    return { applied: [], skipped, dryRun };
  }

  const appliedThisRun = [];
  for (const mig of toApply) {
    logger.info(`[migrations] ${dryRun ? 'DRY-RUN ' : ''}applying ${mig.version}_${mig.name}`);
    const t0 = Date.now();
    if (dryRun) {
      // Parse-only sanity: split batches; don't execute.
      const batches = splitBatches(mig.text);
      logger.info(`  parsed ${batches.length} batch(es)`);
      appliedThisRun.push({ version: mig.version, name: mig.name, durationMs: 0, dryRun: true });
      continue;
    }
    try {
      for (const batch of splitBatches(mig.text)) {
        await pool.request().batch(batch);
      }
      const durationMs = Date.now() - t0;
      await recordMigration(pool, mig, mig.checksum, durationMs);
      appliedThisRun.push({ version: mig.version, name: mig.name, durationMs });
      logger.info(`  ok in ${durationMs}ms`);
    } catch (err) {
      logger.error(`[migrations] FAILED at ${mig.version}_${mig.name}: ${err.message}`);
      throw err;
    }
  }

  return { applied: appliedThisRun, skipped, dryRun };
}

async function rollback({ logger = console, version = null } = {}) {
  if (!isSqlEnabled()) {
    logger.warn('[migrations] SQL_ENABLED=false — nothing to do.');
    return { rolledBack: null };
  }
  const pool = await getPool(logger);
  if (!pool) throw new Error('SQL pool unavailable.');

  await ensureMigrationsTable(pool, logger);
  const applied = await getAppliedVersions(pool);
  if (!applied.length) {
    logger.warn('[migrations] nothing to roll back.');
    return { rolledBack: null };
  }

  const target = version
    ? applied.find((r) => r.version === version)
    : applied[applied.length - 1];

  if (!target) {
    throw new Error(`Version ${version} is not in schema_migrations.`);
  }

  const files = listMigrationFiles(ROLLBACKS_DIR);
  const rb = files.find((f) => f.version === target.version);
  if (!rb) {
    throw new Error(`No rollback file for version ${target.version} in db/rollbacks/`);
  }

  logger.info(`[migrations] rolling back ${rb.version}_${rb.name}`);
  const text = fs.readFileSync(rb.fullPath, 'utf8');
  for (const batch of splitBatches(text)) {
    await pool.request().batch(batch);
  }

  // schema_migrations is a special case: if we just dropped it (M001 rollback),
  // there's nothing to delete from.
  if (target.version !== '0000') {
    await removeMigrationRecord(pool, target.version);
  }

  logger.info(`[migrations] rolled back ${target.version}_${target.name}`);
  return { rolledBack: target };
}

async function status({ logger = console } = {}) {
  if (!isSqlEnabled()) {
    logger.warn('[migrations] SQL_ENABLED=false.');
    return { enabled: false, files: listMigrationFiles(MIGRATIONS_DIR), applied: [] };
  }
  const pool = await getPool(logger);
  if (!pool) throw new Error('SQL pool unavailable.');

  await ensureMigrationsTable(pool, logger);
  const applied = await getAppliedVersions(pool);
  const files = listMigrationFiles(MIGRATIONS_DIR);
  const appliedSet = new Set(applied.map((a) => a.version));

  logger.info('  VERSION  NAME                                          STATUS    APPLIED_AT');
  logger.info('  -------  --------------------------------------------  --------  --------------------');
  for (const f of files) {
    const isApplied = appliedSet.has(f.version);
    const row = applied.find((a) => a.version === f.version);
    const ts = row ? new Date(row.applied_at).toISOString().replace('T', ' ').slice(0, 19) : '';
    logger.info(`  ${f.version.padEnd(7)}  ${f.name.padEnd(44).slice(0, 44)}  ${(isApplied ? 'APPLIED' : 'PENDING').padEnd(8)}  ${ts}`);
  }

  const orphans = applied.filter((a) => !files.some((f) => f.version === a.version));
  if (orphans.length) {
    logger.warn(`[migrations] ${orphans.length} applied migration(s) have no file on disk:`);
    for (const o of orphans) logger.warn(`  ${o.version}_${o.name}`);
  }

  return { enabled: true, files, applied, orphans };
}

module.exports = {
  migrate,
  rollback,
  status,
  listMigrationFiles,
  splitBatches,
  sha256,
  MIGRATIONS_DIR,
  ROLLBACKS_DIR,
};

// CLI entry point: `node src/utils/migrations.js <up|down|status> [version]`
if (require.main === module) {
  (async () => {
    try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }
    const cmd = (process.argv[2] || 'status').toLowerCase();
    const arg = process.argv[3] || null;
    const dryRun = process.argv.includes('--dry-run');
    const logger = console;
    try {
      if (cmd === 'up' || cmd === 'migrate') {
        const res = await migrate({ logger, dryRun });
        logger.info(`[migrations] done. applied=${res.applied.length} skipped=${res.skipped.length} dryRun=${!!dryRun}`);
      } else if (cmd === 'down' || cmd === 'rollback') {
        const res = await rollback({ logger, version: arg });
        logger.info(`[migrations] rollback done. target=${res.rolledBack ? res.rolledBack.version : 'none'}`);
      } else if (cmd === 'status') {
        await status({ logger });
      } else {
        logger.error(`Unknown command: ${cmd}. Use: up | down [version] | status [--dry-run]`);
        process.exit(2);
      }
      process.exit(0);
    } catch (err) {
      logger.error(`[migrations] error: ${err.message}`);
      process.exit(1);
    }
  })();
}
