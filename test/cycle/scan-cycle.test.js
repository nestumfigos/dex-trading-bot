'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { create } = require('../../src/cycle/scan-cycle');

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

function baseDeps(over = {}) {
  const calls = { scans: [], snapshots: [], saves: 0, statusUpdates: [] };
  return {
    calls,
    deps: {
      loopLocks: { momentumScan: false, bsc_flow_breakoutScan: false, kucoinMomentumScan: false },
      loopLastCompletedAt: {},
      filterStatsState: { currentCycle: { momentum: {}, bsc_flow_breakout: {} } },
      config: { bot: { scanDiscoveryTimeoutMs: 60_000, stateSaveTimeoutMs: 10_000 } },
      logger: silentLogger(),
      refreshScanInFlightFlag: () => {},
      isWithinTradingWindow: () => true,
      shouldPauseKucoinEntryScans: () => ({ paused: false }),
      withTimeout: async (p) => p,
      exchanges: { solana: { id: 'sol' }, bsc: { id: 'bsc' }, base: { id: 'base' }, kucoin: { id: 'ku' } },
      isStrategyScanEnabled: () => true,
      scanChain: async (chain, exchange, strategy) => { calls.scans.push({ chain, strategy }); },
      startFilterCycle: () => {},
      finalizeFilterCycle: () => {},
      getStrategyScanStatus: () => ({ status: 'running', currentToken: 'X', lastUpdate: '?' }),
      syncChainScanStatus: (chain) => { calls.statusUpdates.push(chain); },
      recordPortfolioSnapshot: (reason) => { calls.snapshots.push(reason); },
      saveState: async () => { calls.saves += 1; },
      ...over,
    },
  };
}

// ── Defensive guards ───────────────────────────────────────────────────────

test('create: throws on missing loopLocks', () => {
  assert.throws(() => create({ isWithinTradingWindow: () => true, scanChain: () => {} }), /loopLocks required/);
});

test('create: throws on missing isWithinTradingWindow', () => {
  assert.throws(() => create({ loopLocks: {}, scanChain: () => {} }), /isWithinTradingWindow required/);
});

test('create: throws on missing scanChain', () => {
  assert.throws(() => create({ loopLocks: {}, isWithinTradingWindow: () => true }), /scanChain required/);
});

// ── runStrategyScanCycle: early returns ────────────────────────────────────

test('strategy scan: returns early when lock held', async () => {
  const { calls, deps } = baseDeps();
  deps.loopLocks.momentumScan = true;
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(calls.scans.length, 0);
});

test('strategy scan: returns early outside trading window', async () => {
  const { calls, deps } = baseDeps({ isWithinTradingWindow: () => false });
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(calls.scans.length, 0);
});

// ── Momentum scan: all chains in parallel ──────────────────────────────────

test('momentum scan: scans solana + bsc + kucoin in parallel', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  const chains = calls.scans.map((s) => s.chain).sort();
  assert.deepEqual(chains, ['bsc', 'kucoin', 'solana']);
  assert.ok(calls.scans.every((s) => s.strategy === 'momentum'));
});

test('momentum scan: skips disabled chains', async () => {
  const { calls, deps } = baseDeps({
    isStrategyScanEnabled: (chain) => chain === 'kucoin', // only kucoin enabled
  });
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(calls.scans.length, 1);
  assert.equal(calls.scans[0].chain, 'kucoin');
});

test('momentum scan: per-chain failure logged but other chains continue', async () => {
  const errors = [];
  const { calls, deps } = baseDeps({
    scanChain: async (chain) => {
      if (chain === 'bsc') throw new Error('rpc dead');
      calls.scans.push({ chain });
    },
    logger: { ...silentLogger(), error: (m, ctx) => errors.push({ m, ctx }) },
  });
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  // bsc failed but solana + kucoin scanned
  const chains = calls.scans.map((s) => s.chain).sort();
  assert.deepEqual(chains, ['kucoin', 'solana']);
  assert.ok(errors.some((e) => /bsc/.test(e.m)));
});

test('momentum scan: per-chain timeout uses chainDiscoveryTimeoutMs', async () => {
  const { calls, deps } = baseDeps();
  deps.config.bot.solanaScanDiscoveryTimeoutMs = 30_000;
  deps.config.bot.bscScanDiscoveryTimeoutMs = 45_000;
  let timeouts = [];
  deps.withTimeout = async (p, ms) => { timeouts.push(ms); return p; };
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  // Should include all per-chain timeouts + saveState timeout
  assert.ok(timeouts.includes(30_000));
  assert.ok(timeouts.includes(45_000));
});

// ── Paper strategy scan: configured chain only ─────────────────────────────

test('paper strategy scan: scans configured BSC chain only', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('bsc_flow_breakout');
  assert.equal(calls.scans.length, 1);
  assert.equal(calls.scans[0].chain, 'bsc');
  assert.equal(calls.scans[0].strategy, 'bsc_flow_breakout');
});

test('paper strategy scan: skipped when configured chain disabled', async () => {
  const { calls, deps } = baseDeps({
    isStrategyScanEnabled: () => false,
  });
  const sc = create(deps);
  await sc.runStrategyScanCycle('bsc_flow_breakout');
  assert.equal(calls.scans.length, 0);
});

test('paper strategy scan: scanChain throw caught + logged', async () => {
  const errors = [];
  const { deps } = baseDeps({
    scanChain: async () => { throw new Error('kucoin down'); },
    logger: { ...silentLogger(), error: (m, ctx) => errors.push(m) },
  });
  const sc = create(deps);
  await sc.runStrategyScanCycle('bsc_flow_breakout'); // should not throw
  assert.ok(errors.some((e) => /bsc bsc_flow_breakout scan failed/.test(e)));
});

// ── Post-scan side effects ─────────────────────────────────────────────────

test('strategy scan: records portfolio snapshot with strategy in reason', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(calls.snapshots[0], 'scan_momentum');
  await sc.runStrategyScanCycle('bsc_flow_breakout');
  assert.equal(calls.snapshots[1], 'scan_bsc_flow_breakout');
});

test('strategy scan: calls saveState after scan', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(calls.saves, 1);
});

test('strategy scan: updates loopLastCompletedAt[lockKey]', async () => {
  const { deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(typeof deps.loopLastCompletedAt.momentumScan, 'number');
  await sc.runStrategyScanCycle('bsc_flow_breakout');
  assert.equal(typeof deps.loopLastCompletedAt.bsc_flow_breakoutScan, 'number');
});

test('strategy scan: releases lock + refreshes flag in finally', async () => {
  let refreshCount = 0;
  const { deps } = baseDeps({ refreshScanInFlightFlag: () => { refreshCount += 1; } });
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  assert.equal(deps.loopLocks.momentumScan, false);
  // Once on acquire, once on release
  assert.ok(refreshCount >= 2);
});

test('strategy scan: lock released even when scan throws', async () => {
  const { deps } = baseDeps({
    scanChain: async () => { throw new Error('boom'); },
    saveState: async () => { throw new Error('save fail'); },
  });
  const sc = create(deps);
  // Inner errors caught per-chain — but saveState may surface
  try { await sc.runStrategyScanCycle('momentum'); } catch (_) {}
  assert.equal(deps.loopLocks.momentumScan, false);
});

// ── Status indicator cleanup ───────────────────────────────────────────────

test('strategy scan: resets momentum scan status for all chains in finally', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('momentum');
  const synced = calls.statusUpdates.sort();
  assert.deepEqual(synced, ['bsc', 'kucoin', 'solana']);
});

test('strategy scan: resets paper strategy status only for configured chain', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runStrategyScanCycle('bsc_flow_breakout');
  assert.deepEqual(calls.statusUpdates, ['bsc']);
});

// ── runDetachedKucoinMomentumScan ──────────────────────────────────────────

test('detached kucoin: returns early when lock held', async () => {
  const { calls, deps } = baseDeps();
  deps.loopLocks.kucoinMomentumScan = true;
  const sc = create(deps);
  await sc.runDetachedKucoinMomentumScan();
  assert.equal(calls.scans.length, 0);
});

test('detached kucoin: returns early outside trading window', async () => {
  const { calls, deps } = baseDeps({ isWithinTradingWindow: () => false });
  const sc = create(deps);
  await sc.runDetachedKucoinMomentumScan();
  assert.equal(calls.scans.length, 0);
});

test('detached kucoin: returns early when paused by shouldPauseKucoinEntryScans', async () => {
  const { calls, deps } = baseDeps({
    shouldPauseKucoinEntryScans: () => ({ paused: true, reason: 'daily_loss_halt', msUntilReset: 3_600_000 }),
  });
  const sc = create(deps);
  await sc.runDetachedKucoinMomentumScan();
  assert.equal(calls.scans.length, 0);
});

test('detached kucoin: scans kucoin only', async () => {
  const { calls, deps } = baseDeps();
  const sc = create(deps);
  await sc.runDetachedKucoinMomentumScan();
  assert.equal(calls.scans.length, 1);
  assert.equal(calls.scans[0].chain, 'kucoin');
  assert.equal(calls.scans[0].strategy, 'momentum');
});

test('detached kucoin: releases lock even on error', async () => {
  const { deps } = baseDeps({
    scanChain: async () => { throw new Error('rpc dead'); },
  });
  const sc = create(deps);
  try { await sc.runDetachedKucoinMomentumScan(); } catch (_) {}
  assert.equal(deps.loopLocks.kucoinMomentumScan, false);
});
