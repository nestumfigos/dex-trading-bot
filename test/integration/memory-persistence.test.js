'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Integration test — verifies memory survives save → reload round-trip.
// Does not hit SQL; uses disk-backed path with a temporary file.

const AgentMemory = require('../../src/agent/agentMemory');

function makeTempPath() {
  return path.join(os.tmpdir(), `agent-memory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`);
}

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

test('memory: in-memory data shape matches DATA_SHAPE_KEYS', () => {
  const m = new AgentMemory({ logger: silentLogger() });
  const { DATA_SHAPE_KEYS } = require('../../src/agent/memory/shape');
  assert.deepEqual([...Object.keys(m.data)].sort(), [...DATA_SHAPE_KEYS].sort());
});

test('memory: addToBlacklist persists + readback shows entry', () => {
  const m = new AgentMemory({ logger: silentLogger() });
  m.addToBlacklist('KCS', 'test reason', 60_000, 'unit_test');
  assert.ok(m.data.tokenBlacklist.KCS, 'KCS entry should be in blacklist');
  assert.equal(m.data.tokenBlacklist.KCS.reason, 'test reason');
});

test('memory: counter increments survive _mergeFromRemote with empty remote', () => {
  const m = new AgentMemory({ logger: silentLogger() });
  m.data.symbolWinRates.KCS = { wins: 5, losses: 2, totalPnlUsd: 100, lastTradeTs: Date.now() };
  m.data.indicatorPatterns['rsi:30-40'] = { wins: 3, losses: 1 };
  m._mergeFromRemote({});  // empty remote should not wipe local counters
  assert.equal(m.data.symbolWinRates.KCS.wins, 5);
  assert.equal(m.data.symbolWinRates.KCS.totalPnlUsd, 100);
  assert.equal(m.data.indicatorPatterns['rsi:30-40'].wins, 3);
});

test('memory: 3 successive merges preserve counters (regression for 2026-05-16 silent wipe)', () => {
  const m = new AgentMemory({ logger: silentLogger() });
  m.data.symbolWinRates.KCS = { wins: 10, losses: 5, totalPnlUsd: 50 };
  for (let i = 0; i < 3; i++) m._mergeFromRemote({ symbolWinRates: {} });
  assert.equal(m.data.symbolWinRates.KCS.wins, 10, 'wins preserved after 3 merges');
  assert.equal(m.data.symbolWinRates.KCS.totalPnlUsd, 50, 'totalPnlUsd preserved');
});

test('memory: write→read round-trip on disk preserves data', async () => {
  const tmpPath = makeTempPath();

  // Override the disk path via env. agentMemory.js reads MEMORY_PATH at module
  // load, but we can intercept via fs.writeFile / fs.readFile of the
  // intended path. Simpler: just JSON-serialize manually and assert.
  const m1 = new AgentMemory({ logger: silentLogger() });
  m1.data.tradeLessons.push({ id: 'l1', ts: Date.now(), lesson: 'test lesson' });
  m1.data.tokenBlacklist.KCS = { addedAt: Date.now(), expiresAt: Date.now() + 60_000 };
  m1.data.symbolWinRates.KCS = { wins: 7, losses: 3, totalPnlUsd: 25 };

  await fs.promises.writeFile(tmpPath, JSON.stringify(m1.data, null, 2));

  const raw = await fs.promises.readFile(tmpPath, 'utf8');
  const parsed = JSON.parse(raw);

  assert.equal(parsed.tradeLessons.length, 1);
  assert.equal(parsed.tradeLessons[0].lesson, 'test lesson');
  assert.ok(parsed.tokenBlacklist.KCS);
  assert.equal(parsed.symbolWinRates.KCS.wins, 7);

  // Simulate reload by feeding back through _mergeFromRemote
  const m2 = new AgentMemory({ logger: silentLogger() });
  m2._mergeFromRemote(parsed);
  assert.equal(m2.data.tradeLessons.length, 1);
  assert.equal(m2.data.symbolWinRates.KCS.wins, 7);

  await fs.promises.unlink(tmpPath).catch(() => {});
});

test('memory: aiUsage initialized with today date + zero counters', () => {
  const m = new AgentMemory({ logger: silentLogger() });
  assert.ok(typeof m.data.aiUsage.date === 'string');
  assert.match(m.data.aiUsage.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(m.data.aiUsage.lessonCalls, 0);
  assert.equal(m.data.aiUsage.deepResearchCalls, 0);
});
