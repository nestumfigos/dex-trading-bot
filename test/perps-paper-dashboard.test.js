'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _testInternals } = require('../src/dashboard');

test('paper perps dashboard reader returns newest exits and net stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-dashboard-'));
  const historyPath = path.join(dir, 'trades.json');
  fs.writeFileSync(historyPath, JSON.stringify([
    { type: 'EXIT', market: 'perps', strategy: 'traderxo_perps', closedAt: '2026-05-23T00:00:00.000Z', pnlUsd: -5 },
    { type: 'EXIT', market: 'perps', strategy: 'traderxo_perps', closedAt: '2026-05-24T00:00:00.000Z', pnlUsd: 10 },
  ]));

  const trades = _testInternals.readPerpsPaperHistory(historyPath);
  const stats = _testInternals.buildPerpsPaperStats(trades);

  assert.equal(trades[0].pnlUsd, 10);
  assert.deepEqual(stats, {
    closed: 2,
    wins: 1,
    winRatePct: 50,
    pnlUsd: 5,
    profitFactor: 2,
  });
});

test('paper perps dashboard reader safely returns no history when file is absent', () => {
  const historyPath = path.join(os.tmpdir(), 'does-not-exist-perps-trades.json');
  assert.deepEqual(_testInternals.readPerpsPaperHistory(historyPath), []);
  assert.equal(_testInternals.readPerpsPaperHistorySnapshot(historyPath).historyStatus, 'not_started');
});

test('paper perps dashboard reports corrupt history rather than displaying a false empty ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-dashboard-invalid-'));
  const historyPath = path.join(dir, 'trades.json');
  fs.writeFileSync(historyPath, '{bad json', 'utf8');
  const snapshot = _testInternals.readPerpsPaperHistorySnapshot(historyPath);
  assert.equal(snapshot.historyStatus, 'unavailable');
  assert.deepEqual(snapshot.trades, []);
});

test('paper perps summary counts a partially exited position once after it fully closes', () => {
  const stats = _testInternals.buildPerpsPaperStats([
    { type: 'EXIT', positionId: 'p-1', closed: false, pnlUsd: 2 },
    { type: 'EXIT', positionId: 'p-1', closed: true, pnlUsd: 3 },
  ]);
  assert.equal(stats.closed, 1);
  assert.equal(stats.pnlUsd, 5);
});

test('paper perps dashboard excludes spot proxy trades from perp evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-dashboard-proxy-'));
  const historyPath = path.join(dir, 'trades.json');
  fs.writeFileSync(historyPath, JSON.stringify([
    { type: 'EXIT', market: 'perps', strategy: 'traderxo_perps', positionId: 'perp-1', pnlUsd: 5 },
    { type: 'EXIT', positionId: 'paper-spot:btc', signalId: 'spot-exit:btc', pnlUsd: -999 },
  ]));
  const snapshot = _testInternals.readPerpsPaperHistorySnapshot(historyPath);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.excludedNonPerpsTrades, 1);
  assert.equal(_testInternals.buildPerpsPaperStats(snapshot.trades).pnlUsd, 5);
});

test('paper perps dashboard fallback prefers authoritative transactional state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-dashboard-state-'));
  const historyPath = path.join(dir, 'trades.json');
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(historyPath, JSON.stringify([
    { type: 'EXIT', market: 'perps', strategy: 'traderxo_perps', positionId: 'stale', pnlUsd: -50 },
  ]));
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    trades: [{ type: 'EXIT', market: 'perps', strategy: 'traderxo_perps', positionId: 'current', pnlUsd: 5 }],
    openPositions: [],
    signalEvents: [],
  }));
  const snapshot = _testInternals.readPerpsPaperHistorySnapshot(historyPath, statePath);
  assert.equal(snapshot.trades.length, 1);
  assert.equal(snapshot.trades[0].positionId, 'current');
  assert.equal(_testInternals.buildPerpsPaperStats(snapshot.trades).pnlUsd, 5);
});
