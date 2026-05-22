'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyNewsEvent } = require('../src/utils/news-event-classifier');

test('news event classifier flags exploit risk', () => {
  const result = classifyNewsEvent('Bridge exploit drains protocol funds after vulnerability disclosure');
  assert.equal(result.label, 'exploit');
  assert.equal(result.bearish, true);
});

test('news event classifier flags listings as bullish context', () => {
  const result = classifyNewsEvent('Coinbase lists TEST token with trading opening tomorrow');
  assert.equal(result.label, 'listing');
  assert.equal(result.bullish, true);
});
