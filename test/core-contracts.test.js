'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEventBus,
  normalizeStrategyDecision,
  assertStrategyShape,
  createOrderIntent,
  assertExecutionAdapter,
  evaluateRiskEnvelope,
  normalizeBotProfile,
  validateRuntimeProfile,
  routeStrategies,
  buildConfigProvenance,
  createMemoryStateStore,
  buildPortfolioAllocationPlan,
  summarizePortfolioRisk,
  createOrderLifecycle,
  applyOrderLifecycleEvent,
  buildOrderIdempotencyKey,
  buildExecutionTradingEvents,
  summarizeVenueHealth,
  renderPrometheusMetrics,
  buildBotHealthMetrics,
  normalizeMutationProposal,
  evaluatePromotionGate,
  normalizeTradingEvent,
} = require('../packages/core');

test('v2 event bus publishes typed trading events and keeps bounded history', async () => {
  const bus = createEventBus({ historyLimit: 1, now: () => '2026-06-05T00:00:00.000Z' });
  const seen = [];
  bus.subscribe('risk.rejected', (event) => seen.push(event));
  await bus.publish('risk.rejected', { symbol: 'BTCUSDT' });
  await bus.publish('signal.evaluated', { symbol: 'ETHUSDT' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload.symbol, 'BTCUSDT');
  assert.equal(bus.getHistory().length, 1);
  assert.equal(bus.getHistory()[0].eventName, 'signal.evaluated');
});

test('v2 telemetry sink preserves correlation identifiers', () => {
  const event = normalizeTradingEvent({
    eventName: 'order.submitted',
    botProfile: 'paper_spot',
    strategy: 'momentum',
    symbol: 'ABCUSDT',
    correlationId: 'intent-abc',
    payload: { orderType: 'market' },
  });

  assert.equal(event.correlationId, 'intent-abc');
  assert.equal(event.eventName, 'order.submitted');
});

test('v2 strategy contract normalizes decisions without binding to persistence', () => {
  const strategy = {
    id: 'spot_day_bull_flag',
    version: '2.0.0',
    marketTypes: ['spot'],
    timeframes: ['5m', '15m'],
    evaluate: async () => ({ signal: 'BUY' }),
  };
  assert.equal(assertStrategyShape(strategy), strategy);

  const decision = normalizeStrategyDecision({
    action: 'open_long',
    setup: 'deviation_reclaim',
    reasons: ['historical_evidence_not_passed'],
    expectedSlippageBps: '12',
  });
  assert.equal(decision.signal, 'OPEN_LONG');
  assert.equal(decision.setupType, 'deviation_reclaim');
  assert.deepEqual(decision.rejectReasons, ['historical_evidence_not_passed']);
  assert.equal(decision.expectedSlippageBps, 12);
});

test('v2 execution contract enforces idempotent order intent shape', () => {
  const intent = createOrderIntent({
    botProfile: 'paper_perps',
    strategy: 'traderxo_perps',
    symbol: 'btcusdt',
    side: 'long',
    marketType: 'perp',
    quoteUsd: 1000,
    reduceOnly: false,
  });
  assert.equal(intent.symbol, 'BTCUSDT');
  assert.equal(intent.side, 'LONG');

  const adapter = {
    venue: 'paper-sim',
    marketType: 'paper',
    quote: async () => ({}),
    submit: async () => ({}),
    reconcile: async () => ({}),
    cancel: async () => ({}),
  };
  assert.equal(assertExecutionAdapter(adapter), adapter);
});

test('v2 risk contract blocks kill switch and liquidation buffer violations', () => {
  assert.deepEqual(evaluateRiskEnvelope({
    botProfile: 'paper_perps',
    strategy: 'traderxo_perps',
    symbol: 'BTCUSDT',
    killSwitch: true,
  }).reasons, ['kill_switch_active']);

  assert.equal(evaluateRiskEnvelope({
    botProfile: 'paper_perps',
    strategy: 'traderxo_perps',
    symbol: 'BTCUSDT',
    liquidationBufferMultiple: 1.2,
    minLiquidationBufferMultiple: 2,
  }).allow, false);
});

test('v2 profile schema maps legacy bot profiles to stable cross-bot identities', () => {
  assert.equal(normalizeBotProfile('live'), 'live_spot');
  assert.equal(normalizeBotProfile('paper'), 'paper_spot');
  assert.equal(normalizeBotProfile('perps-paper'), 'paper_perps');
  assert.equal(validateRuntimeProfile({
    botProfile: 'paper_perps',
    marketType: 'perp',
    liveExecutionEnabled: false,
  }).ok, true);
});

test('v2 strategy router applies profile, risk, exposure, and quality gates deterministically', () => {
  const routed = routeStrategies({
    now: () => '2026-06-06T00:00:00.000Z',
    strategies: [
      { id: 'spot_day_bull_flag', marketTypes: ['spot'] },
      { id: 'traderxo_perps', marketTypes: ['perp'] },
      { id: 'momentum', marketTypes: ['spot'] },
    ],
    marketContext: {
      botProfile: 'paper_spot',
      marketType: 'spot',
      symbol: 'BTCUSDT',
      riskOff: false,
      liquidityTier: 'low',
      executionQualityByStrategy: { momentum: 0.2 },
    },
    performanceByStrategy: {
      momentum: { sampleSize: 30, expectancyUsd: -2, profitFactor: 0.7 },
    },
    openExposure: {
      portfolioHeatPct: 20,
      openPositionCount: 1,
      correlationByStrategy: { spot_day_bull_flag: 0.9 },
    },
    config: {
      enabledStrategyIds: ['spot_day_bull_flag', 'momentum', 'traderxo_perps'],
      maxCorrelation: 0.8,
      maxConcurrentPositions: 3,
      minExecutionQuality: 0.4,
    },
  });

  assert.equal(routed.generatedAt, '2026-06-06T00:00:00.000Z');
  assert.deepEqual(routed.enabledStrategies, ['spot_day_bull_flag', 'momentum']);
  assert.ok(
    routed.decisions.find((item) => item.strategyId === 'traderxo_perps').reasons.includes('market_type_not_supported'),
  );
  assert.ok(
    routed.decisions.find((item) => item.strategyId === 'spot_day_bull_flag').reasons.includes('correlation_cap_pressure'),
  );
  assert.ok(
    routed.decisions.find((item) => item.strategyId === 'momentum').reasons.includes('execution_quality_below_min'),
  );
});

test('v2 config provenance reports active source and redacts secrets', () => {
  const report = buildConfigProvenance({
    now: () => '2026-06-06T00:00:00.000Z',
    schema: {
      BOT_PROFILE: { required: true, enum: ['paper_spot', 'live_spot'] },
      SQL_CONNECTION_STRING: { secret: true },
      MAX_OPEN_POSITIONS: { default: 2, validate: (value) => Number(value) > 0 },
    },
    defaults: { BOT_PROFILE: 'paper_spot' },
    pm2Env: { MAX_OPEN_POSITIONS: '2' },
    env: { SQL_CONNECTION_STRING: 'Server=secret;' },
    dbOverrides: { MAX_OPEN_POSITIONS: '3' },
  });

  assert.equal(report.generatedAt, '2026-06-06T00:00:00.000Z');
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(report.rows.find((row) => row.name === 'MAX_OPEN_POSITIONS').source, 'db');
  assert.equal(report.rows.find((row) => row.name === 'SQL_CONNECTION_STRING').activeValue, '[redacted]');
});

test('v2 state store snapshots and restores profile-scoped state', async () => {
  const store = createMemoryStateStore({
    botProfile: 'paper_perps',
    initialState: { cashUsd: 10000 },
    now: () => '2026-06-06T01:00:00.000Z',
  });
  const saved = await store.save({ cashUsd: 9900 }, { source: 'unit-test' });
  assert.equal(saved.botProfile, 'paper_perps');
  assert.equal(saved.revision, 1);
  assert.equal(saved.source, 'unit-test');

  await store.restore({ version: 1, revision: 7, state: { cashUsd: 10100 }, source: 'sql' });
  assert.deepEqual(await store.load(), { cashUsd: 10100 });
  assert.equal((await store.snapshot()).revision, 7);
});

test('v2 portfolio risk summary computes heat and max pair correlation', () => {
  const summary = summarizePortfolioRisk({
    equityUsd: 10000,
    exposures: [
      { botProfile: 'live_spot', symbol: 'BTCUSDT', notionalUsd: 2000, riskUsd: 100, correlationKey: 'BTC' },
      { botProfile: 'paper_perps', symbol: 'ETHUSDT', notionalUsd: -1500, riskUsd: 80, correlationKey: 'ETH' },
    ],
    correlationPairs: { 'BTC:ETH': 0.72 },
  });

  assert.equal(summary.openPositionCount, 2);
  assert.equal(summary.totalRiskUsd, 180);
  assert.equal(Number(summary.portfolioHeatPct.toFixed(2)), 1.8);
  assert.equal(summary.maxCorrelation, 0.72);
  assert.equal(summary.bySymbol[0].symbol, 'BTCUSDT');
});

test('v2 portfolio allocation applies cross-bot profile and strategy risk budgets', () => {
  const plan = buildPortfolioAllocationPlan({
    equityUsd: 10000,
    targetHeatPct: 3,
    maxHeatPct: 5,
    exposures: [
      { botProfile: 'live_spot', strategy: 'spot_day_bull_flag', symbol: 'BTCUSDT', riskUsd: 120 },
      { botProfile: 'paper_spot', strategy: 'momentum', symbol: 'ETHUSDT', riskUsd: 80 },
      { botProfile: 'paper_perps', strategy: 'traderxo_perps', symbol: 'SOLUSDT', riskUsd: 150 },
    ],
    profileBudgets: { live_spot: 1.5, paper_spot: 1, paper_perps: 2 },
    strategyBudgets: { spot_day_bull_flag: 1.4, traderxo_perps: 2 },
    proposedTrade: {
      botProfile: 'live_spot',
      strategy: 'spot_day_bull_flag',
      symbol: 'KCSUSDT',
      riskUsd: 60,
      notionalUsd: 1000,
    },
  });

  assert.equal(plan.usedRiskUsd, 350);
  assert.equal(Number(plan.currentHeatPct.toFixed(2)), 3.5);
  assert.equal(plan.proposedTrade.allow, false);
  assert.equal(plan.proposedTrade.riskMultiplier, 0.3333333333333333);
  assert.ok(plan.proposedTrade.reasons.includes('profile_budget_exceeded'));
  assert.ok(plan.proposedTrade.reasons.includes('strategy_budget_exceeded'));
  assert.ok(plan.proposedTrade.reasons.includes('risk_reduction_required'));

  const smallPlan = buildPortfolioAllocationPlan({
    equityUsd: 10000,
    maxHeatPct: 5,
    exposures: [{ botProfile: 'live_spot', strategy: 'spot_day_bull_flag', symbol: 'BTCUSDT', riskUsd: 120 }],
    profileBudgets: { live_spot: 1.5 },
    strategyBudgets: { spot_day_bull_flag: 1.5 },
    proposedTrade: { botProfile: 'live_spot', strategy: 'spot_day_bull_flag', symbol: 'KCSUSDT', riskUsd: 20 },
  });

  assert.equal(smallPlan.proposedTrade.allow, true);
  assert.equal(smallPlan.proposedTrade.riskMultiplier, 1);
});

test('v2 portfolio allocation flags correlated proposed exposure', () => {
  const plan = buildPortfolioAllocationPlan({
    equityUsd: 10000,
    maxHeatPct: 5,
    maxCorrelation: 0.75,
    exposures: [{ botProfile: 'live_spot', strategy: 'momentum', symbol: 'BTCUSDT', riskUsd: 100, correlationKey: 'BTC' }],
    correlationPairs: { 'BTC:ETH': 0.82 },
    proposedTrade: {
      botProfile: 'paper_perps',
      strategy: 'traderxo_perps',
      symbol: 'ETHUSDT',
      riskUsd: 50,
      correlationKey: 'ETH',
    },
  });

  assert.equal(plan.proposedTrade.allow, false);
  assert.equal(plan.proposedTrade.maxPairCorrelation, 0.82);
  assert.ok(plan.proposedTrade.reasons.includes('correlation_cap_pressure'));
});

test('v2 execution lifecycle keeps idempotency stable and accounts partial fills', () => {
  const intent = createOrderIntent({
    botProfile: 'paper_perps',
    strategy: 'traderxo_perps',
    symbol: 'BTCUSDT',
    side: 'LONG',
    marketType: 'perp',
    quoteUsd: 1000,
    metadata: { signalId: 'sig-1' },
  });
  assert.equal(buildOrderIdempotencyKey(intent), buildOrderIdempotencyKey({ ...intent }));

  let lifecycle = createOrderLifecycle({ intent, now: () => '2026-06-06T02:00:00.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'submitted', exchangeOrderId: 'ex-1', ts: '2026-06-06T02:00:01.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'partial_fill', fill: { fillId: 'f1', quantity: 2, quoteUsd: 200, feeUsd: 0.2 }, ts: '2026-06-06T02:00:02.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'filled', fill: { fillId: 'f2', quantity: 3, quoteUsd: 330, feeUsd: 0.3 }, ts: '2026-06-06T02:00:03.000Z' });

  assert.equal(lifecycle.state, 'filled');
  assert.equal(lifecycle.exchangeOrderId, 'ex-1');
  assert.equal(lifecycle.filledQuantity, 5);
  assert.equal(lifecycle.filledQuoteUsd, 530);
  assert.equal(lifecycle.feeUsd, 0.5);
  assert.equal(lifecycle.avgFillPrice, 106);
  assert.equal(lifecycle.terminalAt, '2026-06-06T02:00:03.000Z');

  const events = buildExecutionTradingEvents(lifecycle);
  assert.deepEqual(events.map((event) => event.eventName), ['order.submitted', 'fill.confirmed', 'fill.confirmed']);
  assert.equal(events[0].strategy, 'traderxo_perps');
  assert.equal(events[1].correlationId, lifecycle.idempotencyKey);
});

test('v2 execution lifecycle dedupes fills and emits reconciliation evidence', () => {
  const intent = createOrderIntent({
    botProfile: 'live_spot',
    strategy: 'spot_day_bull_flag',
    symbol: 'ETHUSDT',
    side: 'BUY',
    marketType: 'spot',
    quantity: 10,
    metadata: { signalId: 'sig-2' },
  });

  let lifecycle = createOrderLifecycle({ intent, now: () => '2026-06-06T03:00:00.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'submitted', exchangeOrderId: 'ex-2', ts: '2026-06-06T03:00:01.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'partial_fill', fill: { fillId: 'dup', quantity: 4, quoteUsd: 800, feeUsd: 0.8 }, ts: '2026-06-06T03:00:02.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'partial_fill', fill: { fillId: 'dup', quantity: 4, quoteUsd: 800, feeUsd: 0.8 }, ts: '2026-06-06T03:00:03.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, { type: 'filled', fill: { fillId: 'final', quantity: 6, quoteUsd: 1212, feeUsd: 1.2 }, ts: '2026-06-06T03:00:04.000Z' });
  lifecycle = applyOrderLifecycleEvent(lifecycle, {
    type: 'reconciled',
    expectedQuantity: 10,
    actualQuantity: 10,
    expectedQuoteUsd: 2000,
    actualQuoteUsd: 2012,
    source: 'exchange_fill_reconcile',
    ts: '2026-06-06T03:00:05.000Z',
  });

  assert.equal(lifecycle.state, 'reconciled');
  assert.equal(lifecycle.fills.length, 2);
  assert.equal(lifecycle.filledQuantity, 10);
  assert.equal(lifecycle.filledQuoteUsd, 2012);
  assert.equal(lifecycle.fillRatio, 1);
  assert.equal(lifecycle.reconciliation.status, 'mismatch');
  assert.equal(lifecycle.reconciliation.quoteDiffUsd, 12);

  const events = buildExecutionTradingEvents(lifecycle);
  assert.deepEqual(
    events.map((event) => event.eventName),
    ['order.submitted', 'fill.confirmed', 'fill.confirmed', 'order.reconciled'],
  );
  assert.equal(events.at(-1).severity, 'warn');
  assert.equal(events.at(-1).payload.reconciliation.source, 'exchange_fill_reconcile');
});

test('v2 venue health summarizes execution quality pressure', () => {
  const health = summarizeVenueHealth({
    venue: 'kucoin',
    thresholds: { maxFailureRatePct: 20, maxP95LatencyMs: 1000, maxP95SlippageBps: 50 },
    samples: [
      { ok: true, latencyMs: 120, slippageBps: 5 },
      { ok: false, latencyMs: 1400, slippageBps: 90 },
      { ok: true, latencyMs: 100, slippageBps: 2, rateLimited: true },
    ],
  });
  assert.equal(health.venue, 'kucoin');
  assert.equal(health.status, 'unhealthy');
  assert.ok(health.reasons.includes('failure_rate_high'));
  assert.ok(health.reasons.includes('slippage_p95_high'));
});

test('v2 prometheus renderer emits safe health metrics', () => {
  const text = renderPrometheusMetrics(buildBotHealthMetrics({
    botProfile: 'live_spot',
    health: {
      ok: true,
      degraded: false,
      uptimeSeconds: 12,
      unhealthyReasons: [],
      sql: { enabled: true, connected: true },
    },
    extra: { live_execution_enabled: false },
  }));
  assert.match(text, /# TYPE trading_bot_health_ok gauge/);
  assert.match(text, /trading_bot_health_ok\{bot_profile="live_spot"\} 1/);
  assert.match(text, /trading_bot_live_execution_enabled\{bot_profile="live_spot"\} 0/);
});

test('v2 mutation proposal normalizes patches and creates a stable hash', () => {
  const proposal = normalizeMutationProposal({
    proposalId: 'proposal-1',
    botProfile: 'paper_spot',
    targetProfile: 'live_spot',
    strategy: 'spot_day_bull_flag',
    patch: { BULL_FLAG_MIN_24H_VOLUME_USD: 5000000, BULL_FLAG_MIN_VOLUME_EXPANSION: 2 },
    rationale: { reason: 'tighten liquidity and breakout confirmation' },
    createdAt: '2026-06-06T03:00:00.000Z',
  });

  assert.equal(proposal.proposalId, 'proposal-1');
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.stage, 'proposal');
  assert.equal(proposal.createdAt, '2026-06-06T03:00:00.000Z');
  assert.equal(proposal.patchHash.length, 64);

  const samePatchDifferentOrder = normalizeMutationProposal({
    proposalId: 'proposal-2',
    botProfile: 'paper_spot',
    targetProfile: 'live_spot',
    strategy: 'spot_day_bull_flag',
    patch: { BULL_FLAG_MIN_VOLUME_EXPANSION: 2, BULL_FLAG_MIN_24H_VOLUME_USD: 5000000 },
  });
  assert.equal(samePatchDifferentOrder.patchHash, proposal.patchHash);
});

test('v2 promotion gate blocks weak evidence and passes strong evidence', () => {
  const weak = evaluatePromotionGate({
    botProfile: 'paper_spot',
    targetProfile: 'live_spot',
    strategy: 'momentum',
    strategyClass: 'day_trade',
    metrics: {
      sampleSize: 5,
      expectancyUsd: -1,
      stressedExpectancyUsd: -2,
      profitFactor: 0.8,
      maxDrawdownPct: 9,
      symbolConcentrationPct: 80,
      regimeCoverageCount: 1,
      executionDiscrepancyPct: 30,
    },
    now: () => '2026-06-06T03:00:00.000Z',
  });

  assert.equal(weak.passed, false);
  assert.ok(weak.reasons.includes('sample_size_below_min'));
  assert.ok(weak.reasons.includes('expectancy_not_positive_after_costs'));
  assert.ok(weak.reasons.includes('single_symbol_dependency'));

  const strong = evaluatePromotionGate({
    botProfile: 'paper_spot',
    targetProfile: 'live_spot',
    strategy: 'momentum',
    strategyClass: 'day_trade',
    metrics: {
      sampleSize: 150,
      expectancyUsd: 1.2,
      stressedExpectancyUsd: 0.4,
      profitFactor: 1.4,
      maxDrawdownPct: 4,
      symbolConcentrationPct: 20,
      regimeCoverageCount: 3,
      executionDiscrepancyPct: 5,
    },
    now: () => '2026-06-06T03:00:00.000Z',
  });

  assert.equal(strong.passed, true);
  assert.deepEqual(strong.reasons, []);
  assert.equal(strong.evaluatedAt, '2026-06-06T03:00:00.000Z');
});
