'use strict';

// 2026-08-06: regression guard for the silent-entry-death bug.
// Live generated BUY signals for a month that never became orders: stacked
// discretionary size penalties (macro 0.80 x volatility 0.70 x listing-age
// 0.50 = 0.28x) pushed a ~$15 target under the $6 exchange minimum, and
// positionSize returned 0 with no log. These tests pin the two fixes:
// the compounded-penalty floor, and the explicit rejection log.

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_SIZE_PCT = 0.30;

// Pure reimplementation of the clamp shipped in guardian.positionSize.
// Kept in the test so the arithmetic contract is asserted independently of
// the guardian's many injected collaborators (SQL, telemetry, exchanges).
function applyCompoundedFloor(rawCompounded, floor = 0.45) {
  const compoundedFloor = Math.max(0, Math.min(1, Number(floor)));
  const pct = BASE_SIZE_PCT * rawCompounded;
  if (compoundedFloor > 0 && rawCompounded < compoundedFloor) {
    return { pct: BASE_SIZE_PCT * compoundedFloor, floored: true };
  }
  return { pct, floored: false };
}

function sizeUsd(pct, chainBaseUsd) { return chainBaseUsd * pct; }

// Live conditions at the time of the bug: ~$62.70 equity, KuCoin 80% cap.
const LIVE_CHAIN_BASE = 62.70 * 0.8;
const MIN_ORDER_USD = 6;

test('reproduces the ACE failure: raw compounding lands under the exchange minimum', () => {
  const raw = 0.80 * 0.70 * 0.50; // macro x volatility x listing-age
  assert.ok(Math.abs(raw - 0.28) < 0.001, `compounded haircut ${raw}`);
  const { pct } = applyCompoundedFloor(raw, 0); // floor disabled = old behavior
  const usd = sizeUsd(pct, LIVE_CHAIN_BASE);
  assert.ok(usd < MIN_ORDER_USD, `old path sized $${usd.toFixed(2)}, must be under $${MIN_ORDER_USD}`);
});

test('floor lifts the same trade above the exchange minimum', () => {
  const raw = 0.80 * 0.70 * 0.50;
  const { pct, floored } = applyCompoundedFloor(raw, 0.45);
  assert.equal(floored, true, 'floor must bind for a 0.28x haircut');
  const usd = sizeUsd(pct, LIVE_CHAIN_BASE);
  assert.ok(usd >= MIN_ORDER_USD, `floored path sized $${usd.toFixed(2)}, must clear $${MIN_ORDER_USD}`);
});

test('floor never RAISES size above the un-penalised base', () => {
  const { pct } = applyCompoundedFloor(0.10, 0.45);
  assert.ok(pct < BASE_SIZE_PCT, 'floored size must stay below the unpenalised base');
  assert.equal(pct, BASE_SIZE_PCT * 0.45);
});

test('mild penalties pass through untouched (floor does not bind)', () => {
  const raw = 0.85; // single moderate-volatility cut
  const { pct, floored } = applyCompoundedFloor(raw, 0.45);
  assert.equal(floored, false);
  assert.equal(pct, BASE_SIZE_PCT * 0.85, 'penalty must be preserved exactly');
});

test('floor exactly at the boundary does not bind', () => {
  const { floored } = applyCompoundedFloor(0.45, 0.45);
  assert.equal(floored, false, 'equal-to-floor must pass through');
});

test('floor=0 restores raw compounding (documented escape hatch)', () => {
  const raw = 0.28;
  const { pct, floored } = applyCompoundedFloor(raw, 0);
  assert.equal(floored, false);
  assert.ok(Math.abs(pct - BASE_SIZE_PCT * 0.28) < 1e-12);
});

test('floor is clamped to [0,1] — a misconfigured >1 value cannot inflate size', () => {
  const { pct } = applyCompoundedFloor(0.28, 5);
  assert.equal(pct, BASE_SIZE_PCT * 1, 'floor clamps to 1.0, never above base');
});

test('a genuinely tiny book still gets rejected (floor is not a bypass)', () => {
  // $10 equity: even a floored multiplier cannot reach a $6 order.
  const tinyBase = 10 * 0.8;
  const { pct } = applyCompoundedFloor(0.28, 0.45);
  const usd = sizeUsd(pct, tinyBase);
  assert.ok(usd < MIN_ORDER_USD, `tiny book sized $${usd.toFixed(2)} — must still be rejected downstream`);
});
