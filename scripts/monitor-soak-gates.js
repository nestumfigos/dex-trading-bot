#!/usr/bin/env node
'use strict';

/**
 * Soak-gate monitor — polls each open observation gate from SOAK_OBSERVATION_GATES.md
 * and reports current status programmatically. Run on a cron or by an operator;
 * pipes a structured JSON report to stdout + writes data/soak-gate-status.json.
 *
 * Each gate has:
 *   - threshold (numeric criteria from the runbook)
 *   - sqlQuery (extracts current metric from dbo.bot_trade_ledger / health_checks)
 *   - status: 'pending' | 'ready' | 'failed' | 'no_data'
 *   - actionable: human-readable next step
 *
 * Does NOT mark checklist items [X] automatically — that's an operator decision
 * after reviewing edge cases. Provides the data to make that decision.
 *
 * Usage:
 *   node scripts/monitor-soak-gates.js                 # human-readable
 *   node scripts/monitor-soak-gates.js --json          # machine-readable
 *   node scripts/monitor-soak-gates.js --gate=plan_b   # single gate
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const { getPool } = require('../src/utils/sqlServer');

const GATES = [
  {
    id: 'plan_b_7d',
    name: 'Plan B (spot_day_bull_flag) — 7-day promotion review',
    setupType: 'spot_day_bull_flag',
    minTrades: 7,
    minPfRatio: 1.3,
    maxDdPct: 5,
    windowDays: 7,
  },
  {
    id: 'backes_14d',
    name: 'Backes HTF Swing — 14-day canary',
    setupType: 'backes_swing',
    minTrades: 30,
    windowDays: 14,
  },
  {
    id: 'bsc_flow_breakout',
    name: 'BSC flow breakout — 75 trades / 14d',
    setupType: 'bsc_flow_breakout',
    minTrades: 75,
    windowDays: 14,
  },
  {
    id: 'base_reclaim_6wk',
    name: 'Base reclaim — 6 weeks paper',
    setupType: 'base_dex_momentum_reclaim',
    minTrades: 1,
    windowDays: 42,
  },
  {
    id: 'solana_v2',
    name: 'Solana bull-flag v2 — 100 paper trades',
    setupType: 'solana_bull_flag_v2',
    minTrades: 100,
    windowDays: 90,
  },
  {
    id: 'w16_canary_24h',
    name: 'Week 16 post-refactor 24h paper canary',
    setupType: null, // any closed trades
    minTrades: 1,
    windowDays: 1,
    requirement: 'No loop stalls, no strategy degradation, no >5% regression vs Week 11 baseline',
  },
];

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

async function evaluateGate(pool, gate) {
  if (!pool) return { ...gate, status: 'sql_unavailable', actionable: 'enable SQL_ENABLED' };

  const sinceIso = new Date(Date.now() - gate.windowDays * 86_400_000).toISOString();
  const req = pool.request();
  req.input('since', sinceIso);
  let q = `
    SELECT COUNT(*) AS total_trades,
           SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) AS losses,
           SUM(pnl_usd) AS total_pnl,
           SUM(CASE WHEN pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_wins,
           SUM(CASE WHEN pnl_usd <= 0 THEN -pnl_usd ELSE 0 END) AS gross_losses
      FROM dbo.bot_trade_ledger
     WHERE trade_type = 'SELL' AND ts >= @since AND pnl_usd IS NOT NULL`;
  if (gate.setupType) {
    req.input('setup_type', gate.setupType);
    q += ' AND setup_type = @setup_type';
  }
  let r;
  try { r = await req.query(q); } catch (err) { return { ...gate, status: 'query_failed', actionable: err.message }; }
  const row = r.recordset?.[0] || { total_trades: 0 };
  const total = Number(row.total_trades || 0);
  if (total === 0) return { ...gate, status: 'no_data', currentTrades: 0, actionable: `wait for ${gate.minTrades || 1} trades` };
  const winRate = Number(row.wins || 0) / total * 100;
  const profitFactor = Number(row.gross_losses || 0) > 0
    ? Number(row.gross_wins || 0) / Number(row.gross_losses || 0)
    : (Number(row.gross_wins || 0) > 0 ? Infinity : 0);

  let status = 'in_progress';
  const reasons = [];
  if (total < (gate.minTrades || 1)) {
    status = 'in_progress';
    reasons.push(`trades=${total} < min=${gate.minTrades}`);
  } else {
    status = 'ready';
  }
  if (gate.minPfRatio && profitFactor < gate.minPfRatio) {
    status = 'failed';
    reasons.push(`PF=${profitFactor.toFixed(2)} < min=${gate.minPfRatio}`);
  }
  return {
    ...gate,
    status,
    currentTrades: total,
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    totalPnlUsd: Number(row.total_pnl || 0),
    winRatePct: Number(winRate.toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    reasons,
    actionable: status === 'ready'
      ? 'criteria met — operator may review + mark [X] in REFACTOR_CHECKLIST.md'
      : reasons.join('; '),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const wantJson = Boolean(args.json);
  const gateId = args.gate || null;

  if (String(process.env.SQL_ENABLED || '').toLowerCase() !== 'true') {
    console.error('SQL_ENABLED=true required.');
    process.exit(2);
  }
  const pool = await getPool(logger);
  const list = gateId ? GATES.filter((g) => g.id === gateId) : GATES;
  const results = [];
  for (const g of list) {
    const r = await evaluateGate(pool, g);
    results.push(r);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sqlEnabled: true,
    scope: process.env.BOT_PROFILE || 'unknown',
    gates: results,
    summary: {
      ready: results.filter((r) => r.status === 'ready').length,
      inProgress: results.filter((r) => r.status === 'in_progress').length,
      failed: results.filter((r) => r.status === 'failed').length,
      noData: results.filter((r) => r.status === 'no_data').length,
    },
  };

  const outPath = path.resolve(process.cwd(), 'data', 'soak-gate-status.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Soak-gate report (${report.generatedAt}, scope=${report.scope}):\n`);
    for (const r of results) {
      const badge = r.status === 'ready' ? '✓' : r.status === 'failed' ? '✗' : '…';
      console.log(`  ${badge} [${r.status}] ${r.name}`);
      console.log(`    trades=${r.currentTrades ?? '—'} wr=${r.winRatePct ?? '—'}% pf=${r.profitFactor ?? '—'} pnl=$${Number(r.totalPnlUsd || 0).toFixed(2)}`);
      console.log(`    → ${r.actionable}\n`);
    }
    console.log(`Summary: ${report.summary.ready} ready · ${report.summary.inProgress} in-progress · ${report.summary.failed} failed · ${report.summary.noData} no-data`);
    console.log(`Full report: ${outPath}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('monitor-soak-gates failed:', err.message);
  process.exit(1);
});
