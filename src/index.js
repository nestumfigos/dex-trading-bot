'use strict';

const { createPaperTelemetry } = require('./telemetry/perps-stats');
const { createPaperExecutionAdapter } = require('./paper/paper-perps-adapter');
const { createPaperSignalProcessor } = require('./paper/paper-signal-processor');
const { createBinancePublicPerpsFeed } = require('./market/binance-public-perps');
const { createPaperMarketScanner } = require('./paper/paper-market-scanner');
const { createPublicReplayService } = require('./backtest/public-replay-service');
const { createPaperApiServer } = require('./server');
const { createPaperStrategyAdmission } = require('./paper/paper-strategy-admission');

if (process.env.PERPS_PAPER_SERVICE_ENABLED !== 'true') {
  throw new Error('Perps paper API disabled; set PERPS_PAPER_SERVICE_ENABLED=true only for isolated paper evaluation');
}

const port = Number(process.env.PORT || 3010);
const observationDays = Number(process.env.PERPS_PAPER_OBSERVATION_DAYS || 0);
const telemetry = createPaperTelemetry();
const scannerEnabled = process.env.PERPS_PAPER_MARKET_DATA_ENABLED === 'true';
const symbols = String(process.env.PERPS_PAPER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);
const publicFeed = scannerEnabled ? createBinancePublicPerpsFeed() : null;
// B1P.4: admission required by default. To disable, MUST set
// PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED=false (explicit opt-out). Any other value
// — unset, 'true', 'yes', etc — leaves admission active. Mirror the value into a
// log so operators see what they shipped with.
const admissionRequired = process.env.PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED !== 'false';
if (!admissionRequired) {
  console.warn('[SECURITY] Perps paper admission gate DISABLED via PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED=false');
}
const admission = createPaperStrategyAdmission({ required: admissionRequired });
// B1P.9: mode controls risk caps. 'paper' (default), 'canary' (lev≤3, 1 position, $100 floor), 'live'.
const mode = String(process.env.PERPS_MODE || 'paper').toLowerCase();
if (!['paper', 'canary', 'live'].includes(mode)) {
  throw new Error(`PERPS_MODE must be one of paper|canary|live (got '${mode}')`);
}
const adapter = createPaperExecutionAdapter({ telemetry, entryAdmission: admission, mode });
const processor = createPaperSignalProcessor({ adapter, telemetry });
const scanner = scannerEnabled ? createPaperMarketScanner({
  processor,
  telemetry,
  feed: publicFeed,
  symbols,
  equityUsd: Number(process.env.PERPS_PAPER_EQUITY_USD || 10000),
  leverage: Number(process.env.PERPS_PAPER_LEVERAGE || 3),
  entryAdmission: admission,
}) : null;
const replayService = scannerEnabled ? createPublicReplayService({
  feed: publicFeed,
  allowedSymbols: symbols,
  admission,
}) : null;
const server = createPaperApiServer({
  telemetry,
  adapter,
  processor,
  scanner,
  replayService,
  admission,
  observationDays,
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Perps PAPER telemetry API listening on http://127.0.0.1:${port}; live execution disabled`);
  if (scanner) {
    const intervalMs = Math.max(60000, Number(process.env.PERPS_PAPER_SCAN_INTERVAL_MS || 900000));
    scanner.scanAll().catch((error) => console.error(`Initial paper perps scan failed: ${error.message}`));
    setInterval(() => {
      scanner.scanAll().catch((error) => console.error(`Paper perps scan failed: ${error.message}`));
    }, intervalMs).unref();
    console.log(`Perps PAPER native scanner enabled for ${symbols.join(', ')} every ${intervalMs}ms`);
  }
});
