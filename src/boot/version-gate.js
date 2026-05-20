'use strict';

// Bot version-gating at boot (Week 11.3). Refuses boot if applied schema
// migration count drifts from expected. Prevents running old code against
// migrated DB (silent broken queries) or new code against unmigrated DB.
//
// Pure factory. SQL optional; falls open if pool unavailable.

const fs = require('fs');
const path = require('path');

async function checkSchemaVersion({ getPool, logger, minSchemaVersion, maxSchemaVersion, strict = false } = {}) {
  const log = logger || console;
  if (typeof getPool !== 'function') {
    return { ok: true, skipped: true, reason: 'no_pool_getter' };
  }
  let pool = null;
  try {
    pool = await getPool();
  } catch (e) {
    return { ok: true, skipped: true, reason: `pool_unavailable: ${e?.message || e}` };
  }
  if (!pool) {
    return { ok: true, skipped: true, reason: 'pool_null' };
  }

  let applied = 0;
  try {
    const r = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.schema_migrations`);
    applied = Number(r.recordset?.[0]?.n || 0);
  } catch (e) {
    if (strict) {
      const err = new Error(`[version-gate] cannot read schema_migrations: ${e?.message || e}`);
      err.code = 'VERSION_GATE_SQL_FAIL';
      throw err;
    }
    log.warn?.(`[version-gate] schema_migrations read failed (allowing boot in lenient): ${e?.message || e}`);
    return { ok: true, skipped: true, reason: 'sql_read_failed' };
  }

  const minV = Number(minSchemaVersion || 0);
  const maxV = Number(maxSchemaVersion || Infinity);

  if (applied < minV) {
    const msg = `[version-gate] schema_migrations applied=${applied} < required min=${minV}. Run \`npm run db:migrate\` first.`;
    if (strict) {
      const err = new Error(msg);
      err.code = 'VERSION_GATE_TOO_LOW';
      throw err;
    }
    log.warn?.(msg);
    return { ok: false, applied, minV, maxV, reason: 'too_low' };
  }
  if (applied > maxV) {
    const msg = `[version-gate] schema_migrations applied=${applied} > supported max=${maxV}. This bot binary is older than the DB schema. Update bot to read newer schema or rollback migrations.`;
    if (strict) {
      const err = new Error(msg);
      err.code = 'VERSION_GATE_TOO_HIGH';
      throw err;
    }
    log.warn?.(msg);
    return { ok: false, applied, minV, maxV, reason: 'too_high' };
  }

  log.info?.(`[version-gate] OK — schema_migrations applied=${applied} (range ${minV}..${maxV === Infinity ? '∞' : maxV})`);
  return { ok: true, applied, minV, maxV };
}

function readBotVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg?.version || null;
  } catch {
    return null;
  }
}

module.exports = { checkSchemaVersion, readBotVersion };
