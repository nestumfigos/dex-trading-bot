'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MERGE_KEYS, mergeFromRemote, assertMergeCoverage } = require('../../src/agent/memory/merge');
const { MEMORY_DATA_SHAPE, DATA_SHAPE_KEYS } = require('../../src/agent/memory/shape');

test('MERGE_KEYS covers every key in MEMORY_DATA_SHAPE (catches 2026-05-16 bug regression)', () => {
  const missing = DATA_SHAPE_KEYS.filter((k) => !MERGE_KEYS.includes(k));
  assert.deepEqual(missing, [],
    `MERGE_KEYS is missing keys from MEMORY_DATA_SHAPE: ${missing.join(', ')}. ` +
    `Add to merge.js MERGE_KEYS and extend mergeFromRemote() to handle them, ` +
    `or they will be silently wiped on every SQL merge.`);
});

test('MERGE_KEYS has no extra keys not in MEMORY_DATA_SHAPE', () => {
  const extra = MERGE_KEYS.filter((k) => !DATA_SHAPE_KEYS.includes(k));
  assert.deepEqual(extra, [],
    `MERGE_KEYS lists keys not in shape: ${extra.join(', ')}. ` +
    `Remove from MERGE_KEYS OR add to shape.js MEMORY_DATA_SHAPE.`);
});

test('assertMergeCoverage() passes on current shape (sanity)', () => {
  assert.doesNotThrow(() => assertMergeCoverage());
});

test('MEMORY_DATA_SHAPE includes all the 6 fields that broke on 2026-05-16', () => {
  // Regression check: these were the keys silently wiped by old _mergeFromRemote
  // because they were absent from its merge dispatch.
  const wipedKeys = [
    'symbolWinRates',
    'regimeWinRates',
    'chainPatterns',
    'tokenAgePatterns',
    'exitClassificationStats',
    'indicatorPatterns',
  ];
  for (const k of wipedKeys) {
    assert.ok(DATA_SHAPE_KEYS.includes(k), `${k} must be in shape`);
    assert.ok(MERGE_KEYS.includes(k), `${k} must be in MERGE_KEYS`);
  }
});

test('AgentMemory constructor data shape matches DATA_SHAPE_KEYS', () => {
  // Reflection: if someone adds a new field to AgentMemory constructor
  // without updating shape.js, this catches it.
  const AgentMemory = require('../../src/agent/agentMemory');
  const mem = new AgentMemory({ logger: { warn(){}, info(){}, debug(){}, error(){} } });
  const constructorKeys = Object.keys(mem.data);
  const inConstructorButNotShape = constructorKeys.filter((k) => !DATA_SHAPE_KEYS.includes(k));
  assert.deepEqual(inConstructorButNotShape, [],
    `AgentMemory.data has keys not in shape.js: ${inConstructorButNotShape.join(', ')}. ` +
    `Add them to MEMORY_DATA_SHAPE and MERGE_KEYS, or they will be wiped on SQL merge.`);
  const inShapeButNotConstructor = DATA_SHAPE_KEYS.filter((k) => !constructorKeys.includes(k));
  assert.deepEqual(inShapeButNotConstructor, [],
    `shape.js has keys not in AgentMemory.data: ${inShapeButNotConstructor.join(', ')}. ` +
    `Either init them in constructor or remove from shape.`);
});
