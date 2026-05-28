'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMomentumScanner } = require('../../src/cycle/momentum-scanner');

function createFixture(overrides = {}) {
  const calls = { process: [], timeout: [] };
  const status = {};
  const scanner = createMomentumScanner({
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    config: { bot: { kucoinBatchSize: 4, kucoinBatchDelayMs: 0, kucoinTokenProcessTimeoutMs: 1234 }, risk: {} },
    marketState: { trackedTokens: {} },
    scanStatus: { kucoin: {}, bsc: {} },
    filterStatsState: { currentCycle: {} },
    isExchangeAvailable: () => true,
    getStrategyScanStatus: () => status,
    syncChainScanStatus: () => {},
    refreshKucoinCatalystCache: async () => [],
    getPrioritizedKucoinCatalystPairs: () => [],
    getTokensForStrategy: async () => ['AAA/USDT'],
    getBscDiscoveryRankSummary: () => null,
    getRotatingScanWindow: (tokens) => tokens,
    recordExchangeSuccess: () => {},
    recordExchangeFailure: () => {},
    processToken: async (...args) => { calls.process.push(args); },
    withTimeout: async (promise, ms, message) => {
      calls.timeout.push({ ms, message });
      return promise;
    },
    sleep: async () => {},
    ...overrides,
  });
  return { scanner, calls };
}

test('kucoin scan timeboxes each token and attaches an entry deadline', async () => {
  const { scanner, calls } = createFixture();
  const before = Date.now();
  await scanner.scanChain('kucoin', {
    name: 'KuCoin',
    refreshTickers: async () => {},
    getNewListings: async () => [],
  }, 'momentum', { forceStrategyPerScan: true });

  assert.equal(calls.timeout.length, 1);
  assert.equal(calls.timeout[0].ms, 1234);
  assert.match(calls.timeout[0].message, /KuCoin token evaluation timed out/);
  assert.deepEqual(calls.process[0][3].forcedStrategies, ['momentum']);
  assert.ok(calls.process[0][3].deadlineAtMs >= before + 1000);
});

test('non-kucoin scans do not apply the KuCoin evaluation deadline', async () => {
  const { scanner, calls } = createFixture();
  await scanner.scanChain('bsc', { name: 'BSC' }, 'momentum');
  assert.equal(calls.timeout.length, 0);
  assert.equal(calls.process[0][3].deadlineAtMs, null);
});

test('late BUY guard is enforced before execution dispatch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.js'), 'utf8');
  const guardAt = source.indexOf('evaluation_deadline_exceeded');
  const executionAt = source.indexOf('const decisionResult = await handleApprovedTradeDecision');
  assert.ok(guardAt > 0);
  assert.ok(executionAt > guardAt);
});
