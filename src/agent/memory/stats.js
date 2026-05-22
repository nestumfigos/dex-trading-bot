'use strict';

/**
 * Memory — stats / counters (pure functions on the data shape).
 *
 * Updates the 6 counter buckets used by recordLesson + downstream learning:
 *   - symbolWinRates       — keyed by `${symbol}:${strategy}`
 *   - regimeWinRates       — keyed by `${regime}:${strategy}`
 *   - chainPatterns        — keyed by `${chain}:${strategy}`
 *   - tokenAgePatterns     — keyed by `${ageBucket}:${strategy}`
 *   - exitClassificationStats — keyed by `${chain}:${strategy}:${exitCode}`
 *   - indicatorPatterns    — keyed by indicator (set elsewhere)
 *
 * All updaters are pure: mutate the data object passed in, return nothing.
 * Caller is responsible for marking `_dirty=true` on AgentMemory.
 *
 * Invariant (regression for 2026-05-16 loss bug):
 *   wins + losses are MONOTONIC. Tests verify counters never decrement.
 */

function ensureBucket(map, key, defaults) {
  if (!map[key]) map[key] = { ...defaults };
  return map[key];
}

function isWin(outcome) {
  return String(outcome).toLowerCase() === 'win';
}

// ── Per-bucket updaters ────────────────────────────────────────────────────

function recordSymbolOutcome(data, { symbol, strategy, outcome, pnlUsd = 0, ts = Date.now() }) {
  if (!data) throw new Error('recordSymbolOutcome: data required');
  data.symbolWinRates = data.symbolWinRates || {};
  const key = `${symbol}:${strategy}`;
  const bucket = ensureBucket(data.symbolWinRates, key, { wins: 0, losses: 0, totalPnlUsd: 0, lastTradeTs: 0 });
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
  bucket.totalPnlUsd += Number(pnlUsd) || 0;
  bucket.lastTradeTs = ts;
}

function recordRegimeOutcome(data, { regime, strategy, outcome }) {
  if (!data) throw new Error('recordRegimeOutcome: data required');
  data.regimeWinRates = data.regimeWinRates || {};
  const key = `${regime || 'unknown'}:${strategy}`;
  const bucket = ensureBucket(data.regimeWinRates, key, { wins: 0, losses: 0 });
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
}

function recordChainOutcome(data, { chain, strategy, outcome, holdMinutes = 0 }) {
  if (!data) throw new Error('recordChainOutcome: data required');
  data.chainPatterns = data.chainPatterns || {};
  const key = `${chain}:${strategy}`;
  const bucket = ensureBucket(data.chainPatterns, key, { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 });
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
  bucket.totalHoldMinutes += Number(holdMinutes) || 0;
  bucket.tradeCount += 1;
}

function recordTokenAgeOutcome(data, { ageBucket, strategy, outcome, holdMinutes = 0 }) {
  if (!data) throw new Error('recordTokenAgeOutcome: data required');
  data.tokenAgePatterns = data.tokenAgePatterns || {};
  const key = `${ageBucket || 'unknown'}:${strategy}`;
  const bucket = ensureBucket(data.tokenAgePatterns, key, { wins: 0, losses: 0, totalHoldMinutes: 0, tradeCount: 0 });
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
  bucket.totalHoldMinutes += Number(holdMinutes) || 0;
  bucket.tradeCount += 1;
}

function recordExitClassification(data, { chain, strategy, exitCode, outcome, pnlUsd = 0 }) {
  if (!data) throw new Error('recordExitClassification: data required');
  data.exitClassificationStats = data.exitClassificationStats || {};
  const key = `${chain}:${strategy}:${exitCode || 'unknown'}`;
  const bucket = ensureBucket(data.exitClassificationStats, key, { count: 0, totalPnlUsd: 0, wins: 0, losses: 0 });
  bucket.count += 1;
  bucket.totalPnlUsd += Number(pnlUsd) || 0;
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
}

function recordIndicatorOutcome(data, { indicatorKey, strategy, outcome }) {
  if (!data) throw new Error('recordIndicatorOutcome: data required');
  data.indicatorPatterns = data.indicatorPatterns || {};
  const key = `${indicatorKey}:${strategy}`;
  const bucket = ensureBucket(data.indicatorPatterns, key, { wins: 0, losses: 0, tradeCount: 0 });
  bucket[isWin(outcome) ? 'wins' : 'losses'] += 1;
  bucket.tradeCount += 1;
}

// ── Composite: record full trade outcome across all 5 buckets ──────────────

function recordTradeOutcome(data, entry, opts = {}) {
  if (!data) throw new Error('recordTradeOutcome: data required');
  if (!entry) throw new Error('recordTradeOutcome: entry required');
  const ts = opts.ts || entry.ts || Date.now();
  recordSymbolOutcome(data, {
    symbol: entry.symbol,
    strategy: entry.strategy,
    outcome: entry.outcome,
    pnlUsd: entry.pnlUsd,
    ts,
  });
  recordRegimeOutcome(data, {
    regime: entry.entryRegime,
    strategy: entry.strategy,
    outcome: entry.outcome,
  });
  recordChainOutcome(data, {
    chain: entry.chain,
    strategy: entry.strategy,
    outcome: entry.outcome,
    holdMinutes: entry.holdMinutes,
  });
  recordTokenAgeOutcome(data, {
    ageBucket: opts.tokenAgeBucket || entry.tokenAgeBucket,
    strategy: entry.strategy,
    outcome: entry.outcome,
    holdMinutes: entry.holdMinutes,
  });
  recordExitClassification(data, {
    chain: entry.chain,
    strategy: entry.strategy,
    exitCode: opts.exitClassification || entry.exitClassification,
    outcome: entry.outcome,
    pnlUsd: entry.pnlUsd,
  });
}

// ── Readers ────────────────────────────────────────────────────────────────

function getSymbolStats(data, symbol, strategy) {
  if (!data?.symbolWinRates) return null;
  return data.symbolWinRates[`${symbol}:${strategy}`] || null;
}

function getRegimeStats(data, regime, strategy) {
  if (!data?.regimeWinRates) return null;
  return data.regimeWinRates[`${regime || 'unknown'}:${strategy}`] || null;
}

function getChainStats(data, chain, strategy) {
  if (!data?.chainPatterns) return null;
  return data.chainPatterns[`${chain}:${strategy}`] || null;
}

function winRate(bucket) {
  if (!bucket) return 0;
  const total = Number(bucket.wins || 0) + Number(bucket.losses || 0);
  return total > 0 ? Number(bucket.wins || 0) / total : 0;
}

module.exports = {
  recordSymbolOutcome,
  recordRegimeOutcome,
  recordChainOutcome,
  recordTokenAgeOutcome,
  recordExitClassification,
  recordIndicatorOutcome,
  recordTradeOutcome,
  getSymbolStats,
  getRegimeStats,
  getChainStats,
  winRate,
};
