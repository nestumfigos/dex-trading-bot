'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('ML leaderboard script is deployed', () => {
  const text = fs.readFileSync('scripts/train-ml-leaderboard.js', 'utf8');
  assert.match(text, /splitWalkForward/);
  assert.match(text, /DEFAULT_FRAMEWORKS/);
  assert.match(text, /catboost/);
});

test('regime model training script is deployed', () => {
  const text = fs.readFileSync('scripts/train-regime-models.js', 'utf8');
  assert.match(text, /kmeans/);
  assert.match(text, /gmm/);
  assert.match(text, /hmm/);
});
