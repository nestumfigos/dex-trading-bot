'use strict';

const fs = require('fs');
const path = require('path');
const { createPaperTelemetry } = require('./telemetry/perps-stats');
const { createPaperExecutionAdapter } = require('./paper/paper-perps-adapter');
const { createPaperSignalProcessor } = require('./paper/paper-signal-processor');
const { createBinancePublicPerpsFeed } = require('./market/binance-public-perps');
const { createBinancePerpsWsConsumer } = require('./market/binance-perps-ws');
const { createKucoinPublicPerpsFeed } = require('./market/kucoin-public-perps');
const { createKucoinPerpsWsConsumer } = require('./market/kucoin-perps-ws');
const { createPaperMarketScanner } = require('./paper/paper-market-scanner');
const { createPublicReplayService } = require('./backtest/public-replay-service');
const { createPaperApiServer } = require('./server');
const { createPaperStrategyAdmission } = require('./paper/paper-strategy-admission');
const { setKucoinUniverse } = require('./strategies/perps-maintenance-margin');

if (process.env.PERPS_PAPER_SERVICE_ENABLED !== 'true') {
  throw new Error('Perps paper API disabled; set PERPS_PAPER_SERVICE_ENABLED=true only for isolated paper evaluation');
}

// K6: source selector. Defaults to KuCoin Futures going forward (USDT-M).
// To roll back to Binance, set PERPS_DATA_SOURCE=binance.
const dataSource = String(process.env.PERPS_DATA_SOURCE || 'kucoin').toLowerCase();
if (!['kucoin', 'binance'].includes(dataSource)) {
  throw new Error(`PERPS_DATA_SOURCE must be one of kucoin|binance (got '${dataSource}')`);
}

const port = Number(process.env.PORT || 3010);
const observationDays = Number(process.env.PERPS_PAPER_OBSERVATION_DAYS || 0);
const telemetry = createPaperTelemetry();
const scannerEnabled = process.env.PERPS_PAPER_MARKET_DATA_ENABLED === 'true';

// K6: KuCoin universe loaded from a refreshed snapshot. Run
// `node scripts/refresh-kucoin-perps-universe.js` to regenerate.
// PERPS_PAPER_SYMBOLS env still takes precedence when set — operator can pin
// to a specific list (e.g. for canary mode). Otherwise we use the full
// snapshot symbol list. Binance source falls back to legacy 3-symbol default.
const KUCOIN_UNIVERSE_PATH = path.resolve(__dirname, '..', 'config', 'kucoin-perps-universe.json');
function loadKucoinUniverseSnapshot() {
  if (!fs.existsSync(KUCOIN_UNIVERSE_PATH)) return null;
  try {
    const raw = fs.readFileSync(KUCOIN_UNIVERSE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[perps] failed to read KuCoin universe snapshot: ${err.message}`);
    return null;
  }
}

// K6 auto-refresh: re-fetch KuCoin /api/v1/contracts/active periodically so
// newly-listed perps appear without an operator restart. Default cadence
// 6h; opt-out via PERPS_KUCOIN_UNIVERSE_REFRESH_HOURS=0. New symbols are added
// to the WS subscription set; removed symbols are unsubscribed. PERPS_PAPER_SYMBOLS
// env override disables auto-refresh (operator explicitly pinned the list).
const { fromKucoinSymbol, isKucoinUsdtmPerp } = require('./utils/perps-symbols');
async function refreshKucoinUniverse() {
  const url = 'https://api-futures.kucoin.com/api/v1/contracts/active';
  const response = await global.fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (!body || body.code !== '200000' || !Array.isArray(body.data)) {
    throw new Error(`invalid response code=${body?.code}`);
  }
  const usdtMargined = body.data.filter((c) => (
    c.settleCurrency === 'USDT'
    && c.status !== 'Closed'
    && isKucoinUsdtmPerp(c.symbol)
  ));
  const contracts = usdtMargined.map((c) => ({
    canonical: fromKucoinSymbol(c.symbol),
    kucoin: c.symbol,
    base: c.baseCurrency,
    quote: c.quoteCurrency,
    settle: c.settleCurrency,
    multiplier: Number(c.multiplier),
    lotSize: Number(c.lotSize),
    tickSize: Number(c.tickSize),
    initialMargin: Number(c.initialMargin),
    maintainMargin: Number(c.maintainMargin),
    maxRiskLimit: Number(c.maxRiskLimit),
    minRiskLimit: Number(c.minRiskLimit),
    riskStep: Number(c.riskStep),
    makerFeeRate: Number(c.makerFeeRate),
    takerFeeRate: Number(c.takerFeeRate),
    turnoverOf24h: c.turnoverOf24h != null ? Number(c.turnoverOf24h) : null,
    volumeOf24h: c.volumeOf24h != null ? Number(c.volumeOf24h) : null,
  }));
  const snapshot = {
    source: 'kucoin-futures',
    refreshedAt: new Date().toISOString(),
    baseUrl: 'https://api-futures.kucoin.com',
    filters: { minVol: 0, top: null },
    count: contracts.length,
    canonicalSymbols: contracts.map((c) => c.canonical),
    contracts,
  };
  fs.writeFileSync(KUCOIN_UNIVERSE_PATH, JSON.stringify(snapshot, null, 2));
  return snapshot;
}

let symbols;
let universeSnapshot = null;
if (dataSource === 'kucoin') {
  universeSnapshot = loadKucoinUniverseSnapshot();
  if (process.env.PERPS_PAPER_SYMBOLS) {
    symbols = process.env.PERPS_PAPER_SYMBOLS
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (universeSnapshot && Array.isArray(universeSnapshot.canonicalSymbols)) {
    symbols = universeSnapshot.canonicalSymbols
      .map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  } else {
    throw new Error('PERPS_DATA_SOURCE=kucoin requires either PERPS_PAPER_SYMBOLS env or a refreshed config/kucoin-perps-universe.json (run scripts/refresh-kucoin-perps-universe.js)');
  }
  if (universeSnapshot) {
    const loaded = setKucoinUniverse(universeSnapshot);
    console.log(`Perps PAPER KuCoin universe loaded: ${universeSnapshot.count} contracts, ${loaded} MM tiers, ${symbols.length} symbols active`);
  }
} else {
  symbols = String(process.env.PERPS_PAPER_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

const publicFeed = scannerEnabled
  ? (dataSource === 'kucoin' ? createKucoinPublicPerpsFeed() : createBinancePublicPerpsFeed())
  : null;

// B6P.ws-wire: subscribe to per-symbol markPrice stream for sizing + liq-buffer
// tracking. K6: routes to KuCoin /contract/instrument or Binance markPrice@1s.
// Opt-out via PERPS_PAPER_MARKPRICE_WS_ENABLED=false. Node 18+ provides global
// WebSocket. Falls back to no-WS (sizing uses entryPrice) on construction err.
let markPriceWs = null;
if (scannerEnabled && process.env.PERPS_PAPER_MARKPRICE_WS_ENABLED !== 'false') {
  try {
    // eslint-disable-next-line global-require
    const WebSocketCtor = (typeof WebSocket === 'function') ? WebSocket : require('ws');
    markPriceWs = dataSource === 'kucoin'
      ? createKucoinPerpsWsConsumer({ WebSocketCtor })
      : createBinancePerpsWsConsumer({ WebSocketCtor });
    markPriceWs.subscribe(symbols);
    const preview = symbols.length <= 6
      ? symbols.join(', ')
      : `${symbols.slice(0, 6).join(', ')} ... (+${symbols.length - 6} more)`;
    console.log(`Perps PAPER markPrice WS (${dataSource}) subscribed: ${preview}`);
  } catch (err) {
    console.warn(`Perps PAPER markPrice WS unavailable: ${err.message}`);
    markPriceWs = null;
  }
}
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
  // B6P.ws-wire: scanner uses this to fetch fresh markPrice per scan tick.
  // Null when WS unavailable; scanner falls back to entryPrice-based sizing.
  getLatestMarkPrice: markPriceWs ? (sym) => markPriceWs.getLatestMarkPrice(sym) : null,
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
// B6P.ws-wire: graceful shutdown for WS consumer.
process.on('SIGINT', () => { if (markPriceWs) markPriceWs.close(); process.exit(0); });
process.on('SIGTERM', () => { if (markPriceWs) markPriceWs.close(); process.exit(0); });

server.listen(port, '127.0.0.1', () => {
  console.log(`Perps PAPER telemetry API listening on http://127.0.0.1:${port}; live execution disabled`);
  if (scanner) {
    const intervalMs = Math.max(60000, Number(process.env.PERPS_PAPER_SCAN_INTERVAL_MS || 900000));
    scanner.scanAll().catch((error) => console.error(`Initial paper perps scan failed: ${error.message}`));
    setInterval(() => {
      scanner.scanAll().catch((error) => console.error(`Paper perps scan failed: ${error.message}`));
    }, intervalMs).unref();
    const previewSymbols = symbols.length <= 6
      ? symbols.join(', ')
      : `${symbols.slice(0, 6).join(', ')} ... (+${symbols.length - 6} more, total ${symbols.length})`;
    console.log(`Perps PAPER native scanner (${dataSource}) enabled for ${previewSymbols} every ${intervalMs}ms`);
  }
  // K6 auto-refresh: skip when operator pinned PERPS_PAPER_SYMBOLS or running
  // on Binance source. Pulls fresh contract list on the configured cadence and
  // diff-subscribes new symbols on the WS feed.
  const refreshHours = Number(process.env.PERPS_KUCOIN_UNIVERSE_REFRESH_HOURS || 6);
  const autoRefreshEnabled = (
    dataSource === 'kucoin'
    && !process.env.PERPS_PAPER_SYMBOLS
    && Number.isFinite(refreshHours)
    && refreshHours > 0
  );
  if (autoRefreshEnabled) {
    const refreshMs = refreshHours * 3600 * 1000;
    const tickRefresh = async () => {
      try {
        const snapshot = await refreshKucoinUniverse();
        const before = new Set(symbols);
        const after = new Set(snapshot.canonicalSymbols.map((s) => String(s).toUpperCase()));
        const added = [...after].filter((s) => !before.has(s));
        const removed = [...before].filter((s) => !after.has(s));
        setKucoinUniverse(snapshot);
        if (markPriceWs && added.length > 0) markPriceWs.subscribe(added);
        if (markPriceWs && removed.length > 0) markPriceWs.unsubscribe(removed);
        symbols.length = 0;
        for (const s of after) symbols.push(s);
        console.log(`[perps] KuCoin universe auto-refresh: +${added.length}/-${removed.length} | total ${symbols.length}`);
      } catch (err) {
        console.warn(`[perps] KuCoin universe auto-refresh failed: ${err.message}`);
      }
    };
    setInterval(tickRefresh, refreshMs).unref();
    console.log(`[perps] KuCoin universe auto-refresh every ${refreshHours}h`);
  }
});

// Crash visibility: silent process death has bitten the paper bot. Surface
// uncaught exceptions + unhandled rejections to stderr before exit so the
// operator sees the cause in logs/stderr.log instead of an empty file.
process.on('uncaughtException', (err) => {
  console.error(`[perps] uncaughtException: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[perps] unhandledRejection: ${reason?.stack || reason?.message || reason}`);
  process.exit(1);
});
