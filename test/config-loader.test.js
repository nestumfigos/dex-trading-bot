'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const loader = require('../src/config/loader');

function fakeHotReload(map) {
  return { getKnob: (name, fallback) => (name in map ? map[name] : fallback) };
}

test('DB > env > schema default > fallback precedence', () => {
  loader.detachHotReload();
  delete process.env.PORT;

  // 1. schema default wins when no env, no DB
  assert.equal(loader.read('PORT'), 3002);

  // 2. env beats schema default
  process.env.PORT = '4000';
  assert.equal(loader.read('PORT'), 4000);

  // 3. DB beats env
  loader.attachHotReload(fakeHotReload({ PORT: '5000' }));
  assert.equal(loader.read('PORT'), 5000);

  // 4. fallback when no schema match
  loader.detachHotReload();
  delete process.env.PORT;
  assert.equal(loader.read('TOTALLY_UNKNOWN', 'fb'), 'fb');
});

test('read casts via schema (int / bool / json)', () => {
  loader.detachHotReload();
  process.env.MAX_POSITION_SIZE_PCT = '4.5';
  assert.equal(loader.read('MAX_POSITION_SIZE_PCT'), 4.5);
  process.env.LEARNING_ENABLED = 'true';
  assert.equal(loader.read('LEARNING_ENABLED'), true);
});

test('source() reports correct provenance', () => {
  loader.detachHotReload();
  delete process.env.PORT;
  assert.equal(loader.source('PORT'), 'schema_default');

  process.env.PORT = '3002';
  assert.equal(loader.source('PORT'), 'env');

  loader.attachHotReload(fakeHotReload({ PORT: '3002' }));
  assert.equal(loader.source('PORT'), 'db');

  loader.detachHotReload();
  delete process.env.PORT;
  assert.equal(loader.source('NOPE_NOT_IN_SCHEMA'), 'fallback');
});

test('bad cast falls through to next source', () => {
  loader.detachHotReload();
  // DB has nonsense → falls through to env
  process.env.PORT = '3002';
  loader.attachHotReload(fakeHotReload({ PORT: 'notanint' }));
  assert.equal(loader.read('PORT'), 3002, 'should fall through bad DB cast to env');
  loader.detachHotReload();
});

test('readInt / readFloat / readBool / readString helpers', () => {
  loader.detachHotReload();
  process.env.PORT = '3002';
  assert.equal(loader.readInt('PORT'), 3002);
  process.env.MAX_POSITION_SIZE_PCT = '2.5';
  assert.equal(loader.readFloat('MAX_POSITION_SIZE_PCT'), 2.5);
  process.env.LEARNING_ENABLED = 'on';
  assert.equal(loader.readBool('LEARNING_ENABLED'), true);
  assert.equal(loader.readString('NOPE', 'def'), 'def');
});
