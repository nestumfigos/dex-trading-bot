'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { execFileSync } = require('child_process');

const LIVE_ROOT = path.resolve(__dirname, '..');
const PLATFORM_ROOTS = {
  live: LIVE_ROOT,
  paper: path.resolve(LIVE_ROOT, '..', 'dex-trading-bot-paper'),
  perps: path.resolve(LIVE_ROOT, '..', 'dex-trading-bot-perps'),
};

const DEFAULT_PORTS = {
  live: 3002,
  paper: 3003,
  perps: 3004,
};

const PM2_APPS = {
  live: 'dex-bot',
  paper: 'dex-bot-paper',
  perps: 'dex-bot-perps',
};

const PM2_LOCK_PROFILES = {
  live: 'live',
  paper: 'paper',
  perps: 'paper_perps',
};

const pm2Cache = {
  loaded: false,
  apps: null,
  error: null,
};

const REQUIRED_V2_SECTIONS = [
  'riskEnforcementStatus',
  'botPerformance24h',
  'strategyRejectionWaterfall',
  'openRiskExposure',
  'portfolioAllocationSummary',
  'latestPortfolioExposureSnapshots',
  'latestCorrelationSnapshots',
  'executionQuality',
  'latestStrategyVersions',
  'latestPerpsCanaryPolicyAudits',
  'latestPortfolioAllocationAudits',
  'latestStrategyRouting',
  'perpsControlPlaneSummary',
  'perpsPromotionReadiness',
];

const CONFIG_PARITY_KEYS = [
  'SELF_EVOLUTION_ALLOW_LIVE_MUTATION',
  'SELF_EVOLUTION_ALLOW_LIVE_APPLY',
  'SELF_EVOLUTION_UNSAFE_EXPERIMENTAL',
  'SELF_EVOLUTION_AUTO_APPLY',
  'SELF_EVOLUTION_AUTO_PROMOTE',
  'V2_RISK_ENFORCEMENT_MODE',
  'V2_MAX_PORTFOLIO_HEAT_PCT',
  'V2_MAX_PORTFOLIO_CORRELATION',
];

const CONFIG_EXPECTED_VALUES = {
  live: {
    BOT_PROFILE: ['live', 'live_spot'],
    PAPER_TRADING: [false, 'false', '0', 'off'],
  },
  paper: {
    BOT_PROFILE: ['paper', 'paper_spot'],
    PAPER_TRADING: [true, 'true', '1', 'on'],
  },
  perps: {
    PERPS_BOT_PROFILE: ['paper_perps'],
    LIVE_PERPS_EXECUTION_ENABLED: [false, 'false', '0', 'off'],
    PERPS_LIVE_CANARY_STAGE: ['shadow_only'],
    PERPS_LIVE_SUBMIT_MODE: ['shadow'],
    PERPS_LIVE_CANARY_OPERATOR_APPROVED: [false, 'false', '0', 'off'],
  },
};

const CONFIG_VALUE_KEYS = Array.from(new Set([
  ...CONFIG_PARITY_KEYS,
  ...Object.values(CONFIG_EXPECTED_VALUES).flatMap((expected) => Object.keys(expected)),
]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnv(root) {
  const filePath = path.join(root, '.env');
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
}

function getPort(profile) {
  const overrideName = `V2_SMOKE_${profile.toUpperCase()}_PORT`;
  const value = Number(process.env[overrideName] || DEFAULT_PORTS[profile]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PORTS[profile];
}

function getAdminToken(profile, env) {
  const overrideName = `V2_SMOKE_${profile.toUpperCase()}_ADMIN_TOKEN`;
  if (process.env[overrideName]) return process.env[overrideName];
  if (profile === 'perps') return process.env.PERPS_ADMIN_TOKEN || env.PERPS_ADMIN_TOKEN || '';
  return process.env.DASHBOARD_ADMIN_TOKEN || env.DASHBOARD_ADMIN_TOKEN || '';
}

function parseIsoMs(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : null;
}

function loadPm2Apps() {
  if (pm2Cache.loaded) return pm2Cache;
  pm2Cache.loaded = true;
  try {
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'pm2';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pm2 jlist'] : ['jlist'];
    const raw = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(raw || '[]');
    pm2Cache.apps = new Map(rows.map((row) => [row?.name, row]));
  } catch (error) {
    pm2Cache.error = error;
    pm2Cache.apps = null;
  }
  return pm2Cache;
}

function shouldCheckPm2Ownership() {
  const value = String(process.env.V2_SMOKE_CHECK_PM2 || 'auto').toLowerCase();
  return value !== 'false' && value !== '0' && value !== 'off';
}

function getMinPm2UptimeMs() {
  const value = Number(process.env.V2_SMOKE_MIN_PM2_UPTIME_SECONDS || 120);
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

function checkPm2Ownership(profile, port, {
  root = PLATFORM_ROOTS[profile],
  nowMs = Date.now(),
  maxHeartbeatAgeMs = Number(process.env.V2_SMOKE_MAX_LOCK_HEARTBEAT_AGE_MS || 90000),
  minPm2UptimeMs = getMinPm2UptimeMs(),
  pm2Loader = loadPm2Apps,
} = {}) {
  if (!PM2_APPS[profile]) {
    return { ok: true, skipped: 'profile_not_pm2_managed' };
  }
  if (!shouldCheckPm2Ownership()) {
    return { ok: true, skipped: 'disabled_by_env' };
  }

  const pm2 = pm2Loader();
  if (!pm2.apps) {
    const forced = String(process.env.V2_SMOKE_CHECK_PM2 || '').toLowerCase() === 'true';
    return {
      ok: !forced,
      skipped: forced ? undefined : 'pm2_unavailable',
      error: forced ? (pm2.error?.message || 'pm2 unavailable') : undefined,
    };
  }

  const reasons = [];
  const app = pm2.apps.get(PM2_APPS[profile]);
  const lockProfile = PM2_LOCK_PROFILES[profile] || profile;
  const dataDir = path.join(root, 'data');
  const profileLockPath = path.join(dataDir, `runtime-${lockProfile}.lock`);
  const portLockPath = path.join(dataDir, `runtime-${lockProfile}-${port}.lock`);
  const replacementLocks = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((name) => (
      name.startsWith(`runtime-${lockProfile}-${port}-`) && name.endsWith('.replace.lock')
    ))
    : [];

  if (!app) reasons.push('pm2_app_missing');
  if (app && app.pm2_env?.status !== 'online') reasons.push(`pm2_status_${app.pm2_env?.status || 'unknown'}`);
  if (app && !(Number(app.pid) > 0)) reasons.push('pm2_pid_missing');
  const pm2UptimeStartedMs = Number(app?.pm2_env?.pm_uptime || 0);
  const pm2UptimeMs = pm2UptimeStartedMs > 0 ? Math.max(0, nowMs - pm2UptimeStartedMs) : null;
  if (app && minPm2UptimeMs > 0 && pm2UptimeMs != null && pm2UptimeMs < minPm2UptimeMs) {
    reasons.push(`pm2_uptime_below_min:${Math.round(pm2UptimeMs / 1000)}s<${Math.round(minPm2UptimeMs / 1000)}s`);
  }
  if (!fs.existsSync(profileLockPath)) reasons.push('profile_lock_missing');
  if (!fs.existsSync(portLockPath)) reasons.push('port_lock_missing');
  if (replacementLocks.length) reasons.push('replacement_lock_present');

  let profileLock = null;
  let portLock = null;
  try {
    if (fs.existsSync(profileLockPath)) profileLock = JSON.parse(fs.readFileSync(profileLockPath, 'utf8'));
    if (fs.existsSync(portLockPath)) portLock = JSON.parse(fs.readFileSync(portLockPath, 'utf8'));
  } catch (error) {
    reasons.push(`lock_json_invalid:${error.message}`);
  }

  const expectedPid = Number(app?.pid || 0);
  const profilePid = Number(profileLock?.pid || 0);
  const portPid = Number(portLock?.pid || 0);
  const heartbeatTs = parseIsoMs(profileLock?.heartbeatAt);
  const heartbeatAgeMs = heartbeatTs == null ? null : Math.max(0, nowMs - heartbeatTs);

  if (profileLock && String(profileLock.profile || '') !== lockProfile) reasons.push('profile_lock_profile_mismatch');
  if (portLock && String(portLock.profile || '') !== lockProfile) reasons.push('port_lock_profile_mismatch');
  if (profileLock && Number(profileLock.port) !== Number(port)) reasons.push('profile_lock_port_mismatch');
  if (portLock && Number(portLock.port) !== Number(port)) reasons.push('port_lock_port_mismatch');
  if (profilePid && portPid && profilePid !== portPid) reasons.push('profile_port_lock_pid_mismatch');
  if (expectedPid && profilePid && expectedPid !== profilePid) reasons.push('pm2_profile_lock_pid_mismatch');
  if (expectedPid && portPid && expectedPid !== portPid) reasons.push('pm2_port_lock_pid_mismatch');
  if (heartbeatAgeMs == null) reasons.push('heartbeat_missing');
  if (heartbeatAgeMs != null && heartbeatAgeMs > maxHeartbeatAgeMs) reasons.push('heartbeat_stale');

  return {
    ok: reasons.length === 0,
    app: PM2_APPS[profile],
    lockProfile,
    pm2Pid: expectedPid || null,
    pm2UptimeMs,
    lockPid: profilePid || null,
    portLockPid: portPid || null,
    heartbeatAgeMs,
    replacementLocks,
    reasons,
  };
}

async function fetchWithRetry(url, options = {}, { attempts = 5, delayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_) {
    body = { parseError: true, preview: text.slice(0, 120) };
  }
  return { response, body };
}

function buildHealthResult(profile, response, body, attempt = 1) {
  const sql = body?.sql || {};
  return {
    ok: response.ok && body?.ok === true,
    status: response.status,
    attempts: attempt,
    degraded: Boolean(body?.degraded),
    uptimeSeconds: Number(body?.uptimeSeconds || 0),
    sqlEnabled: Boolean(sql.enabled),
    sqlHealthy: sql.healthy !== false,
    sqlRestore: profile === 'perps' ? body?.sqlRestore : undefined,
    liveExecutionEnabled: profile === 'perps' ? Boolean(body?.liveExecutionEnabled) : undefined,
    unhealthyReasons: Array.isArray(body?.unhealthyReasons) ? body.unhealthyReasons : [],
  };
}

function shouldRetryTransientHealth(body) {
  const reasons = Array.isArray(body?.unhealthyReasons) ? body.unhealthyReasons : [];
  return reasons.length === 1 && reasons[0] === 'exchange_dependency_unhealthy';
}

async function checkHealth(profile, baseUrl, {
  attempts = Number(process.env.V2_SMOKE_HEALTH_ATTEMPTS || 3),
  delayMs = Number(process.env.V2_SMOKE_HEALTH_RETRY_MS || 15000),
} = {}) {
  const maxAttempts = Math.max(1, Math.min(5, Number(attempts) || 1));
  const retryDelayMs = Math.max(100, Math.min(60000, Number(delayMs) || 1000));
  let latest;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { response, body } = await fetchJson(`${baseUrl}/health`);
    latest = buildHealthResult(profile, response, body, attempt);
    if (latest.ok || attempt === maxAttempts || !shouldRetryTransientHealth(body)) return latest;
    await sleep(retryDelayMs);
  }
  return latest;
}

function checkPerpsSqlRestoreStatus(status) {
  const reasons = [];
  if (!status || typeof status !== 'object') {
    return { ok: false, reasons: ['sql_restore_status_missing'] };
  }

  if (status.enabled !== true) reasons.push('sql_restore_not_enabled');
  if (status.required !== true) reasons.push('sql_restore_not_required');
  if (status.attempted !== true) reasons.push('sql_restore_not_attempted');
  if (String(status.policy || '') !== 'sql_if_newer') reasons.push('sql_restore_policy_not_sql_if_newer');
  if (status.restored !== true && status.reason !== 'local_revision_newer_or_equal') {
    reasons.push(`sql_restore_unresolved:${status.reason || 'unknown'}`);
  }
  if (status.localFound === true && status.localValid === false && status.restored !== true) {
    reasons.push('sql_restore_local_invalid_without_restore');
  }
  const hasSqlRevision = status.sqlRevision !== null && status.sqlRevision !== undefined && status.sqlRevision !== '';
  const sqlRevision = Number(status.sqlRevision);
  if (!hasSqlRevision || !Number.isFinite(sqlRevision) || sqlRevision < 0) reasons.push('sql_restore_revision_missing');

  return {
    ok: reasons.length === 0,
    reasons,
    restored: Boolean(status.restored),
    policy: status.policy || null,
    localRevision: Number.isFinite(Number(status.localRevision)) ? Number(status.localRevision) : null,
    sqlRevision: Number.isFinite(sqlRevision) ? sqlRevision : null,
    checkedAt: status.checkedAt || null,
  };
}

async function checkMetrics(baseUrl, profile = 'unknown') {
  const response = await fetchWithRetry(`${baseUrl}/metrics`);
  const text = await response.text();
  const hasPerpsReadinessMetrics = text.includes('trading_bot_perps_live_readiness_gate_passed')
    && text.includes('trading_bot_perps_live_readiness_gates_blocked');
  return {
    ok: response.ok
      && text.includes('trading_bot_health_ok')
      && (profile !== 'perps' || hasPerpsReadinessMetrics),
    status: response.status,
    hasSqlMetric: text.includes('trading_bot_sql_enabled') || text.includes('trading_bot_sql_telemetry_healthy'),
    hasPerpsReadinessMetrics,
  };
}

function validateRiskEnforcementStatus(rows) {
  const reasons = [];
  if (!Array.isArray(rows) || rows.length === 0) return ['risk_enforcement_status_missing'];
  const allowedModes = new Set(['advisory', 'block_core']);
  rows.forEach((row, index) => {
    const prefix = `risk_enforcement_status_${index}`;
    if (!row || typeof row !== 'object') {
      reasons.push(`${prefix}_invalid_row`);
      return;
    }
    if (!row.bot_profile || typeof row.bot_profile !== 'string') reasons.push(`${prefix}_bot_profile_missing`);
    if (!row.pre_trade_contract_mode || typeof row.pre_trade_contract_mode !== 'string') {
      reasons.push(`${prefix}_pre_trade_contract_mode_missing`);
    }
    if (!allowedModes.has(String(row.v2_risk_enforcement_mode || '').toLowerCase())) {
      reasons.push(`${prefix}_v2_risk_enforcement_mode_invalid`);
    }
    [
      'v2_risk_audit_enabled',
      'v2_enforcement_active_for_profile',
      'v2_can_block_core_rejections',
      'advisory_only',
    ].forEach((field) => {
      if (typeof row[field] !== 'boolean') reasons.push(`${prefix}_${field}_not_boolean`);
    });
  });
  return reasons;
}

async function checkSpotSqlReport(baseUrl, token) {
  const headers = token ? { 'x-admin-token': token } : {};
  const { response, body } = await fetchJson(`${baseUrl}/api/sql-report?report=v2&smoke=1`, { headers });
  const data = body?.data || {};
  const missing = REQUIRED_V2_SECTIONS.filter((section) => !Array.isArray(data[section]));
  const missingObjects = REQUIRED_V2_SECTIONS
    .filter((section) => section !== 'riskEnforcementStatus')
    .filter((section) => Array.isArray(data[section]) && data[section][0]?.exists === false)
    .map((section) => data[section][0]?.objectName || section);
  const invalidRiskEnforcementStatus = validateRiskEnforcementStatus(data.riskEnforcementStatus);
  return {
    ok: response.ok
      && body?.ok === true
      && missing.length === 0
      && missingObjects.length === 0
      && invalidRiskEnforcementStatus.length === 0,
    status: response.status,
    smoke: Boolean(body?.smoke),
    missing,
    missingObjects,
    invalidRiskEnforcementStatus,
  };
}

async function checkConfigProvenance(baseUrl, token) {
  if (!token) {
    return {
      ok: true,
      skipped: 'admin_token_unavailable',
      status: null,
      rows: 0,
      missingRequired: [],
      invalid: [],
      leakedSecretRows: [],
    };
  }
  const headers = token ? { 'x-admin-token': token } : {};
  const { response, body } = await fetchJson(`${baseUrl}/api/config-provenance`, { headers });
  const rows = Array.isArray(body?.report?.rows) ? body.report.rows : [];
  const configValues = rows.reduce((acc, row) => {
    if (row && CONFIG_VALUE_KEYS.includes(row.name)) acc[row.name] = row.activeValue;
    return acc;
  }, {});
  const leakedSecretRows = rows.filter((row) => (
    row?.secret === true
    && [row.defaultValue, row.pm2Value, row.envValue, row.dbValue, row.activeValue]
      .some((value) => value && value !== '[redacted]')
  ));
  return {
    ok: response.ok && body?.ok === true && rows.length > 0 && leakedSecretRows.length === 0,
    status: response.status,
    rows: rows.length,
    missingRequired: Array.isArray(body?.report?.missingRequired) ? body.report.missingRequired : [],
    invalid: Array.isArray(body?.report?.invalid) ? body.report.invalid : [],
    leakedSecretRows: leakedSecretRows.map((row) => row.name),
    configValues,
  };
}

function comparableConfigValue(value) {
  if (value == null) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim().toLowerCase();
}

function valueInSet(value, allowed) {
  const normalized = comparableConfigValue(value);
  return allowed.map(comparableConfigValue).includes(normalized);
}

function checkConfigParity(results) {
  const byProfile = new Map(results.map((result) => [result.profile, result]));
  const liveValues = byProfile.get('live')?.configProvenance?.configValues;
  const paperValues = byProfile.get('paper')?.configProvenance?.configValues;
  const perpsValues = byProfile.get('perps')?.configProvenance?.configValues;
  const missingProfiles = [
    ['live', liveValues],
    ['paper', paperValues],
    ['perps', perpsValues],
  ].filter(([, values]) => !values || Object.keys(values).length === 0).map(([profile]) => profile);

  if (missingProfiles.length) {
    return {
      ok: true,
      skipped: 'config_provenance_unavailable',
      missingProfiles,
      driftKeys: [],
      violations: [],
    };
  }

  const driftKeys = [];
  const violations = [];

  CONFIG_PARITY_KEYS.forEach((key) => {
    const liveValue = liveValues[key];
    const paperValue = paperValues[key];
    if (liveValue == null || paperValue == null) {
      violations.push(`missing_spot_parity_key:${key}`);
      return;
    }
    if (comparableConfigValue(liveValue) !== comparableConfigValue(paperValue)) {
      driftKeys.push(key);
    }
  });

  Object.entries(CONFIG_EXPECTED_VALUES).forEach(([profile, expected]) => {
    const values = byProfile.get(profile)?.configProvenance?.configValues || {};
    Object.entries(expected).forEach(([key, allowed]) => {
      if (!valueInSet(values[key], allowed)) {
        violations.push(`unexpected_${profile}_config:${key}`);
      }
    });
  });

  return {
    ok: driftKeys.length === 0 && violations.length === 0,
    driftKeys,
    violations,
    checkedKeys: CONFIG_PARITY_KEYS,
  };
}

async function checkConfigSourceAudit(baseUrl, token) {
  if (!token) {
    return {
      ok: true,
      skipped: 'admin_token_unavailable',
      status: null,
      conflictCount: 0,
      conflicts: [],
    };
  }
  const headers = token ? { 'x-admin-token': token } : {};
  const { response, body } = await fetchJson(`${baseUrl}/api/config-source-audit`, { headers });
  const conflicts = Array.isArray(body?.report?.conflicts) ? body.report.conflicts : [];
  return {
    ok: response.ok && body?.ok === true && conflicts.length === 0,
    status: response.status,
    conflictCount: Number(body?.report?.conflictCount ?? conflicts.length),
    conflicts: conflicts.map((conflict) => conflict?.key).filter(Boolean),
  };
}

async function checkPerpsStatus(baseUrl) {
  const { response, body } = await fetchJson(`${baseUrl}/api/status`);
  const sqlEnabled = Boolean(body?.sql?.enabled);
  const sqlHealthy = body?.sql?.healthy !== false;
  const controlPlane = body?.controlPlane || {};
  const sqlControlPlaneRequired = sqlEnabled && sqlHealthy;
  return {
    ok: response.ok
      && body?.liveExecutionEnabled === false
      && Boolean(body?.sql)
      && (!sqlControlPlaneRequired || controlPlane.source === 'sql'),
    status: response.status,
    sqlHealthy,
    liveExecutionEnabled: Boolean(body?.liveExecutionEnabled),
    controlPlaneSource: controlPlane.source || null,
    controlPlaneReason: controlPlane.reason || null,
  };
}

async function checkPerpsReadiness(baseUrl) {
  const { response, body } = await fetchJson(`${baseUrl}/api/live-readiness`);
  const gates = Array.isArray(body?.gates) ? body.gates : [];
  const gateByName = new Map(gates.map((gate) => [gate?.gate, gate]));
  const requiredClearGates = [
    'perps_kill_switch_clear',
    'perps_safe_mode_clear',
    'live_order_dry_run_validated',
    'live_cancel_reconcile_dry_run_validated',
    'live_execution_adapter_contract_validated',
    'live_emergency_flatten_dry_run_validated',
    'live_exchange_reconciliation_dry_run_validated',
    'live_user_data_reconciliation_policy_validated',
    'live_symbol_filters_dry_run_validated',
    'live_leverage_brackets_dry_run_validated',
    'live_funding_drag_dry_run_validated',
    'live_signed_request_dry_run_validated',
    'live_margin_leverage_dry_run_validated',
    'live_position_mode_dry_run_validated',
    'live_user_data_stream_dry_run_validated',
    'live_user_data_event_normalization_validated',
    'live_user_data_lifecycle_policy_validated',
    'live_user_data_stream_health_policy_validated',
    'live_user_data_stream_client_validated',
    'live_canary_rollout_policy_validated',
    'live_user_data_lifecycle_mapping_validated',
  ];
  const missingGates = requiredClearGates.filter((gate) => !gateByName.has(gate));
  const failedGates = requiredClearGates.filter((gate) => gateByName.has(gate) && gateByName.get(gate)?.passed !== true);
  return {
    ok: response.ok
      && body?.liveExecutionEnabled === false
      && body?.liveReady === false
      && Array.isArray(body?.gates)
      && missingGates.length === 0
      && failedGates.length === 0,
    status: response.status,
    operatorReviewEligible: Boolean(body?.operatorReviewEligible),
    liveReady: Boolean(body?.liveReady),
    gateCount: gates.length,
    requiredClearGates,
    missingGates,
    failedGates,
  };
}

async function checkPerpsLiveCanaryPolicy(baseUrl, token) {
  if (!token) {
    return {
      ok: true,
      skipped: 'admin_token_unavailable',
      status: null,
      blockedReasons: [],
    };
  }
  const { response, body } = await fetchJson(`${baseUrl}/api/live-canary-policy/evaluate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token,
    },
    body: JSON.stringify({
      stage: 'tiny_canary',
      submitMode: 'tiny_live_canary',
      liveExecutionEnabled: true,
      operatorApproved: true,
      symbol: 'DOGEUSDT',
      notionalUsd: 100,
      leverage: 10,
    }),
  });
  const reasons = Array.isArray(body?.policy?.reasons) ? body.policy.reasons : [];
  const requiredBlockReasons = [
    'symbol_not_allowed_for_canary',
    'canary_notional_above_limit',
    'canary_leverage_above_limit',
  ];
  const missingReasons = requiredBlockReasons.filter((reason) => !reasons.includes(reason));
  return {
    ok: response.ok
      && body?.ok === true
      && body?.liveExecutionEnabled === false
      && body?.policy?.ok === false
      && body?.audit?.attempted === true
      && body?.audit?.recorded === true
      && missingReasons.length === 0,
    status: response.status,
    blockedReasons: reasons,
    missingReasons,
    audit: body?.audit || null,
    policyEvaluationId: body?.policyEvaluationId || null,
    maxCanaryNotionalUsd: body?.policy?.limits?.maxCanaryNotionalUsd,
    maxCanaryLeverage: body?.policy?.limits?.maxCanaryLeverage,
  };
}

function summarizeRow(profile, result) {
  return {
    profile,
    health: result.health.ok,
    metrics: result.metrics.ok,
    pm2Ownership: result.pm2Ownership?.skipped || (result.pm2Ownership ? result.pm2Ownership.ok : undefined),
    configProvenance: result.configProvenance?.skipped || (result.configProvenance ? result.configProvenance.ok : false),
    configSourceAudit: result.configSourceAudit?.skipped || (result.configSourceAudit ? result.configSourceAudit.ok : undefined),
    sqlHealthy: result.health.sqlHealthy,
    report: result.report ? result.report.ok : undefined,
    perpsStatus: result.perpsStatus ? result.perpsStatus.ok : undefined,
    perpsControlPlane: result.perpsStatus?.controlPlaneSource,
    perpsReadiness: result.perpsReadiness ? result.perpsReadiness.ok : undefined,
    perpsCanaryPolicy: result.perpsCanaryPolicy?.skipped || (result.perpsCanaryPolicy ? result.perpsCanaryPolicy.ok : undefined),
    perpsSqlRestore: result.perpsSqlRestore ? result.perpsSqlRestore.ok : undefined,
    configParity: result.configParity ? (result.configParity.skipped || result.configParity.ok) : undefined,
    degraded: result.health.degraded,
    uptimeSeconds: result.health.uptimeSeconds,
  };
}

async function checkProfile(profile) {
  const env = loadEnv(PLATFORM_ROOTS[profile]);
  const port = getPort(profile);
  const baseUrl = `http://127.0.0.1:${port}`;
  const result = {
    profile,
    baseUrl,
    health: await checkHealth(profile, baseUrl),
    metrics: await checkMetrics(baseUrl, profile),
  };
  result.pm2Ownership = checkPm2Ownership(profile, port);
  result.configProvenance = await checkConfigProvenance(baseUrl, getAdminToken(profile, env));
  result.configSourceAudit = await checkConfigSourceAudit(baseUrl, getAdminToken(profile, env));
  if (profile === 'perps') {
    result.perpsStatus = await checkPerpsStatus(baseUrl);
    result.perpsReadiness = await checkPerpsReadiness(baseUrl);
    result.perpsCanaryPolicy = await checkPerpsLiveCanaryPolicy(baseUrl, getAdminToken(profile, env));
    result.perpsSqlRestore = checkPerpsSqlRestoreStatus(result.health.sqlRestore);
  } else {
    result.report = await checkSpotSqlReport(baseUrl, getAdminToken(profile, env));
  }
  result.ok = result.health.ok
    && result.metrics.ok
    && (result.pm2Ownership ? result.pm2Ownership.ok : true)
    && result.configProvenance.ok
    && (result.configSourceAudit ? result.configSourceAudit.ok : true)
    && (result.report ? result.report.ok : true)
    && (result.perpsStatus ? result.perpsStatus.ok : true)
    && (result.perpsReadiness ? result.perpsReadiness.ok : true)
    && (result.perpsCanaryPolicy ? result.perpsCanaryPolicy.ok : true)
    && (result.perpsSqlRestore ? result.perpsSqlRestore.ok : true);
  return result;
}

async function main() {
  const profiles = ['live', 'paper', 'perps'];
  const results = [];
  for (const profile of profiles) {
    try {
      results.push(await checkProfile(profile));
    } catch (error) {
      results.push({
        profile,
        ok: false,
        error: error.message,
        health: { ok: false, sqlHealthy: false, degraded: true, uptimeSeconds: 0 },
        metrics: { ok: false },
        configProvenance: { ok: false },
      });
    }
  }

  const configParity = checkConfigParity(results);
  const platformResult = {
    profile: 'platform',
    ok: configParity.ok,
    health: { ok: true, sqlHealthy: true, degraded: false, uptimeSeconds: null },
    metrics: { ok: true },
    configProvenance: { ok: true },
    configParity,
  };

  const summary = [...results, platformResult].map((result) => summarizeRow(result.profile, result));
  console.table(summary);
  const failures = results.filter((result) => !result.ok);
  if (!configParity.ok) failures.push(platformResult);
  if (failures.length) {
    console.error(JSON.stringify(failures.map((failure) => ({
      profile: failure.profile,
      error: failure.error,
      health: failure.health,
      metrics: failure.metrics,
      pm2Ownership: failure.pm2Ownership,
      configProvenance: failure.configProvenance,
      configSourceAudit: failure.configSourceAudit,
      report: failure.report,
      perpsStatus: failure.perpsStatus,
      perpsReadiness: failure.perpsReadiness,
      perpsCanaryPolicy: failure.perpsCanaryPolicy,
      perpsSqlRestore: failure.perpsSqlRestore,
      configParity: failure.configParity,
    })), null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_V2_SECTIONS,
  checkHealth,
  checkMetrics,
  checkSpotSqlReport,
  checkConfigProvenance,
  checkConfigSourceAudit,
  checkConfigParity,
  checkPm2Ownership,
  checkPerpsStatus,
  checkPerpsReadiness,
  checkPerpsLiveCanaryPolicy,
  checkPerpsSqlRestoreStatus,
};
