
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('./utils/logger');

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
  const app = express();
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
    if (!adminToken) {
      return res.status(503).json({ error: 'DASHBOARD_ADMIN_TOKEN is required for this endpoint' });
    }

    const authHeader = String(req.headers.authorization || '');
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const headerToken = String(req.headers['x-admin-token'] || '').trim();
    const token = headerToken || bearer;
    if (token !== adminToken) {
      return res.status(401).json({ error: 'Unauthorized' });
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

  app.use(express.static(publicDir));

  app.get('/api/status', (req, res) => {
    res.json(ctx.getDashboardState());
  });

  app.get('/health', (req, res) => {
    const health = typeof ctx.getHealthStatus === 'function'
      ? ctx.getHealthStatus()
      : { ok: true, timestamp: new Date().toISOString() };

    return res.status(health.ok ? 200 : 503).json(health);
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

      if (!priceHistories || Object.keys(priceHistories).length === 0) {
        try {
          const stateFile = path.join(__dirname, '..', 'data', 'state.json');
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

      const matrix = buildCorrelationMatrix(priceHistories);
      res.json({
        ...matrix,
        source,
        historyCount: Object.keys(priceHistories || {}).length,
      });
    } catch (error) {
      logger.error(`Correlation endpoint failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/backtest', requireWriteAccess, async (req, res) => {
    try {
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

  app.post('/api/simulation', requireWriteAccess, async (req, res) => {
    try {
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

  app.get('*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  wss.on('connection', (socket) => {
    logger.info('Dashboard WebSocket client connected');

    const pushState = () => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'state', payload: ctx.getDashboardState() }));
      }
    };

    pushState();
    const interval = setInterval(pushState, 4000);
    socket.on('close', () => clearInterval(interval));
  });

  const bindHost = config.dashboard?.bindHost || '127.0.0.1';
  server.listen(config.bot.port, bindHost, () => {
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
}

module.exports = { startDashboard };
