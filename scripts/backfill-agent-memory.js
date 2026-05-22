#!/usr/bin/env node
'use strict';

/**
 * Backfill historical lessons in agent-memory.json with the new classification fields
 * introduced by the structured-learning fixes. Without this, lessons logged before
 * the upgrade have entryRegime/holdMinutes/exitClassification all as 'unknown' and
 * never contribute to regime/chain/age pattern stats.
 *
 * Heuristics:
 *  - outcome=win, pnlUsd>0           => take_profit
 *  - outcome=loss, pnlUsd<-2         => stop_hunt (no liquidity data → guess)
 *  - outcome=loss, |pnlUsd|<2        => mean_reversion (slow drift)
 *  - reason contains TIME/HOLD       => time_stop_no_gain
 *  - reason contains TRAILING        => trailing_stop
 *  - otherwise                       => keep 'unknown'
 *
 * Also rebuilds the aggregate buckets (regimeWinRates, chainPatterns,
 * tokenAgePatterns, exitClassificationStats) from the lesson set so the agent
 * has a non-empty history to draw on immediately.
 *
 * Usage:  node scripts/backfill-agent-memory.js [path/to/agent-memory.json]
 */

const fs = require('fs');
const path = require('path');

const targetPath = process.argv[2] || path.resolve(__dirname, '..', 'data', 'agent-memory.json');

function classifyExit(lesson) {
  const reason = String(lesson.reason || lesson.entryConditions?.exitReason || '').toUpperCase();
  const pnl = Number(lesson.pnlUsd || 0);
  const outcome = String(lesson.outcome || '').toLowerCase();

  if (reason.includes('TIME') || reason.includes('HOLD') || reason === 'MIN_HOLD_NO_GAIN') {
    return { code: 'time_stop_no_gain', reasoning: `legacy reason=${reason}, pnl=$${pnl.toFixed(2)}` };
  }
  if (reason.includes('TRAILING')) {
    return { code: 'trailing_stop', reasoning: `legacy trailing exit, pnl=$${pnl.toFixed(2)}` };
  }
  if (reason.includes('STOP_LOSS') || reason === 'SL_HIT' || reason === 'DISASTER_STOP') {
    return { code: 'stop_hunt', reasoning: `legacy stop loss, pnl=$${pnl.toFixed(2)}` };
  }
  if (reason.includes('SELL_TIER_') || reason.includes('TAKE_PROFIT')) {
    return { code: 'take_profit', reasoning: `legacy tier exit, pnl=$${pnl.toFixed(2)}` };
  }
  if (reason.includes('AI_') || reason.includes('SIGNAL')) {
    return { code: 'ai_veto', reasoning: `legacy signal exit, pnl=$${pnl.toFixed(2)}` };
  }

  // No reason — guess from outcome and pnl magnitude
  if (outcome === 'win' && pnl > 0) {
    return { code: 'take_profit', reasoning: `legacy win, no reason data, pnl=$${pnl.toFixed(2)}` };
  }
  if (outcome === 'loss' && pnl < -2) {
    return { code: 'stop_hunt', reasoning: `legacy hard loss, no reason data, pnl=$${pnl.toFixed(2)}` };
  }
  if (outcome === 'loss' && pnl >= -2 && pnl < 0) {
    return { code: 'mean_reversion', reasoning: `legacy soft loss, no reason data, pnl=$${pnl.toFixed(2)}` };
  }
  return { code: 'unknown', reasoning: `no classifying data, pnl=$${pnl.toFixed(2)}` };
}

function rebuildAggregates(data) {
  const regimeWinRates = {};
  const chainPatterns = {};
  const tokenAgePatterns = {};
  const exitClassificationStats = {};

  for (const lesson of data.tradeLessons || []) {
    const strategy = String(lesson.strategy || 'momentum');
    const chain = String(lesson.chain || 'unknown');
    const regime = String(lesson.entryRegime || 'unknown');
    const age = String(lesson.entryConditions?.tokenAgeBucket || 'unknown');
    const exit = String(lesson.exitClassification || 'unknown');
    const outcome = lesson.outcome === 'win' ? 'wins' : 'losses';
    const holdMin = Number(lesson.holdMinutes || 0);

    const rKey = `${regime}:${strategy}`;
    regimeWinRates[rKey] = regimeWinRates[rKey] || { wins: 0, losses: 0 };
    regimeWinRates[rKey][outcome] += 1;

    const cKey = `${chain}:${strategy}`;
    chainPatterns[cKey] = chainPatterns[cKey] || { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 };
    chainPatterns[cKey][outcome] += 1;
    chainPatterns[cKey].totalHoldMinutes += holdMin;
    chainPatterns[cKey].tradeCount += 1;

    const aKey = `${age}:${strategy}`;
    tokenAgePatterns[aKey] = tokenAgePatterns[aKey] || { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 };
    tokenAgePatterns[aKey][outcome] += 1;
    tokenAgePatterns[aKey].totalHoldMinutes += holdMin;
    tokenAgePatterns[aKey].tradeCount += 1;

    const eKey = `${chain}:${strategy}:${exit}`;
    exitClassificationStats[eKey] = exitClassificationStats[eKey] || { count: 0, totalPnlUsd: 0, wins: 0, losses: 0 };
    exitClassificationStats[eKey].count += 1;
    exitClassificationStats[eKey].totalPnlUsd += Number(lesson.pnlUsd || 0);
    exitClassificationStats[eKey][outcome] += 1;
  }

  return { regimeWinRates, chainPatterns, tokenAgePatterns, exitClassificationStats };
}

function backfill(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  const lessons = Array.isArray(data.tradeLessons) ? data.tradeLessons : [];

  let updated = 0;
  for (const lesson of lessons) {
    if (!lesson.exitClassification || lesson.exitClassification === 'unknown') {
      const classified = classifyExit(lesson);
      lesson.exitClassification = classified.code;
      lesson.exitClassificationReasoning = classified.reasoning;
      lesson.entryConditions = lesson.entryConditions || {};
      lesson.entryConditions.exitClassification = classified.code;
      updated += 1;
    }
    if (!lesson.entryRegime) lesson.entryRegime = 'unknown';
    if (!Number.isFinite(Number(lesson.holdMinutes))) lesson.holdMinutes = 0;
    if (!lesson.entryConditions?.tokenAgeBucket) {
      lesson.entryConditions = lesson.entryConditions || {};
      lesson.entryConditions.tokenAgeBucket = 'unknown';
    }
  }

  const rebuilt = rebuildAggregates(data);
  data.regimeWinRates = rebuilt.regimeWinRates;
  data.chainPatterns = rebuilt.chainPatterns;
  data.tokenAgePatterns = rebuilt.tokenAgePatterns;
  data.exitClassificationStats = rebuilt.exitClassificationStats;

  // Backup original first
  const backupPath = `${filePath}.pre-backfill.${Date.now()}.bak`;
  fs.writeFileSync(backupPath, raw);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  console.log(`Backfilled ${updated} of ${lessons.length} lessons.`);
  console.log(`Aggregates: ${Object.keys(rebuilt.regimeWinRates).length} regime keys, ${Object.keys(rebuilt.chainPatterns).length} chain keys, ${Object.keys(rebuilt.tokenAgePatterns).length} age keys, ${Object.keys(rebuilt.exitClassificationStats).length} exit keys`);
  console.log(`Backup: ${backupPath}`);
}

backfill(targetPath);
