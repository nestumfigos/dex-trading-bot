'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addKnowledgeInto, getKnowledgeFrom,
  recordEvolutionOutcomeInto, getEvolutionSummary, shouldPauseEvolution,
} = require('../../src/agent/memory/knowledge');

function makeData() {
  return { knowledgeBase: [], evolutionOutcomes: [] };
}

test('addKnowledgeInto: appends + clamps confidence', () => {
  const data = makeData();
  const e = addKnowledgeInto(data, { category: 'risk', insight: 'X', source: 's', confidence: 150 });
  assert.equal(e.confidence, 100);
  assert.equal(data.knowledgeBase.length, 1);
});

test('addKnowledgeInto: dedupes within 12h window', () => {
  const data = makeData();
  addKnowledgeInto(data, { category: 'risk', insight: 'X', source: 's', confidence: 50 });
  const second = addKnowledgeInto(data, { category: 'risk', insight: 'X', source: 's', confidence: 50 });
  assert.equal(second, null);
  assert.equal(data.knowledgeBase.length, 1);
});

test('addKnowledgeInto: caps at maxKnowledge', () => {
  const data = makeData();
  for (let i = 0; i < 12; i += 1) {
    addKnowledgeInto(data, { category: 'c', insight: `i${i}`, source: 's' }, { maxKnowledge: 10 });
  }
  assert.equal(data.knowledgeBase.length, 10);
});

test('getKnowledgeFrom: filters by category', () => {
  const data = makeData();
  addKnowledgeInto(data, { category: 'a', insight: '1' });
  addKnowledgeInto(data, { category: 'b', insight: '2' });
  assert.equal(getKnowledgeFrom(data, { category: 'a' }).length, 1);
  assert.equal(getKnowledgeFrom(data, {}).length, 2);
});

test('recordEvolutionOutcomeInto: derives verdict=improved for big gains', () => {
  const data = makeData();
  const e = recordEvolutionOutcomeInto(data, {
    pfBefore: 1.0, pfAfter: 1.2, wrBefore: 50, wrAfter: 55, sampleSizeAfter: 20,
  });
  assert.equal(e.verdict, 'improved');
});

test('recordEvolutionOutcomeInto: derives verdict=regressed for losses', () => {
  const data = makeData();
  const e = recordEvolutionOutcomeInto(data, {
    pfBefore: 1.2, pfAfter: 1.0, wrBefore: 60, wrAfter: 50, sampleSizeAfter: 20,
  });
  assert.equal(e.verdict, 'regressed');
});

test('recordEvolutionOutcomeInto: small sample → inconclusive', () => {
  const data = makeData();
  const e = recordEvolutionOutcomeInto(data, {
    pfBefore: 1.0, pfAfter: 2.0, wrBefore: 30, wrAfter: 80, sampleSizeAfter: 3,
  });
  assert.equal(e.verdict, 'inconclusive');
});

test('shouldPauseEvolution: < 4 recent → not paused', () => {
  const data = makeData();
  recordEvolutionOutcomeInto(data, { pfBefore: 1, pfAfter: 1, sampleSizeAfter: 20 });
  recordEvolutionOutcomeInto(data, { pfBefore: 1, pfAfter: 1, sampleSizeAfter: 20 });
  assert.equal(shouldPauseEvolution(data).paused, false);
});

test('shouldPauseEvolution: 3+ regressions → paused', () => {
  const data = makeData();
  for (let i = 0; i < 4; i += 1) {
    recordEvolutionOutcomeInto(data, {
      pfBefore: 1.2, pfAfter: 1.0, wrBefore: 60, wrAfter: 50, sampleSizeAfter: 20,
    });
  }
  assert.equal(shouldPauseEvolution(data).paused, true);
});

test('getEvolutionSummary: counts by verdict', () => {
  const data = makeData();
  recordEvolutionOutcomeInto(data, { pfBefore: 1.0, pfAfter: 1.2, wrBefore: 50, wrAfter: 55, sampleSizeAfter: 20 });
  recordEvolutionOutcomeInto(data, { pfBefore: 1.2, pfAfter: 1.0, wrBefore: 60, wrAfter: 50, sampleSizeAfter: 20 });
  const s = getEvolutionSummary(data);
  assert.equal(s.improved, 1);
  assert.equal(s.regressed, 1);
});
