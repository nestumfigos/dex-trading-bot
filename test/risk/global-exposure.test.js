'use strict';

// Parity guard: paper must enforce the same global cross-chain gross-exposure
// cap as live (spot). Per-chain heat alone allows stacking across chains
// (45% sol + 45% bsc + 45% kucoin = 135% gross); checkGlobalExposure caps the
// aggregate. Ported from main 2026-05-30.

const test = require('node:test');
const assert = require('node:assert/strict');

const RiskGuardian = require('../../src/risk/guardian');

test('getTotalInFlightUsd sums in-flight across chains', () => {
  const g = new RiskGuardian({ balance: 100, positions: {} });
  g._inFlightUsd = { solana: 10, bsc: 5, kucoin: 0 };
  assert.equal(g.getTotalInFlightUsd(), 15);
});

test('getGlobalGrossExposureUsd = cost basis + in-flight, excludes exempt symbols', () => {
  const g = new RiskGuardian({
    balance: 100,
    positions: {
      'solana:a': { chainKey: 'solana', costBasisUsd: 40, symbol: 'A' },
      'bsc:b': { chainKey: 'bsc', costBasisUsd: 30, symbol: 'B' },
      // BANANAS31 is the default heat-exempt symbol — must not count toward gross.
      'kucoin:x': { chainKey: 'kucoin', costBasisUsd: 1000, symbol: 'BANANAS31' },
    },
  });
  g._inFlightUsd = { solana: 5 };
  assert.equal(g.getGlobalGrossExposureUsd(), 75); // 40 + 30 + 5, exempt excluded
});

test('checkGlobalExposure BLOCKS cross-chain stacking beyond cap', () => {
  const g = new RiskGuardian({
    balance: 5,
    positions: {
      'solana:a': { chainKey: 'solana', costBasisUsd: 50, quantity: 50, currentPrice: 1, symbol: 'A' },
      'bsc:b': { chainKey: 'bsc', costBasisUsd: 45, quantity: 45, currentPrice: 1, symbol: 'B' },
    },
  });
  // Isolate from the position-sizing cascade — its exact $ output is irrelevant
  // here; current gross (95) already exceeds 90% of equity (100).
  g.positionSize = () => 10;
  const res = g.checkGlobalExposure({ chainKey: 'kucoin', symbol: 'C' }, 'momentum');
  assert.equal(res.blocked, true);
  assert.equal(res.code, 'global_exposure_cap');
  assert.ok(res.exposurePct > 90);
});

test('checkGlobalExposure ALLOWS when aggregate is under cap', () => {
  const g = new RiskGuardian({
    balance: 1000,
    positions: {
      'solana:a': { chainKey: 'solana', costBasisUsd: 50, quantity: 50, currentPrice: 1, symbol: 'A' },
    },
  });
  g.positionSize = () => 10;
  const res = g.checkGlobalExposure({ chainKey: 'kucoin', symbol: 'C' }, 'momentum');
  assert.equal(res.blocked, false);
});

test('checkGlobalExposure is non-blocking when equity is zero', () => {
  const g = new RiskGuardian({ balance: 0, positions: {} });
  g.positionSize = () => 10;
  const res = g.checkGlobalExposure({ chainKey: 'kucoin', symbol: 'C' }, 'momentum');
  assert.equal(res.blocked, false);
});
