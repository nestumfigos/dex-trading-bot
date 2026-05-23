'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getRegimeContext, getChainContext, getSymbolContext, getTokenAgeContext,
} = require('../../src/agent/memory/insights');

test('getRegimeContext: low sample → no insights', () => {
  const data = { regimeWinRates: { 'choppy:momentum': { wins: 1, losses: 1 } } };
  const r = getRegimeContext(data, { regime: 'choppy', strategy: 'momentum' });
  assert.equal(r.totalTrades, 2);
  assert.equal(r.insights.length, 0);
});

test('getRegimeContext: high winrate emits ✅ insight', () => {
  const data = { regimeWinRates: { 'trending:momentum': { wins: 6, losses: 2 } } };
  const r = getRegimeContext(data, { regime: 'trending', strategy: 'momentum' });
  assert.equal(r.winRate, 75);
  assert.match(r.insights[0], /✅.*75%/);
});

test('getRegimeContext: low winrate emits ⚠️ caution', () => {
  const data = { regimeWinRates: { 'risk_off:momentum': { wins: 1, losses: 6 } } };
  const r = getRegimeContext(data, { regime: 'risk_off', strategy: 'momentum' });
  assert.match(r.insights[0], /⚠️.*require higher confidence/);
});

test('getChainContext: emits per-chain stats above min sample', () => {
  const data = { chainPatterns: { 'kucoin:momentum': { wins: 5, losses: 2, totalHoldMinutes: 700, tradeCount: 7 } } };
  const r = getChainContext(data, { chain: 'kucoin', strategy: 'momentum' });
  assert.equal(r.winRate, 71);
  assert.equal(r.avgHoldMinutes, 100);
  assert.equal(r.insights.length, 2);
});

test('getSymbolContext: stale data returns empty', () => {
  const data = {
    symbolWinRates: {
      'OLD:momentum': { wins: 0, losses: 5, totalPnlUsd: -50, lastTradeTs: Date.now() - 30 * 24 * 3600 * 1000 },
    },
  };
  const r = getSymbolContext(data, { symbol: 'OLD', strategy: 'momentum', windowDays: 14 });
  assert.equal(r.recentLosses, 0);
  assert.equal(r.penaltyPct, 0);
});

test('getSymbolContext: 3+ losses no wins emits ⚠️', () => {
  const data = {
    symbolWinRates: {
      'CHIP:momentum': { wins: 0, losses: 4, totalPnlUsd: -40, lastTradeTs: Date.now() },
    },
  };
  const r = getSymbolContext(data, { symbol: 'CHIP', strategy: 'momentum' });
  assert.equal(r.recentLosses, 4);
  assert.equal(r.penaltyPct, 20);
  assert.match(r.insights[0], /⚠️/);
});

test('getTokenAgeContext: low winrate above min sample emits ⚠️', () => {
  const data = { tokenAgePatterns: { 'new:momentum': { wins: 1, losses: 4, tradeCount: 5 } } };
  const r = getTokenAgeContext(data, { tokenAgeBucket: 'new', strategy: 'momentum' });
  assert.match(r.insights[0], /⚠️.*require higher confidence/);
});
