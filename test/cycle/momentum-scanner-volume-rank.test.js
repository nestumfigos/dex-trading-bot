'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rankKucoinByVolume } = require('../../src/cycle/momentum-scanner');

// Mirrors the real KuCoin universe shape observed 2026-08-03: dominated by
// dust (median ~$51k) with a thin high-volume head — the distribution that
// starved the blind rotation for 30 days.
function exchangeWith(volumes) {
  const tickerCache = {};
  for (const [base, quoteVolume] of Object.entries(volumes)) {
    tickerCache[`${base}/USDT`] = { quoteVolume };
  }
  return { tickerCache };
}

const UNIVERSE = ['BTC', 'ETH', 'SOL', 'MIDA', 'MIDB', 'DUST1', 'DUST2', 'DUST3'];
const VOLUMES = {
  BTC: 100_000_000,
  ETH: 50_000_000,
  SOL: 9_000_000,
  MIDA: 800_000,
  MIDB: 600_000,
  DUST1: 50_000,
  DUST2: 20_000,
  DUST3: 10_000,
};

test('sorts by descending 24h quote volume', () => {
  const out = rankKucoinByVolume(UNIVERSE, exchangeWith(VOLUMES), { minVolumeUsd: 0, minCandidates: 1 });
  assert.deepEqual(out.slice(0, 3), ['BTC', 'ETH', 'SOL']);
});

test('drops names below the volume floor (the core fix)', () => {
  const out = rankKucoinByVolume(UNIVERSE, exchangeWith(VOLUMES), { minVolumeUsd: 500_000, minCandidates: 1 });
  assert.deepEqual(out, ['BTC', 'ETH', 'SOL', 'MIDA', 'MIDB']);
  for (const dust of ['DUST1', 'DUST2', 'DUST3']) {
    assert.ok(!out.includes(dust), `${dust} must not reach the scanner`);
  }
});

test('live-sized floor ($5M) yields only the deep-liquidity head', () => {
  const out = rankKucoinByVolume(UNIVERSE, exchangeWith(VOLUMES), { minVolumeUsd: 5_000_000, minCandidates: 1 });
  assert.deepEqual(out, ['BTC', 'ETH', 'SOL']);
});

test('never starves: too-few qualifiers top up with next-best volume', () => {
  // Floor admits only BTC, but the cycle wants 4 names.
  const out = rankKucoinByVolume(UNIVERSE, exchangeWith(VOLUMES), { minVolumeUsd: 60_000_000, minCandidates: 4 });
  assert.equal(out.length, 4);
  assert.equal(out[0], 'BTC', 'highest volume still leads');
  assert.deepEqual(out, ['BTC', 'ETH', 'SOL', 'MIDA'], 'padded in volume order');
});

test('cold ticker cache falls back to the original universe (no empty scan)', () => {
  const out = rankKucoinByVolume(UNIVERSE, { tickerCache: {} }, { minVolumeUsd: 500_000, minCandidates: 40 });
  assert.equal(out.length, UNIVERSE.length, 'must not filter everything out on a cold cache');
});

test('partial ticker data still ranks the known names first', () => {
  const partial = exchangeWith({ SOL: 9_000_000, MIDA: 800_000 });
  const out = rankKucoinByVolume(UNIVERSE, partial, { minVolumeUsd: 0, minCandidates: 1 });
  assert.deepEqual(out.slice(0, 2), ['SOL', 'MIDA']);
});

test('excludes stablecoins and leveraged tokens', () => {
  const tokens = ['BTC', 'USDC', 'BTC3L', 'ETH3S'];
  const out = rankKucoinByVolume(tokens, exchangeWith({
    BTC: 100_000_000, USDC: 90_000_000, BTC3L: 80_000_000, ETH3S: 70_000_000,
  }), { minVolumeUsd: 0, minCandidates: 1 });
  assert.deepEqual(out, ['BTC'], 'stables + leveraged must be filtered despite high volume');
});

test('empty input returns empty (no throw)', () => {
  assert.deepEqual(rankKucoinByVolume([], exchangeWith({}), {}), []);
});

test('deduplicates repeated tokens', () => {
  const out = rankKucoinByVolume(['BTC', 'BTC', 'ETH'], exchangeWith(VOLUMES), { minVolumeUsd: 0, minCandidates: 1 });
  assert.deepEqual(out, ['BTC', 'ETH']);
});
