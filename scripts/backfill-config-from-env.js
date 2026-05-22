#!/usr/bin/env node
'use strict';

// One-shot importer: env (.env + ecosystem.config.js) → dbo.strategy_config.
// Idempotent (UPSERT pattern). Re-runnable. Marks rows with
// source='env_import_<date>' so they're traceable.
//
// Usage:
//   node scripts/backfill-config-from-env.js --dry-run     # show diff only
//   node scripts/backfill-config-from-env.js               # apply
//   node scripts/backfill-config-from-env.js --scope=live  # default live; or paper
//   node scripts/backfill-config-from-env.js --hot-only    # only hotReload=true knobs

require('dotenv').config();

const path = require('path');
const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');
const { KNOBS } = require('../src/config/schema');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const SCOPE_ARG = (args.find((a) => a.startsWith('--scope=')) || '--scope=live').split('=')[1];
const HOT_ONLY = args.includes('--hot-only');
const STAMP = new Date().toISOString().slice(0, 10);
const SOURCE = `env_import_${STAMP}`;

function loadEcosystemEnv(scope) {
  const ecoPath = path.resolve(__dirname, '..', 'ecosystem.config.js');
  delete require.cache[require.resolve(ecoPath)];
  let eco;
  try { eco = require(ecoPath); } catch (e) {
    console.error(`[backfill] failed to load ecosystem.config.js: ${e.message}`);
    return {};
  }
  const appName = scope === 'paper' ? 'dex-bot-paper' : 'dex-bot';
  const app = (eco.apps || []).find((a) => a.name === appName);
  if (!app) return {};
  // Prefer env_production then env
  return { ...(app.env || {}), ...(app.env_production || {}) };
}

function collectDesiredRows(scope) {
  const dotenv = process.env;
  const eco = loadEcosystemEnv(scope);
  const rows = [];
  const ecoConflicts = [];

  for (const [knob, spec] of Object.entries(KNOBS)) {
    if (HOT_ONLY && !spec.hotReload) continue;
    if (spec.secret) continue; // never persist secrets to DB

    const dotenvVal = dotenv[knob];
    const ecoVal = eco[knob];
    const value = ecoVal !== undefined ? ecoVal : dotenvVal;
    if (value === undefined) continue;

    if (dotenvVal !== undefined && ecoVal !== undefined && String(dotenvVal) !== String(ecoVal)) {
      ecoConflicts.push({ knob, dotenv: dotenvVal, eco: ecoVal });
    }

    rows.push({
      scope,
      strategy: null,
      knob,
      value: String(value),
      value_type: spec.type,
      source: ecoVal !== undefined ? `${SOURCE}_eco` : `${SOURCE}_dotenv`,
      notes: spec.hotReload ? 'hot-reloadable' : null,
    });
  }

  return { rows, ecoConflicts };
}

async function upsertRow(pool, row) {
  // Use MERGE for clean UPSERT on the unique filtered index (scope, strategy, knob) WHERE active=1.
  const req = pool.request();
  req.input('scope', sql.NVarChar(32), row.scope);
  req.input('strategy', sql.NVarChar(32), row.strategy);
  req.input('knob', sql.NVarChar(128), row.knob);
  req.input('value', sql.NVarChar(1024), row.value);
  req.input('value_type', sql.NVarChar(16), row.value_type);
  req.input('source', sql.NVarChar(64), row.source);
  req.input('notes', sql.NVarChar(512), row.notes);

  // Fetch prior value first so we can audit on change.
  const priorR = await pool.request()
    .input('scope', sql.NVarChar(32), row.scope)
    .input('knob', sql.NVarChar(128), row.knob)
    .query(`
      SELECT TOP 1 value FROM dbo.strategy_config
      WHERE scope = @scope AND knob = @knob AND active = 1 AND strategy IS NULL;
    `);
  const prior = priorR.recordset[0]?.value;

  if (prior === row.value) return { action: 'skip', prior };

  await req.query(`
    MERGE dbo.strategy_config WITH (HOLDLOCK) AS T
    USING (SELECT @scope AS scope, @knob AS knob) AS S
      ON T.scope = S.scope AND T.knob = S.knob AND T.strategy IS NULL AND T.active = 1
    WHEN MATCHED THEN UPDATE SET
      value = @value, value_type = @value_type, source = @source,
      notes = @notes, updated_at = SYSUTCDATETIME(), updated_by = SUSER_SNAME()
    WHEN NOT MATCHED THEN INSERT
      (scope, strategy, knob, value, value_type, source, notes)
      VALUES (@scope, NULL, @knob, @value, @value_type, @source, @notes);
  `);

  // Audit row
  const audReq = pool.request();
  audReq.input('scope', sql.NVarChar(32), row.scope);
  audReq.input('strategy', sql.NVarChar(32), row.strategy);
  audReq.input('knob', sql.NVarChar(128), row.knob);
  audReq.input('old_value', sql.NVarChar(1024), prior ?? null);
  audReq.input('new_value', sql.NVarChar(1024), row.value);
  audReq.input('source', sql.NVarChar(64), row.source);
  audReq.input('reason', sql.NVarChar(512), 'env→DB backfill');
  await audReq.query(`
    INSERT INTO dbo.config_changes (scope, strategy, knob, old_value, new_value, source, reason)
    VALUES (@scope, @strategy, @knob, @old_value, @new_value, @source, @reason);
  `);

  return { action: prior === undefined ? 'insert' : 'update', prior };
}

async function main() {
  if (!isSqlEnabled()) {
    console.error('[backfill] SQL_ENABLED=false — set it and provide SQL_CONNECTION_STRING.');
    process.exit(2);
  }
  console.log(`[backfill] scope=${SCOPE_ARG} dryRun=${DRY} hotOnly=${HOT_ONLY} source=${SOURCE}`);

  const { rows, ecoConflicts } = collectDesiredRows(SCOPE_ARG);
  console.log(`[backfill] collected ${rows.length} candidate rows`);

  if (ecoConflicts.length) {
    console.warn(`[backfill] ${ecoConflicts.length} env/ecosystem CONFLICTS (eco wins):`);
    for (const c of ecoConflicts) {
      console.warn(`  ${c.knob}: dotenv='${c.dotenv}' eco='${c.eco}'`);
    }
  }

  if (DRY) {
    console.log('[backfill] DRY-RUN — would upsert:');
    for (const r of rows) {
      console.log(`  ${r.scope}/${r.knob} = ${r.value} (${r.source})`);
    }
    process.exit(0);
  }

  const pool = await getPool(console);
  if (!pool) {
    console.error('[backfill] pool unavailable');
    process.exit(1);
  }

  const counts = { insert: 0, update: 0, skip: 0 };
  for (const r of rows) {
    try {
      const res = await upsertRow(pool, r);
      counts[res.action]++;
      if (res.action !== 'skip') {
        console.log(`  ${res.action.padEnd(6)} ${r.scope}/${r.knob} = ${r.value}`);
      }
    } catch (err) {
      console.error(`  FAIL ${r.scope}/${r.knob}: ${err.message}`);
    }
  }

  console.log(`[backfill] done. inserted=${counts.insert} updated=${counts.update} skipped=${counts.skip}`);
  process.exit(0);
}

main().catch((err) => { console.error('[backfill] error:', err.message); process.exit(1); });
