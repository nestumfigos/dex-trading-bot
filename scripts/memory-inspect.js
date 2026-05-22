#!/usr/bin/env node
'use strict';

// Pretty-print current agent memory state from SQL (or disk fallback).
//
// Usage:
//   node scripts/memory-inspect.js
//   node scripts/memory-inspect.js --top=10        # top 10 lessons / counters
//   node scripts/memory-inspect.js --json

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool, isSqlEnabled } = require('../src/utils/sqlServer');

const TOP = Number((process.argv.find((a) => a.startsWith('--top=')) || '--top=5').split('=')[1]) || 5;
const JSON_OUT = process.argv.includes('--json');
const DISK_PATH = path.resolve(__dirname, '../data/agent-memory.json');

async function loadFromSql() {
  if (!isSqlEnabled()) return null;
  try {
    const pool = await getPool();
    const r = await pool.request().query(`SELECT TOP 1 value FROM dbo.kv_store WHERE k = 'agent-memory:shared' ORDER BY ver DESC`);
    if (r.recordset?.[0]?.value) return JSON.parse(r.recordset[0].value);
  } catch (e) { console.error(`[memory-inspect] SQL load failed: ${e.message}`); }
  return null;
}

function loadFromDisk() {
  if (!fs.existsSync(DISK_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DISK_PATH, 'utf8')); }
  catch (e) { console.error(`[memory-inspect] disk load failed: ${e.message}`); return null; }
}

function summarizeCounters(map = {}) {
  const entries = Object.entries(map);
  return entries
    .map(([k, v]) => ({ k, wins: Number(v?.wins || 0), losses: Number(v?.losses || 0), pnl: Number(v?.totalPnlUsd || 0) }))
    .filter((x) => x.wins + x.losses > 0)
    .sort((a, b) => b.pnl - a.pnl);
}

async function main() {
  let data = await loadFromSql();
  let source = 'sql';
  if (!data) { data = loadFromDisk(); source = 'disk'; }
  if (!data) { console.error('[memory-inspect] no memory found (SQL or disk).'); process.exit(2); }

  if (JSON_OUT) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }

  console.log(`\n[memory-inspect] source=${source}, version=${data.version || '?'}`);
  console.log(`  tradeLessons:        ${(data.tradeLessons || []).length}`);
  console.log(`  strategyDiscoveries: ${(data.strategyDiscoveries || []).length}`);
  console.log(`  tokenBlacklist:      ${Object.keys(data.tokenBlacklist || {}).length}`);
  console.log(`  tokenPreferences:    ${Object.keys(data.tokenPreferences || {}).length}`);
  console.log(`  evolutionOutcomes:   ${(data.evolutionOutcomes || []).length}`);
  console.log(`  knowledgeBase:       ${(data.knowledgeBase || []).length}`);

  console.log(`\n  aiUsage: date=${data.aiUsage?.date || '?'}, lessonCalls=${data.aiUsage?.lessonCalls || 0}, deepResearchCalls=${data.aiUsage?.deepResearchCalls || 0}`);

  for (const cat of ['symbolWinRates', 'regimeWinRates', 'chainPatterns', 'tokenAgePatterns', 'exitClassificationStats', 'indicatorPatterns']) {
    const sum = summarizeCounters(data[cat]);
    if (sum.length === 0) continue;
    console.log(`\n  ${cat} (top ${TOP} by PnL):`);
    for (const e of sum.slice(0, TOP)) {
      const wr = (e.wins / (e.wins + e.losses) * 100).toFixed(1);
      console.log(`    ${e.k.padEnd(28).slice(0, 28)}  w/l=${e.wins}/${e.losses}  wr=${wr}%  pnl=$${e.pnl.toFixed(2)}`);
    }
  }

  const recentLessons = (data.tradeLessons || []).slice(0, TOP);
  if (recentLessons.length > 0) {
    console.log(`\n  recent lessons (top ${TOP}):`);
    for (const l of recentLessons) {
      const when = l.ts ? new Date(l.ts).toISOString().slice(0, 16) : '?';
      console.log(`    [${when}] ${l.symbol || '?'}: ${String(l.lesson || '').slice(0, 90)}`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(`[memory-inspect] fatal: ${e?.stack || e}`); process.exit(1); });
