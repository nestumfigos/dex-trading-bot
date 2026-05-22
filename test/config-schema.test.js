'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { KNOBS, castValue, validate, listKnobs, getKnobSpec } = require('../src/config/schema');

test('schema exposes core knobs', () => {
  for (const name of ['BOT_PROFILE', 'PORT', 'MAX_POSITION_SIZE_PCT', 'SELF_EVOLUTION_ENABLED']) {
    assert.ok(KNOBS[name], `${name} should be in schema`);
  }
});

test('castValue: int respects min/max', () => {
  assert.equal(castValue('PORT', '3002'), 3002);
  assert.throws(() => castValue('PORT', '80'), /below min/);
  assert.throws(() => castValue('PORT', '99999'), /above max/);
});

test('castValue: bool accepts common truthy strings', () => {
  for (const s of ['true', '1', 'yes', 'on', 'TRUE']) {
    assert.equal(castValue('LEARNING_ENABLED', s), true);
  }
  for (const s of ['false', '0', 'no', 'off']) {
    assert.equal(castValue('LEARNING_ENABLED', s), false);
  }
});

test('castValue: enum rejects out-of-set values', () => {
  assert.equal(castValue('BOT_PROFILE', 'live'), 'live');
  assert.throws(() => castValue('BOT_PROFILE', 'mainnet'), /not in enum/);
});

test('castValue: empty string uses default', () => {
  assert.equal(castValue('PORT', ''), 3002);
  assert.equal(castValue('PORT', undefined), 3002);
});

test('castValue: float rejects non-numeric', () => {
  assert.throws(() => castValue('MAX_POSITION_SIZE_PCT', 'abc'), /not float/);
});

test('castValue: json parses MOMENTUM_SELL_TIERS', () => {
  const tiers = [{ profitMultiplier: 1.04, sellPct: 0.3 }];
  const got = castValue('MOMENTUM_SELL_TIERS', JSON.stringify(tiers));
  assert.deepEqual(got, tiers);
});

test('validate: current process.env passes (no errors)', () => {
  const res = validate(process.env, { strictUnknown: false });
  assert.equal(res.errors.length, 0, `errors: ${res.errors.join(', ')}`);
});

test('validate: bad knob value caught', () => {
  const env = { PORT: 'notanumber', BOT_PROFILE: 'live' };
  const res = validate(env, { strictUnknown: false });
  assert.ok(res.errors.some((e) => e.startsWith('PORT:')));
});

test('validate: strictUnknown rejects unknown vars', () => {
  const env = { TOTALLY_MADE_UP_KNOB: 'x' };
  const res = validate(env, { strictUnknown: true });
  assert.ok(res.errors.some((e) => e.includes('Unknown env vars')));
});

test('validate: STRATEGY_MOMENTUM_MAX_POSITIONS regression (typo example from 2026-05-16)', () => {
  // The fictitious env var that was set but never read. Should be flagged as unknown.
  const env = { STRATEGY_MOMENTUM_MAX_POSITIONS: '5' };
  const res = validate(env);
  assert.ok(res.unknown.includes('STRATEGY_MOMENTUM_MAX_POSITIONS'));
});

test('listKnobs returns array with name', () => {
  const list = listKnobs();
  assert.ok(list.length >= 30);
  assert.ok(list.every((k) => k.name && k.type));
});

test('getKnobSpec returns null for unknown', () => {
  assert.equal(getKnobSpec('NOT_A_REAL_KNOB'), null);
  assert.ok(getKnobSpec('PORT'));
});

test('secret knobs do not have hotReload=true (security: secrets should not be in DB)', () => {
  for (const [name, spec] of Object.entries(KNOBS)) {
    if (spec.secret) {
      assert.notEqual(spec.hotReload, true, `${name}: secret knobs must not be hotReload`);
    }
  }
});
