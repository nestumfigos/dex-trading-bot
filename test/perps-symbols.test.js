'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toKucoinSymbol,
  fromKucoinSymbol,
  isCanonicalUsdtPerp,
  isKucoinUsdtmPerp,
} = require('../src/utils/perps-symbols');

test('K1: BTC <-> XBT alias', () => {
  assert.equal(toKucoinSymbol('BTCUSDT'), 'XBTUSDTM');
  assert.equal(fromKucoinSymbol('XBTUSDTM'), 'BTCUSDT');
});

test('K1: non-aliased bases pass through with USDTM suffix', () => {
  assert.equal(toKucoinSymbol('ETHUSDT'), 'ETHUSDTM');
  assert.equal(toKucoinSymbol('SOLUSDT'), 'SOLUSDTM');
  assert.equal(toKucoinSymbol('PEPEUSDT'), 'PEPEUSDTM');
  assert.equal(fromKucoinSymbol('ETHUSDTM'), 'ETHUSDT');
  assert.equal(fromKucoinSymbol('WIFUSDTM'), 'WIFUSDT');
});

test('K1: lowercase input is uppercased', () => {
  assert.equal(toKucoinSymbol('btcusdt'), 'XBTUSDTM');
  assert.equal(fromKucoinSymbol('xbtusdtm'), 'BTCUSDT');
});

test('K1: roundtrip stable for arbitrary USDT-M perp', () => {
  for (const canonical of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'PEPEUSDT', 'WIFUSDT']) {
    assert.equal(fromKucoinSymbol(toKucoinSymbol(canonical)), canonical, `roundtrip failed for ${canonical}`);
  }
});

test('K1: rejects non-USDT-margined inputs (USD-margined inverse, COIN-M)', () => {
  assert.throws(() => toKucoinSymbol('BTCUSD'), /USDT-margined/);
  assert.throws(() => fromKucoinSymbol('XBTUSDM'), /USDT-margined/);
  assert.throws(() => fromKucoinSymbol('BTCUSD'), /USDT-margined/);
});

test('K1: rejects empty / non-string / empty-base inputs', () => {
  assert.throws(() => toKucoinSymbol(''), /non-empty string/);
  assert.throws(() => toKucoinSymbol(null), /non-empty string/);
  assert.throws(() => toKucoinSymbol('USDT'), /empty base/);
  assert.throws(() => fromKucoinSymbol(null), /non-empty string/);
  assert.throws(() => fromKucoinSymbol('USDTM'), /empty base/);
});

test('K1: predicate helpers do not throw', () => {
  assert.equal(isCanonicalUsdtPerp('BTCUSDT'), true);
  assert.equal(isCanonicalUsdtPerp('BTCUSD'), false);
  assert.equal(isCanonicalUsdtPerp(''), false);
  assert.equal(isCanonicalUsdtPerp(undefined), false);
  assert.equal(isKucoinUsdtmPerp('XBTUSDTM'), true);
  assert.equal(isKucoinUsdtmPerp('XBTUSDM'), false);
  assert.equal(isKucoinUsdtmPerp(''), false);
});
