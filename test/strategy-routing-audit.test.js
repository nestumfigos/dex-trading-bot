'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStrategyRoutingAudit,
  shouldEmitStrategyRoutingAudit,
  buildOpenExposure,
  buildPerformanceByStrategy,
  buildRouterConfig,
} = require('../src/utils/strategy-routing-audit');

test('strategy routing audit summarizes runtime gates without enabling disabled strategies', () => {
  const audit = buildStrategyRoutingAudit({
    now: () => '2026-06-06T10:00:00.000Z',
    botProfile: 'paper',
    strategyNames: ['momentum', 'spot_day_bull_flag', 'backes_swing'],
    currentStrategy: 'spot_day_bull_flag',
    marketType: 'spot',
    config: {
      paperTrading: true,
      risk: { maxConcurrentPositions: 2, maxPortfolioHeatPct: 75 },
      strategies: {
        momentum: { enabled: true },
        spot_day_bull_flag: { enabled: true },
        backes_swing: { enabled: false },
      },
      strategyRouter: {
        minSampleSize: 2,
        minProfitFactor: 1.1,
        maxConcurrentPositions: 3,
      },
    },
    portfolio: {
      balance: 8000,
      positions: {
        abc: { strategy: 'momentum', costBasisUsd: 2000 },
      },
      strategies: {
        momentum: {
          stats: {
            closedTrades: 3,
            expectancyUsd: -4,
            profitFactor: 0.7,
            avgSlippageBps: 18,
          },
        },
        spot_day_bull_flag: {
          stats: {
            closedTrades: 1,
            expectancyUsd: 3,
            profitFactor: 2,
          },
        },
      },
    },
    marketState: {
      macroRegime: { regime: 'risk_on' },
    },
    cycleStats: {
      strategy: 'spot_day_bull_flag',
      evaluated: 10,
      passed: 0,
      completedAt: '2026-06-06T10:00:01.000Z',
      signalDroughtCycle: true,
      gateRejectCounts: {
        prefilter_volume_below_min: 7,
        detector_sixty_minute_move_below_min: 3,
      },
    },
  });

  assert.equal(audit.eventName, 'strategy.routing');
  assert.equal(audit.botProfile, 'paper_spot');
  assert.equal(audit.strategy, 'spot_day_bull_flag');
  assert.equal(audit.occurredAt, '2026-06-06T10:00:01.000Z');
  assert.deepEqual(audit.payload.enabledStrategies, ['spot_day_bull_flag', 'momentum']);

  const backes = audit.payload.decisions.find((decision) => decision.strategyId === 'backes_swing');
  assert.equal(backes.enabled, false);
  assert.ok(backes.reasons.includes('strategy_not_enabled_for_profile'));
  assert.ok(backes.reasons.includes('strategy_disabled_by_config'));

  const momentum = audit.payload.decisions.find((decision) => decision.strategyId === 'momentum');
  assert.equal(momentum.enabled, true);
  assert.ok(momentum.reasons.includes('recent_expectancy_negative'));
  assert.ok(momentum.reasons.includes('profit_factor_below_min'));

  assert.deepEqual(audit.payload.cycle.topGateRejects, [
    { reason: 'prefilter_volume_below_min', count: 7 },
    { reason: 'detector_sixty_minute_move_below_min', count: 3 },
  ]);
});

test('strategy routing helpers derive exposure, performance, and config consistently', () => {
  const exposure = buildOpenExposure({
    balance: 5000,
    positions: {
      a: { strategy: 'momentum', costBasisUsd: 500, maxOpenCorrelation: 0.3 },
      b: { strategy: 'spot_day_bull_flag', valueUsd: 1000, correlationPressure: 0.7 },
    },
  }, { risk: { maxConcurrentPositions: 4 } });

  assert.equal(exposure.openPositionCount, 2);
  assert.equal(exposure.exposureUsd, 1500);
  assert.equal(exposure.portfolioHeatPct, 23.08);
  assert.equal(exposure.correlationByStrategy.spot_day_bull_flag, 0.7);

  const performance = buildPerformanceByStrategy({
    strategies: {
      momentum: {
        stats: { closedTrades: 5, expectancyUsd: 1.25, profitFactor: 1.3, avgSlippageBps: 30 },
      },
    },
  }, ['momentum']);

  assert.equal(performance.momentum.sampleSize, 5);
  assert.equal(performance.momentum.executionQuality, 0.8);

  const routerConfig = buildRouterConfig({
    risk: { maxConcurrentPositions: 2 },
    strategies: {
      momentum: { enabled: true },
      spot_day_bull_flag: { enabled: false },
    },
  }, ['momentum', 'spot_day_bull_flag']);

  assert.deepEqual(routerConfig.enabledStrategyIds, ['momentum']);
  assert.deepEqual(routerConfig.disabledStrategyIds, ['spot_day_bull_flag']);
  assert.equal(routerConfig.maxConcurrentPositions, 2);
});

test('strategy routing audit throttle is per strategy', () => {
  const state = {};
  const audit = { strategy: 'momentum' };

  assert.equal(shouldEmitStrategyRoutingAudit({ state, audit, nowMs: 1000, throttleMs: 5000 }), true);
  assert.equal(shouldEmitStrategyRoutingAudit({ state, audit, nowMs: 2000, throttleMs: 5000 }), false);
  assert.equal(shouldEmitStrategyRoutingAudit({ state, audit: { strategy: 'spot_day_bull_flag' }, nowMs: 2000, throttleMs: 5000 }), true);
  assert.equal(shouldEmitStrategyRoutingAudit({ state, audit, nowMs: 7000, throttleMs: 5000 }), true);
});
