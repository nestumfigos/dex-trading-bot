'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ml = require('../../src/cycle/main-loop');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

function makeState() {
  return {
    scanTimer: null,
    momentumScanTimer: null,
    bullFlagScanTimer: null,
    momentumExitTimer: null,
    bullFlagExitTimer: null,
    strategyScanTimers: {},
    strategyExitTimers: {},
    realtimeStopTimer: null,
    walletBalanceRefreshTimer: null,
    bscNativePriceRefreshTimer: null,
    selfEvolutionTimer: null,
    selfEvolutionBootTimer: null,
    intelligenceTimer: null,
    intelligenceBootTimer: null,
    bscNativePriceBootTimer: null,
    rlTrainingTimer: null,
    mlTrainingSchedulerDispose: null,
  };
}

function makeLoopLocks() {
  return {
    momentumScan: false,
    kucoinMomentumScan: false,
    bullFlagScan: false,
    momentumExit: false,
    bullFlagExit: false,
    bsc_flow_breakoutScan: false,
    bsc_flow_breakoutExit: false,
    realtimeStop: false,
  };
}

function baseDeps(over = {}) {
  return {
    portfolio: { safeMode: false },
    config: {
      bot: { momentumScanIntervalSeconds: 75, swingScanIntervalMinutes: 15, momentumExitCheckMinutes: 15, swingExitCheckMinutes: 60, swingWatchlistRefreshHours: 24, walletBalanceRefreshSeconds: 60 },
      risk: { realtimeStopLossEnabled: true, realtimeStopCheckSeconds: 8, nativePriceRefreshSeconds: 45 },
      selfEvolution: { enabled: false },
    },
    logger: silentLogger(),
    runStrategyScanCycle: async () => {},
    runStrategyExitCycle: async () => {},
    runRealtimeRiskStopCycle: async () => {},
    refreshSwingWatchlists: async () => {},
    updateWalletBalance: async () => {},
    refreshBscNativePrice: async () => {},
    runSelfEvolutionCycle: async () => {},
    runMarketIntelligenceCycle: async () => {},
    evictStuckPositions: () => {},
    startOracleStopWatchers: () => {},
    stopOracleStopWatchers: () => {},
    mlTrainingSchedulerRegister: () => () => {}, // returns no-op disposer
    mlTrainingSchedulerCtx: {},
    ...over,
  };
}

// ── Defensive guards ───────────────────────────────────────────────────────

test('clearLoopSchedulers: throws on missing state', () => {
  assert.throws(() => ml.clearLoopSchedulers({ deps: baseDeps() }), /state required/);
});

test('clearLoopSchedulers: throws on missing deps', () => {
  assert.throws(() => ml.clearLoopSchedulers({ state: makeState() }), /deps required/);
});

test('setLoopLocks: throws on missing loopLocks', () => {
  assert.throws(() => ml.setLoopLocks({ enabled: true }), /loopLocks required/);
});

test('restartLoopSchedulers: throws on missing state', () => {
  assert.throws(() => ml.restartLoopSchedulers({ deps: baseDeps(), loopLocks: makeLoopLocks() }), /state required/);
});

test('restartLoopSchedulers: throws on missing deps', () => {
  assert.throws(() => ml.restartLoopSchedulers({ state: makeState(), loopLocks: makeLoopLocks() }), /deps required/);
});

test('restartLoopSchedulers: throws on missing loopLocks', () => {
  assert.throws(() => ml.restartLoopSchedulers({ state: makeState(), deps: baseDeps() }), /loopLocks required/);
});

// ── clearLoopSchedulers ────────────────────────────────────────────────────

test('clearLoopSchedulers: clears all timer slots', () => {
  const state = makeState();
  state.momentumScanTimer = setInterval(() => {}, 60000);
  state.walletBalanceRefreshTimer = setInterval(() => {}, 60000);
  state.scanTimer = state.momentumScanTimer;
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
  assert.equal(state.momentumScanTimer, null);
  assert.equal(state.walletBalanceRefreshTimer, null);
  assert.equal(state.scanTimer, null);
});

test('clearLoopSchedulers: calls stopOracleStopWatchers when provided', () => {
  let called = false;
  ml.clearLoopSchedulers({ state: makeState(), deps: { stopOracleStopWatchers: () => { called = true; } } });
  assert.equal(called, true);
});

test('clearLoopSchedulers: stopOracleStopWatchers throw is swallowed', () => {
  ml.clearLoopSchedulers({ state: makeState(), deps: { stopOracleStopWatchers: () => { throw new Error('boom'); } } });
  // no exception
});

test('clearLoopSchedulers: disposes ml-training-scheduler hook + clears slot', () => {
  let disposed = false;
  const state = makeState();
  state.mlTrainingSchedulerDispose = () => { disposed = true; };
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
  assert.equal(disposed, true);
  assert.equal(state.mlTrainingSchedulerDispose, null);
});

test('clearLoopSchedulers: ml dispose throw swallowed', () => {
  const state = makeState();
  state.mlTrainingSchedulerDispose = () => { throw new Error('dispose failed'); };
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
  assert.equal(state.mlTrainingSchedulerDispose, null);
});

// ── setLoopLocks ───────────────────────────────────────────────────────────

test('setLoopLocks: sets all keys to enabled', () => {
  const locks = makeLoopLocks();
  ml.setLoopLocks({ loopLocks: locks, enabled: true });
  for (const v of Object.values(locks)) assert.equal(v, true);
});

test('setLoopLocks: sets all keys to false', () => {
  const locks = makeLoopLocks();
  for (const k of Object.keys(locks)) locks[k] = true;
  ml.setLoopLocks({ loopLocks: locks, enabled: false });
  for (const v of Object.values(locks)) assert.equal(v, false);
});

test('setLoopLocks: calls refreshScanInFlightFlag when provided', () => {
  let called = false;
  ml.setLoopLocks({ loopLocks: makeLoopLocks(), enabled: true, refreshScanInFlightFlag: () => { called = true; } });
  assert.equal(called, true);
});

test('setLoopLocks: refreshScanInFlightFlag missing -> no throw', () => {
  ml.setLoopLocks({ loopLocks: makeLoopLocks(), enabled: false });
});

// ── stopSchedulersForSafeMode ──────────────────────────────────────────────

test('stopSchedulersForSafeMode: pauses entry timers but retains realtime stops', () => {
  const state = makeState();
  state.momentumScanTimer = setInterval(() => {}, 60000);
  const locks = makeLoopLocks();
  const deps = baseDeps();
  ml.stopSchedulersForSafeMode({ state, deps, loopLocks: locks });
  assert.equal(state.momentumScanTimer, null);
  assert.ok(state.realtimeStopTimer);
  assert.equal(locks.realtimeStop, false);
  for (const [name, value] of Object.entries(locks)) {
    if (name !== 'realtimeStop') assert.equal(value, true);
  }
  ml.clearLoopSchedulers({ state, deps });
});

// ── restartLoopSchedulers ──────────────────────────────────────────────────

test('restartLoopSchedulers: safeMode=true -> pauses entries but retains realtime stops', () => {
  const state = makeState();
  const locks = makeLoopLocks();
  const warns = [];
  const deps = baseDeps({
    portfolio: { safeMode: true },
    logger: { ...silentLogger(), warn: (m) => warns.push(m) },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: locks });
  assert.equal(locks.realtimeStop, false);
  for (const [name, value] of Object.entries(locks)) {
    if (name !== 'realtimeStop') assert.equal(value, true, `${name} locked`);
  }
  assert.ok(warns.some((w) => w.includes('safe mode')));
  assert.equal(state.momentumScanTimer, null);
  assert.ok(state.realtimeStopTimer);
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: creates momentum scan + exit + core refresh timers', () => {
  const state = makeState();
  const locks = makeLoopLocks();
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: locks });
  assert.ok(state.momentumScanTimer);
  assert.ok(state.momentumExitTimer);
  assert.ok(state.realtimeStopTimer);
  assert.ok(state.walletBalanceRefreshTimer);
  assert.ok(state.bscNativePriceRefreshTimer);
  assert.equal(state.bullFlagScanTimer, null);
  assert.equal(state.bullFlagExitTimer, null);
  assert.ok(state.strategyScanTimers.momentum);
  assert.ok(state.strategyExitTimers.momentum);
  // scanTimer aliases momentumScanTimer
  assert.equal(state.scanTimer, state.momentumScanTimer);
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
});

test('restartLoopSchedulers: creates bull-flag scan + exit timers when enabled', () => {
  const state = makeState();
  const calls = [];
  const deps = baseDeps({
    config: {
      ...baseDeps().config,
      strategies: {
        momentum: { enabled: false },
        spot_day_bull_flag: { enabled: true },
      },
    },
    runStrategyScanCycle: async (strategyName) => { calls.push(`scan:${strategyName}`); },
    runStrategyExitCycle: async (strategyName) => { calls.push(`exit:${strategyName}`); },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(state.momentumScanTimer, null);
  assert.ok(state.bullFlagScanTimer);
  assert.ok(state.bullFlagExitTimer);
  assert.ok(calls.includes('scan:spot_day_bull_flag'));
  assert.ok(calls.includes('exit:spot_day_bull_flag'));
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: creates dynamic paper strategy timers when enabled', () => {
  const state = makeState();
  const calls = [];
  const deps = baseDeps({
    strategyNames: ['momentum', 'bsc_flow_breakout'],
    config: {
      ...baseDeps().config,
      strategies: {
        momentum: { enabled: false },
        bsc_flow_breakout: { enabled: true },
      },
    },
    runStrategyScanCycle: async (strategyName) => { calls.push(`scan:${strategyName}`); },
    runStrategyExitCycle: async (strategyName) => { calls.push(`exit:${strategyName}`); },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(state.momentumScanTimer, null);
  assert.ok(state.strategyScanTimers.bsc_flow_breakout);
  assert.ok(state.strategyExitTimers.bsc_flow_breakout);
  assert.ok(calls.includes('scan:bsc_flow_breakout'));
  assert.ok(calls.includes('exit:bsc_flow_breakout'));
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: skips realtimeStopTimer when realtimeStopLossEnabled=false', () => {
  const state = makeState();
  const deps = baseDeps({
    config: { ...baseDeps().config, risk: { realtimeStopLossEnabled: false } },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(state.realtimeStopTimer, null);
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: skips selfEvolutionTimer when disabled', () => {
  const state = makeState();
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: makeLoopLocks() });
  assert.equal(state.selfEvolutionTimer, null);
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
});

test('restartLoopSchedulers: creates selfEvolutionTimer when enabled', () => {
  const state = makeState();
  const deps = baseDeps({
    config: { ...baseDeps().config, selfEvolution: { enabled: true, intervalMinutes: 180 } },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.ok(state.selfEvolutionTimer);
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: skips intelligenceTimer when INTELLIGENCE_ENABLED=false', () => {
  process.env.INTELLIGENCE_ENABLED = 'false';
  const state = makeState();
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: makeLoopLocks() });
  assert.equal(state.intelligenceTimer, null);
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
  delete process.env.INTELLIGENCE_ENABLED;
});

test('restartLoopSchedulers: calls mlTrainingSchedulerRegister + stores disposer', () => {
  const state = makeState();
  let registered = false;
  let disposed = false;
  const deps = baseDeps({
    mlTrainingSchedulerRegister: () => { registered = true; return () => { disposed = true; }; },
  });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(registered, true);
  assert.equal(typeof state.mlTrainingSchedulerDispose, 'function');
  // clear should call disposer
  ml.clearLoopSchedulers({ state, deps });
  assert.equal(disposed, true);
  assert.equal(state.mlTrainingSchedulerDispose, null);
});

test('restartLoopSchedulers: clear cycle then restart yields fresh timers (no leak)', () => {
  const state = makeState();
  const locks = makeLoopLocks();
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: locks });
  const firstHandle = state.momentumScanTimer;
  assert.ok(firstHandle);
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: locks });
  assert.ok(state.momentumScanTimer);
  assert.notStrictEqual(state.momentumScanTimer, firstHandle, 'second restart creates fresh timer');
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
});

test('restartLoopSchedulers: releases all loopLocks (false) on normal start', () => {
  const state = makeState();
  const locks = makeLoopLocks();
  for (const k of Object.keys(locks)) locks[k] = true;
  ml.restartLoopSchedulers({ state, deps: baseDeps(), loopLocks: locks });
  for (const v of Object.values(locks)) assert.equal(v, false);
  ml.clearLoopSchedulers({ state, deps: baseDeps() });
});

test('restartLoopSchedulers: calls startOracleStopWatchers', () => {
  let started = false;
  const state = makeState();
  const deps = baseDeps({ startOracleStopWatchers: () => { started = true; } });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(started, true);
  ml.clearLoopSchedulers({ state, deps });
});

test('restartLoopSchedulers: calls evictStuckPositions before initial scans', () => {
  let evicted = false;
  const state = makeState();
  const deps = baseDeps({ evictStuckPositions: () => { evicted = true; } });
  ml.restartLoopSchedulers({ state, deps, loopLocks: makeLoopLocks() });
  assert.equal(evicted, true);
  ml.clearLoopSchedulers({ state, deps });
});
