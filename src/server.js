'use strict';

const http = require('http');
const { createPaperTelemetry } = require('./telemetry/perps-stats');
const { createPaperExecutionAdapter } = require('./paper/paper-perps-adapter');
const { createPaperSignalProcessor } = require('./paper/paper-signal-processor');

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
      runResearchRequest((options) => replayService.run(options), 'historical-replay');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/study' && replayService) {
      runResearchRequest((options) => replayService.runStudy(options), 'historical-replay-study');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/walk-forward' && replayService) {
      runResearchRequest((options) => replayService.runWalkForward(options), 'walk-forward');
      return;
    } else if (req.method === 'POST' && req.url === '/api/backtests/traderxo/benchmark' && replayService) {
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
