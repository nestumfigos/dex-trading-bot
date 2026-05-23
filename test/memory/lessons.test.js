'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordLessonInto, checkLessonsFor } = require('../../src/agent/memory/lessons');

function makeData() {
  return { tradeLessons: [] };
}

test('recordLessonInto: inserts entry at head with required fields', () => {
  const data = makeData();
  const entry = recordLessonInto(data, {
    symbol: 'abc', chain: 'kucoin', strategy: 'momentum',
    outcome: 'loss', pnlUsd: -5, pnlPct: -2, lesson: 'X',
  });
  assert.equal(data.tradeLessons.length, 1);
  assert.equal(entry.symbol, 'ABC');
  assert.equal(entry.outcome, 'loss');
  assert.ok(entry.id);
});

test('recordLessonInto: caps at maxLessons (newest first)', () => {
  const data = makeData();
  for (let i = 0; i < 12; i += 1) {
    recordLessonInto(data, { symbol: `T${i}`, outcome: 'loss', pnlUsd: -1 }, { maxLessons: 10 });
  }
  assert.equal(data.tradeLessons.length, 10);
  assert.equal(data.tradeLessons[0].symbol, 'T11');
});

test('recordLessonInto: outcome other than win defaults to loss', () => {
  const data = makeData();
  const entry = recordLessonInto(data, { symbol: 'X', outcome: 'foo' });
  assert.equal(entry.outcome, 'loss');
});

test('checkLessonsFor: returns blocked when same-symbol repeat exceeds threshold', () => {
  const data = makeData();
  recordLessonInto(data, {
    symbol: 'CHIP', strategy: 'momentum', chain: 'kucoin',
    outcome: 'loss', pnlUsd: -10, lesson: 'rsi too high',
    entryConditions: { rsi: 75, volumeSpike: 3 },
    entryRegime: 'choppy',
  });
  const r = checkLessonsFor(data, 'CHIP', {
    rsi: 73, strategy: 'momentum', chain: 'kucoin', volumeSpike: 3.2, regime: 'choppy',
  }, { blockThreshold: 50, warnThreshold: 30 });
  assert.equal(r.blocked, true);
  assert.match(r.reason, /Memory block/);
});

test('checkLessonsFor: returns warned (not blocked) for partial match', () => {
  const data = makeData();
  recordLessonInto(data, {
    symbol: 'CHIP', strategy: 'momentum', chain: 'kucoin',
    outcome: 'loss', pnlUsd: -10, lesson: 'rsi too high',
    entryConditions: { rsi: 75 },
  });
  const r = checkLessonsFor(data, 'OTHER', {
    rsi: 70, strategy: 'momentum', chain: 'kucoin',
  }, { blockThreshold: 60, warnThreshold: 20 });
  assert.equal(r.blocked, false);
  assert.equal(r.warned, true);
});

test('checkLessonsFor: skips lessons with outcome=win', () => {
  const data = makeData();
  recordLessonInto(data, { symbol: 'CHIP', outcome: 'win', pnlUsd: 5 });
  const r = checkLessonsFor(data, 'CHIP', { rsi: 70 });
  assert.equal(r.blocked, false);
  assert.equal(r.matchedLessons.length, 0);
});

test('checkLessonsFor: decay factor reduces old-lesson weight', () => {
  const data = makeData();
  const lesson = recordLessonInto(data, {
    symbol: 'OLD', outcome: 'loss', pnlUsd: -5, entryConditions: { rsi: 75 },
  });
  lesson.ts = Date.now() - 30 * 24 * 3_600_000;
  const r = checkLessonsFor(data, 'OLD', { rsi: 73 }, { blockThreshold: 60, warnThreshold: 35 });
  assert.equal(r.blocked, false);
});
