'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('./utils/logger');
const { enforceRollingWindow, searchArchive, MAX_SIGNALS } = require('./utils/signals-archive');
const { redactObject, redactSecretsInText } = require('./utils/redaction');
const { getPool, ensureSchema, sql } = require('./utils/sqlServer');
const { runRegimeAwareMonteCarlo } = require('./utils/backtest-utils');

function roundMetric(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
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
  const publicDir = path.join(__dirname, 'public');
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
    swingScanIntervalMinutes: { min: 1, max: 10080 },
    momentumExitCheckMinutes: { min: 1, max: 10080 },
    swingExitCheckMinutes: { min: 1, max: 10080 },
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
      if (token !== adminToken) {
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
      if (token !== adminToken) {
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
    res.json(ctx.getDashboardState({ compact: true }));
  });

  app.get('/health', (req, res) => {
    const health = typeof ctx.getHealthStatus === 'function'
      ? ctx.getHealthStatus()
      : { ok: true, timestamp: new Date().toISOString() };

    return res.status(health.ok ? 200 : 503).json(health);
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
      ['swing', 'momentum'].forEach((name) => {
        if (payload.strategies[name] && typeof payload.strategies[name] === 'object') {
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
      ['swing', 'momentum'].forEach((name) => {
        if (payload.strategies[name] && typeof payload.strategies[name] === 'object') {
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
    res.json({ tokens: ctx.getTrackedTokens() });
  });

  app.get('/api/performance', (req, res) => {
    const state = ctx.getDashboardState();
    res.json({
      timestamp: state.timestamp,
      mode: state.mode,
      performanceGate: state.performanceGate,
      portfolio: {
        closedTrades: state.portfolio.closedTrades,
        wins: state.portfolio.wins,
        losses: state.portfolio.losses,
        winRate: state.portfolio.winRate,
        profitFactor: state.portfolio.profitFactor,
        expectancyUsd: state.portfolio.expectancyUsd,
        avgWinUsd: state.portfolio.avgWinUsd,
        avgLossUsd: state.portfolio.avgLossUsd,
        consecutiveLosses: state.portfolio.consecutiveLosses,
        maxConsecutiveLosses: state.portfolio.maxConsecutiveLosses,
        avgSlippageBps: state.portfolio.avgSlippageBps,
        slippageSamples: state.portfolio.slippageSamples,
        realizedPnl: state.portfolio.realizedPnl,
        totalPnl: state.portfolio.totalPnl,
      },
    });
  });

  app.get('/api/strategies', (req, res) => {
    const state = ctx.getDashboardState();
    const strategies = state.portfolio?.strategies || {};
    res.json({
      timestamp: state.timestamp,
      swing: strategies.swing || {},
      momentum: strategies.momentum || {},
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

      const payload = {};
      for (const [key, queryText] of allowedReports[requested]) {
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
      if (configuredSecret && providedSecret !== configuredSecret) {
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

  app.post('/api/paper/reset', requireWriteAccess, (req, res) => {
    try {
      const balance = sanitizeNumber(req.body?.balance, config.paperBalance);
      const snapshot = ctx.resetPaperPortfolio(balance);
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

module.exports = { startDashboard };
