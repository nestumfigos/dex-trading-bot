'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeFromRemote, mergeArrayById, mergeMap, mergeCounters } = require('../../src/agent/memory/merge');

const caps = { MAX_LESSONS: 300, MAX_DISCOVERIES: 100, MAX_KNOWLEDGE: 600, MAX_EVOLUTION_LOG: 50 };
const helpers = {
  stableKnowledgeId: (item) => `k:${item.insight || ''}`,
  normalizeAiUsage: (v = {}) => ({ date: v.date || '2026-05-16', lessonCalls: v.lessonCalls || 0, deepResearchCalls: v.deepResearchCalls || 0 }),
  mergeAiUsage: (a = {}, b = {}) => ({
    date: '2026-05-16',
    lessonCalls: Math.max(a.lessonCalls || 0, b.lessonCalls || 0),
    deepResearchCalls: Math.max(a.deepResearchCalls || 0, b.deepResearchCalls || 0),
  }),
};

function populated() {
  return {
    version: 2,
    tradeLessons:        [{ id: 'l1', ts: 1, lesson: 'a' }],
    strategyDiscoveries: [{ id: 'd1', ts: 1 }],
    tokenBlacklist:      { KCS: { addedAt: 1, expiresAt: 9 } },
    tokenPreferences:    { BNB: { addedAt: 1, expiresAt: 9 } },
    evolutionOutcomes:   [{ patch: 'p1' }],
    knowledgeBase:       [{ insight: 'i1', ts: 1 }],
    symbolWinRates:      { KCS: { wins: 2, losses: 1, totalPnlUsd: 10 } },
    regimeWinRates:      { trend_up: { wins: 3, losses: 0, totalPnlUsd: 20 } },
    chainPatterns:       { kucoin: { wins: 5, losses: 2, totalPnlUsd: 50 } },
    tokenAgePatterns:    { '1d': { wins: 1, losses: 1 } },
    exitClassificationStats: { TAKE_PROFIT: { wins: 2, losses: 0 } },
    indicatorPatterns:   { 'rsi:30-40': { wins: 4, losses: 1 } },
    aiUsage:             { date: '2026-05-16', lessonCalls: 3, deepResearchCalls: 1 },
  };
}

test('roundtrip: counters survive merge with empty remote', () => {
  const current = populated();
  const merged = mergeFromRemote({ current, remote: {}, caps, helpers });
  // All 6 historically-wiped counter buckets preserved
  assert.equal(merged.symbolWinRates.KCS.wins, 2);
  assert.equal(merged.regimeWinRates.trend_up.totalPnlUsd, 20);
  assert.equal(merged.chainPatterns.kucoin.wins, 5);
  assert.equal(merged.tokenAgePatterns['1d'].wins, 1);
  assert.equal(merged.exitClassificationStats.TAKE_PROFIT.wins, 2);
  assert.equal(merged.indicatorPatterns['rsi:30-40'].wins, 4);
});

test('roundtrip: counters sum across remote + local', () => {
  const current = populated();
  const remote = {
    symbolWinRates: { KCS: { wins: 1, losses: 0, totalPnlUsd: 5 } },
  };
  const merged = mergeFromRemote({ current, remote, caps, helpers });
  assert.equal(merged.symbolWinRates.KCS.wins, 3, '2+1');
  assert.equal(merged.symbolWinRates.KCS.losses, 1, '1+0');
  assert.equal(merged.symbolWinRates.KCS.totalPnlUsd, 15, '10+5');
});

test('roundtrip: arrays merge by id, prefer newest ts', () => {
  const current = { tradeLessons: [{ id: 'l1', ts: 5, lesson: 'newer' }] };
  const remote  = { tradeLessons: [{ id: 'l1', ts: 1, lesson: 'older' }, { id: 'l2', ts: 2 }] };
  const merged = mergeFromRemote({ current, remote, caps, helpers });
  const l1 = merged.tradeLessons.find((x) => x.id === 'l1');
  assert.equal(l1.lesson, 'newer', 'higher ts wins');
  assert.equal(merged.tradeLessons.length, 2);
});

test('roundtrip: maps prefer newer addedAt OR longer expiry (original semantics)', () => {
  // Case A: newer addedAt wins (even with shorter expiry — OR semantics)
  let merged = mergeFromRemote({
    current: { tokenBlacklist: { KCS: { addedAt: 5, expiresAt: 10 } } },
    remote:  { tokenBlacklist: { KCS: { addedAt: 2, expiresAt: 20 } } },
    caps, helpers,
  });
  assert.equal(merged.tokenBlacklist.KCS.addedAt, 5, 'newer addedAt wins');
  assert.equal(merged.tokenBlacklist.KCS.expiresAt, 10);

  // Case B: longer expiry wins when addedAt is older
  merged = mergeFromRemote({
    current: { tokenBlacklist: { KCS: { addedAt: 1, expiresAt: 30 } } },
    remote:  { tokenBlacklist: { KCS: { addedAt: 2, expiresAt: 5 } } },
    caps, helpers,
  });
  assert.equal(merged.tokenBlacklist.KCS.expiresAt, 30, 'longer expiry wins when addedAt comparable');
});

test('roundtrip: handles non-object remote without throwing', () => {
  const current = populated();
  assert.equal(mergeFromRemote({ current, remote: null, caps, helpers }), current);
  assert.equal(mergeFromRemote({ current, remote: undefined, caps, helpers }), current);
  assert.equal(mergeFromRemote({ current, remote: 'string', caps, helpers }), current);
});

test('roundtrip: 3 successive merges do not lose counters (regression for 2026-05-16)', () => {
  let state = populated();
  for (let i = 0; i < 3; i++) {
    state = mergeFromRemote({
      current: state,
      remote: { symbolWinRates: {} }, // empty remote (just keys touched)
      caps, helpers,
    });
  }
  // After 3 merges, counters should still be intact (they used to wipe).
  assert.equal(state.symbolWinRates.KCS.wins, 2, '3 merges preserved KCS wins');
  assert.equal(state.indicatorPatterns['rsi:30-40'].wins, 4, 'indicator preserved');
  assert.equal(state.chainPatterns.kucoin.wins, 5, 'chain preserved');
});

test('mergeArrayById caps result + sorts newest first', () => {
  const a = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, ts: i }));
  const b = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, ts: i + 10 }));
  const merged = mergeArrayById(a, b, 4);
  assert.equal(merged.length, 4);
  assert.equal(merged[0].ts, 14, 'newest first');
});

test('mergeMap empty cases', () => {
  assert.deepEqual(mergeMap(), {});
  assert.deepEqual(mergeMap({ a: 1 }), { a: 1 });
  assert.deepEqual(mergeMap({}, { a: 1 }), { a: 1 });
});

test('mergeCounters initializes counters when only one side has values', () => {
  const merged = mergeCounters({}, { KCS: { wins: 3, losses: 1 } });
  assert.equal(merged.KCS.wins, 3);
  assert.equal(merged.KCS.losses, 1);
});
