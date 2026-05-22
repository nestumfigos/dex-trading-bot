#!/usr/bin/env node
'use strict';

// Scan artifacts/models/ and INSERT ml_model_versions rows for each artifact.
// Idempotent: skips files already registered (matched by name+version).
//
// Usage:
//   node scripts/backfill-model-versions.js --dry-run
//   node scripts/backfill-model-versions.js
//   node scripts/backfill-model-versions.js --scope=live
//   node scripts/backfill-model-versions.js --activate    # mark production-v* as active

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const ACTIVATE = args.includes('--activate');
const SCOPE_ARG = (args.find((a) => a.startsWith('--scope=')) || '').split('=')[1] || 'global';
const MODELS_DIR = path.resolve(__dirname, '../artifacts/models');

// Parse filename like "xgboost_production-v1.pkl" → {name, version, framework}
function parseFilename(filename) {
  // Strip extension
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext);
  // Split on first "-v" or last "_" before version
  // Match longer patterns first (production-vN, candidate-YYYY-MM-DD, fold-N, plain vN).
  // \b doesn't fire between '_' and letters since both are word chars, so anchor on '_' or '-' separator.
  const versionMatch = base.match(/^(.+?)[_-](production-v\d+|candidate-\d{4}-\d{2}-\d{2}|fold-\d+|v\d+)$/i);
  let name, version;
  if (versionMatch) {
    name = versionMatch[1].replace(/[_-]+$/, '');
    version = versionMatch[2];
  } else {
    name = base;
    version = 'v1';
  }
  let framework = null;
  // Name-based detection beats extension since *.pkl can be any sklearn-compatible serialization.
  if (/catboost/i.test(name)) framework = 'catboost';
  else if (/lightgbm/i.test(name)) framework = 'lightgbm';
  else if (/xgboost/i.test(name)) framework = 'xgboost';
  else if (/random_forest|^random|^rf/i.test(name)) framework = 'sklearn';
  else if (/torch|gru|lstm/i.test(name)) framework = 'pytorch';
  else if (/regime|gmm|hmm|kmeans/i.test(name)) framework = 'sklearn';
  else if (ext === '.pkl') framework = 'sklearn';
  else if (ext === '.pt') framework = 'pytorch';
  return { name: name.toLowerCase(), version, framework };
}

function sha256(filepath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex');
}

async function existsRow(pool, name, version, scope) {
  const req = pool.request();
  req.input('name', name); req.input('version', version); req.input('scope', scope);
  const r = await req.query(`SELECT 1 FROM dbo.ml_model_versions WHERE name = @name AND version = @version AND scope = @scope`);
  return (r.recordset || []).length > 0;
}

async function insertRow(pool, row) {
  const req = pool.request();
  req.input('name',            sql.NVarChar(64),  row.name);
  req.input('version',         sql.NVarChar(64),  row.version);
  req.input('scope',           sql.NVarChar(32),  row.scope);
  req.input('artifact_path',   sql.NVarChar(512), row.artifact_path);
  req.input('artifact_sha256', sql.NVarChar(128), row.artifact_sha256);
  req.input('framework',       sql.NVarChar(32),  row.framework);
  req.input('active',          sql.Bit,           row.active ? 1 : 0);
  req.input('promoted_at',     sql.DateTime2,     row.active ? new Date() : null);
  req.input('source',          sql.NVarChar(64),  'backfill');
  req.input('notes',           sql.NVarChar(512), row.notes || null);
  await req.query(`
    INSERT INTO dbo.ml_model_versions
      (name, version, scope, artifact_path, artifact_sha256, framework, active, promoted_at, source, notes)
    VALUES
      (@name, @version, @scope, @artifact_path, @artifact_sha256, @framework, @active, @promoted_at, @source, @notes);
  `);
}

async function deactivatePeers(pool, name, scope) {
  const req = pool.request();
  req.input('name', name); req.input('scope', scope);
  await req.query(`
    UPDATE dbo.ml_model_versions
       SET active = 0, retired_at = SYSUTCDATETIME()
     WHERE name = @name AND scope = @scope AND active = 1
  `);
}

async function main() {
  if (!isSqlEnabled()) { console.error('[backfill-model-versions] SQL not configured.'); process.exit(2); }
  if (!fs.existsSync(MODELS_DIR)) { console.error(`[backfill-model-versions] ${MODELS_DIR} not found.`); process.exit(2); }

  const pool = await getPool();
  const files = fs.readdirSync(MODELS_DIR)
    .filter((f) => /\.(pkl|pt|model)$/i.test(f));

  let inserted = 0;
  let skipped = 0;
  let activated = 0;

  for (const f of files) {
    const filepath = path.join(MODELS_DIR, f);
    const { name, version, framework } = parseFilename(f);
    const isProduction = /production-v\d+/i.test(version);
    const shouldActivate = ACTIVATE && isProduction;

    const row = {
      name,
      version,
      scope: SCOPE_ARG,
      artifact_path: path.relative(path.resolve(__dirname, '..'), filepath).replace(/\\/g, '/'),
      artifact_sha256: sha256(filepath),
      framework,
      active: shouldActivate,
      notes: `backfilled from ${f}`,
    };

    if (DRY) {
      console.log(`  [DRY] ${name} ${version} (${framework || '?'}) active=${shouldActivate ? 'Y' : 'N'}`);
      continue;
    }

    try {
      const exists = await existsRow(pool, name, version, SCOPE_ARG);
      if (exists) { skipped++; continue; }
      if (shouldActivate) {
        await deactivatePeers(pool, name, SCOPE_ARG);
        activated++;
      }
      await insertRow(pool, row);
      inserted++;
      console.log(`  ✓ ${name} ${version} (${framework || '?'})${shouldActivate ? ' [ACTIVATED]' : ''}`);
    } catch (e) {
      console.error(`  ✗ ${f}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n[backfill-model-versions] scanned=${files.length} inserted=${inserted} skipped=${skipped} activated=${activated}`);
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(`[backfill-model-versions] fatal: ${e?.stack || e}`); process.exit(1); });
