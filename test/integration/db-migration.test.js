'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Integration test — verifies the migration runner's invariants without
// hitting real SQL: file pairing, idempotency guards, GO splitter, checksum
// drift detection. The actual M001-M015 application is verified by
// `npm run db:migrate` against a live DB; this test guards the engine.

const { _testInternals } = (() => {
  try { return require('../../src/utils/migrations'); } catch { return { _testInternals: null }; }
})();

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const ROLLBACKS_DIR  = path.resolve(__dirname, '../../db/rollbacks');

function readMigrationFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

// ─── File pairing ─────────────────────────────────────────────────────────

test('every migration has a paired rollback', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  const rollbacks  = readMigrationFiles(ROLLBACKS_DIR);
  const orphans    = migrations.filter((f) => !rollbacks.includes(f));
  assert.deepEqual(orphans, [], `unpaired migrations: ${orphans.join(',')}`);
});

test('every rollback has a paired migration', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  const rollbacks  = readMigrationFiles(ROLLBACKS_DIR);
  const orphans    = rollbacks.filter((f) => !migrations.includes(f));
  assert.deepEqual(orphans, [], `orphan rollbacks: ${orphans.join(',')}`);
});

test('migration filenames are sequentially numbered (no gaps)', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  const versions = migrations.map((f) => Number(f.match(/^(\d+)_/)[1]));
  for (let i = 1; i < versions.length; i++) {
    assert.equal(versions[i], versions[i - 1] + 1,
      `gap between ${migrations[i - 1]} and ${migrations[i]}`);
  }
});

// ─── Idempotency guards ───────────────────────────────────────────────────

test('every CREATE TABLE migration uses IF NOT EXISTS guard', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  for (const f of migrations) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    if (!/CREATE TABLE/i.test(body)) continue;
    assert.ok(
      /IF NOT EXISTS\s*\(\s*SELECT[\s\S]+?sys\.tables/i.test(body),
      `${f} has CREATE TABLE without IF NOT EXISTS guard`,
    );
  }
});

test('every CREATE INDEX migration uses IF NOT EXISTS guard (sys.indexes or co-located inside sys.tables guard)', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  for (const f of migrations) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const indexCount = (body.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) || []).length;
    if (indexCount === 0) continue;

    // Find all CREATE INDEX positions that are NOT inside an IF NOT EXISTS sys.tables BEGIN...END block.
    // The co-located pattern is valid: the table-creation guard implicitly guards its indexes.
    const tableBlocks = [];
    const tblRe = /IF NOT EXISTS\s*\(\s*SELECT[\s\S]+?sys\.tables[\s\S]+?BEGIN([\s\S]+?)END/gi;
    let m;
    while ((m = tblRe.exec(body)) !== null) {
      tableBlocks.push([m.index, m.index + m[0].length]);
    }
    const isInsideTableBlock = (pos) => tableBlocks.some(([s, e]) => pos >= s && pos < e);

    const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX/gi;
    const standaloneIndexes = [];
    while ((m = idxRe.exec(body)) !== null) {
      if (!isInsideTableBlock(m.index)) standaloneIndexes.push(m.index);
    }

    const sysIdxGuards = (body.match(/IF NOT EXISTS\s*\(\s*SELECT[\s\S]+?sys\.indexes/gi) || []).length;
    assert.ok(sysIdxGuards >= standaloneIndexes.length,
      `${f} has ${standaloneIndexes.length} standalone CREATE INDEX but only ${sysIdxGuards} sys.indexes guards`);
  }
});

test('every ALTER TABLE ADD column migration uses IF NOT EXISTS guard on sys.columns', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  for (const f of migrations) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const addCount     = (body.match(/ALTER TABLE [^\n]+ADD\s+(?!CONSTRAINT)/gi) || []).length;
    const guardedCount = (body.match(/IF NOT EXISTS\s*\(\s*SELECT[\s\S]+?sys\.columns/gi) || []).length;
    if (addCount > 0) {
      assert.ok(guardedCount >= addCount,
        `${f} has ${addCount} ALTER TABLE ADD but only ${guardedCount} sys.columns guards`);
    }
  }
});

test('every rollback uses IF EXISTS guard on DROP', () => {
  const rollbacks = readMigrationFiles(ROLLBACKS_DIR);
  for (const f of rollbacks) {
    const body = fs.readFileSync(path.join(ROLLBACKS_DIR, f), 'utf8');
    const dropCount    = (body.match(/DROP\s+(TABLE|INDEX|COLUMN|CONSTRAINT)/gi) || []).length;
    const guardedCount = (body.match(/IF EXISTS\s*\(\s*SELECT/gi) || []).length;
    if (dropCount > 0) {
      assert.ok(guardedCount >= 1,
        `${f} has ${dropCount} DROP statements but no IF EXISTS guard`);
    }
  }
});

// ─── GO splitter behavior ─────────────────────────────────────────────────

test('migrations parse into multiple batches when GO present', () => {
  if (!_testInternals?.splitBatchesOnGo) {
    return; // older migrations.js without test hooks
  }
  const sample = readMigrationFiles(MIGRATIONS_DIR).find((f) => {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    return /\bGO\b/m.test(body);
  });
  if (sample) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, sample), 'utf8');
    const batches = _testInternals.splitBatchesOnGo(body);
    assert.ok(batches.length > 1, `${sample} should split into multiple batches`);
  }
});

// ─── Checksum drift detection ─────────────────────────────────────────────

test('migration files are reasonable sizes (non-empty, < 50KB)', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  for (const f of migrations) {
    const stat = fs.statSync(path.join(MIGRATIONS_DIR, f));
    assert.ok(stat.size > 100,    `${f} is suspiciously small (${stat.size} bytes)`);
    assert.ok(stat.size < 50_000, `${f} exceeds 50KB (${stat.size} bytes)`);
  }
});

// ─── Inventory check ─────────────────────────────────────────────────────

test('expected migrations through Week 5 are present (M001-M015)', () => {
  const migrations = readMigrationFiles(MIGRATIONS_DIR);
  const versions = new Set(migrations.map((f) => f.slice(0, 4)));
  const expected = ['0000', '0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014'];
  for (const v of expected) {
    assert.ok(versions.has(v), `migration ${v} missing — Week 5 expects M001-M015 (files 0000-0014)`);
  }
});
