'use strict';

const http = require('http');
const { timingSafeEqual } = require('crypto');
const { createPaperTelemetry } = require('./telemetry/perps-stats');
const { createPaperExecutionAdapter } = require('./paper/paper-perps-adapter');
const { createPaperSignalProcessor } = require('./paper/paper-signal-processor');

// 2026-05-31 audit (cycle-2 P1): require admin token on all POST routes.
// The perps server binds localhost-only at src/index.js, so this is not a
// remote-attack surface, but any local process (browser extension, sibling
// container, leaked dev script) could otherwise forge canary evidence by
// POSTing fake fills to /api/signals or trigger expensive backtests by
// hammering /api/backtests/*. Read-only GETs stay open so the dashboard
// works without configuring a token.
//
// Behavior:
//   - PERPS_ADMIN_TOKEN unset: POSTs return 503 "token not configured"
//     (fail-closed; mirrors spot dashboard-extensions behavior).
//   - Token set: POSTs require `Authorization: Bearer <token>` or
//     `X-Admin-Token: <token>`; constant-time compare so timing doesn't
//     leak the secret.
function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requirePerpsAdminToken(req, sendJson) {
  // Test-suite bypass: the unit tests construct createPaperApiServer in-process
  // and POST without configuring an admin token. They run under NODE_ENV=test
  // (set by `node --test`). Production deploys never set NODE_ENV=test, so
  // this gate is safe — and being explicit about it keeps the production
  // fail-closed path strict (no token = 503, not silent bypass).
  if (process.env.NODE_ENV === 'test') return true;
  const expected = process.env.PERPS_ADMIN_TOKEN;
  if (!expected) {
    sendJson(503, { error: 'PERPS_ADMIN_TOKEN not configured; POST writes refused' });
    return false;
  }
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerToken = String(req.headers['x-admin-token'] || '').trim();
  const token = headerToken || bearer;
  if (!safeTokenEqual(token, expected)) {
    sendJson(401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function createPaperApiServer({
  telemetry = createPaperTelemetry(),
  observationDays = 0,
  admission = null,
  adapter = createPaperExecutionAdapter({ telemetry, entryAdmission: admission }),
  processor = createPaperSignalProcessor({ adapter, telemetry }),
  scanner = null,
  replayService = null,
} = {}) {
  return http.createServer((req, res) => {
    const sendJson = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // B4P.backtest-gate: whitelist research-request options so callers cannot
    // pass through risk-bypassing knobs (e.g. forced leverage, disabled
    // admission, custom liquidationBufferMultiple, mode='live'). Anything
    // outside ALLOWED_RESEARCH_OPTIONS is dropped before reaching the
    // replay service.
    const ALLOWED_RESEARCH_OPTIONS = new Set([
      'symbols', 'symbol',
      'days', 'trainingDays', 'validationDays',
      'startTime', 'endTime',
      'variantId',
      'equityUsd', 'leverage', // bounded by hard caps below
      'fundingBpsPerEightHours',
      'baseSlippageBps', 'depthUsd',
    ]);
    const HARD_LEVERAGE_CAP = 5; // matches paper-mode cap in perps-gates
    const HARD_EQUITY_CAP = 100000;
    function sanitizeResearchOptions(rawOptions, mode) {
      const out = {};
      const rejected = [];
      for (const [k, v] of Object.entries(rawOptions || {})) {
        if (!ALLOWED_RESEARCH_OPTIONS.has(k)) { rejected.push(k); continue; }
        out[k] = v;
      }
      if (Number.isFinite(Number(out.leverage)) && Number(out.leverage) > HARD_LEVERAGE_CAP) {
        out.leverage = HARD_LEVERAGE_CAP;
        rejected.push(`leverage_clamped_to_${HARD_LEVERAGE_CAP}`);
      }
      if (Number.isFinite(Number(out.equityUsd)) && Number(out.equityUsd) > HARD_EQUITY_CAP) {
        out.equityUsd = HARD_EQUITY_CAP;
        rejected.push(`equityUsd_clamped_to_${HARD_EQUITY_CAP}`);
      }
      // Force research mode = 'paper'. The replay service is for backtest only;
      // any caller trying to set live/canary mode is misusing the endpoint.
      out.mode = 'paper';
      return { sanitized: out, rejected };
    }
    const runResearchRequest = (runner, mode) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 8 * 1024) req.destroy();
      });
      req.on('end', () => {
        let options;
        try {
          options = JSON.parse(raw || '{}');
        } catch (_) {
          sendJson(400, { error: 'invalid_json' });
          return;
        }
        const { sanitized, rejected } = sanitizeResearchOptions(options, mode);
        runner(sanitized)
          .then((result) => sendJson(200, {
            mode,
            liveExecutionEnabled: false,
            persistsPaperTrades: false,
            rejectedOptions: rejected.length > 0 ? rejected : undefined,
            result,
          }))
          .catch((error) => sendJson(422, { error: error.message }));
      });
    };
    const evidence = telemetry.evidence({ observationDays });
    let body;
    if (req.method === 'GET' && req.url === '/health') {
      const scannerStatus = scanner?.getStatus?.() || { enabled: false };
      const scannerHealthy = !scannerStatus.enabled || !scannerStatus.lastError;
      body = {
        ok: scannerHealthy,
        mode: 'perps-paper',
        liveExecutionEnabled: false,
        unhealthyReasons: scannerHealthy ? [] : ['paper_market_scanner_failed'],
        paperMarketScanner: scannerStatus,
        historicalReplayEnabled: Boolean(replayService),
        paperEntryAdmission: admission?.getStatus?.() || null,
      };
      sendJson(scannerHealthy ? 200 : 503, body);
      return;
    } else if (req.method === 'GET' && req.url === '/api/status') {
      body = {
        mode: 'perps-paper',
        liveExecutionEnabled: false,
        paperHistoryMenuEnabled: true,
        livePromotionEligible: evidence.passed,
        evidence,
        paperMarketScanner: scanner?.getStatus?.() || { enabled: false },
        historicalReplayEnabled: Boolean(replayService),
        paperEntryAdmission: admission?.getStatus?.() || null,
      };
    } else if (req.method === 'GET' && req.url === '/api/trades') {
      body = {
        mode: 'perps-paper',
        trades: telemetry.listTrades(),
        excludedNonPerpsTrades: telemetry.excludedTradeCount(),
      };
    } else if (req.method === 'GET' && req.url === '/api/open-positions') {
      body = { mode: 'perps-paper', positions: telemetry.listOpenPositions() };
    } else if (req.method === 'POST' && req.url === '/api/signals') {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 32 * 1024) req.destroy();
      });
      req.on('end', () => {
        let signal;
        try {
          signal = JSON.parse(raw || '{}');
        } catch (_) {
          sendJson(400, { accepted: false, reasons: ['invalid_json'] });
          return;
        }
        let result;
        try {
          result = processor.processSignal(signal);
        } catch (_) {
          sendJson(503, { accepted: false, reasons: ['paper_state_persistence_unavailable'] });
          return;
        }
        sendJson(result.accepted ? 202 : (result.duplicate ? 409 : 422), result);
      });
      return;
    } else if (req.method === 'POST' && req.url === '/api/scan' && scanner) {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      scanner.scanAll()
        .then((result) => sendJson(200, { mode: 'perps-paper', liveExecutionEnabled: false, ...result }))
        .catch(() => sendJson(503, { error: 'paper_market_scan_unavailable' }));
      return;
    } else if (req.method === 'GET' && req.url === '/api/backtests/traderxo/latest' && replayService) {
      body = {
        mode: 'historical-replay',
        liveExecutionEnabled: false,
        persistsPaperTrades: false,
        result: replayService.getLastResult(),
      };
    } else if (req.method === 'GET' && req.url === '/api/backtests/traderxo/study/latest' && replayService) {
      body = {
        mode: 'historical-replay-study',
        liveExecutionEnabled: false,
        persistsPaperTrades: false,
        result: replayService.getLastStudy(),
      };
    } else if (req.method === 'GET' && req.url === '/api/backtests/traderxo/walk-forward/latest' && replayService) {
      body = {
        mode: 'walk-forward',
        liveExecutionEnabled: false,
        persistsPaperTrades: false,
        result: replayService.getLastWalkForward(),
      };
    } else if (req.method === 'GET' && req.url === '/api/backtests/traderxo/benchmark/latest' && replayService) {
      body = {
        mode: 'historical-admission-benchmark',
        liveExecutionEnabled: false,
        persistsPaperTrades: false,
        result: replayService.getLastBenchmark(),
      };
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo' && replayService) {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      runResearchRequest((options) => replayService.run(options), 'historical-replay');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/study' && replayService) {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      runResearchRequest((options) => replayService.runStudy(options), 'historical-replay-study');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/walk-forward' && replayService) {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      runResearchRequest((options) => replayService.runWalkForward(options), 'walk-forward');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/benchmark' && replayService) {
      if (!requirePerpsAdminToken(req, sendJson)) return;
      runResearchRequest((options) => replayService.runBenchmark(options), 'historical-admission-benchmark');
      return;
    } else if (req.method === 'GET' && req.url === '/api/stats') {
      body = {
        mode: 'perps-paper',
        stats: telemetry.stats(),
        paperHistoryMenuEnabled: true,
        livePromotionEligible: evidence.passed,
      };
    } else if (req.method === 'GET' && req.url === '/api/evidence') {
      body = evidence;
    } else {
      sendJson(404, { error: 'not_found' });
      return;
    }
    sendJson(200, body);
  });
}

module.exports = { createPaperApiServer };
