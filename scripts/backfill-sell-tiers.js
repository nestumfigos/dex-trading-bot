#!/usr/bin/env node
'use strict';

// One-shot importer: MOMENTUM_SELL_TIERS / BACKES_SELL_TIERS env JSON → dbo.sell_tiers.
// Idempotent (deactivate then insert pattern). Re-runnable.
//
// Usage:
//   node scripts/backfill-sell-tiers.js --dry-run
//   node scripts/backfill-sell-tiers.js                  # apply for live + paper
//   node scripts/backfill-sell-tiers.js --scope=paper    # one scope only

require('dotenv').config();

const path = require('path');
const { getPool, isSqlEnabled, sql } = require('../src/utils/sqlServer');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run') || args.includes('-n');
const SCOPE_ARG = (args.find((a) => a.startsWith('--scope=')) || '').split('=')[1] || null; // null = both
const STAMP = new Date().toISOString().slice(0, 10);
const SOURCE = `env_import_${STAMP}`;

// Strategy → env-var name(s) to scan
const STRATEGY_ENV_MAP = {
  momentum: ['MOMENTUM_SELL_TIERS', 'SELL_TIERS'],
  backes:   ['BACKES_SELL_TIERS', 'SWING_SELL_TIERS', 'BACKES_SWING_SELL_TIERS'],
  rotation: ['ROTATION_SELL_TIERS'],
};

function loadEcosystemEnv(scope) {
  const ecoPath = path.resolve(__dirname, '..', 'ecosystem.config.js');
  delete require.cache[require.resolve(ecoPath)];
  let eco;
  try { eco = require(ecoPath); } catch (e) {
    console.error(`[backfill-sell-tiers] failed to load ecosystem.config.js: ${e.message}`);
    return {};
  }
  const appName = scope === 'paper' ? 'dex-bot-paper' : 'dex-bot';
  const app = (eco.apps || []).find((a) => a.name === appName);
  if (!app) return {};
  return { ...(app.env || {}), ...(app.env_production || {}) };
}

function parseTiers(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((t) => Number.isFinite(t.profitMultiplier) && Number.isFinite(t.sellPct));
  } catch {
    return null;
  }
}

function collectDesiredRows(scope) {
  const dotenv = process.env;
  const eco = loadEcosystemEnv(scope);
  const rows = [];

  for (const [strategy, envNames] of Object.entries(STRATEGY_ENV_MAP)) {
    let raw = null;
    let provenance = null;
    for (const name of envNames) {
      if (eco[name] !== undefined) { raw = eco[name]; provenance = `${SOURCE}_eco`; break; }
      if (dotenv[name] !== undefined) { raw = dotenv[name]; provenance = `${SOURCE}_dotenv`; break; }
    }
    const tiers = parseTiers(raw);
    if (!tiers || tiers.length === 0) continue;

    tiers.forEach((t, idx) => {
      rows.push({
        scope,
        strategy,
        tier_index: idx + 1,
        profit_multiplier: Number(t.profitMultiplier),
        sell_pct: Number(t.sellPct),
        min_notional_usd: Number(t.minNotionalUsd) || null,  // optional override
        chain: t.chain || null,
        source: provenance,
        notes: `imported from env on ${STAMP}`,
      });
    });
  }

  return rows;
}

async function deactivateExisting(pool, { scope, strategy }) {
  const req = pool.request();
  req.input('scope',    sql.NVarChar(32), scope);
  req.input('strategy', sql.NVarChar(32), strategy);
  await req.query(`
    UPDATE dbo.sell_tiers
       SET active = 0, updated_at = SYSUTCDATETIME()
     WHERE scope = @scope AND strategy = @strategy AND active = 1
  `);
}

async function insertRow(pool, row) {
  const req = pool.request();
  req.input('scope',             sql.NVarChar(32),  row.scope);
  req.input('strategy',          sql.NVarChar(32),  row.strategy);
  req.input('tier_index',        sql.Int,           row.tier_index);
  req.input('profit_multiplier', sql.Float,         row.profit_multiplier);
  req.input('sell_pct',          sql.Float,         row.sell_pct);
  req.input('min_notional_usd',  sql.Float,         row.min_notional_usd);
  req.input('chain',             sql.NVarChar(32),  row.chain);
  req.input('source',            sql.NVarChar(64),  row.source);
  req.input('notes',             sql.NVarChar(512), row.notes);
  await req.query(`
    INSERT INTO dbo.sell_tiers
      (scope, strategy, tier_index, profit_multiplier, sell_pct, min_notional_usd, chain, source, notes, active)
    VALUES
      (@scope, @strategy, @tier_index, @profit_multiplier, @sell_pct, @min_notional_usd, @chain, @source, @notes, 1)
  `);
}

async function backfillScope(pool, scope) {
  const rows = collectDesiredRows(scope);
  if (rows.length === 0) {
    console.log(`[backfill-sell-tiers] ${scope}: no tier env vars found, skipping`);
    return { scope, count: 0 };
  }

  console.log(`[backfill-sell-tiers] ${scope}: ${rows.length} tier rows to upsert`);
  rows.forEach((r) => console.log(`  ${r.strategy} tier ${r.tier_index}: x${r.profit_multiplier} → ${(r.sell_pct * 100).toFixed(0)}% (${r.source})`));

  if (DRY) {
    console.log(`[backfill-sell-tiers] DRY-RUN — no changes written`);
    return { scope, count: rows.length, dry: true };
  }

  // Group by strategy so deactivate-then-insert is atomic-ish per strategy.
  const byStrategy = new Map();
  for (const r of rows) {
    if (!byStrategy.has(r.strategy)) byStrategy.set(r.strategy, []);
    byStrategy.get(r.strategy).push(r);
  }

  for (const [strategy, strategyRows] of byStrategy) {
    await deactivateExisting(pool, { scope, strategy });
    for (const r of strategyRows) {
      await insertRow(pool, r);
    }
  }

  return { scope, count: rows.length };
}

async function main() {
  if (!isSqlEnabled()) {
    console.error('[backfill-sell-tiers] SQL not configured (SQL_CONNECTION_STRING). Aborting.');
    process.exit(2);
  }

  const pool = await getPool();
  const scopes = SCOPE_ARG ? [SCOPE_ARG] : ['live', 'paper'];

  for (const scope of scopes) {
    try {
      await backfillScope(pool, scope);
    } catch (e) {
      console.error(`[backfill-sell-tiers] ${scope}: failed: ${e.message}`);
      process.exitCode = 1;
    }
  }

  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error(`[backfill-sell-tiers] fatal: ${e?.stack || e}`);
  process.exit(1);
});
