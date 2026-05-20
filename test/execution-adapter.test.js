'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getVenueExecutionProfile } = require('../src/utils/execution-adapter');

test('execution adapter exposes normalized venue profiles', () => {
  const kucoin = getVenueExecutionProfile('kucoin');
  const solana = getVenueExecutionProfile('solana');
  const bsc = getVenueExecutionProfile('bsc');

  assert.equal(kucoin.venueKind, 'cex');
  assert.equal(kucoin.requiresNativeQuote, false);
  assert.equal(solana.supportsSplitBuys, true);
  assert.equal(bsc.requiresNativeQuote, true);
});
