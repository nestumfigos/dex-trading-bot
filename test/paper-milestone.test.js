'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { calculatePaperPosition } = require('../src/strategies/perps-sizing');
const { evaluatePaperPerpsRisk } = require('../src/risk/perps-gates');
const { createPaperExecutionAdapter } = require('../src/paper/paper-perps-adapter');
const { buildReduceOnlyExit } = require('../src/exits/perps-reduce-only');
const { createPaperTelemetry } = require('../src/telemetry/perps-stats');
const { createPaperApiServer } = require('../src/server');

function tempTelemetry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-paper-'));
  return {
    dir,
    telemetry: createPaperTelemetry({ historyPath: path.join(dir, 'trades.json') }),
  };
}

test('paper sizing computes liquidation buffer and margin with numeric gates', () => {
  const position = calculatePaperPosition({
    equityUsd: 1000, riskPct: 1, entryPrice: 100, stopPrice: 98, leverage: 3, side: 'long',
  });
  assert.equal(position.riskUsd, 10);
  assert.equal(position.notionalUsd, 500);
  assert.equal(position.marginUsd, 500 / 3);
  assert.ok(position.liquidationBufferMultiple > 2);
});

test('leverage changes margin but never multiplies dollar loss at the stop', () => {
  for (const leverage of [1, 3, 5]) {
    const position = calculatePaperPosition({
      equityUsd: 10000, riskPct: 1, entryPrice: 100, stopPrice: 99, leverage, side: 'long',
    });
    const stopLossUsd = position.notionalUsd * 0.01;
    assert.ok(Math.abs(stopLossUsd - 100) < 0.000001);
  }
});

test('paper risk denies poor R:R, leverage above paper plan, and thin liquidation buffer', () => {
  const result = evaluatePaperPerpsRisk({
    equityUsd: 1000, plannedRewardRisk: 2, liquidationBufferMultiple: 1.5, leverage: 6, marginMode: 'cross',
  });
  assert.equal(result.allow, false);
  assert.ok(result.reasons.includes('reward_risk_below_3'));
  assert.ok(result.reasons.includes('liquidation_buffer_below_2x_stop'));
  assert.ok(result.reasons.includes('leverage_over_paper_cap'));
  assert.ok(result.reasons.includes('isolated_margin_required'));
});

test('paper profile models up to 5x while rejecting malformed liquidation inputs', () => {
  assert.equal(evaluatePaperPerpsRisk({
    equityUsd: 1000, plannedRewardRisk: 3, liquidationBufferMultiple: 2.1, leverage: 5, marginMode: 'isolated',
  }).allow, true);
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  const bad = adapter.openPosition({
    id: 'bad-maintenance', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, maintenanceMarginPct: 'bad',
    plannedRewardRisk: 3, marginMode: 'isolated',
  });
  assert.equal(bad.accepted, false);
  assert.match(bad.reasons[0], /maintenanceMarginPct/);
});

test('paper strategy caps base risk and permits 1 percent only for A-plus setup', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  assert.deepEqual(adapter.openPosition({
    id: 'oversize', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 1,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).reasons, ['risk_pct_above_strategy_cap']);
  assert.equal(adapter.openPosition({
    id: 'a-plus', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 1, isAPlus: true,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).accepted, true);
});

test('paper perps rejects impossible margin and aggregate open risk', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  assert.ok(adapter.openPosition({
    id: 'impossible-margin', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 99.9, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).reasons.includes('insufficient_available_margin'));
  assert.equal(adapter.openPosition({
    id: 'risk-one', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 1, isAPlus: true,
    entryPrice: 100, stopPrice: 95, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).accepted, true);
  assert.equal(adapter.openPosition({
    id: 'risk-two', symbol: 'ETHUSDT', side: 'long', equityUsd: 1000, riskPct: 1, isAPlus: true,
    entryPrice: 100, stopPrice: 95, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).accepted, true);
  const blocked = adapter.openPosition({
    id: 'risk-three', symbol: 'SOLUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 95, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  assert.ok(blocked.reasons.includes('aggregate_open_risk_above_2_pct'));
});

test('paper adapter only exits through reduce-only orders and writes trade telemetry', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry, now: () => '2026-05-24T00:00:00.000Z' });
  const opened = adapter.openPosition({
    id: 'pos-1', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  assert.equal(opened.accepted, true);
  const exited = adapter.reduceOnlyExit({ positionId: 'pos-1', price: 106, fundingUsd: 1, feeUsd: 1, slippageUsd: 1 });
  assert.equal(exited.accepted, true);
  assert.equal(exited.order.reduceOnly, true);
  assert.equal(telemetry.listTrades()[0].reduceOnly, true);
  assert.ok(telemetry.stats().pnlUsd > 0);
  assert.equal(telemetry.stats().slippagePaidUsd, 1);
  assert.ok(telemetry.stats().stressedExpectancyUsd < telemetry.stats().expectancyUsd);
});

test('paper lifecycle charges both-side costs and elapsed funding by default', () => {
  const { telemetry } = tempTelemetry();
  let clock = '2026-05-24T00:00:00.000Z';
  const adapter = createPaperExecutionAdapter({ telemetry, now: () => clock });
  const opened = adapter.openPosition({
    id: 'cost-model', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  clock = '2026-05-24T08:00:00.000Z';
  const closed = adapter.reduceOnlyExit({ positionId: 'cost-model', price: 100 }).trade;
  assert.equal(closed.heldHours, 8);
  assert.ok(closed.feeUsd > opened.position.notionalUsd * 0.0005);
  assert.ok(closed.slippageUsd > opened.position.notionalUsd * 0.0002);
  assert.ok(closed.fundingUsd > 0);
  assert.ok(closed.pnlUsd < 0);
});

test('reduce-only builder caps exits to remaining position notional', () => {
  const exit = buildReduceOnlyExit({
    position: { id: 'pos-1', symbol: 'BTCUSDT', side: 'long', remainingNotionalUsd: 100 },
    notionalUsd: 500,
    price: 105,
  });
  assert.equal(exit.reduceOnly, true);
  assert.equal(exit.closeNotionalUsd, 100);
});

test('live perps execution remains disabled before evidence gates', () => {
  const liveAdapter = require('../src/exchanges/binance-perps');
  assert.throws(() => liveAdapter.placeOrder(), /live execution disabled until evidence gates pass\.placeOrder\(\) is not implemented/);
});

test('paper history visibility does not waive four-week live promotion evidence', () => {
  const { telemetry } = tempTelemetry();
  const evidence = telemetry.evidence({ observationDays: 0 });
  assert.equal(evidence.passed, false);
  assert.ok(evidence.reasons.includes('paper_trades_under_200'));
});

test('partial exits count as one completed position only after final reduce-only exit', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  const opened = adapter.openPosition({
    id: 'partial-position', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  assert.equal(opened.accepted, true);
  const half = opened.position.notionalUsd / 2;
  assert.equal(adapter.reduceOnlyExit({ positionId: 'partial-position', notionalUsd: half, price: 104 }).trade.closed, false);
  assert.equal(telemetry.stats().closed, 0);
  assert.equal(adapter.reduceOnlyExit({ positionId: 'partial-position', price: 106 }).trade.closed, true);
  assert.equal(telemetry.listTrades().length, 2);
  assert.equal(telemetry.stats().closed, 1);
});

test('failed trade persistence does not remove or shrink an open position', () => {
  const telemetry = {
    listOpenPositions: () => [],
    upsertOpenPosition() {},
    removeOpenPosition() {},
    recordTrade() { throw new Error('disk unavailable'); },
  };
  const adapter = createPaperExecutionAdapter({ telemetry });
  const opened = adapter.openPosition({
    id: 'durable-position', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  const before = opened.position.remainingNotionalUsd;
  assert.throws(() => adapter.reduceOnlyExit({ positionId: 'durable-position', price: 106 }), /disk unavailable/);
  assert.equal(adapter.positions.get('durable-position').remainingNotionalUsd, before);
});

test('failed atomic exit commit survives restart without a ghost trade or lost open position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-atomic-failure-'));
  const statePath = path.join(dir, 'state.json');
  let failWrites = false;
  const persistSnapshot = (filePath, snapshot) => {
    if (failWrites) throw new Error('disk unavailable');
    fs.writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');
  };
  const telemetry = createPaperTelemetry({
    historyPath: path.join(dir, 'trades.json'),
    statePath,
    persistSnapshot,
  });
  const adapter = createPaperExecutionAdapter({ telemetry });
  assert.equal(adapter.openPosition({
    id: 'atomic-position', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).accepted, true);
  failWrites = true;
  assert.throws(() => adapter.reduceOnlyExit({ positionId: 'atomic-position', price: 106 }), /disk unavailable/);

  const restarted = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json'), statePath });
  assert.equal(restarted.listOpenPositions().length, 1);
  assert.equal(restarted.listOpenPositions()[0].id, 'atomic-position');
  assert.deepEqual(restarted.listTrades(), []);
});

test('accepted exit and signal dedupe record persist in the same authoritative snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-atomic-signal-'));
  const statePath = path.join(dir, 'state.json');
  const telemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json'), statePath });
  const server = createPaperApiServer({ telemetry });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const signal = (id, action) => ({
    id,
    paperOnly: true,
    approved: true,
    market: 'perps',
    strategy: 'traderxo_perps',
    action,
    positionId: 'atomic-api-position',
    ...(action === 'OPEN_LONG' ? {
      order: {
        symbol: 'BTCUSDT', equityUsd: 1000, riskPct: 0.5, entryPrice: 100,
        stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
      },
    } : { exit: { price: 106 } }),
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signal('atomic-open', 'OPEN_LONG')),
    })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signal('atomic-exit', 'EXIT')),
    })).status, 202);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const restartedTelemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json'), statePath });
  assert.equal(restartedTelemetry.listTrades().length, 1);
  assert.equal(restartedTelemetry.listOpenPositions().length, 0);
  assert.equal(restartedTelemetry.hasSignal('atomic-exit'), true);
});

test('paper API does not acknowledge an order when authoritative persistence fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-api-write-failure-'));
  let failWrites = false;
  const telemetry = createPaperTelemetry({
    historyPath: path.join(dir, 'trades.json'),
    statePath: path.join(dir, 'state.json'),
    persistSnapshot(filePath, snapshot) {
      if (failWrites) throw new Error('disk unavailable');
      fs.writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');
    },
  });
  const server = createPaperApiServer({ telemetry });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  failWrites = true;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'failed-open',
        paperOnly: true,
        approved: true,
        market: 'perps',
        strategy: 'traderxo_perps',
        action: 'OPEN_LONG',
        positionId: 'failed-position',
        order: {
          symbol: 'BTCUSDT', equityUsd: 1000, riskPct: 0.5, entryPrice: 100,
          stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
        },
      }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { accepted: false, reasons: ['paper_state_persistence_unavailable'] });
    assert.deepEqual(telemetry.listOpenPositions(), []);
    assert.equal(telemetry.hasSignal('failed-open'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('legacy migration retains excluded rows but never restores spot proxy open exposure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-legacy-migrate-'));
  const historyPath = path.join(dir, 'trades.json');
  fs.writeFileSync(historyPath, JSON.stringify([{ positionId: 'paper-spot:legacy', pnlUsd: -50 }]));
  fs.writeFileSync(path.join(dir, 'perps-paper-open-positions.json'), JSON.stringify([
    { id: 'paper-spot:legacy', signalId: 'spot-open:legacy', symbol: 'BAD' },
    { id: 'real-perps', signalId: 'perps-open', market: 'perps', strategy: 'traderxo_perps', symbol: 'BTCUSDT' },
  ]));
  const telemetry = createPaperTelemetry({ historyPath });
  assert.equal(telemetry.excludedTradeCount(), 1);
  assert.deepEqual(telemetry.listOpenPositions().map((position) => position.id), ['real-perps']);
});

test('corrupt authoritative state fails closed instead of reviving legacy exposure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-corrupt-state-'));
  const historyPath = path.join(dir, 'trades.json');
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(historyPath, JSON.stringify([]));
  fs.writeFileSync(statePath, '{invalid', 'utf8');
  assert.throws(
    () => createPaperTelemetry({ historyPath, statePath }),
    /paper perps authoritative state unavailable/,
  );
});

test('paper adapter rejects negative cost credits and retains open position', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  assert.equal(adapter.openPosition({
    id: 'cost-position', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  }).accepted, true);
  const result = adapter.reduceOnlyExit({ positionId: 'cost-position', price: 106, feeUsd: -100 });
  assert.deepEqual(result.reasons, ['costs_must_be_finite_and_non_negative']);
  assert.equal(adapter.positions.has('cost-position'), true);
  assert.deepEqual(telemetry.listTrades(), []);
});

test('reopened position keys count as separate perp trade lifecycles', () => {
  const { telemetry } = tempTelemetry();
  const adapter = createPaperExecutionAdapter({ telemetry });
  for (const price of [104, 105]) {
    assert.equal(adapter.openPosition({
      id: 'BTCUSDT', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
      entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
    }).accepted, true);
    assert.equal(adapter.reduceOnlyExit({ positionId: 'BTCUSDT', price }).accepted, true);
  }
  assert.equal(telemetry.stats().closed, 2);
});

test('durable realized R blocks new paper entries after the daily loss limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perps-risk-window-'));
  const telemetry = createPaperTelemetry({
    historyPath: path.join(dir, 'trades.json'),
    now: () => Date.parse('2026-05-25T12:00:00.000Z'),
  });
  const adapter = createPaperExecutionAdapter({ telemetry, now: () => '2026-05-25T10:00:00.000Z' });
  for (const id of ['loss-1', 'loss-2']) {
    assert.equal(adapter.openPosition({
      id, symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
      entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
    }).accepted, true);
    assert.equal(adapter.reduceOnlyExit({ positionId: id, price: 98 }).accepted, true);
  }
  const blocked = adapter.openPosition({
    id: 'loss-3', symbol: 'BTCUSDT', side: 'long', equityUsd: 1000, riskPct: 0.5,
    entryPrice: 100, stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
  });
  assert.equal(blocked.accepted, false);
  assert.ok(blocked.reasons.includes('daily_loss_limit'));
});

test('paper API exposes history while clearly disabling live execution', async () => {
  const { telemetry } = tempTelemetry();
  const server = createPaperApiServer({ telemetry, observationDays: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((res) => res.json());
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`).then((res) => res.json());
    const trades = await fetch(`http://127.0.0.1:${address.port}/api/trades`).then((res) => res.json());
    assert.equal(health.ok, true);
    assert.equal(health.liveExecutionEnabled, false);
    assert.equal(status.liveExecutionEnabled, false);
    assert.equal(status.paperHistoryMenuEnabled, true);
    assert.equal(status.livePromotionEligible, false);
    assert.deepEqual(trades.trades, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('paper API health fails closed when the native scanner reports an error', async () => {
  const { telemetry } = tempTelemetry();
  const server = createPaperApiServer({
    telemetry,
    observationDays: 0,
    scanner: { getStatus: () => ({ enabled: true, lastError: 'market feed down' }) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const health = await response.json();
    assert.equal(response.status, 503);
    assert.equal(health.ok, false);
    assert.deepEqual(health.unhealthyReasons, ['paper_market_scanner_failed']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('approved paper signals create reduce-only trade history and reject duplicate delivery', async () => {
  const { telemetry } = tempTelemetry();
  const server = createPaperApiServer({ telemetry, observationDays: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const open = await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'approved-open-1',
        paperOnly: true,
        approved: true,
        market: 'perps',
        strategy: 'traderxo_perps',
        action: 'OPEN_LONG',
        positionId: 'position-1',
        order: {
          symbol: 'BTCUSDT', equityUsd: 1000, riskPct: 0.5, entryPrice: 100,
          stopPrice: 98, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
        },
      }),
    });
    assert.equal(open.status, 202);

    const exitSignal = {
      id: 'approved-exit-1',
      paperOnly: true,
      approved: true,
      market: 'perps',
      strategy: 'traderxo_perps',
      action: 'EXIT',
      positionId: 'position-1',
      exit: { price: 106, fundingUsd: 1, feeUsd: 1, slippageUsd: 1 },
    };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exitSignal),
    })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exitSignal),
    })).status, 409);

    const trades = await fetch(`http://127.0.0.1:${port}/api/trades`).then((res) => res.json());
    assert.equal(trades.trades.length, 1);
    assert.equal(trades.trades[0].reduceOnly, true);
    assert.equal(trades.trades[0].signalId, 'approved-exit-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('spot proxy signals cannot create paper perp evidence', async () => {
  const { telemetry } = tempTelemetry();
  const server = createPaperApiServer({ telemetry });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'spot-open:btc',
        paperOnly: true,
        approved: true,
        market: 'spot',
        strategy: 'momentum',
        action: 'OPEN_LONG',
        positionId: 'paper-spot:btc',
        order: {
          symbol: 'BTCUSDT', equityUsd: 1000, riskPct: 0.5, entryPrice: 100,
          stopPrice: 98, leverage: 1, plannedRewardRisk: 3, marginMode: 'isolated',
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.deepEqual(body.reasons, ['traderxo_perps_signal_required']);
    assert.deepEqual(telemetry.listTrades(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('paper open positions survive a service restart before an approved exit', async () => {
  const { dir, telemetry } = tempTelemetry();
  const first = createPaperApiServer({ telemetry });
  await new Promise((resolve) => first.listen(0, '127.0.0.1', resolve));
  const firstPort = first.address().port;
  await fetch(`http://127.0.0.1:${firstPort}/api/signals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'restart-open',
      paperOnly: true,
      approved: true,
      market: 'perps',
      strategy: 'traderxo_perps',
      action: 'OPEN_SHORT',
      positionId: 'restart-position',
      order: {
        symbol: 'ETHUSDT', equityUsd: 1000, riskPct: 0.5, entryPrice: 100,
        stopPrice: 102, leverage: 3, plannedRewardRisk: 3, marginMode: 'isolated',
      },
    }),
  });
  await new Promise((resolve) => first.close(resolve));

  const restartedTelemetry = createPaperTelemetry({ historyPath: path.join(dir, 'trades.json') });
  const restarted = createPaperApiServer({ telemetry: restartedTelemetry });
  await new Promise((resolve) => restarted.listen(0, '127.0.0.1', resolve));
  const restartedPort = restarted.address().port;
  try {
    const openPositions = await fetch(`http://127.0.0.1:${restartedPort}/api/open-positions`).then((res) => res.json());
    assert.equal(openPositions.positions.length, 1);
    const exit = await fetch(`http://127.0.0.1:${restartedPort}/api/signals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'restart-exit',
        paperOnly: true,
        approved: true,
        market: 'perps',
        strategy: 'traderxo_perps',
        action: 'EXIT',
        positionId: 'restart-position',
        exit: { price: 95 },
      }),
    });
    assert.equal(exit.status, 202);
    assert.equal(restartedTelemetry.listTrades().length, 1);
  } finally {
    await new Promise((resolve) => restarted.close(resolve));
  }
});
