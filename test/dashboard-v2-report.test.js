'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('dashboard exposes the V2 SQL control-plane report', () => {
  const dashboardSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dashboardSource, /v2:\s*\[/);
  assert.match(dashboardSource, /v2SmokeObjects/);
  assert.match(dashboardSource, /req\.query\.smoke/);
  assert.match(dashboardSource, /OBJECT_ID\(N'\$\{spec\.name\}', N'\$\{spec\.type\}'\)/);
  [
    'riskEnforcementStatus',
    'buildRiskEnforcementStatus',
    'v2_risk_enforcement_mode',
    'v2_can_block_core_rejections',
    'dbo.v_bot_performance_24h',
    'dbo.v_strategy_rejection_waterfall',
    'dbo.v_open_risk_exposure',
    'portfolioAllocationSummary',
    'latestPortfolioAllocationAudits',
    "$.input.portfolioAllocation.proposedTrade",
    'dbo.portfolio_exposure_snapshots',
    'dbo.correlation_snapshots',
    'dbo.v_execution_quality',
    'dbo.strategy_versions',
    'dbo.trading_events',
    'latestStrategyRouting',
    "event_name = 'strategy.routing'",
    "$.enabledStrategies",
    "$.decisions",
    "$.scan.topReasons",
    'dbo.v_perps_control_plane_summary',
    'dbo.v_perps_risk_exposure',
    'dbo.v_perps_execution_quality_summary',
    'dbo.v_perps_promotion_readiness',
    'dbo.perps_signals',
    'dbo.perps_trades',
    'dbo.perps_positions',
    'dbo.perps_admission_snapshots',
    'dbo.promotion_candidates',
    'dbo.walk_forward_results',
    'dbo.v_mutation_proposals_latest',
    'dbo.v_promotion_gate_evaluations_latest',
  ].forEach((identifier) => {
    assert.match(dashboardSource, new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('dashboard exposes admin-gated config provenance with redaction helper', () => {
  const dashboardSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dashboardSource, /buildConfigProvenance/);
  assert.match(dashboardSource, /app\.get\('\/api\/config-provenance', requireAdminToken/);
});

test('dashboard exposes admin-gated config source audit without values', () => {
  const dashboardSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dashboardSource, /buildDashboardConfigSourceAudit/);
  assert.match(dashboardSource, /app\.get\('\/api\/config-source-audit', requireAdminToken/);
  assert.match(dashboardSource, /conflicts:\s*result\.conflicts\.map/);
  assert.doesNotMatch(dashboardSource, /envValue:\s*conflict\.envValue|ecoValue:\s*conflict\.ecoValue/);
});

test('dashboard exposes safe prometheus metrics endpoint', () => {
  const dashboardSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'dashboard.js'), 'utf8');
  assert.match(dashboardSource, /app\.get\('\/metrics'/);
  assert.match(dashboardSource, /renderPrometheusMetrics/);
  assert.match(dashboardSource, /trading_bot_health_ok|buildBotHealthMetrics/);
});
