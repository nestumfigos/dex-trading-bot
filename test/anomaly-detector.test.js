'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeStats, isAnomaly, createWindow, createAnomalyAlerter } = require('../src/utils/anomaly-detector');

test('computeStats: empty → zeros', () => {
  const s = computeStats([]);
  assert.equal(s.mean, 0);
  assert.equal(s.stddev, 0);
  assert.equal(s.n, 0);
});

test('computeStats: insufficient samples (n<4) → zeros', () => {
  const s = computeStats([1, 2, 3]);
  assert.equal(s.mean, 0);
  assert.equal(s.stddev, 0);
});

test('computeStats: known values', () => {
  const s = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.mean, 5);
  assert.ok(Math.abs(s.stddev - 2) < 0.001);
  assert.equal(s.n, 8);
});

test('isAnomaly: value within 3σ → not anomaly', () => {
  const samples = [10, 10, 11, 9, 10, 12, 8, 10, 11];
  const r = isAnomaly(11.5, samples);
  assert.equal(r.anomaly, false);
});

test('isAnomaly: value beyond 3σ → anomaly', () => {
  const samples = [10, 10, 11, 9, 10, 12, 8, 10, 11];
  const r = isAnomaly(100, samples);
  assert.equal(r.anomaly, true);
  assert.ok(r.zScore > 3);
});

test('isAnomaly: insufficient samples → no anomaly + reason', () => {
  const r = isAnomaly(50, [1, 2]);
  assert.equal(r.anomaly, false);
  assert.equal(r.reason, 'insufficient_samples');
});

test('isAnomaly: zero stddev → no anomaly', () => {
  const r = isAnomaly(5, [5, 5, 5, 5, 5, 5, 5, 5]);
  assert.equal(r.anomaly, false);
});

test('createWindow: pushes + caps at maxSize', () => {
  const w = createWindow(5);
  for (let i = 0; i < 10; i += 1) w.push(i);
  assert.equal(w.size(), 5);
  assert.deepEqual(w.snapshot(), [5, 6, 7, 8, 9]);
});

test('createWindow: skips non-finite values', () => {
  const w = createWindow(10);
  w.push(1); w.push(NaN); w.push(null); w.push(Infinity); w.push(2);
  assert.equal(w.size(), 2);
});

test('createAnomalyAlerter: fires alert on anomaly + respects cooldown', () => {
  let alertCount = 0;
  const alerter = createAnomalyAlerter({ sendAlert: () => { alertCount += 1; }, cooldownMs: 1000 });
  const samples = [10, 10, 10, 10, 10, 10, 10, 11, 9];
  const r1 = alerter.check('pnl_daily', 100, samples);
  assert.equal(r1.fired, true);
  assert.equal(alertCount, 1);
  // Same metric within cooldown → suppressed
  const r2 = alerter.check('pnl_daily', 200, samples);
  assert.equal(r2.fired, false);
  assert.equal(r2.suppressed, true);
});

test('createAnomalyAlerter: normal value does not fire', () => {
  let fired = 0;
  const alerter = createAnomalyAlerter({ sendAlert: () => { fired += 1; } });
  const samples = [10, 10, 11, 9, 10, 12, 8, 10, 11];
  alerter.check('m', 10.5, samples);
  assert.equal(fired, 0);
});

test('createAnomalyAlerter: sendAlert throw does not propagate', () => {
  const alerter = createAnomalyAlerter({ sendAlert: () => { throw new Error('telegram down'); } });
  const samples = [10, 10, 11, 9, 10, 12, 8, 10, 11];
  assert.doesNotThrow(() => alerter.check('m', 100, samples));
});

test('createAnomalyAlerter: resetCooldown allows re-fire', () => {
  let count = 0;
  const alerter = createAnomalyAlerter({ sendAlert: () => { count += 1; }, cooldownMs: 9_999_999 });
  const samples = [10, 10, 11, 9, 10, 12, 8, 10, 11];
  alerter.check('m', 100, samples);
  alerter.check('m', 100, samples); // suppressed
  assert.equal(count, 1);
  alerter.resetCooldown('m');
  alerter.check('m', 100, samples);
  assert.equal(count, 2);
});
