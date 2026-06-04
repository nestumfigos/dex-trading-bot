'use strict';

const BOOT_TIME_MS = Date.now();
require('dotenv').config();

// Crash visibility: surface unhandled rejections + uncaught exceptions to
// stderr before exit. Default Node 18+ behavior is silent exit (especially
// for unhandledRejection on older runtimes) which masks root cause in logs.
function earlyUncaughtExceptionHandler(err) {
  // eslint-disable-next-line no-console
  console.error(`[live] uncaughtException: ${err?.stack || err?.message || err}`);
  process.exit(1);
}
function earlyUnhandledRejectionHandler(reason) {
  // eslint-disable-next-line no-console
  console.error(`[live] unhandledRejection: ${reason?.stack || reason?.message || reason}`);
  process.exit(1);
}
process.on('uncaughtException', earlyUncaughtExceptionHandler);
process.on('unhandledRejection', earlyUnhandledRejectionHandler);

const cron = require('node-cron');
const { ethers } = require('ethers');
const config = require('../config');
const logger = require('./utils/logger');
const RiskGuardian = require('./risk/guardian');
const { applyPositionJitter, getRandomEntryDelay, shouldSplitSolanaTrade, generateSplitTradeSchedule, sleep } = require('./utils/anti-pattern');
const JupiterExchange = require('./exchanges/jupiter');
const PancakeSwapExchange = require('./exchanges/pancakeswap');
const BaseSwapExchange = require('./exchanges/baseswap');
const KuCoinExchange = require('./exchanges/kucoin');
const WebSocketDiscovery = require('./discovery/ws-discovery');
const { startDashboard } = require('./dashboard');
const WalletMonitor = require('./wallet-monitor');
const AITradeBrain = require('./ai/ensemble');
const StrategyBrain = require('./strategy-brain');
const { runBacktest, runBacktestWithRegimes, runWalkForwardBacktest, runRegimeSpecificBacktest, runPortfolioBacktest } = require('./backtest');
const { runPaperSimulation } = require('./simulation');
const { sendHeartbeat, sendTradeAlert, sendErrorAlert, sendHealthAlert, sendSafeModeAlert } = require('./telegram');
const { validateConfig } = require('./utils/validate-config');
const { cleanupNonTradeLogs, getLogCleanupIntervalMs } = require('./utils/log-maintenance');
const { buildDashboardStatePayload } = require('./utils/dashboard-state');
const { createTokenDecisionPipeline } = require('./utils/token-decision-pipeline');
const { createExecutionAccounting } = require('./utils/execution-accounting');
const { createExecutionFlow } = require('./utils/execution-flow');
const {
  calcSlippageBps,
  extractExecutionPriceUsd,
  extractFilledBaseQty,
  extractFilledQuoteUsd,
  calcDiscrepancyPct,
  createSlippageRecorder,
} = require('./utils/execution-extractors');
const { createSellRecovery } = require('./utils/sell-recovery');
const { createExecutionOrchestrator } = require('./execution/orchestrator');
const { createAiDecisionQueue } = require('./ai/decision-queue');
const { createTrackedTokens } = require('./utils/tracked-tokens');
const { createDecisionProposals } = require('./decision/proposals');
const { createDashboardState } = require('./dashboard/state');
const { createLearningBrain } = require('./learning/brain-profiles');
const { createMomentumScoring } = require('./scoring/momentum-rotation');
const { applyTrailingStopState, shouldExtendMaxHold } = require('./execution/exit-helpers');
const { createBscRanking } = require('./chains/bsc-ranking');
const { createIntelligentModelReview } = require('./ai/intelligent-model-review');
const { createExitConditions } = require('./execution/exit-conditions');
const { createMomentumRotator } = require('./rotation/momentum-rotator');
const { createTradeRepairHelpers } = require('./utils/trade-repair');
const { createResearchHandlers } = require('./utils/research-handlers');
const { createSelfEvolutionOrchestration } = require('./utils/self-evolution-orchestration');
const { createStatePersistence } = require('./utils/state-persistence');
const { createWindow, createAnomalyAlerter } = require('./utils/anomaly-detector');
const SelfEvolutionEngine = require('./self-evolution');
const EvolutionGovernor = require('./evolution-governor');
const EvolutionValidator = require('./evolution-validator');
const StrategyLab = require('./strategy-lab');
const MarketIntelligenceAgent = require('./agent/marketIntelligence');
// W16.2 closeout: import via memory facade (core.js). AgentMemory class
// remains the underlying impl; this indirection lets future cleanup migrate
// to pure-composition without touching call sites again.
const _memoryFacade = require('./agent/memory/core');
const SqlCoordination = require('./utils/sqlCoordination');
const { SqlTelemetry, uuid: telemetryUuid } = require('./utils/sqlTelemetry');
const { getSqlStatus, runSelfTest: runSqlSelfTest, hasExplicitDatabase } = require('./utils/sqlServer');
const { execFileSync } = require('child_process');
const {
  refreshKucoinCatalystCache,
  getPrioritizedKucoinCatalystPairs,
  getKucoinCatalystForToken,
} = require('./utils/catalyst');
const { rsi: computeRsi, volumeSpike: computeVolumeSpike, computeRegime } = require('./utils/indicators');
const { analyzeEstablishedTokenPatterns, isEstablishedTokenCandidate } = require('./utils/pattern-recognition');
const { getOhlcvSeries, setKucoinOhlcvProvider } = require('./utils/candles');
const { detectBullFlag } = require('./strategies/bull-flag-detector');
const { createBullFlagEvaluator } = require('./strategies/bull-flag-evaluator');
const { createBackesEvaluator } = require('./strategies/backes-evaluator');
const { createBscFlowEvaluator } = require('./strategies/bsc-flow-evaluator');
const { createBaseDexMomentumReclaimEvaluator } = require('./strategies/base-dex-momentum-reclaim-evaluator');
const { createSolanaBullFlagEvaluator } = require('./strategies/bull-flag-evaluator-solana');
const {
  getDeploymentSummary,
  getImplementedStrategyNames,
  getStrategyOrderForChain,
  isStrategyEnabledForChain,
} = require('./strategies/deployment');
const RUNTIME_STRATEGY_NAMES = getImplementedStrategyNames();
const { executeBuyViaVenue, executeSellViaVenue } = require('./utils/execution-adapter');
const { runPreTrade: runPreTradeContract } = require('./risk/pre-trade-runtime');
const { runHyperopt, runValidation, buildBaseBacktestOptions } = require('./utils/research');
const { computeStrategyVersionHash, normalizeRegimeLabel, classifyRegimeFamily } = require('./utils/promotion-governance');
const { ModelRegistry } = require('./utils/model-registry');
const { buildFeatureSnapshot } = require('./utils/feature-pipeline');
const { fetchTokenSentiment } = require('./utils/sentiment-engine');
const { trainQPolicy, inferRlAction, buildFeatureSeriesFromHistories } = require('./utils/rl-policy');
const { inferExternalRlAction } = require('./utils/external-rl-policy');
const { runHybridDecision } = require('./utils/hybrid-agent-orchestrator');
const OrderBookImbalanceAnalyzer = require('./utils/orderbook-imbalance');
const TimeframeConfluenceAnalyzer = require('./utils/timeframe-confluence');
const PositionSizingEngine = require('./utils/position-sizing');
const RLOnlineUpdater = require('./utils/rl-online-updater');
const ShadowStrategyValidator = require('./utils/shadow-strategy');
const SymbolPnLMemory = require('./utils/symbol-memory');
const BTCMacroFilter = require('./utils/btc-macro-filter');
const fs = require('fs').promises;
const path = require('path');
const redis = require('redis');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BOT_PROFILE = String(process.env.BOT_PROFILE || (process.env.PAPER_TRADING === 'true' ? 'paper' : 'live')).toLowerCase();
const BOT_DATA_DIR = process.env.BOT_DATA_DIR || 'data';
const DATA_DIR_ABS = path.resolve(PROJECT_ROOT, BOT_DATA_DIR);
const STATE_PATH = path.join(DATA_DIR_ABS, 'state.json');
const MARKET_STATE_PATH = path.join(DATA_DIR_ABS, 'marketState.json');
const STATE_BACKUP_PATH = path.join(DATA_DIR_ABS, 'state.backup.json');
const MARKET_STATE_BACKUP_PATH = path.join(DATA_DIR_ABS, 'marketState.backup.json');
const STATE_TMP_PATH = path.join(DATA_DIR_ABS, 'state.tmp.json');
const MARKET_STATE_TMP_PATH = path.join(DATA_DIR_ABS, 'marketState.tmp.json');
const LIVE_ROLLOUT_PATH = path.join(DATA_DIR_ABS, 'evolution-live-rollout.json');
const SELF_EVOLUTION_HISTORY_PATH = path.join(DATA_DIR_ABS, 'self-evolution-history.jsonl');
const CURRENT_STRATEGY_VERSION_HASH = computeStrategyVersionHash({
  config,
  strategies: config.strategies,
  risk: config.risk,
});
const CURRENT_STRATEGY_VERSION_ID = `${BOT_PROFILE}-${CURRENT_STRATEGY_VERSION_HASH}`;

// Runtime singleton guard + lock manager (Week 1b/1c, 2026-05-16).
// Acquires data/runtime-${profile}-${port}.lock with sibling-takeover on dead pid.
// Singleton release registers with lock-manager so boot/lifecycle drains it
// through the graceful shutdown path (no more SIGINT race between sync
// release+exit and async shutdownAndExit drain).
const { acquireRuntimeSingleton } = require('./boot/singleton');
const { installErrorHandlers } = require('./boot/error-handlers');
const lockManager = require('./state/lock-manager');
const configSchema = require('./config/schema');
const configSourceAudit = require('./config/source-audit');

// Week 11.1 — boot-time config integrity. Strict-unknown env var rejection +
// .env vs ecosystem.config.js conflict detection. Both gated by env flags
// (default lenient for grace period; flip to strict after canary).
try {
  const strictMode = String(process.env.CONFIG_STRICT_UNKNOWN || 'false').toLowerCase() === 'true';
  const schemaResult = configSchema.validate(process.env, { strictUnknown: strictMode });
  if (schemaResult.errors.length) {
    if (strictMode) {
      const err = new Error(`[config/schema] validation failed: ${schemaResult.errors.join('; ')}`);
      err.code = 'CONFIG_SCHEMA_INVALID';
      throw err;
    }
    logger.warn(`[config/schema] ${schemaResult.errors.length} error(s): ${schemaResult.errors.join('; ')}`);
  }
  if (schemaResult.warnings.length) {
    logger.info(`[config/schema] ${schemaResult.warnings.join('; ')}`);
  }
} catch (e) {
  if (e.code === 'CONFIG_SCHEMA_INVALID') throw e;
  logger.warn(`[config/schema] check skipped: ${e.message}`);
}

try {
  const lenient = String(process.env.CONFIG_AUDIT_LENIENT || 'true').toLowerCase() === 'true';
  configSourceAudit.auditBoot({
    envPath: require('path').join(__dirname, '..', '.env'),
    ecoPath: require('path').join(__dirname, '..', 'ecosystem.config.js'),
    profile: BOT_PROFILE,
    lenient,
    logger,
  });
} catch (e) {
  if (e.code === 'CONFIG_SOURCE_CONFLICT') {
    logger.error(e.message);
    throw e;
  }
  logger.warn(`[config/source-audit] check skipped: ${e.message}`);
}

acquireRuntimeSingleton({
  dataDirAbs: DATA_DIR_ABS,
  profile: BOT_PROFILE,
  port: config.bot.port,
  logger,
  lockManager,
});

// Global dashboard server reference for graceful shutdown
let dashboardServer = null;
let dashboardWss = null;

// Simple cache with Redis fallback
class Cache {
  constructor() {
    this.memoryCache = new Map();
    this.memoryTimers = new Map();
    this.redisClient = null;
    this.initRedis();
  }

  async initRedis() {
    try {
      this.redisClient = redis.createClient();
      await this.redisClient.connect();
      logger.info('Redis cache connected');
    } catch (error) {
      logger.warn('Redis not available, using memory cache:', error.message);
      this.redisClient = null;
    }
  }

  async get(key) {
    if (this.redisClient) {
      try {
        const value = await this.redisClient.get(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        logger.warn('Redis get error:', error.message);
      }
    }
    return this.memoryCache.get(key) || null;
  }

  async set(key, value, ttlSeconds = 300) {
    const serialized = JSON.stringify(value);
    if (this.redisClient) {
      try {
        await this.redisClient.setEx(key, ttlSeconds, serialized);
        return;
      } catch (error) {
        logger.warn('Redis set error:', error.message);
      }
    }
    clearTimeout(this.memoryTimers.get(key));
    this.memoryCache.set(key, value);
    const timer = setTimeout(() => {
      this.memoryCache.delete(key);
      this.memoryTimers.delete(key);
    }, ttlSeconds * 1000);
    this.memoryTimers.set(key, timer);
  }

  async del(key) {
    if (this.redisClient) {
      try {
        await this.redisClient.del(key);
      } catch (error) {
        logger.warn('Redis del error:', error.message);
      }
    }
    clearTimeout(this.memoryTimers.get(key));
    this.memoryTimers.delete(key);
    this.memoryCache.delete(key);
  }
}

const cache = new Cache();

// Mutex that serialises position entry. Prevents concurrent processToken() calls
// from both passing the position-count check and both writing to portfolio.positions.
// Distributed: file-lock outer guard (cross-process) + in-process FIFO queue.
// Implementation extracted to utils/async-mutex.js Day 7 follow-up.
const { createAsyncMutex } = require('./utils/async-mutex');
const positionMutex = createAsyncMutex({ logger, projectRoot: path.resolve(__dirname, '..'), profile: BOT_PROFILE });
const sqlCoordination = new SqlCoordination({
  logger,
  botId: `${process.env.BOT_PROFILE || 'bot'}:${process.pid}`,
});
const telemetry = new SqlTelemetry({ logger, botProfile: BOT_PROFILE });
const sqlRuntimeState = {
  selfTestOk: false,
  selfTestReason: 'not_run',
  lastSelfTestAt: null,
};

// Track order->position linkage for clean attribution.
const orderToPositionId = new Map();

/**
 * Returns true if the current UTC time falls within any configured trading window.
 * When tradingWindowsEnabled is false, always returns true (24/7 trading).
 * Windows where startUtcHour >= endUtcHour are ignored (invalid range).
 */
function isWithinTradingWindow() {
  if (!config.tradingWindowsEnabled) return true;
  const windows = config.tradingWindows;
  if (!Array.isArray(windows) || windows.length === 0) return true;
  const hourUtc = new Date().getUTCHours();
  return windows.some(
    (w) => Number.isFinite(w.startUtcHour) &&
           Number.isFinite(w.endUtcHour) &&
           w.endUtcHour > w.startUtcHour &&
           hourUtc >= w.startUtcHour &&
           hourUtc < w.endUtcHour
  );
}

const CHAIN_LABELS = {
  solana: 'Solana',
  bsc: 'BSC',
  base: 'Base',
  kucoin: 'KuCoin',
};

const CHAINLINK_FEED_ABI = [
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)',
  'event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)',
];
const UNISWAP_V2_PAIR_ABI = [
  'event Burn(address indexed sender, uint amount0, uint amount1, address indexed to)',
];

class TtlLruCache {
  constructor(maxEntries = 512) {
    this.maxEntries = Math.max(16, Number(maxEntries || 512));
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Number.isFinite(Number(entry.expiresAt)) && Date.now() >= Number(entry.expiresAt)) {
      this.store.delete(key);
      return null;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const normalizedTtlMs = Math.max(500, Number(ttlMs || 2000));
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + normalizedTtlMs,
    });
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }
}

const oraclePriceCache = new TtlLruCache(1024);
const oracleWsProviders = {
  bsc: null,
  base: null,
};
const oracleFeedSubscriptions = {
  bsc: [],
  base: [],
};
let oracleReconnectTimer = null;
let oracleReconnectPending = false;
let oracleStopSuppressReconnectUntil = 0;

function getOracleProviderSocket(provider) {
  if (!provider) return null;
  return provider.websocket || provider._websocket || null;
}

function scheduleOracleWatcherReconnect(reason = 'unknown') {
  if (Date.now() < oracleStopSuppressReconnectUntil) return;
  if (config.risk?.oracleStopEnabled !== true) return;
  if (oracleReconnectPending) return;

  oracleReconnectPending = true;
  const delayMs = Math.max(2000, Number(config.risk?.oracleWsReconnectDelayMs || 5000));
  logger.warn(`Oracle websocket watcher reconnect scheduled in ${delayMs}ms: ${reason}`);
  oracleReconnectTimer = setTimeout(() => {
    oracleReconnectPending = false;
    oracleReconnectTimer = null;
    startOracleStopWatchers();
  }, delayMs);
}

function setOraclePriceCache(cacheKey, value) {
  const ttlMs = Math.max(500, Number(config.risk?.oraclePriceCacheMs || 2000));
  oraclePriceCache.set(cacheKey, value, ttlMs);
}

function getTokenFeedConfig(chainName, tokenAddress, symbol) {
  const feeds = config.risk?.chainlinkFeedByToken || {};
  const chain = String(chainName || '').toLowerCase();
  const addressKey = `${chain}:${String(tokenAddress || '').toLowerCase()}`;
  const symbolKey = `${chain}:${String(symbol || '').toUpperCase()}`;
  return feeds[addressKey] || feeds[symbolKey] || null;
}

async function getChainlinkPriceUsd(chainName, feedAddress) {
  if (!feedAddress || !exchanges?.[chainName]?.provider) return null;
  const cacheKey = `${chainName}:${String(feedAddress).toLowerCase()}`;
  const cached = oraclePriceCache.get(cacheKey);
  if (cached !== null) return cached;

  const provider = exchanges[chainName].provider;
  const feed = new ethers.Contract(feedAddress, CHAINLINK_FEED_ABI, provider);
  const [roundData, decimals] = await Promise.all([
    feed.latestRoundData(),
    feed.decimals(),
  ]);
  const raw = Number(roundData?.[1] || 0);
  const d = Number(decimals || 8);
  const price = raw / (10 ** d);
  if (!Number.isFinite(price) || price <= 0) return null;
  setOraclePriceCache(cacheKey, price);
  return price;
}

async function getPythPriceUsd(feedId) {
  if (!feedId) return null;
  const cacheKey = `pyth:${String(feedId).toLowerCase()}`;
  const cached = oraclePriceCache.get(cacheKey);
  if (cached !== null) return cached;

  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) return null;
  const body = await res.json();
  const parsed = Array.isArray(body?.parsed) ? body.parsed[0] : null;
  const p = Number(parsed?.price?.price || 0);
  const expo = Number(parsed?.price?.expo || 0);
  const price = p * (10 ** expo);
  if (!Number.isFinite(price) || price <= 0) return null;
  setOraclePriceCache(cacheKey, price);
  return price;
}

function clearStopHuntDelay(position, stopType = null) {
  if (!position || !position.pendingStopHunt) return;
  if (!stopType || position.pendingStopHunt.type === stopType) {
    delete position.pendingStopHunt;
  }
}

function shouldDelayBorderlineStop(position, currentPrice, stopLevel, stopType) {
  const delayMs = Math.max(0, Number(config.risk?.stopHuntDelayMs || 30000));
  const borderlinePct = Math.max(0, Number(config.risk?.stopHuntBorderlinePct || 0.35));
  const price = Number(currentPrice || 0);
  const level = Number(stopLevel || 0);
  if (!position || delayMs <= 0 || borderlinePct <= 0 || !Number.isFinite(price) || !Number.isFinite(level) || level <= 0) {
    return false;
  }

  if (price > level) {
    clearStopHuntDelay(position, stopType);
    return false;
  }

  const breachPct = ((level - price) / level) * 100;
  if (!Number.isFinite(breachPct) || breachPct <= 0 || breachPct > borderlinePct) {
    clearStopHuntDelay(position, stopType);
    return false;
  }

  const now = Date.now();
  const existing = position.pendingStopHunt;
  if (!existing || existing.type !== stopType) {
    position.pendingStopHunt = {
      type: stopType,
      stopLevel: level,
      triggeredAt: now,
      releaseAt: now + delayMs,
      lastPrice: price,
    };
    logger.warn(`Borderline ${stopType} detected for ${position.symbol}: delaying exit ${delayMs}ms at ${price.toFixed(8)} vs ${level.toFixed(8)}`);
    return true;
  }

  existing.lastPrice = price;
  existing.stopLevel = level;
  if (now < Number(existing.releaseAt || 0)) {
    return true;
  }

  clearStopHuntDelay(position, stopType);
  return false;
}

/**
 * Smooth dynamic AI confidence floor adjustment based on recent win rate.
 * When WR is low (drowning), tighten floor (raise it) to be more selective.
 * When WR is high (hot streak), loosen floor (lower it) to allow more entries.
 * Returns adjustment in percentage points to add to base floor (positive = stricter).
 */
function getDynamicAiFloorAdjustment(strategyName, lookbackTrades = 20) {
  if (config.risk?.dynamicAiFloorEnabled === false) return 0;
  const trades = Array.isArray(portfolio.strategies?.[strategyName]?.trades)
    ? portfolio.strategies[strategyName].trades
    : [];
  const closed = trades
    .filter((t) => t?.type === 'SELL' && Number.isFinite(Number(t?.pnl)))
    .slice(-lookbackTrades);
  if (closed.length < 5) return 0;
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  const winRatePct = (wins / closed.length) * 100;
  // Linear: at 50% WR adjustment is 0; at 30% WR add +10; at 70% WR add -10
  const slope = Number(config.risk?.dynamicAiFloorSlope || 0.5);
  const target = Number(config.risk?.dynamicAiFloorTargetWinRatePct || 50);
  const maxAdjust = Number(config.risk?.dynamicAiFloorMaxAdjustPct || 12);
  const raw = (target - winRatePct) * slope;
  return Math.max(-maxAdjust, Math.min(maxAdjust, raw));
}

function getHourlyWinRateAdjustment(strategyName, now = new Date()) {
  if (config.risk?.hourlyWinRateModelEnabled === false) {
    return { adjustmentPct: 0, sampleSize: 0, hourUtc: now.getUTCHours(), winRatePct: null };
  }

  const hourUtc = now.getUTCHours();
  const minTrades = Math.max(1, Number(config.risk?.hourlyWinRateMinTrades || 5));
  const adjustPct = Math.max(0, Number(config.risk?.hourlyWinRateThresholdAdjustPct || 5));
  const lowPct = Number(config.risk?.hourlyWinRateLowPct || 40);
  const highPct = Number(config.risk?.hourlyWinRateHighPct || 60);
  const trades = Array.isArray(portfolio.strategies?.[strategyName]?.trades)
    ? portfolio.strategies[strategyName].trades
    : [];

  const hourlyTrades = trades.filter((trade) => {
    if (trade?.type !== 'SELL') return false;
    if (!Number.isFinite(Number(trade?.pnl))) return false;
    const tradeDate = new Date(trade.timestamp || 0);
    return !Number.isNaN(tradeDate.getTime()) && tradeDate.getUTCHours() === hourUtc;
  });

  if (hourlyTrades.length < minTrades) {
    return { adjustmentPct: 0, sampleSize: hourlyTrades.length, hourUtc, winRatePct: null };
  }

  const wins = hourlyTrades.filter((trade) => Number(trade.pnl) > 0).length;
  const winRatePct = (wins / hourlyTrades.length) * 100;
  if (winRatePct <= lowPct) {
    return { adjustmentPct: adjustPct, sampleSize: hourlyTrades.length, hourUtc, winRatePct: round(winRatePct, 1) };
  }
  if (winRatePct >= highPct) {
    return { adjustmentPct: -adjustPct, sampleSize: hourlyTrades.length, hourUtc, winRatePct: round(winRatePct, 1) };
  }
  return { adjustmentPct: 0, sampleSize: hourlyTrades.length, hourUtc, winRatePct: round(winRatePct, 1) };
}

/**
 * Determine the bot's current recovery mode based on aggregate performance.
 * Returns { active, severity, sizeMultiplier, volumeSpikeBoost, requireBothFlowAndVolume, blockExploration, consecutiveWins }
 * severity: 'none' | 'light' | 'moderate' | 'deep'
 */
function getRecoveryMode() {
  if (config.recovery?.enabled === false) {
    return { active: false, severity: 'none', sizeMultiplier: 1, volumeSpikeBoost: 1, requireBothFlowAndVolume: false, blockExploration: false };
  }

  const rc = config.recovery || {};
  const minClosed = Number(rc.minClosedTrades || 8);
  const stats = portfolio.stats || {};
  const closedTrades = Number(stats.closedTrades || 0);
  if (closedTrades < minClosed) {
    return { active: false, severity: 'none', sizeMultiplier: 1, volumeSpikeBoost: 1, requireBothFlowAndVolume: false, blockExploration: false };
  }

  const wins = Number(stats.wins || 0);
  const winRatePct = closedTrades > 0 ? (wins / closedTrades) * 100 : 0;
  const grossProfit = Number(stats.grossProfit || 0);
  const grossLoss = Math.abs(Number(stats.grossLoss || 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const consecutiveWins = Number(stats.consecutiveWins || 0);

  const deepPF = Number(rc.deepProfitFactorThreshold || 0.25);
  const moderatePF = Number(rc.moderateProfitFactorThreshold || 0.55);
  const lightPF = Number(rc.lightProfitFactorThreshold || 0.85);
  const deepWR = Number(rc.deepWinRateThreshold || 28);
  const moderateWR = Number(rc.moderateWinRateThreshold || 38);

  const winsEscapeDeep = Number(rc.winsToEscapeDeep || 3);
  const winsEscapeModerate = Number(rc.winsToEscapeModerate || 2);
  const winsEscapeLight = Number(rc.winsToEscapeLight || 2);

  let severity = 'none';
  if ((profitFactor <= deepPF || winRatePct <= deepWR) && consecutiveWins < winsEscapeDeep) {
    severity = 'deep';
  } else if ((profitFactor <= moderatePF || winRatePct <= moderateWR) && consecutiveWins < winsEscapeModerate) {
    severity = 'moderate';
  } else if (profitFactor <= lightPF && consecutiveWins < winsEscapeLight) {
    severity = 'light';
  }

  if (severity === 'none') {
    return { active: false, severity: 'none', sizeMultiplier: 1, volumeSpikeBoost: 1, requireBothFlowAndVolume: false, blockExploration: false };
  }

  const sizeMultipliers = { deep: Number(rc.deepSizeMultiplier || 0.30), moderate: Number(rc.moderateSizeMultiplier || 0.50), light: Number(rc.lightSizeMultiplier || 0.70) };
  const volumeBoosts    = { deep: Number(rc.deepVolumeSpikeBoost || 2.0), moderate: Number(rc.moderateVolumeSpikeBoost || 1.5), light: Number(rc.lightVolumeSpikeBoost || 1.2) };

  return {
    active: true,
    severity,
    sizeMultiplier: sizeMultipliers[severity],
    volumeSpikeBoost: volumeBoosts[severity],
    requireBothFlowAndVolume: severity === 'deep' || severity === 'moderate',
    blockExploration: severity === 'deep',
    profitFactor: round(profitFactor, 3),
    winRatePct: round(winRatePct, 1),
    closedTrades,
    consecutiveWins,
  };
}

async function getOraclePriceUsdForPosition(position, chainName) {
  if (config.risk?.oracleStopEnabled !== true) return null;
  const chain = String(chainName || '').toLowerCase();
  const tokenAddress = String(position?.address || '').toLowerCase();
  const symbol = String(position?.symbol || '').toUpperCase();

  if (chain === 'bsc' || chain === 'base') {
    const feed = getTokenFeedConfig(chain, tokenAddress, symbol);
    if (!feed) return null;
    return getChainlinkPriceUsd(chain, feed).catch(() => null);
  }

  if (chain === 'solana') {
    const pythFeeds = config.risk?.pythFeedByToken || {};
    const addressKey = `${chain}:${tokenAddress}`;
    const symbolKey = `${chain}:${symbol}`;
    const feedId = pythFeeds[addressKey] || pythFeeds[symbolKey] || null;
    if (!feedId) return null;
    return getPythPriceUsd(feedId).catch(() => null);
  }

  return null;
}

async function runOracleTriggeredStopsForFeed(chainName, feedAddress, eventPriceUsd = null) {
  if (portfolio.safeMode) return;
  const chain = String(chainName || '').toLowerCase();
  const exchange = exchanges[chain];
  if (!exchange || !isExchangeAvailable(chain)) return;

  const targetFeed = String(feedAddress || '').toLowerCase();
  if (!targetFeed) return;

  const positions = Object.values(portfolio.positions || {}).filter((position) => {
    const posChain = normalizeChainKey(position.chainKey || position.chain);
    if (posChain !== chain || position.exitInProgress) return false;
    const feed = getTokenFeedConfig(chain, position.address, position.symbol);
    return String(feed || '').toLowerCase() === targetFeed;
  });

  if (!positions.length) return;

  for (const position of positions) {
    const price = Number(eventPriceUsd || 0) > 0
      ? Number(eventPriceUsd)
      : Number(await getOraclePriceUsdForPosition(position, chain).catch(() => null) || 0);
    if (!Number.isFinite(price) || price <= 0) continue;

    const tokenData = {
      address: position.address,
      symbol: position.symbol,
      chainKey: chain,
      chain: CHAIN_LABELS[chain],
      strategyKey: position.strategyKey || buildTokenKey(chain, position.address),
      price,
      volume24h: 0,
      _oracle: true,
    };

    const strategyName = position.strategy || 'momentum';
    const strategyCfg = config.strategies?.[strategyName] || {};
    const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
    const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
    applyTrailingStopState(position, price, trailingStartMultiplier, trailingStopPct);

    if (position.trailingStop && price <= position.trailingStop) {
      if (shouldDelayBorderlineStop(position, price, position.trailingStop, 'ORACLE_TRAILING_STOP')) {
        continue;
      }
      logger.warn(`ORACLE TRAILING STOP (feed event) for ${position.symbol} on ${chain}: ${price.toFixed(8)} <= ${Number(position.trailingStop).toFixed(8)}`);
      await executeSell(chain, exchange, tokenData, position, 1, 'ORACLE_TRAILING_STOP');
      continue;
    }

    if (price <= position.stopLoss) {
      if (shouldDelayBorderlineStop(position, price, position.stopLoss, 'ORACLE_STOP_LOSS')) {
        continue;
      }
      logger.warn(`ORACLE STOP LOSS (feed event) for ${position.symbol} on ${chain}: ${price.toFixed(8)} <= ${Number(position.stopLoss).toFixed(8)}`);
      await executeSell(chain, exchange, tokenData, position, 1, 'ORACLE_STOP_LOSS');
    }
  }
}

function stopOracleStopWatchers() {
  oracleStopSuppressReconnectUntil = Date.now() + 2000;
  if (oracleReconnectTimer) {
    clearTimeout(oracleReconnectTimer);
    oracleReconnectTimer = null;
  }
  oracleReconnectPending = false;

  Object.keys(oracleWsProviders).forEach((chain) => {
    const provider = oracleWsProviders[chain];
    const subscriptions = Array.isArray(oracleFeedSubscriptions[chain]) ? oracleFeedSubscriptions[chain] : [];
    subscriptions.forEach(({ contract, listener }) => {
      try {
        contract.off('AnswerUpdated', listener);
      } catch (_) {
        // ignore listener detach errors
      }
    });
    oracleFeedSubscriptions[chain] = [];

    if (!provider) return;
    try {
      provider.removeAllListeners('block');
      provider.destroy();
    } catch (_) {
      // ignore teardown errors
    }
    oracleWsProviders[chain] = null;
  });
}

function startOracleStopWatchers() {
  stopOracleStopWatchers();
  if (config.risk?.oracleStopEnabled !== true) return;

  const wsByChain = {
    bsc: config.bsc?.wsUrl,
    base: config.base?.wsUrl,
  };

  Object.entries(wsByChain).forEach(([chain, wsUrl]) => {
    if (!wsUrl) return;
    try {
      const provider = new ethers.WebSocketProvider(wsUrl);
      provider.on('block', () => {
        runRealtimeRiskStopCycle().catch((error) => logger.debug(`Oracle stop WS tick error on ${chain}: ${error.message}`));
      });
      provider.on('error', (error) => {
        logger.warn(`Oracle websocket provider error on ${chain}: ${error.message}`);
        oracleWsProviders[chain] = null;
        scheduleOracleWatcherReconnect(`${chain} provider error`);
      });
      const providerSocket = getOracleProviderSocket(provider);
      if (providerSocket && typeof providerSocket.on === 'function') {
        providerSocket.on('close', (code) => {
          logger.warn(`Oracle websocket connection closed on ${chain} (code=${code})`);
          oracleWsProviders[chain] = null;
          scheduleOracleWatcherReconnect(`${chain} websocket close`);
        });
        providerSocket.on('error', (error) => {
          const msg = error?.message || String(error || 'unknown');
          logger.warn(`Oracle websocket socket error on ${chain}: ${msg}`);
          oracleWsProviders[chain] = null;
          scheduleOracleWatcherReconnect(`${chain} websocket error`);
        });
      }

      const configuredFeeds = Object.entries(config.risk?.chainlinkFeedByToken || {})
        .filter(([key, address]) => {
          if (!address) return false;
          const [kChain] = String(key || '').toLowerCase().split(':');
          return kChain === chain;
        })
        .map(([, address]) => String(address).toLowerCase());

      const uniqueFeeds = [...new Set(configuredFeeds)];
      uniqueFeeds.forEach((feedAddress) => {
        if (!ethers.isAddress(feedAddress)) return;
        const contract = new ethers.Contract(feedAddress, CHAINLINK_FEED_ABI, provider);
        const listener = async (current) => {
          try {
            const decimals = await contract.decimals();
            const raw = Number(current || 0);
            const price = raw / (10 ** Number(decimals || 8));
            if (Number.isFinite(price) && price > 0) {
              const cacheKey = `${chain}:${feedAddress}`;
              setOraclePriceCache(cacheKey, price);
            }
            await runOracleTriggeredStopsForFeed(chain, feedAddress, price);
          } catch (error) {
            logger.debug(`Chainlink feed event handling failed on ${chain}: ${error.message}`);
          }
        };
        contract.on('AnswerUpdated', listener);
        oracleFeedSubscriptions[chain].push({ contract, listener });
      });

      oracleWsProviders[chain] = provider;
      logger.info(`Oracle websocket stop watcher enabled on ${chain}`);
    } catch (error) {
      logger.warn(`Failed to initialize oracle websocket watcher on ${chain}: ${error.message}`);
      scheduleOracleWatcherReconnect(`${chain} init failure`);
    }
  });
}

// Portfolio factory extracted to src/state/portfolio.js (Week 10.1, 2026-05-18).
// Baseline shape; state-persistence.loadState() overlays persisted snapshot on top.
const { createPortfolio } = require('./state/portfolio');
const portfolio = createPortfolio(config);

function makeFilterCycleStats(strategyName = 'momentum') {
  return {
    strategy: strategyName,
    evaluated: 0,
    passed: 0,
    redditBlocked: 0,
    coincapBlocked: 0,
    buyFlowBlocked: 0,
    uniqueBuyerBlocked: 0,
    technicalBlocked: 0,
    aiBlocked: 0,
    riskBlocked: 0,
    gateRejectCounts: {},
    rejectReasons: {
      portfolioHeat: 0,
      balanceDrift: 0,
      roundTripFriction: 0,
      honeypot: 0,
      aiHold: 0,
      aiPending: 0,
      other: 0,
    },
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

function incrementRejectReason(cycleStats, key = 'other') {
  if (!cycleStats?.rejectReasons) return;
  const normalizedKey = Object.prototype.hasOwnProperty.call(cycleStats.rejectReasons, key) ? key : 'other';
  cycleStats.rejectReasons[normalizedKey] = Number(cycleStats.rejectReasons[normalizedKey] || 0) + 1;
}

function classifyRejectReason(reasonOrCode = '') {
  const value = String(reasonOrCode || '').toLowerCase();
  if (!value) return 'other';
  if (value.includes('portfolio_heat') || value.includes('portfolio heat')) return 'portfolioHeat';
  if (value.includes('balance_drift') || value.includes('balance drift')) return 'balanceDrift';
  if (value.includes('round_trip_friction') || value.includes('round-trip friction')) return 'roundTripFriction';
  if (value.includes('honeypot')) return 'honeypot';
  if (value.includes('ai_cached_decision_pending') || value.includes('ai pending')) return 'aiPending';
  if (value.includes('ai_hold') || value.includes('hold')) return 'aiHold';
  return 'other';
}

const filterStatsState = {
  currentCycle: Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((name) => [name, makeFilterCycleStats(name)])),
  recentCycles: Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((name) => [name, []])),
  consecutiveZeroSignalCycles: Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((name) => [name, 0])),
  signalDrought: {
    ...Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((name) => [name, false])),
    global: false,
  },
};

// Operational diagnostics — tracks execution-phase failures invisible to filter stats.
// Self-evolution reads this to detect capacity, chain-diversity, and provider issues.
const operationalDiagnostics = {
  slotBlockedCount: 0,          // times "Max concurrent positions reached" fired at execution time
  nativePriceAbortCount: 0,     // times "native price unavailable or stale" aborted a buy
  dailyLossBlockCount: 0,       // times per-chain daily loss limit blocked a buy
  chainMonopolyHistory: [],     // [{ts, chainBreakdown}] rolling 20-entry window of chain distribution at each buy attempt
  resetAt: Date.now(),
};

const pollingFallbackLastWarnAt = {};
const scanCounterMismatchLastWarnAt = {};
const scanCounterMismatchState = {};
const processStartedAtMs = Date.now();

function warnScanCounterMismatch(scopeKey, context) {
  const now = Date.now();
  const lastWarnAt = Number(scanCounterMismatchLastWarnAt[scopeKey] || 0);
  if (now - lastWarnAt < 120000) {
    return;
  }

  scanCounterMismatchLastWarnAt[scopeKey] = now;
  logger.warn('Scan counter mismatch detected', context);
}

function setScanCounterMismatch(scopeKey, context = null) {
  if (!scopeKey) return;
  if (!context) {
    delete scanCounterMismatchState[scopeKey];
    return;
  }

  scanCounterMismatchState[scopeKey] = {
    ...context,
    scope: scopeKey,
    updatedAt: new Date().toISOString(),
  };
}

function getScanCounterMismatchState() {
  return Object.values(scanCounterMismatchState)
    .sort((left, right) => {
      const l = Date.parse(left?.updatedAt || '') || 0;
      const r = Date.parse(right?.updatedAt || '') || 0;
      return r - l;
    });
}

function ensureRuntimeStateShape() {
  if (!portfolio.runtime || typeof portfolio.runtime !== 'object') {
    portfolio.runtime = {
      totalSeconds: 0,
      lastTickMs: processStartedAtMs,
    };
    return;
  }

  if (!Number.isFinite(Number(portfolio.runtime.totalSeconds)) || Number(portfolio.runtime.totalSeconds) < 0) {
    portfolio.runtime.totalSeconds = 0;
  }

  if (!Number.isFinite(Number(portfolio.runtime.lastTickMs)) || Number(portfolio.runtime.lastTickMs) <= 0) {
    portfolio.runtime.lastTickMs = processStartedAtMs;
  }
}

const {
  ensureLearningStateShape,
  getLearningBrainProfileKey,
  updateBrainProfileFromClosedTrade,
  getLearningTokenKey,
  getLearningSleeveKey,
  markTokenBadPattern,
  updateAdaptiveSleevePerformance,
} = createLearningBrain({ config, logger, portfolio, normalizeChainKey });

function recordRuntimeDelta() {
  ensureRuntimeStateShape();
  ensureLearningStateShape();
  const nowMs = Date.now();
  const lastTickMs = Number(portfolio.runtime.lastTickMs || nowMs);
  const deltaSeconds = Math.max(0, (nowMs - lastTickMs) / 1000);
  portfolio.runtime.totalSeconds = Number(portfolio.runtime.totalSeconds || 0) + deltaSeconds;
  portfolio.runtime.lastTickMs = nowMs;
}

function getRuntimeSnapshot() {
  recordRuntimeDelta();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    totalRuntimeSeconds: Math.round(Number(portfolio.runtime.totalSeconds || 0)),
  };
}

function startFilterCycle(strategyName) {
  if (!RUNTIME_STRATEGY_NAMES.includes(strategyName)) return;
  filterStatsState.recentCycles[strategyName] = filterStatsState.recentCycles[strategyName] || [];
  filterStatsState.consecutiveZeroSignalCycles[strategyName] = Number(filterStatsState.consecutiveZeroSignalCycles[strategyName] || 0);
  filterStatsState.currentCycle[strategyName] = makeFilterCycleStats(strategyName);
}

function classifyFilterReason(cycleStats, reasonText) {
  const reason = String(reasonText || '').toLowerCase();
  if (reason.includes('reddit')) cycleStats.redditBlocked += 1;
  if (reason.includes('coincap')) cycleStats.coincapBlocked += 1;
  if (reason.includes('net buy flow')) cycleStats.buyFlowBlocked += 1;
  if (reason.includes('unique buyers')) cycleStats.uniqueBuyerBlocked += 1;
  incrementRejectReason(cycleStats, classifyRejectReason(reason));

  const gateReasonKey = String(reason || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'other';
  cycleStats.gateRejectCounts[gateReasonKey] = Number(cycleStats.gateRejectCounts[gateReasonKey] || 0) + 1;
}

function recordEvaluatorRejectReasons(cycleStats, details = {}) {
  if (!cycleStats || !details || typeof details !== 'object') return;
  const rawReasons = [
    ...(Array.isArray(details.scannerReasons) ? details.scannerReasons : []),
    ...(Array.isArray(details.reasons) ? details.reasons : []),
    ...(Array.isArray(details.detectorReasons) ? details.detectorReasons : []),
    details.reason,
    details.holdReason,
    details.blockReason,
  ]
    .filter((reason) => reason !== null && reason !== undefined && String(reason).trim() !== '')
    .map((reason) => String(reason));

  const uniqueReasons = [...new Set(rawReasons)];
  if (!uniqueReasons.length) {
    classifyFilterReason(cycleStats, 'technical_hold_unspecified');
    return;
  }

  uniqueReasons.slice(0, 8).forEach((reason) => classifyFilterReason(cycleStats, reason));
}

function buildGateRejectPercentages(gateRejectCounts = {}, evaluated = 0) {
  const denominator = Math.max(1, Number(evaluated || 0));
  const entries = Object.entries(gateRejectCounts || {})
    .map(([reason, count]) => {
      const numericCount = Number(count || 0);
      return [reason, `${((numericCount / denominator) * 100).toFixed(1)}% (${numericCount})`];
    })
    .sort((left, right) => {
      const leftCount = Number(String(left[1]).match(/\((\d+)\)$/)?.[1] || 0);
      const rightCount = Number(String(right[1]).match(/\((\d+)\)$/)?.[1] || 0);
      return rightCount - leftCount;
    })
    .slice(0, 12);
  return Object.fromEntries(entries);
}

function isPipelineRejectReason(reason) {
  const value = String(reason || '').toLowerCase();
  return value.includes('token_data_unavailable')
    || value.includes('ohlcv_unavailable')
    || value.includes('ohlcv_fetch_error')
    || value.includes('fresh_multisource_data_required')
    || value.includes('missing_liquidity')
    || value.includes('required_tax_data_unavailable');
}

function isSignalDroughtCycle(cycleStats = {}) {
  const evaluated = Number(cycleStats.evaluated || 0);
  const passed = Number(cycleStats.passed || 0);
  if (passed > 0) return false;
  if (evaluated <= 0) return true;

  const gateRejectCounts = cycleStats.gateRejectCounts || {};
  const pipelineRejects = Object.entries(gateRejectCounts)
    .filter(([reason]) => isPipelineRejectReason(reason))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const notApplicableRejects = Number(gateRejectCounts.strategy_not_applicable || 0);
  const pipelineThreshold = Number(process.env.SIGNAL_DROUGHT_PIPELINE_REJECT_PCT || 0.5);
  const notApplicableThreshold = Number(process.env.SIGNAL_DROUGHT_NOT_APPLICABLE_REJECT_PCT || 0.95);

  return (pipelineRejects / evaluated) >= pipelineThreshold
    || (notApplicableRejects / evaluated) >= notApplicableThreshold;
}

function finalizeFilterCycle(strategyName) {
  if (!RUNTIME_STRATEGY_NAMES.includes(strategyName)) return;
  filterStatsState.currentCycle[strategyName] = filterStatsState.currentCycle[strategyName] || makeFilterCycleStats(strategyName);
  filterStatsState.recentCycles[strategyName] = filterStatsState.recentCycles[strategyName] || [];
  filterStatsState.consecutiveZeroSignalCycles[strategyName] = Number(filterStatsState.consecutiveZeroSignalCycles[strategyName] || 0);

  const cycleStats = {
    ...filterStatsState.currentCycle[strategyName],
    completedAt: new Date().toISOString(),
  };
  filterStatsState.recentCycles[strategyName].unshift(cycleStats);
  if (filterStatsState.recentCycles[strategyName].length > 10) {
    filterStatsState.recentCycles[strategyName] = filterStatsState.recentCycles[strategyName].slice(0, 10);
  }

  const evaluated = Number(cycleStats.evaluated || 0);
  const passed = Number(cycleStats.passed || 0);
  const passedPct = evaluated > 0 ? ((passed / evaluated) * 100) : 0;

  const droughtCycle = isSignalDroughtCycle(cycleStats);
  if (droughtCycle) {
    filterStatsState.consecutiveZeroSignalCycles[strategyName] += 1;
  } else if (evaluated > 0 || passed > 0) {
    filterStatsState.consecutiveZeroSignalCycles[strategyName] = 0;
  }

  filterStatsState.signalDrought[strategyName] = filterStatsState.consecutiveZeroSignalCycles[strategyName] > 3;
  filterStatsState.signalDrought.global = RUNTIME_STRATEGY_NAMES
    .filter((name) => name !== strategyName || filterStatsState.signalDrought[name] != null)
    .every((name) => Boolean(filterStatsState.signalDrought[name]));
  if (filterStatsState.signalDrought[strategyName]) {
    logger.warn('Signal drought detected', {
      reason: 'no actionable candidates or data pipeline rejects dominated N consecutive cycles',
      consecutiveCycles: filterStatsState.consecutiveZeroSignalCycles[strategyName],
      strategy: strategyName,
    });
  }

  logger.info(
    `Filter stats (cycle): strategy=${strategyName} evaluated=${evaluated} passed=${passed} ` +
    `passedPct=${passedPct.toFixed(1)} redditBlocked=${cycleStats.redditBlocked} coincapBlocked=${cycleStats.coincapBlocked} ` +
    `buyFlowBlocked=${cycleStats.buyFlowBlocked} uniqueBuyerBlocked=${cycleStats.uniqueBuyerBlocked} ` +
    `technicalBlocked=${cycleStats.technicalBlocked} aiBlocked=${cycleStats.aiBlocked} riskBlocked=${cycleStats.riskBlocked} ` +
    `rejects=${JSON.stringify(cycleStats.rejectReasons || {})} ` +
    `gateRejectPct=${JSON.stringify(buildGateRejectPercentages(cycleStats.gateRejectCounts || {}, evaluated))}`
  );
}

const marketState = {
  trackedTokens: {}, // key: { ...tokenData, lastUpdated: ISO string }
  signals: [], // { ...signalData, lastUpdated: ISO string }
  externalSignals: [],
  macroRegime: null,
  backtests: [],
  simulations: [],
  evolution: {
    activeExperiment: null,
    history: [],
    lastPromotion: null,
    lastRollback: null,
  },
};

function clearTrackedTokensAndSignals() {
  Object.keys(marketState.trackedTokens).forEach((key) => {
    delete marketState.trackedTokens[key];
  });
  marketState.signals = [];
  marketState.externalSignals = [];
}

function ingestExternalSignal(raw = {}) {
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return { ok: false, reason: 'symbol_required' };
  }
  const signal = String(raw.signal || 'HOLD').trim().toUpperCase();
  const normalizedSignal = ['BUY', 'SELL', 'HOLD'].includes(signal) ? signal : 'HOLD';
  const entry = {
    id: telemetryUuid(),
    source: String(raw.source || 'webhook').trim().toLowerCase(),
    provider: String(raw.provider || 'tradingview').trim().toLowerCase(),
    symbol,
    chainKey: raw.chain ? normalizeChainKey(raw.chain) : null,
    strategy: raw.strategy ? String(raw.strategy).trim().toLowerCase() : null,
    signal: normalizedSignal,
    confidence: Math.max(0, Math.min(100, Number(raw.confidence || 50))),
    note: String(raw.note || raw.message || '').slice(0, 300),
    expiresAt: new Date(Date.now() + Math.max(5 * 60 * 1000, Number(raw.ttlMs || 60 * 60 * 1000))).toISOString(),
    createdAt: new Date().toISOString(),
  };
  marketState.externalSignals.unshift(entry);
  marketState.externalSignals = marketState.externalSignals
    .filter((item) => Date.parse(item.expiresAt || 0) > Date.now())
    .slice(0, 200);
  telemetry.logOpsEvent({
    severity: 'info',
    category: 'external_signal',
    name: 'webhook_ingested',
    chain_key: entry.chainKey,
    symbol: entry.symbol,
    message: `${entry.provider}:${entry.signal}`.slice(0, 800),
    context: entry,
  });
  return { ok: true, entry };
}

function getActiveExternalSignal(symbol, chainKey = null, strategyName = null) {
  const sym = String(symbol || '').trim().toUpperCase();
  const chain = chainKey ? normalizeChainKey(chainKey) : null;
  const strategy = strategyName ? String(strategyName).trim().toLowerCase() : null;
  const now = Date.now();
  marketState.externalSignals = (marketState.externalSignals || []).filter((item) => Date.parse(item.expiresAt || 0) > now);
  return (marketState.externalSignals || []).find((item) => (
    item.symbol === sym
    && (!item.chainKey || !chain || item.chainKey === chain)
    && (!item.strategy || !strategy || item.strategy === strategy)
  )) || null;
}
const bscDiscoveryLaneCache = new Map();
const bscDiscoveryRankState = {
  lastRankedAt: null,
  summary: null,
};
const liquiditySentinelSubscriptions = new Map();

const brainState = {
  status: 'idle',
  callCount: 0,
  successCount: 0,
  failureCount: 0,
  lastLatencyMs: null,
  lastDecision: null,
  lastError: null,
  lastErrorAt: null,
  model: config.anthropic.model,
};

let statePersistenceError = false;
let saveFailureCount = 0;

const dependencyHealth = {
  solana: { endpoint: config.solana.rpcUrl, lastLatencyMs: null, lastCheckedAt: null, lastError: null },
  bsc: { endpoint: config.bsc.rpcUrl, lastLatencyMs: null, lastCheckedAt: null, lastError: null },
  base: { endpoint: config.base.rpcUrl, lastLatencyMs: null, lastCheckedAt: null, lastError: null },
  kucoin: { endpoint: 'kucoin-rest', lastLatencyMs: null, lastCheckedAt: null, lastError: null },
};

const watchlists = {
  solana: [
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'SLERFDKvkuqPEQdDvFJEQ3TkqARrqHXJGBvNUc9PUMP',
  ],
  bsc: [
    // NOTE: Previous address was malformed (41 chars instead of 42). Removed pending verification.
    '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  ],
  base: [
    '0x4200000000000000000000000000000000000006',
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ],

};

const exchanges = {
  solana: new JupiterExchange(cache),
  bsc: new PancakeSwapExchange(cache),
  base: new BaseSwapExchange(cache),
  kucoin: new KuCoinExchange(cache),
};
setKucoinOhlcvProvider(exchanges.kucoin);

function makeStrategyScanStatusMap() {
  return Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((strategyName) => [
    strategyName,
    { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
  ]));
}

const scanStatus = {
  solana: {
    name: 'Jupiter (Solana)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    discoveredTokens: 0,
    evaluatedTokens: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: makeStrategyScanStatusMap(),
  },
  bsc: {
    name: 'PancakeSwap (BSC)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    discoveredTokens: 0,
    evaluatedTokens: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: makeStrategyScanStatusMap(),
  },
  base: {
    name: 'BaseSwap (Base)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    discoveredTokens: 0,
    evaluatedTokens: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: makeStrategyScanStatusMap(),
  },
  kucoin: {
    name: 'KuCoin (CEX)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    discoveredTokens: 0,
    evaluatedTokens: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: makeStrategyScanStatusMap(),
  },
};

function isStrategyScanEnabled(chainName, strategyName = 'momentum') {
  return isStrategyEnabledForChain({
    config,
    chainName,
    strategyName,
    paperTrading: config.paperTrading,
  });
}

function applyDisabledScanStates() {
  Object.keys(scanStatus).forEach((chainName) => {
    const chainState = scanStatus[chainName];
    if (!chainState?.strategies) return;
    getImplementedStrategyNames().forEach((strategyName) => {
      if (!isStrategyScanEnabled(chainName, strategyName)) {
        chainState.strategies[strategyName] = {
          status: 'disabled',
          currentToken: '-',
          currentPair: '-',
          tokensScanned: 0,
          discoveredTokens: 0,
          evaluatedTokens: 0,
          lastUpdate: null,
        };
      }
    });

    const enabledStates = Object.entries(chainState.strategies)
      .filter(([strategyName]) => isStrategyScanEnabled(chainName, strategyName))
      .map(([, state]) => state);

    if (!enabledStates.length) {
      chainState.status = 'disabled';
      chainState.currentToken = '-';
      chainState.tokensScanned = 0;
      chainState.discoveredTokens = 0;
      chainState.evaluatedTokens = 0;
      chainState.lastUpdate = null;
      chainState.suppressedTokenErrors = 0;
    }

    if (!isStrategyScanEnabled(chainName, 'momentum')) {
      chainState.status = 'disabled';
      chainState.currentToken = '-';
      chainState.tokensScanned = 0;
      chainState.discoveredTokens = 0;
      chainState.evaluatedTokens = 0;
      chainState.lastUpdate = null;
      chainState.suppressedTokenErrors = 0;
    }
  });
}

applyDisabledScanStates();

// Bull-flag evaluator (spot_day_bull_flag strategy). Pure async wrapper around detector.
const bullFlagEvaluator = createBullFlagEvaluator({
  logger,
  fetchOhlcv: getOhlcvSeries,
  detectBullFlag,
});

const backesEvaluator = createBackesEvaluator({
  logger,
  fetchOhlcv: getOhlcvSeries,
});

const bscFlowEvaluator = createBscFlowEvaluator();

const baseDexMomentumReclaimEvaluator = createBaseDexMomentumReclaimEvaluator({
  fetchOhlcv: getOhlcvSeries,
});

const solanaBullFlagEvaluator = createSolanaBullFlagEvaluator({
  logger,
  fetchOhlcv: getOhlcvSeries,
});

// Local strategy adapter used by processToken/scanChain.
const strategy = {
  priceHistory: {},
  volumeHistory: {},

  getHistoryLength(tokenKey) {
    const key = String(tokenKey || '');
    const series = this.priceHistory[key];
    return Array.isArray(series) ? series.length : 0;
  },

  clearHistory(tokenKey) {
    const key = String(tokenKey || '');
    if (!key) return;
    delete this.priceHistory[key];
  },

  refreshSettings() {
    // Adapter uses live config reads in evaluateForStrategy.
  },

  passesStrategyPrefilter(strategyName, chainName, tokenData = {}) {
    return this.getStrategyPrefilterFailureReason(strategyName, chainName, tokenData) == null;
  },

  getStrategyPrefilterFailureReason(strategyName, chainName, tokenData = {}) {
    const cfgBase = config.strategies?.[strategyName] || {};
    const cfg = {
      ...cfgBase,
      ...(cfgBase.perChainOverrides?.[chainName] || {}),
    };
    const volume24hUsd = Number(tokenData.volume24hUsd || tokenData.volume24h || 0);
    const liquidityUsd = Number(tokenData.liquidityUsd || 0);
    const minVol = Number(cfg.min24hVolumeUsd || 0);
    const minLiq = Number(cfg.minLiquidityUsd || 0);
    if (minVol > 0 && volume24hUsd < minVol) return 'prefilter_volume_below_min';
    if (minLiq > 0 && liquidityUsd < minLiq) return 'prefilter_liquidity_below_min';
    if (Number(cfg.minTokenAgeDays || 0) > 0) {
      const ageDays = Number(tokenData.ageDays || tokenData.tokenAgeDays || 0);
      if (ageDays > 0 && ageDays < Number(cfg.minTokenAgeDays)) return 'prefilter_token_age_below_min';
    }
    return null;
  },

  determineApplicableStrategies(tokenData = {}) {
    const chainName = normalizeChainKey(tokenData?.chainKey || tokenData?.chain);
    const lane = String(tokenData?.discoveryLane || '').toLowerCase() || null;
    const applicable = { momentumLane: lane };
    for (const strategyName of getImplementedStrategyNames()) {
      applicable[strategyName] = isStrategyScanEnabled(chainName, strategyName)
        && this.passesStrategyPrefilter(strategyName, chainName, tokenData);
    }
    return applicable;
  },

  async evaluateForStrategy(_tokenKey, strategyName, tokenData = {}) {
    const strategyCfg = config.strategies?.[strategyName] || {};
    const chainName = normalizeChainKey(tokenData?.chainKey || tokenData?.chain);

    // Bull-flag delegate: spot_day_bull_flag uses a separate detector pipeline.
    if (strategyName === 'spot_day_bull_flag') {
      return bullFlagEvaluator.evaluate(tokenData, { config: strategyCfg, chainKey: chainName });
    }

    if (strategyName === 'backes_swing') {
      const result = await backesEvaluator.evaluate(tokenData, { config: strategyCfg, chainKey: chainName });
      if (result?.details?.macroRegime) {
        marketState.macroRegime = {
          regime: result.details.macroRegime,
          reasons: result.details.macroReasons || [],
          scores: result.details.macroScores || {},
          sizeMultiplier: Number(result.details.macroSizeMultiplier || result.details.sizeMultiplier || 1),
          updatedAt: new Date().toISOString(),
          source: 'backes_macro',
        };
      }
      return result;
    }

    if (strategyName === 'bsc_flow_breakout') {
      return bscFlowEvaluator.evaluate(tokenData, { config: strategyCfg, chainKey: chainName });
    }

    if (strategyName === 'base_dex_momentum_reclaim') {
      return baseDexMomentumReclaimEvaluator.evaluate(tokenData, { config: strategyCfg, chainKey: chainName });
    }

    if (strategyName === 'solana_bull_flag_v2') {
      return solanaBullFlagEvaluator.evaluate(tokenData, { config: strategyCfg, chainKey: chainName });
    }

    const adaptiveParams = strategyBrain.getAdaptiveParameters(chainName, strategyName, strategyCfg, tokenData);

    // Accumulate price/volume history and compute RSI + volumeSpike when not provided by exchange (e.g. KuCoin CEX)
    if (tokenData?.price > 0) {
      const histKey = tokenData.strategyKey || buildTokenKey(chainName, tokenData.address);
      recordStrategyTick(histKey, Number(tokenData.price), Number(tokenData.volume24hUsd || tokenData.volume24h || 0));
      const rsiPeriod = Number(strategyCfg?.rsiPeriod || adaptiveParams?.rsiPeriod || 14);
      if (!Number.isFinite(Number(tokenData.rsi)) || tokenData.rsi == null) {
        const computedRsi = computeRsi(this.priceHistory[histKey], rsiPeriod);
        if (Number.isFinite(computedRsi)) tokenData.rsi = computedRsi;
      }
      if (!Number.isFinite(Number(tokenData.volumeSpike)) || !tokenData.volumeSpike) {
        const validVols = this.volumeHistory[histKey].filter((v) => v > 0);
        if (validVols.length >= 8) {
          const computedSpike = computeVolumeSpike(validVols, { method: 'median', minBars: 8 });
          if (Number.isFinite(computedSpike) && computedSpike > 0) tokenData.volumeSpike = computedSpike;
        }
      }
    }

    const rsi = Number(tokenData?.rsi);
    const volumeSpike = Number(tokenData?.volumeSpike || tokenData?.volumeSpikePct || 0);
    const priceChange24h = Number(tokenData?.priceChange24h || 0);
    const buyRatioRecentPct = Number(tokenData?.buyRatioRecentPct || tokenData?.buyRatio10mPct || 0);
    const netBuyFlowUsd10m = Number(tokenData?.netBuyFlowUsd10m || 0);
    const liquidityUsd = Number(tokenData?.liquidityUsd || 0);
    const patternAnalysis = (strategyName === 'backes_swing' || chainName === 'kucoin') && isEstablishedTokenCandidate(tokenData)
      ? await analyzeEstablishedTokenPatterns({ ...tokenData, chainKey: chainName }).catch(() => null)
      : null;

    // --- Recovery mode: tighten entry thresholds when in a losing hole ---
    const recovery = getRecoveryMode();
    if (recovery.active) {
      const discoveryLane = String(tokenData?.discoveryLane || '').toLowerCase();
      if (recovery.blockExploration && discoveryLane === 'exploration') {
        return {
          signal: 'HOLD',
          details: {
            technicalSignal: 'HOLD',
            triggerTimeframe: 'blocked',
            brainArchetype: adaptiveParams.archetype,
            brainArchetypeFamily: adaptiveParams.archetypeFamily,
            brainProfileKey: adaptiveParams.profileKey,
            brainAdjusted: false,
            brainBlockReason: null,
            rsi: Number.isFinite(rsi) ? rsi : null,
            volumeSpike,
            priceChange24h,
            buyRatioRecentPct,
            netBuyFlowUsd10m,
            confidence: 0,
            technicalBlocked: true,
            externalReasons: [`recovery_${recovery.severity}_blocks_exploration`],
          },
        };
      }
    }

    const defaultRsiMin = 40;
    const defaultRsiMax = 75;
    const defaultVolumeSpikeMin = 1.35;
    const defaultStrongMoveThreshold = Number(strategyCfg?.strongMoveThresholdPct || 12);
    const defaultExtremeMoveThreshold = Number(strategyCfg?.extremeMoveThresholdPct || 60);
    const defaultMinBuyRatio = 50;
    const defaultMinNetBuyFlowUsd = 3500;

    const rsiMin = Number(adaptiveParams?.rsiBuyThreshold || strategyCfg?.rsiBuyThreshold || defaultRsiMin);
    const rsiMax = Number(adaptiveParams?.rsiBuyMaxThreshold || strategyCfg?.rsiBuyMaxThreshold || defaultRsiMax);
    const baseVolumeSpikeMin = Number(adaptiveParams?.volumeSpikeMultiplier || strategyCfg?.volumeSpikeMultiplier || defaultVolumeSpikeMin);
    const volumeSpikeMin = recovery.active ? baseVolumeSpikeMin * recovery.volumeSpikeBoost : baseVolumeSpikeMin;
    const minMoveAll = Number(adaptiveParams?.minPriceChange24hPctAll || strategyCfg?.minPriceChange24hPctAll || 0);
    const maxMoveAll = Number(adaptiveParams?.maxPriceChange24hPctAll || strategyCfg?.maxPriceChange24hPctAll || 0);
    const kucoinMinMove = Number(strategyCfg?.minPriceChange24hPctKucoin || minMoveAll || 0);
    const kucoinMaxMove = Number(strategyCfg?.maxPriceChange24hPctKucoin || maxMoveAll || 0);

    const reasons = [];
    let signal = 'HOLD';

    const hasRsi = Number.isFinite(rsi);
    const rsiInRange = hasRsi && rsi >= rsiMin && rsi <= rsiMax;
    const strongMove = priceChange24h >= defaultStrongMoveThreshold;
    const extremeMove = priceChange24h >= defaultExtremeMoveThreshold;
    const volumeConfirmed = Number.isFinite(volumeSpike) && volumeSpike >= volumeSpikeMin;
    const minFlowUsd = Number(strategyCfg?.minNetBuyFlowUsd || config.strategy?.minNetBuyFlowUsd || defaultMinNetBuyFlowUsd);
    const minBuyRatioPct = Number(strategyCfg?.minBuyRatioRecentPct || defaultMinBuyRatio);
    const flowConfirmed = netBuyFlowUsd10m >= minFlowUsd;
    const ratioConfirmed = buyRatioRecentPct >= minBuyRatioPct;
    // For KuCoin (CEX), on-chain flow/ratio data is not available. Treat confirmed volume spike as flow proxy.
    const kucoinFlowProxy = chainName === 'kucoin' && tokenData.buyTx10m === 0 && netBuyFlowUsd10m === 0 && volumeConfirmed;
    const absMove24h = Math.abs(priceChange24h);
    const minMoveForChain = chainName === 'kucoin' ? kucoinMinMove : minMoveAll;
    const maxMoveForChain = chainName === 'kucoin' ? kucoinMaxMove : maxMoveAll;
    const minMoveConfirmed = !(Number.isFinite(minMoveForChain) && minMoveForChain > 0) || absMove24h >= minMoveForChain;
    const maxMoveConfirmed = !(Number.isFinite(maxMoveForChain) && maxMoveForChain > 0) || absMove24h <= maxMoveForChain;
    const rsiGatePassed = rsiInRange || (!hasRsi && (volumeConfirmed || flowConfirmed || ratioConfirmed || strongMove));

    if (!hasRsi) {
      reasons.push('missing_rsi_using_momentum_fallback');
    }

    if (!minMoveConfirmed) reasons.push('move_below_minimum_window');
    if (!maxMoveConfirmed) reasons.push('move_above_max_window_late_chase_guard');
    if (!rsiGatePassed) reasons.push('rsi_not_in_buy_zone');
    if (!(volumeConfirmed || strongMove)) reasons.push('volume_or_momentum_not_confirmed');
    if (!(flowConfirmed || ratioConfirmed || strongMove || kucoinFlowProxy)) reasons.push('buy_flow_not_confirmed');
    if (!(Number.isFinite(liquidityUsd) && liquidityUsd > 0)) reasons.push('missing_liquidity');
    if (patternAnalysis?.strongestPattern?.pattern) reasons.push(`pattern_context:${patternAnalysis.strongestPattern.pattern}`);

    // Recovery mode — in deep/moderate recovery require BOTH volume AND buy-flow (no OR shortcut)
    const recoveryVolumeGate = recovery.requireBothFlowAndVolume
      ? (volumeConfirmed && (flowConfirmed || ratioConfirmed || kucoinFlowProxy))
      : (volumeConfirmed || strongMove);
    const recoveryFlowGate = recovery.requireBothFlowAndVolume
      ? (flowConfirmed || ratioConfirmed || kucoinFlowProxy)
      : (flowConfirmed || ratioConfirmed || strongMove || kucoinFlowProxy);

    if (recovery.active) {
      if (recovery.requireBothFlowAndVolume && !volumeConfirmed) reasons.push(`recovery_${recovery.severity}_requires_volume_confirmed`);
      if (recovery.requireBothFlowAndVolume && !(flowConfirmed || ratioConfirmed || kucoinFlowProxy)) reasons.push(`recovery_${recovery.severity}_requires_flow_confirmed`);
    }

    // Check symbol-specific penalty (repeated losses)
    const symbolPenalty = symbolPnLMemory.getSymbolPenalty(tokenData?.symbol, chainName);

    if (
      minMoveConfirmed
      && maxMoveConfirmed
      && rsiGatePassed
      && recoveryVolumeGate
      && recoveryFlowGate
      && Number.isFinite(liquidityUsd)
      && liquidityUsd > 0
    ) {
      signal = 'BUY';
    }

    // Block entry if symbol has 3+ recent losses (unless very high confidence override)
    if (signal === 'BUY' && symbolPenalty >= 10) {
      // Bug-fix 2026-05-22: was `evaluation?.details?.confidence` but `evaluation` is undefined here
      // (this method PRODUCES the evaluation object). Fall back to tokenData.aiConfidence set
      // upstream by the AI ensemble; default 0.5 if not yet evaluated.
      const currentConfidence = Number(tokenData?.aiConfidence || 0.5);
      const requiredConfidence = 0.70 + (symbolPenalty / 100);

      if (currentConfidence < requiredConfidence) {
        signal = 'HOLD';
        reasons.push(`symbol_loss_recovery: ${symbolPenalty.toFixed(0)}pp penalty, confidence ${(currentConfidence * 100).toFixed(0)}% < required ${(requiredConfidence * 100).toFixed(0)}%`);
      } else {
        reasons.push(`symbol_loss_recovery_override: confidence sufficient (${(currentConfidence * 100).toFixed(0)}% >= ${(requiredConfidence * 100).toFixed(0)}%)`);
      }
    }

    if (signal === 'BUY' && recovery.active) {
      logger.warn(`[RECOVERY:${recovery.severity.toUpperCase()}] BUY signal allowed for ${tokenData?.symbol} | PF=${recovery.profitFactor} WR=${recovery.winRatePct}% | sizeX=${recovery.sizeMultiplier} volBoost=${recovery.volumeSpikeBoost}x`);
    }

    let brainBlockReason = null;
    const brainEntryGate = strategyBrain.shouldAllowEntry(chainName, strategyName, adaptiveParams.archetype);
    if (signal === 'BUY' && !brainEntryGate.allowed) {
      signal = 'HOLD';
      brainBlockReason = brainEntryGate.reason || 'brain_profile_block';
      reasons.push('brain_profile_block');
      reasons.push(brainBlockReason);
    }

    if (signal === 'BUY' && brainEntryGate.exploreBypass) {
      reasons.push('brain_explore_bypass');
    }

    const triggerTimeframe = strategyCfg?.triggerTimeframe || (extremeMove
      ? 'extreme_24h_momentum'
      : (strongMove ? `${strategyName}_strong_move` : `${strategyName}_breakout`));

    // ── Learned bad pattern: hard-ban gate ─────────────────────────────────
    if (signal === 'BUY') {
      const learnedTokenKey = getLearningTokenKey(tokenData);
      const badRecord = learnedTokenKey ? portfolio.learning?.badTokenMemory?.[learnedTokenKey] : null;
      if (badRecord) {
        const banUntilMs = Date.parse(badRecord.banUntil || '');
        const stillBanned = badRecord.hardBan || (Number.isFinite(banUntilMs) && banUntilMs > Date.now());
        if (stillBanned) {
          signal = 'HOLD';
          reasons.push(`learned_hard_ban: ${badRecord.lastReason || 'sell_failed'}`);
        }
      }
    }

    // ── AgentMemory: blacklist gate ──────────────────────────────────────────
    if (signal === 'BUY') {
      const blacklistCheck = agentMemory.isBlacklisted(tokenData?.symbol);
      if (blacklistCheck.blacklisted) {
        signal = 'HOLD';
        reasons.push(`memory_blacklist: ${blacklistCheck.reason}`);
      }
    }

    // ── AgentMemory: lesson block (similar losing pattern detected) ──────────
    if (signal === 'BUY') {
      const lessonCheck = agentMemory.checkLessons(tokenData?.symbol, {
        rsi, volumeSpike, chain: chainName, strategy: strategyName,
        netBuyFlow: netBuyFlowUsd10m,
      });
      if (lessonCheck.blocked) {
        signal = 'HOLD';
        reasons.push(`memory_lesson_block: ${lessonCheck.reason}`);
      } else if (lessonCheck.warned) {
        logger.warn(`[AgentMemory] Pattern warning for ${tokenData?.symbol}: ${lessonCheck.reason}`);
      }
    }

    // ── AgentMemory: deep-research preference boost ───────────────────────────
    const memoryPreference = agentMemory.getTokenPreference(tokenData?.symbol);

    // ── Intelligence: avoid-list gate ──────────────────────────────────────
    const avoidCheck = intelligenceAgent.isOnAvoidList(tokenData?.symbol);
    if (signal === 'BUY' && avoidCheck.avoid) {
      signal = 'HOLD';
      reasons.push(`intelligence_avoid_list: ${avoidCheck.reason}`);
    }

    // ── BTC Macro Risk-Off Filter ───────────────────────────────────────────
    let btcStatus = null;
    if (signal === 'BUY' && config.risk?.btcRiskOffEnabled !== false) {
      const btcCheck = await btcMacroFilter.canEnterAltcoin(tokenData);
      btcStatus = btcCheck.btcStatus;
      if (!btcCheck.allowed) {
        signal = 'HOLD';
        reasons.push(`btc_macro_risk_off: ${btcCheck.reason}`);
        logger.warn(`[BTC-Macro] ${tokenData?.symbol} altcoin BUY blocked: ${btcCheck.reason}`);
      }
    }

    const externalSignal = getActiveExternalSignal(tokenData?.symbol, chainName, strategyName);
    if (signal === 'BUY' && externalSignal?.signal === 'SELL') {
      signal = 'HOLD';
      reasons.push(`external_signal_block:${externalSignal.provider}`);
    }
    if (signal === 'BUY' && patternAnalysis?.bias === 'bearish') {
      signal = 'HOLD';
      reasons.push(`pattern_bearish_bias:${patternAnalysis?.strongestPattern?.pattern || 'higher_timeframe_reversal'}`);
    }

    // ── Intelligence: watchlist boost (add to confidence, log it) ──────────
    const watchlistCheck = signal === 'BUY'
      ? intelligenceAgent.isOnWatchlist(tokenData?.symbol, chainName)
      : { matched: false };
    const sectorBoost = intelligenceAgent.getSectorBoostPct(tokenData);
    const intelligenceBoost = watchlistCheck.matched
      ? Math.min(30, watchlistCheck.confidence / 3)
      : sectorBoost;
    const externalSignalBoost = externalSignal?.signal === 'BUY'
      ? Math.min(12, Math.max(0, Number(externalSignal.confidence || 0) / 8))
      : 0;

    // ── Order book imbalance analysis (bullish if more bids than asks) ─────
    let orderbookBoost = 0;
    let orderbookAnalysis = null;
    try {
      if (signal === 'BUY' && chainName !== 'bsc' && chainName !== 'base') {
        orderbookAnalysis = await orderbookAnalyzer.analyzeOrderbook(
          tokenData?.symbol,
          chainName,
          chainName === 'solana' ? 'jupiter' : 'kucoin'
        );
        if (orderbookAnalysis?.isBullish) {
          orderbookBoost = Math.min(15, orderbookAnalysis.signalStrength / 20);
          if (orderbookBoost > 8) {
            logger.info(`[OrderBook] ${tokenData?.symbol} strong bid/ask imbalance: ${orderbookAnalysis.signalStrength}% bullish`);
          }
        }
      }
    } catch (err) {
      logger.debug(`[OrderBook] Analysis failed for ${tokenData?.symbol}: ${err.message}`);
    }

    if (signal === 'BUY' && ['spot_day_bull_flag', 'solana_bull_flag_v2'].includes(strategyName) && orderbookAnalysis) {
      const bidDepth = Number(orderbookAnalysis.bidDepth || 0);
      const askDepth = Number(orderbookAnalysis.askDepth || 0);
      const maxAskBidDepthRatio = Math.max(1, Number(strategyCfg.maxAskBidDepthRatio || 1.35));
      const minDepthImbalance = Number(strategyCfg.minOrderBookDepthImbalance ?? -0.15);
      const depthImbalance = Number(orderbookAnalysis.depthImbalance);
      const askBidDepthRatio = bidDepth > 0 ? askDepth / bidDepth : null;
      if (askBidDepthRatio && askBidDepthRatio > maxAskBidDepthRatio) {
        signal = 'HOLD';
        reasons.push(`bull_flag_ask_wall:${askBidDepthRatio.toFixed(2)}>${maxAskBidDepthRatio}`);
      } else if (Number.isFinite(depthImbalance) && depthImbalance < minDepthImbalance) {
        signal = 'HOLD';
        reasons.push(`bull_flag_orderbook_depth_imbalance:${depthImbalance.toFixed(2)}<${minDepthImbalance}`);
      }
    }

    // ── Multi-timeframe confluence (1h + 4h alignment) ──────────────────
    let confluenceBoost = 0;
    let confluenceAnalysis = null;
    try {
      confluenceAnalysis = await timeframeConfluenceAnalyzer.analyzeTimeframeConfluence(tokenData, chainName);
      if (confluenceAnalysis && confluenceAnalysis.alignmentScore >= 50) {
        confluenceBoost = timeframeConfluenceAnalyzer.getConfluenceBoost(confluenceAnalysis.alignmentScore);
        if (confluenceAnalysis.alignmentScore >= 75) {
          logger.info(`[Confluence] ${tokenData?.symbol} strong 1h/4h alignment: ${confluenceAnalysis.signal} (${confluenceAnalysis.alignmentScore}%)`);
        }
      }
    } catch (err) {
      logger.debug(`[Confluence] Analysis failed for ${tokenData?.symbol}: ${err.message}`);
    }

    if (signal === 'BUY' && watchlistCheck.matched) {
      logger.warn(`[Intelligence] ${tokenData?.symbol} is on AI watchlist (confidence=${watchlistCheck.confidence}): ${watchlistCheck.reason}`);
    } else if (signal === 'BUY' && sectorBoost > 0) {
      logger.info(`[Intelligence] ${tokenData?.symbol} sector boost +${sectorBoost} from hot sector alignment`);
    }

    // W16.5: optional ML-derived regime override. Multiplies into macroSizeMultiplier
    // when dbo.regime_patterns has an active row for the current regime + strategy.
    // Falls back to neutral (1.0) when table empty / SQL down / no match.
    const macroSizeMultiplierBase = intelligenceAgent.getMacroSizeMultiplier();
    let regimePatternMultiplier = 1.0;
    let regimePatternChainAllowed = true;
    try {
      const _regimeModule = require('./agent/regime-patterns');
      const currentRegime = String(marketState?.macroRegime?.regime || tokenData?.macroRegime || 'unknown').toLowerCase();
      const currentStrategy = String(strategyName || 'momentum').toLowerCase();
      if (currentRegime && currentRegime !== 'unknown') {
        const cached = _regimeModule.getCachedRegimePattern({ regime: currentRegime, strategy: currentStrategy });
        if (cached === undefined) {
          _regimeModule.prefetch({ regime: currentRegime, strategy: currentStrategy });
        } else if (cached) {
          regimePatternMultiplier = _regimeModule.regimePatternSizeMultiplier(cached);
          regimePatternChainAllowed = _regimeModule.chainAllowedByRegimePattern(cached, chainName);
          if (regimePatternMultiplier !== 1.0 || !regimePatternChainAllowed) {
            logger.debug(`[regime_patterns] ${tokenData?.symbol} regime=${currentRegime} mult=${regimePatternMultiplier} chainAllowed=${regimePatternChainAllowed} rec=${cached.recommendation}`);
          }
        }
      }
    } catch (_) { /* never throw — degrade silently */ }
    const macroSizeMultiplier = macroSizeMultiplierBase * regimePatternMultiplier;
    if (signal === 'BUY' && !regimePatternChainAllowed) {
      logger.info(`[regime_patterns] ${tokenData?.symbol} BUY suppressed: chain ${chainName} not allowed for current regime`);
      signal = 'HOLD';
    }

    const memoryBoost = memoryPreference ? memoryPreference.boost : 0;
    if (signal === 'BUY' && memoryBoost > 0) {
      logger.info(`[AgentMemory] ${tokenData?.symbol} deep-research boost +${memoryBoost}: ${(memoryPreference.reason || '').slice(0, 80)}`);
    }
    const confidence = Math.max(0, Math.min(1,
      (rsiInRange ? 0.3 : 0)
      + (volumeConfirmed ? 0.2 : 0)
      + (flowConfirmed ? 0.2 : 0)
      + (ratioConfirmed ? 0.1 : 0)
      + Math.min(0.2, Math.max(0, Math.abs(priceChange24h)) / 200)
      + (patternAnalysis?.bias === 'bullish' ? 0.08 : 0)
      - (patternAnalysis?.bias === 'bearish' ? 0.08 : 0)
      + Math.min(0.15, intelligenceBoost / 100)
      + Math.min(0.08, externalSignalBoost / 100)
      + Math.min(0.1, memoryBoost / 100)
      + Math.min(0.1, orderbookBoost / 100)
      + Math.min(0.15, confluenceBoost / 100)
    ));

    return {
      signal,
      details: {
        technicalSignal: signal,
        triggerTimeframe,
        brainArchetype: adaptiveParams.archetype,
        brainArchetypeFamily: adaptiveParams.archetypeFamily,
        brainProfileKey: adaptiveParams.profileKey,
        brainAdjusted: Boolean(adaptiveParams.hasAdjustments),
        brainBlockReason,
        rsi: Number.isFinite(rsi) ? rsi : null,
        volumeSpike: Number.isFinite(volumeSpike) ? volumeSpike : 0,
        priceChange24h,
        buyRatioRecentPct,
        netBuyFlowUsd10m,
        confidence,
        patternAnalysis,
        establishedTokenPatternEligible: Boolean(patternAnalysis?.applicable),
        intelligenceBoost,
        externalSignal,
        externalSignalBoost,
        intelligenceWatchlist: watchlistCheck.matched,
        intelligenceMacroSentiment: intelligenceAgent.getReport()?.macroSentiment || null,
        macroSizeMultiplier,
        orderbookAnalysis: orderbookAnalysis ? {
          imbalance: Number(orderbookAnalysis.imbalance || 0),
          depthImbalance: Number(orderbookAnalysis.depthImbalance || 0),
          signalStrength: orderbookAnalysis.signalStrength,
          isBullish: orderbookAnalysis.isBullish,
        } : null,
        orderbookBoost,
        confluenceAnalysis: confluenceAnalysis ? {
          alignmentScore: confluenceAnalysis.alignmentScore,
          signal: confluenceAnalysis.signal,
          rsi1h: confluenceAnalysis.details.rsi1h,
          rsi4h: confluenceAnalysis.details.rsi4h,
          trend1h: confluenceAnalysis.details.trend1h,
          trend4h: confluenceAnalysis.details.trend4h,
        } : null,
        confluenceBoost,
        technicalBlocked: signal !== 'BUY',
        externalReasons: signal !== 'BUY' ? reasons : [],
      },
    };
  },

  evaluateExitForStrategy(_tokenKey, strategyName, tokenData = {}, position = {}) {
    const strategyCfg = config.strategies?.[strategyName] || {};
    const price = Number(tokenData?.price || 0);
    const entryPrice = Number(position?.entryPrice || 0);
    if (!(price > 0) || !(entryPrice > 0)) {
      return { shouldExit: false, reason: null, details: { insufficientData: true } };
    }

    const profitPct = ((price - entryPrice) / entryPrice) * 100;
    const rsi = Number(tokenData?.rsi);
    const buyTx10m = Number(tokenData?.buyTx10m || 0);
    const sellTx10m = Number(tokenData?.sellTx10m || 0);
    const tx10mTotal = buyTx10m + sellTx10m;
    const sellRatio10mPct = tx10mTotal > 0 ? (sellTx10m / tx10mTotal) * 100 : 0;
    const priceChange24h = Number(tokenData?.priceChange24h || 0);

    // Volume divergence: compare current volume spike to entry volume spike. A collapsing
    // volume profile while price is fading is a stronger sell signal than RSI alone.
    const entryVolumeSpike = Number(position?.entryVolumeSpike || 0);
    const currentVolumeSpike = Number(tokenData?.volumeSpike || 0);
    const volumeDivergencePct = entryVolumeSpike > 0
      ? ((currentVolumeSpike - entryVolumeSpike) / entryVolumeSpike) * 100
      : 0;
    const hasVolumeCollapse = entryVolumeSpike > 0 && volumeDivergencePct <= -30;

    if (String(strategyName) === 'momentum') {
      const maxSellRatio10m = Number(strategyCfg.maxSellRatioPct10m || 65);
      const bearishRsiFloor = Number(strategyCfg.momentumExitRsiFloor || 32);
      const bearish24hFloor = Number(strategyCfg.momentumExitPriceChange24hFloor || -8);

      if (Number.isFinite(rsi) && rsi <= bearishRsiFloor && sellRatio10mPct >= maxSellRatio10m && profitPct > 0.5) {
        return {
          shouldExit: true,
          reason: 'MOMENTUM_FADE_RSI_SELL_PRESSURE',
          details: { rsi, sellRatio10mPct, profitPct, priceChange24h, volumeDivergencePct },
        };
      }

      if (priceChange24h <= bearish24hFloor && sellRatio10mPct >= maxSellRatio10m + 5 && profitPct > 0.5) {
        return {
          shouldExit: true,
          reason: 'MOMENTUM_REVERSAL_SELL_PRESSURE',
          details: { rsi, sellRatio10mPct, profitPct, priceChange24h, volumeDivergencePct },
        };
      }

      // New: volume collapse on a winning position with rising sell ratio = momentum exhaustion
      if (hasVolumeCollapse && sellRatio10mPct >= 55 && profitPct > 1) {
        return {
          shouldExit: true,
          reason: 'MOMENTUM_VOLUME_COLLAPSE',
          details: { rsi, sellRatio10mPct, profitPct, volumeDivergencePct, entryVolumeSpike, currentVolumeSpike },
        };
      }

      return {
        shouldExit: false,
        reason: null,
        details: { rsi, sellRatio10mPct, profitPct, priceChange24h, volumeDivergencePct },
      };
    }

    const strategyKey = String(strategyName || 'strategy').toUpperCase();
    const exitRsiThreshold = Number(strategyCfg.rsiExitThreshold || 78);
    const minProfitPct = Number(strategyCfg.exitSignalMinProfitPct || 2);
    const maxSellRatioPct = Number(strategyCfg.exitSellPressureRatioPct || 60);

    if (Number.isFinite(rsi) && rsi >= exitRsiThreshold && profitPct > minProfitPct) {
      return {
        shouldExit: true,
        reason: `${strategyKey}_RSI_OVERBOUGHT`,
        details: { rsi, profitPct, priceChange24h, volumeDivergencePct },
      };
    }

    if (hasVolumeCollapse && sellRatio10mPct >= maxSellRatioPct && profitPct > minProfitPct) {
      return {
        shouldExit: true,
        reason: `${strategyKey}_VOLUME_DIVERGENCE`,
        details: { rsi, sellRatio10mPct, profitPct, volumeDivergencePct },
      };
    }

    return {
      shouldExit: false,
      reason: null,
      details: { rsi, sellRatio10mPct, profitPct, priceChange24h, volumeDivergencePct },
    };
  },
};
const risk = new RiskGuardian(portfolio);
const strategyBrain = new StrategyBrain({ config, logger, portfolio });
const orderbookAnalyzer = new OrderBookImbalanceAnalyzer({ logger, config });
const timeframeConfluenceAnalyzer = new TimeframeConfluenceAnalyzer({ logger, config });
const positionSizingEngine = new PositionSizingEngine({ logger, config });
const rlOnlineUpdater = new RLOnlineUpdater({ logger, config });
const shadowStrategyValidator = new ShadowStrategyValidator({ logger, config });
const symbolPnLMemory = new SymbolPnLMemory({ logger, config });
const btcMacroFilter = new BTCMacroFilter({ logger, config, exchanges });
const selfEvolution = new SelfEvolutionEngine({
  config,
  logger,
  projectRoot: PROJECT_ROOT,
});
const evolutionGovernor = new EvolutionGovernor({
  config,
  logger,
  projectRoot: PROJECT_ROOT,
  dataDir: BOT_DATA_DIR,
});
const evolutionValidator = new EvolutionValidator({
  config,
  logger,
  projectRoot: PROJECT_ROOT,
});
const executionAccounting = createExecutionAccounting({
  portfolio,
  logger,
  getRequiredConfirmations,
  extractExecutionPriceUsd,
  extractFilledBaseQty,
  extractFilledQuoteUsd,
});
const {
  setExecutionJournalState,
  markExecutionConfirmed,
  resolveBuyFillMetrics,
  resolveSellFillMetrics,
} = executionAccounting;
const strategyLab = new StrategyLab({
  logger,
  projectRoot: PROJECT_ROOT,
  dataDir: BOT_DATA_DIR,
});
const agentMemory = _memoryFacade.create({ logger, config });
selfEvolution.bindDependencies({ agentMemory, portfolio });
const modelRegistry = new ModelRegistry({ logger, botProfile: BOT_PROFILE });
const intelligenceAgent = new MarketIntelligenceAgent({ portfolio, config, agentMemory, marketState });
// C1 (Phase C): removed dead `MarketAnalyst` instantiation. Class was a
// placeholder with inverted RSI logic (BUY at RSI>70 with 5% capital) and zero
// method calls ever made on the resulting `agent` var. Strategy flow goes
// strategy/evaluators → risk → orchestrator; this never participated.
const walletMonitor = new WalletMonitor(portfolio);
const wsDiscovery = new WebSocketDiscovery();

const rlPolicyManager = {
  async getActivePolicy() {
    if (config.rl?.enabled === false) return null;
    return modelRegistry.getLatestRlPolicy(config.paperTrading ? 'paper_rl_default' : 'live_rl_default');
  },
  inferAction(policyRecord, featureSnapshot) {
    if (!policyRecord?.policy) {
      return { signal: 'HOLD', confidence: 0, score: 0, stateKey: 'missing_policy', q: {} };
    }
    const engine = String(policyRecord?.metrics?.framework || policyRecord?.policy?.framework || policyRecord?.policy?.engine || '').toLowerCase();
    if (engine === 'sb3' || engine === 'stable_baselines3' || engine === 'rllib') {
      return inferExternalRlAction(policyRecord, featureSnapshot).catch(() => ({
        signal: 'HOLD',
        confidence: 0,
        score: 0.5,
        provider: engine,
      }));
    }
    return inferRlAction(policyRecord.policy, featureSnapshot);
  },
};

// Loop timers moved into _mainLoopState (Week 9.3, 2026-05-18) — see src/cycle/main-loop.js.
// _mainLoopState is declared further down; health check reads timer state from there directly.
let scanInFlight = false;
const loopLocks = {
  momentumScan: false,
  kucoinMomentumScan: false,
  bullFlagScan: false,
  momentumExit: false,
  bullFlagExit: false,
  realtimeStop: false,
  selfEvolution: false,
  intelligence: false,
};
RUNTIME_STRATEGY_NAMES.forEach((strategyName) => {
  loopLocks[`${strategyName}Scan`] = false;
  loopLocks[`${strategyName}Exit`] = false;
});

const scanCursorByChainStrategy = {
  kucoin: {
    momentum: 0,
    spot_day_bull_flag: 0,
    backes_swing: 0,
  },
};

function getRotatingScanWindow(tokens, chainName, strategyName) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (!list.length) return [];

  if (chainName !== 'kucoin') {
    return list;
  }

  const perCycleCapRaw = Number(config.bot?.kucoinMaxTokensPerCycle || 0);
  const targetCount = perCycleCapRaw > 0
    ? Math.min(list.length, Math.max(20, perCycleCapRaw))
    : list.length;
  const chainCursor = scanCursorByChainStrategy[chainName] || {};
  const strategyKey = String(strategyName || 'momentum').toLowerCase();
  const start = Number(chainCursor[strategyKey] || 0) % list.length;

  const selected = [];
  for (let i = 0; i < targetCount; i += 1) {
    selected.push(list[(start + i) % list.length]);
  }

  chainCursor[strategyKey] = (start + targetCount) % list.length;
  scanCursorByChainStrategy[chainName] = chainCursor;
  return selected;
}

// Tracks the wall-clock timestamp of the most recent successful completion of each scheduled loop.
// null = loop has not completed even once since startup.
const loopLastCompletedAt = {
  momentumScan: null,
  bullFlagScan: null,
  momentumExit: null,
  bullFlagExit: null,
  realtimeStop: null,
  walletBalanceRefresh: null,
};
RUNTIME_STRATEGY_NAMES.forEach((strategyName) => {
  loopLastCompletedAt[`${strategyName}Scan`] = null;
  loopLastCompletedAt[`${strategyName}Exit`] = null;
});

function refreshScanInFlightFlag() {
  scanInFlight = Object.entries(loopLocks).some(([key, value]) => Boolean(value) && key.endsWith('Scan'))
    || Boolean(loopLocks.kucoinMomentumScan);
}

function setStatePersistenceError(enabled) {
  const next = Boolean(enabled);
  statePersistenceError = next;
  portfolio.statePersistenceError = next;
}

// Main loop scheduler extracted to src/cycle/main-loop.js (Week 9.3, 2026-05-18).
// State pattern: module mutates _mainLoopState.<timer> via setInterval; index.js
// health check reads timers directly from _mainLoopState for observability.
const _mainLoopModule = require('./cycle/main-loop');
const _mainLoopState = {
  scanTimer: null,
  momentumScanTimer: null,
  bullFlagScanTimer: null,
  momentumExitTimer: null,
  bullFlagExitTimer: null,
  strategyScanTimers: {},
  strategyExitTimers: {},
  realtimeStopTimer: null,
  walletBalanceRefreshTimer: null,
  bscNativePriceRefreshTimer: null,
  selfEvolutionTimer: null,
  selfEvolutionBootTimer: null,
  intelligenceTimer: null,
  intelligenceBootTimer: null,
  bscNativePriceBootTimer: null,
  rlTrainingTimer: null,
  mlTrainingSchedulerDispose: null,
};

function setLoopLocks(enabled) {
  return _mainLoopModule.setLoopLocks({ loopLocks, enabled, refreshScanInFlightFlag });
}

function stopSchedulersForSafeMode() {
  return _mainLoopModule.stopSchedulersForSafeMode({
    state: _mainLoopState,
    deps: { stopOracleStopWatchers },
    loopLocks,
    refreshScanInFlightFlag,
  });
}

// reconcileWalletPositions extracted to src/cycle/reconciliation.js (Week 9.2, 2026-05-18).
// 322-line body now lives in the factory below; index.js binds to the factory output.

const _safeModeFsm = require('./state/safe-mode');

async function enterSafeMode(reason) {
  return _safeModeFsm.enter({
    reason,
    portfolio,
    logger,
    stopSchedulers: stopSchedulersForSafeMode,
    onPersistError: setStatePersistenceError,
    onAlert: sendSafeModeAlert,
    onReconcile: reconcileWalletPositions,
  });
}

function clearSafeModeState() {
  return _safeModeFsm.clear({
    portfolio,
    onPersistError: setStatePersistenceError,
    onLoopLocks: setLoopLocks,
  });
}

function getStrategyScanStatus(chainName, strategyName) {
  return scanStatus[chainName]?.strategies?.[strategyName] || scanStatus[chainName];
}

function syncChainScanStatus(chainName) {
  const chainState = scanStatus[chainName];
  const strategyState = chainState?.strategies;
  if (!chainState || !strategyState) return;

  const strategyEntries = Object.entries(strategyState);
  const states = strategyEntries.map(([, state]) => state || {});
  const nowIso = new Date().toISOString();

  const checkStrategyCounters = (strategyName, scanned, evaluated) => {
    const scopeKey = `${chainName}:${strategyName}`;
    if (scanned === evaluated) {
      delete scanCounterMismatchLastWarnAt[scopeKey];
      setScanCounterMismatch(scopeKey, null);
      return;
    }

    const mismatch = {
      reason: 'strategy evaluated/scanned mismatch',
      chain: chainName,
      strategy: strategyName,
      scanned,
      evaluated,
      delta: evaluated - scanned,
    };

    setScanCounterMismatch(scopeKey, mismatch);
    warnScanCounterMismatch(scopeKey, mismatch);
  };

  strategyEntries.forEach(([strategyName, state]) => {
    checkStrategyCounters(
      strategyName,
      Number(state?.tokensScanned || 0),
      Number(state?.evaluatedTokens || 0)
    );
  });

  chainState.tokensScanned = states.reduce((sum, state) => sum + Number(state.tokensScanned || 0), 0);
  chainState.discoveredTokens = states.reduce((sum, state) => sum + Number(state.discoveredTokens || 0), 0);
  chainState.evaluatedTokens = states.reduce((sum, state) => sum + Number(state.evaluatedTokens || 0), 0);

  if (chainState.tokensScanned === chainState.evaluatedTokens) {
    delete scanCounterMismatchLastWarnAt[chainName];
    setScanCounterMismatch(chainName, null);
  } else {
    const mismatch = {
      reason: 'chain evaluated/scanned mismatch',
      chain: chainName,
      scanned: chainState.tokensScanned,
      evaluated: chainState.evaluatedTokens,
      delta: chainState.evaluatedTokens - chainState.tokensScanned,
    };

    setScanCounterMismatch(chainName, mismatch);
    warnScanCounterMismatch(chainName, mismatch);
  }

  const scanningState = states.find((state) => state.status === 'scanning') || null;
  chainState.currentToken = scanningState?.currentToken || '-';

  if (scanningState) {
    chainState.status = 'scanning';
  } else if (states.some((state) => state.status === 'error')) {
    chainState.status = 'error';
  } else if (states.some((state) => state.status === 'degraded')) {
    chainState.status = 'degraded';
  } else {
    chainState.status = 'idle';
  }

  const latest = states
    .map((state) => Number.isFinite(Date.parse(state.lastUpdate || '')) ? Date.parse(state.lastUpdate) : 0)
    .reduce((max, value) => Math.max(max, value), 0);
  chainState.lastUpdate = latest > 0 ? new Date(latest).toISOString() : (chainState.lastUpdate || nowIso);
}
const aiCircuit = {
  failures: 0,
  cooldownUntil: 0,
};

function normalizeConfidencePercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

const {
  buildAiDecisionCacheKey,
  getAiDecisionCacheTtlMs,
  hasFreshAiDecision,
  scoreAiDecisionCandidate,
  removeAiDecisionQueueCandidate,
  cacheAiDecisionCandidate,
  getAiDecisionCacheStatus,
  getCachedAiDecision,
  pumpAiDecisionQueue,
  queueAiDecisionRefresh,
} = createAiDecisionQueue({
  config,
  aiCircuit,
  AITradeBrain,
  normalizeChainKey,
  round,
  logger,
  recordBrainSuccess,
  recordBrainFailure,
  normalizeConfidencePercent,
});

const {
  toCompactTrackedToken,
  toCompactSignal,
  getTrackedTokens,
  recordSignalEvent,
  summarizeBuyFailureReason,
  recordBuyFailureState,
  recordTradeBlockState,
  buildMomentumMetrics,
  isStrongMomentumSnapshot,
  normalizeRotationVolumeSpike,
  buildMomentumState,
  updateTrackedToken,
  refreshTrackedOpenPositionSnapshot,
} = createTrackedTokens({
  marketState,
  portfolio,
  config,
  strategy,
  telemetry,
  CHAIN_LABELS,
  normalizeChainKey,
  buildTokenKey,
  round,
  normalizeConfidencePercent,
  getAiDecisionCacheStatus,
});

const { scoreMomentumCandidate, scoreOpenMomentumPosition } = createMomentumScoring({
  config,
  marketState,
  round,
  normalizeChainKey,
  normalizeConfidencePercent,
  buildMomentumMetrics,
  buildMomentumState,
  normalizeRotationVolumeSpike,
});

const { rankBscMomentumUniverse } = createBscRanking({
  config,
  logger,
  setBscDiscoveryLaneMetadata,
});

const { applyIntelligentModelReview } = createIntelligentModelReview({
  config,
  logger,
  strategy,
  modelRegistry,
  rlPolicyManager,
  fetchTokenSentiment,
  buildFeatureSnapshot,
  computeRegime,
  runHybridDecision,
});

const {
  safeDecisionText,
  deriveIncidentState,
  buildDecisionProposal,
  buildDecisionRiskReview,
  approvePortfolioDecision,
  queueDecisionTelemetry,
  buildDecisionReflection,
} = createDecisionProposals({
  config,
  BOT_PROFILE,
  CURRENT_STRATEGY_VERSION_ID,
  portfolio,
  sqlRuntimeState,
  telemetry,
  telemetryUuid,
  normalizeChainKey,
  normalizeRegimeLabel,
  isBtcRiskOff,
  getBtcRiskOffReason,
  getActivePromotionRolloutContext,
  getAiDecisionCacheStatus,
  getStatePersistenceError: () => statePersistenceError,
});

const { buildDashboardState, getAgentActionFeed } = createDashboardState({
  config,
  portfolio,
  marketState,
  risk,
  round,
  CHAIN_LABELS,
  buildDashboardStatePayload,
  getRuntimeSnapshot,
  getScanCounterMismatchState,
  getTrackedTokens,
  toCompactSignal,
  getHealthStatus,
  getPortfolioSnapshot,
  getPrioritizedKucoinCatalystPairs,
  getScanStatus: () => scanStatus,
  getBrainState: () => brainState,
  getFilterStatsState: () => filterStatsState,
  getAgentMemory: () => agentMemory,
  getIntelligenceAgent: () => intelligenceAgent,
});

const tokenDecisionPipeline = createTokenDecisionPipeline({
  config,
  logger,
  aiCircuit,
  operationalDiagnostics,
  agentMemory,
  risk,
  strategy,
  AITradeBrain,
  getStrategyScanStatus,
  syncChainScanStatus,
  removeAiDecisionQueueCandidate,
  getHourlyWinRateAdjustment,
  getDynamicAiFloorAdjustment,
  cacheAiDecisionCandidate,
  queueAiDecisionRefresh,
  getCachedAiDecision,
  recordBrainSuccess,
  recordBrainFailure,
  getAiDecisionCacheStatus,
  refreshBrainAvailability,
  incrementRejectReason,
  tryRotateForStrongerMomentum: (...args) => tryRotateForStrongerMomentum(...args),
  approvePortfolioDecision,
  queueDecisionTelemetry,
  recordTradeBlockState,
  classifyRejectReason,
  executeBuy: (...args) => executeBuy(...args),
  enterSafeMode,
  sendErrorAlert,
});
const {
  updateTokenScanState,
  runTokenEligibilityGates,
  applyAiReviewToEvaluation,
  handleApprovedTradeDecision,
} = tokenDecisionPipeline;
const exchangeCircuit = {
  solana: { failures: 0, cooldownUntil: 0, initialized: false, lastError: null },
  bsc: { failures: 0, cooldownUntil: 0, initialized: false, lastError: null },
  base: { failures: 0, cooldownUntil: 0, initialized: false, lastError: null },
  kucoin: { failures: 0, cooldownUntil: 0, initialized: false, lastError: null },
};

function recordExchangeFailure(chainName, message) {
  const state = exchangeCircuit[chainName];
  if (!state) return;
  state.failures += 1;
  state.lastError = message;
  logger.warn(
    `${chainName} exchange failure ${state.failures}/${config.bot.exchangeFailureThreshold}: ${message}`
  );
  if (state.failures >= config.bot.exchangeFailureThreshold) {
    state.cooldownUntil = Date.now() + (config.bot.exchangeFailureCooldownSeconds * 1000);
    logger.warn(`${chainName} exchange circuit opened for ${config.bot.exchangeFailureCooldownSeconds}s after repeated failures.`);
    state.failures = 0;
  }
}

function recordExchangeSuccess(chainName) {
  const state = exchangeCircuit[chainName];
  if (!state) return;
  if (state.failures > 0 || state.cooldownUntil > 0 || state.lastError) {
    logger.info(`${chainName} exchange circuit recovered and counters were reset.`);
  }
  state.failures = 0;
  state.cooldownUntil = 0;
  state.lastError = null;
}

function isExchangeAvailable(chainName) {
  const state = exchangeCircuit[chainName];
  if (!state) return false;
  if (!state.initialized) return false;
  if (state.cooldownUntil > Date.now()) return false;
  if (dependencyHealth[chainName]?.lastError) return false;
  return true;
}

async function probeExchangeHealth(chainName, exchange) {
  const state = dependencyHealth[chainName];
  if (!state || !exchange) return;

  const startedAt = Date.now();
  try {
    if (chainName === 'solana') {
      await exchange.connection.getLatestBlockhash('confirmed');
      state.endpoint = exchange.connection?.rpcEndpoint || config.solana.rpcUrl;
    } else if (chainName === 'bsc' || chainName === 'base') {
      if (!exchange.provider) throw new Error('RPC provider not initialized');
      await exchange.provider.getBlockNumber();
      state.endpoint = exchange.provider?._getConnection?.().url || state.endpoint;
    } else if (chainName === 'kucoin') {
      if (!exchange.exchange) throw new Error('KuCoin client not initialized');
      if (typeof exchange.exchange.fetchTime === 'function') {
        await exchange.exchange.fetchTime();
      } else {
        await exchange.exchange.loadMarkets();
      }
      state.endpoint = exchange.exchange.id || 'kucoin-rest';
    }

    state.lastLatencyMs = Date.now() - startedAt;
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = null;
  } catch (error) {
    state.lastLatencyMs = Date.now() - startedAt;
    state.lastCheckedAt = new Date().toISOString();
    state.lastError = error.message;
    // 2026-05-23: throttle warn to once per 5min per chain so RPC 429 loops
    // don't flood combined.log (was firing every cycle on transient outage).
    const nowMs = Date.now();
    if (!state._lastWarnAt || nowMs - state._lastWarnAt > 5 * 60_000) {
      logger.warn(`${chainName} dependency health check failed: ${error.message}`);
      state._lastWarnAt = nowMs;
    }
  }
}

async function refreshDependencyHealth() {
  await Promise.allSettled(
    Object.entries(exchanges).map(([chainName, exchange]) => probeExchangeHealth(chainName, exchange))
  );
}

async function saveState() {
  return statePersistence.saveState();
}

function buildSerializableStatePayload() {
  return statePersistence.buildSerializableStatePayload();
}

async function persistSqlStateSnapshot(snapshotKind = 'periodic') {
  return statePersistence.persistSqlStateSnapshot(snapshotKind);
}

async function loadSelfEvolutionHistoryEntries(limit = 250) {
  return statePersistence.loadSelfEvolutionHistoryEntries(limit);
}

async function syncQueryableSqlState() {
  return statePersistence.syncQueryableSqlState();
}

async function tryLoadStateFromSqlSnapshot() {
  return statePersistence.tryLoadStateFromSqlSnapshot();
}

async function loadState() {
  return statePersistence.loadState();
}

function normalizeChainKey(chain) {
  const value = String(chain || '').trim().toLowerCase();
  if (value.includes('sol')) return 'solana';
  if (value.includes('bsc') || value.includes('binance')) return 'bsc';
  if (value.includes('base')) return 'base';
  if (value.includes('kucoin')) return 'kucoin';
  logger.warn(`normalizeChainKey: unrecognized chain string "${chain}", using as-is`);
  return value;
}

function buildTokenKey(chainName, tokenAddress) {
  return `${String(chainName || '').trim().toLowerCase()}:${String(tokenAddress || '').trim().toLowerCase()}`;
}

const OPERATOR_RUNBOOKS = {
  sql_unhealthy: {
    title: 'SQL degraded',
    summary: 'Check SQL connectivity, explicit database selection, and schema readiness before trusting reports or state writes.',
    steps: [
      'Run npm run sql:init to ensure schema and views exist.',
      'Verify SQL_CONNECTION_STRING points at the expected database and instance.',
      'Inspect dashboard SQL status and recent SQL errors in logs.',
    ],
  },
  safe_mode_active: {
    title: 'Safe mode active',
    summary: 'Bot has entered capital-protection mode after a serious execution or reconciliation issue.',
    steps: [
      'Review recent execution failures and balance drift diagnostics.',
      'Confirm exchange connectivity and wallet balances before resuming.',
      'Clear safe mode only after the triggering fault is understood.',
    ],
  },
  loop_stalled_or_timer_missing: {
    title: 'Loop stalled',
    summary: 'One or more core scan or exit loops are stale or missing a timer.',
    steps: [
      'Inspect PM2 logs for uncaught loop errors.',
      'Check dashboard health loop timestamps and stale flags.',
      'Restart the affected bot only after confirming root cause.',
    ],
  },
  strategy_exit_checks_degraded: {
    title: 'Exit checks degraded',
    summary: 'One or more strategy exit loops are skipping work or hitting repeated errors.',
    steps: [
      'Inspect skipped exit checks and exitErrorCount in dashboard health.',
      'Review market-data availability for affected positions.',
      'Treat open positions cautiously until exit checks are healthy again.',
    ],
  },
  exchange_dependency_unhealthy: {
    title: 'Exchange dependency unhealthy',
    summary: 'One or more exchange or RPC dependencies are degraded.',
    steps: [
      'Review dependency health in the dashboard and recent RPC errors.',
      'Confirm upstream API or RPC availability outside the bot.',
      'Reduce exposure or disable affected chains if failures persist.',
    ],
  },
  state_persistence_error: {
    title: 'State persistence error',
    summary: 'Primary state save path is failing and needs immediate attention.',
    steps: [
      'Inspect SQL self-test and state snapshot write errors.',
      'Check filesystem backup path permissions if SQL fallback was used.',
      'Do not delete backup state files until the save path is healthy again.',
    ],
  },
};


function getBscDiscoveryLaneMetadata(tokenAddress) {
  const key = String(tokenAddress || '').trim().toLowerCase();
  return bscDiscoveryLaneCache.get(key) || null;
}

function getActivePromotionRolloutContext() {
  const rollout = marketState.evolution?.liveRollout || null;
  if (!rollout || BOT_PROFILE !== 'live' || config.paperTrading) return null;
  const stage = String(rollout.stage || '').toLowerCase();
  if (!stage) return null;
  const regimeFamily = normalizeRegimeLabel(rollout.regimeFamily || '');
  const canaryLiveSizePct = Number(rollout.canaryLiveSizePct || config.selfEvolution?.governance?.canaryLiveSizePct || 10);
  return {
    stage,
    regimeFamily: classifyRegimeFamily(rollout.regimeFamily || ''),
    canaryLiveSizePct: Number.isFinite(canaryLiveSizePct) ? canaryLiveSizePct : 10,
  };
}

function setBscDiscoveryLaneMetadata(rows = [], summary = null) {
  bscDiscoveryLaneCache.clear();
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const address = String(row?.address || '').trim().toLowerCase();
    if (!address) return;
    bscDiscoveryLaneCache.set(address, {
      address,
      lane: String(row?.lane || '').toLowerCase(),
      score: Number(row?.score || 0),
      rank: Number(index + 1),
      liquidityUsd: Number(row?.liquidityUsd || 0),
      volume24h: Number(row?.volume24h || 0),
    });
  });
  bscDiscoveryRankState.lastRankedAt = new Date().toISOString();
  bscDiscoveryRankState.summary = summary ? { ...summary, rankedAt: bscDiscoveryRankState.lastRankedAt } : null;
}

function getBscDiscoveryRankSummary() {
  return bscDiscoveryRankState.summary ? { ...bscDiscoveryRankState.summary } : null;
}

function getHistorySeries(historyMap, chainKey, tokenAddress) {
  const direct = historyMap[tokenAddress];
  if (Array.isArray(direct)) return direct;

  const scopedKey = buildTokenKey(chainKey, tokenAddress);
  if (Array.isArray(historyMap[scopedKey])) return historyMap[scopedKey];

  const suffix = `:${String(tokenAddress || '').trim().toLowerCase()}`;
  const fallbackKey = Object.keys(historyMap).find((k) => k.endsWith(suffix));
  return fallbackKey ? (historyMap[fallbackKey] || []) : [];
}

function round(value, digits = 2) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num === 0) return 0;
  // For very small values (sub-pico like meme coins at 4e-10), .toFixed truncates to 0.
  // Promote to scientific precision (4 significant digits) so the price survives serialization.
  const abs = Math.abs(num);
  if (abs > 0 && abs < Math.pow(10, -digits)) {
    return Number(num.toPrecision(4));
  }
  return Number(num.toFixed(digits));
}

// roundPrice — like round() but specifically tuned to preserve very small token prices
// (BABYDOGE, SHIB, etc) where .toFixed(N) silently truncates to 0. Always uses scientific
// precision when the absolute value is below the precision floor.
function roundPrice(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num === 0) return 0;
  if (Math.abs(num) < 1e-4) return Number(num.toPrecision(6));
  return Number(num.toFixed(8));
}

// ── BTC risk-off filter ──────────────────────────────────────────────────────
// Macro guard: when BTC is selling off (>2% drop in last hour), block new altcoin
// BUYs. Catches market-wide flushes that would otherwise vaporize altcoin momentum.
const btcRiskOffState = {
  enabled: true,
  lastCheckedAt: 0,
  lastPriceUsd: 0,
  hourAgoPriceUsd: 0,
  priceChange1hPct: 0,
  riskOff: false,
  reason: null,
  // Rolling 1h price ring buffer of {ts, price}
  history: [],
};

async function refreshBtcRiskOff() {
  try {
    const ku = exchanges?.kucoin;
    if (!ku || typeof ku.exchange?.fetchTicker !== 'function') return;
    const ticker = await ku.exchange.fetchTicker('BTC/USDT').catch((err) => {
      logger.warn(`[btcRiskOff] BTC/USDT fetch failed: ${err?.message || err} — stale price retained`);
      return null;
    });
    const last = Number(ticker?.last || 0);
    if (!last || !Number.isFinite(last)) {
      // Mark state as stale — downstream consumers should treat lastPriceUsd as untrusted if lastCheckedAt is old.
      btcRiskOffState.lastFetchFailedAt = Date.now();
      return;
    }
    btcRiskOffState.lastFetchFailedAt = null;
    const now = Date.now();
    btcRiskOffState.lastPriceUsd = last;
    btcRiskOffState.lastCheckedAt = now;
    btcRiskOffState.history.push({ ts: now, price: last });
    // Keep only last 90 minutes of samples
    const oneAndHalfHourAgo = now - 90 * 60 * 1000;
    btcRiskOffState.history = btcRiskOffState.history.filter((s) => s.ts >= oneAndHalfHourAgo);
    // Find the sample closest to 1h ago
    const oneHourAgo = now - 60 * 60 * 1000;
    let hourAgoSample = btcRiskOffState.history[0];
    for (const s of btcRiskOffState.history) {
      if (s.ts <= oneHourAgo) hourAgoSample = s;
    }
    if (hourAgoSample && hourAgoSample.ts <= now - 30 * 60 * 1000) {
      // Need at least 30 min of history before drawing conclusions
      const change = ((last - hourAgoSample.price) / hourAgoSample.price) * 100;
      btcRiskOffState.hourAgoPriceUsd = hourAgoSample.price;
      btcRiskOffState.priceChange1hPct = change;
      const threshold = -Number(config.risk?.btcRiskOffThresholdPct || 2);
      btcRiskOffState.riskOff = change <= threshold;
      btcRiskOffState.reason = btcRiskOffState.riskOff
        ? `btc_risk_off:${change.toFixed(2)}%_in_1h`
        : null;
    }
  } catch (err) {
    logger.debug(`BTC risk-off refresh failed: ${err.message}`);
  }
}

function isBtcRiskOff() {
  if (!btcRiskOffState.enabled || config.risk?.btcRiskOffEnabled === false) return false;
  return btcRiskOffState.riskOff;
}

function getBtcRiskOffReason() {
  return btcRiskOffState.reason;
}

// metrics-compute extracted to src/stats/metrics-compute.js (Week 7 Track B, 2026-05-17).
// Delegating wrappers preserve closure-bound signature (portfolio) so callers unchanged.
const _metricsCompute = require('./stats/metrics-compute');
const defaultStatsShape = _metricsCompute.defaultStatsShape;
function ensureStatsShape() { return _metricsCompute.ensureStatsShape(portfolio); }
function refreshPerformanceMetrics() { return _metricsCompute.refreshPerformanceMetrics(portfolio); }

const recordSlippageSample = createSlippageRecorder({ portfolio, logger, ensureStatsShape });

const executionFlow = createExecutionFlow({
  config,
  logger,
  portfolio,
  strategy,
  telemetry,
  telemetryUuid,
  operationalDiagnostics,
  risk,
  sqlCoordination,
  markExecutionConfirmed,
  resolveBuyFillMetrics,
  resolveSellFillMetrics,
  setExecutionJournalState,
  calcSlippageBps,
  calcDiscrepancyPct,
  recordSlippageSample,
  refreshPerformanceMetrics,
  buildTokenKey,
  ensureLiquiditySentinel,
  releaseLiquiditySentinel,
  markTokenBadPattern,
  recordTradeBlockState,
  sendErrorAlert,
  sendTradeAlert,
  enterSafeMode,
  saveState: (...args) => saveState(...args),
  logTrade,
  recordPortfolioSnapshot,
  queueDecisionTelemetry,
  safeDecisionText,
  buildDecisionReflection,
  updateAdaptiveSleevePerformance,
  updateBrainProfileFromClosedTrade,
  strategyBrain,
  agentMemory,
  symbolPnLMemory,
  rlOnlineUpdater,
  round,
  normalizeChainKey,
  updateWalletBalance: (...args) => updateWalletBalance(...args),
  reconcileWalletPositions: (...args) => reconcileWalletPositions(...args),
  recordExchangeFailure,
  recordBuyFailureState,
  orderToPositionId,
  executeSell: (...args) => executeSell(...args),
});

function getRequiredConfirmations(chainName) {
  if (chainName === 'bsc') {
    return Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2));
  }
  if (chainName === 'base') {
    return Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2));
  }
  return 1;
}

function recordStrategyTick(tokenKey, price, volume = 0) {
  const key = String(tokenKey || '');
  const priceNum = Number(price || 0);
  if (!key || !Number.isFinite(priceNum) || priceNum <= 0) {
    return;
  }
  const maxHistBars = Math.max(120, Number(config.research?.targetHistoryBars || 240));
  if (!strategy.priceHistory[key]) strategy.priceHistory[key] = [];
  if (!strategy.volumeHistory[key]) strategy.volumeHistory[key] = [];
  strategy.priceHistory[key].push(priceNum);
  if (strategy.priceHistory[key].length > maxHistBars) strategy.priceHistory[key].shift();
  const vol = Number(volume || 0);
  if (Number.isFinite(vol) && vol > 0) {
    strategy.volumeHistory[key].push(vol);
    if (strategy.volumeHistory[key].length > maxHistBars) strategy.volumeHistory[key].shift();
  }
}

function getNativeQuoteOrThrow(normalizedChain, currentTokenData) {
  // B5.9: default tightened to 30s per Phase A audit 02-execution.md #10.
  // Override via RISK_MAX_NATIVE_PRICE_AGE_MS env or config.risk.maxNativePriceAgeMs
  // if ops cycle on slower refresh cadences; the override still floors at 1s.
  const maxNativePriceAgeMs = Math.max(1000, Number(config.risk?.maxNativePriceAgeMs || 30000));
  const cached = normalizedChain === 'bsc'
    ? exchanges.bsc.getCachedBnbPrice()
    : exchanges.base.getCachedEthPrice();
  if (!Number.isFinite(cached.price) || cached.price <= 0 || cached.cachedAt === null || (Date.now() - cached.cachedAt) > maxNativePriceAgeMs) {
    operationalDiagnostics.nativePriceAbortCount++;
    logger.error('native price unavailable or stale - buy aborted', {
      reason: 'native price unavailable or stale - buy aborted',
      chain: normalizedChain,
      symbol: currentTokenData.symbol,
      cachedAt: cached.cachedAt,
    });
    throw new Error(`native price unavailable or stale for ${currentTokenData.symbol} on ${normalizedChain}`);
  }
  return cached.price;
}

async function withTimeout(promise, timeoutMs, timeoutMessage) {
  const timeout = Math.max(1000, Number(timeoutMs || 6000));
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage || `Timed out after ${timeout}ms`)), timeout);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Reconciliation extracted to src/cycle/reconciliation.js
// - reconcileExecutionJournal (Week 7 Track B, 2026-05-17)
// - reconcileWalletPositions (Week 9.2, 2026-05-18)
const _reconciliationFactory = require('./cycle/reconciliation').create({
  portfolio,
  exchanges,
  marketState,
  config,
  logger,
  normalizeChainKey,
  buildTokenKey,
  findRecoverableKucoinBuyFill,
  restoreKucoinRecoveredBuy,
  releaseLiquiditySentinel,
  strategy,
  setExecutionJournalState,
  ensureStatsShape,
  refreshPerformanceMetrics,
  recordPortfolioSnapshot,
});
const reconcileExecutionJournal = _reconciliationFactory.reconcileExecutionJournal;
const reconcileWalletPositions = _reconciliationFactory.reconcileWalletPositions;

function refreshBrainAvailability() {
  brainState.model = config.anthropic.model;

  if (!config.anthropic.enabled) {
    brainState.status = 'disabled';
    return;
  }

  if (!config.anthropic.apiKey) {
    brainState.status = 'missing_api_key';
    return;
  }

  if (aiCircuit.cooldownUntil > Date.now()) {
    brainState.status = 'cooldown';
    return;
  }

  brainState.status = brainState.lastError ? 'degraded' : 'ready';
}

function getHealthStatus() {
  const runtime = getRuntimeSnapshot();
  const degradedReasons = [];
  const unhealthyReasons = [];
  const sqlStatus = getSqlStatus();
  const maxNativePriceAgeMs = Math.max(1000, Number(config.risk?.maxNativePriceAgeMs || 120000));
  const bscNativePriceCache = (() => {
    try {
      return exchanges?.bsc?.getCachedBnbPrice?.() || { price: null, cachedAt: null };
    } catch {
      return { price: null, cachedAt: null };
    }
  })();
  const bscNativePriceHealthy = Number.isFinite(Number(bscNativePriceCache.price))
    && Number(bscNativePriceCache.price) > 0
    && Number.isFinite(Number(bscNativePriceCache.cachedAt))
    && (Date.now() - Number(bscNativePriceCache.cachedAt)) <= maxNativePriceAgeMs;
  const sqlHealth = {
    ...sqlStatus,
    selfTestOk: Boolean(sqlRuntimeState.selfTestOk),
    selfTestReason: sqlRuntimeState.selfTestReason,
    lastSelfTestAt: sqlRuntimeState.lastSelfTestAt,
    databaseExplicit: Boolean(sqlStatus.databaseExplicit || hasExplicitDatabase()),
    healthy: !sqlStatus.enabled || (
      Boolean(sqlRuntimeState.selfTestOk)
      && Boolean(sqlStatus.connected)
      && Boolean(sqlStatus.schemaReady)
      && Boolean(sqlStatus.databaseExplicit || hasExplicitDatabase())
    ),
  };
  const dependencies = Object.keys(exchangeCircuit).map((chainKey) => {
    const state = exchangeCircuit[chainKey];
    const probe = dependencyHealth[chainKey] || {};
    return {
      chainKey,
      initialized: state.initialized,
      healthy: state.initialized && state.cooldownUntil <= Date.now() && !probe.lastError,
      cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
      lastError: state.lastError,
      rpcEndpoint: probe.endpoint || null,
      rpcLatencyMs: probe.lastLatencyMs,
      rpcLastCheckedAt: probe.lastCheckedAt,
      rpcLastError: probe.lastError,
    };
  });

  const unhealthyDeps = dependencies.filter((item) => !item.healthy).length;
  const aiHealthRequired = Boolean(config.anthropic.enabled) && config.execution?.aiNonBlocking === false;
  const aiHealthy = aiHealthRequired
    ? (Boolean(config.anthropic.apiKey) && aiCircuit.cooldownUntil <= Date.now())
    : true;
  const discovery = wsDiscovery.getStatus();
  const discoveryEnabled = discovery?.enabled !== false;
  const discoveryConfigured = Boolean(discovery?.anyConfigured);
  const enabledDiscoveryChains = Array.isArray(discovery?.configuredChains)
    ? discovery.configuredChains.filter(Boolean)
    : [];
  const discoveryActiveChains = enabledDiscoveryChains.filter((chainKey) => {
    const state = discovery?.[chainKey] || {};
    return Boolean(state.connected) || Number(state.subscriptions || 0) > 0;
  });
  const discoveryEventStaleness = enabledDiscoveryChains.map((chainKey) => {
    const state = discovery?.[chainKey] || {};
    const connected = Boolean(state.connected);
    const stale = Boolean(state.eventStale);
    return {
      chainKey,
      connected,
      lastEventAt: state.lastEventAt || null,
      stale,
      staleSuppressed: Boolean(state.staleSuppressed),
      unhealthy: connected && stale,
    };
  });
  const discoveryBootstrapFailed = Boolean(discovery?.bootstrapFailed);
  if (discoveryEnabled && discoveryConfigured && discoveryBootstrapFailed) {
    degradedReasons.push('ws_discovery_bootstrap_failed_polling_only');
  }
  const discoveryStarted = Boolean(discovery?.startedAt);
  if (discoveryEnabled && discoveryConfigured && !discoveryStarted && !discoveryBootstrapFailed) {
    degradedReasons.push('ws_discovery_unavailable_polling_only');
  }
  const anyDiscoveryEventStale = discoveryEventStaleness.some((row) => row.stale);
  const discoveryBlockingFailure = discoveryEnabled
    && discoveryConfigured
    && discoveryStarted
    && !discoveryBootstrapFailed
    && discoveryEventStaleness.some((row) => row.unhealthy);
  const discoveryHealthy = !discoveryBlockingFailure;

  const isRuntimeStrategyEnabled = (strategyName) => strategyName === 'momentum'
    ? config.strategies?.momentum?.enabled !== false
    : config.strategies?.[strategyName]?.enabled === true;
  const isBullFlagRuntimeStrategy = (strategyName) => (
    strategyName === 'spot_day_bull_flag' || strategyName === 'solana_bull_flag_v2'
  );
  const enabledRuntimeStrategyNames = RUNTIME_STRATEGY_NAMES.filter(isRuntimeStrategyEnabled);
  const getScanLockKey = (strategyName) => {
    if (strategyName === 'spot_day_bull_flag') return 'bullFlagScan';
    if (strategyName === 'momentum') return 'momentumScan';
    return `${strategyName}Scan`;
  };
  const getExitLockKey = (strategyName) => {
    if (strategyName === 'spot_day_bull_flag') return 'bullFlagExit';
    if (strategyName === 'momentum') return 'momentumExit';
    return `${strategyName}Exit`;
  };
  const getScanTimer = (strategyName) => {
    if (strategyName === 'momentum') return _mainLoopState.momentumScanTimer;
    if (strategyName === 'spot_day_bull_flag') return _mainLoopState.bullFlagScanTimer;
    return _mainLoopState.strategyScanTimers?.[strategyName];
  };
  const getExitTimer = (strategyName) => {
    if (strategyName === 'momentum') return _mainLoopState.momentumExitTimer;
    if (strategyName === 'spot_day_bull_flag') return _mainLoopState.bullFlagExitTimer;
    return _mainLoopState.strategyExitTimers?.[strategyName];
  };
  // Staleness thresholds: stale if loop has completed before but not within N × its configured interval.
  const healthNow = Date.now();
  const momentumScanMs = Math.max(60_000, Number(config.bot.momentumScanIntervalSeconds || 75) * 1000);
  const bullFlagScanMs = Math.max(60_000, Number(config.bot.bullFlagScanIntervalSeconds || 90) * 1000);
  const momentumExitMs = Math.max(5 * 60_000, Number(config.bot.momentumExitCheckMinutes || 15) * 60_000);
  const bullFlagExitMs = Math.max(5 * 60_000, Number(config.bot.bullFlagExitCheckMinutes || config.bot.momentumExitCheckMinutes || 15) * 60_000);
  const realtimeStopMs = Math.max(2_000, Number(config.risk?.realtimeStopCheckSeconds || 8) * 1000);
  const walletBalanceMs = Math.max(30_000, Number(config.bot.walletBalanceRefreshSeconds || 60) * 1000);
  const checkStale = (key, intervalMs, multiplier) => {
    const ts = loopLastCompletedAt[key];
    return ts !== null && (healthNow - ts) > multiplier * intervalMs;
  };
  const getStrategyScanIntervalMs = (strategyName) => {
    if (strategyName === 'momentum') return momentumScanMs;
    if (isBullFlagRuntimeStrategy(strategyName)) return bullFlagScanMs;
    if (strategyName === 'backes_swing') return Math.max(10 * 60_000, Number(config.strategies?.backes_swing?.scanIntervalMinutes || 30) * 60_000);
    return Math.max(60_000, Number(config.strategies?.[strategyName]?.scanIntervalSeconds || config.bot.momentumScanIntervalSeconds || 75) * 1000);
  };
  const getStrategyExitIntervalMs = (strategyName) => {
    if (isBullFlagRuntimeStrategy(strategyName)) return bullFlagExitMs;
    if (strategyName === 'backes_swing') return Math.max(30 * 60_000, Number(config.strategies?.backes_swing?.exitCheckMinutes || 60) * 60_000);
    return momentumExitMs;
  };
  const strategyLoopStaleness = Object.fromEntries(enabledRuntimeStrategyNames.map((strategyName) => [
    strategyName,
    {
      scan: checkStale(getScanLockKey(strategyName), getStrategyScanIntervalMs(strategyName), 3),
      exit: checkStale(getExitLockKey(strategyName), getStrategyExitIntervalMs(strategyName), 3),
    },
  ]));
  const loopStaleness = {
    momentumScan: checkStale('momentumScan', momentumScanMs, 3),
    bullFlagScan: checkStale('bullFlagScan', bullFlagScanMs, 3),
    momentumExit: checkStale('momentumExit', momentumExitMs, 3),
    bullFlagExit: checkStale('bullFlagExit', bullFlagExitMs, 3),
    realtimeStop: Boolean(config.risk?.realtimeStopLossEnabled !== false) ? checkStale('realtimeStop', realtimeStopMs, 4) : false,
    walletBalanceRefresh: checkStale('walletBalanceRefresh', walletBalanceMs, 3),
  };
  const anyStrategyLoopStale = enabledRuntimeStrategyNames.some((strategyName) => {
    const stale = strategyLoopStaleness[strategyName] || {};
    return stale.scan || stale.exit;
  });
  const anyLoopStale = loopStaleness.walletBalanceRefresh
    || loopStaleness.realtimeStop
    || anyStrategyLoopStale;
  const strategyTimersActive = enabledRuntimeStrategyNames.every((strategyName) => Boolean(getScanTimer(strategyName)) && Boolean(getExitTimer(strategyName)));
  const loopsTimersActive = Boolean(_mainLoopState.walletBalanceRefreshTimer)
    && (config.risk?.realtimeStopLossEnabled === false || Boolean(_mainLoopState.realtimeStopTimer))
    && strategyTimersActive;
  const loopsHealthy = loopsTimersActive && !anyLoopStale;
  const skippedExitThreshold = Math.max(1, Number(config.risk?.skippedExitChecksAlertThreshold || 3));
  const strategyDegradation = getImplementedStrategyNames().map((strategyName) => {
    const skipped = Number(portfolio.strategies?.[strategyName]?.stats?.skippedExitChecks || 0);
    const exitErrorCount = Number(portfolio.strategies?.[strategyName]?.stats?.exitErrorCount || 0);
    return {
      strategy: strategyName,
      skippedExitChecks: skipped,
      exitErrorCount,
      degraded: skipped >= skippedExitThreshold || exitErrorCount >= skippedExitThreshold,
    };
  });
  const anyStrategyDegraded = strategyDegradation.some((row) => row.degraded);
  const balanceDriftHalt = Boolean(portfolio.balanceDriftHalt);
  const safeMode = Boolean(portfolio.safeMode);
  const persistenceError = Boolean(statePersistenceError || portfolio.statePersistenceError);
  const signalDrought = {
    ...Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((strategyName) => [
      strategyName,
      Boolean(filterStatsState.signalDrought?.[strategyName]),
    ])),
    global: Boolean(filterStatsState.signalDrought?.global),
  };
  const overallOk = unhealthyDeps === 0
    && aiHealthy
    && discoveryHealthy
    && loopsHealthy
    && !anyStrategyDegraded
    && !balanceDriftHalt
    && !safeMode
    && !persistenceError
    && sqlHealth.healthy;

  RUNTIME_STRATEGY_NAMES.forEach((strategyName) => {
    if (signalDrought[strategyName]) degradedReasons.push(`signal_drought_${strategyName}`);
  });
  if (!bscNativePriceHealthy) {
    degradedReasons.push('bsc_native_price_degraded');
  }
  const stuckPositionCount = Object.keys(portfolio.stuckPositions || {}).length;
  if (stuckPositionCount > 0) {
    degradedReasons.push(`stuck_positions_${stuckPositionCount}`);
  }

  if (unhealthyDeps > 0) {
    unhealthyReasons.push('exchange_dependency_unhealthy');
  }
  if (!aiHealthy) {
    unhealthyReasons.push('ai_brain_unhealthy');
  }
  if (!discoveryHealthy && !discoveryBootstrapFailed) {
    unhealthyReasons.push('ws_discovery_event_stale');
  }
  if (!loopsHealthy) {
    unhealthyReasons.push('loop_stalled_or_timer_missing');
  }
  if (anyStrategyDegraded) {
    unhealthyReasons.push('strategy_exit_checks_degraded');
  }
  if (balanceDriftHalt) {
    unhealthyReasons.push('balance_drift_halt');
  }
  if (safeMode) {
    unhealthyReasons.push('safe_mode_active');
  }
  if (persistenceError) {
    unhealthyReasons.push('state_persistence_error');
  }
  if (!sqlHealth.healthy) {
    unhealthyReasons.push('sql_unhealthy');
  }
  if (sqlStatus.enabled && !sqlHealth.databaseExplicit) {
    degradedReasons.push('sql_connection_string_missing_database');
  }
  const incidentKeys = [...new Set([...unhealthyReasons, ...degradedReasons])];
  const incidentState = {
    severity: unhealthyReasons.length > 0 ? 'critical' : (degradedReasons.length > 0 ? 'warning' : 'normal'),
    active: unhealthyReasons.length > 0 || degradedReasons.length > 0,
    keys: incidentKeys,
    runbooks: incidentKeys.filter((key) => OPERATOR_RUNBOOKS[key]).map((key) => ({ key, ...(OPERATOR_RUNBOOKS[key] || {}) })),
  };
  return {
    ok: overallOk,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    unhealthyReasons,
    timestamp: new Date().toISOString(),
    uptimeSeconds: runtime.uptimeSeconds,
    totalRuntimeSeconds: runtime.totalRuntimeSeconds,
    scanInFlight,
    momentumScanActive: Boolean(loopLocks.momentumScan),
    kucoinMomentumScanActive: Boolean(loopLocks.kucoinMomentumScan),
    strategyScanActive: Object.fromEntries(RUNTIME_STRATEGY_NAMES.map((strategyName) => [
      strategyName,
      Boolean(loopLocks[getScanLockKey(strategyName)]),
    ])),
    loops: {
      healthy: loopsHealthy,
      timersActive: loopsTimersActive,
      anyStale: anyLoopStale,
      strategies: Object.fromEntries(enabledRuntimeStrategyNames.map((strategyName) => [
        strategyName,
        {
          scanTimerActive: Boolean(getScanTimer(strategyName)),
          exitTimerActive: Boolean(getExitTimer(strategyName)),
          scanLastCompletedAt: loopLastCompletedAt[getScanLockKey(strategyName)] ? new Date(loopLastCompletedAt[getScanLockKey(strategyName)]).toISOString() : null,
          exitLastCompletedAt: loopLastCompletedAt[getExitLockKey(strategyName)] ? new Date(loopLastCompletedAt[getExitLockKey(strategyName)]).toISOString() : null,
          scanStale: Boolean(strategyLoopStaleness[strategyName]?.scan),
          exitStale: Boolean(strategyLoopStaleness[strategyName]?.exit),
        },
      ])),
      momentumScan: {
        timerActive: Boolean(_mainLoopState.momentumScanTimer),
        lastCompletedAt: loopLastCompletedAt.momentumScan ? new Date(loopLastCompletedAt.momentumScan).toISOString() : null,
        stale: loopStaleness.momentumScan,
      },
      momentumExit: {
        timerActive: Boolean(_mainLoopState.momentumExitTimer),
        lastCompletedAt: loopLastCompletedAt.momentumExit ? new Date(loopLastCompletedAt.momentumExit).toISOString() : null,
        stale: loopStaleness.momentumExit,
      },
      walletBalanceRefresh: {
        timerActive: Boolean(_mainLoopState.walletBalanceRefreshTimer),
        lastCompletedAt: loopLastCompletedAt.walletBalanceRefresh ? new Date(loopLastCompletedAt.walletBalanceRefresh).toISOString() : null,
        stale: loopStaleness.walletBalanceRefresh,
      },
    },
    discovery: {
      ...discovery,
      healthy: discoveryHealthy,
      bootstrapFailed: discoveryBootstrapFailed,
      enabledChains: enabledDiscoveryChains,
      activeChains: discoveryActiveChains,
      eventStaleMinutes: Math.max(1, Number(config.discovery?.eventStaleMinutes || 30)),
      anyEventStale: anyDiscoveryEventStale,
      eventStaleness: discoveryEventStaleness,
    },
    ai: {
      enabled: config.anthropic.enabled,
      healthy: aiHealthy,
      status: brainState.status,
      cooldownUntil: aiCircuit.cooldownUntil ? new Date(aiCircuit.cooldownUntil).toISOString() : null,
      lastError: brainState.lastError,
    },
    strategies: {
      degraded: anyStrategyDegraded,
      skippedExitThreshold,
      details: strategyDegradation,
    },
    balanceDrift: portfolio.balanceDrift || { amountUsd: 0, pct: 0 },
    balanceDriftHalt,
    balanceCoverageCount: typeof portfolio.balanceCoverageCount === 'number' ? portfolio.balanceCoverageCount : null,
    balanceCoverageRequired: Math.max(1, Number(config.risk?.minBalanceCoverage || 2)),
    safeMode,
    statePersistenceError: persistenceError,
    saveFailureCount: Number(portfolio.saveFailureCount || saveFailureCount || 0),
    stateReconciliation: {
      lastRunAt: portfolio.stateReconciliation?.lastRunAt || null,
      discrepancyCount: Array.isArray(portfolio.stateReconciliation?.discrepancies)
        ? portfolio.stateReconciliation.discrepancies.length
        : 0,
      discrepancies: Array.isArray(portfolio.stateReconciliation?.discrepancies)
        ? portfolio.stateReconciliation.discrepancies
        : [],
    },
    signalDrought,
    signalDroughtCycles: Object.fromEntries(Object.entries(filterStatsState.consecutiveZeroSignalCycles || {})
      .map(([strategyName, value]) => [strategyName, Number(value || 0)])),
    incidentState,
    filterStats: {
      currentCycle: filterStatsState.currentCycle,
      recentCycles: filterStatsState.recentCycles,
    },
    scanErrors: Object.keys(scanStatus).reduce((acc, chainKey) => {
      acc[chainKey] = scanStatus[chainKey].suppressedTokenErrors || 0;
      return acc;
    }, {}),
    exchanges: dependencies,
    nativePrices: {
      bsc: {
        healthy: bscNativePriceHealthy,
        price: Number.isFinite(Number(bscNativePriceCache.price)) ? Number(bscNativePriceCache.price) : null,
        cachedAt: Number.isFinite(Number(bscNativePriceCache.cachedAt))
          ? new Date(Number(bscNativePriceCache.cachedAt)).toISOString()
          : null,
        maxAgeMs: maxNativePriceAgeMs,
      },
    },
    sql: sqlHealth,
  };
}

function getPositionValue(position) {
  const currentPrice = Number(position.currentPrice || position.entryPrice || 0);
  const quantity = Number(position.quantity || 0);

  if (quantity > 0) {
    return quantity * currentPrice;
  }

  return Number(position.costBasisUsd || position.initialSizeUsd || 0);
}

function getOpenPositions() {
  // B2.19: round-trip fee estimate for unrealized PnL display.
  // Previously the dashboard showed gross unrealized which inflated the apparent
  // edge by ~0.2-0.4% per side (40-80 bps round trip). Operators saw a $100 gain
  // that actually nets to ~$99.20 at close. Apply the per-chain fee profile when
  // available; otherwise use a conservative 40bps round-trip default.
  const feeProfileMap = (config.execution?.feeProfile || {});
  function estimateRoundTripFeeBps(chainKey) {
    const profile = feeProfileMap[chainKey] || feeProfileMap.default || { entryBps: 10, exitBps: 10 };
    return Number(profile.entryBps || 10) + Number(profile.exitBps || 10);
  }
  return Object.entries(portfolio.positions)
    .map(([positionKey, position]) => {
      const currentValue = getPositionValue(position);
      const costBasisUsd = Number(position.costBasisUsd || position.initialSizeUsd || 0);
      const unrealizedPnlGross = currentValue - costBasisUsd;
      const roundTripFeeBps = estimateRoundTripFeeBps(position.chainKey);
      const estimatedFeesUsd = costBasisUsd * (roundTripFeeBps / 10000);
      const unrealizedPnl = unrealizedPnlGross - estimatedFeesUsd;
      const unrealizedPnlPct = costBasisUsd > 0 ? (unrealizedPnl / costBasisUsd) * 100 : 0;

      return {
        address: position.address || positionKey,
        chain: position.chain,
        chainKey: position.chainKey,
        strategy: position.strategy || 'momentum',
        triggerTimeframe: position.triggerTimeframe || null,
        symbol: position.symbol,
        entryPrice: roundPrice(position.entryPrice),
        currentPrice: roundPrice(position.currentPrice || position.entryPrice),
        quantity: round(position.quantity || 0, 6),
        initialSizeUsd: round(position.initialSizeUsd || 0),
        costBasisUsd: round(costBasisUsd),
        positionValueUsd: round(currentValue),
        unrealizedPnl: round(unrealizedPnl),
        unrealizedPnlPct: round(unrealizedPnlPct),
        // B2.19: also expose gross (pre-fee) so the dashboard can show both
        // and operators see exactly how much of the gain fees will consume.
        unrealizedPnlGross: round(unrealizedPnlGross),
        estimatedRoundTripFeeUsd: round(estimatedFeesUsd),
        stopLoss: roundPrice(position.stopLoss || 0),
        takeProfit: roundPrice(position.takeProfit || 0),
        openedAt: position.openedAt,
        signalSource: position.signalSource || 'technical',
        aiReason: position.aiReason || '',
        aiConfidence: position.aiConfidence || 0,
        entryLiquidityUsd: round(position.entryLiquidityUsd || 0),
        entryTopHoldersPct: round(position.entryTopHoldersPct || 0, 2),
        realizedPnlByTier: position.realizedPnlByTier || {},
      };
    })
    .sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0));
}

function getRecentTrades(limit = 30) {
  const tradeRows = Array.isArray(portfolio.trades) ? portfolio.trades : [];
  const journal = portfolio.executionJournal || {};
  const merged = [];
  const seen = new Set();

  for (const trade of tradeRows) {
    if (!trade || typeof trade !== 'object') continue;
    const key = String(trade.txid || `${trade.timestamp}:${trade.type}:${trade.address}`);
    seen.add(key);
    merged.push(trade);
  }

  for (const entry of Object.values(journal)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.status !== 'confirmed' && entry.status !== 'finalized') continue;
    if (entry.type !== 'BUY' && entry.type !== 'SELL') continue;

    const key = String(entry.txid || `${entry.createdAt}:${entry.type}:${entry.address}`);
    if (seen.has(key)) continue;

    merged.push({
      type: entry.type,
      symbol: entry.symbol || '-',
      chain: CHAIN_LABELS[normalizeChainKey(entry.chainKey || entry.chain)] || entry.chain || '-',
      chainKey: normalizeChainKey(entry.chainKey || entry.chain),
      address: entry.address || '-',
      valueUsd: null,
      pnl: null,
      txid: entry.txid || null,
      signalSource: entry.signalSource || '',
      reason: entry.reason || (entry.status === 'finalized' ? 'FINALIZED' : 'EXECUTED'),
      timestamp: entry.finalizedAt || entry.createdAt || entry.updatedAt || null,
      executionStatus: entry.status,
      blockNumber: Number.isFinite(Number(entry.blockNumber)) ? Number(entry.blockNumber) : null,
      confirmations: Number.isFinite(Number(entry.confirmations)) ? Number(entry.confirmations) : null,
    });
    seen.add(key);
  }

  return merged
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, limit);
}

function getPortfolioSnapshot(options = {}) {
  const compact = options?.compact === true;
  const positions = getOpenPositions();
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const exposureUsd = positions.reduce((sum, position) => sum + position.positionValueUsd, 0);
  const walletCash = config.paperTrading ? portfolio.balance : Number(portfolio.walletBalanceUsd ?? portfolio.balance);
  const equity = walletCash + exposureUsd;
  // For paper trading we have a reliable startingBalance (full portfolio), so equity-baseline is accurate.
  // For live trading, startingBalance is only the free-cash snapshot at startup (excludes deployed capital),
  // so equity - baseline would show position market value rather than actual profit.
  // Instead, sum realised PnL (from closed trades) + unrealised PnL (cost-basis delta on open positions).
  const baseline = config.paperTrading && portfolio.startingBalance > 0 ? portfolio.startingBalance : 0;
  const totalPnl = baseline > 0 ? equity - baseline : portfolio.stats.totalPnl + unrealizedPnl;
  const totalReturnPct = baseline > 0 ? (totalPnl / baseline) * 100 : null;
  const winRate = portfolio.stats.closedTrades > 0
    ? (portfolio.stats.wins / portfolio.stats.closedTrades) * 100
    : null;

  const strategySummaries = Object.keys(portfolio.strategies || {}).reduce((acc, strategyName) => {
    const bucket = portfolio.strategies?.[strategyName] || {};
    const stats = bucket.stats || defaultStatsShape();
    const strategyPositions = Object.values(bucket.positions || {});
    const strategyExposure = strategyPositions.reduce((sum, position) => sum + getPositionValue(position), 0);
    const strategyWinRate = Number(stats.closedTrades || 0) > 0
      ? (Number(stats.wins || 0) / Number(stats.closedTrades || 0)) * 100
      : null;

    acc[strategyName] = {
      openPositionCount: strategyPositions.length,
      exposureUsd: round(strategyExposure),
      totalExecutions: Number(stats.executions || 0),
      closedTrades: Number(stats.closedTrades || 0),
      wins: Number(stats.wins || 0),
      losses: Number(stats.losses || 0),
      winRate: strategyWinRate === null ? null : round(strategyWinRate, 1),
      realizedPnl: round(stats.totalPnl || 0),
      grossProfit: round(stats.grossProfit || 0),
      grossLoss: round(stats.grossLoss || 0),
      profitFactor: round(stats.profitFactor || 0, 2),
      expectancyUsd: round(stats.expectancyUsd || 0),
      avgWinUsd: round(stats.avgWinUsd || 0),
      avgLossUsd: round(stats.avgLossUsd || 0),
      consecutiveLosses: Number(stats.consecutiveLosses || 0),
      maxConsecutiveLosses: Number(stats.maxConsecutiveLosses || 0),
      avgSlippageBps: round(stats.avgSlippageBps || 0, 2),
      slippageSamples: Number(stats.slippageSamples || 0),
      skippedExitChecks: Number(stats.skippedExitChecks || 0),
      exitErrorCount: Number(stats.exitErrorCount || 0),
    };
    return acc;
  }, {});

  const snapshot = {
    mode: config.paperTrading ? 'paper' : 'live',
    startingBalance: round(baseline),
    cashBalance: round(walletCash),
    chainBalancesUsd: {
      solana: Number.isFinite(Number(portfolio.walletBalancesUsd?.solana)) ? round(portfolio.walletBalancesUsd.solana) : null,
      bsc: Number.isFinite(Number(portfolio.walletBalancesUsd?.bsc)) ? round(portfolio.walletBalancesUsd.bsc) : null,
      base: Number.isFinite(Number(portfolio.walletBalancesUsd?.base)) ? round(portfolio.walletBalancesUsd.base) : null,
      kucoin: Number.isFinite(Number(portfolio.walletBalancesUsd?.kucoin)) ? round(portfolio.walletBalancesUsd.kucoin) : null,
    },
    untrackedWalletPositionValueUsd: round(portfolio.untrackedWalletPositionValueUsd || 0),
    untrackedWalletPositionValueUsdByChain: {
      solana: round(portfolio.untrackedWalletPositionValueUsdByChain?.solana || 0),
      bsc: round(portfolio.untrackedWalletPositionValueUsdByChain?.bsc || 0),
      base: round(portfolio.untrackedWalletPositionValueUsdByChain?.base || 0),
      kucoin: round(portfolio.untrackedWalletPositionValueUsdByChain?.kucoin || 0),
    },
    equity: round(equity),
    exposureUsd: round(exposureUsd),
    realizedPnl: round(portfolio.stats.totalPnl),
    unrealizedPnl: round(unrealizedPnl),
    totalPnl: round(totalPnl),
    totalReturnPct: totalReturnPct === null ? null : round(totalReturnPct),
    openPositionCount: positions.length,
    untrackedWalletPositions: (Array.isArray(portfolio.untrackedWalletPositions) ? portfolio.untrackedWalletPositions : [])
      .map((position) => ({
        key: position.key || null,
        chain: CHAIN_LABELS[normalizeChainKey(position.chain)] || position.chain || '-',
        chainKey: normalizeChainKey(position.chain),
        symbol: position.symbol || '-',
        address: position.address || '-',
        quantity: round(position.quantity || 0, 6),
        valueUsd: round(position.valueUsd || 0),
        type: position.type || 'wallet_untracked_position',
      })),
    totalExecutions: portfolio.stats.executions,
    closedTrades: portfolio.stats.closedTrades,
    wins: portfolio.stats.wins,
    losses: portfolio.stats.losses,
    winRate: winRate === null ? null : round(winRate, 1),
    grossProfit: round(portfolio.stats.grossProfit),
    grossLoss: round(portfolio.stats.grossLoss),
    profitFactor: round(portfolio.stats.profitFactor || 0, 2),
    expectancyUsd: round(portfolio.stats.expectancyUsd || 0),
    avgWinUsd: round(portfolio.stats.avgWinUsd || 0),
    avgLossUsd: round(portfolio.stats.avgLossUsd || 0),
    consecutiveLosses: Number(portfolio.stats.consecutiveLosses || 0),
    maxConsecutiveLosses: Number(portfolio.stats.maxConsecutiveLosses || 0),
    avgSlippageBps: round(portfolio.stats.avgSlippageBps || 0, 2),
    slippageSamples: Number(portfolio.stats.slippageSamples || 0),
    strategies: strategySummaries,
    positions: compact ? positions.slice(0, 12) : positions,
    recentTrades: compact ? getRecentTrades(8) : getRecentTrades(30),
    pnlHistory: compact ? portfolio.pnlHistory.slice(-40) : portfolio.pnlHistory.slice(-180),
  };

  if (compact) {
    delete snapshot.strategies;
  }

  return snapshot;
}

function recordPortfolioSnapshot(reason) {
  return _metricsCompute.recordPortfolioSnapshot({
    portfolio,
    telemetry,
    getSnapshot: getPortfolioSnapshot,
    reason,
  });
}


function recordBrainSuccess(tokenData, aiDecision) {
  brainState.callCount += 1;
  brainState.successCount += 1;
  brainState.lastLatencyMs = aiDecision.latencyMs || null;
  brainState.lastDecision = {
    timestamp: new Date().toISOString(),
    symbol: tokenData.symbol,
    address: tokenData.address,
    chain: tokenData.chain,
    signal: aiDecision.signal,
    confidence: aiDecision.confidence || 0,
    reason: aiDecision.reason || '',
    model: aiDecision.model || config.anthropic.model,
  };
  brainState.lastError = null;
  brainState.lastErrorAt = null;
  refreshBrainAvailability();
}

function recordBrainFailure(message) {
  brainState.callCount += 1;
  brainState.failureCount += 1;
  brainState.lastError = message;
  brainState.lastErrorAt = new Date().toISOString();
  logger.warn(`AI brain failure ${brainState.failureCount}: ${message}`);
  refreshBrainAvailability();
}


function applyKucoinCatalystPreEventGate(tokenData, strategyName, finalSignal, evaluation, cycleStats) {
  if (normalizeChainKey(tokenData?.chainKey || tokenData?.chain) !== 'kucoin') {
    return { finalSignal, blocked: false };
  }
  if (String(strategyName || '').toLowerCase() !== 'momentum') {
    return { finalSignal, blocked: false };
  }
  if (finalSignal !== 'BUY') {
    return { finalSignal, blocked: false };
  }

  const catalyst = getKucoinCatalystForToken(tokenData);
  if (!catalyst) {
    return { finalSignal, blocked: false };
  }

  const maxLead = Math.max(30, Number(config.risk?.catalystPreEventMaxLeadMinutes || 1440));
  const minLead = Math.max(0, Number(config.risk?.catalystPreEventMinLeadMinutes || 15));
  const minConfidence = Math.max(0, Math.min(100, Number(config.risk?.catalystMinConfidence || 72)));
  const minSourceCount = Math.max(1, Number(config.risk?.catalystMinSourceCount || 2));

  const confidence = Number(catalyst.confidence || 0);
  const sourceCount = Number(catalyst.sourceCount || 0);
  const minutesToEvent = Number(catalyst.minutesToEvent || 0);

  evaluation.details.catalyst = {
    symbol: catalyst.symbol,
    pair: catalyst.pair,
    eventType: catalyst.eventType,
    eventTimeIso: catalyst.eventTimeIso,
    confidence,
    sourceCount,
    minutesToEvent,
    score: Number(catalyst.score || 0),
  };

  const shouldBlock = (
    confidence < minConfidence
    || sourceCount < minSourceCount
    || !Number.isFinite(minutesToEvent)
    || minutesToEvent <= minLead
    || minutesToEvent > maxLead
  );

  if (!shouldBlock) {
    return { finalSignal, blocked: false };
  }

  evaluation.details.aiReason = 'catalyst_pre_event_gate';
  evaluation.details.aiRiskFlags = [
    ...new Set([...(evaluation.details.aiRiskFlags || []), 'catalyst_pre_event_gate']),
  ];
  if (cycleStats) {
    cycleStats.aiBlocked += 1;
  }

  return { finalSignal: 'HOLD', blocked: true };
}

function buildLiquiditySentinelKey(chainName, pairAddress) {
  return `${normalizeChainKey(chainName)}:${String(pairAddress || '').toLowerCase()}`;
}

async function handleLiquiditySentinelTrigger(chainName, pairAddress, txHash = null) {
  if (portfolio.safeMode || config.risk?.liquiditySentinelEnabled === false) return;
  const normalizedChain = normalizeChainKey(chainName);
  const targetPair = String(pairAddress || '').toLowerCase();
  const exchange = exchanges[normalizedChain];
  if (!exchange || !targetPair) return;

  const impactedPositions = Object.values(portfolio.positions || {}).filter((position) => {
    const positionChain = normalizeChainKey(position.chainKey || position.chain);
    return positionChain === normalizedChain
      && String(position.pairAddress || '').toLowerCase() === targetPair
      && !position.exitInProgress;
  });
  if (!impactedPositions.length) return;

  const reason = `Liquidity sentinel detected LP burn for ${normalizedChain}:${targetPair}${txHash ? ` tx=${txHash}` : ''}`;
  logger.warn(reason, { chain: normalizedChain, pairAddress: targetPair, txHash, positions: impactedPositions.length });
  await sendErrorAlert(reason).catch((err) => logger.error(`[liquidation-sentinel] alert send failed: ${err?.message || err}`));

  for (const position of impactedPositions) {
    try {
      const tokenData = await exchange.getTokenData(position.address).catch((err) => {
        logger.warn(`[liquidation-sentinel] getTokenData failed for ${position.symbol || position.address}: ${err?.message || err}`);
        return null;
      });
      if (!tokenData || !Number.isFinite(Number(tokenData?.price)) || Number(tokenData.price) <= 0) {
        logger.error(`[liquidation-sentinel] SKIP sell for ${position.symbol || position.address}: fresh price unavailable — refusing stale-price liquidation`);
        continue;
      }
      const exitToken = {
        ...tokenData,
        address: position.address,
        symbol: position.symbol,
        chain: position.chain,
        chainKey: normalizedChain,
        pairAddress: position.pairAddress,
        price: Number(tokenData?.price || position.currentPrice || position.entryPrice || 0),
      };
      await executeSell(normalizedChain, exchange, exitToken, position, 1, 'LIQUIDITY_SENTINEL');
    } catch (error) {
      logger.error(`Liquidity sentinel exit failed for ${position.symbol} on ${normalizedChain}: ${error.message}`);
    }
  }
}

function ensureLiquiditySentinel(chainName, pairAddress) {
  if (config.risk?.liquiditySentinelEnabled === false) return;
  const normalizedChain = normalizeChainKey(chainName);
  if (!['bsc', 'base'].includes(normalizedChain)) return;
  if (!ethers.isAddress(String(pairAddress || ''))) return;

  const subscriptionKey = buildLiquiditySentinelKey(normalizedChain, pairAddress);
  if (liquiditySentinelSubscriptions.has(subscriptionKey)) return;

  const provider = exchanges?.[normalizedChain]?.provider;
  if (!provider) return;

  const contract = new ethers.Contract(pairAddress, UNISWAP_V2_PAIR_ABI, provider);
  const listener = async (...args) => {
    const event = args[args.length - 1];
    const txHash = event?.log?.transactionHash || event?.transactionHash || null;
    await handleLiquiditySentinelTrigger(normalizedChain, pairAddress, txHash);
  };
  contract.on('Burn', listener);
  liquiditySentinelSubscriptions.set(subscriptionKey, { contract, listener, chainName: normalizedChain, pairAddress });
}

function releaseLiquiditySentinel(chainName, pairAddress) {
  const subscriptionKey = buildLiquiditySentinelKey(chainName, pairAddress);
  const subscription = liquiditySentinelSubscriptions.get(subscriptionKey);
  if (!subscription) return;

  const stillNeeded = Object.values(portfolio.positions || {}).some((position) => {
    const positionChain = normalizeChainKey(position.chainKey || position.chain);
    return positionChain === normalizeChainKey(chainName)
      && String(position.pairAddress || '').toLowerCase() === String(pairAddress || '').toLowerCase();
  });
  if (stillNeeded) return;

  try {
    subscription.contract.off('Burn', subscription.listener);
  } catch (_) {
    // ignore unsubscribe errors
  }
  liquiditySentinelSubscriptions.delete(subscriptionKey);
}

function syncLiquiditySentinelsFromPortfolio() {
  Object.values(portfolio.positions || {}).forEach((position) => {
    ensureLiquiditySentinel(position.chainKey || position.chain, position.pairAddress);
  });
}

const sellPnlAnomalyWindow = createWindow(Number(process.env.SELL_PNL_ANOMALY_WINDOW || 40));
const sellPnlAnomalyAlerter = createAnomalyAlerter({
  sendAlert: (msg) => sendErrorAlert(msg).catch(() => undefined),
  logger,
  cooldownMs: Number(process.env.SELL_PNL_ANOMALY_COOLDOWN_MS || 60 * 60_000),
});

function recordSellPnlAnomaly(trade) {
  if (String(trade?.type || '').toUpperCase() !== 'SELL') return null;
  const pnlUsd = Number(trade.pnl);
  if (!Number.isFinite(pnlUsd)) return null;
  const result = sellPnlAnomalyAlerter.check(
    'sell_pnl_usd',
    pnlUsd,
    sellPnlAnomalyWindow.snapshot(),
    {
      minSamples: Number(process.env.SELL_PNL_ANOMALY_MIN_SAMPLES || 8),
      sigmaThreshold: Number(process.env.SELL_PNL_ANOMALY_SIGMA || 3),
    },
  );
  sellPnlAnomalyWindow.push(pnlUsd);
  return result;
}

// Trade schema: `quantity` always represents the confirmed on-chain filled base-token amount,
// not the requested/intended amount. Requested amounts are stored in executionMeta.requestedQuantity.
function logTrade(type, tokenData, quantity, valueUsd, txid, pnl = null, signalSource = 'technical', reason = '', executionMeta = {}, strategyName = 'momentum') {
  const tradeTimestamp = executionMeta.timestamp
    ? new Date(executionMeta.timestamp).toISOString()
    : new Date().toISOString();
  const trade = {
    type,
    symbol: tokenData.symbol,
    chain: tokenData.chain,
    chainKey: normalizeChainKey(tokenData.chainKey || tokenData.chain),
    strategy: strategyName,
    address: tokenData.address,
    price: round(tokenData.price, 8),
    quantity: round(quantity, 6), // confirmed filled base-token amount (never the requested amount)
    valueUsd: round(valueUsd),
    pnl: pnl === null ? null : round(pnl),
    txid,
    signalSource,
    reason,
    expectedPrice: executionMeta.expectedPrice ? round(executionMeta.expectedPrice, 8) : null,
    realizedPrice: executionMeta.realizedPrice ? round(executionMeta.realizedPrice, 8) : null,
    slippageBps: Number.isFinite(Number(executionMeta.slippageBps)) ? round(executionMeta.slippageBps, 2) : null,
    requestedQuantity: Number.isFinite(Number(executionMeta.requestedQuantity)) ? round(executionMeta.requestedQuantity, 8) : null,
    filledQuantity: Number.isFinite(Number(executionMeta.filledQuantity)) ? round(executionMeta.filledQuantity, 8) : null,
    requestedValueUsd: Number.isFinite(Number(executionMeta.requestedValueUsd)) ? round(executionMeta.requestedValueUsd) : null,
    filledValueUsd: Number.isFinite(Number(executionMeta.filledValueUsd)) ? round(executionMeta.filledValueUsd) : null,
    fillDiscrepancyPct: Number.isFinite(Number(executionMeta.fillDiscrepancyPct)) ? round(executionMeta.fillDiscrepancyPct, 4) : null,
    blockNumber: Number.isFinite(Number(executionMeta.blockNumber)) ? Number(executionMeta.blockNumber) : null,
    confirmations: Number.isFinite(Number(executionMeta.confirmations)) ? Number(executionMeta.confirmations) : null,
    privateRouteUsed: Boolean(executionMeta.privateRouteUsed),
    quotedPriceImpactPct: Number.isFinite(Number(executionMeta.quotedPriceImpactPct)) ? round(executionMeta.quotedPriceImpactPct, 4) : null,
    realizedVsQuoteSlippagePct: Number.isFinite(Number(executionMeta.realizedVsQuoteSlippagePct)) ? round(executionMeta.realizedVsQuoteSlippagePct, 4) : null,
    // Bull-flag setup telemetry (Week 12 B.8). Tags each trade with its setup
    // classification so dashboards / SQL reports can segment performance by setup.
    setupType: tokenData.setupType || executionMeta.setupType || null,
    structureType: tokenData.structureType || executionMeta.structureType || null,
    setupStopPrice: Number.isFinite(Number(executionMeta.setupStopPrice)) ? round(executionMeta.setupStopPrice, 8) : null,
    setupTargetPrice: Number.isFinite(Number(executionMeta.setupTargetPrice)) ? round(executionMeta.setupTargetPrice, 8) : null,
    setupRiskUsd: Number.isFinite(Number(executionMeta.setupRiskUsd)) ? round(executionMeta.setupRiskUsd) : null,
    setupIsAPlus: executionMeta.setupIsAPlus === true ? true : undefined,
    brainProfileKey: executionMeta.brainProfileKey || undefined,
    brainMultiplier: Number.isFinite(Number(executionMeta.brainMultiplier)) ? round(executionMeta.brainMultiplier, 4) : undefined,
    executionStatus: executionMeta.executionStatus || undefined,
    recoveredFromFailure: executionMeta.recoveredFromFailure === true ? true : undefined,
    recoverySource: executionMeta.recoverySource || undefined,
    timestamp: tradeTimestamp,
  };

  portfolio.trades.unshift(trade);
  telemetry.logTradeLedger(trade);
  recordSellPnlAnomaly(trade);
  if (portfolio.trades.length > 250) {
    portfolio.trades.pop();
  }

  if (portfolio.strategies?.[strategyName]) {
    portfolio.strategies[strategyName].trades.unshift(trade);
    if (portfolio.strategies[strategyName].trades.length > 250) {
      portfolio.strategies[strategyName].trades.pop();
    }
  }

  const pnlText = pnl === null ? '' : ` | PnL: ${pnl >= 0 ? '+' : ''}$${round(pnl).toFixed(2)}`;
  const slippageText = Number.isFinite(Number(trade.slippageBps)) ? ` | Slippage: ${round(trade.slippageBps, 1)}bps` : '';
  logger.info(`TRADE ${type} ${tokenData.symbol} @ $${tokenData.price} | Value: $${round(valueUsd).toFixed(2)}${pnlText}${slippageText} | TX: ${txid} | Source: ${signalSource}`);
}

function inferRecoveredKucoinStrategy(address, recoveredAt = null) {
  const recoveredAtMs = Date.parse(recoveredAt || '') || 0;
  const recentSignal = (marketState.signals || []).find((signal) => {
    if (normalizeChainKey(signal?.chainKey || signal?.chain) !== 'kucoin') return false;
    if (String(signal?.address || '').toLowerCase() !== String(address || '').toLowerCase()) return false;
    if (!signal?.strategy) return false;
    const signalAtMs = Date.parse(signal.timestamp || '') || 0;
    if (!recoveredAtMs || !signalAtMs) return true;
    return Math.abs(signalAtMs - recoveredAtMs) <= 30 * 60_000;
  });
  if (recentSignal?.strategy) {
    return String(recentSignal.strategy).toLowerCase();
  }

  return 'momentum';
}

async function findRecoverableKucoinBuyFill(exchange, walletPosition) {
  if (!exchange || typeof exchange.findRecentTradeFill !== 'function' || !walletPosition?.address) {
    return null;
  }

  const processAgeMs = Date.now() - processStartedAtMs;
  const startupGraceMs = Math.max(10 * 60_000, Number(config.execution?.kucoinOrphanRecoveryStartupGraceMs || (12 * 60 * 60_000)));
  if (processAgeMs > startupGraceMs) {
    return null;
  }

  const maxTradeAgeBeforeStartupMs = Math.max(30 * 60_000, Number(config.execution?.kucoinOrphanRecoveryBeforeStartupMs || (24 * 60 * 60_000)));
  const quantityTolerancePct = Math.max(0.1, Number(config.execution?.kucoinOrphanRecoveryQtyTolerancePct || 2.5));
  const symbol = String(walletPosition.address || '').trim();
  const walletQty = Number(walletPosition.quantity || 0);
  if (!symbol || !Number.isFinite(walletQty) || walletQty <= 0) {
    return null;
  }

  const searchSinceMs = Math.max(0, processStartedAtMs - maxTradeAgeBeforeStartupMs);
  const recoveredFill = await exchange.findRecentTradeFill(symbol, 'buy', walletQty, {
    sinceMs: searchSinceMs,
    lookbackMs: processStartedAtMs - searchSinceMs,
    targetTimestampMs: processStartedAtMs,
  });

  if (!recoveredFill?.txid) {
    return null;
  }

  const fillTimestampMs = Date.parse(recoveredFill.timestamp || '') || Number(recoveredFill.timestampMs || 0) || 0;
  if (fillTimestampMs > 0) {
    if (fillTimestampMs > processStartedAtMs + 30_000) {
      return null;
    }
    if (fillTimestampMs < searchSinceMs) {
      return null;
    }
  }

  const recoveredQty = Number(recoveredFill.filledBaseQty || 0);
  const qtyDiffPct = walletQty > 0 && Number.isFinite(recoveredQty)
    ? Math.abs(recoveredQty - walletQty) / walletQty * 100
    : Infinity;
  if (!Number.isFinite(qtyDiffPct) || qtyDiffPct > quantityTolerancePct) {
    return null;
  }

  return recoveredFill;
}

async function restoreKucoinRecoveredBuy(walletPosition, recoveredFill) {
  if (!walletPosition?.address || !recoveredFill?.txid) {
    return false;
  }

  ensureStatsShape();
  const chainName = 'kucoin';
  const address = String(walletPosition.address || '').trim();
  if (!address) return false;
  const tokenKey = buildTokenKey(chainName, address);

  // Acquire positionMutex BEFORE the check-then-write to prevent two concurrent
  // recoveries both passing the !positions[tokenKey] guard and double-creating a position.
  const release = await positionMutex.lock();
  try {
    if (portfolio.positions?.[tokenKey]) {
      return false;
    }

  const tracked = marketState.trackedTokens?.[tokenKey] || null;
  const recoveredAt = recoveredFill.timestamp || new Date().toISOString();
  const strategyName = inferRecoveredKucoinStrategy(address, recoveredAt);
  const walletQty = Number(walletPosition.quantity || 0);
  const currentValueUsd = Number(walletPosition.valueUsd || 0);
  const entryQty = Number(recoveredFill.filledBaseQty || walletQty || 0);
  const entryValueUsd = Number(recoveredFill.filledQuoteUsd || 0);
  const entryPrice = Number(recoveredFill.executedPriceUsd || 0) > 0
    ? Number(recoveredFill.executedPriceUsd)
    : (entryQty > 0 && entryValueUsd > 0 ? (entryValueUsd / entryQty) : 0);
  const currentPrice = walletQty > 0 && currentValueUsd > 0
    ? (currentValueUsd / walletQty)
    : entryPrice;
  const signalSource = tracked?.signalSource || 'technical';

  portfolio.positions[tokenKey] = {
    key: tokenKey,
    address,
    chain: CHAIN_LABELS[chainName],
    chainKey: chainName,
    strategyKey: tracked?.strategyKey || tokenKey,
    strategy: strategyName,
    symbol: walletPosition.symbol || tracked?.symbol || address,
    entryPrice,
    currentPrice: currentPrice || entryPrice,
    quantity: walletQty > 0 ? walletQty : entryQty,
    initialSizeUsd: entryValueUsd,
    costBasisUsd: entryValueUsd,
    requestedEntryUsd: entryValueUsd,
    filledEntryUsd: entryValueUsd,
    requestedEntryQuantity: entryQty,
    filledEntryQuantity: entryQty,
    entryFillDiscrepancyPct: 0,
    stopLoss: risk.stopLossPrice(entryPrice, strategyName),
    takeProfit: risk.takeProfitPrice(entryPrice, strategyName),
    openedAt: recoveredAt,
    txid: recoveredFill.txid,
    entryBlockNumber: Number.isFinite(Number(recoveredFill?.blockNumber)) ? Number(recoveredFill.blockNumber) : null,
    entryConfirmations: Number.isFinite(Number(recoveredFill?.confirmations)) ? Number(recoveredFill.confirmations) : null,
    entryPrivateRouteUsed: false,
    signalSource,
    triggerTimeframe: tracked?.entryTriggerTimeframe || tracked?.triggerTimeframe || null,
    discoveryLane: tracked?.discoveryLane || null,
    aiReason: tracked?.aiReason || 'recovered_from_exchange_history',
    aiConfidence: Number(tracked?.aiConfidence || 0),
    pairAddress: tracked?.pairAddress || null,
    entryLiquidityUsd: Number(tracked?.liquidityUsd || 0),
    entryTopHoldersPct: Number(tracked?.topHoldersPct || 0),
    entryBuyRatioPct10m: 0,
    entryRecentWindowMinutes: Number(tracked?.recentTxWindowMinutes || 0) || null,
    entryBuyRatioRecentPct: Number(tracked?.buyRatioRecentPct || 0) || null,
    entryHolderCount: Number(tracked?.holderCount || 0),
    highestPrice: currentPrice || entryPrice,
    antiPatternInfo: {
      recoveredFromExchangeHistory: true,
      originalTradeTimestamp: recoveredAt,
    },
    trailingStop: null,
    tierLocalHigh: currentPrice || entryPrice,
    triggeredSellTiers: {},
    tierDelayedAt: {},
    partialFillRetry: false,
    exitInProgress: false,
    realizedPnlByTier: {},
    realizedPnl: 0,
  };

  if (portfolio.strategies?.[strategyName]) {
    portfolio.strategies[strategyName].positions[tokenKey] = portfolio.positions[tokenKey];
  }

  const existingTrade = (portfolio.trades || []).some((trade) => String(trade?.txid || '') === String(recoveredFill.txid));
  if (!existingTrade) {
    portfolio.stats.executions += 1;
    if (portfolio.strategies?.[strategyName]?.stats) {
      portfolio.strategies[strategyName].stats.executions += 1;
    }

    logTrade('BUY', {
      symbol: walletPosition.symbol || tracked?.symbol || address,
      chain: CHAIN_LABELS[chainName],
      chainKey: chainName,
      address,
      price: entryPrice,
    }, entryQty, entryValueUsd, recoveredFill.txid, null, signalSource, 'ENTRY', {
      expectedPrice: entryPrice,
      realizedPrice: entryPrice,
      requestedQuantity: entryQty,
      filledQuantity: entryQty,
      requestedValueUsd: entryValueUsd,
      filledValueUsd: entryValueUsd,
      fillDiscrepancyPct: 0,
      blockNumber: recoveredFill?.blockNumber,
      confirmations: recoveredFill?.confirmations,
      privateRouteUsed: false,
      timestamp: recoveredAt,
      executionStatus: 'confirmed',
      recoveredFromFailure: true,
      recoverySource: 'exchange_trade_history',
    }, strategyName);
  }

  setExecutionJournalState(recoveredFill.txid, {
    status: 'confirmed',
    type: 'BUY',
    chain: chainName,
    chainKey: chainName,
    symbol: walletPosition.symbol || tracked?.symbol || address,
    address,
    blockNumber: Number(recoveredFill?.blockNumber || 0) || null,
    confirmations: Number(recoveredFill?.confirmations || 0) || null,
    requiredConfirmations: 1,
    createdAt: recoveredAt,
  });

  if (tracked) {
    tracked.hasOpenPosition = true;
  }

  logger.warn(`Recovered historical BUY position for ${walletPosition.symbol || address} from KuCoin trade history: ${recoveredFill.txid}`);
    return true;
  } finally {
    release();
  }
}


async function initializeExchanges() {
  logger.info('Initializing exchanges...');

  await Promise.all(Object.entries(exchanges).map(async ([chainName, exchange]) => {
    try {
      await exchange.initialize();
      exchangeCircuit[chainName].initialized = true;
      recordExchangeSuccess(chainName);
    } catch (error) {
      exchangeCircuit[chainName].initialized = false;
      recordExchangeFailure(chainName, error.message);
      logger.error(`${CHAIN_LABELS[chainName]} init failed: ${error.message}`);
    }
  }));

  logger.info('Exchange initialization complete');
  await refreshDependencyHealth();
}

async function getTokensForStrategy(chainName, exchange, strategyName = 'momentum', options = {}) {
  if (!isStrategyScanEnabled(chainName, strategyName)) {
    return [];
  }

  // spot_day_bull_flag reuses momentum's liquid-token discovery universe.
  // Detector itself filters via OHLCV pattern + scanner gates.
  const discoveryStrategy = strategyName === 'spot_day_bull_flag' ? 'momentum' : strategyName;

  const watchlistTokens = watchlists[chainName] || [];
  const discoveryStatus = wsDiscovery.getStatus();
  const forcePollingOnly = discoveryStrategy === 'momentum' && Boolean(discoveryStatus?.bootstrapFailed);

  const wsTokens = wsDiscovery.getRecentTokens(chainName, 2 * 60 * 60 * 1000); // Last 2h of websocket discoveries
  const configuredMode = String(config.bot.discoveryMode || 'new').toLowerCase();
  const mode = ['watchlist', 'new', 'hybrid'].includes(configuredMode) ? configuredMode : 'new';

  if (mode === 'watchlist') {
    return [...new Set(watchlistTokens)];
  }
  const pollingPromise = (typeof exchange.getNewTokens === 'function'
    ? exchange.getNewTokens()
    : Promise.resolve([])).catch((error) => {
    logger.warn(`Polling discovery failed on ${chainName}: ${error.message}`);
    return [];
  });

  // WebSocket discoveries should be actionable immediately.
  // In hybrid mode, race polling against a short timeout so same-cycle polling candidates are included when available.
  if (!forcePollingOnly && wsTokens.length > 0) {
    if (mode === 'hybrid') {
      const defaultHybridTimeoutMs = Math.max(50, Number(config.discovery?.hybridPollTimeoutMs || 300));
      // KuCoin and BSC polling can be materially slower on cold starts.
      // Give them longer to return so momentum discovery is not starved after restarts.
      let hybridPollTimeoutMs = defaultHybridTimeoutMs;
      if (chainName === 'kucoin') {
        hybridPollTimeoutMs = Math.max(defaultHybridTimeoutMs, 6000);
      } else if (chainName === 'bsc') {
        hybridPollTimeoutMs = Math.max(defaultHybridTimeoutMs, Number(config.bot?.bscHybridPollTimeoutMs || 10000));
      }
      const raceResult = await Promise.race([
        pollingPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), hybridPollTimeoutMs)),
      ]);
      const sameCyclePolled = Array.isArray(raceResult) ? raceResult : [];
      if (!Array.isArray(raceResult)) {
        // Polling timed out — hydrate queue for next cycle in background
        pollingPromise.then((tokens) => {
          if (!Array.isArray(tokens) || tokens.length === 0) return;
          tokens.forEach((tokenAddress) => wsDiscovery.addToken(chainName, tokenAddress, 'polling_fallback'));
        }).catch(() => undefined);
      }
      return [...new Set([...watchlistTokens, ...wsTokens, ...sameCyclePolled])];
    }

    // Non-hybrid: keep polling result as background hydration only
    pollingPromise.then((tokens) => {
      if (!Array.isArray(tokens) || tokens.length === 0) return;
      tokens.forEach((tokenAddress) => wsDiscovery.addToken(chainName, tokenAddress, 'polling_fallback'));
    }).catch(() => undefined);
    return [...new Set(wsTokens)];
  }

  const defaultPollTimeoutMs = Math.max(250, Number(config.discovery?.pollTimeoutMs || 4000));
  let pollTimeoutMs = defaultPollTimeoutMs;
  if (chainName === 'kucoin') {
    pollTimeoutMs = Math.max(defaultPollTimeoutMs, 10000);
  } else if (chainName === 'bsc') {
    pollTimeoutMs = Math.max(defaultPollTimeoutMs, Number(config.bot?.bscDiscoveryPollTimeoutMs || 90000));
  }
  const timedPollingResult = await Promise.race([
    pollingPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), pollTimeoutMs)),
  ]);
  const newTokens = Array.isArray(timedPollingResult) ? timedPollingResult : [];
  if (!Array.isArray(timedPollingResult)) {
    logger.warn(`Polling discovery timed out on ${chainName} after ${pollTimeoutMs}ms; continuing with websocket-only tokens`);
  }

  if (forcePollingOnly) {
    const now = Date.now();
    const lastWarnAt = Number(pollingFallbackLastWarnAt[chainName] || 0);
    if (now - lastWarnAt > 600000) {
      logger.warn('WS discovery bootstrap failed, using polling-only discovery for momentum', {
        reason: 'websocket discovery bootstrap failed',
        chain: chainName,
      });
      pollingFallbackLastWarnAt[chainName] = now;
    }
    if (mode === 'watchlist') {
      const base = [...new Set(watchlistTokens)];
      if (chainName === 'bsc' && typeof options?.onBscBaseCount === 'function') {
        options.onBscBaseCount(base.length);
      }
      return chainName === 'bsc' ? rankBscMomentumUniverse(exchange, base) : base;
    }
    if (mode === 'hybrid') {
      const base = [...new Set([...watchlistTokens, ...newTokens])];
      if (chainName === 'bsc' && typeof options?.onBscBaseCount === 'function') {
        options.onBscBaseCount(base.length);
      }
      return chainName === 'bsc' ? rankBscMomentumUniverse(exchange, base) : base;
    }
    const base = [...new Set(newTokens)];
    if (chainName === 'bsc' && typeof options?.onBscBaseCount === 'function') {
      options.onBscBaseCount(base.length);
    }
    return chainName === 'bsc' ? rankBscMomentumUniverse(exchange, base) : base;
  }

  if (mode === 'hybrid') {
    const base = [...new Set([...watchlistTokens, ...wsTokens, ...newTokens])];
    if (chainName === 'bsc' && typeof options?.onBscBaseCount === 'function') {
      options.onBscBaseCount(base.length);
    }
    return chainName === 'bsc' ? rankBscMomentumUniverse(exchange, base) : base;
  }
  const base = [...new Set([...wsTokens, ...newTokens])];
  if (chainName === 'bsc' && typeof options?.onBscBaseCount === 'function') {
    options.onBscBaseCount(base.length);
  }
  return chainName === 'bsc' ? rankBscMomentumUniverse(exchange, base) : base;
}

// scanChain extracted to src/cycle/momentum-scanner.js (Week 16.1, 2026-05-23).
// Behavior identical — body lives in the factory, deps are injected here.
const { createMomentumScanner } = require('./cycle/momentum-scanner');
const _momentumScanner = createMomentumScanner({
  logger,
  config,
  marketState,
  scanStatus,
  filterStatsState,
  isExchangeAvailable,
  getStrategyScanStatus,
  syncChainScanStatus,
  refreshKucoinCatalystCache,
  getPrioritizedKucoinCatalystPairs,
  getTokensForStrategy,
  getBscDiscoveryRankSummary,
  getRotatingScanWindow,
  recordExchangeSuccess,
  recordExchangeFailure,
  processToken: (...args) => processToken(...args), // late-binding ref (forward declaration)
  sleep,
});
const scanChain = _momentumScanner.scanChain;


// W16.5: read-through cache for hot scanner path. Mem-LRU only (no SQL on
// scanner cycle to keep latency tight); write-through to SQL on provider fetch.
const { getTokenByAddressWithCache } = require('./utils/tokens-cache');

async function processToken(chainName, exchange, tokenAddress, options = {}) {
  const scanStrategy = String(options.scanStrategy || '').toLowerCase();
  const defaultTokenDataFetchTimeoutMs = chainName === 'solana'
    ? Number(config.risk?.solanaTokenDataFetchTimeoutMs || config.risk?.dexTokenDataFetchTimeoutMs || 15000)
    : chainName === 'base'
      ? Number(config.risk?.baseTokenDataFetchTimeoutMs || config.risk?.dexTokenDataFetchTimeoutMs || 15000)
      : Number(config.risk?.tokenDataFetchTimeoutMs || 5000);
  const tokenDataFetchTimeoutMs = Math.max(1000, defaultTokenDataFetchTimeoutMs);
  const tokenData = await getTokenByAddressWithCache(
    chainName,
    tokenAddress,
    () => withTimeout(
      exchange.getTokenData(tokenAddress),
      tokenDataFetchTimeoutMs,
      `Token data fetch timed out for ${chainName}:${tokenAddress}`,
    ),
  ).catch((error) => {
    logger.debug(`Token data fetch skipped for ${chainName}:${tokenAddress}: ${error.message}`);
    return null;
  });
  if (!tokenData || !tokenData.price) {
    const cycleStats = scanStrategy ? filterStatsState.currentCycle?.[scanStrategy] : null;
    if (cycleStats) {
      cycleStats.technicalBlocked += 1;
      classifyFilterReason(cycleStats, 'token_data_unavailable');
    }
    return;
  }

  const tokenKey = buildTokenKey(chainName, tokenAddress);
  tokenData.address = tokenData.address || tokenAddress;
  tokenData.chainKey = chainName;
  tokenData.chain = CHAIN_LABELS[chainName];
  tokenData.strategyKey = tokenKey;
  if (chainName === 'bsc') {
    const laneMetadata = getBscDiscoveryLaneMetadata(tokenData.address || tokenAddress);
    if (laneMetadata) {
      tokenData.discoveryLane = laneMetadata.lane;
      tokenData.discoveryRank = laneMetadata.rank;
      tokenData.discoveryScore = laneMetadata.score;
    }
  }

  const trackInsufficient = (reason, strategyName = null) => {
    const statsStrategy = String(strategyName || scanStrategy || '').toLowerCase();
    const cycleStats = statsStrategy ? filterStatsState.currentCycle?.[statsStrategy] : null;
    if (cycleStats) {
      cycleStats.technicalBlocked += 1;
      classifyFilterReason(cycleStats, reason || 'eligibility_rejected');
    }
    updateTrackedToken(chainName, tokenData, {
      strategy: statsStrategy || strategyName,
      technicalSignal: 'INSUFFICIENT DATA',
      finalSignal: 'INSUFFICIENT DATA',
      signalSource: 'eligibility',
      aiReason: reason,
      aiConfidence: 0,
      riskFlags: reason ? [reason] : [],
      details: {},
    }, { recordSignal: false });
  };

  updateTokenScanState(chainName, tokenAddress, tokenData, scanStrategy);
  recordStrategyTick(tokenKey, Number(tokenData.price), Number(tokenData.volume24h || 0));

  const openPosition = portfolio.positions[tokenKey];
  if (openPosition) {
    openPosition.currentPrice = Number(tokenData.price);
    openPosition.lastSeenAt = new Date().toISOString();
    refreshTrackedOpenPositionSnapshot(chainName, tokenData, openPosition);
    // Exit evaluation is handled exclusively by runStrategyExitCycle to prevent concurrent double-sells.
    return;
  }

  // Change 3: AMM reserve-imbalance filter — block tokens with extreme pool imbalance.
  if (!await runTokenEligibilityGates(chainName, exchange, tokenAddress, tokenData, trackInsufficient)) {
    return;
  }

  

  // Change 1: Round-trip friction pre-check — block tokens where implied tax/friction exceeds threshold.
  

  const applicability = strategy.determineApplicableStrategies(tokenData);
  if (chainName === 'bsc' && applicability.momentumLane && !tokenData.discoveryLane) {
    tokenData.discoveryLane = applicability.momentumLane;
  }
  const strategyOrder = getStrategyOrderForChain({
    config,
    chainName,
    paperTrading: config.paperTrading,
  });
  const forced = Array.isArray(options.forcedStrategies) ? options.forcedStrategies : null;
  const applicableStrategies = strategyOrder
    .filter((name) => applicability[name])
    .filter((name) => !forced || forced.includes(name));
  if (!applicableStrategies.length) {
    const forcedStrategy = forced?.[0] || null;
    const prefilterReason = forcedStrategy
      ? strategy.getStrategyPrefilterFailureReason(forcedStrategy, chainName, tokenData)
      : null;
    trackInsufficient(prefilterReason || 'strategy_not_applicable');
    return;
  }

  for (const strategyName of applicableStrategies) {
    const evaluation = await strategy.evaluateForStrategy(tokenKey, strategyName, tokenData);
    if (!evaluation.details) evaluation.details = {};
    evaluation.details.discoveryLane = evaluation.details.discoveryLane || tokenData.discoveryLane || applicability.momentumLane || null;
    await applyIntelligentModelReview({
      chainName,
      tokenKey,
      tokenData,
      strategyName,
      evaluation,
      exchange,
    });
    const cycleStats = filterStatsState.currentCycle?.[strategyName] || null;
    let aiBlockedThisToken = false;
    const isBscRelaxedContinuation = strategyName === 'momentum'
      && chainName === 'bsc'
      && String(evaluation.details.triggerTimeframe || '').toLowerCase() === 'bsc_relaxed_continuation'
      && evaluation.signal === 'BUY';

    let finalSignal = evaluation.signal;
    let signalSource = 'technical';

    if (cycleStats) {
      if (Array.isArray(evaluation.details.externalReasons)) {
        evaluation.details.externalReasons.forEach((reason) => classifyFilterReason(cycleStats, reason));
      }
      if (Boolean(evaluation.details.technicalBlocked) || finalSignal !== 'BUY') {
        cycleStats.technicalBlocked += 1;
        if (['spot_day_bull_flag', 'solana_bull_flag_v2', 'backes_swing'].includes(strategyName)
          || Array.isArray(evaluation.details.scannerReasons)
          || Array.isArray(evaluation.details.reasons)) {
          recordEvaluatorRejectReasons(cycleStats, evaluation.details);
        }
      }
    }

    ({ finalSignal, signalSource, aiBlockedThisToken } = await applyAiReviewToEvaluation({
      chainName,
      tokenData,
      strategyName,
      evaluation,
      cycleStats,
      isBscRelaxedContinuation,
    }));

    if (
      strategyName === 'momentum'
      && evaluation.details.triggerTimeframe === 'extreme_24h_momentum'
      && evaluation.details.aiReason !== 'ai_pending_advisory_only'
    ) {
      const aiApprovedExtremeMove = signalSource === 'AI' && finalSignal === 'BUY';
      if (!aiApprovedExtremeMove) {
        finalSignal = 'HOLD';
        evaluation.details.aiReason = evaluation.details.aiReason || 'extreme_move_requires_ai_buy';
        evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'extreme_move_ai_required'])];
        if (cycleStats) {
          cycleStats.aiBlocked += 1;
          aiBlockedThisToken = true;
        }
      }
    }

    const catalystGate = applyKucoinCatalystPreEventGate(
      tokenData,
      strategyName,
      finalSignal,
      evaluation,
      cycleStats
    );
    finalSignal = catalystGate.finalSignal;
    if (catalystGate.blocked) {
      aiBlockedThisToken = true;
    }

    updateTrackedToken(chainName, tokenData, {
      strategy: strategyName,
      technicalSignal: evaluation.signal,
      finalSignal,
      signalSource,
      aiReason: evaluation.details.aiReason,
      aiConfidence: evaluation.details.aiConfidence,
      riskFlags: evaluation.details.aiRiskFlags,
      details: evaluation.details,
    });

    if (finalSignal !== 'BUY') {
      if (cycleStats && !aiBlockedThisToken && signalSource === 'AI' && evaluation.signal === 'BUY') {
        cycleStats.aiBlocked += 1;
        incrementRejectReason(cycleStats, classifyRejectReason(evaluation.details.aiReason || finalSignal));
      }
      continue;
    }

    logger.info(`BUY signal on ${tokenData.symbol} (${chainName}, ${strategyName}) from ${signalSource}: RSI ${evaluation.details.rsi}, Vol spike ${evaluation.details.volumeSpike}x`);

    tokenData.signalSource = signalSource;
    tokenData.aiReason = evaluation.details.aiReason;
    tokenData.aiConfidence = evaluation.details.aiConfidence;
    tokenData.entryTriggerTimeframe = evaluation.details.triggerTimeframe || 'unknown';
    tokenData.brainArchetype = evaluation.details.brainArchetype || 'canonical_momentum_baseline';
    tokenData.brainProfileKey = evaluation.details.brainProfileKey || null;
    tokenData.marketRegime = evaluation.details.marketRegime || null;
    tokenData.realizedVolPct = Number(evaluation.details.realizedVolPct);
    tokenData.finalSignal = finalSignal;
    tokenData.patternAnalysis = evaluation.details.patternAnalysis || null;
    tokenData.externalSignal = evaluation.details.externalSignal || null;

    // Bull-flag setup propagation (Week 12 B.5): structural stop, measured-move
    // target, and manual-cut deadline travel with the tokenData into execution-flow.
    if (['spot_day_bull_flag', 'solana_bull_flag_v2'].includes(strategyName)
      && ['spot_day_bull_flag', 'solana_bull_flag_v2'].includes(evaluation.details.setupType)) {
      tokenData.setupType = evaluation.details.setupType;
      tokenData.strategyVariant = evaluation.details.setupType;
      tokenData.structureType = evaluation.details.structureType || evaluation.details.setupType;
      tokenData.structuralStopPrice = Number(evaluation.details.stopPrice) || null;
      tokenData.measuredMoveTargetPrice = Number(evaluation.details.targetPrice) || null;
      tokenData.breakoutClosePrice = Number(evaluation.details.breakoutClose) || null;
      tokenData.flagHighPrice = Number(evaluation.details.flagHigh) || null;
      tokenData.flagLowPrice = Number(evaluation.details.flagLow) || null;
      tokenData.poleStartPrice = Number(evaluation.details.poleStartPrice) || null;
      tokenData.poleHighPrice = Number(evaluation.details.poleHighPrice) || null;
      tokenData.expectedFeesBps = Number(evaluation.details.expectedFeesBps) || null;
      tokenData.expectedSlippageBps = Number(evaluation.details.expectedSlippageBps) || null;
      tokenData.expectedSpreadBps = Number(evaluation.details.expectedSpreadBps) || null;
      const activeBullFlagCfg = config.strategies?.[strategyName] || config.strategies?.spot_day_bull_flag || {};
      const cutCandles = Number(activeBullFlagCfg.manualCutCandlesNoFollowThrough || config.strategies?.spot_day_bull_flag?.manualCutCandlesNoFollowThrough || 3);
      const cutTimeframeMin = Number(activeBullFlagCfg.manualCutTimeframeMinutes || config.strategies?.spot_day_bull_flag?.manualCutTimeframeMinutes || 5);
      tokenData.manualCutDeadlineAt = new Date(Date.now() + cutCandles * cutTimeframeMin * 60_000).toISOString();
      tokenData._bullFlagRiskPct = Number(evaluation.details.riskPct) || null;
      tokenData._bullFlagIsAPlus = Boolean(evaluation.details.isAPlus);
    } else if (strategyName === 'backes_swing' && evaluation.details.setupType === 'backes_swing') {
      tokenData.setupType = 'backes_swing';
      tokenData.strategyVariant = 'backes_swing';
      tokenData.structureType = evaluation.details.structureType || null;
      tokenData.structuralStopPrice = Number(evaluation.details.invalidationPrice || evaluation.details.stopPrice) || null;
      tokenData.measuredMoveTargetPrice = Array.isArray(evaluation.details.targetPrices)
        ? Number(evaluation.details.targetPrices[0]) || null
        : Number(evaluation.details.targetPrice) || null;
      tokenData.targetPrices = Array.isArray(evaluation.details.targetPrices) ? evaluation.details.targetPrices : [];
      tokenData.invalidationPrice = tokenData.structuralStopPrice;
      tokenData.macroRegime = evaluation.details.macroRegime || null;
      tokenData._backesRiskPct = Number(evaluation.details.riskPct) || null;
      tokenData._macroSizeMultiplier = Number(evaluation.details.macroSizeMultiplier || evaluation.details.sizeMultiplier || 1);
    } else if (strategyName !== 'momentum') {
      tokenData.setupType = strategyName;
      tokenData.strategyVariant = strategyName;
      tokenData.structureType = evaluation.details.structureType || strategyName;
      tokenData.structuralStopPrice = Number(evaluation.details.stopPrice || evaluation.details.invalidationPrice) || null;
      tokenData.measuredMoveTargetPrice = Number(evaluation.details.targetPrice) || null;
      tokenData._strategyRiskPct = Number(evaluation.details.riskPct) || null;
      tokenData._strategyMaxSlippagePct = Number(evaluation.details.maxSlippagePct) || null;
      tokenData.useMevJitter = evaluation.details.useMevJitter === true;
    }

    const activeRollout = getActivePromotionRolloutContext();
    if (activeRollout) {
      const tokenRegimeFamily = classifyRegimeFamily(tokenData.marketRegime || '');
      const regimeMatch = activeRollout.regimeFamily === 'unknown'
        || tokenRegimeFamily === 'unknown'
        || tokenRegimeFamily === activeRollout.regimeFamily;
      if (activeRollout.stage === 'canary_live') {
        tokenData._promotionRolloutMultiplier = Math.max(0.05, Math.min(1, activeRollout.canaryLiveSizePct / 100));
        tokenData._promotionRolloutStage = 'canary_live';
        tokenData._promotionRolloutRegimeMatch = regimeMatch;
        if (!regimeMatch) {
          logger.info(`Skipping ${tokenData.symbol}: rollout regime mismatch (${tokenRegimeFamily} vs ${activeRollout.regimeFamily})`);
          continue;
        }
      } else if (activeRollout.stage === 'scaled_live') {
        tokenData._promotionRolloutMultiplier = 1;
        tokenData._promotionRolloutStage = 'scaled_live';
      }
    }

    // Recovery mode size multiplier – applied in guardian.positionSize()
    const _rm = getRecoveryMode();
    tokenData._recoveryMultiplier = _rm.active ? _rm.sizeMultiplier : 1;
    tokenData._recoverySeverity = _rm.active ? _rm.severity : 'none';
    // Macro intelligence size multiplier — bullish market allows slightly larger positions
    tokenData._macroSizeMultiplier = Number(tokenData._macroSizeMultiplier || evaluation.details.macroSizeMultiplier || 1);

    const proposal = buildDecisionProposal({
      chainName,
      tokenData,
      strategyName,
      signalSource,
      evaluation,
    });
    const proposalDecisionId = queueDecisionTelemetry({
      stage: 'proposal',
      tokenData,
      chainName,
      strategyName,
      signalSource,
      proposal,
      finalAction: 'PROPOSE',
      approved: false,
      reason: evaluation.details.aiReason || `${signalSource} BUY candidate`,
      status: 'proposed',
    });

    const riskCheck = await risk.canTrade(tokenData, strategy.priceHistory || {}, strategyName);
    const riskReview = buildDecisionRiskReview({
      chainName,
      tokenData,
      strategyName,
      riskCheck,
      evaluation,
    });
    queueDecisionTelemetry({
      stage: 'risk',
      tokenData,
      chainName,
      strategyName,
      signalSource,
      proposal,
      riskReview,
      finalAction: riskCheck.allowed ? 'RISK_PASS' : 'RISK_REJECT',
      approved: Boolean(riskCheck.allowed),
      reason: riskCheck.reason || 'risk reviewed',
      status: riskCheck.allowed ? 'passed' : 'blocked',
    });
    const decisionResult = await handleApprovedTradeDecision({
      chainName,
      exchange,
      tokenData,
      strategyName,
      evaluation,
      signalSource,
      cycleStats,
      proposalDecisionId,
      proposal,
      riskReview,
      riskCheck,
    });
    if (decisionResult === 'bought') {
      return;
    }
    continue;
  }
}



// Exit decision logic extracted to src/exits/evaluate-exit-decision.js (Week 7 Track A, 2026-05-17).


const { recoverFailedSellExecutionFromExchange: _recoverFailedSellExecutionFromExchange } = createSellRecovery({ logger });

const { executeBuy, executeSell, finalizeSellExecution } = createExecutionOrchestrator({
  config,
  logger,
  portfolio,
  risk,
  positionSizingEngine,
  positionMutex,
  telemetry,
  telemetryUuid,
  sqlCoordination,
  executionFlow,
  runPreTradeContract,
  aiCircuit,
  AITradeBrain,
  BOT_PROFILE,
  applyPositionJitter,
  getRandomEntryDelay,
  sleep,
  withTimeout,
  shouldSplitSolanaTrade,
  generateSplitTradeSchedule,
  executeBuyViaVenue,
  executeSellViaVenue,
  getNativeQuoteOrThrow,
  ensureStatsShape,
  round,
  recoverFailedSellExecutionFromExchange: _recoverFailedSellExecutionFromExchange,
});

const { checkExitConditions } = createExitConditions({
  config,
  logger,
  portfolio,
  strategy,
  buildTokenKey,
  applyTrailingStopState,
  shouldExtendMaxHold,
  shouldDelayBorderlineStop,
  getExecuteSell: () => executeSell,
});

const { tryRotateForStrongerMomentum } = createMomentumRotator({
  config,
  logger,
  portfolio,
  marketState,
  exchanges,
  CHAIN_LABELS,
  round,
  normalizeChainKey,
  normalizeConfidencePercent,
  normalizeRotationVolumeSpike,
  buildMomentumMetrics,
  buildMomentumState,
  scoreMomentumCandidate,
  scoreOpenMomentumPosition,
  refreshTrackedOpenPositionSnapshot,
  withTimeout,
  getExecuteSell: () => executeSell,
});


function resetPaperPortfolio(balance) {
  const nextBalance = Number(balance || config.paperBalance || 10000);

  portfolio.startingBalance = nextBalance;
  portfolio.balance = nextBalance;
  portfolio.walletBalanceUsd = null;
  portfolio.walletBalancesUsd = {
    solana: null,
    bsc: null,
    base: null,
    kucoin: null,
  };
  portfolio.balanceCoverageCount = null;
  portfolio.balanceDrift = { amountUsd: 0, pct: 0 };
  portfolio.balanceDriftHalt = false;
  portfolio.executionJournal = {};
  portfolio.positions = {};
  portfolio.trades = [];
  portfolio.stats = defaultStatsShape();
  portfolio.strategies = Object.fromEntries(
    RUNTIME_STRATEGY_NAMES.map((strategyName) => [
      strategyName,
      { positions: {}, trades: [], stats: defaultStatsShape() },
    ])
  );
  portfolio.pnlHistory = [];

  risk.dailyStartBalance = nextBalance;
  risk.haltedToday = false;

  refreshPerformanceMetrics();

  recordPortfolioSnapshot('reset');
  return getPortfolioSnapshot();
}

async function runBacktestRequest(payload) {
  return researchHandlers.runBacktestRequest(payload);
}

async function seedBacktestData(priceHistory, volumeHistory, tokenAddress, chain) {
  return researchHandlers.seedBacktestData(priceHistory, volumeHistory, tokenAddress, chain);
}

async function ensureResearchHistory(tokenAddress, chainKey) {
  return researchHandlers.ensureResearchHistory(tokenAddress, chainKey);
}

async function runHyperoptRequest(payload) {
  return researchHandlers.runHyperoptRequest(payload);
}

async function runValidationRequest(payload) {
  return researchHandlers.runValidationRequest(payload);
}

async function runPositionResearchRequest(payload) {
  return researchHandlers.runPositionResearchRequest(payload);
}

function getResearchTargets() {
  return researchHandlers.getResearchTargets();
}

async function runSimulationRequest(payload) {
  return researchHandlers.runSimulationRequest(payload);
}

async function previewAiSignal(payload) {
  return researchHandlers.previewAiSignal(payload);
}

function onConfigUpdated() {
  strategy.refreshSettings();
  refreshBrainAvailability();

  if (config.paperTrading && portfolio.trades.length === 0 && Object.keys(portfolio.positions).length === 0) {
    portfolio.startingBalance = Number(config.paperBalance || portfolio.startingBalance || 10000);
    portfolio.balance = portfolio.startingBalance;
    risk.dailyStartBalance = portfolio.startingBalance;
    portfolio.pnlHistory = [];
  }

  const haltState = risk.reconcileDailyHaltState('config update');
  if (haltState.changed) {
    saveState().catch((error) => logger.error(`Failed to persist cleared daily halt after config update: ${error.message}`));
  }

  restartLoopSchedulers();
  recordPortfolioSnapshot('config');
}

function clearLoopSchedulers() {
  return _mainLoopModule.clearLoopSchedulers({
    state: _mainLoopState,
    deps: { stopOracleStopWatchers },
  });
}

function getMsUntilNextDailyReset(now = new Date()) {
  const nextReset = new Date(now);
  nextReset.setHours(24, 0, 0, 0);
  return Math.max(0, nextReset.getTime() - now.getTime());
}

function shouldPauseKucoinEntryScans() {
  const warmupWindowMs = 30 * 60 * 1000;
  const msUntilReset = getMsUntilNextDailyReset();
  if (msUntilReset <= warmupWindowMs) {
    return {
      paused: false,
      reason: 'kucoin_reset_warmup_window',
      msUntilReset,
    };
  }

  const performanceGate = risk.checkPerformanceGate(portfolio.stats || {});
  if (!performanceGate.allowed) {
    const reasonText = String(performanceGate.reason || '').toLowerCase();
    if (reasonText.includes('daily loss')) {
      return {
        paused: true,
        reason: performanceGate.reason,
        msUntilReset,
      };
    }
  }

  return {
    paused: false,
    reason: null,
    msUntilReset,
  };
}

// Scan cycle dispatchers extracted to src/cycle/scan-cycle.js (Week 9.4, 2026-05-18).
// runStrategyScanCycle + runDetachedKucoinMomentumScan — 120 lines moved + dep-injected.
const _scanCycleFactory = require('./cycle/scan-cycle').create({
  loopLocks,
  loopLastCompletedAt,
  filterStatsState,
  config,
  logger,
  refreshScanInFlightFlag,
  isWithinTradingWindow,
  shouldPauseKucoinEntryScans,
  withTimeout,
  exchanges,
  isStrategyScanEnabled,
  scanChain,
  startFilterCycle,
  finalizeFilterCycle,
  getStrategyScanStatus,
  syncChainScanStatus,
  recordPortfolioSnapshot,
  saveState,
});
const runStrategyScanCycle = _scanCycleFactory.runStrategyScanCycle;
const runDetachedKucoinMomentumScan = _scanCycleFactory.runDetachedKucoinMomentumScan;

/**
 * Evict positions that have been in stuckPositions for > STUCK_EVICTION_HOURS hours.
 * Moves them out of portfolio.positions into untrackedWalletPositions so slots are freed.
 */
// Maintenance utilities extracted to src/cycle/maintenance.js (Week 9.5, 2026-05-18).
const _maintenanceModule = require('./cycle/maintenance');
const evictStuckPositions = _maintenanceModule.createEvictStuckPositions({
  portfolio, logger, saveState,
});

// Exit cycle dispatchers extracted to src/cycle/exit-pass.js (Week 9.2 cycle split, 2026-05-18).
// runStrategyExitCycle + runRealtimeRiskStopCycle — 280 lines moved + dep-injected.
const _exitPassFactory = require('./cycle/exit-pass').create({
  portfolio,
  marketState,
  loopLocks,
  loopLastCompletedAt,
  config,
  risk,
  CHAIN_LABELS,
  exchanges,
  isExchangeAvailable,
  normalizeChainKey,
  buildTokenKey,
  recordStrategyTick,
  refreshTrackedOpenPositionSnapshot,
  evictStuckPositions,
  checkExitConditions,
  executeSell,
  applyTrailingStopState,
  shouldDelayBorderlineStop,
  getOraclePriceUsdForPosition,
  withTimeout,
  logger,
});
const runStrategyExitCycle = _exitPassFactory.runStrategyExitCycle;
const runRealtimeRiskStopCycle = _exitPassFactory.runRealtimeRiskStopCycle;

async function runMarketIntelligenceCycle() {
  if (loopLocks.intelligence) return;
  loopLocks.intelligence = true;
  try {
    const openPositionSummary = Object.values(portfolio.positions || {})
      .map((p) => `${p.symbol}(${p.chain}) entry=$${Number(p.entryPrice || 0).toFixed(4)}`)
      .join(', ') || 'none';

    const result = await intelligenceAgent.runCycle(portfolio.stats || {}, openPositionSummary);
    if (result?.synthesized && result.report) {
      await saveState().catch((e) => logger.error(`State save after intelligence cycle: ${e.message}`));
    }
  } catch (err) {
    logger.error(`Intelligence cycle error: ${err.message}`);
  } finally {
    loopLocks.intelligence = false;
  }
}

function getChainPerformanceSnapshot() {
  const out = {};
  for (const [strategyName, strategyStats] of Object.entries(portfolio.strategies || {})) {
    const positions = Object.values(strategyStats.positions || {});
    const byChain = {};
    for (const position of positions) {
      const chain = String(position.chain || 'unknown');
      byChain[chain] = (byChain[chain] || 0) + 1;
    }
    out[strategyName] = {
      openPositions: positions.length,
      byChain,
      closedTrades: Number(strategyStats.closedTrades || 0),
      wins: Number(strategyStats.wins || 0),
      losses: Number(strategyStats.losses || 0),
    };
  }
  return out;
}

function getSignalQualitySnapshot() {
  const recentSignals = marketState.signals.slice(0, 80);
  const buySignals = recentSignals.filter((signal) => signal.finalSignal === 'BUY');
  const losingClosures = (portfolio.trades || [])
    .filter((trade) => String(trade.side || '').toUpperCase() === 'SELL' && Number(trade.pnl || 0) < 0)
    .slice(0, 40);
  const falsePositiveRatePct = buySignals.length > 0
    ? (losingClosures.length / buySignals.length) * 100
    : 0;
  return {
    signalCount: recentSignals.length,
    buySignalCount: buySignals.length,
    falsePositiveRatePct: Number(falsePositiveRatePct.toFixed(2)),
  };
}

function getFillQualitySnapshot() {
  const tradeRows = (portfolio.trades || []).slice(0, 60);
  const withSlippage = tradeRows.filter((trade) => Number.isFinite(Number(trade.slippageBps)));
  const withDiscrepancy = tradeRows.filter((trade) => Number.isFinite(Number(trade.fillDiscrepancyPct)));
  const avgSlippagePct = withSlippage.length
    ? withSlippage.reduce((sum, trade) => sum + (Number(trade.slippageBps || 0) / 100), 0) / withSlippage.length
    : 0;
  const avgFillDiscrepancyPct = withDiscrepancy.length
    ? withDiscrepancy.reduce((sum, trade) => sum + Number(trade.fillDiscrepancyPct || 0), 0) / withDiscrepancy.length
    : 0;
  return {
    sampleSize: tradeRows.length,
    avgSlippagePct: Number(avgSlippagePct.toFixed(4)),
    avgFillDiscrepancyPct: Number(avgFillDiscrepancyPct.toFixed(4)),
  };
}

const tradeRepairHelpers = createTradeRepairHelpers({
  portfolio,
  logger,
  exchanges,
  config,
  normalizeChainKey,
  buildTokenKey,
  ensureStatsShape,
  extractFilledBaseQty,
  extractFilledQuoteUsd,
  extractExecutionPriceUsd,
  calcSlippageBps,
  calcDiscrepancyPct,
  round,
  setExecutionJournalState,
  refreshPerformanceMetrics,
  recordPortfolioSnapshot,
  saveState: (...args) => saveState(...args),
});

const researchHandlers = createResearchHandlers({
  config,
  logger,
  marketState,
  strategy,
  exchanges,
  CHAIN_LABELS,
  normalizeChainKey,
  buildTokenKey,
  getTrackedTokens,
  getPortfolioSnapshot,
  getHistorySeries,
  getOhlcvSeries,
  runBacktest,
  runBacktestWithRegimes,
  runWalkForwardBacktest,
  runRegimeSpecificBacktest,
  runPortfolioBacktest,
  runPaperSimulation,
  runHyperopt,
  runValidation,
  buildBaseBacktestOptions,
  AITradeBrain,
  recordBrainSuccess,
  recordBrainFailure,
  refreshBrainAvailability,
  round,
});

const selfEvolutionOrchestration = createSelfEvolutionOrchestration({
  config,
  logger,
  marketState,
  portfolio,
  filterStatsState,
  operationalDiagnostics,
  intelligenceAgent,
  agentMemory,
  getHealthStatus,
  getChainPerformanceSnapshot,
  getSignalQualitySnapshot,
  getFillQualitySnapshot,
  telemetry,
  evolutionGovernor,
  selfEvolution,
  evolutionValidator,
  strategyLab,
  saveState: (...args) => saveState(...args),
  shutdownAndExit: (...args) => shutdownAndExit(...args),
  LIVE_ROLLOUT_PATH,
  execFileSync,
  processExecPath: process.execPath,
  rollbackScriptPath: path.join(PROJECT_ROOT, 'scripts', 'rollback-live-promotion.js'),
  projectRoot: PROJECT_ROOT,
  pathModule: path,
  loopLocks,
  strategyVersionId: CURRENT_STRATEGY_VERSION_ID,
  strategyVersionHash: CURRENT_STRATEGY_VERSION_HASH,
});

const statePersistence = createStatePersistence({
  logger,
  telemetry,
  portfolio,
  risk,
  strategy,
  marketState,
  config,
  BOT_PROFILE,
  BOT_DATA_DIR,
  DATA_DIR_ABS,
  STATE_PATH,
  MARKET_STATE_PATH,
  STATE_BACKUP_PATH,
  MARKET_STATE_BACKUP_PATH,
  STATE_TMP_PATH,
  MARKET_STATE_TMP_PATH,
  SELF_EVOLUTION_HISTORY_PATH,
  recordRuntimeDelta,
  setStatePersistenceError,
  getStatePersistenceError: () => statePersistenceError,
  getSaveFailureCount: () => saveFailureCount,
  setSaveFailureCount: (value) => { saveFailureCount = Number(value || 0); },
  agentMemory,
  ensureRuntimeStateShape,
  ensureLearningStateShape,
  ensureStatsShape,
  refreshPerformanceMetrics,
  normalizeChainKey,
  buildTokenKey,
  enterSafeMode: (...args) => enterSafeMode(...args),
});

function getSelfEvolutionContext() {
  return selfEvolutionOrchestration.getSelfEvolutionContext();
}

async function evaluateActiveEvolutionExperiment() {
  return selfEvolutionOrchestration.evaluateActiveEvolutionExperiment();
}

async function evaluateLivePromotionHealth() {
  return selfEvolutionOrchestration.evaluateLivePromotionHealth();
}

async function runSelfEvolutionCycle() {
  return selfEvolutionOrchestration.runSelfEvolutionCycle();
}

async function trainPaperRlPolicy() {
  if (config.paperTrading !== true || config.rl?.enabled === false || config.rl?.paperTrainingEnabled === false) {
    return null;
  }

  const featureSeries = buildFeatureSeriesFromHistories(
    strategy.priceHistory || {},
    strategy.volumeHistory || {},
    Number(config.rl?.trainingSeriesLimit || 12)
  );

  if (featureSeries.length < 100) {
    logger.debug(`[RL] Skipping paper RL training: only ${featureSeries.length} feature rows available`);
    return null;
  }

  const policy = trainQPolicy(featureSeries, {
    episodes: Number(config.rl?.trainingEpisodes || 24),
    environment: {
      feePct: Number(config.execution?.slippageBps || 100) / 100,
      drawdownPenalty: 0.4,
      churnPenalty: 0.04,
      holdBonus: 0.01,
    },
  });

  const policyId = await modelRegistry.upsertRlPolicy({
    policyName: 'paper_rl_default',
    botProfile: 'paper',
    stage: 'paper_training',
    status: 'active',
    policy,
    metrics: {
      featureRows: featureSeries.length,
      stateCount: policy.stateCount,
      episodes: policy.episodes,
    },
  }).catch((error) => {
    logger.warn(`[RL] paper policy persistence failed: ${error.message}`);
    return null;
  });

  if (policyId) {
    logger.info(`[RL] Paper policy refreshed | rows=${featureSeries.length} states=${policy.stateCount} episodes=${policy.episodes}`);
  }
  return { policyId, featureRows: featureSeries.length, stateCount: policy.stateCount };
}

function setupHealthCanary() {
  const path = require('path');
  const { register } = require('./cycle/canary-scheduler');
  register({
    logger,
    ctx: {
      memoryPath: path.join(DATA_DIR_ABS, 'agent-memory.json'),
      bootTimeMs: BOOT_TIME_MS,
      dataDir: DATA_DIR_ABS,
      scope: BOT_PROFILE,
      aiCircuit,
      getMemorySnapshot: () => agentMemory?.data,
      getPositions: () => portfolio?.positions,
      getDailyPnlUsd: () => Number(portfolio?.stats?.todaysPnl || 0),
      sendHealthAlert: typeof sendHealthAlert === 'function' ? sendHealthAlert : null,
    },
  });
}

function restartLoopSchedulers() {
  const _mlTrainingSchedulerModule = require('./cycle/ml-training-scheduler');
  return _mainLoopModule.restartLoopSchedulers({
    state: _mainLoopState,
    loopLocks,
    refreshScanInFlightFlag,
    deps: {
      portfolio,
      config,
      logger,
      runStrategyScanCycle,
      runStrategyExitCycle,
      runRealtimeRiskStopCycle,
      updateWalletBalance,
      refreshBscNativePrice,
      runSelfEvolutionCycle,
      runMarketIntelligenceCycle,
      evictStuckPositions,
      startOracleStopWatchers,
      stopOracleStopWatchers,
      strategyNames: RUNTIME_STRATEGY_NAMES,
      mlTrainingSchedulerRegister: _mlTrainingSchedulerModule.register,
      mlTrainingSchedulerCtx: {
        config,
        portfolio,
        modelRegistry,
        rlOnlineUpdater,
        trainPaperRlPolicy,
        sendHeartbeat,
        sendErrorAlert,
      },
    },
  });
}

// Wallet balance + BSC native price refresh extracted to src/cycle/wallet-balance-refresh.js
// (Week 7 Track B, 2026-05-17). Delegating wrappers preserve original signature; multiple
// callsites (timer setup, lessons hot path, init bootstrap) call these by name.
const _walletBalanceRefreshModule = require('./cycle/wallet-balance-refresh');
async function refreshBscNativePrice() {
  return _walletBalanceRefreshModule.refreshBscNativePrice({ exchanges, loopLastCompletedAt });
}
async function updateWalletBalance() {
  return _walletBalanceRefreshModule.updateWalletBalance({
    exchanges, portfolio, config, loopLastCompletedAt, round,
  }, logger);
}

async function main() {
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error('Configuration validation failed. Check logs for missing env vars.');
  }

  refreshBrainAvailability();
  await loadState();
  const sqlSelfTest = await runSqlSelfTest(logger);
  sqlRuntimeState.selfTestOk = Boolean(sqlSelfTest?.ok);
  sqlRuntimeState.selfTestReason = sqlSelfTest?.reason || (sqlSelfTest?.enabled === false ? 'sql_disabled' : 'ok');
  sqlRuntimeState.lastSelfTestAt = new Date().toISOString();

  // Week 11.3 — Schema version gate. Lenient by default (warn only); flip to
  // strict via VERSION_GATE_STRICT=true after release cadence stabilizes.
  try {
    const { checkSchemaVersion } = require('./boot/version-gate');
    const { getPool } = require('./utils/sqlServer');
    const minV = Number(process.env.BOT_MIN_SCHEMA_VERSION || 17); // M001..M017 applied as of Week 6
    const maxV = process.env.BOT_MAX_SCHEMA_VERSION ? Number(process.env.BOT_MAX_SCHEMA_VERSION) : undefined;
    const strict = String(process.env.VERSION_GATE_STRICT || 'false').toLowerCase() === 'true';
    await checkSchemaVersion({
      getPool,
      logger,
      minSchemaVersion: minV,
      maxSchemaVersion: maxV,
      strict,
    });
  } catch (e) {
    if (e.code && String(e.code).startsWith('VERSION_GATE_')) throw e;
    logger.warn(`[version-gate] check skipped: ${e.message}`);
  }

  if (sqlSelfTest?.enabled !== false) {
    const sqlStatus = getSqlStatus();
    logger.info(
      `[SQL] startup self-test ${sqlSelfTest.ok ? 'passed' : 'failed'} | ` +
      `db=${sqlStatus.databaseName || 'unknown'} explicitDb=${sqlStatus.databaseExplicit ? 'yes' : 'no'} ` +
      `schema=${sqlStatus.schemaReady ? 'ready' : 'not_ready'}`
    );
  }
  await agentMemory.load();
  // Boot-heartbeat: touch agent-memory.json so memory_mtime canary passes even
  // when SQL is primary (save() returns early on SQL success without writing file).
  try {
    const fsp = require('fs').promises;
    const path = require('path');
    const memPath = path.join(__dirname, '..', process.env.BOT_DATA_DIR || 'data', 'agent-memory.json');
    const now = new Date();
    await fsp.utimes(memPath, now, now).catch(async () => {
      // File may not exist yet — create empty stub
      await fsp.writeFile(memPath, JSON.stringify(agentMemory.data || {}, null, 2), 'utf8').catch(() => {});
    });
  } catch (e) { logger.warn(`[AgentMemory] boot heartbeat touch failed: ${e.message}`); }
  await modelRegistry.ensureReady().catch((error) => {
    logger.warn(`[ModelRegistry] startup ensure failed: ${error.message}`);
    return null;
  });
  let addedKnowledge = 0;
  if (typeof agentMemory.ensureChartPatternPlaybook === 'function') {
    addedKnowledge += agentMemory.ensureChartPatternPlaybook();
  }
  if (typeof agentMemory.ensureCoreTrainingPlaybook === 'function') {
    addedKnowledge += agentMemory.ensureCoreTrainingPlaybook();
  }
  if (addedKnowledge > 0) {
    logger.info(`[AgentMemory] Seeded ${addedKnowledge} operator training knowledge entries`);
    await agentMemory.saveIfDirty();
  }
  ensureStatsShape();
  refreshPerformanceMetrics();
  await telemetry.startRun({
    configHash: CURRENT_STRATEGY_VERSION_HASH,
    meta: {
      profile: BOT_PROFILE,
      dataDir: BOT_DATA_DIR,
      paperTrading: Boolean(config.paperTrading),
      port: config.bot?.port,
    },
  });
  telemetry.logStrategyVersion({
    version_id: CURRENT_STRATEGY_VERSION_ID,
    version_hash: CURRENT_STRATEGY_VERSION_HASH,
    bot_profile: BOT_PROFILE,
    source_profile: BOT_PROFILE,
    stage: config.paperTrading ? 'paper_active' : 'live_active',
    config_hash: CURRENT_STRATEGY_VERSION_HASH,
    code_hash: CURRENT_STRATEGY_VERSION_HASH,
    metadata: {
      paperTrading: Boolean(config.paperTrading),
      port: config.bot?.port,
    },
  });

  logger.info('=========================================');
  logger.info(' DEX Trading Bot - Starting up (multi strategy)');
  logger.info(` Runtime profile: ${BOT_PROFILE} (paper=${config.paperTrading ? 'yes' : 'no'}) dataDir=${BOT_DATA_DIR}`);
  logger.info(`  Mode: ${config.paperTrading ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  logger.info(`  Discovery Mode: ${config.bot.discoveryMode || 'hybrid'}`);
  getDeploymentSummary(config, config.paperTrading).forEach((row) => {
    const status = row.enabled ? `enabled on ${row.chains.join(',') || 'none'}` : 'disabled';
    const suffix = row.implemented ? '' : ' (planned, no runtime)';
    logger.info(`  Strategy ${row.strategy}: ${status} | ${row.stage}${suffix}`);
  });
  logger.info(`  Momentum Scan Interval: ${config.bot.momentumScanIntervalSeconds || 75}s`);
  logger.info(`  Bull-Flag Scan Interval: ${config.bot.bullFlagScanIntervalSeconds || 90}s`);
  logger.info(`  Momentum Exit Checks: every ${config.bot.momentumExitCheckMinutes || 15}m`);
  logger.info(`  Bull-Flag Exit Checks: every ${config.bot.bullFlagExitCheckMinutes || config.bot.momentumExitCheckMinutes || 15}m`);
  logger.info(`  Realtime Stop Monitor: ${config.risk?.realtimeStopLossEnabled !== false ? `enabled (${config.risk?.realtimeStopCheckSeconds || 8}s)` : 'disabled'}`);
  logger.info(`  AI Brain: ${config.anthropic.enabled ? config.anthropic.model : 'disabled'}`);
  logger.info(
    `  Self-Evolution: ${config.selfEvolution?.enabled === true
      ? `enabled (${config.selfEvolution?.intervalMinutes || 180}m, autoApply=${config.selfEvolution?.autoApply === true ? 'on' : 'off'})`
      : 'disabled'}`
  );
  
  // Log external filter configuration
  const filterCfg = config.filters || {};
  const redditDisabled = filterCfg.reddit?.disabledChains || [];
  logger.info(`  Reddit Filter: ${filterCfg.reddit?.enabled !== false ? `enabled (${filterCfg.reddit?.lookbackHours || 24}h window, min ${filterCfg.reddit?.minPostsRequired || 0} posts)` : 'disabled'}${redditDisabled.length ? ` [disabled for: ${redditDisabled.join(', ')}]` : ''}`);
  logger.info(`  CoinCap Filter: ${filterCfg.coincap?.enabled !== false ? `enabled (${(filterCfg.coincap?.maxPriceMismatchPct || 15)}% max mismatch)` : 'disabled'}`);
  logger.info(`  CryptoCompare Filter: ${filterCfg.cryptocompare?.enabled !== false ? `enabled (${(filterCfg.cryptocompare?.maxPriceMismatchPct || 15)}% max mismatch)` : 'disabled'}`);
  logger.info(`  DeFiLlama Enrichment: ${filterCfg.defillama?.enabled !== false ? 'enabled (best-effort TVL context)' : 'disabled'}`);
  logger.info('=========================================');

  if (!config.paperTrading) {
    logger.warn('LIVE TRADING ACTIVE - real funds at risk. You have 10 seconds to abort (Ctrl+C).');
    await sleep(config.bot.liveAbortDelayMs);
  }

  recordPortfolioSnapshot('boot');
  await initializeExchanges();
  syncLiquiditySentinelsFromPortfolio();
  await wsDiscovery.start(exchanges);

  if (!config.paperTrading) {
    await updateWalletBalance();
    await reconcileWalletPositions();
    const deployedCapitalUsd = Object.values(portfolio.positions || {})
      .reduce((sum, pos) => sum + Number(pos?.costBasisUsd || pos?.initialSizeUsd || 0), 0);
    // walletBalanceUsd is the free cash in the wallet — token positions are already excluded
    // (the USDT spent on them left the wallet at buy time). Do NOT subtract deployedCapitalUsd
    // again or the ledger starts at $0 and immediately triggers a 100% drift halt on every restart.
    // 2026-05-23: if wallet returned 0 (RPCs down at boot), keep persisted balance instead
    // of overwriting it with 0 — wallet-balance-refresh will auto-rebase once coverage recovers.
    const bootWalletUsd = Number(portfolio.walletBalanceUsd || 0);
    if (bootWalletUsd > 0) {
      portfolio.balance = bootWalletUsd;
      portfolio.startingBalance = portfolio.balance;
      portfolio.balanceDriftHalt = false;
    } else {
      logger.warn(`Boot wallet balance is $0 (likely RPC unavailable); keeping persisted cash ledger $${Number(portfolio.balance || 0)}`);
    }
    if (risk.dailyResetDate !== risk.getLocalDateStamp()) {
      logger.info(`Risk day rollover detected on startup: ${risk.dailyResetDate || 'none'} -> ${risk.getLocalDateStamp()}`);
      risk.resetDaily();
    } else if (!Number.isFinite(Number(risk.dailyStartBalance)) || Number(risk.dailyStartBalance) <= 0) {
      risk.dailyStartBalance = Number(portfolio.balance || 0);
      risk.dailyResetDate = risk.getLocalDateStamp();
    }
    risk.reconcileDailyHaltState('startup');
    logger.info(`Startup cash balance: walletBalance=$${portfolio.walletBalanceUsd}, deployedCapital=$${round(deployedCapitalUsd)}, freeCash=$${portfolio.balance}`);
  }

  await cleanupNonTradeLogs(logger);
  const repairedSellFailures = await tradeRepairHelpers.repairAmbiguousKucoinSellFailures({ applyCashLedger: false })
    .catch((error) => {
      logger.error(`Startup SELL_FAILED repair pass failed: ${error.message}`);
      return 0;
    });
  if (repairedSellFailures > 0) {
    logger.warn(`Recovered ${repairedSellFailures} historical KuCoin sell failure record(s) from exchange history`);
  }
  await saveState();

  const dashboard = startDashboard(portfolio, {
    marketState,
    getTrackedTokens,
    getDashboardState: buildDashboardState,
    getAiCircuitState: () => ({ cooldownUntil: aiCircuit.cooldownUntil, failures: aiCircuit.failures }),
    runBacktestRequest,
    runHyperoptRequest,
    runValidationRequest,
    runPositionResearchRequest,
    seedBacktestData,
    runSimulationRequest,
    previewAiSignal,
    ingestExternalSignal,
    getResearchTargets,
    resetPaperPortfolio,
    saveState,
    onConfigUpdated,
    getHealthStatus,
    getFilterStatsHistory: () => {
      const combined = [
        ...(filterStatsState.recentCycles?.momentum || []),
        ...(filterStatsState.recentCycles?.swing || []),
      ].sort((left, right) => {
        const l = Date.parse(left?.completedAt || left?.startedAt || '') || 0;
        const r = Date.parse(right?.completedAt || right?.startedAt || '') || 0;
        return r - l;
      });
      return combined.slice(0, 10);
    },
    getScanCounterMismatches: () => getScanCounterMismatchState(),
    clearSafeMode: () => {
      clearSafeModeState();
      restartLoopSchedulers();
      return {
        safeMode: portfolio.safeMode,
        statePersistenceError: portfolio.statePersistenceError,
      };
    },
    clearTrackedTokensAndSignals,
    forceSellPosition: async (positionKey, reason = 'DASHBOARD_MANUAL') => {
      const position = portfolio.positions[positionKey];
      if (!position) return { ok: false, error: `position not found: ${positionKey}` };
      const chainKey = position.chainKey || normalizeChainKey(position.chain);
      const exchange = exchanges[chainKey];
      if (!exchange) return { ok: false, error: `exchange not initialized for chain ${chainKey}` };
      try {
        const tokenData = await exchange.getTokenData(position.address);
        if (!tokenData || !tokenData.price) {
          return { ok: false, error: 'token data unavailable; refusing to sell blind' };
        }
        await executeSell(chainKey, exchange, tokenData, position, 1, reason);
        return { ok: true, symbol: position.symbol, chain: chainKey, reason };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    },
    modelRegistry,
    getAgentMemoryState: () => agentMemory?.getState?.() || {
      lessons: 0,
      recentLessons: [],
      blacklistedTokens: {},
    },
  });
  dashboardServer = dashboard?.server;
  dashboardWss = dashboard?.wss;

  // Clear safe mode if it was entered due to state mismatch
  if (portfolio.safeMode && portfolio.statePersistenceError) {
    clearSafeModeState();
  }

  restartLoopSchedulers();
  setupHealthCanary(); // independent of safe mode — canary must run even when bot paused
  await reconcileExecutionJournal().catch((error) => logger.error(`Initial execution journal reconciliation failed: ${error.message}`));
  await persistSqlStateSnapshot('startup').catch((error) => logger.warn(`Startup SQL state snapshot failed: ${error.message}`));
  await syncQueryableSqlState().catch((error) => logger.warn(`Startup SQL queryable state sync failed: ${error.message}`));

  setInterval(() => {
    refreshDependencyHealth().catch((error) => logger.error(`Dependency health refresh failed: ${error.message}`));
  }, 2 * 60 * 1000);

  setInterval(() => {
    walletMonitor.monitor().catch((error) => logger.error(`Wallet monitor error: ${error.message}`));
  }, 5 * 60 * 1000);

  setInterval(() => {
    runSqlSelfTest(logger)
      .then((result) => {
        sqlRuntimeState.selfTestOk = Boolean(result?.ok);
        sqlRuntimeState.selfTestReason = result?.reason || (result?.enabled === false ? 'sql_disabled' : 'ok');
        sqlRuntimeState.lastSelfTestAt = new Date().toISOString();
      })
      .catch((error) => {
        sqlRuntimeState.selfTestOk = false;
        sqlRuntimeState.selfTestReason = error.message;
        sqlRuntimeState.lastSelfTestAt = new Date().toISOString();
        logger.warn(`SQL self-test refresh failed: ${error.message}`);
      });
  }, Math.max(30000, Number(process.env.SQL_SELF_TEST_INTERVAL_MS || 120000)));

  setInterval(() => {
    syncQueryableSqlState().catch((error) => {
      logger.warn(`Periodic SQL queryable state sync failed: ${error.message}`);
    });
  }, Math.max(30000, Number(process.env.SQL_QUERYABLE_SYNC_MS || 120000)));

  // Periodic SQL position snapshots (best-effort; gated by SQL_ENABLED)
  setInterval(() => {
    try {
      const open = Object.values(portfolio.positions || {});
      for (const p of open) {
        if (!p || !p.sqlPositionId) continue;
        const qty = Number(p.quantity || 0);
        const price = Number(p.currentPrice || 0);
        const unrealized = (qty > 0 && price > 0)
          ? (qty * price) - Number(p.costBasisUsd || 0)
          : null;
        telemetry.logPositionSnapshot({
          position_id: p.sqlPositionId,
          ts: new Date().toISOString(),
          price,
          unrealized_pnl_usd: Number.isFinite(unrealized) ? unrealized : null,
          highest_price: Number(p.highestPrice || 0) || null,
          trailing_stop: Number(p.trailingStop || 0) || null,
          risk_state: {
            costBasisUsd: p.costBasisUsd,
            initialSizeUsd: p.initialSizeUsd,
            openedAt: p.openedAt,
            lastExitReason: p.lastExitReason,
          },
        });
      }
    } catch (_) {
      // ignore
    }
  }, Math.max(5000, Number(process.env.SQL_POSITION_SNAPSHOT_MS || 60000)));

  setInterval(() => {
    persistSqlStateSnapshot('periodic').catch((error) => {
      logger.warn(`Periodic SQL state snapshot failed: ${error.message}`);
    });
  }, Math.max(10000, Number(process.env.SQL_STATE_SNAPSHOT_MS || 120000)));

  setInterval(() => {
    reconcileExecutionJournal().catch((error) => logger.error(`Execution journal reconciliation error: ${error.message}`));
  }, 60 * 1000);

  // Track health status across heartbeat cycles to detect degradation transitions
  let lastHealthOk = true;
  let lastHealthDegraded = false;
  let lastHealthUnhealthyCount = 0;

  setInterval(() => {
    try {
      const health = getHealthStatus();
      const snapshot = getPortfolioSnapshot();
      const heartbeatStats = {
        cashBalance: snapshot.cashBalance,
        equity: snapshot.equity,
        totalPnl: snapshot.totalPnl,
        unrealizedPnl: snapshot.unrealizedPnl,
        openPositionCount: snapshot.openPositionCount,
        closedTrades: snapshot.closedTrades,
        wins: snapshot.wins,
        winRate: snapshot.winRate,
        grossProfit: snapshot.grossProfit,
        grossLoss: snapshot.grossLoss,
        profitFactor: snapshot.profitFactor,
        healthOk: health.ok,
        degradedReasons: health.degradedReasons || [],
        unhealthyReasons: health.unhealthyReasons || [],
        signalDrought: Boolean(health.signalDrought?.global),
      };
      sendHeartbeat(heartbeatStats).catch((error) => logger.error(`Heartbeat error: ${error.message}`));

      // Proactive health degradation alerts
      const nowUnhealthyCount = (health.unhealthyReasons || []).length;
      const nowDegraded = (health.degradedReasons || []).length > 0;
      const nowOk = health.ok;
      if (!lastHealthOk && nowOk) {
        sendHealthAlert(health).catch((error) => logger.error(`Health recovered alert error: ${error.message}`));
      } else if (nowUnhealthyCount > 0 && (nowUnhealthyCount !== lastHealthUnhealthyCount || (!lastHealthOk === nowOk))) {
        sendHealthAlert(health).catch((error) => logger.error(`Health alert error: ${error.message}`));
      } else if (nowDegraded && !lastHealthDegraded) {
        sendHealthAlert(health).catch((error) => logger.error(`Health degraded alert error: ${error.message}`));
      }
      lastHealthOk = nowOk;
      lastHealthDegraded = nowDegraded;
      lastHealthUnhealthyCount = nowUnhealthyCount;
    } catch (error) {
      logger.error(`Heartbeat scheduler error: ${error.message}`);
    }
  }, 60 * 60 * 1000);

  setInterval(() => {
    cleanupNonTradeLogs(logger).catch((error) => logger.error(`Log cleanup scheduler error: ${error.message}`));
  }, getLogCleanupIntervalMs());

  // runSqlAutoPrune extracted to src/cycle/maintenance.js (Week 9.5, 2026-05-18).
  const runSqlAutoPrune = _maintenanceModule.runSqlAutoPrune;

  // SQL telemetry prune — keeps the Agent DB under SQL Express 10GB limit by deleting
  // high-churn telemetry rows older than per-table retention windows. Runs every hour.
  // Disabled by default; enable with SQL_AUTO_PRUNE_ENABLED=true in env.
  if (String(process.env.SQL_AUTO_PRUNE_ENABLED || '').toLowerCase() === 'true') {
    const sqlPruneIntervalMs = Math.max(15 * 60_000, Number(process.env.SQL_AUTO_PRUNE_INTERVAL_MS || 3600000));
    setInterval(() => {
      runSqlAutoPrune(logger).catch((error) => logger.warn(`SQL auto-prune failed: ${error.message}`));
    }, sqlPruneIntervalMs);
    logger.info(`SQL auto-prune enabled (every ${Math.round(sqlPruneIntervalMs / 60000)}m)`);
  }

  // BTC risk-off poller: refreshes BTC price every N minutes (default 5)
  // and updates a global flag that the approval gate consults to block altcoins
  // during macro selloffs.
  if (config.risk?.btcRiskOffEnabled !== false) {
    const btcPollMs = Math.max(60_000, Number(config.risk?.btcRiskOffPollMinutes || 5) * 60_000);
    refreshBtcRiskOff().catch(() => {});
    setInterval(() => {
      refreshBtcRiskOff().catch((err) => logger.debug(`BTC risk-off poll error: ${err.message}`));
    }, btcPollMs);
    logger.info(`BTC risk-off filter enabled (poll every ${Math.round(btcPollMs / 60000)}m, threshold ${config.risk?.btcRiskOffThresholdPct || 2}% in 1h)`);
  }

  cron.schedule('0 0 * * *', () => {
    logger.info('Daily reset - resetting risk guardian drawdown tracker');
    risk.resetDaily();
  });

  logger.info(`Bot running. Dashboard at http://localhost:${config.bot.port}`);
}

// Shutdown + signal handlers extracted to src/boot/lifecycle.js (Week 1c, 2026-05-16).
// Fixes SIGINT race: signal handlers route through shutdownAndExit's async drain
// instead of singleton's sync release+exit. Dashboard refs are late-bound via getters.
// Per-hook timeout (2s) + hard kill backstop (8s) so shutdown never hangs.
// lockManager drain runs last in the async chain.
const { createLifecycle } = require('./boot/lifecycle');
const lifecycle = createLifecycle({
  logger,
  wsDiscovery,
  getDashboardServer: () => dashboardServer,
  getDashboardWss:    () => dashboardWss,
  telemetry,
  saveState,
  lockManager,
});
const shutdownAndExit = lifecycle.shutdownAndExit;
lifecycle.installSignalHandlers();

// Error handlers extracted to src/boot/error-handlers.js (Week 1b, 2026-05-16).
// Uses errors/isTransient() taxonomy — ignores EADDRINUSE, ECONNRESET,
// ETIMEDOUT, EPIPE, EHOSTUNREACH. Anything else → shutdownAndExit(1).
process.removeListener('uncaughtException', earlyUncaughtExceptionHandler);
process.removeListener('unhandledRejection', earlyUnhandledRejectionHandler);
installErrorHandlers({ logger, shutdownAndExit });

main().catch((error) => {
  shutdownAndExit(1, `Fatal startup error: ${error.message}`, error);
});
