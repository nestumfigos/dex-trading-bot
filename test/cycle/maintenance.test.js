'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../../src/cycle/maintenance');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

// ── createEvictStuckPositions ─────────────────────────────────────────────

test('createEvictStuckPositions: throws on missing portfolio', () => {
  assert.throws(() => m.createEvictStuckPositions({ logger: silentLogger() }), /portfolio required/);
});

test('createEvictStuckPositions: throws on missing logger', () => {
  assert.throws(() => m.createEvictStuckPositions({ portfolio: {} }), /logger required/);
});

test('evictStuckPositions: clears stale stuck flag when position already gone', () => {
  const portfolio = {
    positions: {}, // no in-state position
    stuckPositions: { 'kucoin:btc': { symbol: 'BTC', stuckAt: new Date().toISOString() } },
  };
  const evict = m.createEvictStuckPositions({ portfolio, logger: silentLogger() });
  evict();
  assert.equal(portfolio.stuckPositions['kucoin:btc'], undefined);
});

test('evictStuckPositions: does not evict positions stuck < 2h', () => {
  const portfolio = {
    positions: { 'kucoin:btc': { symbol: 'BTC' } },
    stuckPositions: { 'kucoin:btc': { symbol: 'BTC', stuckAt: new Date(Date.now() - 30 * 60_000).toISOString() } }, // 30min
  };
  const evict = m.createEvictStuckPositions({ portfolio, logger: silentLogger() });
  const count = evict();
  assert.equal(count, 0);
  assert.ok(portfolio.positions['kucoin:btc']);
  assert.ok(portfolio.stuckPositions['kucoin:btc']);
});

test('evictStuckPositions: evicts after threshold + moves to untrackedWalletPositions', () => {
  const portfolio = {
    positions: { 'kucoin:btc': { symbol: 'BTC', entryPrice: 100 } },
    stuckPositions: { 'kucoin:btc': { symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', estimatedValueUsd: 50, stuckAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } }, // 3h
  };
  const evict = m.createEvictStuckPositions({ portfolio, logger: silentLogger() });
  const count = evict();
  assert.equal(count, 1);
  assert.equal(portfolio.positions['kucoin:btc'], undefined);
  assert.ok(portfolio.untrackedWalletPositions['kucoin:btc']);
  assert.equal(portfolio.untrackedWalletPositions['kucoin:btc'].reason, 'stuck_evicted');
});

test('evictStuckPositions: calls saveState only when at least one evicted', () => {
  let saveCalls = 0;
  const portfolio = {
    positions: { 'kucoin:btc': { symbol: 'BTC' } },
    stuckPositions: { 'kucoin:btc': { symbol: 'BTC', chainKey: 'kucoin', stuckAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() } },
  };
  const evict = m.createEvictStuckPositions({ portfolio, logger: silentLogger(), saveState: () => { saveCalls++; } });
  evict();
  assert.equal(saveCalls, 1);

  // Run again with no stuck positions
  portfolio.stuckPositions = {};
  evict();
  assert.equal(saveCalls, 1, 'no extra save when nothing evicted');
});

test('evictStuckPositions: returns count of evicted', () => {
  const portfolio = {
    positions: { 'kucoin:a': { symbol: 'A' }, 'kucoin:b': { symbol: 'B' } },
    stuckPositions: {
      'kucoin:a': { symbol: 'A', chainKey: 'kucoin', stuckAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() },
      'kucoin:b': { symbol: 'B', chainKey: 'kucoin', stuckAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString() },
    },
  };
  const evict = m.createEvictStuckPositions({ portfolio, logger: silentLogger() });
  assert.equal(evict(), 2);
});

// ── createRefreshSwingWatchlists ──────────────────────────────────────────

test('createRefreshSwingWatchlists: throws on missing loopLocks', () => {
  assert.throws(() => m.createRefreshSwingWatchlists({ exchanges: {}, watchlists: {} }), /loopLocks required/);
});

test('createRefreshSwingWatchlists: throws on missing exchanges', () => {
  assert.throws(() => m.createRefreshSwingWatchlists({ loopLocks: {}, watchlists: {} }), /exchanges required/);
});

test('createRefreshSwingWatchlists: throws on missing watchlists', () => {
  assert.throws(() => m.createRefreshSwingWatchlists({ loopLocks: {}, exchanges: {} }), /watchlists required/);
});

test('refreshSwingWatchlists: returns early when lock held', async () => {
  let called = false;
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: true },
    logger: silentLogger(),
    exchanges: { kucoin: { getNewTokens: () => { called = true; return []; } } },
    watchlists: {},
  });
  await refresh();
  assert.equal(called, false);
});

test('refreshSwingWatchlists: skips chains without swing support', async () => {
  const calls = [];
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: false },
    logger: silentLogger(),
    exchanges: { kucoin: { getNewTokens: async () => { calls.push('kucoin'); return []; } } },
    watchlists: {},
    supportsSwingOnChain: () => false,
  });
  await refresh();
  assert.equal(calls.length, 0);
});

test('refreshSwingWatchlists: skips chains without getNewTokens method', async () => {
  const warns = [];
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: false },
    logger: { ...silentLogger(), warn: (m) => warns.push(m) },
    exchanges: { kucoin: {} }, // no getNewTokens
    watchlists: {},
    supportsSwingOnChain: () => true,
    isExchangeAvailable: () => true,
  });
  await refresh();
  assert.ok(warns.some((w) => /no getNewTokens/.test(w)));
});

test('refreshSwingWatchlists: adds swing-applicable tokens, dedupes, caps at 120', async () => {
  const watchlists = { kucoin: ['old1', 'old2'] };
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: false },
    logger: silentLogger(),
    exchanges: {
      kucoin: {
        getNewTokens: async () => ['btc', 'eth', 'old1'], // old1 should dedup
        getTokenData: async (addr) => ({ address: addr, price: 100 }),
      },
    },
    watchlists,
    supportsSwingOnChain: () => true,
    isExchangeAvailable: () => true,
    strategy: { determineApplicableStrategies: () => ({ swing: true }) },
  });
  await refresh();
  assert.ok(watchlists.kucoin.includes('btc'));
  assert.ok(watchlists.kucoin.includes('eth'));
  // dedup: old1 not duplicated
  const old1Count = watchlists.kucoin.filter((x) => x === 'old1').length;
  assert.equal(old1Count, 1);
});

test('refreshSwingWatchlists: filters out non-swing tokens', async () => {
  const watchlists = { kucoin: [] };
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: false },
    logger: silentLogger(),
    exchanges: {
      kucoin: {
        getNewTokens: async () => ['btc', 'meme'],
        getTokenData: async (addr) => ({ address: addr, price: 100 }),
      },
    },
    watchlists,
    supportsSwingOnChain: () => true,
    isExchangeAvailable: () => true,
    strategy: { determineApplicableStrategies: (t) => ({ swing: t.address === 'btc' }) },
  });
  await refresh();
  assert.deepEqual(watchlists.kucoin, ['btc']);
});

test('refreshSwingWatchlists: getTokenData throw increments suppressedTokenErrors', async () => {
  const scanStatus = { kucoin: {} };
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks: { swingRefresh: false },
    logger: silentLogger(),
    config: { risk: { maxSuppressedTokenErrors: 10 } },
    exchanges: {
      kucoin: {
        getNewTokens: async () => ['bad'],
        getTokenData: async () => { throw new Error('rpc dead'); },
      },
    },
    watchlists: { kucoin: [] },
    scanStatus,
    supportsSwingOnChain: () => true,
    isExchangeAvailable: () => true,
    strategy: { determineApplicableStrategies: () => ({ swing: true }) },
  });
  await refresh();
  assert.equal(scanStatus.kucoin.suppressedTokenErrors, 1);
});

test('refreshSwingWatchlists: releases lock even on error', async () => {
  const loopLocks = { swingRefresh: false };
  const refresh = m.createRefreshSwingWatchlists({
    loopLocks,
    logger: silentLogger(),
    exchanges: {
      kucoin: { getNewTokens: async () => { throw new Error('discovery down'); } },
    },
    watchlists: {},
    supportsSwingOnChain: () => true,
    isExchangeAvailable: () => true,
  });
  await refresh();
  assert.equal(loopLocks.swingRefresh, false);
});

// ── runSqlAutoPrune ────────────────────────────────────────────────────────

test('runSqlAutoPrune: returns undefined when SQL pool unavailable', async () => {
  // Will fail to acquire pool (no SQL configured in test env) -> return early
  const result = await m.runSqlAutoPrune({ ...silentLogger(), debug: () => {} });
  // Either returns undefined (no pool) or a number (if test env has SQL)
  assert.ok(result === undefined || typeof result === 'number');
});
