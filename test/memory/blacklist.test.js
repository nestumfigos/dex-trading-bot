'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bl = require('../../src/agent/memory/blacklist');

function makeData() {
  return { tokenBlacklist: {} };
}

function silentLogger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

const NOW = 1_730_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

// ── addToBlacklist ─────────────────────────────────────────────────────────

test('addToBlacklist: writes entry keyed by upper-case symbol', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'btc', 'pump-and-dump', 12 * HOUR_MS, 'test', { now: NOW });
  assert.ok(data.tokenBlacklist.BTC);
  assert.equal(data.tokenBlacklist.BTC.reason, 'pump-and-dump');
  assert.equal(data.tokenBlacklist.BTC.source, 'test');
  assert.equal(data.tokenBlacklist.BTC.addedAt, NOW);
  assert.equal(data.tokenBlacklist.BTC.expiresAt, NOW + 12 * HOUR_MS);
});

test('addToBlacklist: empty symbol returns false', () => {
  const data = makeData();
  assert.equal(bl.addToBlacklist(data, '', 'reason'), false);
  assert.equal(bl.addToBlacklist(data, null, 'reason'), false);
  assert.deepEqual(data.tokenBlacklist, {});
});

test('addToBlacklist: default duration 24h applied when omitted', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'ETH', 'test', undefined, 'test', { now: NOW });
  assert.equal(data.tokenBlacklist.ETH.expiresAt, NOW + bl.DEFAULT_DURATION_MS);
  assert.equal(bl.DEFAULT_DURATION_MS, 24 * HOUR_MS);
});

test('addToBlacklist: reason truncated to 200 chars', () => {
  const data = makeData();
  const longReason = 'x'.repeat(500);
  bl.addToBlacklist(data, 'SOL', longReason, HOUR_MS, 'test', { now: NOW });
  assert.equal(data.tokenBlacklist.SOL.reason.length, 200);
});

test('addToBlacklist: throws if data.tokenBlacklist missing', () => {
  assert.throws(() => bl.addToBlacklist({}, 'BTC', 'x'), /tokenBlacklist required/);
});

test('addToBlacklist: logger.warn called when provided', () => {
  const data = makeData();
  const calls = [];
  const logger = { ...silentLogger(), warn: (msg) => calls.push(msg) };
  bl.addToBlacklist(data, 'BTC', 'spam', HOUR_MS, 'test', { now: NOW, logger });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('BTC'));
  assert.ok(calls[0].includes('blacklisted'));
});

test('addToBlacklist: re-adding same symbol overwrites', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'first', HOUR_MS, 'a', { now: NOW });
  bl.addToBlacklist(data, 'BTC', 'second', 2 * HOUR_MS, 'b', { now: NOW + 1000 });
  assert.equal(data.tokenBlacklist.BTC.reason, 'second');
  assert.equal(data.tokenBlacklist.BTC.source, 'b');
});

// ── isBlacklisted ──────────────────────────────────────────────────────────

test('isBlacklisted: returns blacklisted=false for unknown symbol', () => {
  const r = bl.isBlacklisted(makeData(), 'BTC');
  assert.equal(r.blacklisted, false);
});

test('isBlacklisted: returns true with reason+source for active entry', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'rugpull', HOUR_MS, 'auto', { now: NOW });
  const r = bl.isBlacklisted(data, 'BTC', { now: NOW + 1000 });
  assert.equal(r.blacklisted, true);
  assert.equal(r.reason, 'rugpull');
  assert.equal(r.source, 'auto');
});

test('isBlacklisted: expired entry returns false AND prunes', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'old', HOUR_MS, 'test', { now: NOW });
  const r = bl.isBlacklisted(data, 'BTC', { now: NOW + 2 * HOUR_MS });
  assert.equal(r.blacklisted, false);
  assert.equal(data.tokenBlacklist.BTC, undefined, 'expired entry pruned on lookup');
});

test('isBlacklisted: case-insensitive lookup', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'x', HOUR_MS, 'test', { now: NOW });
  assert.equal(bl.isBlacklisted(data, 'btc', { now: NOW + 1000 }).blacklisted, true);
  assert.equal(bl.isBlacklisted(data, 'Btc', { now: NOW + 1000 }).blacklisted, true);
});

// ── removeFromBlacklist ────────────────────────────────────────────────────

test('removeFromBlacklist: removes entry, returns true', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'x', HOUR_MS, 'test', { now: NOW });
  assert.equal(bl.removeFromBlacklist(data, 'BTC'), true);
  assert.equal(data.tokenBlacklist.BTC, undefined);
});

test('removeFromBlacklist: returns false for unknown symbol', () => {
  assert.equal(bl.removeFromBlacklist(makeData(), 'UNKNOWN'), false);
});

test('removeFromBlacklist: case-insensitive', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'x', HOUR_MS, 'test', { now: NOW });
  assert.equal(bl.removeFromBlacklist(data, 'btc'), true);
});

// ── pruneExpired ───────────────────────────────────────────────────────────

test('pruneExpired: removes only expired entries, returns count', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'old', HOUR_MS, 'test', { now: NOW });
  bl.addToBlacklist(data, 'ETH', 'fresh', 10 * HOUR_MS, 'test', { now: NOW + 5 * HOUR_MS });
  const pruned = bl.pruneExpired(data, { now: NOW + 3 * HOUR_MS });
  assert.equal(pruned, 1);
  assert.equal(data.tokenBlacklist.BTC, undefined);
  assert.ok(data.tokenBlacklist.ETH);
});

test('pruneExpired: returns 0 when nothing expired', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'fresh', 24 * HOUR_MS, 'test', { now: NOW });
  assert.equal(bl.pruneExpired(data, { now: NOW + HOUR_MS }), 0);
});

test('pruneExpired: empty/missing data returns 0', () => {
  assert.equal(bl.pruneExpired(null), 0);
  assert.equal(bl.pruneExpired({}), 0);
});

// ── getAllBlacklisted ──────────────────────────────────────────────────────

test('getAllBlacklisted: returns array of symbol keys', () => {
  const data = makeData();
  bl.addToBlacklist(data, 'BTC', 'x', HOUR_MS, 'test', { now: NOW });
  bl.addToBlacklist(data, 'ETH', 'x', HOUR_MS, 'test', { now: NOW });
  bl.addToBlacklist(data, 'SOL', 'x', HOUR_MS, 'test', { now: NOW });
  const all = bl.getAllBlacklisted(data).sort();
  assert.deepEqual(all, ['BTC', 'ETH', 'SOL']);
});

test('getAllBlacklisted: empty data returns []', () => {
  assert.deepEqual(bl.getAllBlacklisted({}), []);
  assert.deepEqual(bl.getAllBlacklisted(null), []);
});
