'use strict';

// 2026-08-24: once the volumeSpike fix let candidates reach the risk layer,
// estimateMarketImpact's hourly-volume-share cap rejected EVERY qualified
// signal — STORJ 1.08%, CYS 1.10%, PROM 0.99%, ATA 1.62% against a 0.85%
// cap, all only slightly over. The fix clamps size to fit the cap instead of
// refusing the trade. These tests pin that arithmetic.

const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the clamp shipped in guardian.positionSize.
function clampToLiquidity(sizeUsd, volume24hUsd, maxSharePct) {
  if (!(volume24hUsd > 0) || !(sizeUsd > 0)) return sizeUsd;
  const hourly = volume24hUsd / 24;
  const cap = hourly * (maxSharePct / 100);
  return cap > 0 && sizeUsd > cap ? cap : sizeUsd;
}

function sharePct(sizeUsd, volume24hUsd) {
  return (sizeUsd / (volume24hUsd / 24)) * 100;
}

const CAP = 0.85;

test('the four real blocked trades now fit the cap instead of being rejected', () => {
  // Reconstructed from production logs: share% -> implied size on that token.
  for (const [symbol, observedSharePct] of [['STORJ', 1.08], ['CYS', 1.10], ['PROM', 0.99], ['ATA', 1.62]]) {
    const volume24hUsd = 24 * 100_000;               // $100k/h reference
    const size = (observedSharePct / 100) * 100_000; // size that produced that share
    assert.ok(sharePct(size, volume24hUsd) > CAP, `${symbol} must exceed the cap pre-clamp`);
    const clamped = clampToLiquidity(size, volume24hUsd, CAP);
    assert.ok(sharePct(clamped, volume24hUsd) <= CAP + 1e-9, `${symbol} must fit the cap post-clamp`);
    assert.ok(clamped < size, `${symbol} must actually shrink`);
  }
});

test('clamp reduces, never inflates a size that already fits', () => {
  const volume24hUsd = 24 * 100_000;
  const small = 200; // 0.2% of hourly
  assert.equal(clampToLiquidity(small, volume24hUsd, CAP), small, 'compliant size must pass through untouched');
});

test('clamped size lands exactly at the cap, not above it', () => {
  const volume24hUsd = 24 * 50_000;
  const clamped = clampToLiquidity(10_000, volume24hUsd, CAP);
  assert.ok(Math.abs(sharePct(clamped, volume24hUsd) - CAP) < 1e-9);
});

test('illiquid token still yields a sub-minimum size (rejected downstream, not forced)', () => {
  // $12k/day token: cap allows only ~$4.25 — below a $6 minimum order.
  const clamped = clampToLiquidity(500, 12_000, CAP);
  assert.ok(clamped < 6, `expected sub-minimum, got $${clamped.toFixed(2)}`);
});

test('missing volume data leaves size untouched (no divide-by-zero)', () => {
  assert.equal(clampToLiquidity(300, 0, CAP), 300);
  assert.equal(clampToLiquidity(300, Number.NaN, CAP), 300);
});

test('cap scales linearly with liquidity', () => {
  const a = clampToLiquidity(1e9, 24 * 100_000, CAP);
  const b = clampToLiquidity(1e9, 24 * 200_000, CAP);
  assert.ok(Math.abs(b - a * 2) < 1e-6, 'twice the volume must permit twice the size');
});
