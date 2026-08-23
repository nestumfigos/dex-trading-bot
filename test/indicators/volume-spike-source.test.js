'use strict';

// 2026-08-23: pins the bug that blocked every entry for ~50 days.
//
// volumeHistory was fed volume24hUsd — a 24-HOUR ROLLING TOTAL — sampled
// every scan cycle (~2 min). Consecutive samples of a 24h window are nearly
// identical, so latest/median(prior) collapsed to ~1.00 for every token,
// failing the volume gate on 85-92% of candidates. Gate telemetry measured
// 0.94-1.00 across 24 assets on both bots.
//
// These tests assert the DISTINCTION between the two input series, so the
// wrong one can never be silently reintroduced.

const test = require('node:test');
const assert = require('node:assert/strict');

const { volumeSpike } = require('../../src/utils/indicators');

// A 24h rolling total sampled every ~2 minutes: each sample adds the newest
// couple of minutes and drops the oldest, so the total barely moves — even
// when the CURRENT bar is genuinely exploding.
function rollingTwentyFourHourSamples({ base = 20_000_000, driftPct = 0.5, n = 12 }) {
  return Array.from({ length: n }, (_, i) => base * (1 + (driftPct / 100) * (i / n)));
}

// Real per-bar volumes: a quiet baseline then a genuine 4x spike on the
// latest completed bar.
function perBarVolumes({ baseline = 100_000, spikeMultiple = 4, n = 12 }) {
  const bars = Array.from({ length: n - 1 }, () => baseline * (0.9 + Math.random() * 0.2));
  bars.push(baseline * spikeMultiple);
  return bars;
}

test('REGRESSION: 24h rolling totals collapse volumeSpike to ~1.0 (the bug)', () => {
  const spike = volumeSpike(rollingTwentyFourHourSamples({}), { method: 'median', minBars: 8 });
  assert.ok(Math.abs(spike - 1) < 0.02, `rolling-total input produced ${spike}, expected ~1.0`);
  // And that is below every threshold the fleet has ever used.
  for (const threshold of [1.35, 1.5, 1.65, 1.8]) {
    assert.ok(spike < threshold, `~1.0 must fail threshold ${threshold} — no tuning could fix it`);
  }
});

test('per-bar volumes surface a real 4x spike', () => {
  const spike = volumeSpike(perBarVolumes({ spikeMultiple: 4 }), { method: 'median', minBars: 8 });
  assert.ok(spike > 3, `expected >3x, got ${spike}`);
  assert.ok(spike >= 1.65, 'a genuine 4x spike must clear the live threshold');
});

test('per-bar volumes stay below threshold when there is no spike', () => {
  const flat = Array.from({ length: 12 }, () => 100_000 * (0.95 + Math.random() * 0.1));
  const spike = volumeSpike(flat, { method: 'median', minBars: 8 });
  assert.ok(spike < 1.35, `flat tape must not fire a spike, got ${spike}`);
});

test('dropping the in-progress bar prevents a partial bar masking a spike', () => {
  // Prior bars quiet; last COMPLETED bar is a 4x spike; the in-progress bar
  // has only accumulated 10% of its volume so far.
  const completed = perBarVolumes({ spikeMultiple: 4 });
  const withPartial = [...completed, 10_000];

  const naive = volumeSpike(withPartial, { method: 'median', minBars: 8 });
  const corrected = volumeSpike(withPartial.slice(0, -1), { method: 'median', minBars: 8 });

  assert.ok(naive < 1, `partial bar makes the spike look like a slump (${naive})`);
  assert.ok(corrected > 3, `dropping it recovers the real spike (${corrected})`);
});

test('insufficient bars returns NaN rather than a misleading number', () => {
  assert.ok(Number.isNaN(volumeSpike([1, 2, 3], { minBars: 8 })));
});

test('zero baseline returns NaN (no divide-by-zero garbage)', () => {
  const zeros = Array.from({ length: 12 }, () => 0);
  assert.ok(Number.isNaN(volumeSpike(zeros, { minBars: 8 })));
});
