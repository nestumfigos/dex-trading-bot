'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveMaintenanceMarginPct,
  setKucoinUniverse,
  getKucoinMaintenanceMarginPct,
  DEFAULT_MM,
} = require('../src/strategies/perps-maintenance-margin');

test('K5: setKucoinUniverse loads per-contract maintainMargin', () => {
  const loaded = setKucoinUniverse({
    contracts: [
      { canonical: 'BTCUSDT', maintainMargin: 0.004 },
      { canonical: 'ETHUSDT', maintainMargin: 0.005 },
      { canonical: 'WIFUSDT', maintainMargin: 0.01 },
      { canonical: 'BADROW', maintainMargin: 1.5 },  // rejected: out of range
      { canonical: '', maintainMargin: 0.01 },        // rejected: empty key
    ],
  });
  assert.equal(loaded, 3);
  assert.equal(getKucoinMaintenanceMarginPct('BTCUSDT'), 0.004);
  assert.equal(getKucoinMaintenanceMarginPct('btcusdt'), 0.004);
  assert.equal(getKucoinMaintenanceMarginPct('BADROW'), null);
});

test('K5: resolveMaintenanceMarginPct prefers KuCoin MM when loaded', () => {
  setKucoinUniverse({
    contracts: [{ canonical: 'BTCUSDT', maintainMargin: 0.0035 }],
  });
  // Even with a notional/leverage that would normally pick a Binance tier MM,
  // the KuCoin per-contract MM wins.
  const mm = resolveMaintenanceMarginPct({ symbol: 'BTCUSDT', notionalUsd: 30000, leverage: 50 });
  assert.equal(mm, 0.0035);
});

test('K5: resolveMaintenanceMarginPct falls back to Binance tier when symbol unknown', () => {
  setKucoinUniverse({ contracts: [] });  // KuCoin map empty
  const mm = resolveMaintenanceMarginPct({ symbol: 'BTCUSDT', notionalUsd: 30000, leverage: 50 });
  // Binance tier table still active: 30k notional -> 0.004 bracket for BTC.
  assert.equal(mm, 0.004);
});

test('K5: falls back to DEFAULT_MM for fully-unknown symbol', () => {
  setKucoinUniverse({ contracts: [] });
  const mm = resolveMaintenanceMarginPct({ symbol: 'NOTHING_USDT', notionalUsd: 1000, leverage: 3 });
  assert.equal(mm, DEFAULT_MM);
});

test('K5: setKucoinUniverse(null) clears the map', () => {
  setKucoinUniverse({ contracts: [{ canonical: 'BTCUSDT', maintainMargin: 0.004 }] });
  assert.equal(getKucoinMaintenanceMarginPct('BTCUSDT'), 0.004);
  setKucoinUniverse(null);
  assert.equal(getKucoinMaintenanceMarginPct('BTCUSDT'), null);
});
