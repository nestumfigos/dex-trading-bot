'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDotenv, audit, auditBoot } = require('../../src/config/source-audit');

function tmpFile(content, ext = '.env') {
  const p = path.join(os.tmpdir(), `cfg-audit-${Date.now()}-${Math.random()}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}

test('parseDotenv: parses KEY=VALUE pairs, strips quotes + comments', () => {
  const env = parseDotenv(`# comment\nFOO=bar\nBAZ="quoted"\nQUX='single'\n# end`);
  assert.equal(env.FOO, 'bar');
  assert.equal(env.BAZ, 'quoted');
  assert.equal(env.QUX, 'single');
  assert.equal(env['# comment'], undefined);
});

test('audit: detects key in both .env and eco with different values → conflict', () => {
  const r = audit({
    envVars: { MIN_LIQUIDITY_USD: '75000', SQL_ENABLED: 'true' },
    ecoVars: { MIN_LIQUIDITY_USD: '5000', SQL_ENABLED: 'true' },
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].key, 'MIN_LIQUIDITY_USD');
  assert.equal(r.conflicts[0].envValue, '75000');
  assert.equal(r.conflicts[0].ecoValue, '5000');
});

test('audit: matching values do not conflict', () => {
  const r = audit({
    envVars: { SQL_ENABLED: 'true' },
    ecoVars: { SQL_ENABLED: 'true' },
  });
  assert.equal(r.conflicts.length, 0);
});

test('audit: identifies onlyEnv and onlyEco keys', () => {
  const r = audit({
    envVars: { FOO: '1', BOTH: 'x' },
    ecoVars: { BAR: '2', BOTH: 'x' },
  });
  assert.deepEqual(r.onlyEnv, ['FOO']);
  assert.deepEqual(r.onlyEco, ['BAR']);
});

test('audit: respects ignoreKeys set', () => {
  const r = audit({
    envVars: { PORT: '3001', NODE_ENV: 'production' },
    ecoVars: { PORT: '3002', NODE_ENV: 'development' },
    ignoreKeys: new Set(['PORT', 'NODE_ENV']),
  });
  assert.equal(r.conflicts.length, 0);
});

test('audit: lenient flag marks conflicts as warn instead of error', () => {
  const r = audit({
    envVars: { X: 'a' },
    ecoVars: { X: 'b' },
    lenient: true,
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].severity, 'warn');
});

test('auditBoot: throws CONFIG_SOURCE_CONFLICT when conflicts present', () => {
  const envPath = tmpFile('MIN_LIQUIDITY_USD=75000\n');
  const ecoPath = tmpFile(
    `module.exports={apps:[{name:'x',env:{BOT_PROFILE:'live',MIN_LIQUIDITY_USD:'5000'}}]}`,
    '.js'
  );
  const logger = { info() {}, warn() {} };
  assert.throws(
    () => auditBoot({ envPath, ecoPath, profile: 'live', logger }),
    (err) => err.code === 'CONFIG_SOURCE_CONFLICT'
  );
  fs.unlinkSync(envPath);
  fs.unlinkSync(ecoPath);
});

test('auditBoot: lenient mode logs warning, no throw', () => {
  const envPath = tmpFile('X=a\n');
  const ecoPath = tmpFile(
    `module.exports={apps:[{name:'x',env:{BOT_PROFILE:'live',X:'b'}}]}`,
    '.js'
  );
  let warned = false;
  const logger = { info() {}, warn() { warned = true; } };
  const r = auditBoot({ envPath, ecoPath, profile: 'live', lenient: true, logger });
  assert.equal(r.conflicts.length, 1);
  assert.equal(warned, true);
  fs.unlinkSync(envPath);
  fs.unlinkSync(ecoPath);
});

test('auditBoot: clean config logs info, returns empty conflicts', () => {
  const envPath = tmpFile('X=same\n');
  const ecoPath = tmpFile(
    `module.exports={apps:[{name:'x',env:{BOT_PROFILE:'live',X:'same'}}]}`,
    '.js'
  );
  let infoed = false;
  const logger = { info() { infoed = true; }, warn() {} };
  const r = auditBoot({ envPath, ecoPath, profile: 'live', logger });
  assert.equal(r.conflicts.length, 0);
  assert.equal(infoed, true);
  fs.unlinkSync(envPath);
  fs.unlinkSync(ecoPath);
});

test('auditBoot: missing files → empty result, no throw', () => {
  const logger = { info() {}, warn() {} };
  const r = auditBoot({ envPath: '/nonexistent/.env', ecoPath: '/nonexistent/ecosystem.config.js', profile: 'live', logger });
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.envCount, 0);
  assert.equal(r.ecoCount, 0);
});

test('auditBoot: profile mismatch returns empty eco vars', () => {
  const envPath = tmpFile('X=a\n');
  const ecoPath = tmpFile(
    `module.exports={apps:[{name:'x',env:{BOT_PROFILE:'paper',X:'b'}}]}`,
    '.js'
  );
  const logger = { info() {}, warn() {} };
  const r = auditBoot({ envPath, ecoPath, profile: 'live', logger });
  assert.equal(r.ecoCount, 0); // no matching profile
  assert.equal(r.conflicts.length, 0);
  fs.unlinkSync(envPath);
  fs.unlinkSync(ecoPath);
});
