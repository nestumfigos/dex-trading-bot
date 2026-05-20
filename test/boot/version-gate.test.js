'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSchemaVersion, readBotVersion } = require('../../src/boot/version-gate');

function makePool(appliedCount, throwOnQuery = false) {
  return {
    request() {
      return {
        async query() {
          if (throwOnQuery) throw new Error('boom');
          return { recordset: [{ n: appliedCount }] };
        },
      };
    },
  };
}

const silentLogger = { info() {}, warn() {} };

test('no getPool fn → skipped', async () => {
  const r = await checkSchemaVersion({ logger: silentLogger });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no_pool_getter');
});

test('pool throws → skipped (lenient)', async () => {
  const r = await checkSchemaVersion({
    getPool: async () => { throw new Error('connect refused'); },
    logger: silentLogger,
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('applied within range → ok', async () => {
  const r = await checkSchemaVersion({
    getPool: async () => makePool(17),
    minSchemaVersion: 15,
    maxSchemaVersion: 20,
    logger: silentLogger,
  });
  assert.equal(r.ok, true);
  assert.equal(r.applied, 17);
});

test('applied below min → ok=false (lenient), no throw', async () => {
  const r = await checkSchemaVersion({
    getPool: async () => makePool(5),
    minSchemaVersion: 17,
    logger: silentLogger,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_low');
});

test('applied below min + strict → throws VERSION_GATE_TOO_LOW', async () => {
  await assert.rejects(
    () => checkSchemaVersion({
      getPool: async () => makePool(5),
      minSchemaVersion: 17,
      strict: true,
      logger: silentLogger,
    }),
    (err) => err.code === 'VERSION_GATE_TOO_LOW'
  );
});

test('applied above max + strict → throws VERSION_GATE_TOO_HIGH', async () => {
  await assert.rejects(
    () => checkSchemaVersion({
      getPool: async () => makePool(99),
      maxSchemaVersion: 17,
      strict: true,
      logger: silentLogger,
    }),
    (err) => err.code === 'VERSION_GATE_TOO_HIGH'
  );
});

test('SQL read fails + strict → throws VERSION_GATE_SQL_FAIL', async () => {
  await assert.rejects(
    () => checkSchemaVersion({
      getPool: async () => makePool(0, true),
      minSchemaVersion: 1,
      strict: true,
      logger: silentLogger,
    }),
    (err) => err.code === 'VERSION_GATE_SQL_FAIL'
  );
});

test('readBotVersion returns string or null', () => {
  const v = readBotVersion();
  assert.ok(v === null || typeof v === 'string');
});
