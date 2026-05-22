#!/usr/bin/env node
'use strict';

// Show recent config_changes (audit log). Useful pre-restart to see what knobs
// have changed since last running state.
//
// Usage:
//   node scripts/config-diff.js                    # last 24h
//   node scripts/config-diff.js --hours=72
//   node scripts/config-diff.js --knob=MIN_LIQUIDITY_USD
//   node scripts/config-diff.js --json

require('dotenv').config();
const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');

const args = process.argv.slice(2);
const HOURS = Number((args.find((a) => a.startsWith('--hours=')) || '--hours=24').split('=')[1]) || 24;
const KNOB  = (args.find((a) => a.startsWith('--knob=')) || '').split('=')[1] || null;
const JSON_OUT = args.includes('--json');

async function main() {
  if (!isSqlEnabled()) { console.error('[config-diff] SQL not configured.'); process.exit(2); }
  const pool = await getPool();

  const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
  const req = pool.request();
  req.input('since', since);
  let q = `SELECT TOP 200 changed_at, scope, knob, old_value, new_value, actor, source, reason
             FROM dbo.config_changes
            WHERE changed_at >= @since`;
  if (KNOB) { req.input('knob', KNOB); q += ' AND knob = @knob'; }
  q += ' ORDER BY changed_at DESC';

  const r = await req.query(q);
  const rows = r.recordset || [];

  if (JSON_OUT) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

  console.log(`\n[config-diff] last ${HOURS}h${KNOB ? ` knob=${KNOB}` : ''}, ${rows.length} changes`);
  if (rows.length === 0) { console.log('  (no changes)'); process.exit(0); }

  console.log('  WHEN                  SCOPE  KNOB                                  OLD → NEW                     ACTOR');
  console.log('  --------------------  -----  ------------------------------------  ----------------------------  --------');
  for (const row of rows) {
    const when = new Date(row.changed_at).toISOString().slice(0, 19).replace('T', ' ');
    const scope = (row.scope || 'global').padEnd(5).slice(0, 5);
    const knob = String(row.knob).padEnd(36).slice(0, 36);
    const diff = `${String(row.old_value ?? '∅').slice(0, 12)} → ${String(row.new_value ?? '∅').slice(0, 12)}`.padEnd(28);
    const actor = (row.actor || '?').slice(0, 14);
    console.log(`  ${when}  ${scope}  ${knob}  ${diff}  ${actor}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(`[config-diff] fatal: ${e?.stack || e}`); process.exit(1); });
