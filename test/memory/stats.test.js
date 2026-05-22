'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../../src/agent/memory/stats');

function emptyData() {
  return {
    symbolWinRates: {},
    regimeWinRates: {},
    chainPatterns: {},
    tokenAgePatterns: {},
    exitClassificationStats: {},
    indicatorPatterns: {},
  };
}

// ── recordSymbolOutcome ────────────────────────────────────────────────────

test('recordSymbolOutcome: creates bucket + increments wins on win', () => {
  const d = emptyData();
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'win', pnlUsd: 5.5, ts: 100 });
  const b = d.symbolWinRates['BTC:momentum'];
  assert.equal(b.wins, 1);
  assert.equal(b.losses, 0);
  assert.equal(b.totalPnlUsd, 5.5);
  assert.equal(b.lastTradeTs, 100);
});

test('recordSymbolOutcome: increments losses on loss + accumulates pnl', () => {
  const d = emptyData();
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'win', pnlUsd: 10 });
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'loss', pnlUsd: -3 });
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'win', pnlUsd: 2 });
  const b = d.symbolWinRates['BTC:momentum'];
  assert.equal(b.wins, 2);
  assert.equal(b.losses, 1);
  assert.equal(b.totalPnlUsd, 9); // 10 - 3 + 2
});

test('recordSymbolOutcome: monotonic counters (never decrement) — 2026-05-16 regression', () => {
  const d = emptyData();
  for (let i = 0; i < 10; i++) {
    stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: i % 2 === 0 ? 'win' : 'loss', pnlUsd: 1 });
  }
  assert.equal(d.symbolWinRates['BTC:momentum'].wins, 5);
  assert.equal(d.symbolWinRates['BTC:momentum'].losses, 5);
});

// ── recordRegimeOutcome ────────────────────────────────────────────────────

test('recordRegimeOutcome: uses regime|unknown:strategy key', () => {
  const d = emptyData();
  stats.recordRegimeOutcome(d, { regime: 'trend_up', strategy: 'momentum', outcome: 'win' });
  stats.recordRegimeOutcome(d, { regime: undefined, strategy: 'swing', outcome: 'loss' });
  assert.equal(d.regimeWinRates['trend_up:momentum'].wins, 1);
  assert.equal(d.regimeWinRates['unknown:swing'].losses, 1);
});

// ── recordChainOutcome ─────────────────────────────────────────────────────

test('recordChainOutcome: tracks wins/losses + hold minutes + trade count', () => {
  const d = emptyData();
  stats.recordChainOutcome(d, { chain: 'kucoin', strategy: 'momentum', outcome: 'win', holdMinutes: 30 });
  stats.recordChainOutcome(d, { chain: 'kucoin', strategy: 'momentum', outcome: 'win', holdMinutes: 60 });
  const b = d.chainPatterns['kucoin:momentum'];
  assert.equal(b.wins, 2);
  assert.equal(b.totalHoldMinutes, 90);
  assert.equal(b.tradeCount, 2);
});

// ── recordTokenAgeOutcome ──────────────────────────────────────────────────

test('recordTokenAgeOutcome: bucket key includes age + strategy', () => {
  const d = emptyData();
  stats.recordTokenAgeOutcome(d, { ageBucket: '1d', strategy: 'momentum', outcome: 'win', holdMinutes: 20 });
  stats.recordTokenAgeOutcome(d, { ageBucket: undefined, strategy: 'swing', outcome: 'loss', holdMinutes: 10 });
  assert.equal(d.tokenAgePatterns['1d:momentum'].wins, 1);
  assert.equal(d.tokenAgePatterns['unknown:swing'].losses, 1);
});

// ── recordExitClassification ───────────────────────────────────────────────

test('recordExitClassification: tracks per-exit-code stats', () => {
  const d = emptyData();
  stats.recordExitClassification(d, { chain: 'kucoin', strategy: 'momentum', exitCode: 'TAKE_PROFIT', outcome: 'win', pnlUsd: 5 });
  stats.recordExitClassification(d, { chain: 'kucoin', strategy: 'momentum', exitCode: 'STOP_LOSS', outcome: 'loss', pnlUsd: -2 });
  assert.equal(d.exitClassificationStats['kucoin:momentum:TAKE_PROFIT'].count, 1);
  assert.equal(d.exitClassificationStats['kucoin:momentum:TAKE_PROFIT'].wins, 1);
  assert.equal(d.exitClassificationStats['kucoin:momentum:STOP_LOSS'].losses, 1);
  assert.equal(d.exitClassificationStats['kucoin:momentum:STOP_LOSS'].totalPnlUsd, -2);
});

// ── recordIndicatorOutcome ─────────────────────────────────────────────────

test('recordIndicatorOutcome: bucket key includes indicator + strategy', () => {
  const d = emptyData();
  stats.recordIndicatorOutcome(d, { indicatorKey: 'rsi:30-40', strategy: 'momentum', outcome: 'win' });
  stats.recordIndicatorOutcome(d, { indicatorKey: 'rsi:30-40', strategy: 'momentum', outcome: 'win' });
  stats.recordIndicatorOutcome(d, { indicatorKey: 'rsi:70-80', strategy: 'momentum', outcome: 'loss' });
  assert.equal(d.indicatorPatterns['rsi:30-40:momentum'].wins, 2);
  assert.equal(d.indicatorPatterns['rsi:30-40:momentum'].tradeCount, 2);
  assert.equal(d.indicatorPatterns['rsi:70-80:momentum'].losses, 1);
});

// ── recordTradeOutcome (composite) ─────────────────────────────────────────

test('recordTradeOutcome: updates all 5 counter buckets in one call', () => {
  const d = emptyData();
  const entry = {
    symbol: 'BTC',
    strategy: 'momentum',
    chain: 'kucoin',
    outcome: 'win',
    pnlUsd: 12,
    holdMinutes: 45,
    entryRegime: 'trend_up',
  };
  stats.recordTradeOutcome(d, entry, { ts: 100, tokenAgeBucket: '1w', exitClassification: 'TAKE_PROFIT' });
  assert.equal(d.symbolWinRates['BTC:momentum'].wins, 1);
  assert.equal(d.regimeWinRates['trend_up:momentum'].wins, 1);
  assert.equal(d.chainPatterns['kucoin:momentum'].wins, 1);
  assert.equal(d.tokenAgePatterns['1w:momentum'].wins, 1);
  assert.equal(d.exitClassificationStats['kucoin:momentum:TAKE_PROFIT'].wins, 1);
  assert.equal(d.symbolWinRates['BTC:momentum'].lastTradeTs, 100);
});

test('recordTradeOutcome: throws on missing entry', () => {
  assert.throws(() => stats.recordTradeOutcome(emptyData(), null), /entry required/);
});

// ── Auto-create missing buckets ────────────────────────────────────────────

test('recordSymbolOutcome: creates data.symbolWinRates when missing', () => {
  const d = {}; // no buckets pre-created
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'win', pnlUsd: 1 });
  assert.ok(d.symbolWinRates);
  assert.equal(d.symbolWinRates['BTC:momentum'].wins, 1);
});

// ── Readers ────────────────────────────────────────────────────────────────

test('getSymbolStats: returns bucket or null', () => {
  const d = emptyData();
  stats.recordSymbolOutcome(d, { symbol: 'BTC', strategy: 'momentum', outcome: 'win', pnlUsd: 1 });
  assert.ok(stats.getSymbolStats(d, 'BTC', 'momentum'));
  assert.equal(stats.getSymbolStats(d, 'ETH', 'momentum'), null);
});

test('getRegimeStats: returns bucket or null', () => {
  const d = emptyData();
  stats.recordRegimeOutcome(d, { regime: 'trend_up', strategy: 'momentum', outcome: 'loss' });
  assert.equal(stats.getRegimeStats(d, 'trend_up', 'momentum').losses, 1);
  assert.equal(stats.getRegimeStats(d, 'trend_down', 'momentum'), null);
});

test('getChainStats: returns bucket or null', () => {
  const d = emptyData();
  stats.recordChainOutcome(d, { chain: 'kucoin', strategy: 'swing', outcome: 'win', holdMinutes: 5 });
  assert.equal(stats.getChainStats(d, 'kucoin', 'swing').wins, 1);
  assert.equal(stats.getChainStats(d, 'solana', 'swing'), null);
});

// ── winRate helper ─────────────────────────────────────────────────────────

test('winRate: computes wins / (wins + losses)', () => {
  assert.equal(stats.winRate({ wins: 3, losses: 1 }), 0.75);
  assert.equal(stats.winRate({ wins: 0, losses: 0 }), 0);
  assert.equal(stats.winRate({ wins: 10, losses: 10 }), 0.5);
  assert.equal(stats.winRate(null), 0);
});

// ── Defensive guards ───────────────────────────────────────────────────────

test('all recorders: throw on missing data', () => {
  const cases = [
    ['recordSymbolOutcome',       { symbol: 'BTC', strategy: 'm', outcome: 'win' }],
    ['recordRegimeOutcome',       { regime: 'r', strategy: 'm', outcome: 'win' }],
    ['recordChainOutcome',        { chain: 'c', strategy: 'm', outcome: 'win' }],
    ['recordTokenAgeOutcome',     { ageBucket: 'a', strategy: 'm', outcome: 'win' }],
    ['recordExitClassification',  { chain: 'c', strategy: 'm', exitCode: 'e', outcome: 'win' }],
    ['recordIndicatorOutcome',    { indicatorKey: 'i', strategy: 'm', outcome: 'win' }],
  ];
  for (const [fn, args] of cases) {
    assert.throws(() => stats[fn](null, args), /required/);
  }
});
