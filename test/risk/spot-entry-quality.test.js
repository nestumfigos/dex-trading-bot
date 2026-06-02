'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateSpotSymbolQuality, normalizeSymbol } = require('../../src/risk/spot-entry-quality');

const NOW = Date.parse('2026-06-02T12:00:00.000Z');

test('spot quality gate blacklists same strategy after recent bad exit', () => {
  const result = evaluateSpotSymbolQuality({
    tokenData: { symbol: 'H', chainKey: 'kucoin' },
    strategyName: 'momentum',
    nowMs: NOW,
    trades: [{
      type: 'SELL',
      symbol: 'H',
      chainKey: 'kucoin',
      strategy: 'momentum',
      reason: 'FAST_STOP_LOSS',
      pnl: -58.85,
      timestamp: '2026-06-02T10:00:00.000Z',
    }],
  });

  assert.equal(result.allow, false);
  assert.equal(result.reason, 'spot_symbol_quality_blacklist_recent_loss');
  assert.equal(result.details.symbol, 'H');
  assert.equal(result.details.strategy, 'momentum');
});

test('spot quality gate default scope does not block a different strategy', () => {
  const result = evaluateSpotSymbolQuality({
    tokenData: { symbol: 'H', chainKey: 'kucoin' },
    strategyName: 'spot_day_bull_flag',
    nowMs: NOW,
    trades: [{
      type: 'SELL',
      symbol: 'H',
      chainKey: 'kucoin',
      strategy: 'momentum',
      reason: 'FAST_STOP_LOSS',
      pnl: -58.85,
      timestamp: '2026-06-02T10:00:00.000Z',
    }],
  });

  assert.equal(result.allow, true);
});

test('spot quality gate ignores old losses and non-bad exits', () => {
  const result = evaluateSpotSymbolQuality({
    tokenData: { symbol: 'WLD/USDT', chainKey: 'kucoin' },
    strategyName: 'momentum',
    nowMs: NOW,
    trades: [
      {
        type: 'SELL',
        symbol: 'WLD',
        chainKey: 'kucoin',
        strategy: 'momentum',
        reason: 'FAST_STOP_LOSS',
        pnl: -10,
        timestamp: '2026-05-20T10:00:00.000Z',
      },
      {
        type: 'SELL',
        symbol: 'WLD',
        chainKey: 'kucoin',
        strategy: 'momentum',
        reason: 'FAST_TRAILING_STOP',
        pnl: -3,
        timestamp: '2026-06-02T10:00:00.000Z',
      },
    ],
  });

  assert.equal(result.allow, true);
});

test('normalizeSymbol strips common quote suffixes', () => {
  assert.equal(normalizeSymbol('WLD/USDT'), 'WLD');
  assert.equal(normalizeSymbol('abc-usdc'), 'ABC');
});
