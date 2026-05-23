'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  regimePatternSizeMultiplier,
  chainAllowedByRegimePattern,
  getCachedRegimePattern,
  _internal,
} = require('../src/agent/regime-patterns');

test('regimePatternSizeMultiplier: defaults to 1.0 on null/zero/negative', () => {
  assert.equal(regimePatternSizeMultiplier(null), 1.0);
  assert.equal(regimePatternSizeMultiplier({ size_multiplier: 0 }), 1.0);
  assert.equal(regimePatternSizeMultiplier({ size_multiplier: -1 }), 1.0);
  assert.equal(regimePatternSizeMultiplier({ size_multiplier: NaN }), 1.0);
});

test('regimePatternSizeMultiplier: returns valid multiplier', () => {
  assert.equal(regimePatternSizeMultiplier({ size_multiplier: 0.5 }), 0.5);
  assert.equal(regimePatternSizeMultiplier({ size_multiplier: 1.5 }), 1.5);
});

test('chainAllowedByRegimePattern: avoid_chains blocks named chain', () => {
  const row = { avoid_chains: 'solana,bsc' };
  assert.equal(chainAllowedByRegimePattern(row, 'solana'), false);
  assert.equal(chainAllowedByRegimePattern(row, 'kucoin'), true);
});

test('chainAllowedByRegimePattern: preferred_chains gates non-listed', () => {
  const row = { preferred_chains: 'kucoin,bsc' };
  assert.equal(chainAllowedByRegimePattern(row, 'kucoin'), true);
  assert.equal(chainAllowedByRegimePattern(row, 'solana'), false);
});

test('chainAllowedByRegimePattern: avoid wins over preferred', () => {
  const row = { preferred_chains: 'kucoin', avoid_chains: 'kucoin' };
  assert.equal(chainAllowedByRegimePattern(row, 'kucoin'), false);
});

test('chainAllowedByRegimePattern: null row or chain → allowed', () => {
  assert.equal(chainAllowedByRegimePattern(null, 'kucoin'), true);
  assert.equal(chainAllowedByRegimePattern({ avoid_chains: 'x' }, ''), true);
});

test('getCachedRegimePattern: undefined when never fetched', () => {
  _internal._flushCache();
  assert.equal(getCachedRegimePattern({ regime: 'trend_up', strategy: 'momentum' }), undefined);
});

test('_key normalizes case', () => {
  assert.equal(_internal._key('Trend_Up', 'Momentum', 'GLOBAL'), 'trend_up|momentum|global');
});
