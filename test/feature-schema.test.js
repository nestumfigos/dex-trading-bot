'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEATURE_ORDER,
  FEATURE_SCHEMA_VERSION,
  getFeatureSchemaHash,
  summarizeFeatureParity,
} = require('../src/utils/feature-schema');

test('feature schema hash is stable for the canonical order', () => {
  const first = getFeatureSchemaHash(FEATURE_ORDER, FEATURE_SCHEMA_VERSION);
  const second = getFeatureSchemaHash([...FEATURE_ORDER], FEATURE_SCHEMA_VERSION);
  assert.equal(first, second);
});

test('feature parity reports missing features cleanly', () => {
  const parity = summarizeFeatureParity({ priceChange24hPct: 2, return1Pct: 0.5 }, FEATURE_ORDER);
  assert.equal(parity.featureCount, FEATURE_ORDER.length);
  assert.equal(parity.presentCount, 2);
  assert.ok(parity.missing.includes('rsi'));
  assert.ok(parity.coverage < 1);
});
