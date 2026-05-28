'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('scripts/promote-paper-to-main.js', 'utf8');

test('promotion requires clean paper health, policy evidence, and rollback after restart failure', () => {
  assert.match(source, /paper health is not clean/);
  assert.match(source, /Promotion denied: policy validation unavailable/);
  assert.match(source, /rollbackCopiedFiles\(liveBackup\)/);
  assert.match(source, /Promotion restart failed; restored previous live files/);
  assert.doesNotMatch(source, /will still promote/);
});
