#!/usr/bin/env node
'use strict';

// Audit current bot configuration. Lists every knob with:
//   - effective value
//   - source (DB row | env | hardcoded default)
//   - last change (from config_changes audit log if DB)
//   - orphan env vars (defined but not in schema)
//
// Usage:
//   node scripts/config-audit.js
//   node scripts/config-audit.js --scope=live
//   node scripts/config-audit.js --orphans-only
//   node scripts/config-audit.js --json

require('dotenv').config();

const { KNOBS } = require('../src/config/schema');
const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');

const args = process.argv.slice(2);
const SCOPE = (args.find((a) => a.startsWith('--scope=')) || '--scope=live').split('=')[1];
const ORPHANS_ONLY = args.includes('--orphans-only');
const JSON_OUT = args.includes('--json');

async function loadDbKnobs(pool, scope) {
  if (!pool) return new Map();
  try {
    const req = pool.request();
    req.input('scope', scope);
    const r = await req.query(`
      SELECT knob, value, value_type, source, updated_at, updated_by, notes
        FROM dbo.strategy_config
       WHERE scope IN (@scope, 'global') AND active = 1
    `);
    const map = new Map();
    for (const row of (r.recordset || [])) {
      if (!map.has(row.knob)) map.set(row.knob, row);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function loadLastChange(pool, knob) {
  if (!pool) return null;
  try {
    const req = pool.request();
    req.input('knob', knob);
    const r = await req.query(`
      SELECT TOP 1 changed_at, actor, old_value, new_value, reason
        FROM dbo.config_changes
       WHERE knob = @knob
       ORDER BY changed_at DESC
    `);
    return r.recordset?.[0] || null;
  } catch {
    return null;
  }
}

function resolveSource(name, dbRow) {
  if (dbRow) return `db:${dbRow.source || 'manual'}`;
  if (process.env[name] !== undefined) return 'env';
  return 'default';
}

function resolveValue(name, dbRow, knobSpec) {
  if (dbRow) return dbRow.value;
  if (process.env[name] !== undefined) return process.env[name];
  return knobSpec.default == null ? '(none)' : String(knobSpec.default);
}

async function main() {
  const pool = isSqlEnabled() ? await getPool().catch(() => null) : null;
  const dbKnobs = await loadDbKnobs(pool, SCOPE);

  const rows = [];
  const orphans = [];

  for (const name of Object.keys(process.env)) {
    if (!KNOBS[name] && name !== 'NODE_ENV' && !/^npm_/.test(name) && !/^PATH/.test(name) && /^[A-Z][A-Z0-9_]+$/.test(name)) {
      // Heuristic: bot-shaped env var (UPPER_SNAKE) not in schema
      orphans.push(name);
    }
  }

  for (const [name, spec] of Object.entries(KNOBS)) {
    const dbRow = dbKnobs.get(name) || null;
    const source = resolveSource(name, dbRow);
    const value = resolveValue(name, dbRow, spec);
    const lastChange = pool ? await loadLastChange(pool, name) : null;
    rows.push({
      name,
      type: spec.type,
      value: spec.secret ? '<redacted>' : value,
      source,
      hotReload: !!spec.hotReload,
      secret: !!spec.secret,
      lastChangeAt: lastChange?.changed_at || null,
      lastChangeBy: lastChange?.actor || null,
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));

  if (JSON_OUT) {
    console.log(JSON.stringify({ scope: SCOPE, rows, orphans }, null, 2));
    process.exit(0);
  }

  if (!ORPHANS_ONLY) {
    console.log(`\n[config-audit] scope=${SCOPE}, ${rows.length} knobs`);
    console.log('  KNOB                                         SOURCE         HR   VALUE');
    console.log('  -------------------------------------------- -------------- ---- --------------------');
    for (const r of rows) {
      const nameCol = r.name.padEnd(44).slice(0, 44);
      const srcCol = r.source.padEnd(14).slice(0, 14);
      const hrCol = (r.hotReload ? '🔥' : '  ').padEnd(4);
      const valCol = String(r.value).slice(0, 40);
      console.log(`  ${nameCol} ${srcCol} ${hrCol} ${valCol}`);
    }
  }

  if (orphans.length > 0) {
    console.log(`\n[config-audit] ⚠ ${orphans.length} orphan env var(s) (defined but not in schema):`);
    for (const name of orphans) console.log(`  • ${name}`);
    console.log('  → either add to src/config/schema.js KNOBS or remove from .env/ecosystem.config.js');
  }

  process.exit(0);
}

main().catch((e) => { console.error(`[config-audit] fatal: ${e?.stack || e}`); process.exit(1); });
