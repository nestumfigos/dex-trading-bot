'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const wbr = require('../../src/cycle/wallet-balance-refresh');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

function round(v, d = 2) {
  return Number((Number(v) || 0).toFixed(d));
}

function makeExchanges(balances = { solana: 100, bsc: 50, base: 25, kucoin: 200 }) {
  return {
    solana: { getBalance: async () => balances.solana },
    bsc:    { getBalance: async () => balances.bsc, getBnbPrice: async () => 450 },
    base:   { getBalance: async () => balances.base },
    kucoin: { getBalance: async () => balances.kucoin },
  };
}

test('updateWalletBalance: paper trading skips fetch', async () => {
  const portfolio = {};
  await wbr.updateWalletBalance({
    config: { paperTrading: true },
    portfolio,
    exchanges: makeExchanges(),
    loopLastCompletedAt: {},
    round,
  }, silentLogger());
  assert.equal(portfolio.walletBalanceUsd, undefined);
});

test('updateWalletBalance: sums per-exchange balances + sets walletBalancesUsd', async () => {
  const portfolio = { balance: 375 };
  const loopLastCompletedAt = {};
  await wbr.updateWalletBalance({
    config: { paperTrading: false, risk: { minBalanceCoverage: 2, maxBalanceDriftPct: 10 } },
    portfolio,
    exchanges: makeExchanges({ solana: 100, bsc: 50, base: 25, kucoin: 200 }),
    loopLastCompletedAt,
    round,
  }, silentLogger());
  assert.equal(portfolio.walletBalanceUsd, 375);
  assert.deepEqual(portfolio.walletBalancesUsd, { solana: 100, bsc: 50, base: 25, kucoin: 200 });
  assert.equal(portfolio.balanceCoverageCount, 4);
  assert.ok(loopLastCompletedAt.walletBalanceRefresh > 0);
});

test('updateWalletBalance: partial coverage (1 of 4 succeeds) -> skips drift check', async () => {
  const portfolio = {};
  const exchanges = makeExchanges();
  exchanges.solana.getBalance = async () => { throw new Error('rpc down'); };
  exchanges.bsc.getBalance = async () => { throw new Error('rpc down'); };
  exchanges.base.getBalance = async () => { throw new Error('rpc down'); };
  await wbr.updateWalletBalance({
    config: { paperTrading: false, risk: { minBalanceCoverage: 2 } },
    portfolio,
    exchanges,
    loopLastCompletedAt: {},
    round,
  }, silentLogger());
  assert.equal(portfolio.balanceCoverageCount, 1);
  assert.equal(portfolio.walletBalanceUsd, 200);
});

test('updateWalletBalance: drift >25% sets balanceDriftHalt=true', async () => {
  const portfolio = { balance: 1000 }; // ledger says $1000, wallet only $375
  await wbr.updateWalletBalance({
    config: { paperTrading: false, risk: { minBalanceCoverage: 2, maxBalanceDriftPct: 10 } },
    portfolio,
    exchanges: makeExchanges(),
    loopLastCompletedAt: {},
    round,
  }, silentLogger());
  // drift = |375 - 1000| / 1000 = 62.5%
  assert.equal(portfolio.balanceDriftHalt, true);
});

test('updateWalletBalance: drift back below threshold clears halt', async () => {
  const portfolio = { balance: 400, balanceDriftHalt: true };
  await wbr.updateWalletBalance({
    config: { paperTrading: false, risk: { minBalanceCoverage: 2, maxBalanceDriftPct: 10 } },
    portfolio,
    exchanges: makeExchanges(),
    loopLastCompletedAt: {},
    round,
  }, silentLogger());
  // drift = |375 - 400| / 400 = 6.25% < 10%
  assert.equal(portfolio.balanceDriftHalt, false);
});

test('refreshBscNativePrice: returns price + records timestamp', async () => {
  const loopLastCompletedAt = {};
  const price = await wbr.refreshBscNativePrice({
    exchanges: { bsc: { getBnbPrice: async () => 425 } },
    loopLastCompletedAt,
  });
  assert.equal(price, 425);
  assert.ok(loopLastCompletedAt.bscNativePriceRefresh > 0);
});

test('refreshBscNativePrice: returns null when exchange missing', async () => {
  const price = await wbr.refreshBscNativePrice({ exchanges: {} });
  assert.equal(price, null);
});

test('register: returns disposer (idempotent + cleanup)', () => {
  const ctx = {
    exchanges: makeExchanges(),
    portfolio: {},
    config: { paperTrading: true, bot: {}, risk: {} },
    loopLastCompletedAt: {},
    round,
  };
  const dispose = wbr.register({ logger: silentLogger(), ctx });
  assert.equal(typeof dispose, 'function');
  dispose();
  // Re-register works after dispose
  const dispose2 = wbr.register({ logger: silentLogger(), ctx });
  dispose2();
});
