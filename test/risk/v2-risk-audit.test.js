'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildV2RiskEnvelopeInput,
  runV2RiskAudit,
} = require('../../src/risk/v2-risk-audit');

test('buildV2RiskEnvelopeInput normalizes legacy spot profile and PnL into shared core shape', () => {
  const input = buildV2RiskEnvelopeInput({
    scope: 'paper',
    strategy: 'spot_day_bull_flag',
    trade: { symbol: 'KCS', expectedNetEdgePct: 1.2 },
    state: { walletUsd: 1000, todaysPnlUsd: -15 },
    config: { dailyDrawdownLimitUsd: 30 },
  });

  assert.equal(input.botProfile, 'paper_spot');
  assert.equal(input.strategy, 'spot_day_bull_flag');
  assert.equal(input.symbol, 'KCS');
  assert.equal(input.dailyLossPct, -1.5);
  assert.equal(input.maxDailyLossPct, 3);
  assert.equal(input.expectedNetEdgePct, 1.2);
});

test('buildV2RiskEnvelopeInput attaches portfolio allocation evidence when exposure state is present', () => {
  const input = buildV2RiskEnvelopeInput({
    scope: 'live',
    strategy: 'spot_day_bull_flag',
    trade: { symbol: 'KCSUSDT', expectedNetEdgePct: 1.4, riskUsd: 40 },
    state: {
      walletUsd: 10000,
      portfolioExposures: [
        { botProfile: 'live_spot', strategy: 'spot_day_bull_flag', symbol: 'BTCUSDT', riskUsd: 130 },
      ],
    },
    config: {
      maxPortfolioHeatPct: 5,
      profileRiskBudgetsPct: { live_spot: 1.5 },
      strategyRiskBudgetsPct: { spot_day_bull_flag: 1.5 },
    },
  });

  assert.equal(input.portfolioHeatPct, 1.3);
  assert.equal(input.portfolioAllocation.proposedTrade.allow, false);
  assert.equal(input.portfolioAllocation.proposedTrade.recommendedRiskUsd, 20);
  assert.ok(input.portfolioAllocation.proposedTrade.reasons.includes('profile_budget_exceeded'));
});

test('runV2RiskAudit reports advisory core blocks without changing legacy result', () => {
  const warnings = [];
  const audit = runV2RiskAudit({
    side: 'BUY',
    scope: 'live',
    strategy: 'momentum',
    trade: { symbol: 'ABC', expectedNetEdgePct: 0.4 },
    state: { walletUsd: 1000, todaysPnlUsd: 0 },
    config: { minExpectedNetEdgePct: 0.8 },
    legacyResult: { blocked: [] },
    logger: { warn: (line) => warnings.push(line) },
  });

  assert.equal(audit.enabled, true);
  assert.equal(audit.advisoryOnly, true);
  assert.equal(audit.allow, false);
  assert.equal(audit.legacyBlocked, false);
  assert.equal(audit.coreBlocked, true);
  assert.equal(audit.disagreement, true);
  assert.deepEqual(audit.reasons, ['expected_net_edge_below_min']);
  assert.match(warnings[0], /ADVISORY_BLOCK BUY ABC live_spot\/momentum/);
});

test('runV2RiskAudit reports advisory portfolio allocation blocks', () => {
  const audit = runV2RiskAudit({
    side: 'BUY',
    scope: 'live',
    strategy: 'spot_day_bull_flag',
    trade: { symbol: 'KCSUSDT', expectedNetEdgePct: 1.4, riskUsd: 40 },
    state: {
      walletUsd: 10000,
      portfolioExposures: [
        { botProfile: 'live_spot', strategy: 'spot_day_bull_flag', symbol: 'BTCUSDT', riskUsd: 130 },
      ],
    },
    config: {
      maxPortfolioHeatPct: 5,
      profileRiskBudgetsPct: { live_spot: 1.5 },
      strategyRiskBudgetsPct: { spot_day_bull_flag: 1.5 },
    },
    legacyResult: { blocked: [] },
  });

  assert.equal(audit.allow, false);
  assert.ok(audit.reasons.includes('portfolio_allocation_profile_budget_exceeded'));
  assert.ok(audit.reasons.includes('portfolio_allocation_strategy_budget_exceeded'));
  assert.ok(audit.reasons.includes('portfolio_allocation_risk_reduction_required'));
});

test('buildV2RiskEnvelopeInput reads V2 allocation budget maps from environment', () => {
  const previousProfileBudgets = process.env.V2_PROFILE_RISK_BUDGETS_JSON;
  const previousStrategyBudgets = process.env.V2_STRATEGY_RISK_BUDGETS_JSON;
  try {
    process.env.V2_PROFILE_RISK_BUDGETS_JSON = JSON.stringify({ live_spot: 1.5 });
    process.env.V2_STRATEGY_RISK_BUDGETS_JSON = JSON.stringify({ momentum: 1.5 });

    const input = buildV2RiskEnvelopeInput({
      scope: 'live',
      strategy: 'momentum',
      trade: { symbol: 'CRVUSDT', riskUsd: 40 },
      state: {
        walletUsd: 10000,
        portfolioExposures: [
          { botProfile: 'live_spot', strategy: 'momentum', symbol: 'BTCUSDT', riskUsd: 130 },
        ],
      },
      config: { maxPortfolioHeatPct: 5 },
    });

    assert.equal(input.portfolioAllocation.proposedTrade.allow, false);
    assert.equal(input.portfolioAllocation.proposedTrade.recommendedRiskUsd, 20);
    assert.ok(input.portfolioAllocation.proposedTrade.reasons.includes('profile_budget_exceeded'));
    assert.ok(input.portfolioAllocation.proposedTrade.reasons.includes('strategy_budget_exceeded'));
  } finally {
    if (previousProfileBudgets == null) delete process.env.V2_PROFILE_RISK_BUDGETS_JSON;
    else process.env.V2_PROFILE_RISK_BUDGETS_JSON = previousProfileBudgets;
    if (previousStrategyBudgets == null) delete process.env.V2_STRATEGY_RISK_BUDGETS_JSON;
    else process.env.V2_STRATEGY_RISK_BUDGETS_JSON = previousStrategyBudgets;
  }
});
