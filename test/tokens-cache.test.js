'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getTokenWithCache, getStats, _internal } = require('../src/utils/tokens-cache');

test('getTokenWithCache: provider hit on first call when cache cold', async () => {
  _internal._flushCache();
  let calls = 0;
  const fetchFresh = async () => { calls += 1; return { symbol: 'BTC', chain: 'kucoin', price: 70000 }; };
  const r = await getTokenWithCache('BTC', 'kucoin', fetchFresh);
  assert.equal(calls, 1);
  assert.equal(r.price, 70000);
});

test('getTokenWithCache: mem hit on second call within TTL', async () => {
  _internal._flushCache();
  let calls = 0;
  const fetchFresh = async () => { calls += 1; return { symbol: 'ETH', chain: 'base', price: 3000 }; };
  await getTokenWithCache('ETH', 'base', fetchFresh);
  await getTokenWithCache('ETH', 'base', fetchFresh);
  assert.equal(calls, 1);
});

test('getTokenWithCache: returns null when fetchFresh throws', async () => {
  _internal._flushCache();
  const fetchFresh = async () => { throw new Error('provider down'); };
  const r = await getTokenWithCache('XYZ', 'kucoin', fetchFresh);
  assert.equal(r, null);
});

test('getTokenWithCache: returns null when symbol/chain missing', async () => {
  _internal._flushCache();
  const r1 = await getTokenWithCache('', 'kucoin', async () => ({ symbol: 'X' }));
  const r2 = await getTokenWithCache('X', '', async () => ({ symbol: 'X' }));
  assert.equal(r1, null);
  assert.equal(r2, null);
});

test('getTokenWithCache: returns null when fetchFresh not a function', async () => {
  _internal._flushCache();
  const r = await getTokenWithCache('X', 'kucoin', null);
  assert.equal(r, null);
});

test('getStats: returns sane shape', () => {
  const s = getStats();
  assert.ok(typeof s.memSize === 'number');
  assert.ok(typeof s.memTtlMs === 'number');
});

test('_key normalizes case', () => {
  assert.equal(_internal._key('Foo', 'KuCoin'), 'FOO|kucoin');
});
