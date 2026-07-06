'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createKucoinStopOrderManager, stopNeedsReplace } = require('../../src/execution/kucoin-stop-orders');

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

function mockExchange(overrides = {}) {
  const calls = { create: [], cancel: [], fetch: [] };
  const exchange = {
    normalizeSymbol: (s) => String(s).toUpperCase(),
    exchange: {
      amountToPrecision: (_s, a) => Number(a),
      priceToPrecision: (_s, p) => Number(p),
      createOrder: async (symbol, type, side, amount, price, params) => {
        calls.create.push({ symbol, type, side, amount, params });
        if (overrides.createThrows) throw new Error(overrides.createThrows);
        return { id: `stop_${calls.create.length}` };
      },
      cancelOrder: async (id, symbol, params) => {
        calls.cancel.push({ id, symbol, params });
        if (overrides.cancelThrows) throw new Error(overrides.cancelThrows);
        return {};
      },
      fetchOrder: async (id, symbol, params) => {
        calls.fetch.push({ id, symbol, params });
        if (overrides.fetchResult) return overrides.fetchResult;
        return { id, status: 'open', filled: 0 };
      },
    },
  };
  return { exchange, calls };
}

function manager(exchangeWrapper, { enabled = true, paperTrading = false } = {}) {
  return createKucoinStopOrderManager({
    exchange: exchangeWrapper.exchange,
    logger: silentLogger,
    config: { paperTrading },
    isEnabledEnv: () => enabled,
  });
}

const POSITION = { symbol: 'ABC/USDT', quantity: 10, stopLoss: 0.96 };

// ─── stopNeedsReplace (pure) ────────────────────────────────────────────────

test('stopNeedsReplace: no tracked stop -> place', () => {
  assert.deepEqual(stopNeedsReplace({ position: POSITION, trackedStop: null }), { place: true });
});

test('stopNeedsReplace: matching stop -> ok', () => {
  const r = stopNeedsReplace({
    position: POSITION,
    trackedStop: { quantity: 10, stopPrice: 0.96 },
  });
  assert.equal(r.ok, true);
});

test('stopNeedsReplace: qty drift >1% (partial exit) -> replace', () => {
  const r = stopNeedsReplace({
    position: { ...POSITION, quantity: 7.5 },
    trackedStop: { quantity: 10, stopPrice: 0.96 },
  });
  assert.equal(r.replace, true);
  assert.equal(r.reason, 'qty_drift');
});

test('stopNeedsReplace: stop level drift -> replace', () => {
  const r = stopNeedsReplace({
    position: { ...POSITION, stopLoss: 1.02 },
    trackedStop: { quantity: 10, stopPrice: 0.96 },
  });
  assert.equal(r.replace, true);
  assert.equal(r.reason, 'stop_price_drift');
});

// ─── manager gating ─────────────────────────────────────────────────────────

test('disabled env -> ensureStops is a no-op', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap, { enabled: false });
  const out = await mgr.ensureStops({ p1: POSITION });
  assert.deepEqual(out, { adoptedFills: [] });
  assert.equal(wrap.calls.create.length, 0);
});

test('paperTrading -> never enabled even with env on', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap, { enabled: true, paperTrading: true });
  assert.equal(mgr.isEnabled(), false);
  await mgr.ensureStops({ p1: POSITION });
  assert.equal(wrap.calls.create.length, 0);
});

// ─── ensureStops lifecycle ──────────────────────────────────────────────────

test('ensureStops places a stop-market sell for an unprotected position', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  assert.equal(wrap.calls.create.length, 1);
  const call = wrap.calls.create[0];
  assert.equal(call.type, 'market');
  assert.equal(call.side, 'sell');
  assert.equal(call.amount, 10);
  assert.equal(call.params.stopPrice, 0.96);
  assert.equal(call.params.stop, 'loss');
  assert.ok(mgr._tracked.has('p1'));
});

test('ensureStops is idempotent while position unchanged', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  await mgr.ensureStops({ p1: POSITION });
  assert.equal(wrap.calls.create.length, 1, 'no duplicate placement');
});

test('ensureStops replaces stop after partial exit (qty shrank)', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  await mgr.ensureStops({ p1: { ...POSITION, quantity: 6 } });
  assert.equal(wrap.calls.cancel.length, 1);
  assert.equal(wrap.calls.create.length, 2);
  assert.equal(wrap.calls.create[1].amount, 6);
});

test('ensureStops adopts a filled stop instead of re-placing', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  wrap.exchange.exchange.fetchOrder = async () => ({ id: 'stop_1', status: 'closed', filled: 10, average: 0.955, cost: 9.55 });
  const out = await mgr.ensureStops({ p1: POSITION });
  assert.equal(out.adoptedFills.length, 1);
  assert.equal(out.adoptedFills[0].positionKey, 'p1');
  assert.equal(mgr._tracked.has('p1'), false);
  assert.equal(wrap.calls.create.length, 1, 'must not place a new stop for an exchange-closed position');
});

test('ensureStops sweeps orphan stops for closed positions', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  await mgr.ensureStops({}); // position gone
  assert.equal(wrap.calls.cancel.length, 1);
  assert.equal(mgr._tracked.size, 0);
});

// ─── pre-sell hook ──────────────────────────────────────────────────────────

test('cancelBeforeManualSell: open stop cancelled -> proceed', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  const out = await mgr.cancelBeforeManualSell('p1');
  assert.equal(out.proceed, true);
  assert.equal(wrap.calls.cancel.length, 1);
});

test('cancelBeforeManualSell: stop already filled -> adopt fill, block re-sell', async () => {
  const wrap = mockExchange({ cancelThrows: 'order not found', fetchResult: { id: 'stop_1', status: 'closed', filled: 10, average: 0.955, cost: 9.55 } });
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  const out = await mgr.cancelBeforeManualSell('p1');
  assert.equal(out.proceed, false);
  assert.ok(out.adoptedFill);
  assert.equal(out.adoptedFill.filledBaseQty, 10);
  assert.equal(out.adoptedFill.executedPriceUsd, 0.955);
  assert.equal(out.adoptedFill.exchangeStopFill, true);
});

test('cancelBeforeManualSell: cancel failed for unknown reason -> block (retry), no double-sell window', async () => {
  const wrap = mockExchange({ cancelThrows: 'network down', fetchResult: { id: 'stop_1', status: 'open', filled: 0 } });
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  const out = await mgr.cancelBeforeManualSell('p1');
  assert.equal(out.proceed, false);
  assert.equal(out.retry, true);
});

test('cancelBeforeManualSell: no tracked stop -> proceed untouched', async () => {
  const wrap = mockExchange();
  const mgr = manager(wrap);
  const out = await mgr.cancelBeforeManualSell('unknown');
  assert.equal(out.proceed, true);
  assert.equal(wrap.calls.cancel.length, 0);
});

test('placeStop failure leaves loop protection intact (no tracked entry)', async () => {
  const wrap = mockExchange({ createThrows: 'insufficient balance' });
  const mgr = manager(wrap);
  await mgr.ensureStops({ p1: POSITION });
  assert.equal(mgr._tracked.has('p1'), false, 'failed placement must not be tracked');
});
