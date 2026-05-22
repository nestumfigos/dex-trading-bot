const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDashboardStatePayload } = require('../src/utils/dashboard-state');

test('dashboard status payload keeps UI-critical schema stable', () => {
  const payload = buildDashboardStatePayload({
    runtime: { uptimeSeconds: 1, totalRuntimeSeconds: 2 },
    mode: 'paper',
    health: { ok: true },
    portfolio: { positions: [], recentTrades: [], openPositionCount: 0 },
    performanceGate: {},
    configSnapshot: {},
    scanStatus: { kucoin: { name: 'KuCoin', strategies: { momentum: {} } } },
    brainState: { callCount: 0, successCount: 0 },
    round: (value) => value,
    filterStatsState: { signalDrought: {}, consecutiveZeroSignalCycles: {}, currentCycle: {}, recentCycles: [] },
    diagnostics: {},
    agentActions: [],
    evolutionState: {},
    trackedTokens: [{ chainKey: 'kucoin', finalSignal: 'HOLD', hasOpenPosition: false }],
    catalystPairs: [],
    recentSignals: [],
    backtests: [],
    simulations: [],
    chainLabels: { kucoin: 'KuCoin' },
    supportsSwingOnChain: () => true,
  });

  assert.equal(payload.mode, 'paper');
  assert.ok(Array.isArray(payload.portfolio.positions));
  assert.ok(Array.isArray(payload.market.trackedTokens));
  assert.ok(Array.isArray(payload.market.chainSummary));
  assert.equal(payload.market.chainSummary[0].chainKey, 'kucoin');
  assert.equal(typeof payload.filterStats.signalDrought.momentum, 'boolean');
});
