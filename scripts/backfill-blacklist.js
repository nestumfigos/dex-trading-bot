#!/usr/bin/env node
'use strict';

/**
 * Backfill in-memory blacklist → dbo.symbol_overrides table (Week 11.6).
 *
 * Reads agent-memory.json (disk fallback) + optionally SQL agent-memory snapshot,
 * upserts each blacklisted symbol as a `block` override in `symbol_overrides`.
 *
 * Idempotent: deactivates prior rows for same (scope, symbol, action) before
 * inserting fresh row. Run with --scope=live or --scope=paper.
 *
 * Usage:
 *   node scripts/backfill-blacklist.js
 *   node scripts/backfill-blacklist.js --scope=paper
 *   node scripts/backfill-blacklist.js --dry-run
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SCOPE = (args.find((a) => a.startsWith('--scope=')) || '--scope=live').split('=')[1];
const DRY_RUN = args.includes('--dry-run');

async function main() {
  const memPath = path.join(__dirname, '..', process.env.BOT_DATA_DIR || 'data', 'agent-memory.json');
  if (!fs.existsSync(memPath)) {
    console.log(`No agent-memory.json found at ${memPath} — nothing to backfill`);
    process.exit(0);
  }
  const raw = fs.readFileSync(memPath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to parse agent-memory.json: ${e.message}`);
    process.exit(1);
  }
  const blacklist = data?.tokenBlacklist || {};
  const symbols = Object.entries(blacklist).filter(([, entry]) => entry && (!entry.expiresAt || entry.expiresAt > Date.now()));

  if (symbols.length === 0) {
    console.log(`No active blacklist entries to backfill (scope=${SCOPE})`);
    process.exit(0);
  }

  console.log(`Found ${symbols.length} active blacklist entries to backfill into symbol_overrides (scope=${SCOPE})`);

  if (DRY_RUN) {
    for (const [sym, entry] of symbols) {
      console.log(`  [dry] ${sym} reason="${(entry.reason || '').slice(0, 60)}" expires=${entry.expiresAt ? new Date(entry.expiresAt).toISOString() : 'never'}`);
    }
    process.exit(0);
  }

  const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');
  if (!isSqlEnabled()) {
    console.log('SQL not enabled — set SQL_ENABLED=true and re-run');
    process.exit(1);
  }
  const pool = await getPool();
  if (!pool) {
    console.error('SQL pool unavailable');
    process.exit(1);
  }

  let inserted = 0;
  let skipped = 0;
  for (const [sym, entry] of symbols) {
    try {
      const tx = pool.transaction();
      await tx.begin();
      try {
        const reqDeact = tx.request();
        reqDeact.input('scope', SCOPE);
        reqDeact.input('symbol', sym);
        await reqDeact.query(`
          UPDATE dbo.symbol_overrides
             SET active = 0, updated_at = SYSUTCDATETIME()
           WHERE scope = @scope AND symbol = @symbol AND action = 'block' AND active = 1
        `);

        const reqIns = tx.request();
        reqIns.input('scope', SCOPE);
        reqIns.input('symbol', sym);
        reqIns.input('chain', null);
        reqIns.input('action', 'block');
        reqIns.input('value', String(entry.reason || '').slice(0, 200));
        reqIns.input('expires_at', entry.expiresAt ? new Date(entry.expiresAt) : null);
        await reqIns.query(`
          INSERT INTO dbo.symbol_overrides(scope, symbol, chain, action, value, expires_at, active, created_at, updated_at)
          VALUES (@scope, @symbol, @chain, @action, @value, @expires_at, 1, SYSUTCDATETIME(), SYSUTCDATETIME())
        `);
        await tx.commit();
        inserted += 1;
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    } catch (e) {
      console.error(`  FAIL ${sym}: ${e.message}`);
      skipped += 1;
    }
  }
  console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped (scope=${SCOPE})`);
  process.exit(skipped > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
