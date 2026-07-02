'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create } = require('../../src/cycle/exit-pass');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

const normalizeChainKey = (k) => String(k || '').toLowerCase();
const buildTokenKey = (chain, addr) => `${chain}:${(addr || '').toLowerCase()}`;
const CHAIN_LABELS = { kucoin: 'KuCoin', bsc: 'BSC', base: 'Base', solana: 'Solana' };

function baseDeps(over = {}) {
  const calls = { exitChecks: [], sells: [], oracleQueries: [], tickRecords: [] };
  return {
    calls,
    deps: {
      portfolio: { positions: {}, strategies: {}, safeMode: false },
      marketState: { trackedTokens: {} },
      loopLocks: { momentumExit: false, swingExit: false, bullFlagExit: false, realtimeStop: false },
      loopLastCompletedAt: {},
      loopLastStartedAt: {},
      config: {
        risk: {
          realtimeStopLossEnabled: true,
          realtimeStopFetchTimeoutMs: 6000,
          disasterStopPct: 25,
          trailingStopAfterMultiplier: 2,
          trailingStopPct: 15,
        },
        strategies: { momentum: {}, swing: {}, spot_day_bull_flag: {} },
      },
      risk: { checkPerChainDailyLoss: () => ({ allowed: true }) },
      CHAIN_LABELS,
      exchanges: {},
      isExchangeAvailable: () => true,
      normalizeChainKey,
      buildTokenKey,
      recordStrategyTick: (k, p, v) => { calls.tickRecords.push({ k, p, v }); },
      refreshTrackedOpenPositionSnapshot: () => {},
      evictStuckPositions: () => {},
      checkExitConditions: async (chain, exchange, td, pos, opts) => { calls.exitChecks.push({ chain, symbol: td.symbol, opts }); },
      executeSell: async (chain, exchange, td, pos, pct, reason) => { calls.sells.push({ chain, symbol: td.symbol, pct, reason }); },
      applyTrailingStopState: () => {},
      shouldDelayBorderlineStop: () => false,
      getOraclePriceUsdForPosition: async () => null,
      withTimeout: async (p) => p,
      logger: silentLogger(),
      ...over,
    },
  };
}

// ─── create() guards ───────────────────────────────────────────────────────

test('create: throws on missing portfolio', () => {
  assert.throws(() => create({ loopLocks: {}, checkExitConditions: () => {}, executeSell: () => {} }), /portfolio required/);
});

test('create: throws on missing loopLocks', () => {
  assert.throws(() => create({ portfolio: {}, checkExitConditions: () => {}, executeSell: () => {} }), /loopLocks required/);
});

test('create: throws on missing checkExitConditions', () => {
  assert.throws(() => create({ portfolio: {}, loopLocks: {}, executeSell: () => {} }), /checkExitConditions required/);
});

test('create: throws on missing executeSell', () => {
  assert.throws(() => create({ portfolio: {}, loopLocks: {}, checkExitConditions: () => {} }), /executeSell required/);
});

// ─── runStrategyExitCycle ──────────────────────────────────────────────────

test('strategy exit: returns early when lock held', async () => {
  const { calls, deps } = baseDeps();
  deps.loopLocks.momentumExit = true;
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 0);
});

test('strategy exit: returns early in safeMode', async () => {
  const { calls, deps } = baseDeps();
  deps.portfolio.safeMode = true;
  deps.portfolio.positions = { 'kucoin:btc': { strategy: 'momentum', symbol: 'BTC' } };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 0);
});

test('strategy exit: zero positions -> no-op clean exit', async () => {
  const { calls, deps } = baseDeps();
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 0);
});

test('strategy exit: filters positions by strategy', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
    'kucoin:eth': { strategy: 'swing', symbol: 'ETH', chainKey: 'kucoin', address: 'ETH' },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 1);
  assert.equal(calls.exitChecks[0].symbol, 'BTC');
});

test('strategy exit: spot_day_bull_flag uses dedicated exit lock + positions', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'FLAG', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:flag': { strategy: 'spot_day_bull_flag', symbol: 'FLAG', chainKey: 'kucoin', address: 'FLAG' },
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('spot_day_bull_flag');
  assert.equal(calls.exitChecks.length, 1);
  assert.equal(calls.exitChecks[0].symbol, 'FLAG');
  assert.equal(deps.loopLocks.bullFlagExit, false);
  assert.equal(typeof deps.loopLastCompletedAt.bullFlagExit, 'number');
});

test('strategy exit: uses cached stale price when getTokenData fails (< 10min old)', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => null } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  deps.marketState.trackedTokens['kucoin:btc'] = {
    price: 99, symbol: 'BTC', lastScannedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 1);
  assert.equal(calls.exitChecks[0].opts.staleData, true);
});

test('strategy exit: skips when cache > 10min stale', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => null } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  deps.portfolio.strategies = { momentum: { stats: { skippedExitChecks: 0 } } };
  deps.marketState.trackedTokens['kucoin:btc'] = {
    price: 99, symbol: 'BTC', lastScannedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.exitChecks.length, 0);
  assert.equal(deps.portfolio.strategies.momentum.stats.skippedExitChecks, 1);
});

test('strategy exit: PARTIAL_FILL_RETRY triggers full sell', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', partialFillRetry: true },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].reason, 'PARTIAL_FILL_RETRY');
});

test('strategy exit: clean cycle resets exitErrorCount on stats', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  deps.portfolio.strategies = { momentum: { stats: { exitErrorCount: 3, skippedExitChecks: 2 } } };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(deps.portfolio.strategies.momentum.stats.exitErrorCount, 0);
});

test('strategy exit: error in checkExitConditions increments exitErrorCount', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
    checkExitConditions: async () => { throw new Error('boom'); },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  deps.portfolio.strategies = { momentum: { stats: { exitErrorCount: 0, skippedExitChecks: 0 } } };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(deps.portfolio.strategies.momentum.stats.exitErrorCount, 1);
});

test('strategy exit: updates loopLastCompletedAt[lockKey] after processing positions', async () => {
  const { deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(typeof deps.loopLastCompletedAt.momentumExit, 'number');
});

test('strategy exit: updates loopLastStartedAt[lockKey] when acquired', async () => {
  const { deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(typeof deps.loopLastStartedAt.momentumExit, 'number');
});

test('strategy exit: no positions -> updates completed timestamp', async () => {
  const { deps } = baseDeps();
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(typeof deps.loopLastCompletedAt.momentumExit, 'number');
});

test('strategy exit: releases loopLocks even on error', async () => {
  const { deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => { throw new Error('rpc dead'); } } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC' },
  };
  const ep = create(deps);
  await ep.runStrategyExitCycle('momentum');
  assert.equal(deps.loopLocks.momentumExit, false);
});

// ─── runRealtimeRiskStopCycle ──────────────────────────────────────────────

test('realtime stop: returns early when lock held', async () => {
  const { calls, deps } = baseDeps();
  deps.loopLocks.realtimeStop = true;
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 0);
});

test('realtime stop: returns early when safeMode', async () => {
  const { calls, deps } = baseDeps();
  deps.portfolio.safeMode = true;
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 0);
});

test('realtime stop: returns early when realtimeStopLossEnabled=false', async () => {
  const { calls, deps } = baseDeps();
  deps.config.risk.realtimeStopLossEnabled = false;
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 0);
});

test('realtime stop: zero positions -> no-op + completed timestamp set', async () => {
  const { calls, deps } = baseDeps();
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 0);
  assert.equal(typeof deps.loopLastCompletedAt.realtimeStop, 'number');
});

test('realtime stop: chain daily-loss halt -> sells all chain positions', async () => {
  const { calls, deps } = baseDeps({
    risk: { checkPerChainDailyLoss: (c) => c === 'kucoin' ? { allowed: false, reason: 'daily loss exceeded' } : { allowed: true } },
    exchanges: { kucoin: {} },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', currentPrice: 100, entryPrice: 100 },
    'kucoin:eth': { strategy: 'momentum', symbol: 'ETH', chainKey: 'kucoin', address: 'ETH', currentPrice: 50, entryPrice: 50 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  const haltSells = calls.sells.filter((s) => s.reason === 'CHAIN_DAILY_LOSS_HALT');
  assert.equal(haltSells.length, 2);
});

test('realtime stop: exitInProgress positions skipped during chain halt', async () => {
  const { calls, deps } = baseDeps({
    risk: { checkPerChainDailyLoss: () => ({ allowed: false, reason: 'halt' }) },
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', exitInProgress: true, currentPrice: 100 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  // No CHAIN_DAILY_LOSS_HALT sell because exitInProgress=true
  const haltSells = calls.sells.filter((s) => s.reason === 'CHAIN_DAILY_LOSS_HALT');
  assert.equal(haltSells.length, 0);
});

test('realtime stop: oracle price preferred over exchange when available', async () => {
  const { calls, deps } = baseDeps({
    getOraclePriceUsdForPosition: async () => 95,
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 100 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 96 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  // 95 (oracle) <= 96 (stopLoss) -> ORACLE_STOP_LOSS
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].reason, 'ORACLE_STOP_LOSS');
});

test('realtime stop: FAST_STOP_LOSS triggered when price <= stopLoss', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 90 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 92 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].reason, 'FAST_STOP_LOSS');
});

test('realtime stop: borderline delay returns without sell', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 90 }) } },
    shouldDelayBorderlineStop: () => true,
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 92 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 0);
});

test('realtime stop: DISASTER_STOP fires when loss >= disasterStopPct', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 70 }) } },
  });
  // Entry 100, price 70 = -30% loss > 25% disaster threshold
  // No stopLoss set (or higher than current), so disaster floor kicks in
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 50 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  // FAST_STOP_LOSS won't fire (70 > 50), DISASTER_STOP should fire (30% > 25%)
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].reason, 'DISASTER_STOP');
});

test('realtime stop: FAST_TRAILING_STOP triggered when price <= trailingStop', async () => {
  const { calls, deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => ({ symbol: 'BTC', price: 110 }) } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 80, trailingStop: 115 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(calls.sells.length, 1);
  assert.equal(calls.sells[0].reason, 'FAST_TRAILING_STOP');
});

test('realtime stop: releases loopLock even on error', async () => {
  const { deps } = baseDeps({
    exchanges: { kucoin: { getTokenData: async () => { throw new Error('rpc dead'); } } },
  });
  deps.portfolio.positions = {
    'kucoin:btc': { strategy: 'momentum', symbol: 'BTC', chainKey: 'kucoin', address: 'BTC', entryPrice: 100, stopLoss: 90 },
  };
  const ep = create(deps);
  await ep.runRealtimeRiskStopCycle();
  assert.equal(deps.loopLocks.realtimeStop, false);
});
