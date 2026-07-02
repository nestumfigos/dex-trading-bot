'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const smoke = require('../scripts/v2-platform-smoke');

test('v2 platform smoke script checks required cross-bot report sections', () => {
  assert.equal(typeof smoke.checkConfigProvenance, 'function');
  assert.equal(typeof smoke.checkPerpsReadiness, 'function');
  assert.equal(typeof smoke.checkPerpsLiveCanaryPolicy, 'function');
  [
    'riskEnforcementStatus',
    'botPerformance24h',
    'strategyRejectionWaterfall',
    'openRiskExposure',
    'portfolioAllocationSummary',
    'latestPortfolioExposureSnapshots',
    'latestCorrelationSnapshots',
    'executionQuality',
    'latestPerpsCanaryPolicyAudits',
    'latestPortfolioAllocationAudits',
    'latestStrategyRouting',
    'perpsControlPlaneSummary',
    'perpsPromotionReadiness',
  ].forEach((section) => {
    assert.ok(smoke.REQUIRED_V2_SECTIONS.includes(section), `${section} missing`);
  });
});

test('v2 platform smoke verifies perps canary policy endpoint blocks unsafe preview', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/live-canary-policy/evaluate');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-admin-token'], 'test-token');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const proposal = JSON.parse(raw || '{}');
      assert.equal(proposal.stage, 'tiny_canary');
      assert.equal(proposal.symbol, 'DOGEUSDT');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        policyEvaluationId: 'live-canary-policy:test',
        liveExecutionEnabled: false,
        audit: {
          attempted: true,
          recorded: true,
        },
        policy: {
          ok: false,
          reasons: [
            'symbol_not_allowed_for_canary',
            'canary_notional_above_limit',
            'canary_leverage_above_limit',
          ],
          limits: {
            maxCanaryNotionalUsd: 25,
            maxCanaryLeverage: 2,
          },
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await smoke.checkPerpsLiveCanaryPolicy(`http://127.0.0.1:${port}`, 'test-token');
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingReasons, []);
    assert.equal(result.maxCanaryNotionalUsd, 25);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke script does not print configured admin tokens', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'v2-platform-smoke.js'), 'utf8');
  assert.doesNotMatch(source, /console\.(log|error)\([^)]*(DASHBOARD_ADMIN_TOKEN|PERPS_ADMIN_TOKEN|token)/i);
  assert.match(source, /'x-admin-token': token/);
});

test('v2 platform smoke retries transient connection failures after restarts', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'v2-platform-smoke.js'), 'utf8');
  assert.match(source, /async function fetchWithRetry/);
  assert.match(source, /attempts = 5/);
  assert.match(source, /await sleep\(delayMs\)/);
});

test('v2 platform smoke requires perps readiness metrics', async () => {
  let includeReadiness = true;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/metrics');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end([
      'trading_bot_health_ok{bot_profile="paper_perps"} 1',
      'trading_bot_sql_enabled{bot_profile="paper_perps"} 1',
      ...(includeReadiness ? [
        'trading_bot_perps_live_readiness_gates_blocked{bot_profile="paper_perps"} 4',
        'trading_bot_perps_live_readiness_gate_passed{bot_profile="paper_perps",gate="paper_evidence_passed"} 0',
      ] : []),
    ].join('\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await smoke.checkMetrics(`http://127.0.0.1:${port}`, 'perps');
    assert.equal(ok.ok, true);
    assert.equal(ok.hasPerpsReadinessMetrics, true);

    includeReadiness = false;
    const bad = await smoke.checkMetrics(`http://127.0.0.1:${port}`, 'perps');
    assert.equal(bad.ok, false);
    assert.equal(bad.hasPerpsReadinessMetrics, false);

    const spot = await smoke.checkMetrics(`http://127.0.0.1:${port}`, 'live');
    assert.equal(spot.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke retries transient exchange dependency health once', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/health');
    calls += 1;
    res.writeHead(calls === 1 ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1
      ? {
        ok: false,
        unhealthyReasons: ['exchange_dependency_unhealthy'],
        sql: { enabled: true, healthy: true },
      }
      : {
        ok: true,
        unhealthyReasons: [],
        uptimeSeconds: 10,
        sql: { enabled: true, healthy: true },
      }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await smoke.checkHealth('paper', `http://127.0.0.1:${port}`, {
      attempts: 2,
      delayMs: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke uses lightweight V2 SQL report smoke path', async () => {
  let objectExists = true;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-admin-token'], 'test-token');
    assert.equal(req.url, '/api/sql-report?report=v2&smoke=1');
    const data = smoke.REQUIRED_V2_SECTIONS.reduce((acc, section) => {
      acc[section] = section === 'riskEnforcementStatus'
        ? [{
          bot_profile: 'live_spot',
          pre_trade_contract_mode: 'enforce',
          v2_risk_audit_enabled: true,
          v2_risk_enforcement_mode: 'advisory',
          v2_enforcement_active_for_profile: false,
          v2_can_block_core_rejections: false,
          advisory_only: true,
        }]
        : [{ objectName: `dbo.${section}`, exists: objectExists }];
      return acc;
    }, {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: objectExists, smoke: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await smoke.checkSpotSqlReport(`http://127.0.0.1:${port}`, 'test-token');
    assert.equal(ok.ok, true);
    assert.equal(ok.smoke, true);
    assert.deepEqual(ok.missing, []);
    assert.deepEqual(ok.missingObjects, []);
    assert.deepEqual(ok.invalidRiskEnforcementStatus, []);

    objectExists = false;
    const bad = await smoke.checkSpotSqlReport(`http://127.0.0.1:${port}`, 'test-token');
    assert.equal(bad.ok, false);
    assert.equal(bad.missingObjects.length, smoke.REQUIRED_V2_SECTIONS.length - 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke rejects malformed risk enforcement status rows', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/sql-report?report=v2&smoke=1');
    const data = smoke.REQUIRED_V2_SECTIONS.reduce((acc, section) => {
      acc[section] = section === 'riskEnforcementStatus'
        ? [{ bot_profile: 'live_spot', v2_risk_enforcement_mode: 'unsafe' }]
        : [{ objectName: `dbo.${section}`, exists: true }];
      return acc;
    }, {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, smoke: true, data }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await smoke.checkSpotSqlReport(`http://127.0.0.1:${port}`, 'test-token');
    assert.equal(result.ok, false);
    assert.ok(result.invalidRiskEnforcementStatus.includes('risk_enforcement_status_0_v2_risk_enforcement_mode_invalid'));
    assert.ok(result.invalidRiskEnforcementStatus.includes('risk_enforcement_status_0_advisory_only_not_boolean'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke requires perps kill and safe-mode readiness gates', async () => {
  let gates = [
    { gate: 'live_execution_disabled', passed: true },
    { gate: 'perps_kill_switch_clear', passed: true },
    { gate: 'perps_safe_mode_clear', passed: true },
    { gate: 'live_order_dry_run_validated', passed: true },
    { gate: 'live_cancel_reconcile_dry_run_validated', passed: true },
    { gate: 'live_execution_adapter_contract_validated', passed: true },
    { gate: 'live_emergency_flatten_dry_run_validated', passed: true },
    { gate: 'live_exchange_reconciliation_dry_run_validated', passed: true },
    { gate: 'live_user_data_reconciliation_policy_validated', passed: true },
    { gate: 'live_symbol_filters_dry_run_validated', passed: true },
    { gate: 'live_leverage_brackets_dry_run_validated', passed: true },
    { gate: 'live_funding_drag_dry_run_validated', passed: true },
    { gate: 'live_signed_request_dry_run_validated', passed: true },
    { gate: 'live_margin_leverage_dry_run_validated', passed: true },
    { gate: 'live_position_mode_dry_run_validated', passed: true },
    { gate: 'live_user_data_stream_dry_run_validated', passed: true },
    { gate: 'live_user_data_event_normalization_validated', passed: true },
    { gate: 'live_user_data_lifecycle_policy_validated', passed: true },
    { gate: 'live_user_data_stream_health_policy_validated', passed: true },
    { gate: 'live_user_data_stream_client_validated', passed: true },
    { gate: 'live_canary_rollout_policy_validated', passed: true },
    { gate: 'live_user_data_lifecycle_mapping_validated', passed: true },
  ];
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/live-readiness');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      liveExecutionEnabled: false,
      liveReady: false,
      operatorReviewEligible: false,
      gates,
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await smoke.checkPerpsReadiness(`http://127.0.0.1:${port}`);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.missingGates, []);
    assert.deepEqual(ok.failedGates, []);

    gates = [
      { gate: 'live_execution_disabled', passed: true },
      { gate: 'perps_kill_switch_clear', passed: false },
      { gate: 'live_order_dry_run_validated', passed: true },
      { gate: 'live_cancel_reconcile_dry_run_validated', passed: true },
      { gate: 'live_execution_adapter_contract_validated', passed: true },
      { gate: 'live_emergency_flatten_dry_run_validated', passed: true },
      { gate: 'live_exchange_reconciliation_dry_run_validated', passed: true },
      { gate: 'live_user_data_reconciliation_policy_validated', passed: true },
      { gate: 'live_symbol_filters_dry_run_validated', passed: true },
      { gate: 'live_leverage_brackets_dry_run_validated', passed: true },
      { gate: 'live_funding_drag_dry_run_validated', passed: true },
      { gate: 'live_signed_request_dry_run_validated', passed: true },
      { gate: 'live_margin_leverage_dry_run_validated', passed: true },
      { gate: 'live_position_mode_dry_run_validated', passed: true },
      { gate: 'live_user_data_stream_dry_run_validated', passed: true },
      { gate: 'live_user_data_event_normalization_validated', passed: true },
      { gate: 'live_user_data_lifecycle_policy_validated', passed: true },
      { gate: 'live_user_data_stream_health_policy_validated', passed: true },
      { gate: 'live_user_data_stream_client_validated', passed: true },
      { gate: 'live_canary_rollout_policy_validated', passed: true },
      { gate: 'live_user_data_lifecycle_mapping_validated', passed: true },
    ];
    const bad = await smoke.checkPerpsReadiness(`http://127.0.0.1:${port}`);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missingGates, ['perps_safe_mode_clear']);
    assert.deepEqual(bad.failedGates, ['perps_kill_switch_clear']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke detects PM2 lock ownership drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-smoke-locks-'));
  const dataDir = path.join(root, 'data');
  const nowMs = Date.now();
  const freshPayload = {
    pid: 111,
    profile: 'live',
    port: 3002,
    startedAt: new Date(nowMs - 1000).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    pmId: '1',
  };
  const pm2Loader = () => ({
    apps: new Map([['dex-bot', { pid: 111, pm2_env: { status: 'online', pm_uptime: nowMs - 180000 } }]]),
  });

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime-live.lock'), JSON.stringify(freshPayload));
    fs.writeFileSync(path.join(dataDir, 'runtime-live-3002.lock'), JSON.stringify(freshPayload));

    const ok = smoke.checkPm2Ownership('live', 3002, { root, nowMs, pm2Loader });
    assert.equal(ok.ok, true);

    fs.writeFileSync(path.join(dataDir, 'runtime-live.lock'), JSON.stringify({ ...freshPayload, pid: 222 }));
    const bad = smoke.checkPm2Ownership('live', 3002, { root, nowMs, pm2Loader });
    assert.equal(bad.ok, false);
    assert.ok(bad.reasons.includes('pm2_profile_lock_pid_mismatch'));
    assert.ok(bad.reasons.includes('profile_port_lock_pid_mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 platform smoke detects too-recent PM2 restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-smoke-recent-restart-'));
  const dataDir = path.join(root, 'data');
  const nowMs = Date.now();
  const freshPayload = {
    pid: 444,
    profile: 'paper',
    port: 3003,
    startedAt: new Date(nowMs - 15000).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    pmId: '2',
  };
  const pm2Loader = () => ({
    apps: new Map([['dex-bot-paper', { pid: 444, pm2_env: { status: 'online', pm_uptime: nowMs - 15000 } }]]),
  });

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime-paper.lock'), JSON.stringify(freshPayload));
    fs.writeFileSync(path.join(dataDir, 'runtime-paper-3003.lock'), JSON.stringify(freshPayload));

    const result = smoke.checkPm2Ownership('paper', 3003, {
      root,
      nowMs,
      pm2Loader,
      minPm2UptimeMs: 120000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.pm2UptimeMs, 15000);
    assert.equal(result.reasons.some((reason) => reason.startsWith('pm2_uptime_below_min:')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 platform smoke allows PM2 uptime guard to be disabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-smoke-no-uptime-guard-'));
  const dataDir = path.join(root, 'data');
  const nowMs = Date.now();
  const freshPayload = {
    pid: 445,
    profile: 'paper',
    port: 3003,
    startedAt: new Date(nowMs - 15000).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    pmId: '2',
  };
  const pm2Loader = () => ({
    apps: new Map([['dex-bot-paper', { pid: 445, pm2_env: { status: 'online', pm_uptime: nowMs - 15000 } }]]),
  });

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime-paper.lock'), JSON.stringify(freshPayload));
    fs.writeFileSync(path.join(dataDir, 'runtime-paper-3003.lock'), JSON.stringify(freshPayload));

    const result = smoke.checkPm2Ownership('paper', 3003, {
      root,
      nowMs,
      pm2Loader,
      minPm2UptimeMs: 0,
    });
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 platform smoke fails config source audit conflicts without reading values', async () => {
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/config-source-audit') {
      res.writeHead(404);
      res.end();
      return;
    }
    assert.equal(req.headers['x-admin-token'], 'test-token');
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      report: {
        conflictCount: 1,
        conflicts: [{ key: 'SELF_EVOLUTION_ENABLED', severity: 'warn' }],
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await smoke.checkConfigSourceAudit(`http://127.0.0.1:${port}`, 'test-token');
    assert.equal(result.ok, false);
    assert.equal(result.conflictCount, 1);
    assert.deepEqual(result.conflicts, ['SELF_EVOLUTION_ENABLED']);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'envValue'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'ecoValue'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('v2 platform smoke accepts intentional profile differences while checking safety parity', () => {
  const sharedSafety = {
    SELF_EVOLUTION_ALLOW_LIVE_MUTATION: false,
    SELF_EVOLUTION_ALLOW_LIVE_APPLY: false,
    SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: false,
    SELF_EVOLUTION_AUTO_APPLY: false,
    SELF_EVOLUTION_AUTO_PROMOTE: false,
    V2_RISK_ENFORCEMENT_MODE: 'advisory',
    V2_MAX_PORTFOLIO_HEAT_PCT: 25,
    V2_MAX_PORTFOLIO_CORRELATION: 1,
  };
  const result = smoke.checkConfigParity([
    {
      profile: 'live',
      configProvenance: {
        configValues: {
          BOT_PROFILE: 'live',
          PAPER_TRADING: false,
          ...sharedSafety,
        },
      },
    },
    {
      profile: 'paper',
      configProvenance: {
        configValues: {
          BOT_PROFILE: 'paper',
          PAPER_TRADING: true,
          ...sharedSafety,
        },
      },
    },
    {
      profile: 'perps',
      configProvenance: {
        configValues: {
          PERPS_BOT_PROFILE: 'paper_perps',
          LIVE_PERPS_EXECUTION_ENABLED: false,
          PERPS_LIVE_CANARY_STAGE: 'shadow_only',
          PERPS_LIVE_SUBMIT_MODE: 'shadow',
          PERPS_LIVE_CANARY_OPERATOR_APPROVED: false,
        },
      },
    },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.driftKeys, []);
  assert.deepEqual(result.violations, []);
});

test('v2 platform smoke fails unsafe config parity drift and live perps enablement', () => {
  const result = smoke.checkConfigParity([
    {
      profile: 'live',
      configProvenance: {
        configValues: {
          BOT_PROFILE: 'live',
          PAPER_TRADING: false,
          SELF_EVOLUTION_ALLOW_LIVE_MUTATION: false,
          SELF_EVOLUTION_ALLOW_LIVE_APPLY: false,
          SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: false,
          SELF_EVOLUTION_AUTO_APPLY: false,
          SELF_EVOLUTION_AUTO_PROMOTE: false,
          V2_RISK_ENFORCEMENT_MODE: 'advisory',
          V2_MAX_PORTFOLIO_HEAT_PCT: 25,
          V2_MAX_PORTFOLIO_CORRELATION: 1,
        },
      },
    },
    {
      profile: 'paper',
      configProvenance: {
        configValues: {
          BOT_PROFILE: 'paper',
          PAPER_TRADING: true,
          SELF_EVOLUTION_ALLOW_LIVE_MUTATION: true,
          SELF_EVOLUTION_ALLOW_LIVE_APPLY: false,
          SELF_EVOLUTION_UNSAFE_EXPERIMENTAL: false,
          SELF_EVOLUTION_AUTO_APPLY: false,
          SELF_EVOLUTION_AUTO_PROMOTE: false,
          V2_RISK_ENFORCEMENT_MODE: 'advisory',
          V2_MAX_PORTFOLIO_HEAT_PCT: 30,
          V2_MAX_PORTFOLIO_CORRELATION: 1,
        },
      },
    },
    {
      profile: 'perps',
      configProvenance: {
        configValues: {
          PERPS_BOT_PROFILE: 'paper_perps',
          LIVE_PERPS_EXECUTION_ENABLED: true,
          PERPS_LIVE_CANARY_STAGE: 'tiny_canary',
          PERPS_LIVE_SUBMIT_MODE: 'tiny_live_canary',
          PERPS_LIVE_CANARY_OPERATOR_APPROVED: true,
        },
      },
    },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.driftKeys.sort(), [
    'SELF_EVOLUTION_ALLOW_LIVE_MUTATION',
    'V2_MAX_PORTFOLIO_HEAT_PCT',
  ].sort());
  assert.ok(result.violations.includes('unexpected_perps_config:LIVE_PERPS_EXECUTION_ENABLED'));
  assert.ok(result.violations.includes('unexpected_perps_config:PERPS_LIVE_CANARY_STAGE'));
  assert.ok(result.violations.includes('unexpected_perps_config:PERPS_LIVE_SUBMIT_MODE'));
  assert.ok(result.violations.includes('unexpected_perps_config:PERPS_LIVE_CANARY_OPERATOR_APPROVED'));
});

test('v2 platform smoke verifies perps PM2 ownership through paper_perps locks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-smoke-perps-locks-'));
  const dataDir = path.join(root, 'data');
  const nowMs = Date.now();
  const freshPayload = {
    pid: 333,
    profile: 'paper_perps',
    port: 3004,
    startedAt: new Date(nowMs - 1000).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    pmId: '0',
  };
  const pm2Loader = () => ({
    apps: new Map([['dex-bot-perps', { pid: 333, pm2_env: { status: 'online', pm_uptime: nowMs - 180000 } }]]),
  });

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'runtime-paper_perps.lock'), JSON.stringify(freshPayload));
    fs.writeFileSync(path.join(dataDir, 'runtime-paper_perps-3004.lock'), JSON.stringify(freshPayload));

    const ok = smoke.checkPm2Ownership('perps', 3004, { root, nowMs, pm2Loader });
    assert.equal(ok.ok, true);
    assert.equal(ok.app, 'dex-bot-perps');
    assert.equal(ok.lockProfile, 'paper_perps');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v2 platform smoke accepts perps SQL restore when local state matches SQL', () => {
  const result = smoke.checkPerpsSqlRestoreStatus({
    enabled: true,
    required: true,
    attempted: true,
    restored: false,
    reason: 'local_revision_newer_or_equal',
    policy: 'sql_if_newer',
    localFound: true,
    localValid: true,
    localRevision: 229,
    sqlRevision: 229,
    checkedAt: new Date().toISOString(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.policy, 'sql_if_newer');
  assert.equal(result.localRevision, 229);
  assert.equal(result.sqlRevision, 229);
});

test('v2 platform smoke rejects missing or unsafe perps SQL restore state', () => {
  const missing = smoke.checkPerpsSqlRestoreStatus(null);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.reasons, ['sql_restore_status_missing']);

  const unsafe = smoke.checkPerpsSqlRestoreStatus({
    enabled: true,
    required: false,
    attempted: true,
    restored: false,
    reason: 'sql_snapshot_unavailable',
    policy: 'always_sql',
    localFound: true,
    localValid: false,
    sqlRevision: null,
  });
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.reasons.includes('sql_restore_not_required'));
  assert.ok(unsafe.reasons.includes('sql_restore_policy_not_sql_if_newer'));
  assert.ok(unsafe.reasons.includes('sql_restore_unresolved:sql_snapshot_unavailable'));
  assert.ok(unsafe.reasons.includes('sql_restore_local_invalid_without_restore'));
  assert.ok(unsafe.reasons.includes('sql_restore_revision_missing'));
});

test('v2 platform smoke requires SQL-sourced perps control-plane status when SQL is healthy', async () => {
  let source = 'sql';
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      liveExecutionEnabled: false,
      sql: { enabled: true, healthy: true },
      controlPlane: { source },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const ok = await smoke.checkPerpsStatus(`http://127.0.0.1:${port}`);
    assert.equal(ok.ok, true);
    assert.equal(ok.controlPlaneSource, 'sql');

    source = 'local_fallback';
    const bad = await smoke.checkPerpsStatus(`http://127.0.0.1:${port}`);
    assert.equal(bad.ok, false);
    assert.equal(bad.controlPlaneSource, 'local_fallback');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
