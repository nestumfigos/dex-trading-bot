'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID, timingSafeEqual } = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('./utils/logger');
const { enforceRollingWindow, searchArchive, MAX_SIGNALS } = require('./utils/signals-archive');
const { redactObject, redactSecretsInText } = require('./utils/redaction');
const { getPool, ensureSchema, sql } = require('./utils/sqlServer');
const { runRegimeAwareMonteCarlo } = require('./utils/backtest-utils');
const { getImplementedStrategyNames } = require('./strategies/deployment');
const {
  buildConfigProvenance,
  renderPrometheusMetrics,
  buildBotHealthMetrics,
  normalizeBotProfile,
} = require('../packages/core');
const { KNOBS } = require('./config/schema');
const configSourceAudit = require('./config/source-audit');

function roundMetric(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function normalizeV2RiskEnforcementMode(value) {
  const mode = String(value || 'advisory').trim().toLowerCase();
  if (mode === 'enforce') return 'block_core';
  return mode === 'block_core' ? mode : 'advisory';
}

function parseCsvValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeParseObject(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTradeHistoryEntry(entry = {}) {
  const timestamp = toIsoOrNull(entry.timestamp || entry.ts || entry.closedAt || entry.openedAt);
  return {
    ...entry,
    type: entry.type ? String(entry.type).toUpperCase() : undefined,
    chainKey: entry.chainKey || entry.chain_key || null,
    valueUsd: toNumberOrNull(entry.valueUsd ?? entry.value_usd ?? entry.filledValueUsd),
    pnl: toNumberOrNull(entry.pnl ?? entry.pnl_usd ?? entry.realizedPnl),
    price: toNumberOrNull(entry.price),
    quantity: toNumberOrNull(entry.quantity),
    signalSource: entry.signalSource || entry.signal_source || null,
    setupType: entry.setupType || entry.setup_type || null,
    timestamp,
  };
}

function normalizeTradeLedgerRow(row = {}) {
  const raw = safeParseObject(row.raw_trade_json);
  return normalizeTradeHistoryEntry({
    ...raw,
    tradeId: row.trade_id || raw.tradeId || raw.trade_id || null,
    botProfile: row.bot_profile || raw.botProfile || raw.bot_profile || null,
    timestamp: row.ts || raw.timestamp || raw.ts,
    type: row.trade_type || raw.type,
    symbol: row.symbol ?? raw.symbol,
    chain: row.chain ?? raw.chain,
    chainKey: row.chain_key ?? raw.chainKey,
    strategy: row.strategy ?? raw.strategy,
    address: row.address ?? raw.address,
    price: row.price ?? raw.price,
    quantity: row.quantity ?? raw.quantity,
    valueUsd: row.value_usd ?? raw.valueUsd,
    pnl: row.pnl_usd ?? raw.pnl,
    txid: row.txid ?? raw.txid,
    signalSource: row.signal_source ?? raw.signalSource,
    reason: row.reason ?? raw.reason,
    setupType: row.setup_type ?? raw.setupType,
  });
}

function buildTradeProfileAliases(profileValue, paperTrading) {
  const raw = String(profileValue || process.env.BOT_PROFILE || (paperTrading ? 'paper_spot' : 'live_spot')).trim().toLowerCase();
  const normalized = normalizeBotProfile(raw);
  const aliases = new Set([normalized, raw]);

  if (normalized === 'live_spot' || raw === 'live') {
    aliases.add('live');
    aliases.add('live_spot');
  }
  if (normalized === 'paper_spot' || raw === 'paper') {
    aliases.add('paper');
    aliases.add('paper_spot');
  }

  return [...aliases].filter(Boolean);
}

function tradeHistoryKey(trade = {}) {
  const txid = String(trade.txid || '').trim();
  if (txid) return `tx:${txid}`;

  const timestamp = trade.timestamp || trade.closedAt || trade.openedAt || '';
  const side = trade.type || trade.side || '';
  const symbol = trade.symbol || '';
  const value = trade.valueUsd ?? trade.value_usd ?? trade.notionalUsd ?? '';
  const pnl = trade.pnl ?? trade.pnlUsd ?? trade.realizedPnl ?? '';
  if (timestamp || side || symbol || value || pnl) {
    return `logical:${timestamp}:${side}:${symbol}:${value}:${pnl}`;
  }

  return String(trade.tradeId || trade.trade_id || Math.random());
}

function mergeTradeHistory(runtimeTrades = [], sqlTrades = [], limit = 250) {
  const merged = [];
  const seen = new Set();
  for (const trade of [...sqlTrades, ...runtimeTrades]) {
    if (!trade || typeof trade !== 'object') continue;
    const normalized = normalizeTradeHistoryEntry(trade);
    const key = tradeHistoryKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged
    .sort((left, right) => {
      const lt = Date.parse(left.timestamp || left.closedAt || left.openedAt || 0) || 0;
      const rt = Date.parse(right.timestamp || right.closedAt || right.openedAt || 0) || 0;
      return rt - lt;
    })
    .slice(0, limit);
}

function filterTradeHistoryByWindow(trades = [], windowHours = null, nowMs = Date.now()) {
  const hours = Number(windowHours);
  if (!Number.isFinite(hours) || hours <= 0) return Array.isArray(trades) ? trades : [];
  const cutoffMs = Number(nowMs) - (hours * 60 * 60 * 1000);
  return (Array.isArray(trades) ? trades : []).filter((trade) => {
    const timestampMs = Date.parse(trade?.timestamp || trade?.closedAt || trade?.openedAt || '');
    return Number.isFinite(timestampMs) && timestampMs >= cutoffMs && timestampMs <= Number(nowMs);
  });
}

async function loadSpotTradeHistoryFromSql({ profiles, limit, log = logger } = {}) {
  const safeProfiles = Array.isArray(profiles) ? profiles.filter(Boolean).slice(0, 8) : [];
  if (safeProfiles.length === 0) return [];
  const pool = await getPool(log);
  if (!pool) return [];
  await ensureSchema(log);

  const req = pool.request();
  req.input('limit', sql.Int, limit);
  const params = safeProfiles.map((profile, index) => {
    const name = `profile${index}`;
    req.input(name, sql.NVarChar(20), String(profile).slice(0, 20));
    return `@${name}`;
  });

  const result = await req.query(`
    SELECT TOP (@limit)
      trade_id, bot_profile, ts, trade_type, symbol, chain, chain_key, strategy,
      address, price, quantity, value_usd, pnl_usd, txid, signal_source, reason,
      setup_type, raw_trade_json
    FROM dbo.bot_trade_ledger
    WHERE bot_profile IN (${params.join(', ')})
    ORDER BY ts DESC
  `);
  return (result.recordset || []).map(normalizeTradeLedgerRow);
}

function requestJson(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(parsedUrl, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

function computePerpsTradeStats(trades = []) {
  const closed = (Array.isArray(trades) ? trades : []).filter((trade) => trade?.closed !== false && Number.isFinite(Number(trade?.pnlUsd ?? trade?.pnl)));
  const pnlValues = closed.map((trade) => Number(trade.pnlUsd ?? trade.pnl));
  const wins = pnlValues.filter((value) => value > 0);
  const losses = pnlValues.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const pnlUsd = pnlValues.reduce((sum, value) => sum + value, 0);
  return {
    trades: closed.length,
    closed: closed.length,
    wins: wins.length,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    pnlUsd,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? null : 0),
    feesPaidUsd: closed.reduce((sum, trade) => sum + Number(trade.feeUsd || 0), 0),
    fundingPaidUsd: closed.reduce((sum, trade) => sum + Number(trade.fundingUsd || 0), 0),
    slippagePaidUsd: closed.reduce((sum, trade) => sum + Number(trade.slippageUsd || 0), 0),
    expectancyUsd: closed.length > 0 ? pnlUsd / closed.length : 0,
  };
}

function summarizeClosedSpotTrades(trades = []) {
  const rows = Array.isArray(trades) ? trades : [];
  const closed = rows.filter((trade) => {
    const type = String(trade?.type || trade?.trade_type || '').toUpperCase();
    return type === 'SELL' && Number.isFinite(Number(trade?.pnl ?? trade?.pnl_usd));
  });
  const pnlValues = closed.map((trade) => Number(trade.pnl ?? trade.pnl_usd));
  const wins = pnlValues.filter((value) => value > 0);
  const nonWins = pnlValues.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnlValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const realizedPnl = pnlValues.reduce((sum, value) => sum + value, 0);

  return {
    tradeRows: rows.length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: nonWins.length,
    winRate: closed.length > 0 ? roundMetric((wins.length / closed.length) * 100, 2) : null,
    winRatePct: closed.length > 0 ? roundMetric((wins.length / closed.length) * 100, 2) : null,
    grossProfit: roundMetric(grossProfit),
    grossLoss: roundMetric(grossLoss),
    realizedPnl: roundMetric(realizedPnl),
    totalPnl: roundMetric(realizedPnl),
    profitFactor: grossLoss > 0 ? roundMetric(grossProfit / grossLoss, 4) : (grossProfit > 0 ? null : 0),
    expectancyUsd: closed.length > 0 ? roundMetric(realizedPnl / closed.length) : 0,
    avgWinUsd: wins.length > 0 ? roundMetric(grossProfit / wins.length) : 0,
    avgLossUsd: nonWins.length > 0 ? roundMetric(grossLoss / nonWins.length) : 0,
  };
}

function buildGroupedSpotTradeSummaries(trades = [], keyFn = () => 'unknown') {
  const groups = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    const key = String(keyFn(trade) || 'unknown').trim().toLowerCase() || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, ...summarizeClosedSpotTrades(rows) }))
    .sort((left, right) => {
      if (right.closedTrades !== left.closedTrades) return right.closedTrades - left.closedTrades;
      return String(left.key).localeCompare(String(right.key));
    });
}

function buildSpotTradeMetrics(trades = []) {
  const normalized = (Array.isArray(trades) ? trades : []).map(normalizeTradeHistoryEntry);
  const summary = summarizeClosedSpotTrades(normalized);
  return {
    ...summary,
    byChain: buildGroupedSpotTradeSummaries(normalized, (trade) => trade.chainKey || trade.chain || 'unknown'),
    byStrategy: buildGroupedSpotTradeSummaries(normalized, (trade) => trade.strategy || trade.setupType || 'unknown'),
  };
}

function buildRiskEnforcementStatus() {
  const profile = normalizeBotProfile(process.env.BOT_PROFILE || (config.paperTrading ? 'paper' : 'live'));
  const mode = normalizeV2RiskEnforcementMode(
    config.risk?.v2RiskEnforcementMode || process.env.V2_RISK_ENFORCEMENT_MODE,
  );
  const enforceProfiles = parseCsvValues(
    config.risk?.v2RiskEnforceProfiles
    || process.env.V2_RISK_ENFORCE_PROFILES
    || process.env.V2_RISK_ENFORCEMENT_PROFILES,
  );
  const activeForProfile = enforceProfiles.length === 0
    || enforceProfiles.includes(profile)
    || enforceProfiles.includes(String(process.env.BOT_PROFILE || '').trim().toLowerCase());
  const v2AuditEnabled = String(process.env.V2_RISK_AUDIT_ENABLED || 'true').trim().toLowerCase() !== 'false';
  return [{
    bot_profile: profile,
    pre_trade_contract_mode: String(process.env.PRE_TRADE_CONTRACT_MODE || 'shadow').trim().toLowerCase(),
    v2_risk_audit_enabled: v2AuditEnabled,
    v2_risk_enforcement_mode: mode,
    v2_enforce_profiles: enforceProfiles.join(','),
    v2_enforcement_active_for_profile: v2AuditEnabled && mode !== 'advisory' && activeForProfile,
    v2_can_block_core_rejections: v2AuditEnabled && mode === 'block_core' && activeForProfile,
    advisory_only: !v2AuditEnabled || mode === 'advisory' || !activeForProfile,
  }];
}

function buildResearchAnalytics(tradeRows = [], decisionRows = []) {
  const sells = (Array.isArray(tradeRows) ? tradeRows : []).filter((row) => String(row.trade_type || '').toUpperCase() === 'SELL');
  const byProfile = new Map();
  for (const row of sells) {
    const key = String(row.bot_profile || 'unknown').toLowerCase();
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key).push(row);
  }

  const monteCarlo = [];
  const benchmark = [];

  for (const [botProfile, rows] of byProfile.entries()) {
    const tradePnls = rows.map((row) => Number(row.pnl_usd || 0)).filter((value) => Number.isFinite(value));
    const startingBalance = 100;
    const mc = runRegimeAwareMonteCarlo(startingBalance, rows.map((row) => ({ pnl: Number(row.pnl_usd || 0) })), [], 1000, 15);
    if (mc) {
      monteCarlo.push({
        bot_profile: botProfile,
        iterations: mc.iterations,
        method: mc.method,
        ruin_probability_pct: mc.ruinProbabilityPct,
        p10_ending_balance: mc.p10EndingBalance,
        p50_ending_balance: mc.p50EndingBalance,
        p90_ending_balance: mc.p90EndingBalance,
        streak_count: mc.streakCount,
      });
    }

    const grouped = {};
    for (const row of rows) {
      const strategy = String(row.strategy || 'unknown').toLowerCase();
      grouped[strategy] = grouped[strategy] || [];
      grouped[strategy].push(Number(row.pnl_usd || 0));
    }
    for (const [strategy, pnls] of Object.entries(grouped)) {
      const tradeCount = pnls.length;
      const totalPnl = pnls.reduce((sum, value) => sum + value, 0);
      const avgPnl = tradeCount > 0 ? totalPnl / tradeCount : 0;
      const wins = pnls.filter((value) => value > 0).length;
      const losses = pnls.filter((value) => value < 0).length;
      benchmark.push({
        bot_profile: botProfile,
        strategy,
        trade_count: tradeCount,
        win_rate_pct: tradeCount > 0 ? roundMetric((wins / tradeCount) * 100, 2) : 0,
        total_pnl_usd: roundMetric(totalPnl),
        avg_pnl_usd: roundMetric(avgPnl),
        profit_factor: losses > 0
          ? roundMetric(
            pnls.filter((value) => value > 0).reduce((sum, value) => sum + value, 0)
            / Math.abs(pnls.filter((value) => value < 0).reduce((sum, value) => sum + value, 0))
          , 3)
          : null,
      });
    }
  }

  const decisionBenchmark = (Array.isArray(decisionRows) ? decisionRows : []).reduce((acc, row) => {
    const key = `${String(row.bot_profile || 'unknown').toLowerCase()}:${String(row.strategy || 'unknown').toLowerCase()}`;
    if (!acc[key]) {
      acc[key] = {
        bot_profile: String(row.bot_profile || 'unknown').toLowerCase(),
        strategy: String(row.strategy || 'unknown').toLowerCase(),
        approvals: 0,
        buys: 0,
      };
    }
    acc[key].approvals += Number(row.approved ? 1 : 0);
    acc[key].buys += String(row.final_action || '').toUpperCase() === 'BUY' ? 1 : 0;
    return acc;
  }, {});

  return {
    monteCarlo,
    benchmark,
    decisionBenchmark: Object.values(decisionBenchmark),
  };
}

function buildRotationDebugPayload(ctx) {
  const trackedTokens = typeof ctx.getTrackedTokens === 'function' ? (ctx.getTrackedTokens() || []) : [];
  const openPositions = trackedTokens
    .filter((token) => token && token.hasOpenPosition)
    .map((token) => ({
      symbol: token.symbol,
      address: token.address,
      chain_key: token.chainKey,
      strategy: token.strategy,
      price_change_24h: token.priceChange24h,
      confidence: token?.indicators?.confidence ?? null,
      volume_spike: token?.indicators?.volumeSpike ?? null,
      buy_ratio_recent_pct: token?.indicators?.buyRatioRecentPct ?? null,
      net_buy_flow_usd_10m: token?.indicators?.netBuyFlowUsd10m ?? null,
      acceleration_score: token?.momentumState?.accelerationScore ?? null,
      consecutive_strong_scans: token?.momentumState?.consecutiveStrongScans ?? null,
      last_scanned_at: token.lastScannedAt || null,
    }))
    .sort((left, right) => String(left.symbol || '').localeCompare(String(right.symbol || '')));

  const blockedCandidates = trackedTokens
    .filter((token) => token && token.rotationContext && token.notBoughtReason)
    .map((token) => ({
      symbol: token.symbol,
      address: token.address,
      chain_key: token.chainKey,
      not_bought_reason: token.notBoughtReason,
      rotation_context: token.rotationContext,
      price_change_24h: token.priceChange24h,
      confidence: token?.indicators?.confidence ?? null,
      volume_spike: token?.indicators?.volumeSpike ?? null,
      acceleration_score: token?.momentumState?.accelerationScore ?? null,
      consecutive_strong_scans: token?.momentumState?.consecutiveStrongScans ?? null,
      last_scanned_at: token.lastScannedAt || null,
    }))
    .sort((left, right) => new Date(right.last_scanned_at || 0) - new Date(left.last_scanned_at || 0))
    .slice(0, 30);

  return {
    openPositions,
    blockedCandidates,
  };
}

function buildDashboardConfigProvenance() {
  const defaults = Object.entries(KNOBS).reduce((acc, [name, spec]) => {
    acc[name] = spec.default;
    return acc;
  }, {});
  return buildConfigProvenance({
    schema: KNOBS,
    defaults,
    env: process.env,
    pm2Env: process.env,
    dbOverrides: {},
  });
}

function buildDashboardConfigSourceAudit({ projectRoot = path.resolve(__dirname, '..'), profile = process.env.BOT_PROFILE } = {}) {
  const result = configSourceAudit.auditBoot({
    envPath: path.join(projectRoot, '.env'),
    ecoPath: path.join(projectRoot, 'ecosystem.config.js'),
    profile: String(profile || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase(),
    lenient: true,
    logger: { info() {}, warn() {} },
  });
  return {
    ok: result.conflicts.length === 0,
    profile: String(profile || '').toLowerCase(),
    envCount: Number(result.envCount || 0),
    ecoCount: Number(result.ecoCount || 0),
    conflictCount: result.conflicts.length,
    conflicts: result.conflicts.map((conflict) => ({
      key: conflict.key,
      severity: conflict.severity,
      note: conflict.note,
    })),
    onlyEnvCount: Array.isArray(result.onlyEnv) ? result.onlyEnv.length : 0,
    onlyEcoCount: Array.isArray(result.onlyEco) ? result.onlyEco.length : 0,
  };
}

function createBackgroundJobManager() {
  const jobs = new Map();
  let queue = Promise.resolve();

  function sanitizeJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      result: job.result,
    };
  }

  function enqueue(type, worker) {
    const job = {
      id: randomUUID(),
      type,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    };
    jobs.set(job.id, job);
    queue = queue
      .catch(() => {})
      .then(async () => {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        try {
          job.result = await worker();
          job.status = 'completed';
        } catch (error) {
          if (error?.code === 'INSUFFICIENT_HISTORY') {
            job.status = 'skipped_insufficient_history';
            job.error = error?.message || String(error);
            job.result = {
              skipped: true,
              reason: 'insufficient_history',
              missingHistoryCount: Number(error?.missingHistoryCount || 0),
              historyCoverage: error?.historyCoverage || null,
              tokenAddress: error?.tokenAddress || null,
              chainKey: error?.chainKey || null,
            };
          } else {
            job.status = 'failed';
            job.error = error?.message || String(error);
          }
        } finally {
          job.finishedAt = new Date().toISOString();
        }
      });
    return sanitizeJob(job);
  }

  function get(id) {
    return sanitizeJob(jobs.get(id));
  }

  function list(limit = 12) {
    return Array.from(jobs.values())
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
      .slice(0, Math.max(1, Number(limit || 12)))
      .map(sanitizeJob);
  }

  return { enqueue, get, list };
}

let app;

function getNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function sanitizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateNumericBounds(patch = {}, bounds = {}, label = 'config') {
  const errors = [];
  Object.entries(bounds).forEach(([key, range]) => {
    if (patch[key] === undefined) return;
    const value = Number(patch[key]);
    if (!Number.isFinite(value)) {
      errors.push(`${label}.${key} must be a finite number`);
      return;
    }
    if (value < range.min || value > range.max) {
      errors.push(`${label}.${key} out of bounds (${range.min}..${range.max})`);
    }
  });
  return errors;
}

function validateObjectShape(patch = {}, template = {}, label = 'config') {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return errors;
  }

  Object.keys(patch).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(template, key)) {
      errors.push(`${label}.${key} is not allowed`);
      return;
    }

    const value = patch[key];
    const expected = template[key];
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && expected
      && typeof expected === 'object'
      && !Array.isArray(expected)
    ) {
      errors.push(...validateObjectShape(value, expected, `${label}.${key}`));
    }
  });

  return errors;
}

function validateConfigPayloadSchema(payload = {}) {
  const schemaTemplate = {
    paperTrading: config.paperTrading,
    paperBalance: config.paperBalance,
    strategy: config.strategy,
    strategies: config.strategies,
    risk: config.risk,
    discovery: config.discovery,
    bot: config.bot,
    anthropic: config.anthropic,
  };

  return validateObjectShape(payload, schemaTemplate, 'config');
}

function startDashboard(portfolio, ctx) {
  app = express();
  // Week 6 API extensions (rejections, evolution-history, ai-decisions, symbol-overrides, health-canary, ml-models, backtest-runs).
  try {
    const { mountWeek6Routes } = require('./dashboard-extensions');
    const week6 = mountWeek6Routes(app, { getPool: () => getPool(logger).catch(() => null), logger });
    logger.info(`[dashboard] Week 6 endpoints mounted: ${week6.endpoints.length}`);
  } catch (e) {
    logger.warn(`[dashboard] Failed to mount Week 6 extensions: ${e.message}`);
  }
  const sqlReportCache = {
    byReport: {},
    lastRefreshAt: {},
    inFlight: {},
  };
  const backgroundJobs = createBackgroundJobManager();
  const scheduledResearchState = {
    lastNightlyKey: '',
    lastTriggeredAt: null,
  };

  async function runNightlyResearch(force = false) {
    if (typeof ctx.getResearchTargets !== 'function' || typeof ctx.runPositionResearchRequest !== 'function') {
      return { queued: 0, reason: 'research_unavailable' };
    }
    const now = new Date();
    const dailyKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    if (!force && scheduledResearchState.lastNightlyKey === dailyKey) {
      return { queued: 0, reason: 'already_ran' };
    }

    const targets = await Promise.resolve(ctx.getResearchTargets()).catch(() => []);
    const orderedTargets = (Array.isArray(targets) ? targets : []).sort((left, right) => {
      const leftOpen = left.source === 'open_position' ? 1 : 0;
      const rightOpen = right.source === 'open_position' ? 1 : 0;
      if (leftOpen !== rightOpen) return rightOpen - leftOpen;
      const leftReady = left.historyCoverage?.ok ? 1 : 0;
      const rightReady = right.historyCoverage?.ok ? 1 : 0;
      if (leftReady !== rightReady) return rightReady - leftReady;
      return Number(left.historyCoverage?.missingBars || 0) - Number(right.historyCoverage?.missingBars || 0);
    });
    const chosen = orderedTargets.slice(0, Math.max(1, Number(config.research?.nightlyMaxTargets || 3)));
    for (const target of chosen) {
      backgroundJobs.enqueue('nightly_research', () => ctx.runPositionResearchRequest({
        tokenAddress: target.address,
        chain: target.chainKey,
        strategy: target.strategy || 'momentum',
        source: 'nightly',
      }));
    }
    scheduledResearchState.lastNightlyKey = dailyKey;
    scheduledResearchState.lastTriggeredAt = new Date().toISOString();
    return { queued: chosen.length, reason: chosen.length ? 'queued' : 'no_targets' };
  }

  function shouldRunNightlyResearch() {
    const now = new Date();
    return (
      now.getUTCHours() === Number(config.research?.nightlyHourUtc || 2)
      && now.getUTCMinutes() >= Number(config.research?.nightlyMinuteUtc || 15)
      && now.getUTCMinutes() < Number(config.research?.nightlyMinuteUtc || 15) + 10
    );
  }

  // Admin endpoint to clear tracked tokens/signals

  // Patch ctx to enforce rolling window for recentSignals
  if (ctx && ctx.market && Array.isArray(ctx.market.recentSignals)) {
    // Enforce rolling window immediately on startup (in case loaded from disk with too many signals)
    if (ctx.market.recentSignals.length > MAX_SIGNALS) {
      ctx.market.recentSignals = ctx.market.recentSignals.slice(-MAX_SIGNALS);
    }
    // Patch push to always enforce rolling window
    const origPush = ctx.market.recentSignals.push.bind(ctx.market.recentSignals);
    ctx.market.recentSignals.push = function (...args) {
      for (const signal of args) {
        enforceRollingWindow(ctx.market.recentSignals, signal);
      }
      return ctx.market.recentSignals.length;
    };
  }
  // Archive search endpoint
  app.get('/api/signals/archive-search', (req, res) => {
    const { symbol, from, to, signal } = req.query;
    searchArchive({ symbol, from, to, signal }, (err, results) => {
      if (err) {
        logger.error('Archive search error:', err);
        return res.status(500).json({ error: 'Archive search failed' });
      }
      res.json({ results });
    });
  });

  // --- AI Provider Health (B.2) ---
  // Combined per-provider snapshot: enabled, hasKey, backoffUntil, quota, circuit, status text.
  app.get('/api/ai-health', (req, res) => {
    try {
      const ensemble = require('./ai/ensemble');
      const stats = ensemble.getQuotaStats ? ensemble.getQuotaStats() : {};
      const anyEnabled = typeof ensemble.hasAnyEnabledProvider === 'function'
        ? ensemble.hasAnyEnabledProvider()
        : false;
      let anthropicBackoff = null;
      try {
        const brain = require('./utils/anthropic');
        if (typeof brain.getBackoffStatus === 'function') anthropicBackoff = brain.getBackoffStatus();
      } catch (_) {}
      const now = Date.now();
      const aiCircuit = (typeof ctx.getAiCircuitState === 'function') ? ctx.getAiCircuitState() : null;
      const providerHealth = stats.providerHealth || {};
      const provider = (cfg, name, extraBackoff) => {
        const enabled = name === 'anthropic' ? !!cfg?.enabled : (cfg?.enabled !== false);
        const hasKey = !!(cfg?.apiKey || process.env[`${name.toUpperCase()}_API_KEY`]);
        const ph = providerHealth[name] || null;
        const onBackoff = (extraBackoff && extraBackoff.backoffSecondsRemaining > 0)
          || (ph && ph.backoffSecondsRemaining > 0);
        let status = 'offline';
        if (!enabled) status = 'disabled_by_config';
        else if (!hasKey) status = 'no_key';
        else if (onBackoff) status = 'backoff';
        else status = 'online';
        return {
          enabled, hasKey, status,
          ...(extraBackoff || {}),
          ...(cfg?.model ? { model: cfg.model } : {}),
          ...(ph ? { consecutiveFailures: ph.consecutiveFailures, maxConsecutiveFailures: ph.maxConsecutiveFailures, autoDisableBackoffMinutes: ph.autoDisableBackoffMinutes } : {}),
          ...(ph && ph.backoffUntil ? { providerBackoffUntil: ph.backoffUntil, providerBackoffSecondsRemaining: ph.backoffSecondsRemaining } : {}),
        };
      };
      const out = {
        timestamp: new Date(now).toISOString(),
        anyProviderEnabled: anyEnabled,
        circuit: aiCircuit ? {
          open: (aiCircuit.cooldownUntil || 0) > now,
          cooldownUntil: aiCircuit.cooldownUntil ? new Date(aiCircuit.cooldownUntil).toISOString() : null,
          secondsRemaining: aiCircuit.cooldownUntil > now ? Math.ceil((aiCircuit.cooldownUntil - now) / 1000) : 0,
          failures: aiCircuit.failures || 0,
        } : null,
        providers: {
          anthropic: provider(config.anthropic, 'anthropic', anthropicBackoff),
          groq: { ...provider(config.groq, 'groq'), quota: stats.groq, backoffUntil: stats.backoffUntil?.groq || null },
          gemini: { ...provider(config.gemini, 'gemini'), quota: stats.gemini, backoffUntil: stats.backoffUntil?.gemini || null },
          nvidia: provider(config.nvidia, 'nvidia'),
          cerebras: provider(config.cerebras, 'cerebras'),
          openrouter: provider(config.openrouter, 'openrouter'),
          sambanova: provider(config.sambanova, 'sambanova'),
          together: provider(config.together, 'together'),
        },
      };
      res.json(out);
    } catch (e) {
      logger.warn(`[ai-health] failed: ${e?.message || e}`);
      res.status(500).json({ error: 'ai-health failed' });
    }
  });

  // --- AI API Quota Endpoint (must be before static serving) ---
  // This must be registered BEFORE app.use(express.static(...))
  app.get('/api/ai-quota', (req, res) => {
    try {
      if (process.env.DEBUG_AI_QUOTA === 'true') {
        logger.debug('[AI-QUOTA DEBUG]', redactObject({
          anthropic: config.anthropic,
          groq: config.groq,
          gemini: config.gemini,
          sambanova: config.sambanova,
          together: config.together,
        }));
      }

      // Dynamically require to avoid circular deps
      const { getQuotaStats } = require('./ai/ensemble');
      const stats = getQuotaStats ? getQuotaStats() : {};
      res.json({
        nvidia: { status: 'Online', remaining: 'Unlimited (free tier)' },
        anthropic: {
          status: config.anthropic.enabled && config.anthropic.apiKey ? 'Online' : 'Offline',
          remaining: config.anthropic.enabled && config.anthropic.apiKey ? 'N/A' : '0',
        },
        groq: stats.groq ? {
          status: 'Online',
          remaining: `${stats.groq.limit - stats.groq.count} / ${stats.groq.limit}`,
          resetsAt: stats.groq.resetsAt,
          backoffUntil: stats.backoffUntil?.groq,
        } : { status: 'Offline', remaining: '0' },
        gemini: stats.gemini ? {
          status: 'Online',
          remaining: `${stats.gemini.limit - stats.gemini.count} / ${stats.gemini.limit}`,
          resetsAt: stats.gemini.resetsAt,
          backoffUntil: stats.backoffUntil?.gemini,
        } : { status: 'Offline', remaining: '0' },
        openai: { status: 'Offline', remaining: '0' },
      });
    } catch (e) {
      logger.warn(`AI quota endpoint fallback: ${redactSecretsInText(e?.message || String(e))}`);
      res.json({
        nvidia: { status: 'Online', remaining: 'Unlimited (free tier)' },
        anthropic: { status: 'Unknown', remaining: 'N/A' },
        groq: { status: 'Unknown', remaining: 'N/A' },
        gemini: { status: 'Unknown', remaining: 'N/A' },
        openai: { status: 'Offline', remaining: '0' },
      });
    }
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const publicDir = path.resolve(__dirname, '..', 'public');
  const adminToken = String(config.dashboard?.adminToken || '').trim();
  const riskBounds = {
    maxPositionSizePct: { min: 0, max: 100 },
    stopLossPct: { min: 0, max: 100 },
    takeProfitPct: { min: 0, max: 1000 },
    minLiquidityUsd: { min: 0, max: 1_000_000_000 },
    maxConcurrentPositions: { min: 1, max: 500 },
    dailyDrawdownLimitPct: { min: 0, max: 100 },
    maxTokenAgeHours: { min: 0, max: 8760 },
    maxBalanceDriftPct: { min: 0, max: 100 },
  };
  const botBounds = {
    momentumScanIntervalSeconds: { min: 5, max: 86400 },
    momentumExitCheckMinutes: { min: 1, max: 10080 },
    walletBalanceRefreshSeconds: { min: 5, max: 86400 },
    aiFailureThreshold: { min: 1, max: 1000 },
    exchangeFailureThreshold: { min: 1, max: 1000 },
  };
  const strategyBounds = {
    emaFast: { min: 1, max: 500 },
    emaSlow: { min: 2, max: 1000 },
    rsiPeriod: { min: 2, max: 200 },
    positionSizePct: { min: 0, max: 100 },
    stopLossPct: { min: 0, max: 100 },
    takeProfitPct: { min: 0, max: 1000 },
    maxConcurrentPositions: { min: 1, max: 500 },
  };

  // Constant-time credential comparison — avoids leaking the admin token /
  // webhook secret through response-timing differences. Length mismatch returns
  // false (timingSafeEqual throws on unequal-length buffers).
  function safeEqual(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function isLocalRequest(req) {
    const remote = String(req.ip || req.socket?.remoteAddress || '');
    return remote === '127.0.0.1' || remote === '::1' || remote.endsWith('::ffff:127.0.0.1');
  }

  function requireWriteAccess(req, res, next) {
    if (adminToken) {
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerToken = String(req.headers['x-admin-token'] || '').trim();
      const token = headerToken || bearer;
      if (!safeEqual(token, adminToken)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return next();
    }

    if (!isLocalRequest(req)) {
      return res.status(403).json({ error: 'Write endpoints require local access or DASHBOARD_ADMIN_TOKEN' });
    }

    return next();
  }

  function requireAdminToken(req, res, next) {
    if (adminToken) {
      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const headerToken = String(req.headers['x-admin-token'] || '').trim();
      const token = headerToken || bearer;
      if (!safeEqual(token, adminToken)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return next();
    }

    if (!isLocalRequest(req)) {
      return res.status(403).json({ error: 'Admin endpoints require local access or DASHBOARD_ADMIN_TOKEN' });
    }
    return next();
  }

  app.use(express.json({ limit: '1mb' }));

  // CORS for cross-port dashboard fetches (Week 7 sidebar dashboard hits
  // both 3001 paper + 3002 live from a single UI via bot-switcher dropdown).
  // Allow any origin since this is LAN-only; tighten via DASHBOARD_CORS_ORIGIN env if needed.
  const corsOrigin = process.env.DASHBOARD_CORS_ORIGIN || '*';
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use((req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
    next();
  });

  app.use(express.static(publicDir, {
    etag: false,
    setHeaders(res, filePath) {
      if (/\.(?:html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
      }
    },
  }));

  app.get('/api/status', (req, res) => {
    // B4.dash.4: surface fetchedAt so the UI can render "as of HH:MM:SS" and
    // operators can spot stale data. Inject at the response edge — does not
    // require touching ctx.getDashboardState.
    const state = ctx.getDashboardState({ compact: true });
    res.json({
      ...state,
      fetchedAt: new Date().toISOString(),
      fetchedAtEpochMs: Date.now(),
    });
  });

  app.get('/api/trades', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 250, 500);
    const metricLimit = parsePositiveInt(req.query.metricLimit, 5000, 10000);
    const windowHours = parsePositiveInt(req.query.windowHours, null, 8760);
    const profileAliases = buildTradeProfileAliases(req.query.profile, config.paperTrading);
    const state = ctx.getDashboardState({ compact: false });
    const portfolioState = state?.portfolio || {};
    const runtimeTrades = Array.isArray(portfolioState.trades)
      ? portfolioState.trades
      : (Array.isArray(portfolioState.recentTrades) ? portfolioState.recentTrades : []);

    let sqlTrades = [];
    let sqlError = null;
    try {
      sqlTrades = await loadSpotTradeHistoryFromSql({ profiles: profileAliases, limit: Math.max(limit, metricLimit), log: logger });
    } catch (error) {
      sqlError = error.message;
      logger.warn(`Trade history SQL fallback to runtime state: ${error.message}`);
    }

    const mergedTrades = mergeTradeHistory(runtimeTrades, sqlTrades, Math.max(limit, metricLimit));
    const allTrades = filterTradeHistoryByWindow(mergedTrades, windowHours);
    const trades = allTrades.slice(0, limit);
    const metrics = buildSpotTradeMetrics(allTrades);
    res.json({
      ok: true,
      mode: state?.mode || (config.paperTrading ? 'paper' : 'live'),
      profiles: profileAliases,
      count: trades.length,
      source: sqlTrades.length > 0 ? 'sql_runtime_merged' : 'runtime',
      metricScope: windowHours ? `rolling_${windowHours}h` : 'merged_available_history',
      window: windowHours ? {
        hours: windowHours,
        from: new Date(Date.now() - (windowHours * 60 * 60 * 1000)).toISOString(),
        to: new Date().toISOString(),
      } : null,
      sqlBacked: sqlTrades.length > 0,
      sqlError,
      summary: metrics,
      byChain: metrics.byChain,
      byStrategy: metrics.byStrategy,
      trades,
    });
  });

  app.get('/api/perps/trades', async (req, res) => {
    const limit = parsePositiveInt(req.query.limit, 250, 500);
    const baseUrl = String(
      process.env.PERPS_DASHBOARD_URL
      || process.env.PERPS_API_URL
      || `http://127.0.0.1:${process.env.PERPS_DASHBOARD_PORT || process.env.PERPS_PORT || 3004}`
    ).replace(/\/+$/, '');

    const [tradePayload, statsPayload] = await Promise.all([
      requestJson(`${baseUrl}/api/trades`, 5000),
      requestJson(`${baseUrl}/api/stats`, 5000),
    ]);

    const trades = Array.isArray(tradePayload?.trades)
      ? tradePayload.trades
      : (Array.isArray(tradePayload) ? tradePayload : []);
    const visibleTrades = trades.slice(0, limit);
    const stats = statsPayload?.stats || computePerpsTradeStats(trades);

    res.json({
      ok: Boolean(tradePayload),
      mode: tradePayload?.mode || statsPayload?.mode || 'perps-paper',
      source: tradePayload ? 'perps_api' : 'unavailable',
      historyError: tradePayload ? null : 'Perps trade API unavailable',
      count: visibleTrades.length,
      totalCount: trades.length,
      stats,
      trades: visibleTrades,
      excludedNonPerpsTrades: tradePayload?.excludedNonPerpsTrades || stats?.excludedNonPerpsTrades || 0,
    });
  });

  app.get('/health', (req, res) => {
    const health = typeof ctx.getHealthStatus === 'function'
      ? ctx.getHealthStatus()
      : { ok: true, timestamp: new Date().toISOString() };

    return res.status(health.ok ? 200 : 503).json(health);
  });

  app.get('/metrics', (req, res) => {
    const health = typeof ctx.getHealthStatus === 'function'
      ? ctx.getHealthStatus()
      : { ok: true, timestamp: new Date().toISOString() };
    const botProfile = normalizeBotProfile(process.env.BOT_PROFILE || (config.paperTrading ? 'paper_spot' : 'live_spot'));
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(renderPrometheusMetrics(buildBotHealthMetrics({
      botProfile,
      health,
      extra: {
        live_execution_enabled: !config.paperTrading,
        safe_mode: Boolean(health.safeMode),
        signal_drought_global: Boolean(health.signalDrought?.global),
      },
    })));
  });

  app.get('/api/health-lite', (req, res) => {
    const health = typeof ctx.getHealthStatus === 'function'
      ? ctx.getHealthStatus()
      : { ok: true, timestamp: new Date().toISOString() };

    const lite = {
      ok: health.ok,
      degraded: Boolean(health.degraded),
      degradedReasons: Array.isArray(health.degradedReasons) ? health.degradedReasons : [],
      unhealthyReasons: Array.isArray(health.unhealthyReasons) ? health.unhealthyReasons : [],
      timestamp: health.timestamp,
      uptimeSeconds: Number(health.uptimeSeconds || 0),
      totalRuntimeSeconds: Number(health.totalRuntimeSeconds || 0),
      scanInFlight: Boolean(health.scanInFlight),
    };

    return res.status(lite.ok ? 200 : 503).json(lite);
  });

  app.get('/api/config', (req, res) => {
    res.json({
      paperTrading: config.paperTrading,
      paperBalance: config.paperBalance,
      strategy: config.strategy,
      strategies: config.strategies,
      discovery: config.discovery,
      risk: config.risk,
      bot: config.bot,
      anthropic: {
        enabled: config.anthropic.enabled,
        model: config.anthropic.model,
        temperature: config.anthropic.temperature,
        hasApiKey: Boolean(config.anthropic.apiKey),
      },
    });
  });

  app.get('/api/config-provenance', requireAdminToken, (req, res) => {
    res.json({
      ok: true,
      report: buildDashboardConfigProvenance(),
    });
  });

  app.get('/api/config-source-audit', requireAdminToken, (req, res) => {
    const report = buildDashboardConfigSourceAudit({
      projectRoot: ctx.projectRoot || path.resolve(__dirname, '..'),
      profile: process.env.BOT_PROFILE || (config.paperTrading ? 'paper' : 'live'),
    });
    res.status(report.ok ? 200 : 409).json({ ok: report.ok, report });
  });

  app.post('/api/config', requireWriteAccess, (req, res) => {
    const payload = req.body || {};
    const validationErrors = validateConfigPayloadSchema(payload);

    if (payload.risk && typeof payload.risk === 'object') {
      validationErrors.push(...validateNumericBounds(payload.risk, riskBounds, 'risk'));
    }
    if (payload.bot && typeof payload.bot === 'object') {
      validationErrors.push(...validateNumericBounds(payload.bot, botBounds, 'bot'));
    }
    if (payload.strategy && typeof payload.strategy === 'object') {
      validationErrors.push(...validateNumericBounds(payload.strategy, strategyBounds, 'strategy'));
    }
    if (payload.strategies && typeof payload.strategies === 'object') {
      Object.keys(payload.strategies).forEach((name) => {
        if (config.strategies?.[name] && payload.strategies[name] && typeof payload.strategies[name] === 'object') {
          validationErrors.push(...validateNumericBounds(payload.strategies[name], strategyBounds, `strategies.${name}`));
        }
      });
    }

    if (validationErrors.length) {
      return res.status(400).json({ error: 'Invalid config payload', details: validationErrors });
    }

    if (typeof payload.paperTrading === 'boolean') {
      config.paperTrading = payload.paperTrading;
    }

    if (payload.paperBalance !== undefined) {
      config.paperBalance = sanitizeNumber(payload.paperBalance, config.paperBalance);
    }

    if (payload.strategy && typeof payload.strategy === 'object') {
      Object.assign(config.strategy, payload.strategy);
    }

    if (payload.strategies && typeof payload.strategies === 'object') {
      Object.keys(payload.strategies).forEach((name) => {
        if (config.strategies?.[name] && payload.strategies[name] && typeof payload.strategies[name] === 'object') {
          Object.assign(config.strategies[name], payload.strategies[name]);
        }
      });
    }

    if (payload.risk && typeof payload.risk === 'object') {
      Object.assign(config.risk, payload.risk);
    }

    if (payload.discovery && typeof payload.discovery === 'object') {
      Object.assign(config.discovery, payload.discovery);
    }

    if (payload.bot && typeof payload.bot === 'object') {
      Object.assign(config.bot, payload.bot);
    }

    if (payload.anthropic && typeof payload.anthropic === 'object') {
      Object.assign(config.anthropic, payload.anthropic);
    }

    if (ctx.onConfigUpdated) {
      ctx.onConfigUpdated({
        scanIntervalSeconds: sanitizeNumber(config.bot.scanIntervalSeconds, 30),
      });
    }

    res.json({
      success: true,
      config: {
        paperTrading: config.paperTrading,
        paperBalance: config.paperBalance,
        strategy: config.strategy,
        strategies: config.strategies,
        discovery: config.discovery,
        risk: config.risk,
        bot: config.bot,
        anthropic: {
          enabled: config.anthropic.enabled,
          model: config.anthropic.model,
          temperature: config.anthropic.temperature,
          hasApiKey: Boolean(config.anthropic.apiKey),
        },
      },
    });
  });

  app.get('/api/tracked-tokens', (req, res) => {
    const tokens = ctx.getTrackedTokens()
      .filter((token) => !['backes', 'swing', 'backes_swing'].includes(String(token?.strategy || '').toLowerCase()));
    res.json({ tokens });
  });

  // ─── Logs tail ─────────────────────────────────────────────────────────
  // GET /api/logs/tail?lines=200
  app.get('/api/logs/tail', async (req, res) => {
    try {
      const fsp = require('fs').promises;
      const fs = require('fs');
      const pathMod = require('path');
      const lines = Math.min(2000, Math.max(10, Number(req.query.lines) || 200));
      const logsDir = pathMod.resolve(__dirname, '..', 'logs');
      const files = (await fsp.readdir(logsDir).catch(() => []))
        .filter((f) => /^combined-.*\.log$/.test(f))
        .map((f) => ({ name: f, mtime: fs.statSync(pathMod.join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length === 0) { res.json({ ok: false, error: 'no log files found', lines: [] }); return; }
      const target = pathMod.join(logsDir, files[0].name);
      const stat = fs.statSync(target);
      // Read last ~256KB for safety
      const readSize = Math.min(stat.size, 256 * 1024);
      const fd = fs.openSync(target, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const all = buf.toString('utf8').split('\n').filter(Boolean);
      const tail = all.slice(-lines);
      res.json({ ok: true, file: files[0].name, totalBytes: stat.size, returned: tail.length, lines: tail });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ─── Force-sell a position from dashboard ────────────────────────────
  // POST /api/admin/sell-position  { key: 'kucoin:abc/usdt' }
  app.post('/api/admin/sell-position', requireAdminToken, async (req, res) => {
    if (typeof ctx.forceSellPosition !== 'function') {
      res.status(503).json({ ok: false, error: 'forceSellPosition not exposed in ctx (needs index.js wire-up)' });
      return;
    }
    const key = String(req.body?.key || '').trim();
    if (!key) { res.status(400).json({ ok: false, error: 'key required' }); return; }
    try {
      const result = await ctx.forceSellPosition(key, 'DASHBOARD_MANUAL');
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // ─── OHLCV proxy (Binance Spot) ───────────────────────────────────────
  // GET /api/ohlcv?symbol=BTCUSDT&interval=5m&limit=200
  // Cached 30s per (symbol, interval, limit) to keep within Binance free tier.
  const OHLCV_CACHE = new Map();
  const OHLCV_TTL_MS = 30_000;
  app.get('/api/ohlcv', async (req, res) => {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const interval = String(req.query.interval || '5m');
    const limit = Math.min(500, Math.max(20, Number(req.query.limit) || 200));
    const key = `${symbol}:${interval}:${limit}`;
    const cached = OHLCV_CACHE.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      res.json({ ok: true, cached: true, symbol, interval, candles: cached.value });
      return;
    }
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const axios = require('axios');
      const r = await axios.get(url, { timeout: 7000 });
      const candles = (r.data || []).map((k) => ({
        time:   Math.floor(k[0] / 1000),
        open:   Number(k[1]),
        high:   Number(k[2]),
        low:    Number(k[3]),
        close:  Number(k[4]),
        volume: Number(k[5]),
      }));
      OHLCV_CACHE.set(key, { value: candles, expiresAt: Date.now() + OHLCV_TTL_MS });
      res.json({ ok: true, cached: false, symbol, interval, candles });
    } catch (err) {
      res.status(502).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ─── Market Indicators (aggregated external APIs) ────────────────────
  // Per-source cache TTLs (CoinGecko free tier is aggressive; cache 10min).
  let MI_CACHE = { value: null, expiresAt: 0 };
  const MI_PER_SOURCE = { fearGreed: 0, coingecko: 0, btcFunding: 0, btcOpenInterest: 0 };
  const MI_TTL = { fearGreed: 5 * 60_000, coingecko: 10 * 60_000, btcFunding: 60_000, btcOpenInterest: 60_000 };
  const MI_AGG_TTL_MS = 30_000; // aggregated response cache
  app.get('/api/market-indicators', async (req, res) => {
    if (MI_CACHE.value && Date.now() < MI_CACHE.expiresAt) {
      res.json({ ok: true, cached: true, data: MI_CACHE.value });
      return;
    }
    const axios = require('axios');
    const out = {
      fearGreed:        { value: null, label: null, error: null },
      btcDominance:     { value: null, change24h: null, error: null },
      marketCap:        { value: null, change24h: null, error: null },
      totalVolume:      { value: null, change24h: null, error: null },
      btcFunding:       { value: null, error: null },
      btcOpenInterest:  { value: null, error: null },
      altseason:        { value: null, label: null, error: null, source: 'derived' },
    };

    const tasks = [
      // Fear & Greed Index — alternative.me
      axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 7000 })
        .then((r) => {
          const item = r.data?.data?.[0];
          if (item) { out.fearGreed.value = Number(item.value); out.fearGreed.label = item.value_classification; }
        })
        .catch((e) => { out.fearGreed.error = e.message; }),
      // CoinPaprika global: BTC dominance + market cap + total volume.
      // Free tier, no key, no aggressive Cloudflare. CoinGecko's free tier
      // returns 429 even from server with browser-like UA, so this is the
      // pragmatic primary source.
      axios.get('https://api.coinpaprika.com/v1/global', { timeout: 7000 })
        .then((r) => {
          const d = r.data || {};
          out.btcDominance.value = Number(d.bitcoin_dominance_percentage);
          out.btcDominance.change24h = Number(d.market_cap_change_24h);
          out.marketCap.value = Number(d.market_cap_usd);
          out.marketCap.change24h = Number(d.market_cap_change_24h);
          out.totalVolume.value = Number(d.volume_24h_usd);
          out.totalVolume.change24h = Number(d.volume_24h_change_24h);
          if (Number.isFinite(out.btcDominance.value)) {
            out.altseason.value = Math.round((100 - out.btcDominance.value) * 1.3);
            out.altseason.label = out.altseason.value > 75 ? 'Altcoin Season'
              : out.altseason.value > 50 ? 'Mixed'
              : 'Bitcoin Season';
          }
        })
        .catch((e) => { out.btcDominance.error = e.message; out.marketCap.error = e.message; out.totalVolume.error = e.message; }),
      // BTC funding rate — Binance Futures
      axios.get('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { timeout: 7000 })
        .then((r) => { out.btcFunding.value = Number(r.data?.lastFundingRate); })
        .catch((e) => { out.btcFunding.error = e.message; }),
      // BTC open interest — Binance Futures
      axios.get('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT', { timeout: 7000 })
        .then((r) => { out.btcOpenInterest.value = Number(r.data?.openInterest); })
        .catch((e) => { out.btcOpenInterest.error = e.message; }),
    ];

    await Promise.allSettled(tasks);
    // Merge with prior MI_CACHE so per-source 429s don't blank prior values.
    const merged = MI_CACHE.value ? { ...MI_CACHE.value } : {};
    for (const k of Object.keys(out)) {
      const v = out[k];
      const hasFresh = v && (v.value != null || v.error == null);
      if (hasFresh) merged[k] = v;
      else if (!merged[k]) merged[k] = v;
    }
    MI_CACHE = { value: merged, expiresAt: Date.now() + MI_AGG_TTL_MS };
    res.json({ ok: true, cached: false, data: merged });
  });

  app.get('/api/performance', async (req, res) => {
    const state = ctx.getDashboardState();
    const windowHours = parsePositiveInt(req.query.windowHours, null, 8760);
    const runtimeTrades = Array.isArray(state.portfolio?.trades)
      ? state.portfolio.trades
      : (Array.isArray(state.portfolio?.recentTrades) ? state.portfolio.recentTrades : []);
    let summary = null;
    let metricSource = 'runtime';
    let sqlError = null;
    try {
      const profileAliases = buildTradeProfileAliases(req.query.profile, config.paperTrading);
      const sqlTrades = await loadSpotTradeHistoryFromSql({ profiles: profileAliases, limit: 5000, log: logger });
      const mergedTrades = mergeTradeHistory(runtimeTrades, sqlTrades, 5000);
      summary = buildSpotTradeMetrics(filterTradeHistoryByWindow(mergedTrades, windowHours));
      if (sqlTrades.length > 0) metricSource = 'sql_runtime_merged';
    } catch (error) {
      sqlError = error.message;
      logger.warn(`Performance SQL metric fallback to runtime state: ${error.message}`);
      summary = buildSpotTradeMetrics(filterTradeHistoryByWindow(runtimeTrades, windowHours));
    }
    const portfolioMetrics = summary && (windowHours || summary.closedTrades > 0)
      ? summary
      : {
          closedTrades: state.portfolio.closedTrades,
          wins: state.portfolio.wins,
          losses: state.portfolio.losses,
          winRate: state.portfolio.winRate,
          profitFactor: state.portfolio.profitFactor,
          expectancyUsd: state.portfolio.expectancyUsd,
          avgWinUsd: state.portfolio.avgWinUsd,
          avgLossUsd: state.portfolio.avgLossUsd,
          realizedPnl: state.portfolio.realizedPnl,
          totalPnl: state.portfolio.totalPnl,
          grossProfit: state.portfolio.grossProfit,
          grossLoss: state.portfolio.grossLoss,
        };

    res.json({
      timestamp: state.timestamp,
      mode: state.mode,
      source: metricSource,
      metricScope: windowHours ? `rolling_${windowHours}h` : 'merged_available_history',
      window: windowHours ? {
        hours: windowHours,
        from: new Date(Date.now() - (windowHours * 60 * 60 * 1000)).toISOString(),
        to: new Date().toISOString(),
      } : null,
      sqlError,
      performanceGate: state.performanceGate,
      runtimeState: {
        closedTrades: state.portfolio.closedTrades,
        wins: state.portfolio.wins,
        losses: state.portfolio.losses,
        winRate: state.portfolio.winRate,
        profitFactor: state.portfolio.profitFactor,
        realizedPnl: state.portfolio.realizedPnl,
        totalPnl: state.portfolio.totalPnl,
      },
      // 2026-07-02 PnL reconciliation (see paper twin for full rationale).
      // On LIVE the usual failure mode is inverted vs paper: in-memory
      // counters reset on restart (runtimeState shows ~0) while SQL holds
      // the durable history — so `portfolio` (sql_runtime_merged) is the
      // authoritative view here whenever SQL rows are present. The drift
      // field makes the divergence visible either way.
      reconciliation: (() => {
        const rt = Number(state.portfolio.realizedPnl || 0);
        const merged = Number(portfolioMetrics.realizedPnl || 0);
        const driftUsd = Number((rt - merged).toFixed(2));
        const closedDrift = Number(state.portfolio.closedTrades || 0) - Number(portfolioMetrics.closedTrades || 0);
        return {
          realizedPnlDriftUsd: driftUsd,
          closedTradesDrift: closedDrift,
          materialDrift: Math.abs(driftUsd) > Math.max(5, Math.abs(merged) * 0.05),
          authoritativeTotal: metricSource === 'sql_runtime_merged' ? 'portfolio' : 'runtimeState',
          note: Math.abs(driftUsd) > Math.max(5, Math.abs(merged) * 0.05)
            ? 'runtime_counters_diverge_from_merged_history — check restart resets or SQL persistence gaps'
            : null,
        };
      })(),
      portfolio: {
        closedTrades: portfolioMetrics.closedTrades,
        wins: portfolioMetrics.wins,
        losses: portfolioMetrics.losses,
        winRate: portfolioMetrics.winRate,
        profitFactor: portfolioMetrics.profitFactor,
        expectancyUsd: portfolioMetrics.expectancyUsd,
        avgWinUsd: portfolioMetrics.avgWinUsd,
        avgLossUsd: portfolioMetrics.avgLossUsd,
        consecutiveLosses: state.portfolio.consecutiveLosses,
        maxConsecutiveLosses: state.portfolio.maxConsecutiveLosses,
        avgSlippageBps: state.portfolio.avgSlippageBps,
        slippageSamples: state.portfolio.slippageSamples,
        grossProfit: portfolioMetrics.grossProfit,
        grossLoss: portfolioMetrics.grossLoss,
        realizedPnl: portfolioMetrics.realizedPnl,
        totalPnl: portfolioMetrics.totalPnl,
        byChain: summary?.byChain || [],
        byStrategy: summary?.byStrategy || [],
      },
    });
  });

  app.get('/api/strategies', (req, res) => {
    const state = ctx.getDashboardState();
    const runtimeStrategies = new Set(getImplementedStrategyNames());
    const strategies = Object.fromEntries(
      Object.entries(state.portfolio?.strategies || {})
        .filter(([name, stats]) => (
          runtimeStrategies.has(name) &&
          config.strategies?.[name]?.enabled !== false
        ) || Number(stats?.openPositionCount || 0) > 0)
    );
    res.json({
      timestamp: state.timestamp,
      strategies,
      aggregate: {
        openPositionCount: state.portfolio?.openPositionCount,
        totalExecutions: state.portfolio?.totalExecutions,
        closedTrades: state.portfolio?.closedTrades,
        wins: state.portfolio?.wins,
        losses: state.portfolio?.losses,
        winRate: state.portfolio?.winRate,
        totalPnl: state.portfolio?.totalPnl,
        profitFactor: state.portfolio?.profitFactor,
      },
    });
  });

  // Bull-flag setup-level breakdown: counts + PnL by setupType from in-memory portfolio.trades
  app.get('/api/bull-flag-stats', (req, res) => {
    const state = ctx.getDashboardState();
    const trades = state.portfolio?.trades || [];
    const bullFlagSetupTypes = new Set(['spot_day_bull_flag', 'solana_bull_flag_v2']);
    const bullFlagTrades = trades.filter((t) => {
      const keys = [t?.setupType, t?.structureType, t?.strategyVariant, t?.strategy]
        .map((value) => String(value || '').toLowerCase());
      return keys.some((key) => bullFlagSetupTypes.has(key));
    });
    const sells = bullFlagTrades.filter((t) => String(t?.type).toUpperCase() === 'SELL');
    const wins = sells.filter((t) => Number(t?.pnl || 0) > 0);
    const losses = sells.filter((t) => Number(t?.pnl || 0) <= 0);
    const totalPnl = sells.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0);
    const grossWins = wins.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0);
    const grossLosses = Math.abs(losses.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0));
    const bySetupType = bullFlagTrades.reduce((acc, t) => {
      const key = String(t?.setupType || t?.structureType || t?.strategyVariant || t?.strategy || 'unknown').toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const reasonBreakdown = sells.reduce((acc, t) => {
      const r = String(t?.reason || 'UNKNOWN');
      acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {});
    // 2026-05-23 W16.4: cumulative PnL series for dashboard chart
    const sortedSells = [...sells]
      .filter((t) => t?.timestamp || t?.closedAt)
      .sort((a, b) => new Date(a.timestamp || a.closedAt) - new Date(b.timestamp || b.closedAt));
    let cum = 0;
    const pnlSeries = sortedSells.map((t) => {
      cum += Number(t?.pnl || 0);
      return { t: t.timestamp || t.closedAt, cumPnl: cum, pnl: Number(t?.pnl || 0) };
    });
    res.json({
      timestamp: state.timestamp,
      totalTrades: bullFlagTrades.length,
      buys: bullFlagTrades.length - sells.length,
      sells: sells.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: sells.length > 0 ? (wins.length / sells.length) * 100 : 0,
      totalPnlUsd: totalPnl,
      avgWinUsd: wins.length > 0 ? grossWins / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
      exitReasonBreakdown: reasonBreakdown,
      bySetupType,
      pnlSeries,
      enabled: Boolean(
        state?.config?.strategies?.spot_day_bull_flag?.enabled
        || state?.config?.strategies?.solana_bull_flag_v2?.enabled
      ),
    });
  });

  app.get('/api/backes-stats', (req, res) => {
    const state = ctx.getDashboardState();
    const trades = state.portfolio?.trades || [];
    const backesTrades = trades.filter((t) => (
      t?.setupType === 'backes'
      || t?.setupType === 'swing'
      || t?.setupType === 'backes_swing'
      || t?.strategy === 'backes'
      || t?.strategy === 'swing'
      || t?.strategy === 'backes_swing'
      || t?.strategyVariant === 'backes_htf_swing'
    ));
    const sells = backesTrades.filter((t) => String(t?.type).toUpperCase() === 'SELL');
    const wins = sells.filter((t) => Number(t?.pnl || 0) > 0);
    const losses = sells.filter((t) => Number(t?.pnl || 0) <= 0);
    const totalPnl = sells.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0);
    const grossWins = wins.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0);
    const grossLosses = Math.abs(losses.reduce((acc, t) => acc + (Number(t?.pnl) || 0), 0));
    const byStructureType = backesTrades.reduce((acc, trade) => {
      const key = String(trade?.structureType || 'unknown');
      if (!acc[key]) {
        acc[key] = { totalTrades: 0, buys: 0, sells: 0, wins: 0, losses: 0, pnlUsd: 0 };
      }
      acc[key].totalTrades += 1;
      if (String(trade?.type).toUpperCase() === 'BUY') acc[key].buys += 1;
      if (String(trade?.type).toUpperCase() === 'SELL') {
        const pnl = Number(trade?.pnl || 0);
        acc[key].sells += 1;
        acc[key].pnlUsd += pnl;
        if (pnl > 0) acc[key].wins += 1;
        else acc[key].losses += 1;
      }
      return acc;
    }, {});
    const exitReasonBreakdown = sells.reduce((acc, trade) => {
      const reason = String(trade?.reason || 'UNKNOWN');
      acc[reason] = (acc[reason] || 0) + 1;
      return acc;
    }, {});
    res.json({
      timestamp: state.timestamp,
      totalTrades: backesTrades.length,
      buys: backesTrades.length - sells.length,
      sells: sells.length,
      wins: wins.length,
      losses: losses.length,
      winRatePct: sells.length > 0 ? (wins.length / sells.length) * 100 : 0,
      totalPnlUsd: totalPnl,
      avgWinUsd: wins.length > 0 ? grossWins / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
      byStructureType,
      exitReasonBreakdown,
      macroRegime: state.macroRegime || null,
      enabled: Boolean(
        state?.config?.strategies?.backes?.enabled
        || state?.config?.strategies?.swing?.enabled
        || state?.config?.strategies?.backes_swing?.enabled
      ),
    });
  });

  const SHARED_REPORT_QUERIES = {
    activeModelVersions: ['activeModelVersions', `
      SELECT TOP 24
        v.version_id, v.model_id, r.display_name, r.model_family, r.task_class, r.provider,
        v.bot_profile, v.stage, v.status, v.regime_family, v.created_at, v.activated_at,
        v.params_json, v.metrics_json
      FROM dbo.model_versions v
      JOIN dbo.model_registry r ON r.model_id = v.model_id
      WHERE v.status = 'active'
      ORDER BY v.activated_at DESC, v.created_at DESC
    `],
    latestSentimentSnapshots: ['latestSentimentSnapshots', `
      SELECT TOP 20
        bot_profile, ts, chain_key, symbol, aggregate_score, signal, confidence, news_count, reddit_count
      FROM dbo.sentiment_snapshots
      ORDER BY ts DESC
    `],
    latestRlPolicyMetrics: ['latestRlPolicyMetrics', `
      SELECT TOP 12
        policy_id, policy_name, bot_profile, stage, status, created_at, updated_at, metrics_json
      FROM dbo.rl_policy_registry
      WHERE status = 'active'
      ORDER BY updated_at DESC
    `],
    latestHybridRouteDecisions: ['latestHybridRouteDecisions', `
      SELECT TOP 20
        bot_profile, ts, chain_key, symbol, task_class, regime_family, final_signal, confidence, route_json
      FROM dbo.multi_agent_decisions
      ORDER BY ts DESC
    `],
    pendingApprovals: ['pendingApprovals', `
      SELECT TOP 20
        v.version_id, v.bot_profile, v.source_profile, v.stage, v.created_at,
        v.candidate_id, v.version_hash, v.metadata_json,
        (SELECT TOP 1 e.promotion_confidence FROM dbo.promotion_events e WHERE e.version_id = v.version_id ORDER BY e.ts DESC) AS promotion_confidence,
        (SELECT TOP 1 e.discrepancy_score FROM dbo.promotion_events e WHERE e.version_id = v.version_id ORDER BY e.ts DESC) AS discrepancy_score
      FROM dbo.strategy_versions v
      WHERE v.stage = 'await_manual_approval'
      ORDER BY v.created_at DESC
    `],
    decisionQualitySummary: ['decisionQualitySummary', 'SELECT * FROM dbo.vw_decision_quality_summary ORDER BY bot_profile'],
    promotionSummary: ['promotionSummary', 'SELECT * FROM dbo.vw_promotion_summary ORDER BY bot_profile'],
    latestStrategyVersions: ['latestStrategyVersions', 'SELECT * FROM dbo.vw_strategy_versions_latest ORDER BY created_at DESC'],
    latestDecisions: ['latestDecisions', 'SELECT * FROM dbo.vw_latest_decisions ORDER BY ts DESC'],
    decisionTimeline: ['decisionTimeline', `
      SELECT TOP 120
        bot_profile, CAST(ts AS date) AS decision_day, COUNT(*) AS decision_count,
        SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) AS rejected_count,
        SUM(CASE WHEN final_action = 'BUY' THEN 1 ELSE 0 END) AS buy_count
      FROM dbo.decision_log
      WHERE decision_stage IN ('approval', 'execution')
      GROUP BY bot_profile, CAST(ts AS date)
      ORDER BY decision_day DESC, bot_profile
    `],
    pnlHistory: ['pnlHistory', `SELECT TOP 240 bot_profile, ts, cash, equity, total_pnl, unrealized_pnl, reason FROM dbo.bot_pnl_history ORDER BY ts DESC`],
    researchTradeRows: ['researchTradeRows', `SELECT TOP 500 bot_profile, strategy, trade_type, pnl_usd, ts FROM dbo.bot_trade_ledger ORDER BY ts DESC`],
    researchDecisionRows: ['researchDecisionRows', `SELECT TOP 500 bot_profile, strategy, approved, final_action, ts FROM dbo.decision_log ORDER BY ts DESC`],
    tradeCadence: ['tradeCadence', `
      SELECT TOP 120
        bot_profile,
        CAST(ts AS date) AS trade_day,
        COUNT(*) AS trade_count,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'BUY' THEN 1 ELSE 0 END) AS buy_count,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' THEN 1 ELSE 0 END) AS sell_count,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL_FAILED' THEN 1 ELSE 0 END) AS sell_failed_count,
        SUM(CASE WHEN pnl_usd IS NOT NULL THEN pnl_usd ELSE 0 END) AS pnl_usd
      FROM dbo.bot_trade_ledger
      GROUP BY bot_profile, CAST(ts AS date)
      ORDER BY trade_day DESC, bot_profile
    `],
  };

  app.get('/api/sql-report', requireAdminToken, async (req, res) => {
    async function computeSqlReport(requested) {
      const allowedReports = {
        portfolio: [
          ['profileSummary', 'SELECT * FROM dbo.vw_profile_summary ORDER BY bot_profile'],
          ['chainSummary', 'SELECT * FROM dbo.vw_chain_summary ORDER BY bot_profile, chain_key'],
          ['strategySummary', 'SELECT * FROM dbo.vw_strategy_summary ORDER BY bot_profile, strategy'],
          ['latestOpenPositions', 'SELECT TOP 50 * FROM dbo.vw_latest_open_positions ORDER BY bot_profile, opened_at DESC'],
          ['liveVsPaper', 'SELECT * FROM dbo.vw_live_vs_paper ORDER BY metric'],
        ],
        decisions: [
          SHARED_REPORT_QUERIES.latestDecisions,
          SHARED_REPORT_QUERIES.decisionQualitySummary,
          SHARED_REPORT_QUERIES.decisionTimeline,
          SHARED_REPORT_QUERIES.pendingApprovals,
          SHARED_REPORT_QUERIES.latestStrategyVersions,
          SHARED_REPORT_QUERIES.promotionSummary,
          SHARED_REPORT_QUERIES.latestHybridRouteDecisions,
        ],
        intelligence: [
          ['latestIntelligence', 'SELECT * FROM dbo.vw_latest_intelligence ORDER BY bot_profile'],
          SHARED_REPORT_QUERIES.latestSentimentSnapshots,
          SHARED_REPORT_QUERIES.activeModelVersions,
          SHARED_REPORT_QUERIES.latestRlPolicyMetrics,
          ['selfEvolutionSummary', 'SELECT * FROM dbo.vw_self_evolution_summary ORDER BY bot_profile'],
        ],
        learning: [
          ['latestLessons', 'SELECT TOP 25 * FROM dbo.vw_latest_agent_lessons ORDER BY ts DESC'],
          ['latestDiscoveries', 'SELECT TOP 25 * FROM dbo.vw_latest_agent_discoveries ORDER BY ts DESC'],
          ['agentMemorySummary', 'SELECT * FROM dbo.vw_agent_memory_summary ORDER BY memory_scope'],
          ['agentLessonContributions', 'SELECT * FROM dbo.vw_agent_lesson_contributions ORDER BY bot_profile, memory_scope'],
          ['learningSummary', 'SELECT * FROM dbo.vw_learning_summary ORDER BY bot_profile'],
        ],
        performance: [
          SHARED_REPORT_QUERIES.tradeCadence,
          SHARED_REPORT_QUERIES.pnlHistory,
          SHARED_REPORT_QUERIES.researchTradeRows,
          SHARED_REPORT_QUERIES.researchDecisionRows,
        ],
        v2: [
          ['riskEnforcementStatus', null],
          ['botPerformance24h', 'SELECT * FROM dbo.v_bot_performance_24h ORDER BY bot_profile, strategy'],
          ['strategyRejectionWaterfall', 'SELECT TOP 500 * FROM dbo.v_strategy_rejection_waterfall ORDER BY ts DESC'],
          ['openRiskExposure', 'SELECT * FROM dbo.v_open_risk_exposure ORDER BY bot_profile, market_type, symbol'],
          ['portfolioAllocationSummary', `
            WITH recent_equity AS (
              SELECT TOP 250
                bot_profile,
                equity,
                ts
              FROM dbo.bot_pnl_history
              WHERE equity IS NOT NULL
              ORDER BY ts DESC
            ),
            latest_equity AS (
              SELECT
                bot_profile,
                equity,
                ts,
                ROW_NUMBER() OVER (PARTITION BY bot_profile ORDER BY ts DESC) AS rn
              FROM recent_equity
            ),
            recent_exposure AS (
              SELECT TOP 500
                bot_profile,
                market_type,
                symbol,
                strategy,
                exposure_usd,
                notional_usd,
                risk_usd,
                ts
              FROM dbo.portfolio_exposure_snapshots
              ORDER BY ts DESC
            ),
            latest_exposure AS (
              SELECT
                *,
                ROW_NUMBER() OVER (
                  PARTITION BY bot_profile, market_type, symbol, strategy
                  ORDER BY ts DESC
                ) AS rn
              FROM recent_exposure
            ),
            current_exposure AS (
              SELECT * FROM latest_exposure WHERE rn = 1
            )
            SELECT
              ce.bot_profile,
              ce.market_type,
              ce.strategy,
              COUNT(*) AS open_exposure_count,
              SUM(ABS(COALESCE(ce.exposure_usd, ce.notional_usd, 0))) AS exposure_usd,
              SUM(ABS(COALESCE(ce.notional_usd, ce.exposure_usd, 0))) AS notional_usd,
              SUM(ABS(COALESCE(ce.risk_usd, 0))) AS risk_usd,
              MAX(le.equity) AS equity_usd,
              CASE
                WHEN MAX(le.equity) > 0
                THEN SUM(ABS(COALESCE(ce.risk_usd, 0))) / MAX(le.equity) * 100.0
                ELSE NULL
              END AS heat_pct,
              MAX(ce.ts) AS last_snapshot_at
            FROM current_exposure ce
            LEFT JOIN latest_equity le
              ON le.bot_profile = ce.bot_profile
             AND le.rn = 1
            GROUP BY ce.bot_profile, ce.market_type, ce.strategy
            ORDER BY heat_pct DESC, risk_usd DESC
          `],
          ['latestPortfolioExposureSnapshots', 'SELECT TOP 500 * FROM dbo.portfolio_exposure_snapshots ORDER BY ts DESC'],
          ['latestCorrelationSnapshots', 'SELECT TOP 500 * FROM dbo.correlation_snapshots ORDER BY ts DESC'],
          ['strategyVersionPerformance', 'SELECT TOP 200 * FROM dbo.v_strategy_version_performance ORDER BY last_trade_at DESC'],
          ['latestStrategyVersions', 'SELECT TOP 100 * FROM dbo.strategy_versions ORDER BY created_at DESC'],
          ['executionQuality', 'SELECT TOP 500 * FROM dbo.v_execution_quality ORDER BY ts DESC'],
          ['latestTradingEvents', 'SELECT TOP 250 * FROM dbo.trading_events ORDER BY occurred_at DESC'],
          ['latestPerpsCanaryPolicyAudits', `
            SELECT TOP 100
              event_id,
              bot_profile,
              strategy,
              symbol,
              occurred_at,
              severity,
              correlation_id,
              JSON_VALUE(payload_json, '$.policyEvaluationId') AS policy_evaluation_id,
              JSON_VALUE(payload_json, '$.proposal.stage') AS canary_stage,
              JSON_VALUE(payload_json, '$.proposal.submitMode') AS submit_mode,
              JSON_VALUE(payload_json, '$.policy.ok') AS policy_ok,
              JSON_QUERY(payload_json, '$.policy.reasons') AS reasons_json,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.policy.limits.maxCanaryNotionalUsd')) AS max_canary_notional_usd,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.policy.limits.maxCanaryLeverage')) AS max_canary_leverage,
              JSON_VALUE(payload_json, '$.runtimeFacts.sqlHealthy') AS sql_healthy,
              payload_json
            FROM dbo.trading_events
            WHERE event_name = 'live_canary.policy_evaluated'
            ORDER BY occurred_at DESC
          `],
          ['latestPortfolioAllocationAudits', `
            WITH recent_events AS (
              SELECT TOP 1000
                event_id,
                bot_profile,
                strategy,
                symbol,
                occurred_at,
                severity,
                payload_json,
                event_name
              FROM dbo.trading_events
              ORDER BY occurred_at DESC
            )
            SELECT TOP 100
              event_id,
              bot_profile,
              strategy,
              symbol,
              occurred_at,
              severity,
              JSON_VALUE(payload_json, '$.input.portfolioAllocation.proposedTrade.allow') AS allocation_allow,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.input.portfolioAllocation.proposedTrade.proposedRiskUsd')) AS proposed_risk_usd,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.input.portfolioAllocation.proposedTrade.recommendedRiskUsd')) AS recommended_risk_usd,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.input.portfolioAllocation.proposedTrade.riskMultiplier')) AS risk_multiplier,
              TRY_CONVERT(float, JSON_VALUE(payload_json, '$.input.portfolioAllocation.proposedTrade.afterHeatPct')) AS after_heat_pct,
              JSON_QUERY(payload_json, '$.input.portfolioAllocation.proposedTrade.reasons') AS allocation_reasons_json,
              JSON_QUERY(payload_json, '$.reasons') AS audit_reasons_json
            FROM recent_events
            WHERE event_name = 'risk.audit'
              AND JSON_QUERY(payload_json, '$.input.portfolioAllocation') IS NOT NULL
            ORDER BY occurred_at DESC
          `],
          ['latestStrategyRouting', `
            SELECT TOP 150
              event_id,
              bot_profile,
              strategy,
              occurred_at,
              correlation_id,
              JSON_VALUE(payload_json, '$.generatedAt') AS generated_at,
              JSON_QUERY(payload_json, '$.enabledStrategies') AS enabled_strategies_json,
              JSON_QUERY(payload_json, '$.decisions') AS decisions_json,
              JSON_QUERY(payload_json, '$.cycle.topGateRejects') AS top_gate_rejects_json,
              TRY_CONVERT(int, JSON_VALUE(payload_json, '$.cycle.evaluated')) AS evaluated,
              TRY_CONVERT(int, JSON_VALUE(payload_json, '$.cycle.passed')) AS passed,
              TRY_CONVERT(int, JSON_VALUE(payload_json, '$.scan.symbolsScanned')) AS perps_symbols_scanned,
              TRY_CONVERT(int, JSON_VALUE(payload_json, '$.scan.shadowQualified')) AS perps_shadow_qualified,
              JSON_QUERY(payload_json, '$.scan.topReasons') AS perps_top_reasons_json,
              JSON_VALUE(payload_json, '$.admission.allowNewPaperEntries') AS perps_admission_allow_new_entries
            FROM dbo.trading_events
            WHERE event_name = 'strategy.routing'
            ORDER BY occurred_at DESC
          `],
          ['perpsControlPlaneSummary', 'SELECT * FROM dbo.v_perps_control_plane_summary ORDER BY bot_profile'],
          ['perpsRiskExposure', 'SELECT * FROM dbo.v_perps_risk_exposure ORDER BY bot_profile, status, updated_at DESC'],
          ['perpsExecutionQualitySummary', 'SELECT TOP 200 * FROM dbo.v_perps_execution_quality_summary ORDER BY last_trade_at DESC'],
          ['perpsPromotionReadiness', 'SELECT TOP 200 * FROM dbo.v_perps_promotion_readiness ORDER BY bot_profile, strategy'],
          ['latestPerpsSignals', 'SELECT TOP 250 * FROM dbo.perps_signals ORDER BY ts DESC'],
          ['latestPerpsTrades', 'SELECT TOP 250 * FROM dbo.perps_trades ORDER BY ts DESC'],
          ['openPerpsPositions', "SELECT * FROM dbo.perps_positions WHERE status = 'open' ORDER BY updated_at DESC"],
          ['latestPerpsAdmission', 'SELECT TOP 20 * FROM dbo.perps_admission_snapshots ORDER BY ts DESC'],
          ['promotionCandidates', 'SELECT TOP 100 * FROM dbo.promotion_candidates ORDER BY created_at DESC'],
          ['walkForwardResults', 'SELECT TOP 100 * FROM dbo.walk_forward_results ORDER BY ts DESC'],
          ['mutationProposals', 'SELECT TOP 100 * FROM dbo.v_mutation_proposals_latest ORDER BY created_at DESC'],
          ['promotionGateEvaluations', 'SELECT TOP 100 * FROM dbo.v_promotion_gate_evaluations_latest ORDER BY ts DESC'],
        ],
        overview: [
          ['profileSummary', 'SELECT * FROM dbo.vw_profile_summary ORDER BY bot_profile'],
          ['learningSummary', 'SELECT * FROM dbo.vw_learning_summary ORDER BY bot_profile'],
          ['liveVsPaper', 'SELECT * FROM dbo.vw_live_vs_paper ORDER BY metric'],
          SHARED_REPORT_QUERIES.pnlHistory,
          SHARED_REPORT_QUERIES.tradeCadence,
          SHARED_REPORT_QUERIES.latestDecisions,
        ],
        breakdown: [
          ['chainSummary', 'SELECT * FROM dbo.vw_chain_summary ORDER BY bot_profile, chain_key'],
          ['strategySummary', 'SELECT * FROM dbo.vw_strategy_summary ORDER BY bot_profile, strategy'],
          ['latestOpenPositions', 'SELECT TOP 50 * FROM dbo.vw_latest_open_positions ORDER BY bot_profile, opened_at DESC'],
          SHARED_REPORT_QUERIES.researchTradeRows,
          SHARED_REPORT_QUERIES.decisionTimeline,
        ],
        memory: [
          ['latestLessons', 'SELECT TOP 25 * FROM dbo.vw_latest_agent_lessons ORDER BY ts DESC'],
          ['latestDiscoveries', 'SELECT TOP 25 * FROM dbo.vw_latest_agent_discoveries ORDER BY ts DESC'],
          ['agentMemorySummary', 'SELECT * FROM dbo.vw_agent_memory_summary ORDER BY memory_scope'],
          ['agentLessonContributions', 'SELECT * FROM dbo.vw_agent_lesson_contributions ORDER BY bot_profile, memory_scope'],
          SHARED_REPORT_QUERIES.activeModelVersions,
          SHARED_REPORT_QUERIES.latestSentimentSnapshots,
          SHARED_REPORT_QUERIES.latestRlPolicyMetrics,
        ],
      };

      const v2SmokeObjects = {
        botPerformance24h: { name: 'dbo.v_bot_performance_24h', type: 'V' },
        strategyRejectionWaterfall: { name: 'dbo.v_strategy_rejection_waterfall', type: 'V' },
        openRiskExposure: { name: 'dbo.v_open_risk_exposure', type: 'V' },
        portfolioAllocationSummary: { name: 'dbo.portfolio_exposure_snapshots', type: 'U' },
        latestPortfolioExposureSnapshots: { name: 'dbo.portfolio_exposure_snapshots', type: 'U' },
        latestCorrelationSnapshots: { name: 'dbo.correlation_snapshots', type: 'U' },
        executionQuality: { name: 'dbo.v_execution_quality', type: 'V' },
        latestStrategyVersions: { name: 'dbo.strategy_versions', type: 'U' },
        latestPerpsCanaryPolicyAudits: { name: 'dbo.trading_events', type: 'U' },
        latestPortfolioAllocationAudits: { name: 'dbo.trading_events', type: 'U' },
        latestStrategyRouting: { name: 'dbo.trading_events', type: 'U' },
        perpsControlPlaneSummary: { name: 'dbo.v_perps_control_plane_summary', type: 'V' },
        perpsPromotionReadiness: { name: 'dbo.v_perps_promotion_readiness', type: 'V' },
      };

      if (!Object.prototype.hasOwnProperty.call(allowedReports, requested)) {
        const error = new Error('Unknown report');
        error.statusCode = 400;
        error.allowed = Object.keys(allowedReports);
        throw error;
      }

      const pool = await getPool(logger);
      if (!pool) {
        const error = new Error('SQL pool unavailable');
        error.statusCode = 503;
        throw error;
      }
      await ensureSchema(logger);

      if (requested === 'v2' && String(req.query.smoke || '').trim() === '1') {
        const payload = {};
        const missingObjects = [];
        for (const [key, spec] of Object.entries(v2SmokeObjects)) {
          // eslint-disable-next-line no-await-in-loop
          const result = await pool.request().query(`
            SELECT
              CASE
                WHEN OBJECT_ID(N'${spec.name}', N'${spec.type}') IS NULL THEN CAST(0 AS bit)
                ELSE CAST(1 AS bit)
              END AS object_exists;
          `);
          const exists = Boolean(result.recordset?.[0]?.object_exists);
          if (!exists) missingObjects.push(spec.name);
          payload[key] = [{
            objectName: spec.name,
            objectType: spec.type,
            exists,
          }];
        }
        payload.riskEnforcementStatus = buildRiskEnforcementStatus();
        payload.rotationDebug = buildRotationDebugPayload(ctx);
        return {
          ok: missingObjects.length === 0,
          report: requested,
          smoke: true,
          generatedAt: new Date().toISOString(),
          missingObjects,
          data: payload,
        };
      }

      const payload = {};
      for (const [key, queryText] of allowedReports[requested]) {
        if (!queryText && key === 'riskEnforcementStatus') {
          payload[key] = buildRiskEnforcementStatus();
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const result = await pool.request().query(queryText);
        payload[key] = result.recordset || [];
      }
      if (payload.researchTradeRows || payload.researchDecisionRows) {
        const research = buildResearchAnalytics(payload.researchTradeRows || [], payload.researchDecisionRows || []);
        payload.monteCarloSummary = research.monteCarlo;
        payload.benchmarkSummary = research.benchmark;
        payload.decisionBenchmark = research.decisionBenchmark;
        delete payload.researchTradeRows;
        delete payload.researchDecisionRows;
      }
      payload.rotationDebug = buildRotationDebugPayload(ctx);
      return {
        ok: true,
        report: requested,
        generatedAt: new Date().toISOString(),
        data: payload,
      };
    }

    try {
      const requested = String(req.query.report || 'overview').trim().toLowerCase();
      const cacheTtlMs = Math.max(3000, Number(process.env.SQL_REPORT_CACHE_MS || 15000));
      const cached = sqlReportCache.byReport[requested];
      const lastRefresh = Number(sqlReportCache.lastRefreshAt[requested] || 0);
      const fresh = cached && (Date.now() - lastRefresh) <= cacheTtlMs;

      if (!fresh && !sqlReportCache.inFlight[requested]) {
        sqlReportCache.inFlight[requested] = computeSqlReport(requested)
          .then((payload) => {
            sqlReportCache.byReport[requested] = payload;
            sqlReportCache.lastRefreshAt[requested] = Date.now();
            return payload;
          })
          .finally(() => {
            sqlReportCache.inFlight[requested] = null;
          });
      }

      if (fresh) {
        return res.json({
          ...cached,
          cache: { hit: true, ageMs: Date.now() - lastRefresh },
        });
      }

      const payload = await (sqlReportCache.inFlight[requested] || computeSqlReport(requested));
      return res.json({
        ...payload,
        cache: { hit: false, ageMs: 0 },
      });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ error: error.message, allowed: error.allowed || [] });
      }
      if (error.statusCode === 503) {
        return res.status(503).json({ error: error.message });
      }
      logger.warn(`SQL report endpoint failed: ${error.message}`);
      return res.status(500).json({ error: 'sql_report_failed', details: error.message });
    }
  });

  app.post('/api/ml-train', requireWriteAccess, async (req, res) => {
    if (!ctx.modelRegistry || typeof ctx.modelRegistry.runAutoTraining !== 'function') {
      return res.status(503).json({ error: 'model_registry_unavailable' });
    }
    try {
      const result = await ctx.modelRegistry.runAutoTraining();
      return res.json({ ok: true, result });
    } catch (error) {
      logger.warn(`[Dashboard] /api/ml-train failed: ${error.message}`);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/jobs/:jobId', requireAdminToken, (req, res) => {
    const job = backgroundJobs.get(String(req.params.jobId || ''));
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  });

  app.get('/api/jobs', requireAdminToken, (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || config.research?.jobsListLimit || 12)));
    return res.json({
      jobs: backgroundJobs.list(limit),
      scheduled: {
        enabled: Boolean(config.research?.scheduledEnabled),
        nightlyHourUtc: Number(config.research?.nightlyHourUtc || 2),
        nightlyMinuteUtc: Number(config.research?.nightlyMinuteUtc || 15),
        lastTriggeredAt: scheduledResearchState.lastTriggeredAt,
      },
    });
  });

  app.post('/api/promotion/approve', requireWriteAccess, async (req, res) => {
    try {
      const versionId = String(req.body?.versionId || '').trim();
      if (!versionId) {
        return res.status(400).json({ error: 'versionId is required' });
      }
      const pool = await getPool(logger);
      if (!pool) {
        return res.status(503).json({ error: 'SQL pool unavailable' });
      }
      await ensureSchema(logger);
      const validateReq = pool.request();
      validateReq.input('version_id', sql.NVarChar(80), versionId.slice(0, 80));
      const validateRes = await validateReq.query(`
SELECT TOP 1 version_id, stage, bot_profile, source_profile
FROM dbo.strategy_versions
WHERE version_id = @version_id
`);
      const versionRow = validateRes.recordset?.[0];
      if (!versionRow) {
        return res.status(404).json({ error: 'Unknown versionId' });
      }
      if (String(versionRow.stage || '').toLowerCase() !== 'await_manual_approval') {
        return res.status(409).json({
          error: `Version ${versionId} is not awaiting manual approval`,
          stage: versionRow.stage,
        });
      }
      const reqSql = pool.request();
      reqSql.input('event_id', sql.UniqueIdentifier, randomUUID());
      reqSql.input('version_id', sql.NVarChar(80), versionId.slice(0, 80));
      reqSql.input('bot_profile', sql.NVarChar(20), String(process.env.BOT_PROFILE || (config.paperTrading ? 'paper' : 'live')).toLowerCase());
      reqSql.input('ts', sql.DateTime2(3), new Date());
      reqSql.input('approved_by', sql.NVarChar(80), 'dashboard_admin');
      reqSql.input('notes', sql.NVarChar(800), String(req.body?.notes || 'approved from dashboard').slice(0, 800));
      await reqSql.query(`
INSERT INTO dbo.promotion_events(event_id, version_id, bot_profile, ts, event_type, stage, status, discrepancy_score, promotion_confidence, approval_required, approved_by, notes, context_json)
VALUES(@event_id, @version_id, @bot_profile, @ts, 'manual_approval', 'await_manual_approval', 'approved', NULL, NULL, 1, @approved_by, @notes, NULL)
`);
      const updateReq = pool.request();
      updateReq.input('version_id', sql.NVarChar(80), versionId.slice(0, 80));
      updateReq.input('approved_at', sql.DateTime2(3), new Date());
      await updateReq.query(`
UPDATE dbo.strategy_versions
SET stage = 'approved_for_canary',
    approved_at = COALESCE(@approved_at, approved_at)
WHERE version_id = @version_id
`);
      return res.json({ ok: true, versionId });
    } catch (error) {
      logger.error(`Promotion approval failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/webhook/tradingview', async (req, res) => {
    try {
      if (!config.webhooks?.tradingViewEnabled) {
        return res.status(404).json({ error: 'Webhook disabled' });
      }
      if (typeof ctx.ingestExternalSignal !== 'function') {
        return res.status(503).json({ error: 'External signal ingestion unavailable' });
      }

      const configuredSecret = String(config.webhooks?.tradingViewSecret || '').trim();
      const providedSecret = String(
        req.headers['x-webhook-secret']
        || req.headers['x-tradingview-secret']
        || req.query.secret
        || req.body?.secret
        || ''
      ).trim();
      // Fail CLOSED: if the webhook is enabled but no secret is configured,
      // refuse unauthenticated signal injection rather than accepting anything.
      if (!configuredSecret) {
        return res.status(503).json({ error: 'Webhook enabled but no secret configured — refusing unauthenticated signals' });
      }
      if (!safeEqual(providedSecret, configuredSecret)) {
        return res.status(401).json({ error: 'Unauthorized webhook secret' });
      }

      const payload = req.body || {};
      const signal = await ctx.ingestExternalSignal({
        provider: 'tradingview',
        source: 'tradingview',
        symbol: payload.symbol || payload.ticker,
        chainKey: payload.chain || payload.chainKey || payload.exchange || null,
        strategy: payload.strategy || null,
        signal: payload.signal || payload.action || payload.side,
        confidence: payload.confidence,
        note: payload.note || payload.message || payload.comment,
        raw: payload,
        expiresAt: payload.expiresAt || new Date(Date.now() + Number(config.webhooks?.tradingViewMaxAgeMs || 21600000)).toISOString(),
      });
      return res.json({ ok: true, signal });
    } catch (error) {
      logger.error(`TradingView webhook failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });


  // Crypto news endpoint (must be inside startDashboard)
  app.get('/api/news', async (req, res) => {
    try {
      const { fetchCryptoNews } = require('./utils/news');
      const news = await fetchCryptoNews('', 12);
      res.json({ news });
    } catch (error) {
      logger.error(`News endpoint failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  // Portfolio correlation matrix endpoint
  app.get('/api/correlation', (req, res) => {
    try {
      const { buildCorrelationMatrix } = require('./utils/correlation');
      let priceHistories = ctx.strategy?.priceHistory || {};
      let source = 'memory';
      const requestedLimitRaw = Number(req.query?.limit);
      const requestedLimit = Number.isFinite(requestedLimitRaw) && requestedLimitRaw > 0
        ? Math.max(10, Math.min(5000, requestedLimitRaw))
        : null;

      if (!priceHistories || Object.keys(priceHistories).length === 0) {
        try {
          const dataDir = process.env.BOT_DATA_DIR || 'data';
          const stateFile = path.join(__dirname, '..', dataDir, 'state.json');
          const raw = fs.readFileSync(stateFile, 'utf8');
          const saved = JSON.parse(raw);
          const persisted = saved?.strategyState?.priceHistory;
          if (persisted && typeof persisted === 'object' && Object.keys(persisted).length > 0) {
            priceHistories = persisted;
            source = 'disk';
          }
        } catch (fallbackError) {
          logger.debug(`Correlation disk fallback unavailable: ${fallbackError.message}`);
        }
      }

      const allKeys = Object.keys(priceHistories || {});
      if (requestedLimit && allKeys.length > requestedLimit) {
        const ranked = allKeys
          .map((key) => {
            const bars = Array.isArray(priceHistories[key]) ? priceHistories[key].length : 0;
            return { key, bars };
          })
          .sort((a, b) => b.bars - a.bars)
          .slice(0, requestedLimit);

        const limited = {};
        ranked.forEach(({ key }) => {
          limited[key] = priceHistories[key];
        });
        priceHistories = limited;
      }

      const matrix = buildCorrelationMatrix(priceHistories);
      res.json({
        ...matrix,
        source,
        historyCount: Object.keys(priceHistories || {}).length,
        limitApplied: requestedLimit,
      });
    } catch (error) {
      logger.error(`Correlation endpoint failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/backtest', requireWriteAccess, async (req, res) => {
    try {
      const wantsAsync = String(req.query.async || req.body?.async || '').toLowerCase() === 'true';
      if (wantsAsync) {
        const job = backgroundJobs.enqueue('backtest', () => ctx.runBacktestRequest(req.body || {}));
        return res.status(202).json({ ok: true, queued: true, job });
      }
      const result = await ctx.runBacktestRequest(req.body || {});
      if (!result) {
        return res.status(400).json({ error: 'Unable to run backtest with the provided token/history.' });
      }
      return res.json(result);
    } catch (error) {
      logger.error(`Backtest request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/backtest/seed-data', requireWriteAccess, async (req, res) => {
    try {
      const { priceHistory, volumeHistory, tokenAddress, chain } = req.body || {};
      if (!priceHistory || !volumeHistory || !tokenAddress || !chain) {
        return res.status(400).json({ error: 'Missing required fields: priceHistory, volumeHistory, tokenAddress, chain' });
      }
      const result = await ctx.seedBacktestData(priceHistory, volumeHistory, tokenAddress, chain);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      return res.json(result);
    } catch (error) {
      logger.error(`Seed backtest data failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/simulation', requireWriteAccess, async (req, res) => {
    try {
      const wantsAsync = String(req.query.async || req.body?.async || '').toLowerCase() === 'true';
      if (wantsAsync) {
        const job = backgroundJobs.enqueue('simulation', () => ctx.runSimulationRequest(req.body || {}));
        return res.status(202).json({ ok: true, queued: true, job });
      }
      const result = await ctx.runSimulationRequest(req.body || {});
      if (!result) {
        return res.status(400).json({ error: 'Simulation could not be generated.' });
      }
      return res.json(result);
    } catch (error) {
      logger.error(`Simulation request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/brain/evaluate', requireWriteAccess, async (req, res) => {
    try {
      const wantsAsync = String(req.query.async || req.body?.async || '').toLowerCase() === 'true';
      if (wantsAsync) {
        const job = backgroundJobs.enqueue('brain_evaluate', () => ctx.previewAiSignal(req.body || {}));
        return res.status(202).json({ ok: true, queued: true, job });
      }
      const result = await ctx.previewAiSignal(req.body || {});
      if (!result) {
        return res.status(400).json({ error: 'Unable to evaluate AI signal for that token.' });
      }
      return res.json(result);
    } catch (error) {
      logger.error(`AI preview request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/research/hyperopt', requireWriteAccess, async (req, res) => {
    try {
      const job = backgroundJobs.enqueue('hyperopt', () => ctx.runHyperoptRequest(req.body || {}));
      return res.status(202).json({ ok: true, queued: true, job });
    } catch (error) {
      logger.error(`Hyperopt request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/research/validate', requireWriteAccess, async (req, res) => {
    try {
      const job = backgroundJobs.enqueue('validate', () => ctx.runValidationRequest(req.body || {}));
      return res.status(202).json({ ok: true, queued: true, job });
    } catch (error) {
      logger.error(`Validation request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/research/benchmark-position', requireWriteAccess, async (req, res) => {
    try {
      const job = backgroundJobs.enqueue('position_benchmark', () => ctx.runPositionResearchRequest(req.body || {}));
      return res.status(202).json({ ok: true, queued: true, job });
    } catch (error) {
      logger.error(`Position benchmark request failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/research/nightly-run', requireWriteAccess, async (req, res) => {
    try {
      const result = await runNightlyResearch(true);
      return res.json({ ok: true, ...result });
    } catch (error) {
      logger.error(`Nightly research trigger failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/paper/reset', requireWriteAccess, async (req, res) => {
    try {
      if (!config.paperTrading) {
        return res.status(409).json({ error: 'Paper reset is only available in paper mode' });
      }
      const balance = sanitizeNumber(req.body?.balance, config.paperBalance);
      const snapshot = ctx.resetPaperPortfolio(balance);
      if (typeof ctx.saveState === 'function') {
        await ctx.saveState();
      }
      return res.json({ success: true, snapshot });
    } catch (error) {
      logger.error(`Paper reset failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/admin/safe-mode/clear', requireAdminToken, (req, res) => {
    try {
      if (typeof ctx.clearSafeMode !== 'function') {
        return res.status(503).json({ error: 'Safe mode control unavailable' });
      }
      const result = ctx.clearSafeMode();
      return res.json({ success: true, ...result });
    } catch (error) {
      logger.error(`Safe mode clear failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/admin/filter-stats', requireAdminToken, (req, res) => {
    try {
      const cycles = typeof ctx.getFilterStatsHistory === 'function' ? ctx.getFilterStatsHistory() : [];
      return res.json({
        success: true,
        cycles: Array.isArray(cycles) ? cycles.slice(0, 10) : [],
      });
    } catch (error) {
      logger.error(`Filter stats endpoint failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/admin/scan-counter-mismatches', requireAdminToken, (req, res) => {
    try {
      const mismatches = typeof ctx.getScanCounterMismatches === 'function'
        ? ctx.getScanCounterMismatches()
        : [];

      return res.json({
        success: true,
        count: Array.isArray(mismatches) ? mismatches.length : 0,
        mismatches: Array.isArray(mismatches) ? mismatches : [],
      });
    } catch (error) {
      logger.error(`Scan counter mismatches endpoint failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/admin/clear-tracked', requireAdminToken, (req, res) => {
    try {
      if (typeof ctx.clearTrackedTokensAndSignals !== 'function') {
        return res.status(503).json({ error: 'Clear tracked tokens function unavailable' });
      }
      const result = ctx.clearTrackedTokensAndSignals();
      return res.json({ success: true, ...result });
    } catch (error) {
      logger.error(`Clear tracked tokens failed: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/lessons', (req, res) => {
    try {
      if (typeof ctx.getAgentMemoryState !== 'function') {
        return res.json({ success: true, lessons: [], totalLessons: 0 });
      }
      const memoryState = ctx.getAgentMemoryState();
      const recentLessons = (memoryState?.recentLessons || []).map((lesson) => ({
        id: lesson.id || `${lesson.symbol}:${lesson.timestamp}`,
        symbol: lesson.symbol,
        reason: lesson.reason,
        severity: lesson.severity,
        timestamp: lesson.timestamp,
        expiresAt: lesson.expiresAt,
        rsiContext: lesson.rsiContext,
        volumeContext: lesson.volumeContext,
      }));
      return res.json({
        success: true,
        lessons: recentLessons.slice(0, 50),
        totalLessons: memoryState?.lessons || 0,
        blacklistedCount: Object.keys(memoryState?.blacklistedTokens || {}).length,
      });
    } catch (error) {
      logger.error(`Lessons endpoint failed: ${error.message}`);
      return res.json({
        success: false,
        error: error.message,
        lessons: [],
        totalLessons: 0,
      });
    }
  });

  app.get('/api/metrics/extended', (req, res) => {
    try {
      const state = ctx.getDashboardState();
      const portfolio = state.portfolio || {};
      const trades = portfolio.recentTrades || [];

      // Calculate hold time metrics
      const closedTrades = trades.filter((t) => t?.type === 'SELL' && Number.isFinite(Number(t?.pnl)));
      const winTrades = closedTrades.filter((t) => Number(t.pnl) > 0);
      const lossTrades = closedTrades.filter((t) => Number(t.pnl) <= 0);

      let avgHoldTimeWinsMinutes = null;
      let avgHoldTimeLoessesMinutes = null;

      if (winTrades.length > 0) {
        const totalHoldWins = winTrades.reduce((sum, t) => {
          const entryTime = Date.parse(t.timestamp || 0);
          const entryIndex = trades.findIndex((tr) => tr.address === t.address && tr?.type === 'BUY');
          if (entryIndex >= 0) {
            const buyTime = Date.parse(trades[entryIndex].timestamp || 0);
            return sum + (entryTime - buyTime) / 60_000;
          }
          return sum;
        }, 0);
        avgHoldTimeWinsMinutes = roundMetric(totalHoldWins / winTrades.length, 1);
      }

      if (lossTrades.length > 0) {
        const totalHoldLosses = lossTrades.reduce((sum, t) => {
          const entryTime = Date.parse(t.timestamp || 0);
          const entryIndex = trades.findIndex((tr) => tr.address === t.address && tr?.type === 'BUY');
          if (entryIndex >= 0) {
            const buyTime = Date.parse(trades[entryIndex].timestamp || 0);
            return sum + (entryTime - buyTime) / 60_000;
          }
          return sum;
        }, 0);
        avgHoldTimeLoessesMinutes = roundMetric(totalHoldLosses / lossTrades.length, 1);
      }

      // Lessons triggered per 100 trades
      const totalTrades = Number(portfolio.closedTrades || 0);
      const memoryState = typeof ctx.getAgentMemoryState === 'function' ? ctx.getAgentMemoryState() : {};
      const lessonsCount = Number(memoryState?.lessons || 0);
      const lessonsPerHundredTrades = totalTrades > 0 ? roundMetric((lessonsCount / totalTrades) * 100, 2) : 0;

      return res.json({
        success: true,
        metrics: {
          winRate: portfolio.winRate || null,
          profitFactor: portfolio.profitFactor || 0,
          avgHoldTimeWinsMinutes,
          avgHoldTimeLoessesMinutes,
          lessonsTriggeredPer100Trades: lessonsPerHundredTrades,
          totalLessonsTrigger: lessonsCount,
          totalTradesClosed: totalTrades,
          cascadeRejectionRate: null, // Requires tracking from scan pipeline
          staleDriftExitRate: null, // Requires tracking from exit logic
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(`Extended metrics endpoint failed: ${error.message}`);
      return res.json({
        success: false,
        error: error.message,
        metrics: null,
      });
    }
  });

  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  wss.on('connection', (socket) => {
    logger.info('Dashboard WebSocket client connected');

    const pushState = () => {
      if (socket.readyState === socket.OPEN) {
        if (Number(socket.bufferedAmount || 0) > 256 * 1024) {
          return;
        }
        socket.send(JSON.stringify({ type: 'state', payload: ctx.getDashboardState({ compact: true }) }));
      }
    };

    pushState();
    const interval = setInterval(pushState, 10000);
    socket.on('close', () => clearInterval(interval));
  });

  const bindHost = config.dashboard?.bindHost || '127.0.0.1';
  
  // Exponential backoff for port binding - handles TIME_WAIT after process restart
  let retryCount = 0;
  const maxRetries = 15;
  let bindRetryTimer = null;
  let bindInProgress = false;
  
  const clearBindRetryTimer = () => {
    if (bindRetryTimer) {
      clearTimeout(bindRetryTimer);
      bindRetryTimer = null;
    }
  };
  
  const handleBindError = (err) => {
    bindInProgress = false;

    // Ignore stale retry errors once the dashboard is already listening.
    if (server.listening) {
      clearBindRetryTimer();
      return;
    }

    if (err.code === 'EADDRINUSE' && retryCount < maxRetries) {
      retryCount++;
      // Longer exponential backoff to let OS release the port from TIME_WAIT state
      const delayMs = 200 + (retryCount * 200); // 400ms, 600ms, 800ms, ..., 3200ms
      logger.warn(`Port ${config.bot.port} in use (EADDRINUSE), attempt ${retryCount}/${maxRetries}, retrying in ${delayMs}ms...`);
      
      clearBindRetryTimer();
      bindRetryTimer = setTimeout(() => {
        bindRetryTimer = null;
        server.removeAllListeners('error');
        server.once('error', handleBindError);
        startListening();
      }, delayMs);
    } else if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${config.bot.port} still in use after ${maxRetries} attempts. This usually means:`);
      logger.error('  1. A previous process is still holding the port');
      logger.error('  2. The OS needs more time to release the port from TIME_WAIT');
      logger.error('  Try: netstat -an | findstr :3002 (Windows) or lsof -i :3002 (Mac/Linux)');
      logger.error('Forcing process exit - PM2 will restart.');
      process.exit(1);
    } else {
      logger.error('Server bind error:', err);
    }
  };

  const startListening = () => {
    if (server.listening || bindInProgress) {
      return;
    }

    bindInProgress = true;
    server.listen(config.bot.port, bindHost, () => {
      bindInProgress = false;
      retryCount = 0; // Reset on successful bind
      clearBindRetryTimer();
      const networkIP = getNetworkIP();
      logger.info(`Dashboard live at http://localhost:${config.bot.port}`);
      if (bindHost === '0.0.0.0') {
        logger.info(`Network access: http://${networkIP}:${config.bot.port}`);
      }

      // Bug 8: warn when write endpoints are reachable without token auth.
      if (!adminToken) {
        if (bindHost === '0.0.0.0') {
          // Exposed to the network AND no token — this is a remote-execution risk.
          logger.warn(
            '[SECURITY] Dashboard is bound to 0.0.0.0 without DASHBOARD_ADMIN_TOKEN. ' +
            'Write endpoints (/api/config, /api/backtest, etc.) are accessible to anyone ' +
            'on the network. Set DASHBOARD_ADMIN_TOKEN in your .env immediately.'
          );
        } else {
          // Localhost only but no token — lower risk, still worth a notice.
          logger.warn(
            '[SECURITY] DASHBOARD_ADMIN_TOKEN is not set. Write endpoints are protected by ' +
            'localhost-only access, but any process on this machine can modify bot configuration. ' +
            'Set DASHBOARD_ADMIN_TOKEN in your .env for stronger protection.'
          );
        }
      }
    });
  };

  server.once('error', handleBindError);
  startListening();

  if (config.research?.scheduledEnabled) {
    setInterval(() => {
      if (!shouldRunNightlyResearch()) return;
      runNightlyResearch(false).catch((error) => {
        logger.warn(`Nightly research scheduler failed: ${error.message}`);
      });
    }, 60 * 1000);
  }

  return { app, server, wss };
}

module.exports = {
  startDashboard,
  buildSpotTradeMetrics,
  buildTradeProfileAliases,
  computePerpsTradeStats,
  filterTradeHistoryByWindow,
  mergeTradeHistory,
  normalizeTradeLedgerRow,
  summarizeClosedSpotTrades,
};
