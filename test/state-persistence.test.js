const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createStatePersistence } = require('../src/utils/state-persistence');

function createTempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-state-test-'));
  return {
    root,
    STATE_PATH: path.join(root, 'state.json'),
    MARKET_STATE_PATH: path.join(root, 'marketState.json'),
    STATE_BACKUP_PATH: path.join(root, 'state.backup.json'),
    MARKET_STATE_BACKUP_PATH: path.join(root, 'marketState.backup.json'),
    STATE_TMP_PATH: path.join(root, 'state.tmp.json'),
    MARKET_STATE_TMP_PATH: path.join(root, 'marketState.tmp.json'),
    SELF_EVOLUTION_HISTORY_PATH: path.join(root, 'self-evolution-history.jsonl'),
  };
}

test('state persistence saves sql-primary and writes disk backups', async (t) => {
  const tmp = createTempPaths();
  t.after(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  const portfolio = { saveFailureCount: 0, statePersistenceError: false, learning: {}, runtime: {} };
  const risk = { dailyStartBalance: 100, dailyResetDate: '2026-05-03', haltedToday: false };
  const strategy = { priceHistory: { a: [1] }, volumeHistory: { a: [2] } };
  const marketState = { trackedTokens: {} };
  const telemetryCalls = [];
  let flushed = 0;
  let runtimeDeltaCalls = 0;
  let persistenceError = false;
  let failureCount = 0;

  const persistence = createStatePersistence({
    logger: { info() {}, warn() {}, error() {} },
    telemetry: {
      logStateSnapshot(payload) { telemetryCalls.push(payload); },
      async flush() { flushed += 1; },
      async syncQueryableState() { return { ok: true }; },
      async getLatestStateSnapshot() { return { ok: false, found: false, reason: 'not_found' }; },
    },
    portfolio,
    risk,
    strategy,
    marketState,
    config: { paperTrading: false },
    BOT_PROFILE: 'live',
    BOT_DATA_DIR: 'data',
    DATA_DIR_ABS: tmp.root,
    ...tmp,
    recordRuntimeDelta() { runtimeDeltaCalls += 1; },
    setStatePersistenceError(value) { persistenceError = Boolean(value); },
    getStatePersistenceError() { return persistenceError; },
    getSaveFailureCount() { return failureCount; },
    setSaveFailureCount(value) { failureCount = value; },
    agentMemory: { data: {} },
    ensureRuntimeStateShape() {},
    ensureLearningStateShape() {},
    ensureStatsShape() {},
    refreshPerformanceMetrics() {},
    normalizeChainKey: (v) => v,
    buildTokenKey: (chain, address) => `${chain}:${address}`,
    enterSafeMode: async () => {},
  });

  await persistence.saveState();

  assert.equal(runtimeDeltaCalls, 1);
  assert.equal(flushed, 1);
  assert.equal(telemetryCalls.length, 1);
  assert.equal(portfolio.saveFailureCount, 0);
  assert.equal(persistenceError, false);
  assert.ok(fs.existsSync(tmp.STATE_PATH));
  assert.ok(fs.existsSync(tmp.MARKET_STATE_PATH));
  const saved = JSON.parse(fs.readFileSync(tmp.STATE_PATH, 'utf8'));
  assert.deepEqual(saved.strategyState.priceHistory, { a: [1] });
});

test('state persistence loads from sql snapshot and migrates legacy position keys', async (t) => {
  const tmp = createTempPaths();
  t.after(() => fs.rmSync(tmp.root, { recursive: true, force: true }));

  const portfolio = { positions: {}, learning: {}, runtime: {} };
  const marketState = { trackedTokens: { 'bad:key': { finalSignal: 'INSUFFICIENT DATA' } } };
  const risk = { dailyStartBalance: 0, dailyResetDate: '', haltedToday: false };
  const strategy = { priceHistory: {}, volumeHistory: {} };
  let persistenceError = true;

  process.env.SQL_ENABLED = 'true';
  process.env.SQL_STATE_RESTORE_ENABLED = 'true';

  const persistence = createStatePersistence({
    logger: { info() {}, warn() {}, error() {} },
    telemetry: {
      logStateSnapshot() {},
      async flush() {},
      async syncQueryableState() { return { ok: true }; },
      async getLatestStateSnapshot() {
        return {
          ok: true,
          found: true,
          ts: '2026-05-03T00:00:00.000Z',
          snapshotKind: 'save',
          state: {
            portfolio: {
              positions: {
                '0xabc': { address: '0xAbC', chain: 'bsc', strategy: 'swing' },
              },
              learning: {},
              runtime: {},
            },
            riskState: { dailyStartBalance: 250, dailyResetDate: '2026-05-03', haltedToday: true },
            strategyState: { priceHistory: { p: [1, 2] }, volumeHistory: { p: [3, 4] } },
          },
          marketState: { trackedTokens: { keep: { finalSignal: 'BUY' } } },
        };
      },
    },
    portfolio,
    risk,
    strategy,
    marketState,
    config: { paperTrading: false },
    BOT_PROFILE: 'live',
    BOT_DATA_DIR: 'data',
    DATA_DIR_ABS: tmp.root,
    ...tmp,
    recordRuntimeDelta() {},
    setStatePersistenceError(value) { persistenceError = Boolean(value); },
    getStatePersistenceError() { return persistenceError; },
    getSaveFailureCount() { return 0; },
    setSaveFailureCount() {},
    agentMemory: { data: {} },
    ensureRuntimeStateShape() { portfolio.runtime = portfolio.runtime || {}; },
    ensureLearningStateShape() { portfolio.learning = portfolio.learning || {}; },
    ensureStatsShape() { portfolio.stats = portfolio.stats || {}; },
    refreshPerformanceMetrics() {},
    normalizeChainKey(chain) { return String(chain).toLowerCase(); },
    buildTokenKey(chain, address) { return `${chain}:${String(address).toLowerCase()}`; },
    enterSafeMode: async () => { throw new Error('should not enter safe mode'); },
  });

  await persistence.loadState();

  assert.equal(risk.dailyStartBalance, 250);
  assert.equal(risk.haltedToday, true);
  assert.deepEqual(strategy.priceHistory, { p: [1, 2] });
  assert.ok(portfolio.positions['bsc:0xabc']);
  assert.equal(portfolio.positions['bsc:0xabc'].strategyKey, 'bsc:0xabc');
  assert.equal(marketState.trackedTokens.bad, undefined);
  assert.equal(persistenceError, false);
});
