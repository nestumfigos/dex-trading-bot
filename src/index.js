'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { ethers } = require('ethers');
const config = require('../config');
const logger = require('./utils/logger');
const RiskGuardian = require('./risk/guardian');
// const MomentumStrategy = require('./strategy/momentum');
const MarketAnalyst = require('./agent/marketAnalyst');
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
const { createTradeRepairHelpers } = require('./utils/trade-repair');
const { createResearchHandlers } = require('./utils/research-handlers');
const { createSelfEvolutionOrchestration } = require('./utils/self-evolution-orchestration');
const { createStatePersistence } = require('./utils/state-persistence');
const { createScanOrchestration } = require('./utils/scan-orchestration');
const SelfEvolutionEngine = require('./self-evolution');
const EvolutionGovernor = require('./evolution-governor');
const EvolutionValidator = require('./evolution-validator');
const StrategyLab = require('./strategy-lab');
const MarketIntelligenceAgent = require('./agent/marketIntelligence');
const AgentMemory = require('./agent/agentMemory');
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
const { getOhlcvSeries } = require('./utils/candles');
const { executeBuyViaVenue, executeSellViaVenue } = require('./utils/execution-adapter');
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
class AsyncMutex {
  constructor() { this._queue = Promise.resolve(); }
  lock() {
    let release;
    const releasePromise = new Promise((res) => { release = res; });
    const prev = this._queue;
    this._queue = prev.then(() => releasePromise).catch(() => {});
    return prev.then(() => release);
  }
}
const positionMutex = new AsyncMutex();
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

const portfolio = {
  startingBalance: config.paperTrading ? config.paperBalance : 0,
  balance: config.paperTrading ? config.paperBalance : 0,
  walletBalanceUsd: null,
  walletBalancesUsd: {
    solana: null,
    bsc: null,
    base: null,
    kucoin: null,
  },
  statePersistenceError: false,
  safeMode: false,
  saveFailureCount: 0,
  stateReconciliation: {
    lastRunAt: null,
    discrepancies: [],
  },
  balanceDrift: { amountUsd: 0, pct: 0 },
  balanceDriftHalt: false,
  executionJournal: {},
  positions: {}, // All positions (swing + momentum) tracked by tokenKey
  trades: [], // All trades (swing + momentum)
  
  // Separate tracking per strategy
  strategies: {
    swing: {
      positions: {}, // swing-specific positions (subset of portfolio.positions)
      trades: [],
      stats: {
        executions: 0,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        consecutiveLosses: 0,
        maxConsecutiveLosses: 0,
        avgWinUsd: 0,
        avgLossUsd: 0,
        expectancyUsd: 0,
        profitFactor: 0,
        totalSlippageBps: 0,
        slippageSamples: 0,
        avgSlippageBps: 0,
      },
    },
    momentum: {
      positions: {}, // momentum-specific positions (subset of portfolio.positions)
      trades: [],
      stats: {
        executions: 0,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        consecutiveLosses: 0,
        maxConsecutiveLosses: 0,
        avgWinUsd: 0,
        avgLossUsd: 0,
        expectancyUsd: 0,
        profitFactor: 0,
        totalSlippageBps: 0,
        slippageSamples: 0,
        avgSlippageBps: 0,
      },
    },
  },
  
  // Aggregate stats (both strategies combined)
  stats: {
    executions: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    totalSlippageBps: 0,
    slippageSamples: 0,
    avgSlippageBps: 0,
  },
  learning: {
    badTokenMemory: {},
    sleevePerformance: {},
  },
  pnlHistory: [],
};

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
  currentCycle: {
    momentum: makeFilterCycleStats('momentum'),
    swing: makeFilterCycleStats('swing'),
  },
  recentCycles: {
    momentum: [],
    swing: [],
  },
  consecutiveZeroSignalCycles: {
    momentum: 0,
    swing: 0,
  },
  signalDrought: {
    momentum: false,
    swing: false,
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

function ensureLearningStateShape() {
  if (!portfolio.learning || typeof portfolio.learning !== 'object') {
    portfolio.learning = {
      badTokenMemory: {},
      sleevePerformance: {},
      brainProfiles: {},
    };
  }

  if (!portfolio.learning.badTokenMemory || typeof portfolio.learning.badTokenMemory !== 'object') {
    portfolio.learning.badTokenMemory = {};
  }

  if (!portfolio.learning.sleevePerformance || typeof portfolio.learning.sleevePerformance !== 'object') {
    portfolio.learning.sleevePerformance = {};
  }

  if (!portfolio.learning.brainProfiles || typeof portfolio.learning.brainProfiles !== 'object') {
    portfolio.learning.brainProfiles = {};
  }

  // Intelligence store — persisted so the agent resumes with its last report after restart
  if (!portfolio.intelligence || typeof portfolio.intelligence !== 'object') {
    portfolio.intelligence = { report: null, lastRunAt: 0, runCount: 0 };
  }

  const nowMs = Date.now();
  Object.entries(portfolio.learning.badTokenMemory).forEach(([tokenKey, record]) => {
    if (!record || typeof record !== 'object') {
      delete portfolio.learning.badTokenMemory[tokenKey];
      return;
    }

    const banUntilMs = Date.parse(record.banUntil || '');
    const hardBan = Boolean(record.hardBan);
    if (!hardBan && Number.isFinite(banUntilMs) && banUntilMs > 0 && banUntilMs < nowMs) {
      delete portfolio.learning.badTokenMemory[tokenKey];
    }
  });
}

function getLearningBrainProfileKey(chainKey, strategyName = 'momentum', lane = 'unknown', trigger = 'unknown') {
  const normalizedChain = normalizeChainKey(chainKey);
  const normalizedStrategy = String(strategyName || 'momentum').toLowerCase();
  const normalizedLane = String(lane || 'unknown').toLowerCase();
  const normalizedTrigger = String(trigger || 'unknown').toLowerCase();
  return `${normalizedChain}:${normalizedStrategy}:${normalizedLane}:${normalizedTrigger}`;
}

function updateBrainProfileFromClosedTrade(position = {}, finalTradePnl = 0) {
  if (config.risk?.learningEnabled === false || config.risk?.brainEnabled === false) return;

  ensureLearningStateShape();
  const lane = String(position.discoveryLane || position.entryLane || 'unknown').toLowerCase();
  const trigger = String(position.triggerTimeframe || position.entryTriggerTimeframe || 'unknown').toLowerCase();
  const brainProfileKey = getLearningBrainProfileKey(
    position.chainKey || position.chain,
    position.strategy || 'momentum',
    lane,
    trigger
  );

  const brainWindowTrades = Math.max(10, Number(config.risk?.brainWindowTrades || 40));
  const profile = portfolio.learning.brainProfiles[brainProfileKey] || {
    chainKey: normalizeChainKey(position.chainKey || position.chain),
    strategy: String(position.strategy || 'momentum').toLowerCase(),
    lane,
    trigger,
    samples: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    recentOutcomes: [],
    recentPnl: [],
    recentWinRatePct: 50,
    avgRecentPnlUsd: 0,
    lastUpdated: null,
  };

  const isWin = Number(finalTradePnl || 0) >= 0;
  profile.samples = Number(profile.samples || 0) + 1;
  if (isWin) profile.wins = Number(profile.wins || 0) + 1;
  else profile.losses = Number(profile.losses || 0) + 1;
  profile.totalPnl = Number(profile.totalPnl || 0) + Number(finalTradePnl || 0);
  profile.recentOutcomes = [...(Array.isArray(profile.recentOutcomes) ? profile.recentOutcomes : []), isWin ? 1 : 0].slice(-brainWindowTrades);
  profile.recentPnl = [...(Array.isArray(profile.recentPnl) ? profile.recentPnl : []), Number(finalTradePnl || 0)].slice(-brainWindowTrades);

  const recentCount = profile.recentOutcomes.length;
  const recentWins = profile.recentOutcomes.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  profile.recentWinRatePct = recentCount > 0 ? (recentWins / recentCount) * 100 : 50;
  profile.avgRecentPnlUsd = profile.recentPnl.length > 0
    ? profile.recentPnl.reduce((sum, value) => sum + Number(value || 0), 0) / profile.recentPnl.length
    : 0;
  profile.lastUpdated = new Date().toISOString();

  portfolio.learning.brainProfiles[brainProfileKey] = profile;
  logger.info(
    `Brain profile update ${brainProfileKey}: samples=${profile.samples} ` +
    `winRate=${profile.recentWinRatePct.toFixed(1)}% avgPnl=${profile.avgRecentPnlUsd.toFixed(3)}`
  );
}

function getLearningTokenKey(tokenData = {}) {
  const chainKey = normalizeChainKey(tokenData.chainKey || tokenData.chain);
  const address = String(tokenData.address || '').trim().toLowerCase();
  if (!chainKey || !address) return '';
  return `${chainKey}:${address}`;
}

function getLearningSleeveKey(chainKey, strategyName = 'momentum') {
  return `${normalizeChainKey(chainKey)}:${String(strategyName || 'momentum').toLowerCase()}`;
}

function markTokenBadPattern(tokenData = {}, reason = '', options = {}) {
  if (config.risk?.learningEnabled === false) return;

  ensureLearningStateShape();
  const tokenKey = getLearningTokenKey(tokenData);
  if (!tokenKey) return;

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const cooldownHours = Math.max(1, Number(config.risk?.learnedPatternCooldownHours || 168));
  const hardBanHours = Math.max(cooldownHours, Number(config.risk?.learnedPatternHardBanHours || 720));
  const strikeThreshold = Math.max(1, Number(config.risk?.learnedPatternStrikeThreshold || 2));
  const hardBan = Boolean(options.hardBan);

  const current = portfolio.learning.badTokenMemory[tokenKey] || {
    chainKey: normalizeChainKey(tokenData.chainKey || tokenData.chain),
    symbol: tokenData.symbol || 'UNKNOWN',
    address: String(tokenData.address || '').trim(),
    strikes: 0,
    hardBan: false,
    firstSeen: nowIso,
    lastSeen: nowIso,
    reasons: [],
    lastReason: '',
    banUntil: nowIso,
  };

  current.symbol = tokenData.symbol || current.symbol;
  current.lastSeen = nowIso;
  current.lastReason = String(reason || '').slice(0, 240);
  current.reasons = [current.lastReason, ...(Array.isArray(current.reasons) ? current.reasons : [])]
    .filter(Boolean)
    .slice(0, 8);

  if (hardBan) {
    current.hardBan = true;
    current.strikes = Math.max(current.strikes, strikeThreshold);
    current.banUntil = new Date(nowMs + (hardBanHours * 3600 * 1000)).toISOString();
  } else {
    current.strikes = Number(current.strikes || 0) + 1;
    if (current.strikes >= strikeThreshold) {
      current.banUntil = new Date(nowMs + (cooldownHours * 3600 * 1000)).toISOString();
    }
  }

  portfolio.learning.badTokenMemory[tokenKey] = current;
  logger.warn(
    `Learned bad pattern: ${current.symbol} (${tokenKey}) strikes=${current.strikes} ` +
    `hardBan=${current.hardBan ? 'yes' : 'no'} until=${current.banUntil} reason=${current.lastReason}`
  );
}

function updateAdaptiveSleevePerformance(position = {}, finalTradePnl = 0) {
  if (config.risk?.learningEnabled === false || config.risk?.adaptiveSizingEnabled === false) return;

  ensureLearningStateShape();
  const sleeveKey = getLearningSleeveKey(position.chainKey || position.chain, position.strategy || 'momentum');
  if (!sleeveKey || sleeveKey.startsWith(':')) return;

  const windowTrades = Math.max(5, Number(config.risk?.adaptiveSizingWindowTrades || 20));
  const minTrades = Math.max(3, Number(config.risk?.adaptiveSizingMinTrades || 6));
  const lowWinRatePct = Math.max(0, Number(config.risk?.adaptiveSizingLowWinRatePct || 40));
  const highWinRatePct = Math.max(lowWinRatePct, Number(config.risk?.adaptiveSizingHighWinRatePct || 60));
  const reduceMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingReduceMultiplier || 0.7));
  const boostMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingBoostMultiplier || 1.05));
  const minMultiplier = Math.max(0.1, Number(config.risk?.adaptiveSizingMinMultiplier || 0.45));
  const maxMultiplier = Math.max(minMultiplier, Number(config.risk?.adaptiveSizingMaxMultiplier || 1.15));

  const sleeve = portfolio.learning.sleevePerformance[sleeveKey] || {
    outcomes: [],
    recentWinRatePct: 50,
    sizeMultiplier: 1,
    totalClosed: 0,
    wins: 0,
    losses: 0,
    lastUpdated: null,
  };

  const win = Number(finalTradePnl || 0) >= 0 ? 1 : 0;
  sleeve.outcomes = [...(Array.isArray(sleeve.outcomes) ? sleeve.outcomes : []), win].slice(-windowTrades);
  sleeve.totalClosed = Number(sleeve.totalClosed || 0) + 1;
  if (win) sleeve.wins = Number(sleeve.wins || 0) + 1;
  else sleeve.losses = Number(sleeve.losses || 0) + 1;

  const outcomeCount = sleeve.outcomes.length;
  const wins = sleeve.outcomes.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  sleeve.recentWinRatePct = outcomeCount > 0 ? (wins / outcomeCount) * 100 : 50;

  let multiplier = 1;
  if (outcomeCount >= minTrades) {
    if (sleeve.recentWinRatePct < lowWinRatePct) multiplier = reduceMultiplier;
    else if (sleeve.recentWinRatePct >= highWinRatePct) multiplier = boostMultiplier;
  }
  sleeve.sizeMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, multiplier));
  sleeve.lastUpdated = new Date().toISOString();

  portfolio.learning.sleevePerformance[sleeveKey] = sleeve;
  logger.info(
    `Adaptive sleeve update ${sleeveKey}: winRate=${sleeve.recentWinRatePct.toFixed(1)}% ` +
    `window=${outcomeCount} sizeMultiplier=${sleeve.sizeMultiplier.toFixed(2)}`
  );
}

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
  if (!['momentum', 'swing'].includes(strategyName)) return;
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

function finalizeFilterCycle(strategyName) {
  if (!['momentum', 'swing'].includes(strategyName)) return;

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

  if (evaluated > 0 && passed === 0) {
    filterStatsState.consecutiveZeroSignalCycles[strategyName] += 1;
  } else if (evaluated > 0) {
    filterStatsState.consecutiveZeroSignalCycles[strategyName] = 0;
  }

  filterStatsState.signalDrought[strategyName] = filterStatsState.consecutiveZeroSignalCycles[strategyName] > 3;
  filterStatsState.signalDrought.global = Boolean(filterStatsState.signalDrought.momentum && filterStatsState.signalDrought.swing);
  if (filterStatsState.signalDrought[strategyName]) {
    logger.warn('Signal drought detected', {
      reason: 'zero signals for N consecutive cycles — filters may be too restrictive',
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
const aiDecisionCache = new Map();
const aiDecisionQueue = new Map();
let aiDecisionInFlightKey = null;
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
    strategies: {
      momentum: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
    },
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
    strategies: {
      momentum: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
    },
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
    strategies: {
      momentum: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
    },
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
    strategies: {
      momentum: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', currentPair: '-', tokensScanned: 0, discoveredTokens: 0, evaluatedTokens: 0, lastUpdate: null },
    },
  },
};

function isStrategyScanEnabled(chainName, strategyName = 'momentum') {
  const chain = String(chainName || '').toLowerCase();
  const strategy = String(strategyName || 'momentum').toLowerCase();
  const isLiveBot = !config.paperTrading;

  // Live bot: KuCoin only
  if (isLiveBot) {
    return chain === 'kucoin';
  }

  // Paper bot: all chains
  if (chain === 'base') return false;
  if (strategy === 'swing') return chain === 'kucoin';
  return ['solana', 'bsc', 'kucoin'].includes(chain);
}

function applyDisabledScanStates() {
  Object.keys(scanStatus).forEach((chainName) => {
    const chainState = scanStatus[chainName];
    if (!chainState?.strategies) return;
    ['momentum', 'swing'].forEach((strategyName) => {
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

  determineApplicableStrategies(tokenData = {}) {
    const chainName = normalizeChainKey(tokenData?.chainKey || tokenData?.chain);
    const lane = String(tokenData?.discoveryLane || '').toLowerCase() || null;
    return {
      momentum: isStrategyScanEnabled(chainName, 'momentum'),
      swing: isStrategyScanEnabled(chainName, 'swing'),
      momentumLane: lane,
    };
  },

  async evaluateForStrategy(_tokenKey, strategyName, tokenData = {}) {
    const strategyCfg = config.strategies?.[strategyName] || {};
    const chainName = normalizeChainKey(tokenData?.chainKey || tokenData?.chain);
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
    const patternAnalysis = (strategyName === 'swing' || chainName === 'kucoin') && isEstablishedTokenCandidate(tokenData)
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

    const defaultRsiMin = strategyName === 'swing' ? 35 : 40;
    const defaultRsiMax = strategyName === 'swing' ? 80 : 75;
    const defaultVolumeSpikeMin = strategyName === 'swing' ? 1.05 : 1.35;
    const defaultStrongMoveThreshold = strategyName === 'swing' ? 6 : 12;
    const defaultExtremeMoveThreshold = strategyName === 'swing' ? 35 : 60;
    const defaultMinBuyRatio = strategyName === 'swing' ? 48 : 50;
    const defaultMinNetBuyFlowUsd = strategyName === 'swing' ? 1500 : 3500;

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
      const currentConfidence = Number(evaluation?.details?.confidence || 0.5);
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

    const triggerTimeframe = extremeMove
      ? 'extreme_24h_momentum'
      : (strongMove ? 'kucoin_relaxed_momentum' : 'momentum_breakout');

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

    const macroSizeMultiplier = intelligenceAgent.getMacroSizeMultiplier();

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

    if (String(strategyName) === 'swing') {
      const swingExitRsi = Number(strategyCfg.rsiExitThreshold || 78);
      if (Number.isFinite(rsi) && rsi >= swingExitRsi && profitPct > 2) {
        return {
          shouldExit: true,
          reason: 'RSI_OVERBOUGHT_SWING',
          details: { rsi, profitPct, priceChange24h, volumeDivergencePct },
        };
      }

      // New: swing exit confluence — volume collapse + sell pressure + winning, no RSI needed
      if (hasVolumeCollapse && sellRatio10mPct >= 60 && profitPct > 2) {
        return {
          shouldExit: true,
          reason: 'SWING_VOLUME_DIVERGENCE',
          details: { rsi, sellRatio10mPct, profitPct, volumeDivergencePct },
        };
      }

      return {
        shouldExit: false,
        reason: null,
        details: { rsi, sellRatio10mPct, profitPct, priceChange24h, volumeDivergencePct },
      };
    }

    return { shouldExit: false, reason: null, details: { unsupportedStrategy: strategyName } };
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
const agentMemory = new AgentMemory({ logger, config });
selfEvolution.bindDependencies({ agentMemory, portfolio });
const modelRegistry = new ModelRegistry({ logger, botProfile: BOT_PROFILE });
const intelligenceAgent = new MarketIntelligenceAgent({ portfolio, config, agentMemory });
const agent = new MarketAnalyst({
  portfolio,
  exchanges,
  config,
  logger,
  risk,
  marketState,
});
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

let scanTimer = null;
let scanInFlight = false;
let momentumScanTimer = null;
let swingScanTimer = null;
let momentumExitTimer = null;
let swingExitTimer = null;
let realtimeStopTimer = null;
let swingWatchlistRefreshTimer = null;
let walletBalanceRefreshTimer = null;
let bscNativePriceRefreshTimer = null;
let selfEvolutionTimer = null;
let intelligenceTimer = null;
let rlTrainingTimer = null;
const loopLocks = {
  momentumScan: false,
  kucoinMomentumScan: false,
  swingScan: false,
  momentumExit: false,
  swingExit: false,
  realtimeStop: false,
  swingRefresh: false,
  selfEvolution: false,
  intelligence: false,
};

const scanCursorByChainStrategy = {
  kucoin: {
    momentum: 0,
    swing: 0,
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
  const strategyKey = strategyName === 'swing' ? 'swing' : 'momentum';
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
  swingScan: null,
  momentumExit: null,
  swingExit: null,
  realtimeStop: null,
  walletBalanceRefresh: null,
};

function refreshScanInFlightFlag() {
  scanInFlight = Boolean(loopLocks.momentumScan || loopLocks.kucoinMomentumScan || loopLocks.swingScan);
}

function setStatePersistenceError(enabled) {
  const next = Boolean(enabled);
  statePersistenceError = next;
  portfolio.statePersistenceError = next;
}

function setLoopLocks(enabled) {
  Object.keys(loopLocks).forEach((key) => {
    loopLocks[key] = Boolean(enabled);
  });
  refreshScanInFlightFlag();
}

function stopSchedulersForSafeMode() {
  clearLoopSchedulers();
  setLoopLocks(true);
}

async function reconcileWalletPositions() {
  const discrepancies = [];
  const untrackedWalletPositions = [];
  const untrackedWalletPositionValueUsdByChain = {};
  const dustThresholdUsd = Math.max(0, Number(config.risk?.reconciliationDustUsd || 5));
  let prunedStateOnlyPositions = 0;
  let recoveredWalletBuys = 0;
  let clearedStuckPositions = 0;

  await Promise.allSettled(Object.entries(exchanges).map(async ([chainName, exchange]) => {
    if (!exchange || typeof exchange.getWalletPositions !== 'function') {
      return;
    }

    let walletPositions = [];
    try {
      walletPositions = await exchange.getWalletPositions(dustThresholdUsd);
    } catch (error) {
      const fetchFailure = {
        chain: chainName,
        type: 'wallet_position_fetch_failed',
        details: error.message,
      };
      discrepancies.push(fetchFailure);
      logger.error('State reconciliation mismatch', {
        reason: 'unrecovered position detected',
        ...fetchFailure,
      });
      return;
    }

    const stateKeys = new Set(
      Object.entries(portfolio.positions || {})
        .filter(([, position]) => normalizeChainKey(position?.chainKey || position?.chain) === chainName)
        .map(([positionKey]) => positionKey)
    );

    const walletPositionByKey = new Map(
      (Array.isArray(walletPositions) ? walletPositions : [])
        .map((position) => [buildTokenKey(chainName, position?.address || position?.symbol || ''), position])
        .filter(([key]) => !key.endsWith(':'))
    );
    const walletKeys = new Set(walletPositionByKey.keys());

    // Refresh price/value on already-tracked positions whose state may have stale data
    // (e.g. positions that were adopted with currentPrice=0 because the ticker lookup
    // failed at that moment). Without this, the dashboard shows them at $0 forever.
    for (const key of walletKeys) {
      if (!stateKeys.has(key)) continue;
      const walletPos = walletPositionByKey.get(key) || {};
      const tracked = portfolio.positions?.[key];
      if (!tracked) continue;
      const livePrice = Number(walletPos.lastPrice || 0);
      const liveQty = Number(walletPos.quantity || 0);
      const liveValue = Number(walletPos.valueUsd || 0);
      if (livePrice > 0) {
        if (!Number.isFinite(Number(tracked.currentPrice)) || Number(tracked.currentPrice) <= 0) {
          tracked.currentPrice = livePrice;
        }
        if (!Number.isFinite(Number(tracked.entryPrice)) || Number(tracked.entryPrice) <= 0) {
          tracked.entryPrice = livePrice;
          tracked.highestPrice = livePrice;
          tracked.stopLoss = livePrice * (1 - Number(config.risk?.stopLossPct || 8) / 100);
          logger.warn(`[Reconciliation] Repaired ${tracked.symbol} entryPrice (was 0): now $${livePrice}`);
        }
      }
      if (liveQty > 0 && (!Number.isFinite(Number(tracked.quantity)) || Number(tracked.quantity) <= 0)) {
        tracked.quantity = liveQty;
      }
      if (liveValue > 0 && (!Number.isFinite(Number(tracked.costBasisUsd)) || Number(tracked.costBasisUsd) <= 0)) {
        tracked.costBasisUsd = liveValue;
        tracked.initialSizeUsd = tracked.initialSizeUsd || liveValue;
      }
    }

    for (const key of walletKeys) {
      if (stateKeys.has(key)) continue;
      const walletPosition = walletPositionByKey.get(key) || {};
      if (chainName === 'kucoin') {
        const recoveredFill = await findRecoverableKucoinBuyFill(exchange, walletPosition).catch(() => null);
        if (recoveredFill && restoreKucoinRecoveredBuy(walletPosition, recoveredFill)) {
          stateKeys.add(key);
          recoveredWalletBuys += 1;
          continue;
        }
      }
      const entry = {
        chain: chainName,
        type: 'wallet_untracked_position',
        key,
        symbol: walletPosition.symbol || null,
        address: walletPosition.address || null,
        quantity: Number(walletPosition.quantity || 0),
        valueUsd: Number(walletPosition.valueUsd || 0),
      };

      // Optional auto-adoption: turn the unmanaged wallet position into a tracked
      // position so the exit logic (stop loss, trailing, stale-drift) applies. We
      // can't recover the real entry price, so we synthesize one from current price
      // and flag the position as `adoptedFromWallet=true` for downstream visibility.
      // Enable with RECONCILE_ADOPT_UNMANAGED=true (default true on KuCoin since
      // that's where reconciliation is reliable; off for DEX chains where partial
      // wallet info can produce false adoptions).
      const adoptionEnabledGlobally = String(process.env.RECONCILE_ADOPT_UNMANAGED || 'true').toLowerCase() !== 'false';
      const adoptionEnabledForChain = chainName === 'kucoin' || String(process.env.RECONCILE_ADOPT_UNMANAGED_DEX || 'false').toLowerCase() === 'true';
      const minAdoptionValueUsd = Number(process.env.RECONCILE_ADOPT_MIN_VALUE_USD || 5);
      const valueUsd = Number(walletPosition.valueUsd || 0);
      const qty = Number(walletPosition.quantity || 0);
      // Prefer the wallet's reported lastPrice (already validated by the exchange adapter).
      // Fall back to value/qty division only as a sanity check.
      const lastPrice = Number(walletPosition.lastPrice || 0);
      const currentPrice = lastPrice > 0
        ? lastPrice
        : (qty > 0 && valueUsd > 0 ? valueUsd / qty : 0);
      let adopted = false;
      // Skip adoption when price is unknown — adopting a position with currentPrice=0
      // breaks every downstream calc (PnL, stop loss, exit thresholds).
      if (currentPrice <= 0) {
        logger.warn(`[Reconciliation] Skipping adoption of ${walletPosition.symbol}: no valid price available`);
      } else if (adoptionEnabledGlobally && adoptionEnabledForChain && qty > 0 && valueUsd >= minAdoptionValueUsd) {
        try {
          const strategyName = 'momentum';
          const stopLossPctRisk = Number(config.risk?.stopLossPct || 8);
          portfolio.positions[key] = {
            key,
            address: walletPosition.address || walletPosition.symbol || key,
            chain: chainName,
            chainKey: chainName,
            strategyKey: key,
            strategy: strategyName,
            symbol: walletPosition.symbol || key,
            entryPrice: currentPrice,
            currentPrice,
            quantity: qty,
            initialSizeUsd: valueUsd,
            costBasisUsd: valueUsd,
            requestedEntryUsd: valueUsd,
            filledEntryUsd: valueUsd,
            requestedEntryQuantity: qty,
            filledEntryQuantity: qty,
            entryFillDiscrepancyPct: 0,
            stopLoss: currentPrice * (1 - stopLossPctRisk / 100),
            takeProfit: currentPrice * 1.25,
            openedAt: new Date().toISOString(),
            txid: null,
            entryBlockNumber: null,
            entryConfirmations: null,
            entryPrivateRouteUsed: false,
            signalSource: 'wallet_adoption',
            triggerTimeframe: null,
            brainArchetype: 'adopted',
            brainProfileKey: null,
            discoveryLane: null,
            aiReason: 'adopted_from_wallet_reconciliation',
            aiConfidence: 0,
            patternAnalysis: null,
            pairAddress: walletPosition.pairAddress || null,
            entryLiquidityUsd: 0,
            entryTopHoldersPct: null,
            entryBuyRatioPct10m: 0,
            entryRecentWindowMinutes: null,
            entryBuyRatioRecentPct: null,
            entryHolderCount: 0,
            entryRsi: 0,
            entryVolumeSpike: 0,
            tokenAgeBucket: 'unknown',
            marketRegime: 'unknown',
            highestPrice: currentPrice,
            antiPatternInfo: { adoptedFromWallet: true },
            trailingStop: null,
            tierLocalHigh: currentPrice,
            triggeredSellTiers: {},
            tierDelayedAt: {},
            partialFillRetry: false,
            exitInProgress: false,
            realizedPnlByTier: {},
            realizedPnl: 0,
            adoptedFromWallet: true,
            adoptedAt: new Date().toISOString(),
          };
          if (!portfolio.strategies?.[strategyName]) {
            portfolio.strategies = portfolio.strategies || {};
            portfolio.strategies[strategyName] = portfolio.strategies[strategyName] || {
              positions: {},
              stats: { wins: 0, losses: 0, totalPnl: 0, grossProfit: 0, grossLoss: 0, closedTrades: 0, consecutiveLosses: 0, consecutiveWins: 0, maxConsecutiveLosses: 0 },
              trades: [],
            };
          }
          portfolio.strategies[strategyName].positions[key] = portfolio.positions[key];
          stateKeys.add(key);
          adopted = true;
          logger.warn(`[Reconciliation] Adopted unmanaged position ${entry.symbol} (${chainName}) qty=${qty.toFixed(6)} value=$${valueUsd.toFixed(2)} — now subject to stop-loss / stale-drift / strategy exits`);
        } catch (adoptErr) {
          logger.warn(`[Reconciliation] Adoption of ${entry.symbol} failed: ${adoptErr.message}`);
        }
      }

      if (adopted) {
        entry.adopted = true;
        // Adopted positions are now tracked — don't show them as "unmanaged" on the
        // dashboard or contribute to untracked totals. Keep an audit entry in discrepancies
        // so the adoption shows up in the reconciliation log, but skip the unmanaged buckets.
        discrepancies.push(entry);
        logger.warn('State reconciliation: adopted unmanaged position', { ...entry });
      } else {
        discrepancies.push(entry);
        untrackedWalletPositions.push(entry);
        untrackedWalletPositionValueUsdByChain[chainName] = Number(untrackedWalletPositionValueUsdByChain[chainName] || 0) + Number(walletPosition.valueUsd || 0);
        logger.error('State reconciliation mismatch', {
          reason: 'unrecovered position detected',
          ...entry,
        });
      }
    }

    stateKeys.forEach((key) => {
      if (walletKeys.has(key)) return;
      const stalePosition = portfolio.positions?.[key];
      const staleQty = Number(stalePosition?.quantity || 0);
      const stalePrice = Number(stalePosition?.currentPrice || stalePosition?.entryPrice || 0);
      const staleValueUsd = staleQty > 0 && stalePrice > 0
        ? staleQty * stalePrice
        : Number(stalePosition?.initialSizeUsd || stalePosition?.costBasisUsd || 0);
      const strategyName = String(stalePosition?.strategy || 'momentum').toLowerCase();

      if (stalePosition && Number.isFinite(staleValueUsd) && staleValueUsd > 0 && staleValueUsd <= dustThresholdUsd) {
        delete portfolio.positions[key];
        if (portfolio.strategies?.[strategyName]?.positions) {
          delete portfolio.strategies[strategyName].positions[key];
        }
        releaseLiquiditySentinel(chainName, stalePosition.pairAddress);
        strategy.clearHistory(stalePosition.strategyKey || key);
        prunedStateOnlyPositions += 1;
        logger.info('Removed dust state-only position from local state', {
          chain: chainName,
          key,
          symbol: stalePosition.symbol,
          valueUsd: Number(staleValueUsd.toFixed(4)),
          dustThresholdUsd,
        });
        return;
      }

      const entry = {
        chain: chainName,
        type: 'state_only_position',
        key,
      };
      discrepancies.push(entry);
      logger.error('State reconciliation mismatch', {
        reason: 'unrecovered position detected',
        ...entry,
      });

      // KuCoin can drift when users manually trade outside the bot.
      // If an in-state KuCoin position is absent from live wallet holdings, prune it.
      if (chainName === 'kucoin') {
        if (stalePosition) {
          delete portfolio.positions[key];
          if (portfolio.strategies?.[strategyName]?.positions) {
            delete portfolio.strategies[strategyName].positions[key];
          }
          releaseLiquiditySentinel(chainName, stalePosition.pairAddress);
          strategy.clearHistory(stalePosition.strategyKey || key);
          prunedStateOnlyPositions += 1;
          logger.warn('Removed stale KuCoin position from local state', {
            reason: 'state-only KuCoin position pruned',
            key,
            symbol: stalePosition.symbol,
            address: stalePosition.address,
          });
        }
      }
    });

    const stuckEntries = Object.entries(portfolio.stuckPositions || {})
      .filter(([, meta]) => normalizeChainKey(meta?.chainKey) === chainName);

    for (const [stuckKey, meta] of stuckEntries) {
      if (walletKeys.has(stuckKey)) continue;
      if (portfolio.positions?.[stuckKey]) continue;
      delete portfolio.stuckPositions[stuckKey];
      clearedStuckPositions += 1;
      logger.info('Cleared stale stuck-position flag after wallet reconciliation', {
        chain: chainName,
        key: stuckKey,
        symbol: meta?.symbol || null,
        address: meta?.address || null,
      });
    }

    Object.values(marketState.trackedTokens || {}).forEach((tracked) => {
      if (normalizeChainKey(tracked?.chainKey || tracked?.chain) !== chainName) return;
      const trackedKey = buildTokenKey(chainName, tracked?.address || '');
      tracked.hasOpenPosition = Boolean(portfolio.positions?.[trackedKey]);
    });
  }));

  if (prunedStateOnlyPositions > 0) {
    ensureStatsShape();
    refreshPerformanceMetrics();
    recordPortfolioSnapshot('reconcile_prune');
  }

  if (recoveredWalletBuys > 0) {
    refreshPerformanceMetrics();
    recordPortfolioSnapshot('reconcile_recover_buy');
  }

  if (clearedStuckPositions > 0) {
    recordPortfolioSnapshot('reconcile_clear_stuck');
  }

  portfolio.stateReconciliation = {
    lastRunAt: new Date().toISOString(),
    discrepancies,
  };
  portfolio.untrackedWalletPositions = untrackedWalletPositions;
  portfolio.untrackedWalletPositionValueUsdByChain = untrackedWalletPositionValueUsdByChain;
  portfolio.untrackedWalletPositionValueUsd = Object.values(untrackedWalletPositionValueUsdByChain)
    .reduce((sum, value) => sum + Number(value || 0), 0);
}

async function enterSafeMode(reason) {
  portfolio.safeMode = true;
  setStatePersistenceError(true);
  stopSchedulersForSafeMode();
  logger.error('Safe mode enabled', {
    reason: reason || 'safe mode activated',
  });
  sendSafeModeAlert(reason || 'safe mode activated').catch((error) => logger.error(`Safe mode alert error: ${error.message}`));
  await reconcileWalletPositions();
}

function clearSafeModeState() {
  portfolio.safeMode = false;
  setStatePersistenceError(false);
  setLoopLocks(false);
}

function getStrategyScanStatus(chainName, strategyName) {
  return scanStatus[chainName]?.strategies?.[strategyName] || scanStatus[chainName];
}

function syncChainScanStatus(chainName) {
  const chainState = scanStatus[chainName];
  const strategyState = chainState?.strategies;
  if (!chainState || !strategyState) return;

  const momentum = strategyState.momentum || {};
  const swing = strategyState.swing || {};
  const states = [momentum, swing];
  const nowIso = new Date().toISOString();

  const momentumScanned = Number(momentum.tokensScanned || 0);
  const momentumEvaluated = Number(momentum.evaluatedTokens || 0);
  const swingScanned = Number(swing.tokensScanned || 0);
  const swingEvaluated = Number(swing.evaluatedTokens || 0);

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

  checkStrategyCounters('momentum', momentumScanned, momentumEvaluated);
  checkStrategyCounters('swing', swingScanned, swingEvaluated);

  chainState.tokensScanned = momentumScanned + swingScanned;
  chainState.discoveredTokens = Number(momentum.discoveredTokens || 0) + Number(swing.discoveredTokens || 0);
  chainState.evaluatedTokens = momentumEvaluated + swingEvaluated;

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

  chainState.currentToken = momentum.status === 'scanning'
    ? (momentum.currentToken || '-')
    : (swing.status === 'scanning' ? (swing.currentToken || '-') : '-');

  if (states.some((state) => state.status === 'scanning')) {
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
  tryRotateForStrongerMomentum,
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
    logger.warn(`${chainName} dependency health check failed: ${error.message}`);
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

function safeDecisionText(value, fallback = '') {
  const text = String(value || fallback || '').trim();
  return text.slice(0, 800);
}

function deriveIncidentState({ riskCheck = null, approval = null, chainName = '', strategyName = '' } = {}) {
  const active = [];
  if (portfolio.safeMode) active.push('safe_mode_active');
  if (portfolio.balanceDriftHalt) active.push('balance_drift_halt');
  if (statePersistenceError || portfolio.statePersistenceError) active.push('state_persistence_error');
  if (String(riskCheck?.code || '').toLowerCase() === 'chain_daily_loss') active.push('chain_daily_loss');
  if (approval && approval.approved === false) active.push(`approval_blocked_${String(approval.reasonCode || 'general').toLowerCase()}`);
  return {
    active,
    primary: active[0] || 'normal',
    chainKey: normalizeChainKey(chainName),
    strategy: strategyName || null,
  };
}

function buildDecisionProposal({
  chainName,
  tokenData,
  strategyName,
  signalSource,
  evaluation,
}) {
  const details = evaluation?.details || {};
  return {
    botProfile: BOT_PROFILE,
    chainKey: normalizeChainKey(chainName),
    symbol: tokenData?.symbol || null,
    address: tokenData?.address || null,
    strategy: strategyName || null,
    signalSource: signalSource || tokenData?.signalSource || 'technical',
    technicalSignal: evaluation?.signal || null,
    finalSignal: tokenData?.finalSignal || 'BUY',
    ai: {
      confidence: Number(details.aiConfidence ?? tokenData?.aiConfidence ?? null),
      reason: details.aiReason || tokenData?.aiReason || null,
      verificationStatus: details.aiVerificationStatus || null,
      riskFlags: Array.isArray(details.aiRiskFlags) ? details.aiRiskFlags : [],
    },
    market: {
      price: Number(tokenData?.price || 0),
      liquidityUsd: Number(tokenData?.liquidityUsd || 0),
      volume24h: Number(tokenData?.volume24h || 0),
      priceChange24h: Number(tokenData?.priceChange24h || details?.priceChange24h || 0),
      holderCount: Number(tokenData?.holderCount || 0),
      topHoldersPct: tokenData?.topHoldersPct ?? null,
    },
    trigger: {
      timeframe: details.triggerTimeframe || tokenData?.entryTriggerTimeframe || null,
      rsi: Number(details.rsi ?? tokenData?.rsi ?? null),
      volumeSpike: Number(details.volumeSpike ?? tokenData?.volumeSpike ?? null),
      buyRatioRecentPct: Number(details.buyRatioRecentPct ?? tokenData?.buyRatioRecentPct ?? null),
      confidence: Number(details.confidence ?? tokenData?.confidence ?? null),
    },
    brain: {
      archetype: details.brainArchetype || tokenData?.brainArchetype || null,
      profileKey: details.brainProfileKey || tokenData?.brainProfileKey || null,
      marketRegime: details.marketRegime || tokenData?.marketRegime || null,
    },
    patternAnalysis: details.patternAnalysis || tokenData?.patternAnalysis || null,
    externalSignal: details.externalSignal || tokenData?.externalSignal || null,
  };
}

function buildDecisionRiskReview({
  chainName,
  tokenData,
  strategyName,
  riskCheck,
  evaluation,
}) {
  const details = evaluation?.details || {};
  return {
    allowed: Boolean(riskCheck?.allowed),
    code: riskCheck?.code || null,
    reason: riskCheck?.reason || null,
    chainKey: normalizeChainKey(chainName),
    strategy: strategyName || null,
    safeMode: Boolean(portfolio.safeMode),
    balanceDriftHalt: Boolean(portfolio.balanceDriftHalt),
    statePersistenceError: Boolean(statePersistenceError || portfolio.statePersistenceError),
    sqlHealthy: !process.env.SQL_ENABLED || Boolean(sqlRuntimeState.selfTestOk),
    openPositions: Object.keys(portfolio.positions || {}).length,
    strategyOpenPositions: Object.values(portfolio.positions || {}).filter((position) => String(position?.strategy || '').toLowerCase() === String(strategyName || '').toLowerCase()).length,
    aiVerificationStatus: details.aiVerificationStatus || null,
    aiRiskFlags: Array.isArray(details.aiRiskFlags) ? details.aiRiskFlags : [],
    topHoldersPctKnown: tokenData?.topHoldersPct !== null && tokenData?.topHoldersPct !== undefined,
    liquidityUsd: Number(tokenData?.liquidityUsd || 0),
  };
}

function approvePortfolioDecision({
  chainName,
  tokenData,
  strategyName,
  signalSource,
  evaluation,
  riskCheck,
}) {
  const details = evaluation?.details || {};
  const blockers = [];
  const notes = [];
  const liveMode = BOT_PROFILE === 'live' && !config.paperTrading;
  const aiVerificationStatus = String(details.aiVerificationStatus || '').toLowerCase();
  const aiConfidence = Number(details.aiConfidence ?? tokenData?.aiConfidence ?? 0);
  const aiFloor = Number(details.confidenceFloor || 0);

  if (!riskCheck?.allowed) {
    blockers.push({ code: String(riskCheck?.code || 'risk_guardian_block'), reason: safeDecisionText(riskCheck?.reason, 'risk guardian blocked entry') });
  }
  if (portfolio.safeMode) {
    blockers.push({ code: 'safe_mode_active', reason: 'safe mode is active' });
  }
  if (portfolio.balanceDriftHalt) {
    blockers.push({ code: 'balance_drift_halt', reason: 'balance drift halt is active' });
  }
  if (liveMode && String(process.env.SQL_ENABLED || '').toLowerCase() === 'true' && !sqlRuntimeState.selfTestOk) {
    blockers.push({ code: 'sql_self_test_failed', reason: 'live execution blocked while SQL self-test is unhealthy' });
  }
  if (liveMode && aiVerificationStatus.includes('pending')) {
    const freshCacheStatus = getAiDecisionCacheStatus(tokenData, strategyName);
    const pendingMs = freshCacheStatus.queuedAt ? Date.now() - Date.parse(freshCacheStatus.queuedAt) : 0;
    const aiPendingTimeoutMs = Number(process.env.AI_PENDING_TIMEOUT_MS || 45000);
    if (pendingMs < aiPendingTimeoutMs) {
      blockers.push({ code: 'ai_verification_pending', reason: `AI verification pending (${(pendingMs / 1000).toFixed(0)}s / ${(aiPendingTimeoutMs / 1000).toFixed(0)}s timeout)` });
    }
  }
  if (liveMode && signalSource === 'AI' && aiFloor > 0 && aiConfidence > 0 && aiConfidence < aiFloor) {
    blockers.push({ code: 'ai_confidence_below_floor', reason: `AI confidence ${aiConfidence.toFixed(1)} is below floor ${aiFloor.toFixed(1)}` });
  }
  if (liveMode && (tokenData?.topHoldersPct === null || tokenData?.topHoldersPct === undefined) && (chainName === 'bsc' || chainName === 'base')) {
    blockers.push({ code: 'holder_concentration_unknown', reason: `${String(chainName).toUpperCase()} holder concentration is unavailable` });
  }

  // BTC macro risk-off: block altcoin BUYs when BTC sold off >2% in last hour.
  // BTC itself is exempt (it IS the macro signal — buying BTC dip is a separate decision).
  const symbolUpper = String(tokenData?.symbol || '').toUpperCase();
  if (isBtcRiskOff() && symbolUpper !== 'BTC' && symbolUpper !== 'WBTC') {
    blockers.push({ code: 'btc_risk_off', reason: getBtcRiskOffReason() || 'BTC selling off; alts blocked' });
  }

  if (!blockers.length) {
    notes.push(`approved for ${BOT_PROFILE} ${normalizeChainKey(chainName)} ${strategyName}`);
  }

  const approved = blockers.length === 0;
  return {
    approved,
    action: approved ? 'BUY' : 'REJECT',
    reasonCode: blockers[0]?.code || 'approved',
    reason: blockers[0]?.reason || notes[0] || 'approved',
    blockers,
    checks: {
      liveMode,
      sqlSelfTestOk: Boolean(sqlRuntimeState.selfTestOk),
      aiVerificationStatus: details.aiVerificationStatus || null,
      aiConfidence,
      aiFloor,
      safeMode: Boolean(portfolio.safeMode),
      balanceDriftHalt: Boolean(portfolio.balanceDriftHalt),
    },
    notes,
    incidentState: deriveIncidentState({ riskCheck, chainName, strategyName }),
  };
}

function queueDecisionTelemetry({
  stage,
  tokenData,
  chainName,
  strategyName,
  signalSource,
  proposal = null,
  riskReview = null,
  approval = null,
  finalAction = null,
  approved = false,
  reason = null,
  status = null,
  orderId = null,
  positionId = null,
}) {
  const decisionId = telemetryUuid();
  const confidence = proposal?.trigger?.confidence;
  const aiConfidence = proposal?.ai?.confidence ?? tokenData?.aiConfidence;
  const activeRollout = getActivePromotionRolloutContext();
  telemetry.logDecision({
    decision_id: decisionId,
    ts: new Date().toISOString(),
    chain: tokenData?.chain || chainName,
    chain_key: normalizeChainKey(chainName),
    symbol: tokenData?.symbol || null,
    address: tokenData?.address || null,
    strategy: strategyName || null,
    signal_source: signalSource || tokenData?.signalSource || 'technical',
    decision_stage: stage,
    proposal_json: proposal || null,
    risk_json: riskReview || null,
    approval_json: approval || null,
    final_action: finalAction || null,
    approved: Boolean(approved),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    ai_confidence: Number.isFinite(Number(aiConfidence)) ? Number(aiConfidence) : null,
    reason: safeDecisionText(reason || approval?.reason || riskReview?.reason || tokenData?.aiReason || ''),
    order_id: orderId,
    position_id: positionId,
    status: status || null,
    strategy_version_id: CURRENT_STRATEGY_VERSION_ID,
    regime_label: normalizeRegimeLabel(tokenData?.marketRegime || proposal?.marketContext?.regime || ''),
    promotion_stage: BOT_PROFILE === 'paper' ? 'paper_candidate' : (activeRollout?.stage || 'live_active'),
  });
  return decisionId;
}

function buildDecisionReflection(position, finalTradePnl, reason) {
  const openedAtMs = position?.openedAt ? new Date(position.openedAt).getTime() : NaN;
  const closedAtMs = Date.now();
  const holdDurationHours = Number.isFinite(openedAtMs) ? ((closedAtMs - openedAtMs) / (1000 * 60 * 60)) : null;
  const initialSizeUsd = Number(position?.initialSizeUsd || position?.costBasisUsd || 0);
  const pnlPct = initialSizeUsd > 0 ? (Number(finalTradePnl || 0) / initialSizeUsd) * 100 : null;
  const outcome = Number(finalTradePnl || 0) > 0 ? 'win' : (Number(finalTradePnl || 0) < 0 ? 'loss' : 'flat');
  const summary = outcome === 'win'
    ? `Closed green after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; keep leaning into this setup when approval conditions match.`
    : outcome === 'loss'
      ? `Closed red after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; review trigger quality, liquidity, and approval blockers for similar setups.`
      : `Closed flat after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; setup was indecisive and may need tighter approval thresholds.`;
  return {
    reflectionId: telemetryUuid(),
    ts: new Date().toISOString(),
    botProfile: BOT_PROFILE,
    chainKey: normalizeChainKey(position?.chainKey || position?.chain),
    symbol: position?.symbol || null,
    strategy: position?.strategy || null,
    outcome,
    pnlUsd: Number(finalTradePnl || 0),
    pnlPct,
    holdDurationHours,
    summary,
    reflection: {
      exitReason: reason || null,
      signalSource: position?.signalSource || null,
      triggerTimeframe: position?.triggerTimeframe || null,
      aiConfidence: Number(position?.aiConfidence || 0),
      entryLiquidityUsd: Number(position?.entryLiquidityUsd || 0),
      entryTopHoldersPct: position?.entryTopHoldersPct ?? null,
      realizedPnlByTier: position?.realizedPnlByTier || {},
      approvalDecisionId: position?.sqlApprovalDecisionId || null,
      executionDecisionId: position?.sqlDecisionId || null,
    },
    strategy_version_id: CURRENT_STRATEGY_VERSION_ID,
    regime_label: normalizeRegimeLabel(position?.marketRegime || ''),
  };
}

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
    const ticker = await ku.exchange.fetchTicker('BTC/USDT').catch(() => null);
    const last = Number(ticker?.last || 0);
    if (!last || !Number.isFinite(last)) return;
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

function defaultStatsShape() {
  return {
    executions: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    grossProfit: 0,
    grossLoss: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
    avgWinUsd: 0,
    avgLossUsd: 0,
    expectancyUsd: 0,
    profitFactor: 0,
    totalSlippageBps: 0,
    slippageSamples: 0,
    avgSlippageBps: 0,
    skippedExitChecks: 0,
    exitErrorCount: 0,
  };
}

function ensureStatsShape() {
  portfolio.stats = {
    ...defaultStatsShape(),
    ...(portfolio.stats || {}),
  };

  portfolio.strategies = portfolio.strategies || {};
  ['swing', 'momentum'].forEach((strategyName) => {
    portfolio.strategies[strategyName] = portfolio.strategies[strategyName] || {};
    portfolio.strategies[strategyName].positions = {};
    portfolio.strategies[strategyName].trades = Array.isArray(portfolio.strategies[strategyName].trades)
      ? portfolio.strategies[strategyName].trades
      : [];
    portfolio.strategies[strategyName].stats = {
      ...defaultStatsShape(),
      ...(portfolio.strategies[strategyName].stats || {}),
    };
  });

  Object.entries(portfolio.positions || {}).forEach(([positionKey, position]) => {
    const strategyName = String(position?.strategy || 'momentum');
    if (!portfolio.strategies[strategyName]) return;
    portfolio.strategies[strategyName].positions[positionKey] = position;
  });
}

function refreshPerformanceMetrics() {
  ensureStatsShape();

  const closedTrades = Number(portfolio.stats.closedTrades || 0);
  const wins = Number(portfolio.stats.wins || 0);
  const losses = Number(portfolio.stats.losses || 0);
  const grossProfit = Number(portfolio.stats.grossProfit || 0);
  const grossLoss = Number(portfolio.stats.grossLoss || 0);

  portfolio.stats.avgWinUsd = wins > 0 ? grossProfit / wins : 0;
  portfolio.stats.avgLossUsd = losses > 0 ? grossLoss / losses : 0;

  const winRate = closedTrades > 0 ? (wins / closedTrades) : 0;
  const lossRate = closedTrades > 0 ? (losses / closedTrades) : 0;
  portfolio.stats.expectancyUsd = (winRate * portfolio.stats.avgWinUsd) - (lossRate * portfolio.stats.avgLossUsd);

  if (grossLoss > 0) {
    portfolio.stats.profitFactor = grossProfit / grossLoss;
  } else {
    // null = "no losses yet" (mathematically undefined, not infinite)
    portfolio.stats.profitFactor = grossProfit > 0 ? null : 0;
  }

  const slippageSamples = Number(portfolio.stats.slippageSamples || 0);
  portfolio.stats.avgSlippageBps = slippageSamples > 0
    ? Number(portfolio.stats.totalSlippageBps || 0) / slippageSamples
    : 0;

  ['swing', 'momentum'].forEach((strategyName) => {
    const stats = portfolio.strategies?.[strategyName]?.stats;
    if (!stats) return;

    const strategyClosedTrades = Number(stats.closedTrades || 0);
    const strategyWins = Number(stats.wins || 0);
    const strategyLosses = Number(stats.losses || 0);
    const strategyGrossProfit = Number(stats.grossProfit || 0);
    const strategyGrossLoss = Number(stats.grossLoss || 0);

    stats.avgWinUsd = strategyWins > 0 ? strategyGrossProfit / strategyWins : 0;
    stats.avgLossUsd = strategyLosses > 0 ? strategyGrossLoss / strategyLosses : 0;

    const strategyWinRate = strategyClosedTrades > 0 ? (strategyWins / strategyClosedTrades) : 0;
    const strategyLossRate = strategyClosedTrades > 0 ? (strategyLosses / strategyClosedTrades) : 0;
    stats.expectancyUsd = (strategyWinRate * stats.avgWinUsd) - (strategyLossRate * stats.avgLossUsd);

    if (strategyGrossLoss > 0) {
      stats.profitFactor = strategyGrossProfit / strategyGrossLoss;
    }

    const strategySlippageSamples = Number(stats.slippageSamples || 0);
    stats.avgSlippageBps = strategySlippageSamples > 0
      ? Number(stats.totalSlippageBps || 0) / strategySlippageSamples
      : 0;
  });
}

function calcSlippageBps(expectedPrice, realizedPrice) {
  const expected = Number(expectedPrice || 0);
  const realized = Number(realizedPrice || 0);
  if (!Number.isFinite(expected) || !Number.isFinite(realized) || expected <= 0 || realized <= 0) {
    return null;
  }
  return Math.abs(((realized - expected) / expected) * 10000);
}

function recordSlippageSample(strategyName, slippageBps) {
  const bps = Number(slippageBps);
  if (!Number.isFinite(bps)) return;

  ensureStatsShape();
  portfolio.stats.totalSlippageBps += bps;
  portfolio.stats.slippageSamples += 1;

  const strategyStats = portfolio.strategies?.[strategyName]?.stats;
  if (!strategyStats) {
    logger.warn(`recordSlippageSample: missing strategy stats bucket for ${strategyName}`);
    return;
  }

  strategyStats.totalSlippageBps += bps;
  strategyStats.slippageSamples += 1;
}

function extractExecutionPriceUsd(txResult, fallbackPrice) {
  const candidates = [
    txResult?.executedPriceUsd,
    txResult?.avgPrice,
    txResult?.averagePrice,
    txResult?.price,
    txResult?.limitPrice,
    fallbackPrice,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length ? candidates[0] : Number(fallbackPrice || 0);
}

function extractFilledBaseQty(txResult, fallbackQty = 0) {
  const candidates = [
    txResult?.filledBaseQty,
    txResult?.filledQuantity,
    txResult?.filledQty,
    txResult?.executedBaseQty,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  if (candidates.length) return candidates[0];
  return Number(fallbackQty || 0);
}

function extractFilledQuoteUsd(txResult, fallbackUsd = 0) {
  const candidates = [
    txResult?.filledQuoteUsd,
    txResult?.filledQuoteQty,
    txResult?.executedQuoteUsd,
    txResult?.cost,
  ].map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);

  if (candidates.length) return candidates[0];
  return Number(fallbackUsd || 0);
}

function calcDiscrepancyPct(requestedValue, filledValue) {
  const requested = Number(requestedValue || 0);
  const filled = Number(filledValue || 0);
  if (!Number.isFinite(requested) || requested <= 0 || !Number.isFinite(filled) || filled <= 0) {
    return null;
  }
  return ((filled - requested) / requested) * 100;
}

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
  const maxNativePriceAgeMs = Math.max(1000, Number(config.risk?.maxNativePriceAgeMs || 120000));
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

async function reconcileExecutionJournal() {
  const journal = portfolio.executionJournal || {};
  const entries = Object.values(journal).filter((row) => row && row.status === 'confirmed');
  if (!entries.length) return;

  for (const entry of entries) {
    const chain = normalizeChainKey(entry.chainKey || entry.chain);
    if (chain !== 'bsc' && chain !== 'base') continue;
    const provider = exchanges?.[chain]?.provider;
    if (!provider) continue;

    try {
      const receipt = await provider.getTransactionReceipt(entry.txid);
      if (!receipt) {
        const ageMs = Date.now() - Date.parse(entry.updatedAt || entry.createdAt || '');
        if (Number.isFinite(ageMs) && ageMs > 10 * 60 * 1000) {
          setExecutionJournalState(entry.txid, {
            status: 'reorg_or_dropped',
            reason: 'receipt not found after confirmation window',
          });
          logger.error('Execution journal detected potential reorg/dropped tx', {
            txid: entry.txid,
            chain,
            reason: 'receipt not found after confirmation window',
          });
          portfolio.balanceDriftHalt = true;
        }
        continue;
      }

      const currentBlock = await provider.getBlockNumber();
      const blockNumber = Number(receipt.blockNumber || entry.blockNumber || 0);
      if (!Number.isFinite(blockNumber) || blockNumber <= 0) continue;
      const confirmations = Math.max(0, currentBlock - blockNumber + 1);
      const required = Math.max(1, Number(entry.requiredConfirmations || 2));
      setExecutionJournalState(entry.txid, { blockNumber, confirmations });

      if (confirmations >= required) {
        setExecutionJournalState(entry.txid, {
          status: 'finalized',
          finalizedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      logger.debug(`Execution journal reconciliation error (${chain} ${entry.txid}): ${error.message}`);
    }
  }
}

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

  const momentumEnabled = config.strategies?.momentum?.enabled !== false;
  const swingEnabled = config.strategies?.swing?.enabled !== false;
  // Staleness thresholds: stale if loop has completed before but not within N × its configured interval.
  const healthNow = Date.now();
  const momentumScanMs = Math.max(60_000, Number(config.bot.momentumScanIntervalSeconds || 75) * 1000);
  const swingScanMs = Math.max(10 * 60_000, Number(config.bot.swingScanIntervalMinutes || 15) * 60_000);
  const momentumExitMs = Math.max(5 * 60_000, Number(config.bot.momentumExitCheckMinutes || 15) * 60_000);
  const swingExitMs = Math.max(30 * 60_000, Number(config.bot.swingExitCheckMinutes || 60) * 60_000);
  const realtimeStopMs = Math.max(2_000, Number(config.risk?.realtimeStopCheckSeconds || 8) * 1000);
  const walletBalanceMs = Math.max(30_000, Number(config.bot.walletBalanceRefreshSeconds || 60) * 1000);
  const checkStale = (key, intervalMs, multiplier) => {
    const ts = loopLastCompletedAt[key];
    return ts !== null && (healthNow - ts) > multiplier * intervalMs;
  };
  const loopStaleness = {
    momentumScan: checkStale('momentumScan', momentumScanMs, 3),
    swingScan: checkStale('swingScan', swingScanMs, 2),
    momentumExit: checkStale('momentumExit', momentumExitMs, 3),
    swingExit: checkStale('swingExit', swingExitMs, 2),
    realtimeStop: Boolean(config.risk?.realtimeStopLossEnabled !== false) ? checkStale('realtimeStop', realtimeStopMs, 4) : false,
    walletBalanceRefresh: checkStale('walletBalanceRefresh', walletBalanceMs, 3),
  };
  const anyLoopStale = loopStaleness.walletBalanceRefresh
    || loopStaleness.realtimeStop
    || (momentumEnabled && (loopStaleness.momentumScan || loopStaleness.momentumExit))
    || (swingEnabled && (loopStaleness.swingScan || loopStaleness.swingExit));
  const loopsTimersActive = Boolean(walletBalanceRefreshTimer)
    && (config.risk?.realtimeStopLossEnabled === false || Boolean(realtimeStopTimer))
    && (!momentumEnabled || (Boolean(momentumScanTimer) && Boolean(momentumExitTimer)))
    && (!swingEnabled || (Boolean(swingScanTimer) && Boolean(swingExitTimer) && Boolean(swingWatchlistRefreshTimer)));
  const loopsHealthy = loopsTimersActive && !anyLoopStale;
  const skippedExitThreshold = Math.max(1, Number(config.risk?.skippedExitChecksAlertThreshold || 3));
  const strategyDegradation = ['momentum', 'swing'].map((strategyName) => {
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
    momentum: Boolean(filterStatsState.signalDrought?.momentum),
    swing: Boolean(filterStatsState.signalDrought?.swing),
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

  if (signalDrought.momentum) {
    degradedReasons.push('signal_drought_momentum');
  }
  if (signalDrought.swing) {
    degradedReasons.push('signal_drought_swing');
  }
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
    swingScanActive: Boolean(loopLocks.swingScan),
    loops: {
      healthy: loopsHealthy,
      timersActive: loopsTimersActive,
      anyStale: anyLoopStale,
      momentumScan: {
        timerActive: Boolean(momentumScanTimer),
        lastCompletedAt: loopLastCompletedAt.momentumScan ? new Date(loopLastCompletedAt.momentumScan).toISOString() : null,
        stale: loopStaleness.momentumScan,
      },
      swingScan: {
        timerActive: Boolean(swingScanTimer),
        lastCompletedAt: loopLastCompletedAt.swingScan ? new Date(loopLastCompletedAt.swingScan).toISOString() : null,
        stale: loopStaleness.swingScan,
      },
      momentumExit: {
        timerActive: Boolean(momentumExitTimer),
        lastCompletedAt: loopLastCompletedAt.momentumExit ? new Date(loopLastCompletedAt.momentumExit).toISOString() : null,
        stale: loopStaleness.momentumExit,
      },
      swingExit: {
        timerActive: Boolean(swingExitTimer),
        lastCompletedAt: loopLastCompletedAt.swingExit ? new Date(loopLastCompletedAt.swingExit).toISOString() : null,
        stale: loopStaleness.swingExit,
      },
      swingWatchlistRefreshTimerActive: Boolean(swingWatchlistRefreshTimer),
      walletBalanceRefresh: {
        timerActive: Boolean(walletBalanceRefreshTimer),
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
    signalDroughtCycles: {
      momentum: Number(filterStatsState.consecutiveZeroSignalCycles?.momentum || 0),
      swing: Number(filterStatsState.consecutiveZeroSignalCycles?.swing || 0),
    },
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
  return Object.entries(portfolio.positions)
    .map(([positionKey, position]) => {
      const currentValue = getPositionValue(position);
      const costBasisUsd = Number(position.costBasisUsd || position.initialSizeUsd || 0);
      const unrealizedPnl = currentValue - costBasisUsd;
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

  const strategySummaries = ['swing', 'momentum'].reduce((acc, strategyName) => {
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
  const snapshot = getPortfolioSnapshot();
  const point = {
    timestamp: new Date().toISOString(),
    cash: snapshot.cashBalance,
    equity: snapshot.equity,
    totalPnl: snapshot.totalPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
    reason,
  };
  portfolio.pnlHistory.push(point);
  telemetry.logPnlPoint(point);

  if (portfolio.pnlHistory.length > 240) {
    portfolio.pnlHistory.shift();
  }
}

function toCompactTrackedToken(token) {
  return {
    key: token.key,
    symbol: token.symbol,
    address: token.address,
    chain: token.chain,
    chainKey: token.chainKey,
    strategy: token.strategy,
    discoveryLane: token.discoveryLane || null,
    price: token.price,
    liquidityUsd: token.liquidityUsd,
    priceChange24h: token.priceChange24h,
    historyBars: token.historyBars,
    technicalSignal: token.technicalSignal,
    finalSignal: token.finalSignal,
    aiReason: token.aiReason || '',
    aiVerificationStatus: token.aiVerificationStatus || 'none',
    aiVerificationQueuedAt: token.aiVerificationQueuedAt || null,
    notBoughtReason: token.notBoughtReason || '',
    lastBuyFailure: token.lastBuyFailure || '',
    lastBuyFailureAt: token.lastBuyFailureAt || null,
    riskFlags: Array.isArray(token.riskFlags) ? token.riskFlags : [],
    indicators: {
      rsi: token.indicators?.rsi ?? null,
      volumeSpike: token.indicators?.volumeSpike ?? null,
      buyRatioRecentPct: token.indicators?.buyRatioRecentPct ?? null,
      netBuyFlowUsd10m: token.indicators?.netBuyFlowUsd10m ?? null,
      shortSignal: token.indicators?.shortSignal ?? null,
      mediumSignal: token.indicators?.mediumSignal ?? null,
      longSignal: token.indicators?.longSignal ?? null,
      recentWindowLabel: token.indicators?.recentWindowLabel ?? null,
    },
    momentumState: token.momentumState || null,
    rotationContext: token.rotationContext || null,
    hasOpenPosition: token.hasOpenPosition,
    signalSource: token.signalSource,
    lastSignalAt: token.lastSignalAt,
    lastScannedAt: token.lastScannedAt,
  };
}

function toCompactSignal(signal) {
  return {
    timestamp: signal.timestamp,
    symbol: signal.symbol,
    address: signal.address,
    chain: signal.chain,
    strategy: signal.strategy || null,
    discoveryLane: signal.discoveryLane || null,
    price: signal.price,
    technicalSignal: signal.technicalSignal,
    finalSignal: signal.finalSignal,
    aiReason: signal.aiReason || '',
    signalSource: signal.signalSource || signal.source || '',
    aiVerificationStatus: signal.aiVerificationStatus || 'none',
    notBoughtReason: signal.notBoughtReason || '',
    lastBuyFailure: signal.lastBuyFailure || '',
    lastBuyFailureAt: signal.lastBuyFailureAt || null,
    rsi: signal.rsi,
    volumeSpike: signal.volumeSpike,
    source: signal.source || signal.signalSource,
  };
}

function getTrackedTokens(options = {}) {
  const rawLimit = Number(options.limit);
  const compact = options.compact === true;
  const allTokens = Object.values(marketState.trackedTokens)
    .sort((a, b) => new Date(b.lastScannedAt || 0) - new Date(a.lastScannedAt || 0));
  const tokens = Number.isFinite(rawLimit) && rawLimit > 0
    ? allTokens.slice(0, rawLimit)
    : allTokens;

  return compact ? tokens.map(toCompactTrackedToken) : tokens;
}

function recordSignalEvent(entry) {
  marketState.signals.unshift(entry);
  if (marketState.signals.length > 1000) {
    marketState.signals.splice(1000);
  }
}

function summarizeBuyFailureReason(message) {
  const raw = String(message || '').trim();
  const value = raw.toLowerCase();
  if (!raw) return 'buy execution failed';
  if (value.includes('insufficient funds')) return 'insufficient funds';
  if (value.includes('transaction reverted') || value.includes('buy transaction reverted') || value.includes('swap reverted')) {
    return 'swap reverted';
  }
  if (
    value.includes('private tx')
    || value.includes('private rpc')
    || value.includes('private route')
    || value.includes('mev protection required')
  ) {
    return 'private route unavailable';
  }
  return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}

function recordBuyFailureState(chainName, tokenData, errorMessage) {
  const key = `${chainName}:${String(tokenData?.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key];
  const reason = summarizeBuyFailureReason(errorMessage);
  const timestamp = new Date().toISOString();

  if (previous) {
    marketState.trackedTokens[key] = {
      ...previous,
      notBoughtReason: reason,
      lastBuyFailure: reason,
      lastBuyFailureAt: timestamp,
    };
  }

  const recentSignal = marketState.signals.find((entry) => (
    String(entry?.address || '').toLowerCase() === String(tokenData?.address || '').toLowerCase()
    && normalizeChainKey(entry?.chainKey || entry?.chain) === normalizeChainKey(chainName)
  ));

  if (recentSignal) {
    recentSignal.notBoughtReason = reason;
    recentSignal.lastBuyFailure = reason;
    recentSignal.lastBuyFailureAt = timestamp;
  }
}

function recordTradeBlockState(chainName, tokenData, strategyName, technicalSignal, signalSource, blockReason, extra = {}) {
  const reason = String(blockReason || '').trim();
  const timestamp = new Date().toISOString();
  const key = `${chainName}:${String(tokenData?.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key];

  const snapshotReason = reason || previous?.notBoughtReason || '';
  if (previous) {
    marketState.trackedTokens[key] = {
      ...previous,
      strategy: strategyName || previous.strategy || null,
      technicalSignal: technicalSignal || previous.technicalSignal || null,
      finalSignal: previous.finalSignal || 'HOLD',
      signalSource: signalSource || previous.signalSource || '',
      notBoughtReason: snapshotReason,
      riskFlags: Array.isArray(extra.riskFlags) && extra.riskFlags.length
        ? extra.riskFlags
        : (Array.isArray(previous.riskFlags) ? previous.riskFlags : []),
      rotationContext: extra.rotationContext || previous.rotationContext || null,
      lastScannedAt: timestamp,
    };
  }

  const recentSignal = marketState.signals.find((entry) => (
    String(entry?.address || '').toLowerCase() === String(tokenData?.address || '').toLowerCase()
    && normalizeChainKey(entry?.chainKey || entry?.chain) === normalizeChainKey(chainName)
  ));
  if (recentSignal) {
    recentSignal.notBoughtReason = snapshotReason;
    if (Array.isArray(extra.riskFlags) && extra.riskFlags.length) {
      recentSignal.riskFlags = extra.riskFlags;
    }
    if (extra.rotationContext) {
      recentSignal.rotationContext = extra.rotationContext;
    }
  }
}

function buildMomentumMetrics(tokenData = {}, technicalDetails = {}) {
  return {
    priceChange24h: Number(tokenData?.priceChange24h || technicalDetails?.priceChange24h || 0),
    buyRatioRecentPct: Number(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || tokenData?.buyRatioRecentPct || 0),
    volumeSpike: Number(technicalDetails?.volumeSpike || tokenData?.volumeSpike || 0),
    confidence: normalizeConfidencePercent(technicalDetails?.confidence ?? tokenData?.confidence ?? 0),
    netBuyFlowUsd10m: Number(technicalDetails?.netBuyFlowUsd10m || tokenData?.netBuyFlowUsd10m || 0),
  };
}

function isStrongMomentumSnapshot(metrics = {}) {
  return Number(metrics.priceChange24h || 0) > 0
    && Number(metrics.buyRatioRecentPct || 0) >= 52
    && Number(metrics.volumeSpike || 0) >= 1.1
    && Number(metrics.netBuyFlowUsd10m || 0) > 0;
}

function normalizeConfidencePercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

function normalizeRotationVolumeSpike(value) {
  const spike = Number(value || 0);
  if (!Number.isFinite(spike) || spike <= 0) return 0;
  if (spike <= 10) return spike;
  return Math.min(10, 1 + (Math.log10(spike) * 3));
}

function buildMomentumState(previousToken = null, metrics = {}) {
  const historyLimit = Math.max(3, Number(config.execution?.momentumRotationHistoryLimit || 5));
  const previousHistory = Array.isArray(previousToken?.momentumState?.history)
    ? previousToken.momentumState.history
    : [];
  const entry = {
    ts: new Date().toISOString(),
    priceChange24h: round(metrics.priceChange24h || 0, 2),
    buyRatioRecentPct: round(metrics.buyRatioRecentPct || 0, 2),
    volumeSpike: round(metrics.volumeSpike || 0, 3),
    confidence: round(normalizeConfidencePercent(metrics.confidence || 0), 2),
    netBuyFlowUsd10m: round(metrics.netBuyFlowUsd10m || 0, 2),
    strong: isStrongMomentumSnapshot(metrics),
  };
  const history = previousHistory.concat(entry).slice(-historyLimit);
  const current = history[history.length - 1] || entry;
  const prior = history[history.length - 2] || null;
  const deltaPriceChange24h = prior ? Number(current.priceChange24h || 0) - Number(prior.priceChange24h || 0) : 0;
  const deltaVolumeSpike = prior ? Number(current.volumeSpike || 0) - Number(prior.volumeSpike || 0) : 0;
  const deltaBuyRatioRecentPct = prior ? Number(current.buyRatioRecentPct || 0) - Number(prior.buyRatioRecentPct || 0) : 0;
  const deltaNetBuyFlowUsd10m = prior ? Number(current.netBuyFlowUsd10m || 0) - Number(prior.netBuyFlowUsd10m || 0) : 0;
  const accelerationScore =
    (deltaPriceChange24h * 0.8)
    + (deltaVolumeSpike * 8)
    + (deltaBuyRatioRecentPct * 0.9)
    + Math.max(-12, Math.min(12, deltaNetBuyFlowUsd10m / 2500));

  let consecutiveStrongScans = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (!history[i]?.strong) break;
    consecutiveStrongScans += 1;
  }

  return {
    history,
    deltaPriceChange24h: round(deltaPriceChange24h, 2),
    deltaVolumeSpike: round(deltaVolumeSpike, 3),
    deltaBuyRatioRecentPct: round(deltaBuyRatioRecentPct, 2),
    deltaNetBuyFlowUsd10m: round(deltaNetBuyFlowUsd10m, 2),
    accelerationScore: round(accelerationScore, 2),
    consecutiveStrongScans,
    strongNow: Boolean(current.strong),
  };
}

function updateTrackedToken(chainName, tokenData, evaluation, options = {}) {
  const recordSignal = options.recordSignal !== false;
  const key = `${chainName}:${String(tokenData.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key];
  const aiCacheStatus = getAiDecisionCacheStatus(tokenData, evaluation.strategy || 'momentum');
  const momentumMetrics = buildMomentumMetrics(tokenData, evaluation.details || {});
  const momentumState = buildMomentumState(previous, momentumMetrics);
  const snapshot = {
    key,
    symbol: tokenData.symbol,
    address: tokenData.address,
    chain: tokenData.chain,
    chainKey: chainName,
    strategy: evaluation.strategy || null,
    discoveryLane: tokenData.discoveryLane || evaluation.details?.discoveryLane || null,
    price: round(tokenData.price, 8),
    liquidityUsd: round(tokenData.liquidityUsd || 0),
    liquidityChange24hPct: round(tokenData.liquidityChange24hPct || 0, 2),
    volume24h: round(tokenData.volume24h || 0),
    priceChange24h: round(tokenData.priceChange24h || 0, 2),
    priceChange7d: round(tokenData.priceChange7d || 0, 2),
    holderCount: Number(tokenData.holderCount || 0),
    topHoldersPct: round(tokenData.topHoldersPct || 0, 2),
    listingDate: tokenData.listingDate || null,
    listedOnCoinGecko: Boolean(tokenData.coingeckoId || tokenData.listedOnCoinGecko),
    listedOnCoinMarketCap: Boolean(tokenData.listedOnCoinMarketCap),
    buyTx10m: Number(tokenData.buyTx10m || 0),
    sellTx10m: Number(tokenData.sellTx10m || 0),
    buyTx1h: Number(tokenData.buyTx1h || 0),
    sellTx1h: Number(tokenData.sellTx1h || 0),
    uniqueBuyers10m: Number(tokenData.uniqueBuyers10m || 0),
    historyBars: strategy.getHistoryLength(tokenData.strategyKey || buildTokenKey(chainName, tokenData.address)),
    technicalSignal: evaluation.technicalSignal,
    finalSignal: evaluation.finalSignal,
    signalSource: evaluation.signalSource,
    aiReason: evaluation.aiReason || '',
    aiConfidence: evaluation.aiConfidence || 0,
    aiVerificationStatus: evaluation.details?.aiVerificationStatus || aiCacheStatus.status || 'none',
    aiVerificationQueuedAt: aiCacheStatus.queuedAt || null,
    notBoughtReason: evaluation.notBoughtReason || '',
    lastBuyFailure: evaluation.lastBuyFailure || previous?.lastBuyFailure || '',
    lastBuyFailureAt: evaluation.lastBuyFailureAt || previous?.lastBuyFailureAt || null,
    riskFlags: evaluation.riskFlags || [],
    indicators: {
      fastEma: evaluation.details.fastEma ?? null,
      slowEma: evaluation.details.slowEma ?? null,
      rsi: evaluation.details.rsi ?? null,
      volumeSpike: evaluation.details.volumeSpike ?? null,
      buyRatioRecentPct: evaluation.details.buyRatioRecentPct ?? evaluation.details.buyRatio10mPct ?? null,
      netBuyFlowUsd10m: evaluation.details.netBuyFlowUsd10m ?? null,
      shortSignal: evaluation.details.short?.signal || null,
      mediumSignal: evaluation.details.medium?.signal || null,
      longSignal: evaluation.details.long?.signal || null,
      confidence: evaluation.details.confidence || 0,
      triggerTimeframe: evaluation.details.triggerTimeframe || null,
      recentWindowLabel: evaluation.details.recentWindowLabel || null,
    },
    momentumState,
    rotationContext: evaluation.details?.rotationContext || null,
    hasOpenPosition: Boolean(portfolio.positions[buildTokenKey(chainName, tokenData.address)]),
    lastScannedAt: new Date().toISOString(),
  };

  marketState.trackedTokens[key] = snapshot;

  const shouldLog = !previous
    || previous.finalSignal !== snapshot.finalSignal
    || previous.signalSource !== snapshot.signalSource
    || snapshot.finalSignal === 'BUY'
    || snapshot.finalSignal === 'SELL';

  if (recordSignal && shouldLog) {
    recordSignalEvent({
      timestamp: snapshot.lastScannedAt,
      symbol: snapshot.symbol,
      address: snapshot.address,
      chain: snapshot.chain,
      chainKey: snapshot.chainKey,
      strategy: snapshot.strategy,
      discoveryLane: snapshot.discoveryLane,
      price: snapshot.price,
      technicalSignal: snapshot.technicalSignal,
      finalSignal: snapshot.finalSignal,
      signalSource: snapshot.signalSource,
      aiReason: snapshot.aiReason,
      aiConfidence: snapshot.aiConfidence,
      aiVerificationStatus: snapshot.aiVerificationStatus,
      rsi: snapshot.indicators.rsi,
      volumeSpike: snapshot.indicators.volumeSpike,
    });

    // SQL telemetry (gated by SQL_ENABLED)
    telemetry.logSignal(snapshot, {
      gate: evaluation?.details || null,
      rejectReasons: evaluation?.details?.externalReasons || evaluation?.notBoughtReason || null,
    });
  }
}

function refreshTrackedOpenPositionSnapshot(chainName, tokenData, position = {}) {
  const key = `${chainName}:${String(tokenData?.address || position?.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key] || {};
  const previousIndicators = previous?.indicators || {};
  const metrics = buildMomentumMetrics(tokenData, {
    confidence: previousIndicators.confidence || 0,
    volumeSpike: tokenData?.volumeSpike ?? previousIndicators.volumeSpike ?? 0,
    buyRatioRecentPct: tokenData?.buyRatioRecentPct ?? tokenData?.buyRatio10mPct ?? previousIndicators.buyRatioRecentPct ?? 0,
    netBuyFlowUsd10m: tokenData?.netBuyFlowUsd10m ?? previousIndicators.netBuyFlowUsd10m ?? 0,
  });
  const momentumState = buildMomentumState(previous, metrics);

  marketState.trackedTokens[key] = {
    ...previous,
    key,
    symbol: tokenData?.symbol || position?.symbol || previous?.symbol || '',
    address: tokenData?.address || position?.address || previous?.address || '',
    chain: CHAIN_LABELS[chainName],
    chainKey: chainName,
    strategy: position?.strategy || previous?.strategy || 'momentum',
    price: round(tokenData?.price || previous?.price || 0, 8),
    volume24h: round(tokenData?.volume24h || previous?.volume24h || 0),
    priceChange24h: round(tokenData?.priceChange24h || previous?.priceChange24h || 0, 2),
    signalSource: previous?.signalSource || 'position_monitor',
    finalSignal: previous?.finalSignal || 'OPEN',
    aiReason: previous?.aiReason || '',
    aiConfidence: normalizeConfidencePercent(previous?.aiConfidence || 0),
    aiVerificationStatus: previous?.aiVerificationStatus || 'none',
    aiVerificationQueuedAt: previous?.aiVerificationQueuedAt || null,
    notBoughtReason: '',
    lastBuyFailure: previous?.lastBuyFailure || '',
    lastBuyFailureAt: previous?.lastBuyFailureAt || null,
    riskFlags: previous?.riskFlags || [],
    indicators: {
      ...previousIndicators,
      confidence: normalizeConfidencePercent(previousIndicators.confidence || 0),
      volumeSpike: round(metrics.volumeSpike || 0, 3),
      buyRatioRecentPct: round(metrics.buyRatioRecentPct || 0, 2),
      netBuyFlowUsd10m: round(metrics.netBuyFlowUsd10m || 0, 2),
    },
    momentumState,
    rotationContext: null,
    hasOpenPosition: true,
    lastScannedAt: new Date().toISOString(),
  };
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

function buildAiDecisionCacheKey(tokenData, strategyName) {
  const chainKey = normalizeChainKey(tokenData?.chainKey || tokenData?.chain || 'unknown');
  const address = String(tokenData?.address || '').toLowerCase();
  return `${chainKey}:${address}:${String(strategyName || 'momentum').toLowerCase()}`;
}

function getAiDecisionCacheTtlMs(strategyName) {
  const strategy = String(strategyName || '').toLowerCase();
  // Momentum needs fresh decisions because prices move fast — 5 minute cache is too stale.
  // Swing can tolerate longer caching because positions are held for hours.
  if (strategy === 'momentum') {
    return Math.max(1000, Number(config.ai?.momentumDecisionCacheMs || 300000));
  }
  if (strategy === 'swing') {
    return Math.max(1000, Number(config.ai?.swingDecisionCacheMs || 1800000));
  }
  return Math.max(1000, Number(config.ai?.decisionCacheMs || 300000));
}

function hasFreshAiDecision(entry, strategyName) {
  if (!entry || !entry.decision || !Number.isFinite(Number(entry.updatedAt))) {
    return false;
  }
  return (Date.now() - Number(entry.updatedAt)) <= getAiDecisionCacheTtlMs(strategyName || entry?.strategy);
}

function scoreAiDecisionCandidate(tokenData, technicalDetails = {}) {
  const triggerTimeframe = String(technicalDetails?.triggerTimeframe || '').toLowerCase();
  const discoveryLane = String(tokenData?.discoveryLane || technicalDetails?.discoveryLane || '').toLowerCase();
  const confidence = normalizeConfidencePercent(technicalDetails?.confidence || 0);
  const volumeSpike = Number(technicalDetails?.volumeSpike || 0);
  const buyRatioRecentPct = Number(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || 0);
  const netBuyFlowUsd = Number(technicalDetails?.netBuyFlowUsd10m || 0);
  const liquidityUsd = Number(tokenData?.liquidityUsd || 0);
  const priceChange24h = Math.abs(Number(tokenData?.priceChange24h || 0));
  const rsiValue = Number(technicalDetails?.rsi || 0);

  let score = confidence;
  score += Math.min(60, Math.max(0, volumeSpike) * 12);
  score += Math.min(35, Math.max(0, buyRatioRecentPct) * 0.45);
  score += Math.min(25, Math.log10(Math.max(1, liquidityUsd)) * 4);
  score += Math.min(20, Math.log10(Math.max(1, netBuyFlowUsd + 1)) * 8);
  score += Math.min(20, priceChange24h * 0.12);

  if (technicalDetails?.breakoutConfirmed) score += 15;
  if (triggerTimeframe === 'extreme_24h_momentum') score += 40;
  if (triggerTimeframe === 'momentum_breakout') score += 28;
  if (triggerTimeframe === 'bsc_relaxed_continuation') score += 22;
  if (triggerTimeframe === 'kucoin_relaxed_momentum') score += 18;
  if (discoveryLane === 'core') score += 8;
  if (discoveryLane === 'exploration') score += 3;
  if (Number.isFinite(rsiValue) && rsiValue >= 50 && rsiValue <= 72) score += 10;

  return Number.isFinite(score) ? score : 0;
}

function removeAiDecisionQueueCandidate(tokenData, strategyName) {
  const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
  aiDecisionQueue.delete(cacheKey);
}

function cacheAiDecisionCandidate(tokenData, technicalDetails, strategyName, options = {}) {
  const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
  const existing = aiDecisionCache.get(cacheKey) || {};
  const nowIso = new Date().toISOString();
  aiDecisionCache.set(cacheKey, {
    ...existing,
    candidate: {
      symbol: tokenData?.symbol || existing?.candidate?.symbol || '',
      address: tokenData?.address || existing?.candidate?.address || '',
      chain: tokenData?.chain || existing?.candidate?.chain || '',
      chainKey: normalizeChainKey(tokenData?.chainKey || tokenData?.chain || existing?.candidate?.chainKey || 'unknown'),
      strategy: String(strategyName || existing?.candidate?.strategy || 'momentum').toLowerCase(),
      discoveryLane: tokenData?.discoveryLane || technicalDetails?.discoveryLane || existing?.candidate?.discoveryLane || null,
      triggerTimeframe: technicalDetails?.triggerTimeframe || existing?.candidate?.triggerTimeframe || null,
      technicalSignal: technicalDetails?.signal || technicalDetails?.technicalSignal || existing?.candidate?.technicalSignal || null,
      price: round(tokenData?.price || existing?.candidate?.price || 0, 8),
      liquidityUsd: round(tokenData?.liquidityUsd || existing?.candidate?.liquidityUsd || 0),
      priceChange24h: round(tokenData?.priceChange24h || existing?.candidate?.priceChange24h || 0, 2),
      buyRatioRecentPct: round(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || existing?.candidate?.buyRatioRecentPct || 0, 2),
      volumeSpike: round(technicalDetails?.volumeSpike || existing?.candidate?.volumeSpike || 0, 2),
      source: options.source || existing?.candidate?.source || 'buy_candidate',
      queuedAt: existing?.candidate?.queuedAt || nowIso,
      lastQueuedAt: nowIso,
    },
  });
}

function getAiDecisionCacheStatus(tokenData, strategyName) {
  const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
  const entry = aiDecisionCache.get(cacheKey);
  if (!entry) {
    return { status: 'none', queuedAt: null, decision: null };
  }
  if (entry.inFlight) {
    return {
      status: 'pending',
      queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
      decision: entry.decision || null,
    };
  }
  if (hasFreshAiDecision(entry)) {
    return {
      status: 'ready',
      queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
      decision: entry.decision,
    };
  }
  if (aiDecisionQueue.has(cacheKey) || entry.candidate) {
    return {
      status: 'queued',
      queuedAt: entry?.candidate?.lastQueuedAt || entry?.candidate?.queuedAt || null,
      decision: null,
    };
  }
  return { status: 'none', queuedAt: null, decision: null };
}

function getCachedAiDecision(tokenData, strategyName) {
  const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
  const entry = aiDecisionCache.get(cacheKey);
  return hasFreshAiDecision(entry, strategyName) ? entry.decision : null;
}

function pumpAiDecisionQueue() {
  if (aiDecisionInFlightKey || !config.anthropic.enabled || Date.now() < aiCircuit.cooldownUntil) {
    return;
  }

  const nextEntry = [...aiDecisionQueue.entries()]
    .sort((left, right) => {
      const priorityDelta = Number(right[1]?.priority || 0) - Number(left[1]?.priority || 0);
      if (priorityDelta !== 0) return priorityDelta;
      return Date.parse(left[1]?.queuedAt || 0) - Date.parse(right[1]?.queuedAt || 0);
    })[0];

  if (!nextEntry) {
    return;
  }

  const [cacheKey, queued] = nextEntry;
  const existing = aiDecisionCache.get(cacheKey) || {};
  aiDecisionInFlightKey = cacheKey;

  const request = AITradeBrain.evaluateToken(queued.tokenData, queued.technicalDetails)
    .then((aiDecision) => {
      const latest = aiDecisionCache.get(cacheKey) || existing;
      aiDecisionQueue.delete(cacheKey);
      aiDecisionCache.set(cacheKey, {
        ...latest,
        decision: aiDecision || latest.decision || null,
        updatedAt: Date.now(),
        inFlight: null,
      });
      if (aiDecision && aiDecision.signal) {
        aiCircuit.failures = 0;
        recordBrainSuccess(queued.tokenData, aiDecision);
      } else if (config.anthropic.apiKey) {
        aiCircuit.failures += 1;
        if (aiCircuit.failures >= config.bot.aiFailureThreshold) {
          aiCircuit.cooldownUntil = Date.now() + (config.bot.aiFailureCooldownSeconds * 1000);
          aiCircuit.failures = 0;
          recordBrainFailure(`AI circuit opened for ${config.bot.aiFailureCooldownSeconds}s`);
        } else {
          recordBrainFailure('AI response unavailable');
        }
      }
      return aiDecision;
    })
    .catch((error) => {
      const latest = aiDecisionCache.get(cacheKey) || existing;
      aiDecisionQueue.delete(cacheKey);
      aiDecisionCache.set(cacheKey, {
        ...latest,
        decision: latest.decision || null,
        updatedAt: Number(latest.updatedAt || 0),
        inFlight: null,
      });
      recordBrainFailure(error.message || 'AI async refresh failed');
      return null;
    })
    .finally(() => {
      aiDecisionInFlightKey = null;
      pumpAiDecisionQueue();
    });

  aiDecisionCache.set(cacheKey, {
    ...existing,
    decision: existing.decision || null,
    updatedAt: Number(existing.updatedAt || 0),
    inFlight: request,
  });
}

function queueAiDecisionRefresh(tokenData, technicalDetails, strategyName) {
  const cacheKey = buildAiDecisionCacheKey(tokenData, strategyName);
  if (String(technicalDetails?.signal || technicalDetails?.technicalSignal || '').toUpperCase() !== 'BUY') {
    removeAiDecisionQueueCandidate(tokenData, strategyName);
    return;
  }

  cacheAiDecisionCandidate(tokenData, technicalDetails, strategyName, { source: 'async_refresh' });
  const existing = aiDecisionCache.get(cacheKey) || {};
  if (existing.inFlight || hasFreshAiDecision(existing) || !config.anthropic.enabled || Date.now() < aiCircuit.cooldownUntil) {
    return;
  }

  aiDecisionQueue.set(cacheKey, {
    tokenData: { ...tokenData },
    technicalDetails: { ...technicalDetails },
    strategyName,
    priority: scoreAiDecisionCandidate(tokenData, technicalDetails),
    queuedAt: new Date().toISOString(),
  });

  pumpAiDecisionQueue();
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
  await sendErrorAlert(reason).catch(() => undefined);

  for (const position of impactedPositions) {
    try {
      const tokenData = await exchange.getTokenData(position.address).catch(() => null);
      const exitToken = {
        ...(tokenData || {}),
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
    brainProfileKey: executionMeta.brainProfileKey || undefined,
    brainMultiplier: Number.isFinite(Number(executionMeta.brainMultiplier)) ? round(executionMeta.brainMultiplier, 4) : undefined,
    executionStatus: executionMeta.executionStatus || undefined,
    recoveredFromFailure: executionMeta.recoveredFromFailure === true ? true : undefined,
    recoverySource: executionMeta.recoverySource || undefined,
    timestamp: tradeTimestamp,
  };

  portfolio.trades.unshift(trade);
  telemetry.logTradeLedger(trade);
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

function restoreKucoinRecoveredBuy(walletPosition, recoveredFill) {
  if (!walletPosition?.address || !recoveredFill?.txid) {
    return false;
  }

  ensureStatsShape();
  const chainName = 'kucoin';
  const address = String(walletPosition.address || '').trim();
  const tokenKey = buildTokenKey(chainName, address);
  if (!address || portfolio.positions?.[tokenKey]) {
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
}

function buildDashboardState(options = {}) {
  const compact = options.compact === true;
  const runtime = getRuntimeSnapshot();
  const trackedTokens = getTrackedTokens({ compact });
  const activeScanCounterMismatches = getScanCounterMismatchState();
  const recentSignals = compact
    ? marketState.signals.map(toCompactSignal)
    : marketState.signals;
  const performanceGate = risk.checkPerformanceGate(portfolio.stats || {});
  return buildDashboardStatePayload({
    compact,
    runtime,
    mode: config.paperTrading ? 'paper' : 'live',
    health: getHealthStatus(),
    portfolio: getPortfolioSnapshot({ compact }),
    performanceGate,
    configSnapshot: {
      paperTrading: config.paperTrading,
      paperBalance: config.paperBalance,
      strategy: config.strategy,
      strategies: config.strategies,
      risk: config.risk,
      bot: config.bot,
      anthropic: {
        enabled: config.anthropic.enabled,
        model: config.anthropic.model,
        temperature: config.anthropic.temperature,
        hasApiKey: Boolean(config.anthropic.apiKey),
      },
    },
    scanStatus,
    brainState: {
      ...brainState,
      enabled: config.anthropic.enabled,
      hasApiKey: Boolean(config.anthropic.apiKey),
    },
    round,
    filterStatsState,
    diagnostics: {
      scanCounterMismatchCount: activeScanCounterMismatches.length,
      scanCounterMismatches: compact ? undefined : activeScanCounterMismatches,
    },
    agentActions: compact ? getAgentActionFeed(12) : getAgentActionFeed(28),
    evolutionState: {
      activeExperiment: marketState.evolution?.activeExperiment
        ? {
          id: marketState.evolution.activeExperiment.id,
          status: marketState.evolution.activeExperiment.status,
          startedAt: marketState.evolution.activeExperiment.startedAt,
          changedFiles: marketState.evolution.activeExperiment.changedFiles || [],
          lastEvaluatedAt: marketState.evolution.activeExperiment.lastEvaluatedAt || null,
          lastEvaluation: compact ? undefined : marketState.evolution.activeExperiment.lastEvaluation,
        }
        : null,
      lastPromotion: marketState.evolution?.lastPromotion || null,
      lastRollback: marketState.evolution?.lastRollback || null,
      liveRollout: marketState.evolution?.liveRollout || null,
      recentHistory: compact
        ? (marketState.evolution?.history || []).slice(0, 3)
        : (marketState.evolution?.history || []).slice(0, 12),
    },
    trackedTokens,
    catalystPairs: getPrioritizedKucoinCatalystPairs().slice(0, 20),
    recentSignals,
    backtests: compact ? [] : marketState.backtests.slice(0, 5),
    simulations: compact ? [] : marketState.simulations.slice(0, 5),
    chainLabels: CHAIN_LABELS,
    supportsSwingOnChain,
  });
}

function getAgentActionFeed(limit = 24) {
  const actions = [];
  const now = Date.now();

  const pushAction = (type, text, ts = now) => {
    const phrase = String(text || '').trim();
    if (!phrase) return;
    actions.push({ type: String(type || 'agent'), phrase: phrase.slice(0, 180), ts: Number(ts || now) });
  };

  const memoryContext = typeof agentMemory?.getContextForAI === 'function'
    ? (agentMemory.getContextForAI() || {})
    : {};
  const intelligenceContext = typeof intelligenceAgent?.getContextForEvolution === 'function'
    ? (intelligenceAgent.getContextForEvolution() || null)
    : null;

  (memoryContext.pendingDiscoveries || []).slice(0, 8).forEach((d) => {
    pushAction('discovery', `Discovery: ${d.theme || 'market'} - ${String(d.insight || '').slice(0, 100)}`);
  });

  (memoryContext.recentLessons || []).slice(0, 6).forEach((lesson) => {
    const outcome = String(lesson.outcome || '').toLowerCase() === 'loss' ? 'loss' : 'win';
    const pnl = Number(lesson.pnl || 0);
    pushAction('lesson', `Lesson (${outcome}): ${lesson.symbol || 'token'} ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`);
  });

  (memoryContext.blacklistedTokens || []).slice(0, 6).forEach((symbol) => {
    pushAction('blacklist', `Blacklist active: ${symbol}`);
  });

  if (intelligenceContext) {
    if (intelligenceContext.strategyRecommendation?.preferredType) {
      pushAction(
        'intelligence',
        `Intelligence bias: ${intelligenceContext.strategyRecommendation.preferredType}/${intelligenceContext.strategyRecommendation.aggressiveness || 'normal'}`,
      );
    }
    (intelligenceContext.riskWarnings || []).slice(0, 5).forEach((riskText) => {
      pushAction('risk', `Risk: ${String(riskText || '').slice(0, 120)}`);
    });
    (intelligenceContext.selfImprovementInsights || []).slice(0, 5).forEach((insight) => {
      pushAction('improve', `Improve: ${String(insight?.suggestedAction || insight?.observation || '').slice(0, 120)}`);
    });
  }

  const latestCycles = [
    ...((filterStatsState.recentCycles?.momentum || []).slice(0, 2)),
    ...((filterStatsState.recentCycles?.swing || []).slice(0, 2)),
  ];
  latestCycles.forEach((cycle) => {
    const evaluated = Number(cycle?.evaluated || 0);
    const technicalBlocked = Number(cycle?.technicalBlocked || 0);
    if (evaluated > 0 && technicalBlocked > 0) {
      const blockedPct = ((technicalBlocked / evaluated) * 100).toFixed(1);
      pushAction('gate', `Gate ${cycle.strategy || 'unknown'}: technical blocked ${technicalBlocked}/${evaluated} (${blockedPct}%)`);
    }
  });

  return actions
    .sort((left, right) => Number(right.ts || 0) - Number(left.ts || 0))
    .slice(0, Math.max(4, Number(limit || 24)));
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

function supportsSwingOnChain(chainName) {
  return String(chainName || '').toLowerCase() === 'kucoin';
}

async function rankBscMomentumUniverse(exchange, candidates = []) {
  const topEnabled = config.discovery?.bscTopUniverseEnabled !== false;
  if (!topEnabled || !Array.isArray(candidates) || candidates.length === 0) {
    setBscDiscoveryLaneMetadata([], null);
    return Array.isArray(candidates) ? candidates : [];
  }

  const topN = Math.max(10, Number(config.discovery?.bscTopUniverseSize || 200));
  const coreLimit = Math.max(1, Number(config.discovery?.bscCoreUniverseSize || Math.round(topN * 0.7) || topN));
  const explorationEnabled = config.discovery?.bscExplorationEnabled !== false;
  const explorationLimit = explorationEnabled
    ? Math.max(0, Number(config.discovery?.bscExplorationUniverseSize || Math.max(20, topN - coreLimit)))
    : 0;
  const borderlineEnabled = config.discovery?.bscBorderlineEnabled === true;
  const borderlineLimit = borderlineEnabled
    ? Math.max(0, Number(config.discovery?.bscBorderlineUniverseSize || 10))
    : 0;
  const coreMinLiquidityUsd = Math.max(0, Number(
    config.discovery?.bscCoreMinLiquidityUsd
    || config.discovery?.bscTopUniverseMinLiquidityUsd
    || 150000
  ));
  const coreMinVolume24hUsd = Math.max(0, Number(
    config.discovery?.bscCoreMinVolume24hUsd
    || config.discovery?.bscTopUniverseMinVolume24hUsd
    || 500000
  ));
  const explorationMinLiquidityUsd = Math.max(0, Number(config.discovery?.bscExplorationMinLiquidityUsd || 85000));
  const explorationMinVolume24hUsd = Math.max(0, Number(config.discovery?.bscExplorationMinVolume24hUsd || 150000));
  const borderlineMinLiquidityUsd = Math.max(0, Number(config.discovery?.bscBorderlineMinLiquidityUsd || 65000));
  const borderlineMinVolume24hUsd = Math.max(0, Number(config.discovery?.bscBorderlineMinVolume24hUsd || 125000));
  const maxAgeDays = Math.max(0, Number(config.discovery?.bscTopUniverseMaxAgeDays || 0));
  const requireLegitimacy = Boolean(config.discovery?.bscTopUniverseRequireLegitimacy);
  const batchSize = Math.max(5, Number(config.discovery?.bscTopUniverseRankBatchSize || 25));
  const maxRankDurationMs = Math.max(5000, Number(config.discovery?.bscTopUniverseMaxRankDurationMs || 90000));
  const startedAt = Date.now();

  const uniqueCandidates = [...new Set(candidates)].slice(0, 3000);
  const rankedCore = [];
  const rankedExploration = [];
  const rankedBorderline = [];
  const stats = {
    fetched: 0,
    missingTokenData: 0,
    filteredLiquidity: 0,
    filteredVolume: 0,
    filteredAge: 0,
    filteredLegitimacy: 0,
    qualifiedCore: 0,
    qualifiedExploration: 0,
    qualifiedBorderline: 0,
  };

  for (let i = 0; i < uniqueCandidates.length; i += batchSize) {
    if ((Date.now() - startedAt) > maxRankDurationMs) {
      logger.warn(
        `BSC rank timeout: stopping after ${Date.now() - startedAt}ms ` +
        `(${i}/${uniqueCandidates.length} candidates processed)`
      );
      break;
    }

    const batch = uniqueCandidates.slice(i, i + batchSize);
    const rows = await Promise.allSettled(batch.map(async (address) => {
      const token = await exchange.getTokenData(address);
      if (!token || !token.price) {
        stats.missingTokenData += 1;
        return null;
      }

      stats.fetched += 1;

      const liquidityUsd = Number(token.liquidityUsd || 0);
      const volume24h = Number(token.volume24h || token.volume24hUsd || 0);
      const listingAgeDays = Number(token.listingAgeDays || 0);
      const listingAgeHours = listingAgeDays * 24;
      token.tokenAgeBucket = listingAgeHours > 0 && listingAgeHours < 24
        ? 'new'
        : listingAgeHours < 168
        ? 'emerging'
        : 'established';
      const legitimacy = Boolean(token.coingeckoId || token.listedOnCoinGecko || token.listedOnCoinMarketCap);

      if (maxAgeDays > 0 && listingAgeDays > maxAgeDays) {
        stats.filteredAge += 1;
        return null;
      }
      if (requireLegitimacy && !legitimacy) {
        stats.filteredLegitimacy += 1;
        return null;
      }

      let lane = null;
      if (liquidityUsd >= coreMinLiquidityUsd && volume24h >= coreMinVolume24hUsd) {
        lane = 'core';
      } else if (
        explorationEnabled
        && liquidityUsd >= explorationMinLiquidityUsd
        && volume24h >= explorationMinVolume24hUsd
      ) {
        lane = 'exploration';
      } else if (
        borderlineEnabled
        && liquidityUsd >= borderlineMinLiquidityUsd
        && volume24h >= borderlineMinVolume24hUsd
      ) {
        lane = 'borderline';
      }

      if (!lane) {
        if (liquidityUsd < explorationMinLiquidityUsd) {
          stats.filteredLiquidity += 1;
        } else {
          stats.filteredVolume += 1;
        }
        return null;
      }

      if (lane === 'core') {
        stats.qualifiedCore += 1;
      } else if (lane === 'exploration') {
        stats.qualifiedExploration += 1;
      } else {
        stats.qualifiedBorderline += 1;
      }

      const liqScore = Math.log10(Math.max(1, liquidityUsd));
      const volScore = Math.log10(Math.max(1, volume24h));
      const ageScore = listingAgeDays > 0 ? Math.min(1.5, Math.log10(1 + listingAgeDays)) : 0;
      const legitimacyBonus = legitimacy ? 0.6 : 0;
      const laneBonus = lane === 'core' ? 0.25 : (lane === 'exploration' ? 0 : -0.1);
      const score = (liqScore * 0.55) + (volScore * 0.35) + (ageScore * 0.10) + legitimacyBonus + laneBonus;

      return {
        address: token.address || address,
        score,
        lane,
        liquidityUsd,
        volume24h,
      };
    }));

    rows.forEach((row) => {
      if (row.status !== 'fulfilled' || !row.value) return;
      if (row.value.lane === 'core') {
        rankedCore.push(row.value);
      } else if (row.value.lane === 'exploration') {
        rankedExploration.push(row.value);
      } else {
        rankedBorderline.push(row.value);
      }
    });
  }

  rankedCore.sort((a, b) => b.score - a.score);
  rankedExploration.sort((a, b) => b.score - a.score);
  rankedBorderline.sort((a, b) => b.score - a.score);

  const selected = [];
  const selectedCore = rankedCore.slice(0, Math.min(coreLimit, topN));
  selected.push(...selectedCore);

  const explorationSlots = Math.max(0, Math.min(explorationLimit, topN - selected.length));
  const selectedExploration = rankedExploration.slice(0, explorationSlots);
  selected.push(...selectedExploration);

  const borderlineSlots = Math.max(0, Math.min(borderlineLimit, topN - selected.length));
  const selectedBorderline = rankedBorderline.slice(0, borderlineSlots);
  selected.push(...selectedBorderline);

  if (selected.length < topN) {
    const leftovers = [
      ...rankedCore.slice(selectedCore.length),
      ...rankedExploration.slice(selectedExploration.length),
      ...rankedBorderline.slice(selectedBorderline.length),
    ].sort((a, b) => b.score - a.score);
    selected.push(...leftovers.slice(0, topN - selected.length));
  }

  const shortlisted = selected.slice(0, topN);
  setBscDiscoveryLaneMetadata(shortlisted, {
    baseCandidates: uniqueCandidates.length,
    shortlisted: shortlisted.length,
    coreQualified: rankedCore.length,
    explorationQualified: rankedExploration.length,
    borderlineQualified: rankedBorderline.length,
    coreSelected: shortlisted.filter((item) => item.lane === 'core').length,
    explorationSelected: shortlisted.filter((item) => item.lane === 'exploration').length,
    borderlineSelected: shortlisted.filter((item) => item.lane === 'borderline').length,
    coreMinLiquidityUsd,
    coreMinVolume24hUsd,
    explorationMinLiquidityUsd,
    explorationMinVolume24hUsd,
    borderlineMinLiquidityUsd,
    borderlineMinVolume24hUsd,
  });

  logger.info(
    `BSC ranked momentum universe: ${shortlisted.length}/${uniqueCandidates.length} ` +
    `(top=${topN}, core=${rankedCore.length}->${shortlisted.filter((item) => item.lane === 'core').length} ` +
    `@ $${Math.round(coreMinLiquidityUsd)}/$${Math.round(coreMinVolume24hUsd)}, ` +
    `explore=${rankedExploration.length}->${shortlisted.filter((item) => item.lane === 'exploration').length} ` +
    `@ $${Math.round(explorationMinLiquidityUsd)}/$${Math.round(explorationMinVolume24hUsd)}, ` +
    `borderline=${rankedBorderline.length}->${shortlisted.filter((item) => item.lane === 'borderline').length} ` +
    `@ $${Math.round(borderlineMinLiquidityUsd)}/$${Math.round(borderlineMinVolume24hUsd)}, ` +
    `fetched=${stats.fetched}, noData=${stats.missingTokenData}, lowLiq=${stats.filteredLiquidity}, ` +
    `lowVol=${stats.filteredVolume}, old=${stats.filteredAge}, illegitimate=${stats.filteredLegitimacy}, ` +
    `elapsedMs=${Date.now() - startedAt})`
  );

  return shortlisted.map((item) => item.address);
}

async function getTokensForStrategy(chainName, exchange, strategyName = 'momentum', options = {}) {
  if (!isStrategyScanEnabled(chainName, strategyName)) {
    return [];
  }

  const watchlistTokens = watchlists[chainName] || [];
  const discoveryStatus = wsDiscovery.getStatus();
  const forcePollingOnly = strategyName === 'momentum' && Boolean(discoveryStatus?.bootstrapFailed);

  if (strategyName === 'swing') {
    if (!supportsSwingOnChain(chainName)) {
      return [];
    }

    const swingSet = new Set(watchlistTokens);

    // Expand swing universe via adapter-specific candidates, or fall back to filtering
    // getNewTokens() through minimum swing eligibility thresholds.
    let adapterCandidates = [];
    if (typeof exchange.getSwingCandidates === 'function') {
      adapterCandidates = await exchange.getSwingCandidates().catch((err) => {
        logger.warn(`getSwingCandidates failed on ${chainName}: ${err.message}`);
        return [];
      });
    }

    if (adapterCandidates.length > 0) {
      adapterCandidates.forEach((addr) => swingSet.add(addr));
    } else if (typeof exchange.getNewTokens === 'function') {
      // Fall back: poll getNewTokens and filter through swing eligibility thresholds.
      const swingMinLiquidityUsd = Number(config.strategies?.swing?.minLiquidityUsd || 500000);
      const swingMinVolume24h = Number(config.strategies?.swing?.min24hVolumeUsd || 100000);
      const swingMinAgeDays = Number(config.strategies?.swing?.minTokenAgeDays || 7);
      try {
        const newTokenAddrs = await exchange.getNewTokens().catch(() => []);
        await Promise.allSettled(newTokenAddrs.slice(0, 30).map(async (addr) => {
          try {
            const token = await exchange.getTokenData(addr);
            if (
              token &&
              token.price > 0 &&
              Number(token.liquidityUsd || 0) >= swingMinLiquidityUsd &&
              Number(token.volume24h || 0) >= swingMinVolume24h &&
              Number(token.listingAgeDays || 0) >= swingMinAgeDays
            ) {
              swingSet.add(token.address || addr);
            }
          } catch (err) {
            logger.debug(`Swing candidate token error on ${chainName}: addr=${addr}, ${err.message}`);
            if (scanStatus[chainName]) {
              scanStatus[chainName].suppressedTokenErrors = (scanStatus[chainName].suppressedTokenErrors || 0) + 1;
              const maxSuppressed = Math.max(1, Number(config.risk?.maxSuppressedTokenErrors || 10));
              if (scanStatus[chainName].suppressedTokenErrors === maxSuppressed) {
                logger.warn(`suppressedTokenErrors threshold reached on ${chainName} this cycle`, {
                  chain: chainName,
                  suppressedTokenErrors: scanStatus[chainName].suppressedTokenErrors,
                  threshold: maxSuppressed,
                });
              }
            }
          }
        }));
      } catch (err) {
        logger.warn(`Swing candidate fallback polling failed on ${chainName}: ${err.message}`);
      }
    }

    return [...swingSet];
  }

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

async function scanChain(chainName, exchange, strategyName = 'momentum', options = {}) {
  const status = getStrategyScanStatus(chainName, strategyName);
  const cycleStats = options.cycleStats || filterStatsState.currentCycle?.[strategyName] || null;

  if (!isExchangeAvailable(chainName)) {
    status.status = 'degraded';
    status.currentToken = 'skipped (exchange unavailable)';
    status.currentPair = '-';
    status.lastUpdate = new Date().toISOString();
    syncChainScanStatus(chainName);
    return;
  }

  logger.info(`Scanning ${exchange.name} for ${strategyName} strategy...`);
  status.status = 'scanning';
  status.currentToken = 'discovering tokens';
  status.currentPair = '-';
  status.tokensScanned = 0;
  status.discoveredTokens = 0;
  status.evaluatedTokens = 0;
  status.laneSummary = null;
  status.lastUpdate = new Date().toISOString();
  scanStatus[chainName].suppressedTokenErrors = 0;
  syncChainScanStatus(chainName);

  // Reset tracked tokens data for this chain before scan
  for (const key of Object.keys(marketState.trackedTokens || {})) {
    if (key.startsWith(`${chainName}:`)) {
      marketState.trackedTokens[key].finalSignal = 'SCANNING';
    }
  }

  try {
    if (chainName === 'kucoin' && typeof exchange.refreshTickers === 'function') {
      await exchange.refreshTickers();
    }

    // Change 2: KuCoin new-listing delta — prepend freshly listed symbols so they are evaluated first.
    const newListings = (chainName === 'kucoin' && typeof exchange.getNewListings === 'function')
      ? await exchange.getNewListings().catch(() => [])
      : [];

    const catalystPriority = (chainName === 'kucoin' && strategyName === 'momentum' && config.risk?.catalystEnabled !== false)
      ? await refreshKucoinCatalystCache(exchange).catch((error) => {
        logger.warn(`KuCoin catalyst refresh failed: ${error.message}`);
        return getPrioritizedKucoinCatalystPairs();
      })
      : [];

    const allTokens = await getTokensForStrategy(chainName, exchange, strategyName, {
      onBscBaseCount: (count) => {
        if (chainName !== 'bsc') return;
        status.discoveredTokens = Number(count || 0);
        status.currentToken = 'ranking bsc core + exploration';
        status.currentPair = '-';
        status.lastUpdate = new Date().toISOString();
        syncChainScanStatus(chainName);
      },
    });
    const candidateTokens = [...new Set([
      ...newListings,
      ...catalystPriority,
      ...allTokens,
    ])];
    status.discoveredTokens = candidateTokens.length;

    if (candidateTokens.length === 0) {
      status.currentToken = `no ${strategyName} candidates`;
      status.currentPair = '-';
      status.lastUpdate = new Date().toISOString();
      syncChainScanStatus(chainName);
      logger.info(`No ${strategyName} candidates on ${chainName}; skipping token evaluation this cycle`);
      recordExchangeSuccess(chainName);
      return;
    }

    if (chainName === 'bsc' && strategyName === 'momentum') {
      status.laneSummary = getBscDiscoveryRankSummary();
      syncChainScanStatus(chainName);
    }

    const scanTokens = getRotatingScanWindow(candidateTokens, chainName, strategyName);

    const batchSize = chainName === 'kucoin'
      ? Math.max(4, Number(config.bot?.kucoinBatchSize || 12))
      : 50;
    const batchDelayMs = chainName === 'kucoin'
      ? Math.max(200, Number(config.bot?.kucoinBatchDelayMs || 700))
      : 500;

    if (chainName === 'kucoin' && strategyName === 'momentum') {
      logger.info(`KuCoin momentum scan window: ${scanTokens.length}/${candidateTokens.length} this cycle (rotating full universe)`);
    }

    for (let i = 0; i < scanTokens.length; i += batchSize) {
      const batch = scanTokens.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (tokenAddress) => {
        status.currentToken = tokenAddress;
        status.currentPair = '-';
        status.tokensScanned += 1;
        status.evaluatedTokens += 1;
        if (cycleStats) {
          cycleStats.evaluated += 1;
        }
        status.lastUpdate = new Date().toISOString();
        syncChainScanStatus(chainName);

        try {
          await processToken(chainName, exchange, tokenAddress, {
            forcedStrategies: [strategyName],
            scanStrategy: strategyName,
          });
        } catch (error) {
          logger.error(`Error processing ${tokenAddress} on ${chainName}/${strategyName}: ${error.message}`);
        }
      }));

      await sleep(batchDelayMs); // Delay between batches (throttled for API safety)
    }
    recordExchangeSuccess(chainName);
  } catch (error) {
    status.status = 'error';
    recordExchangeFailure(chainName, error.message);
    logger.error(`Scan failed on ${chainName}: ${error.message}`);
  } finally {
    status.status = 'idle';
    status.currentToken = '-';
    status.currentPair = '-';
    status.lastUpdate = new Date().toISOString();
    syncChainScanStatus(chainName);
  }
}

async function applyIntelligentModelReview({
  chainName,
  tokenKey,
  tokenData,
  strategyName,
  evaluation,
  exchange,
}) {
  if (!config.ml?.enabled && !config.sentimentEngine?.enabled && !config.hybridAgent?.enabled && !config.rl?.enabled) {
    return null;
  }
  const baseConfidence = Number(evaluation?.details?.confidence || 0);
  const strongMomentum = Number(tokenData?.priceChange24h || 0) >= 3 || Number(evaluation?.details?.volumeSpike || 0) >= 1.2;
  const shouldRun = evaluation?.signal === 'BUY' || baseConfidence >= 60 || strongMomentum;
  if (!shouldRun) {
    return null;
  }

  const localPriceHistory = strategy.priceHistory?.[tokenKey] || [];
  const localVolumeHistory = strategy.volumeHistory?.[tokenKey] || [];
  const sentimentSnapshot = config.sentimentEngine?.enabled !== false
    ? await fetchTokenSentiment({
      symbol: tokenData.symbol,
      chainKey: chainName,
      tokenData,
      logger,
      modelRegistry,
    }).catch((error) => {
      logger.debug(`Sentiment snapshot skipped for ${tokenData.symbol}: ${error.message}`);
      return null;
    })
    : null;

  const featureSnapshot = await buildFeatureSnapshot({
    chainName,
    tokenData,
    strategyName,
    evaluation,
    localPriceHistory,
    localVolumeHistory,
    sentimentSnapshot,
  }).catch((error) => {
    logger.debug(`Feature snapshot skipped for ${tokenData.symbol}: ${error.message}`);
    return null;
  });

  if (featureSnapshot) {
    modelRegistry.recordFeatureSnapshot(featureSnapshot).catch((error) => {
      logger.debug(`Feature snapshot persistence failed for ${tokenData.symbol}: ${error.message}`);
    });
    evaluation.details.modelFeatureCoverage = featureSnapshot.coverage;
    evaluation.details.modelFeatureBars = featureSnapshot.barCount;
    evaluation.details.modelFeatureSource = featureSnapshot.source;
    evaluation.details.featureSnapshot = featureSnapshot.features;
  }

  if (sentimentSnapshot) {
    evaluation.details.sentimentSnapshot = {
      signal: sentimentSnapshot.signal,
      confidence: sentimentSnapshot.confidence,
      aggregateScore: sentimentSnapshot.aggregateScore,
      newsCount: sentimentSnapshot.newsCount,
      redditCount: sentimentSnapshot.redditCount,
    };
  }

  // Order book imbalance — bid/ask depth ratio leads trade-flow data by ~30s.
  // Only available on KuCoin (CEX) for now; DEX would require pool reserves probe.
  if (chainName === 'kucoin' && typeof exchange?.getOrderBookImbalance === 'function') {
    const obSym = tokenData.address || `${String(tokenData.symbol).toUpperCase()}/USDT`;
    const imbalance = await exchange.getOrderBookImbalance(obSym).catch(() => null);
    if (imbalance) {
      evaluation.details.bookImbalance = {
        ratio: Number(imbalance.ratio.toFixed(3)),
        skewPct: Number(imbalance.skewPct.toFixed(2)),
        bidUsd: Math.round(imbalance.bidUsd),
        askUsd: Math.round(imbalance.askUsd),
      };
    }
  }

  // Live regime detection — feeds AI, lessons, rotation scoring
  const liveRegime = localPriceHistory && localPriceHistory.length >= 22
    ? computeRegime(localPriceHistory, localVolumeHistory || [])
    : { label: 'unknown', family: 'unknown', confidence: 0, realizedVol: 0, momentum: 0 };
  if (!evaluation.details.marketRegime) {
    evaluation.details.marketRegime = liveRegime.label;
  }
  evaluation.details.regimeFamily = liveRegime.family;
  evaluation.details.regimeConfidence = liveRegime.confidence;
  if (!Number.isFinite(evaluation.details.realizedVolPct) || evaluation.details.realizedVolPct === 0) {
    evaluation.details.realizedVolPct = liveRegime.realizedVol;
  }

  // Regime-adaptive parameter overlay: in high volatility, loosen RSI band and reduce
  // volume-spike requirement (everything spikes); in low volatility, tighten both.
  // These overrides are applied as advisory hints in evaluation.details — strategies
  // and AI input read them downstream rather than mutating the strategy's base config.
  if (config.risk?.regimeAdaptiveParamsEnabled !== false) {
    const realizedVol = Number(liveRegime.realizedVol || evaluation.details.realizedVolPct || 0);
    let regimeAdjustments = null;
    if (realizedVol >= 5) {
      regimeAdjustments = {
        regime: 'high_vol',
        rsiBuyMinDelta: -5,        // loosen lower bound
        rsiBuyMaxDelta: +5,        // loosen upper bound
        volumeSpikeMultiplierFactor: 0.85, // require less spike
        confidenceFloorDelta: +5,  // be stricter on AI confidence
      };
    } else if (realizedVol >= 2) {
      regimeAdjustments = {
        regime: 'medium_vol',
        rsiBuyMinDelta: 0,
        rsiBuyMaxDelta: 0,
        volumeSpikeMultiplierFactor: 1.0,
        confidenceFloorDelta: 0,
      };
    } else if (realizedVol > 0) {
      regimeAdjustments = {
        regime: 'low_vol',
        rsiBuyMinDelta: +3,        // tighten lower bound
        rsiBuyMaxDelta: -3,        // tighten upper bound
        volumeSpikeMultiplierFactor: 1.15, // require more spike
        confidenceFloorDelta: -3,  // looser on AI confidence (rare opps)
      };
    }
    if (regimeAdjustments) {
      evaluation.details.regimeAdaptiveAdjustments = regimeAdjustments;
    }
  }

  const hybridDecision = featureSnapshot && config.hybridAgent?.enabled !== false
    ? await runHybridDecision({
      registry: modelRegistry,
      rlPolicyManager,
      logger,
      tokenData,
      strategyName,
      evaluation,
      featureSnapshot,
      sentimentSnapshot,
    }).catch((error) => {
      logger.debug(`Hybrid decision skipped for ${tokenData.symbol}: ${error.message}`);
      return null;
    })
    : null;

  if (hybridDecision) {
    evaluation.details.hybridDecision = {
      taskClass: hybridDecision.taskClass,
      regimeFamily: hybridDecision.regimeFamily,
      finalSignal: hybridDecision.finalSignal,
      confidence: hybridDecision.confidence,
      aggregateScore: hybridDecision.aggregateScore,
      route: hybridDecision.route,
    };
    evaluation.details.mlPredictions = hybridDecision.predictions || [];

    if (
      config.hybridAgent?.allowDirectEntryFromHybrid !== false
      && evaluation.signal !== 'BUY'
      && hybridDecision.finalSignal === 'BUY'
      && Number(hybridDecision.confidence || 0) >= Number(config.hybridAgent?.minConfidence || 0.28)
      && Number(hybridDecision.aggregateScore || 0) >= Number(config.ml?.directBuyThreshold || 0.68)
    ) {
      evaluation.signal = 'BUY';
      evaluation.details.hybridPromotedSignal = true;
      evaluation.details.hybridReason = 'hybrid_direct_entry';
    }

    if (
      config.hybridAgent?.allowVetoFromHybrid !== false
      && evaluation.signal === 'BUY'
      && hybridDecision.finalSignal !== 'BUY'
      && Number(hybridDecision.aggregateScore || 0) <= Number(config.ml?.vetoThreshold || 0.42)
    ) {
      evaluation.signal = 'HOLD';
      evaluation.details.hybridVetoedSignal = true;
      evaluation.details.hybridReason = 'hybrid_veto';
      evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'hybrid_veto'])];
    }

    // AI-primary mode: if AI confidence is very high, override technical blocks
    const aiPrimaryEnabled = process.env.AI_PRIMARY_MODE === 'true' || config.execution?.aiPrimaryDecisionEnabled === true;
    const aiConfidence = Number(hybridDecision?.confidence || evaluation.details?.aiConfidence || 0);
    const aiPrimaryThreshold = Number(config.execution?.aiPrimaryConfidenceThreshold || 0.80);

    if (
      aiPrimaryEnabled
      && evaluation.signal === 'HOLD'
      && hybridDecision?.finalSignal === 'BUY'
      && aiConfidence >= aiPrimaryThreshold
    ) {
      evaluation.signal = 'BUY';
      evaluation.details.aiPrimaryOverride = true;
      evaluation.details.aiPrimaryReason = `AI confidence ${(aiConfidence * 100).toFixed(0)}% >= ${(aiPrimaryThreshold * 100).toFixed(0)}% threshold`;
      logger.info(`[AI-Primary] Override to BUY for ${tokenData.symbol}: ${evaluation.details.aiPrimaryReason}`);
    }
  }

  return {
    sentimentSnapshot,
    featureSnapshot,
    hybridDecision,
  };
}

async function processToken(chainName, exchange, tokenAddress, options = {}) {
  const tokenDataFetchTimeoutMs = Math.max(1000, Number(config.risk?.tokenDataFetchTimeoutMs || 5000));
  const tokenData = await withTimeout(
    exchange.getTokenData(tokenAddress),
    tokenDataFetchTimeoutMs,
    `Token data fetch timed out for ${chainName}:${tokenAddress}`
  ).catch((error) => {
    logger.debug(`Token data fetch skipped for ${chainName}:${tokenAddress}: ${error.message}`);
    return null;
  });
  if (!tokenData || !tokenData.price) {
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
    updateTrackedToken(chainName, tokenData, {
      strategy: strategyName,
      technicalSignal: 'INSUFFICIENT DATA',
      finalSignal: 'INSUFFICIENT DATA',
      signalSource: 'eligibility',
      aiReason: reason,
      aiConfidence: 0,
      riskFlags: reason ? [reason] : [],
      details: {},
    }, { recordSignal: false });
  };

  const scanStrategy = String(options.scanStrategy || '').toLowerCase();
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
  const strategyOrder = ['swing', 'momentum'];
  const forced = Array.isArray(options.forcedStrategies) ? options.forcedStrategies : null;
  const applicableStrategies = strategyOrder
    .filter((name) => applicability[name])
    .filter((name) => !forced || forced.includes(name));
  if (!applicableStrategies.length) {
    trackInsufficient('strategy_not_applicable');
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
    tokenData._macroSizeMultiplier = Number(evaluation.details.macroSizeMultiplier || 1);

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

function scoreMomentumCandidate(tokenData = {}, technicalDetails = {}) {
  const metrics = buildMomentumMetrics(tokenData, technicalDetails);
  const trackedKey = `${normalizeChainKey(tokenData?.chainKey || tokenData?.chain)}:${String(tokenData?.address || '').toLowerCase()}`;
  const tracked = marketState.trackedTokens?.[trackedKey] || null;
  const momentumState = tracked?.momentumState || buildMomentumState(null, metrics);
  const priceChange24h = Math.abs(Number(metrics.priceChange24h || 0));
  const buyRatioRecentPct = Number(metrics.buyRatioRecentPct || 0);
  const volumeSpike = normalizeRotationVolumeSpike(metrics.volumeSpike || 0);
  const confidence = normalizeConfidencePercent(metrics.confidence || 0);
  const netBuyFlowUsd10m = Number(metrics.netBuyFlowUsd10m || 0);
  let score =
    (priceChange24h * 0.8)
    + (Math.max(0, buyRatioRecentPct - 50) * 1.1)
    + (Math.max(0, volumeSpike) * 6)
    + (Math.log10(Math.max(1, netBuyFlowUsd10m + 1)) * 5)
    + (confidence * 0.2);
  score += Math.max(0, Number(momentumState.accelerationScore || 0)) * 1.2;
  score += Math.max(0, Number(momentumState.consecutiveStrongScans || 0) - 1) * 6;
  // Age penalty: stale flat positions score lower, making them easier rotation targets
  const posOpenedAtMs = Date.parse(position.openedAt || '') || 0;
  const posHoursHeld = posOpenedAtMs > 0 ? (Date.now() - posOpenedAtMs) / 3_600_000 : 0;
  if (posHoursHeld > 4 && pnlPct <= 0) {
    score -= Math.min(20, (posHoursHeld - 4) * 1.5);
  }
  if (priceChange24h >= Number(config.execution?.momentumRotationExtendedMovePct || 30)
    && Number(momentumState.deltaVolumeSpike || 0) <= 0
    && Number(momentumState.deltaBuyRatioRecentPct || 0) <= 0) {
    score -= 12;
  }
  return Number.isFinite(score) ? score : 0;
}

function scoreOpenMomentumPosition(position = {}, currentTokenData = null) {
  const trackedKey = `${normalizeChainKey(position.chainKey || position.chain)}:${String(position.address || '').toLowerCase()}`;
  const tracked = marketState.trackedTokens?.[trackedKey] || {};
  const liveMetrics = currentTokenData ? buildMomentumMetrics(currentTokenData, tracked?.indicators || {}) : null;
  const currentPrice = Number(position.currentPrice || tracked.price || position.entryPrice || 0);
  const entryPrice = Number(position.entryPrice || 0);
  const pnlPct = entryPrice > 0 && currentPrice > 0
    ? ((currentPrice - entryPrice) / entryPrice) * 100
    : 0;
  const priceChange24h = Math.abs(Number(liveMetrics?.priceChange24h ?? tracked.priceChange24h ?? 0));
  const confidence = normalizeConfidencePercent(liveMetrics?.confidence ?? tracked?.indicators?.confidence ?? 0);
  const volumeSpike = normalizeRotationVolumeSpike(liveMetrics?.volumeSpike ?? tracked?.indicators?.volumeSpike ?? 0);
  const momentumState = liveMetrics ? buildMomentumState(tracked, liveMetrics) : (tracked?.momentumState || {});
  const accelerationScore = Number(momentumState.accelerationScore || 0);
  const consecutiveStrongScans = Number(momentumState.consecutiveStrongScans || 0);
  const weakening = accelerationScore < 0
    && (
      Number(momentumState.deltaVolumeSpike || 0) < 0
      || Number(momentumState.deltaBuyRatioRecentPct || 0) < 0
      || Number(momentumState.deltaNetBuyFlowUsd10m || 0) < 0
    );
  const healthyPnlPct = Number(config.execution?.momentumRotationHealthyPnlPct || 2);
  const healthy = pnlPct >= healthyPnlPct && accelerationScore >= 0 && consecutiveStrongScans >= 2;
  const score = (priceChange24h * 0.75)
    + (pnlPct * 0.4)
    + (confidence * 0.2)
    + (Math.max(0, volumeSpike) * 5)
    + (Math.max(-10, accelerationScore) * 0.8)
    + (Math.max(0, consecutiveStrongScans - 1) * 4);
  return {
    score: Number.isFinite(score) ? score : 0,
    pnlPct: Number.isFinite(pnlPct) ? pnlPct : 0,
    weakening,
    healthy,
    accelerationScore,
    consecutiveStrongScans,
    components: {
      priceChange24h: round(priceChange24h, 2),
      pnlPct: round(pnlPct, 2),
      confidence: round(confidence, 2),
      volumeSpike: round(volumeSpike, 3),
      accelerationScore: round(accelerationScore, 2),
      consecutiveStrongScans,
    },
  };
}

async function tryRotateForStrongerMomentum(candidateTokenData, strategyName, evaluationDetails = {}, options = {}) {
  if (String(strategyName || '').toLowerCase() !== 'momentum') {
    return { rotated: false, reason: 'rotation only supported for momentum strategy' };
  }

  const blockCode = String(options.blockCode || '').toLowerCase();
  const sameChainOnly = Boolean(options.sameChainOnly);
  if (blockCode === 'portfolio_heat' && config.execution?.heatAwareMomentumRotationEnabled === false) {
    return {
      rotated: false,
      reason: 'candidate stronger but heat-rotation disabled',
      context: {
        blockCode,
        sameChainOnly: true,
      },
    };
  }

  const openStrategyPositions = Object.values(portfolio.positions || {}).filter(
    (position) => String(position?.strategy || 'momentum').toLowerCase() === 'momentum'
  );
  if (!openStrategyPositions.length) {
    return { rotated: false, reason: 'no momentum positions available for rotation' };
  }

  const candidateKey = `${normalizeChainKey(candidateTokenData?.chainKey || candidateTokenData?.chain)}:${String(candidateTokenData?.address || '').toLowerCase()}`;
  const candidateTracked = marketState.trackedTokens?.[candidateKey] || null;
  const candidateMomentumState = candidateTracked?.momentumState || buildMomentumState(null, buildMomentumMetrics(candidateTokenData, evaluationDetails));
  const candidateScore = scoreMomentumCandidate(candidateTokenData, evaluationDetails);
  const minScoreEdge = Math.max(1, Number(config.execution?.momentumRotationMinScoreEdge || 12));
  const maxRotationLossPct = Math.abs(Number(config.execution?.momentumRotationMaxLossPct || 4));
  const requiredPersistenceScans = Math.max(2, Number(config.execution?.momentumRotationPersistenceScans || 2));
  const minAccelerationScore = Number(config.execution?.momentumRotationMinAccelerationScore || 2);

  const rankedCandidates = openStrategyPositions
    .filter((position) => {
      if (!sameChainOnly) return true;
      return normalizeChainKey(position.chainKey || position.chain) === normalizeChainKey(candidateTokenData?.chainKey || candidateTokenData?.chain);
    });
  const ranked = (await Promise.all(rankedCandidates.map(async (position) => {
      const positionChain = normalizeChainKey(position.chainKey || position.chain);
      const positionExchange = exchanges[positionChain];
      let freshTokenData = null;
      if (positionExchange) {
        freshTokenData = await withTimeout(
          positionExchange.getTokenData(position.address),
          Math.max(1500, Number(config.risk?.tokenDataFetchTimeoutMs || 5000)),
          `Rotation score data fetch timed out for ${position.symbol || position.address}`
        ).catch(() => null);
      }
      if (freshTokenData?.price) {
        freshTokenData.address = freshTokenData.address || position.address;
        freshTokenData.chainKey = positionChain;
        freshTokenData.chain = CHAIN_LABELS[positionChain];
        refreshTrackedOpenPositionSnapshot(positionChain, freshTokenData, position);
      }
      const scored = scoreOpenMomentumPosition(position, freshTokenData);
      return {
        position,
        score: scored.score,
        pnlPct: scored.pnlPct,
        weakening: scored.weakening,
        healthy: scored.healthy,
        accelerationScore: scored.accelerationScore,
        consecutiveStrongScans: scored.consecutiveStrongScans,
        components: scored.components,
      };
    })))
    .filter((entry) => entry.pnlPct >= -maxRotationLossPct)
    .sort((a, b) => {
      if (a.pnlPct !== b.pnlPct) return a.pnlPct - b.pnlPct;
      return a.score - b.score;
    });

  const weakest = ranked[0];
  if (!weakest) {
    return {
      rotated: false,
      reason: sameChainOnly
        ? 'candidate stronger but no same-chain position eligible for heat rotation'
        : 'no eligible momentum position available for rotation',
      context: {
        candidateScore: round(candidateScore, 2),
        candidateAccelerationScore: candidateMomentumState.accelerationScore,
        candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
      },
    };
  }

  if (candidateScore < (weakest.score + minScoreEdge)) {
    return {
      rotated: false,
      reason: `candidate not stronger enough than weakest position (${candidateScore.toFixed(1)} vs ${(weakest.score + minScoreEdge).toFixed(1)} required)`,
      context: {
        candidateScore: round(candidateScore, 2),
        weakestScore: round(weakest.score, 2),
        weakestPnlPct: round(weakest.pnlPct, 2),
        weakestSymbol: weakest.position?.symbol || weakest.position?.address || null,
        weakestComponents: weakest.components || null,
        candidateComponents: {
          priceChange24h: round(Math.abs(Number(candidateTokenData?.priceChange24h || 0)), 2),
          confidence: round(normalizeConfidencePercent(evaluationDetails?.confidence ?? candidateTokenData?.confidence ?? 0), 2),
          volumeSpike: round(normalizeRotationVolumeSpike(evaluationDetails?.volumeSpike ?? candidateTokenData?.volumeSpike ?? 0), 3),
          accelerationScore: round(Number(candidateMomentumState.accelerationScore || 0), 2),
          consecutiveStrongScans: Number(candidateMomentumState.consecutiveStrongScans || 0),
        },
      },
    };
  }

  if (Number(candidateMomentumState.accelerationScore || 0) < minAccelerationScore) {
    return {
      rotated: false,
      reason: `candidate stronger but acceleration still weak (${Number(candidateMomentumState.accelerationScore || 0).toFixed(1)})`,
      context: {
        candidateScore: round(candidateScore, 2),
        candidateAccelerationScore: candidateMomentumState.accelerationScore,
        candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
        weakestScore: round(weakest.score, 2),
      },
    };
  }

  if (Number(candidateMomentumState.consecutiveStrongScans || 0) < requiredPersistenceScans) {
    return {
      rotated: false,
      reason: `candidate stronger but not persistent yet (${Number(candidateMomentumState.consecutiveStrongScans || 0)}/${requiredPersistenceScans} strong scans)`,
      context: {
        candidateScore: round(candidateScore, 2),
        candidateAccelerationScore: candidateMomentumState.accelerationScore,
        candidateConsecutiveStrongScans: candidateMomentumState.consecutiveStrongScans,
        weakestScore: round(weakest.score, 2),
      },
    };
  }

  const weakestOpenedAtMs = Date.parse(weakest.position.openedAt || '') || 0;
  const weakestHoursHeld = weakestOpenedAtMs > 0 ? (Date.now() - weakestOpenedAtMs) / 3_600_000 : 0;
  const weakestIsStale = weakestHoursHeld >= 4 && weakest.pnlPct <= 0;
  if ((!weakest.weakening || weakest.healthy) && !weakestIsStale) {
    return {
      rotated: false,
      reason: 'candidate stronger but weakest current position still healthy',
      context: {
        candidateScore: round(candidateScore, 2),
        weakestScore: round(weakest.score, 2),
        weakestPnlPct: round(weakest.pnlPct, 2),
        weakestAccelerationScore: round(weakest.accelerationScore, 2),
        weakestConsecutiveStrongScans: weakest.consecutiveStrongScans,
      },
    };
  }

  const weakestChain = normalizeChainKey(weakest.position.chainKey || weakest.position.chain);
  const weakestExchange = exchanges[weakestChain];
  if (!weakestExchange) {
    return { rotated: false, reason: 'rotation venue unavailable for weakest position' };
  }

  const exitTokenData = await withTimeout(
    weakestExchange.getTokenData(weakest.position.address),
    Math.max(1500, Number(config.risk?.tokenDataFetchTimeoutMs || 5000)),
    `Rotation sell data fetch timed out for ${weakest.position.symbol || weakest.position.address}`
  ).catch(() => null);

  const fallbackExitToken = {
    symbol: weakest.position.symbol,
    address: weakest.position.address,
    chainKey: weakestChain,
    chain: CHAIN_LABELS[weakestChain],
    price: Number(weakest.position.currentPrice || weakest.position.entryPrice || 0),
  };

  try {
    logger.info(
      `Momentum rotation: replacing ${weakest.position.symbol || weakest.position.address} ` +
      `(score=${weakest.score.toFixed(1)}, pnl=${weakest.pnlPct.toFixed(2)}%) with ` +
      `${candidateTokenData.symbol} (score=${candidateScore.toFixed(1)})`
    );
    await executeSell(
      weakestChain,
      weakestExchange,
      exitTokenData || fallbackExitToken,
      weakest.position,
      1,
      'ROTATE_STRONGER_MOMENTUM'
    );
    return {
      rotated: true,
      reason: 'rotated into stronger momentum candidate',
      context: {
        candidateScore: round(candidateScore, 2),
        weakestScore: round(weakest.score, 2),
        weakestPnlPct: round(weakest.pnlPct, 2),
      },
    };
  } catch (error) {
    logger.warn(`Momentum rotation failed: ${error.message}`);
    return {
      rotated: false,
      reason: `rotation attempt failed: ${error.message}`,
      context: {
        candidateScore: round(candidateScore, 2),
        weakestScore: round(weakest.score, 2),
      },
    };
  }
}

async function checkExitConditions(chainName, exchange, tokenData, position, options = {}) {
  if (portfolio.safeMode) {
    logger.warn('Exit checks suspended in safe mode', {
      chain: chainName,
      symbol: tokenData?.symbol,
      address: tokenData?.address,
    });
    return;
  }

  const staleData = Boolean(options.staleData);
  const currentProfit = (tokenData.price - position.entryPrice) / position.entryPrice;
  const strategyName = position.strategy || 'momentum';
  const strategySellTiersRaw = config.strategies?.[strategyName]?.sellTiers || config.strategy?.sellTiers;
  const strategySellTiers = Array.isArray(strategySellTiersRaw) ? strategySellTiersRaw : [];
  const strategyCfg = config.strategies?.[strategyName] || {};

  const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
  const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
  applyTrailingStopState(position, tokenData.price, trailingStartMultiplier, trailingStopPct);

  // With stale data only evaluate stop-loss and trailing-stop; skip strategy exit and take-profit tiers.
  let exitSignal = null;
  if (!staleData) {
    try {
      exitSignal = strategy.evaluateExitForStrategy(
        position.strategyKey || buildTokenKey(chainName, tokenData.address),
        strategyName,
        tokenData,
        position
      );
      if (exitSignal?.shouldExit) {
        logger.info(`STRATEGY EXIT triggered for ${tokenData.symbol} [${strategyName}]: ${exitSignal.reason}`);
        await executeSell(chainName, exchange, tokenData, position, 1, exitSignal.reason);
        return;
      }
    } catch (error) {
      logger.warn(`Strategy exit evaluation failed for ${tokenData.symbol} [${strategyName}]: ${error.message}`);
    }
  }

  if (position.trailingStop && tokenData.price <= position.trailingStop) {
    if (shouldDelayBorderlineStop(position, tokenData.price, position.trailingStop, 'TRAILING_STOP')) {
      return;
    }
    logger.info(`TRAILING STOP triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'TRAILING_STOP');
    return;
  }

  if (tokenData.price <= position.stopLoss) {
    if (shouldDelayBorderlineStop(position, tokenData.price, position.stopLoss, 'STOP_LOSS')) {
      return;
    }
    logger.info(`STOP LOSS triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'STOP_LOSS');
    return;
  }

  const openedAtMs = Date.parse(position.openedAt || position.createdAt || '') || Date.now();
  const minutesInTrade = Math.max(0, (Date.now() - openedAtMs) / 60000);
  const maxHoldMinutes = Number(strategyCfg.maxHoldMinutes || config.risk?.maxHoldMinutesGlobal || 4320);
  position.holdExtensionsUsed = Math.max(0, Number(position.holdExtensionsUsed || 0));
  const holdDeadlineMs = Date.parse(position.holdUntilAt || '') || (openedAtMs + (maxHoldMinutes * 60000));
  if (Number.isFinite(maxHoldMinutes) && maxHoldMinutes > 0 && Date.now() >= holdDeadlineMs) {
    const holdExtensionDecision = shouldExtendMaxHold(position, tokenData, exitSignal, strategyCfg, currentProfit);
    if (!staleData && holdExtensionDecision.extend) {
      position.holdExtensionsUsed += 1;
      position.holdUntilAt = holdExtensionDecision.nextDeadlineAt;
      logger.info(
        `MAX HOLD EXTENDED for ${tokenData.symbol}: extension ${position.holdExtensionsUsed}/${Number(strategyCfg.maxHoldExtensions || 0)} ` +
        `for ${holdExtensionDecision.extensionMinutes}m (${holdExtensionDecision.reason})`
      );
      return;
    }
    logger.info(
      `TIME STOP triggered for ${tokenData.symbol}: held ${minutesInTrade.toFixed(0)}m ` +
      `>= ${maxHoldMinutes}m, extensions=${position.holdExtensionsUsed}, reason=${holdExtensionDecision.reason}`
    );
    await executeSell(chainName, exchange, tokenData, position, 1, 'TIME_STOP');
    return;
  }

  // 4-hour minimum hold: if held >= minHoldHours with no profit, exit
  const minHoldHours = Number(strategyCfg.minHoldHours ?? 4);
  const hoursInTrade = minutesInTrade / 60;
  if (hoursInTrade >= minHoldHours && currentProfit <= 0) {
    logger.info(
      `MIN_HOLD_NO_GAIN exit for ${tokenData.symbol} [${strategyName}]: ` +
      `held ${hoursInTrade.toFixed(1)}h, pnl ${(currentProfit * 100).toFixed(2)}%`
    );
    await executeSell(chainName, exchange, tokenData, position, 1, 'MIN_HOLD_NO_GAIN');
    return;
  }

  // Graduated stale-drift exit: positions that are slightly profitable but going
  // nowhere lock up capital indefinitely. Force them out so capital can rotate.
  // Tiers (configurable):
  //   12h+ held with <1% gain   -> exit (totally flat)
  //   24h+ held with <3% gain   -> exit (anemic momentum)
  //   48h+ held with <8% gain   -> exit (capital trapped, opportunity cost)
  const staleDriftEnabled = config.risk?.staleDriftExitEnabled !== false;
  if (staleDriftEnabled && currentProfit > 0) {
    const tier1Hours = Number(config.risk?.staleDriftTier1Hours || 12);
    const tier1MinProfit = Number(config.risk?.staleDriftTier1MinProfitPct || 1) / 100;
    const tier2Hours = Number(config.risk?.staleDriftTier2Hours || 24);
    const tier2MinProfit = Number(config.risk?.staleDriftTier2MinProfitPct || 3) / 100;
    const tier3Hours = Number(config.risk?.staleDriftTier3Hours || 48);
    const tier3MinProfit = Number(config.risk?.staleDriftTier3MinProfitPct || 8) / 100;
    let triggered = null;
    if (hoursInTrade >= tier3Hours && currentProfit < tier3MinProfit) {
      triggered = `${tier3Hours}h with only ${(currentProfit * 100).toFixed(2)}% < ${(tier3MinProfit * 100).toFixed(0)}%`;
    } else if (hoursInTrade >= tier2Hours && currentProfit < tier2MinProfit) {
      triggered = `${tier2Hours}h with only ${(currentProfit * 100).toFixed(2)}% < ${(tier2MinProfit * 100).toFixed(0)}%`;
    } else if (hoursInTrade >= tier1Hours && currentProfit < tier1MinProfit) {
      triggered = `${tier1Hours}h with only ${(currentProfit * 100).toFixed(2)}% < ${(tier1MinProfit * 100).toFixed(0)}%`;
    }
    if (triggered) {
      logger.info(
        `STALE_DRIFT exit for ${tokenData.symbol} [${strategyName}]: ${triggered} ` +
        `(held ${hoursInTrade.toFixed(1)}h)`
      );
      await executeSell(chainName, exchange, tokenData, position, 1, 'STALE_DRIFT');
      return;
    }
  }

  if (staleData) {
    return;
  }

  position.triggeredSellTiers = position.triggeredSellTiers || {};
  position.tierDelayedAt = position.tierDelayedAt || {};

  const adaptiveTierExit = Boolean(strategyCfg.adaptiveTierExit ?? true);
  const tierDelayRsiMin = Number(strategyCfg.tierDelayRsiMin || 70);
  const tierAccelSellRatioPct = Number(strategyCfg.tierAccelSellRatioPct || 60);
  const tierLocalHighReversalPct = Number(strategyCfg.tierLocalHighReversalPct || 5);
  const tierExitRsiValue = Number(exitSignal?.details?.rsiValue ?? NaN);
  const tierSellRatioPct = Number(exitSignal?.details?.sellRatio10mPct ?? 0);

  position.tierLocalHigh = Math.max(Number(position.tierLocalHigh || tokenData.price), Number(tokenData.price));
  const localHigh = Number(position.tierLocalHigh || tokenData.price);
  const reversalFromHighPct = localHigh > 0 ? ((localHigh - tokenData.price) / localHigh) * 100 : 0;

  for (let tierIndex = 0; tierIndex < strategySellTiers.length; tierIndex += 1) {
    const tier = strategySellTiers[tierIndex];
    if (position.triggeredSellTiers[tierIndex]) {
      continue;
    }

    if (currentProfit >= tier.profitMultiplier - 1) {
      if (adaptiveTierExit) {
        if (tierSellRatioPct > tierAccelSellRatioPct) {
          for (let i = tierIndex; i < strategySellTiers.length; i += 1) {
            position.triggeredSellTiers[i] = true;
          }
          delete position.tierDelayedAt[tierIndex];
          logger.info(`SELL TIER ${tierIndex + 1} ACCELERATED for ${tokenData.symbol}: sell pressure ${tierSellRatioPct.toFixed(1)}% -> full exit`);
          await executeSell(chainName, exchange, tokenData, position, 1, `SELL_TIER_ACCEL_${tierIndex + 1}`);
          return;
        }

        if (reversalFromHighPct >= tierLocalHighReversalPct) {
          for (let i = tierIndex; i < strategySellTiers.length; i += 1) {
            position.triggeredSellTiers[i] = true;
          }
          delete position.tierDelayedAt[tierIndex];
          logger.info(`SELL TIER ${tierIndex + 1} ACCELERATED for ${tokenData.symbol}: reversal ${reversalFromHighPct.toFixed(1)}% -> full exit`);
          await executeSell(chainName, exchange, tokenData, position, 1, `SELL_TIER_REVERSAL_${tierIndex + 1}`);
          return;
        }

        const alreadyDelayed = Boolean(position.tierDelayedAt[tierIndex]);
        if (!alreadyDelayed && Number.isFinite(tierExitRsiValue) && tierExitRsiValue > tierDelayRsiMin && tierSellRatioPct <= tierAccelSellRatioPct) {
          position.tierDelayedAt[tierIndex] = Date.now();
          logger.info(`SELL TIER ${tierIndex + 1} DELAYED for ${tokenData.symbol}: RSI ${tierExitRsiValue.toFixed(0)} > ${tierDelayRsiMin}`);
          return;
        }
      }

      delete position.tierDelayedAt[tierIndex];
      position.triggeredSellTiers[tierIndex] = true;
      logger.info(`SELL TIER ${tierIndex + 1} triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}% -> selling ${(tier.sellPct * 100).toFixed(0)}%`);
      await executeSell(chainName, exchange, tokenData, position, tier.sellPct, `SELL_TIER_${tierIndex + 1}`);
      return;
    }
  }

  // Orphaned-tiers guard: all tiers triggered but no sells recorded → force full exit
  const allTiersTriggered = strategySellTiers.length > 0 && strategySellTiers.every((_, i) => position.triggeredSellTiers[i]);
  const noSellsRecorded = Object.keys(position.realizedPnlByTier || {}).length === 0;
  if (allTiersTriggered && noSellsRecorded && !position.exitInProgress) {
    logger.warn(`[Exit] ORPHANED TIERS for ${tokenData.symbol}: all ${strategySellTiers.length} tiers triggered but no sells recorded — forcing full exit at ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'ORPHANED_TIERS_EXIT');
    return;
  }

  if (tokenData.price >= position.takeProfit) {
    logger.info(`TAKE PROFIT triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'TAKE_PROFIT');
  }
}

function applyTrailingStopState(position, currentPrice, trailingStartMultiplier, trailingStopPct) {
  const price = Number(currentPrice || 0);
  const entryPrice = Number(position?.entryPrice || 0);
  const activation = Number(trailingStartMultiplier || 0);
  const stopPct = Number(trailingStopPct || 0);

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return;
  }
  if (!Number.isFinite(activation) || activation <= 0 || !Number.isFinite(stopPct) || stopPct <= 0) {
    return;
  }
  if (price < entryPrice * activation) {
    return;
  }

  const prevHighest = Number(position.highestPrice || 0);
  const nextHighest = Math.max(prevHighest, price);
  const computedStop = nextHighest * (1 - stopPct / 100);
  const prevStop = Number(position.trailingStop || 0);
  const nextStop = Math.max(prevStop, computedStop);

  position.highestPrice = nextHighest;
  position.trailingStop = nextStop;
}

function shouldExtendMaxHold(position, tokenData, exitSignal, strategyCfg, currentProfit) {
  const details = exitSignal?.details || {};
  const extensionEnabled = strategyCfg.extendMaxHoldOnTrend !== false;
  const maxExtensions = Math.max(0, Number(strategyCfg.maxHoldExtensions || 0));
  const extensionMinutes = Math.max(0, Number(strategyCfg.holdExtensionMinutes || 0));
  const extensionsUsed = Math.max(0, Number(position.holdExtensionsUsed || 0));
  const minProfitPct = Number(strategyCfg.holdExtensionMinProfitPct || 0);
  const currentProfitPct = Number.isFinite(currentProfit) ? currentProfit * 100 : 0;
  const fast = Number(details.fast);
  const slow = Number(details.slow);
  const rsiValue = Number(details.rsiValue);
  const sellRatioPct = Number(details.sellRatio10mPct ?? 0);
  const liquidityDropPct = Number(details.liquidityDropPct ?? 0);
  const holderJumpPct = Number(details.holderJumpPct ?? 0);
  const maxSellRatioPct = Number(strategyCfg.maxSellRatioPct10m || 60);
  const maxLiquidityDropPct = Number(strategyCfg.liquidityDropExitPct || (position.strategy === 'swing' ? 30 : 20));
  const maxHolderJumpPct = Number(strategyCfg.holderConcentrationJumpPct || (position.strategy === 'swing' ? 8 : 6));
  const minTrendRsi = position.strategy === 'swing' ? 52 : 50;

  if (!extensionEnabled || extensionMinutes <= 0 || maxExtensions <= 0) return { extend: false, reason: 'extension_disabled' };
  if (extensionsUsed >= maxExtensions) return { extend: false, reason: 'extension_budget_exhausted' };
  if (!Number.isFinite(currentProfitPct) || currentProfitPct < minProfitPct) return { extend: false, reason: 'profit_below_extension_floor' };
  if (exitSignal?.shouldExit) return { extend: false, reason: 'strategy_exit_active' };
  if (details.emaCrossDown) return { extend: false, reason: 'ema_crossdown' };
  if (Number.isFinite(fast) && Number.isFinite(slow) && fast < slow) return { extend: false, reason: 'trend_below_slow_ema' };
  if (Number.isFinite(rsiValue) && rsiValue < minTrendRsi) return { extend: false, reason: 'rsi_too_weak' };
  if (sellRatioPct > maxSellRatioPct) return { extend: false, reason: 'sell_pressure_too_high' };
  if (liquidityDropPct >= maxLiquidityDropPct) return { extend: false, reason: 'liquidity_deteriorating' };
  if (holderJumpPct >= maxHolderJumpPct) return { extend: false, reason: 'holder_concentration_worsening' };
  if (position.trailingStop && Number(tokenData?.price || 0) <= Number(position.trailingStop || 0)) return { extend: false, reason: 'at_trailing_stop' };

  return {
    extend: true,
    reason: 'trend_still_healthy',
    extensionMinutes,
    nextDeadlineAt: new Date(Date.now() + (extensionMinutes * 60000)).toISOString(),
  };
}

async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum') {
  // Live bot: KuCoin only
  if (!config.paperTrading && chainName !== 'kucoin') {
    logger.info(`Buy blocked: live bot restricted to KuCoin, ${chainName} not allowed`);
    return;
  }

  // Smaller-iterations sizing: start small, scale up on wins
  const useSmallIterations = process.env.USE_POSITION_ITERATIONS !== 'false';
  const calculatedSizeUsd = useSmallIterations
    ? positionSizingEngine.calculateSmallIterationSize(tokenData, portfolio, strategyName)
    : risk.positionSize(tokenData, strategyName);

  if (calculatedSizeUsd < 6) {
    logger.warn(`Position size $${calculatedSizeUsd.toFixed(2)} too small, skipping`);
    return;
  }

  // Anti-pattern evasion: apply position size jitter (±15%) to avoid bot fingerprinting
  const sizeUsd = applyPositionJitter(calculatedSizeUsd, 15);

  // Cross-process coordination:
  // - Distributed lock prevents live+paper (or two processes) from entering the same token simultaneously.
  // - Local mutex prevents re-entrancy within a single process.
  const lockTtlMs = Math.max(5000, Number(process.env.SQL_LOCK_TTL_MS || 30000));
  const lockKey = `buy:${String(chainName || '').toLowerCase()}:${String(tokenData?.symbol || tokenData?.address || '').toUpperCase()}`.slice(0, 200);
  const dist = await sqlCoordination.acquireLock(lockKey, { ttlMs: lockTtlMs, waitMs: 0 });
  if (!dist.ok) {
    logger.debug(`Distributed lock busy (${lockKey}), skipping buy for ${tokenData.symbol}`);
    return;
  }

  const orderId = telemetryUuid();
  const decisionContext = tokenData._decisionTelemetry || null;
  const executionDecisionId = telemetryUuid();
  telemetry.logOrder({
    order_id: orderId,
    ts: new Date().toISOString(),
    chain: tokenData.chain,
    chain_key: chainName,
    symbol: tokenData.symbol,
    address: tokenData.address,
    side: 'BUY',
    strategy: strategyName,
    requested_quote_usd: sizeUsd,
    expected_price: Number(tokenData.price || 0),
    status: 'submitted',
    reason: 'ENTRY',
    metadata: {
      discoveryLane: tokenData.discoveryLane || null,
      signalSource: tokenData.signalSource || null,
    },
  });

  const release = await positionMutex.lock();
  try {
    const preflight = executionFlow.runBuyPreflightChecks({
      chainName,
      tokenData,
      strategyName,
    });
    if (!preflight.ok) {
      return;
    }

    logger.info(`Executing BUY: ${tokenData.symbol} @ $${tokenData.price} | size $${sizeUsd.toFixed(2)}`);

    // Anti-pattern evasion: random entry delay (0-3s) to prevent mempool front-running detection
    const entryDelayMs = getRandomEntryDelay(3000);
    if (entryDelayMs > 0) {
      await sleep(entryDelayMs);
    }

    try {
    let txResult;
    const expectedEntryPrice = Number(tokenData.price);
    const execTimeoutMs = Math.max(15000, Number(config.execution?.execTimeoutMs || config.execution?.buyTimeoutMs || 30000));
    txResult = await executeBuyViaVenue({
      chainName,
      exchange,
      tokenData,
      sizeUsd,
      strategyName,
      execTimeoutMs,
      withTimeout,
      shouldSplitSolanaTrade,
      generateSplitTradeSchedule,
      sleep,
      getNativeQuote: async (normalizedChain, currentTokenData) => getNativeQuoteOrThrow(normalizedChain, currentTokenData),
    });

    const finalizeResult = await executionFlow.finalizeBuyExecution({
      chainName,
      exchange,
      tokenData,
      strategyName,
      txResult,
      sizeUsd,
      calculatedSizeUsd,
      entryDelayMs,
      expectedEntryPrice,
      orderId,
      executionDecisionId,
      decisionContext,
    });
    if (finalizeResult?.aborted) {
      return;
    }
  } catch (error) {
    await executionFlow.handleBuyExecutionFailure({
      chainName,
      tokenData,
      strategyName,
      error,
      orderId,
      executionDecisionId,
      decisionContext,
      lockKey,
    });
  }
  } finally {
    delete tokenData._decisionTelemetry;
    release();
    await dist.release();
  }
}

async function finalizeSellExecution({
  chainName,
  tokenData,
  position,
  txResult,
  reason = 'EXIT',
  strategyName = 'momentum',
  expectedExitPrice = 0,
  quantityRequested = 0,
  requestedFraction = 1,
}) {
  ensureStatsShape();
  return executionFlow.finalizeSellExecutionState({
    chainName,
    tokenData,
    position,
    txResult,
    reason,
    strategyName,
    expectedExitPrice,
    quantityRequested,
    requestedFraction,
  });
}

function isAmbiguousSellFailure(errorText = '') {
  return /balance insufficient|\b200004\b|not filled|timed out|timeout/i.test(String(errorText || ''));
}

async function recoverFailedSellExecutionFromExchange({
  chainName,
  exchange,
  tokenData,
  quantityToSell,
  sellStartedAtMs,
  errorText,
}) {
  if (!exchange || typeof exchange.findRecentTradeFill !== 'function') {
    return null;
  }
  if (!isAmbiguousSellFailure(errorText)) {
    return null;
  }

  try {
    const recoveredFill = await exchange.findRecentTradeFill(tokenData.address, 'sell', quantityToSell, {
      sinceMs: Math.max(0, Number(sellStartedAtMs || Date.now()) - 15_000),
      lookbackMs: 5 * 60 * 1000,
      targetTimestampMs: sellStartedAtMs || Date.now(),
    });
    if (!recoveredFill || !Number.isFinite(Number(recoveredFill.filledBaseQty)) || Number(recoveredFill.filledBaseQty) <= 0) {
      return null;
    }
    logger.warn(`Recovered SELL fill from exchange history for ${tokenData.symbol} on ${chainName} after error: ${errorText}`);
    return recoveredFill;
  } catch (recoveryError) {
    logger.warn(`SELL recovery lookup failed for ${tokenData.symbol} on ${chainName}: ${recoveryError.message}`);
    return null;
  }
}

async function executeSell(chainName, exchange, tokenData, position, sellPct = 1, reason = 'EXIT') {
  if (position?.exitInProgress) {
    logger.debug(`SELL skipped for ${tokenData?.symbol || position?.symbol || position?.address}: exit already in progress`);
    return;
  }

  position.exitInProgress = true;
  const strategyName = position.strategy || 'momentum';
  const fraction = Math.max(0.01, Math.min(Number(sellPct || 1), 1));
  const positionQuantityBefore = Number(position.quantity || 0);
  const quantityToSell = positionQuantityBefore * fraction;
  const expectedExitPrice = Number(tokenData.price);
  const sellStartedAtMs = Date.now();

  logger.info(`Executing SELL: ${tokenData.symbol} @ $${tokenData.price} | selling ${round(fraction * 100, 1)}%`);

  try {
    const sellTimeoutMs = Math.max(15000, Number(config.execution?.sellTimeoutMs || config.execution?.buyTimeoutMs || 30000));

    const txResult = await executeSellViaVenue({
      exchange,
      tokenData,
      quantityToSell,
      execTimeoutMs: sellTimeoutMs,
      withTimeout,
    });
    await finalizeSellExecution({
      chainName,
      tokenData,
      position,
      txResult,
      reason,
      strategyName,
      expectedExitPrice,
      quantityRequested: quantityToSell,
      requestedFraction: fraction,
    });
  } catch (error) {
    const errorText = String(error?.message || error || '');
    const recoveredTxResult = await recoverFailedSellExecutionFromExchange({
      chainName,
      exchange,
      tokenData,
      quantityToSell,
      sellStartedAtMs,
      errorText,
    });
    if (recoveredTxResult) {
      await finalizeSellExecution({
        chainName,
        tokenData,
        position,
        txResult: recoveredTxResult,
        reason,
        strategyName,
        expectedExitPrice,
        quantityRequested: quantityToSell,
        requestedFraction: fraction,
      });
      return;
    }

    await executionFlow.handleSellExecutionFailure({
      chainName,
      exchange,
      tokenData,
      position,
      quantityToSell,
      strategyName,
      reason,
      error,
    });
  } finally {
    if (position && typeof position === 'object') {
      position.exitInProgress = false;
    }
  }
}

function getTradePositionKey(trade = {}) {
  return tradeRepairHelpers.getTradePositionKey(trade);
}

function getTradeRepairSignature(trade = {}) {
  return tradeRepairHelpers.getTradeRepairSignature(trade);
}

function patchTradeCopiesBySignature(signature, mutator) {
  return tradeRepairHelpers.patchTradeCopiesBySignature(signature, mutator);
}

function getLotStateBeforeTrade(targetTrade) {
  return tradeRepairHelpers.getLotStateBeforeTrade(targetTrade);
}

function applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd = 0, options = {}) {
  return tradeRepairHelpers.applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd, options);
}

function recoverSellFailureTrade(failedTrade, recoveredTxResult, options = {}) {
  return tradeRepairHelpers.recoverSellFailureTrade(failedTrade, recoveredTxResult, options);
}

async function repairAmbiguousKucoinSellFailures(options = {}) {
  return tradeRepairHelpers.repairAmbiguousKucoinSellFailures(options);
}

function resetPaperPortfolio(balance) {
  const nextBalance = Number(balance || config.paperBalance || 10000);

  portfolio.startingBalance = nextBalance;
  portfolio.balance = nextBalance;
  portfolio.positions = {};
  portfolio.trades = [];
  portfolio.stats = defaultStatsShape();
  portfolio.strategies = {
    swing: { positions: {}, trades: [], stats: defaultStatsShape() },
    momentum: { positions: {}, trades: [], stats: defaultStatsShape() },
  };
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
  stopOracleStopWatchers();
  [
    scanTimer,
    momentumScanTimer,
    swingScanTimer,
    momentumExitTimer,
    swingExitTimer,
    realtimeStopTimer,
    swingWatchlistRefreshTimer,
    walletBalanceRefreshTimer,
    bscNativePriceRefreshTimer,
    selfEvolutionTimer,
    intelligenceTimer,
    rlTrainingTimer,
  ].forEach((timer) => {
    if (timer) clearInterval(timer);
  });

  scanTimer = null;
  momentumScanTimer = null;
  swingScanTimer = null;
  momentumExitTimer = null;
  swingExitTimer = null;
  realtimeStopTimer = null;
  swingWatchlistRefreshTimer = null;
  walletBalanceRefreshTimer = null;
  bscNativePriceRefreshTimer = null;
  selfEvolutionTimer = null;
  intelligenceTimer = null;
  rlTrainingTimer = null;
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

async function runStrategyScanCycle(strategyName) {
  const lockKey = strategyName === 'swing' ? 'swingScan' : 'momentumScan';
  if (loopLocks[lockKey]) {
    return;
  }

  if (!isWithinTradingWindow()) {
    logger.debug(`[${strategyName}] Outside trading window — skipping entry scan`);
    return;
  }

  startFilterCycle(strategyName);
  const cycleStats = filterStatsState.currentCycle?.[strategyName] || null;
  const discoveryTimeoutMs = Math.max(15_000, Number(config.bot?.scanDiscoveryTimeoutMs || 120_000));
  const chainDiscoveryTimeoutMs = {
    solana: Math.max(15_000, Number(config.bot?.solanaScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
    bsc: Math.max(15_000, Number(config.bot?.bscScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
    kucoin: Math.max(15_000, Number(config.bot?.kucoinScanDiscoveryTimeoutMs || discoveryTimeoutMs)),
  };
  const stateSaveTimeoutMs = Math.max(5_000, Number(config.bot?.stateSaveTimeoutMs || 20_000));

  loopLocks[lockKey] = true;
  refreshScanInFlightFlag();
  try {
    if (strategyName === 'momentum') {
      const chainScans = [
        ['solana', exchanges.solana],
        ['bsc', exchanges.bsc],
        ['kucoin', exchanges.kucoin],
      ].filter(([chainName]) => isStrategyScanEnabled(chainName, strategyName));

      await Promise.allSettled(
        chainScans.map(([chainName, exchange]) => withTimeout(
          scanChain(chainName, exchange, strategyName, { cycleStats }),
          chainDiscoveryTimeoutMs[chainName] || discoveryTimeoutMs,
          `${chainName} ${strategyName} scan timed out after ${chainDiscoveryTimeoutMs[chainName] || discoveryTimeoutMs}ms`
        ))
      ).then((results) => {
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            const [chainName] = chainScans[index];
            logger.error(`${chainName} ${strategyName} scan failed`, {
              reason: result.reason?.message || String(result.reason || 'unknown_error'),
            });
          }
        });
      });
    } else if (strategyName === 'swing' && isStrategyScanEnabled('kucoin', strategyName)) {
      await withTimeout(
        scanChain('kucoin', exchanges.kucoin, strategyName, { cycleStats }),
        chainDiscoveryTimeoutMs.kucoin,
        `kucoin ${strategyName} scan timed out after ${chainDiscoveryTimeoutMs.kucoin}ms`
      ).catch((error) => {
        logger.error(`kucoin ${strategyName} scan failed`, { reason: error.message });
      });
    }

    recordPortfolioSnapshot(`scan_${strategyName}`);
    await withTimeout(
      saveState(),
      stateSaveTimeoutMs,
      `saveState timed out after ${stateSaveTimeoutMs}ms`
    );
    loopLastCompletedAt[lockKey] = Date.now();
  } finally {
    finalizeFilterCycle(strategyName);
    
    // Set scan status back to idle for all chains
    if (strategyName === 'momentum') {
      ['solana', 'bsc', 'kucoin'].forEach(chainName => {
        if (isStrategyScanEnabled(chainName, strategyName)) {
          const status = getStrategyScanStatus(chainName, strategyName);
          status.status = 'idle';
          status.currentToken = '-';
          status.lastUpdate = new Date().toISOString();
          syncChainScanStatus(chainName);
        }
      });
    } else if (strategyName === 'swing') {
      if (isStrategyScanEnabled('kucoin', strategyName)) {
        const status = getStrategyScanStatus('kucoin', strategyName);
        status.status = 'idle';
        status.currentToken = '-';
        status.lastUpdate = new Date().toISOString();
        syncChainScanStatus('kucoin');
      }
    }
    
    loopLocks[lockKey] = false;
    refreshScanInFlightFlag();
  }
}

async function runDetachedKucoinMomentumScan(cycleStats = null) {
  if (loopLocks.kucoinMomentumScan) {
    return;
  }

  if (!isWithinTradingWindow()) {
    return;
  }

  const kucoinScanGate = shouldPauseKucoinEntryScans();
  if (kucoinScanGate.paused) {
    logger.info(
      `KuCoin momentum entry scan paused: ${kucoinScanGate.reason}. ` +
      `Resuming warm-up ${(kucoinScanGate.msUntilReset / 60000).toFixed(0)}m before daily reset.`
    );
    return;
  }

  loopLocks.kucoinMomentumScan = true;
  refreshScanInFlightFlag();
  try {
    await scanChain('kucoin', exchanges.kucoin, 'momentum', { cycleStats });
  } finally {
    loopLocks.kucoinMomentumScan = false;
    refreshScanInFlightFlag();
  }
}

/**
 * Evict positions that have been in stuckPositions for > STUCK_EVICTION_HOURS hours.
 * Moves them out of portfolio.positions into untrackedWalletPositions so slots are freed.
 */
function evictStuckPositions() {
  const STUCK_EVICTION_HOURS = Number(process.env.STUCK_POSITION_EVICTION_HOURS || 2);
  const nowMs = Date.now();
  const stuck = portfolio.stuckPositions || {};
  let evicted = 0;
  for (const [key, meta] of Object.entries(stuck)) {
    if (!portfolio.positions?.[key]) {
      delete portfolio.stuckPositions[key];
      logger.info(`[StuckEvict] Cleared stale stuck flag for ${meta.symbol} (${key}) because no in-state position remains.`);
      continue;
    }
    const stuckMs = nowMs - Date.parse(meta.stuckAt || 0);
    if (stuckMs < STUCK_EVICTION_HOURS * 3_600_000) continue;
    const pos = portfolio.positions[key];
    // Move to untrackedWalletPositions so the value is still visible on the dashboard
    if (!portfolio.untrackedWalletPositions) portfolio.untrackedWalletPositions = {};
    portfolio.untrackedWalletPositions[key] = {
      symbol: meta.symbol,
      chainKey: meta.chainKey,
      address: meta.address,
      estimatedValueUsd: meta.estimatedValueUsd,
      reason: 'stuck_evicted',
      evictedAt: new Date().toISOString(),
      originalPosition: pos,
    };
    delete portfolio.positions[key];
    evicted++;
    logger.warn(
      `[StuckEvict] Evicted ${meta.symbol} (${key}) from positions after ${(stuckMs / 3_600_000).toFixed(1)}h stuck. ` +
      `EstValue ~$${Number(meta.estimatedValueUsd || 0).toFixed(2)}. Slot freed.`
    );
  }
  if (evicted > 0) {
    saveState();
  }
}

async function runStrategyExitCycle(strategyName) {
  const lockKey = strategyName === 'swing' ? 'swingExit' : 'momentumExit';
  if (loopLocks[lockKey]) {
    return;
  }

  loopLocks[lockKey] = true;
  try {
    if (portfolio.safeMode) {
      return;
    }

    // Free slots held by positions that have been stuck (unsellable) for too long
    evictStuckPositions();

    const strategyStats = portfolio.strategies?.[strategyName]?.stats || null;
    const cycleExitStats = {
      attempted: 0,
      skipped: 0,
      errors: 0,
      completed: 0,
    };

    // Reset stale-data skip counter unconditionally so a cycle with no positions clears stale alerts.
    if (strategyStats) {
      strategyStats.skippedExitChecks = 0;
    }

    const positions = Object.values(portfolio.positions || {}).filter(
      (position) => String(position?.strategy || 'momentum') === strategyName
    );

    if (!positions.length) {
      return;
    }

    logger.info(`Running ${strategyName} exit checks for ${positions.length} open positions`);

    await Promise.allSettled(positions.map(async (position) => {
      try {
        cycleExitStats.attempted += 1;
        const chainName = normalizeChainKey(position.chainKey || position.chain);
        const exchange = exchanges[chainName];
        if (!exchange || !isExchangeAvailable(chainName)) {
          return;
        }

        let tokenData = await exchange.getTokenData(position.address).catch(() => null);
        if (!tokenData || !tokenData.price) {
          // Attempt stale-price fallback from trackedTokens (max 10-minute age)
          const tokenKey = position.strategyKey || buildTokenKey(chainName, position.address);
          const cached = marketState.trackedTokens[`${chainName}:${String(position.address || '').toLowerCase()}`];
          const cacheAgeMs = cached?.lastScannedAt ? (Date.now() - new Date(cached.lastScannedAt).getTime()) : Infinity;
          if (cached && Number.isFinite(Number(cached.price)) && Number(cached.price) > 0 && cacheAgeMs < 600000) {
            logger.warn('Exit check using stale cached price — stop-loss/trailing-stop only', {
              strategy: strategyName,
              chain: chainName,
              symbol: position.symbol || null,
              address: position.address,
              reason: 'using stale cached price for exit check',
              cacheAgeMs,
            });
            tokenData = {
              price: Number(cached.price),
              symbol: cached.symbol || position.symbol,
              address: position.address,
              chain: CHAIN_LABELS[chainName],
              chainKey: chainName,
              strategyKey: tokenKey,
              volume24h: 0,
              liquidityUsd: 0,
              _stale: true,
            };
          } else {
            logger.warn('Exit check skipped: market data unavailable', {
              strategy: strategyName,
              chain: chainName,
              symbol: position.symbol || null,
              address: position.address,
              reason: 'market data unavailable',
            });
            cycleExitStats.skipped += 1;
            if (strategyStats) {
              strategyStats.skippedExitChecks =
                Number(strategyStats.skippedExitChecks || 0) + 1;
            }
            return;
          }
        }

        tokenData.address = tokenData.address || position.address;
        tokenData.chainKey = chainName;
        tokenData.chain = CHAIN_LABELS[chainName];
        tokenData.strategyKey = position.strategyKey || buildTokenKey(chainName, tokenData.address);

        recordStrategyTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));
        refreshTrackedOpenPositionSnapshot(chainName, tokenData, position);

        if (position.partialFillRetry) {
          logger.warn(`Retrying exit for partially filled position ${position.symbol || position.address} on ${chainName}`);
          await executeSell(chainName, exchange, tokenData, position, 1, 'PARTIAL_FILL_RETRY');
          return;
        }

        await checkExitConditions(chainName, exchange, tokenData, position, { staleData: Boolean(tokenData._stale) });
        cycleExitStats.completed += 1;
      } catch (error) {
        cycleExitStats.errors += 1;
        if (strategyStats) {
          strategyStats.skippedExitChecks =
            Number(strategyStats.skippedExitChecks || 0) + 1;
          strategyStats.exitErrorCount =
            Number(strategyStats.exitErrorCount || 0) + 1;
        }
        logger.error(`Exit check failed`, {
          strategy: strategyName,
          chain: position?.chainKey || position?.chain,
          symbol: position?.symbol,
          address: position?.address,
          reason: error.message,
        });
      }
    }));

    // Self-heal degradation counters after clean exit cycles.
    if (strategyStats) {
      const hadCleanCycle = cycleExitStats.errors === 0 && cycleExitStats.skipped === 0 && cycleExitStats.completed > 0;
      if (hadCleanCycle) {
        strategyStats.exitErrorCount = 0;
      } else if (cycleExitStats.errors === 0 && Number(strategyStats.exitErrorCount || 0) > 0) {
        strategyStats.exitErrorCount = Math.max(0, Number(strategyStats.exitErrorCount || 0) - 1);
      }
    }

    loopLastCompletedAt[lockKey] = Date.now();
  } catch (error) {
    logger.error(`${strategyName} exit cycle failed: ${error.message}`);
  } finally {
    loopLocks[lockKey] = false;
  }
}

async function runRealtimeRiskStopCycle() {
  if (loopLocks.realtimeStop) {
    return;
  }

  loopLocks.realtimeStop = true;
  try {
    if (portfolio.safeMode || config.risk?.realtimeStopLossEnabled === false) {
      return;
    }

    const positions = Object.values(portfolio.positions || {});
    if (!positions.length) {
      loopLastCompletedAt.realtimeStop = Date.now();
      return;
    }

    const chainsInBook = [...new Set(positions.map((p) => normalizeChainKey(p.chainKey || p.chain)))];
    for (const chainName of chainsInBook) {
      const chainRisk = risk.checkPerChainDailyLoss(chainName);
      if (!chainRisk.allowed) {
        logger.warn(`CHAIN DAILY LOSS HALT on ${chainName}: ${chainRisk.reason}`);
        const chainPositions = positions.filter((p) => normalizeChainKey(p.chainKey || p.chain) === chainName);
        for (const position of chainPositions) {
          if (position.exitInProgress) continue;
          const exchange = exchanges[chainName];
          if (!exchange || !isExchangeAvailable(chainName)) continue;
          const fallbackToken = {
            address: position.address,
            symbol: position.symbol,
            chainKey: chainName,
            chain: CHAIN_LABELS[chainName],
            strategyKey: position.strategyKey || buildTokenKey(chainName, position.address),
            price: Number(position.currentPrice || position.entryPrice || 0),
            volume24h: 0,
          };
          await executeSell(chainName, exchange, fallbackToken, position, 1, 'CHAIN_DAILY_LOSS_HALT');
        }
      }
    }

    const fetchTimeoutMs = Math.max(1000, Number(config.risk?.realtimeStopFetchTimeoutMs || 6000));

    await Promise.allSettled(positions.map(async (position) => {
      try {
        if (!position || position.exitInProgress) {
          return;
        }

        const chainName = normalizeChainKey(position.chainKey || position.chain);
        const exchange = exchanges[chainName];
        if (!exchange || !isExchangeAvailable(chainName)) {
          return;
        }

        const oraclePriceUsd = await getOraclePriceUsdForPosition(position, chainName).catch(() => null);
        let tokenData = null;

        if (Number.isFinite(Number(oraclePriceUsd)) && Number(oraclePriceUsd) > 0) {
          tokenData = {
            address: position.address,
            symbol: position.symbol,
            chainKey: chainName,
            chain: CHAIN_LABELS[chainName],
            strategyKey: position.strategyKey || buildTokenKey(chainName, position.address),
            price: Number(oraclePriceUsd),
            volume24h: 0,
            _oracle: true,
          };
        } else {
          tokenData = await withTimeout(
            exchange.getTokenData(position.address),
            fetchTimeoutMs,
            `Realtime stop price fetch timed out for ${position.address}`
          ).catch(() => null);

          if (!tokenData || !Number.isFinite(Number(tokenData.price)) || Number(tokenData.price) <= 0) {
            return;
          }

          tokenData.address = tokenData.address || position.address;
          tokenData.chainKey = chainName;
          tokenData.chain = CHAIN_LABELS[chainName];
          tokenData.strategyKey = position.strategyKey || buildTokenKey(chainName, tokenData.address);
        }

        recordStrategyTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));

        const strategyName = position.strategy || 'momentum';
        const strategyCfg = config.strategies?.[strategyName] || {};
        const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
        const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
        applyTrailingStopState(position, tokenData.price, trailingStartMultiplier, trailingStopPct);

        if (position.trailingStop && tokenData.price <= position.trailingStop) {
          if (shouldDelayBorderlineStop(position, tokenData.price, position.trailingStop, tokenData._oracle ? 'ORACLE_TRAILING_STOP' : 'FAST_TRAILING_STOP')) {
            return;
          }
          logger.warn(`FAST TRAILING STOP triggered for ${tokenData.symbol}: price ${Number(tokenData.price).toFixed(8)} <= stop ${Number(position.trailingStop).toFixed(8)}${tokenData._oracle ? ' (oracle)' : ''}`);
          await executeSell(chainName, exchange, tokenData, position, 1, tokenData._oracle ? 'ORACLE_TRAILING_STOP' : 'FAST_TRAILING_STOP');
          return;
        }

        if (tokenData.price <= position.stopLoss) {
          if (shouldDelayBorderlineStop(position, tokenData.price, position.stopLoss, tokenData._oracle ? 'ORACLE_STOP_LOSS' : 'FAST_STOP_LOSS')) {
            return;
          }
          logger.warn(`FAST STOP LOSS triggered for ${tokenData.symbol}: price ${Number(tokenData.price).toFixed(8)} <= stop ${Number(position.stopLoss).toFixed(8)}${tokenData._oracle ? ' (oracle)' : ''}`);
          await executeSell(chainName, exchange, tokenData, position, 1, tokenData._oracle ? 'ORACLE_STOP_LOSS' : 'FAST_STOP_LOSS');
          return;
        }

        // Disaster-floor safety net: if a position drops more than disasterStopPct from entry,
        // exit immediately even if the configured stopLoss is misconfigured/missing.
        // This prevents catastrophic losses when stopLoss never gets set or is set wrong.
        const disasterStopPct = Number(config.risk?.disasterStopPct || 25);
        const entryPrice = Number(position.entryPrice || 0);
        if (entryPrice > 0 && tokenData.price > 0) {
          const lossPct = ((entryPrice - tokenData.price) / entryPrice) * 100;
          if (lossPct >= disasterStopPct) {
            logger.warn(`DISASTER STOP triggered for ${tokenData.symbol}: down ${lossPct.toFixed(2)}% from entry (>= ${disasterStopPct}%)`);
            await executeSell(chainName, exchange, tokenData, position, 1, 'DISASTER_STOP');
          }
        }
      } catch (error) {
        logger.debug(`Realtime stop check error: ${error.message}`);
      }
    }));

    loopLastCompletedAt.realtimeStop = Date.now();
  } catch (error) {
    logger.error(`Realtime stop cycle failed: ${error.message}`);
  } finally {
    loopLocks.realtimeStop = false;
  }
}

async function refreshSwingWatchlists() {
  if (loopLocks.swingRefresh) {
    return;
  }

  loopLocks.swingRefresh = true;
  try {
    logger.info('Refreshing swing watchlists from discovery feeds');
    const perChainLimit = 120;

    await Promise.allSettled(Object.entries(exchanges).map(async ([chainName, exchange]) => {
      if (!supportsSwingOnChain(chainName)) return;
      if (!isExchangeAvailable(chainName)) return;
      if (typeof exchange.getNewTokens !== 'function') {
        logger.warn(`refreshSwingWatchlists: ${chainName} has no getNewTokens method, skipping`);
        return;
      }
      const discovered = await exchange.getNewTokens();
      const candidates = discovered.slice(0, 80);
      const accepted = [];

      for (const address of candidates) {
        try {
          const token = await exchange.getTokenData(address);
          if (!token || !token.price) continue;
          const applicable = strategy.determineApplicableStrategies({
            ...token,
            chainKey: chainName,
          });
          if (applicable.swing) {
            accepted.push(token.address || address);
          }
        } catch (err) {
            logger.debug(`Watchlist refresh token error on ${chainName}: addr=${address}, ${err.message}`);
            if (scanStatus[chainName]) {
              scanStatus[chainName].suppressedTokenErrors = (scanStatus[chainName].suppressedTokenErrors || 0) + 1;
              const maxSuppressed = Math.max(1, Number(config.risk?.maxSuppressedTokenErrors || 10));
              if (scanStatus[chainName].suppressedTokenErrors === maxSuppressed) {
                logger.warn(`suppressedTokenErrors threshold reached on ${chainName} this cycle`, {
                  chain: chainName,
                  suppressedTokenErrors: scanStatus[chainName].suppressedTokenErrors,
                  threshold: maxSuppressed,
                });
              }
            }
          }
      }

      const merged = [...new Set([...(watchlists[chainName] || []), ...accepted])].slice(0, perChainLimit);
      watchlists[chainName] = merged;
      logger.info(`Swing watchlist ${chainName}: ${watchlists[chainName].length} tokens after refresh`);
    }));
  } catch (error) {
    logger.error(`Swing watchlist refresh failed: ${error.message}`);
  } finally {
    loopLocks.swingRefresh = false;
  }
}

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

const scanOrchestration = createScanOrchestration({
  logger,
  config,
  exchanges,
  marketState,
  scanStatus,
  filterStatsState,
  loopLocks,
  loopLastCompletedAt,
  getStrategyScanStatus,
  isExchangeAvailable,
  syncChainScanStatus,
  getTokensForStrategy,
  refreshKucoinCatalystCache,
  getPrioritizedKucoinCatalystPairs,
  getBscDiscoveryRankSummary,
  getRotatingScanWindow,
  sleep,
  processToken: (...args) => processToken(...args),
  withTimeout,
  recordExchangeSuccess,
  recordExchangeFailure,
  isWithinTradingWindow,
  startFilterCycle,
  finalizeFilterCycle,
  isStrategyScanEnabled,
  recordPortfolioSnapshot,
  saveState: (...args) => saveState(...args),
  refreshScanInFlightFlag,
  shouldPauseKucoinEntryScans,
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

function restartLoopSchedulers() {
  clearLoopSchedulers();

  if (portfolio.safeMode) {
    stopSchedulersForSafeMode();
    logger.warn('Loop schedulers paused: safe mode is active');
    return;
  }

  setLoopLocks(false);

  const momentumScanMs = Math.max(60_000, Number(config.bot.momentumScanIntervalSeconds || 75) * 1000);
  const swingScanMs = Math.max(10 * 60_000, Number(config.bot.swingScanIntervalMinutes || 15) * 60_000);
  const momentumExitMs = Math.max(5 * 60_000, Number(config.bot.momentumExitCheckMinutes || 15) * 60_000);
  const swingExitMs = Math.max(30 * 60_000, Number(config.bot.swingExitCheckMinutes || 60) * 60_000);
  const swingRefreshMs = Math.max(6 * 60 * 60_000, Number(config.bot.swingWatchlistRefreshHours || 24) * 60 * 60_000);
  const realtimeStopMs = Math.max(2_000, Number(config.risk?.realtimeStopCheckSeconds || 8) * 1000);
  const selfEvolutionMs = Math.max(10 * 60_000, Number(config.selfEvolution?.intervalMinutes || 180) * 60_000);

  momentumScanTimer = setInterval(() => {
    runStrategyScanCycle('momentum').catch((error) => logger.error(`Momentum scan loop error: ${error.message}`));
  }, momentumScanMs);
  // Keep a handle in scanTimer for backward compatibility with state/debug expectations.
  scanTimer = momentumScanTimer;

  swingScanTimer = setInterval(() => {
    runStrategyScanCycle('swing').catch((error) => logger.error(`Swing scan loop error: ${error.message}`));
  }, swingScanMs);

  momentumExitTimer = setInterval(() => {
    runStrategyExitCycle('momentum').catch((error) => logger.error(`Momentum exit loop error: ${error.message}`));
  }, momentumExitMs);

  swingExitTimer = setInterval(() => {
    runStrategyExitCycle('swing').catch((error) => logger.error(`Swing exit loop error: ${error.message}`));
  }, swingExitMs);

  if (config.risk?.realtimeStopLossEnabled !== false) {
    realtimeStopTimer = setInterval(() => {
      runRealtimeRiskStopCycle().catch((error) => logger.error(`Realtime stop loop error: ${error.message}`));
    }, realtimeStopMs);
  }

  swingWatchlistRefreshTimer = setInterval(() => {
    refreshSwingWatchlists().catch((error) => logger.error(`Swing watchlist refresh loop error: ${error.message}`));
  }, swingRefreshMs);

  const walletBalanceRefreshMs = Math.max(30_000, Number(config.bot.walletBalanceRefreshSeconds || 60) * 1000);
  walletBalanceRefreshTimer = setInterval(() => {
    updateWalletBalance().catch((error) => logger.error(`Wallet balance refresh loop error: ${error.message}`));
  }, walletBalanceRefreshMs);

  const bscNativePriceRefreshMs = Math.max(15_000, Number(config.risk?.nativePriceRefreshSeconds || 45) * 1000);
  bscNativePriceRefreshTimer = setInterval(() => {
    refreshBscNativePrice().catch((error) => logger.warn(`BSC native price refresh loop error: ${error.message}`));
  }, bscNativePriceRefreshMs);

  if (config.selfEvolution?.enabled === true) {
    selfEvolutionTimer = setInterval(() => {
      runSelfEvolutionCycle().catch((error) => logger.error(`Self-evolution scheduler error: ${error.message}`));
    }, selfEvolutionMs);
  }

  // Market intelligence cycle: every 30 minutes by default
  const intelligenceMs = Math.max(15 * 60_000, Number(process.env.INTELLIGENCE_INTERVAL_MINUTES || 30) * 60_000);
  if (process.env.INTELLIGENCE_ENABLED !== 'false') {
    intelligenceTimer = setInterval(() => {
      runMarketIntelligenceCycle().catch((error) => logger.error(`Intelligence scheduler error: ${error.message}`));
    }, intelligenceMs);
  }

  if (config.paperTrading === true && config.rl?.enabled !== false && config.rl?.paperTrainingEnabled !== false) {
    const rlTrainingMs = Math.max(15 * 60_000, Number(config.rl?.trainingIntervalMinutes || 45) * 60_000);
    rlTrainingTimer = setInterval(() => {
      trainPaperRlPolicy().catch((error) => logger.error(`Paper RL training scheduler error: ${error.message}`));
    }, rlTrainingMs);
  }

  // RL Online updater: update Q-table from live trades every 5 minutes
  if (config.rl?.enabled !== false) {
    setInterval(async () => {
      try {
        const recentClosed = Object.values(portfolio.closedTrades || {})
          .filter((t) => Date.now() - (t.closedAt || 0) < 10 * 60_000)
          .slice(-20);

        for (const trade of recentClosed) {
          if (!trade._rlOnlineProcessed) {
            const tradeOutcome = {
              symbol: trade.symbol,
              symbols: [trade.symbol],
              chain: trade.chain,
              strategy: trade.strategy,
              pnl: trade.realizedPnl || 0,
              sizeUsd: trade.initialSizeUsd || 0,
              confidence: trade.aiConfidence || 0.5,
              priceChange24h: trade.priceChange24h || 0,
              holdMinutes: (trade.closedAt - trade.entryAt) / 60_000 || 0,
              portfolio,
              volatilityClass: portfolio.volatilityClass || 'normal',
            };
            rlOnlineUpdater.updateFromTrade(tradeOutcome);
            trade._rlOnlineProcessed = true;
          }
        }

        const stats = rlOnlineUpdater.getStats();
        if (stats.stateCount > 0) {
          logger.debug(`[RLOnline] Q-table: ${stats.stateCount} states, ${stats.actionCount} actions, avg Q=${stats.avgQValue.toFixed(2)}`);
        }
      } catch (err) {
        logger.debug(`RL online update error: ${err.message}`);
      }
    }, 5 * 60_000);
  }

  if (config.ml?.autoTrainingEnabled !== false) {
    const mlTrainingMs = Math.max(60 * 60_000, Number(config.ml?.autoTrainingIntervalMinutes || 360) * 60_000);
    setInterval(() => {
      modelRegistry.runAutoTraining().catch((error) => logger.error(`ML auto-training scheduler error: ${error.message}`));
    }, mlTrainingMs);
  }

  // Boot cycles immediately.
  evictStuckPositions(); // free any slots occupied by honeypot/stuck positions before first scan
  runStrategyScanCycle('momentum').catch((error) => logger.error(`Initial momentum scan failed: ${error.message}`));
  runStrategyScanCycle('swing').catch((error) => logger.error(`Initial swing scan failed: ${error.message}`));
  runStrategyExitCycle('momentum').catch((error) => logger.error(`Initial momentum exit check failed: ${error.message}`));
  runStrategyExitCycle('swing').catch((error) => logger.error(`Initial swing exit check failed: ${error.message}`));
  if (config.risk?.realtimeStopLossEnabled !== false) {
    runRealtimeRiskStopCycle().catch((error) => logger.error(`Initial realtime stop check failed: ${error.message}`));
  }
  if (config.selfEvolution?.enabled === true) {
    // Delay initial self-evolution by 2 min to avoid Groq rate-limit collision at startup
    setTimeout(() => {
      runSelfEvolutionCycle().catch((error) => logger.error(`Initial self-evolution cycle failed: ${error.message}`));
    }, 2 * 60_000);
  }
  // Boot intelligence cycle immediately (non-blocking)
  if (process.env.INTELLIGENCE_ENABLED !== 'false') {
    setTimeout(() => {
      runMarketIntelligenceCycle().catch((error) => logger.error(`Initial intelligence cycle failed: ${error.message}`));
    }, 3 * 60_000); // 3-min delay so startup Groq calls don't rate-limit intelligence
  }

  if (config.paperTrading === true && config.rl?.enabled !== false && config.rl?.paperTrainingEnabled !== false) {
    setTimeout(() => {
      trainPaperRlPolicy().catch((error) => logger.error(`Initial paper RL training failed: ${error.message}`));
    }, 90_000);
  }

  if (config.ml?.autoTrainingEnabled !== false) {
    setTimeout(() => {
      modelRegistry.runAutoTraining().catch((error) => logger.error(`Initial ML auto-training failed: ${error.message}`));
    }, 5 * 60_000);
  }

  // Weekly model retraining schedule
  if (config.ml?.weeklyRetrainingEnabled !== false || process.env.ML_WEEKLY_RETRAINING_ENABLED === 'true') {
    try {
      const scheduleWeeklyRetraining = () => {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const hourOfDay = now.getHours();

        // Schedule for Sunday at 2 AM UTC (low-traffic time)
        const scheduledDayOfWeek = 0; // Sunday
        const scheduledHour = 2;
        const scheduledMinute = 15;

        let nextRun = new Date(now);
        const currentDayOfWeek = nextRun.getUTCDay();
        const daysUntilSunday = (scheduledDayOfWeek - currentDayOfWeek + 7) % 7;
        nextRun.setUTCDate(nextRun.getUTCDate() + daysUntilSunday);
        nextRun.setUTCHours(scheduledHour, scheduledMinute, 0, 0);

        // If the target time has already passed today (or it's the same time), schedule for next week
        if (nextRun <= now) {
          nextRun.setUTCDate(nextRun.getUTCDate() + 7);
        }

        const delayMs = nextRun.getTime() - now.getTime();

        logger.info(`[Weekly Retraining] Scheduled for ${nextRun.toISOString()} (in ${(delayMs / 3600000).toFixed(1)} hours)`);

        setTimeout(async () => {
          logger.info('[Weekly Retraining] Starting weekly model retraining cycle...');

          try {
            // Retrain models on accumulated data
            const retrainingResult = await modelRegistry.runWeeklyRetraining?.() ||
              await modelRegistry.runAutoTraining?.().catch((error) => {
                logger.error(`Weekly retraining failed: ${error.message}`);
                return null;
              });

            if (retrainingResult) {
              logger.info(`[Weekly Retraining] Cycle completed successfully`);
              sendHeartbeat(`✅ Weekly model retraining completed`).catch(() => {});
            }
          } catch (err) {
            logger.error(`[Weekly Retraining] Cycle failed: ${err.message}`);
            sendErrorAlert(`Weekly model retraining failed: ${err.message}`).catch(() => {});
          }

          // Schedule next week's retraining
          scheduleWeeklyRetraining();
        }, delayMs);
      };

      scheduleWeeklyRetraining();
    } catch (err) {
      logger.warn(`[Weekly Retraining] Setup failed: ${err.message}`);
    }
  }

  setTimeout(() => {
    refreshBscNativePrice().catch((error) => logger.warn(`Initial BSC native price refresh failed: ${error.message}`));
  }, 5_000);

  startOracleStopWatchers();
}

async function refreshBscNativePrice() {
  if (!exchanges?.bsc || typeof exchanges.bsc.getBnbPrice !== 'function') {
    return null;
  }
  const price = await exchanges.bsc.getBnbPrice();
  loopLastCompletedAt.bscNativePriceRefresh = Date.now();
  return price;
}

async function updateWalletBalance() {
  if (config.paperTrading) {
    logger.info('Paper trading active, skipping live wallet balance fetch.');
    return;
  }

  logger.info('Fetching wallet balances...');
  try {
    const balanceResults = await Promise.allSettled([
      exchanges.solana.getBalance(),
      exchanges.bsc.getBalance(),
      exchanges.base.getBalance(),
      exchanges.kucoin.getBalance(),
    ]);
    const exchangeNames = ['Solana', 'BSC', 'Base', 'KuCoin'];
    let total = 0;
    let balanceCoverageCount = 0;
    const perExchangeBalances = {};
    balanceResults.forEach((result, i) => {
      const name = exchangeNames[i];
      if (result.status === 'fulfilled' && Number.isFinite(result.value) && result.value >= 0) {
        total += result.value;
        balanceCoverageCount += 1;
        perExchangeBalances[name] = result.value;
      } else {
        const reason = result.status === 'rejected'
          ? (result.reason?.message || String(result.reason))
          : 'returned non-finite value';
        logger.warn(`${name} balance fetch failed: ${reason}`);
        perExchangeBalances[name] = null;
      }
    });
    portfolio.walletBalanceUsd = round(total);
    portfolio.walletBalancesUsd = {
      solana: Number.isFinite(perExchangeBalances.Solana) ? round(perExchangeBalances.Solana) : null,
      bsc: Number.isFinite(perExchangeBalances.BSC) ? round(perExchangeBalances.BSC) : null,
      base: Number.isFinite(perExchangeBalances.Base) ? round(perExchangeBalances.Base) : null,
      kucoin: Number.isFinite(perExchangeBalances.KuCoin) ? round(perExchangeBalances.KuCoin) : null,
    };
    portfolio.balanceCoverageCount = balanceCoverageCount;

    const balanceCoverageRequired = Math.max(1, Number(config.risk?.minBalanceCoverage || 2));
    if (balanceCoverageCount < balanceCoverageRequired) {
      logger.warn('insufficient exchange coverage for drift check — skipping', {
        reason: 'insufficient exchange coverage for drift check — skipping',
        balanceCoverageCount,
        balanceCoverageRequired,
        perExchangeBalances,
      });
      logger.info(`Updated wallet balance (partial coverage ${balanceCoverageCount}/${balanceCoverageRequired}): ${Object.entries(perExchangeBalances).map(([k, v]) => `${k} $${v ?? 'fail'}`).join(', ')}, Total $${portfolio.walletBalanceUsd}`);
      loopLastCompletedAt.walletBalanceRefresh = Date.now();
      return;
    }

    const solBalance = balanceResults[0].status === 'fulfilled' ? (balanceResults[0].value || 0) : 0;
    const bscBalance = balanceResults[1].status === 'fulfilled' ? (balanceResults[1].value || 0) : 0;
    const baseBalance = balanceResults[2].status === 'fulfilled' ? (balanceResults[2].value || 0) : 0;
    const kucoinBalance = balanceResults[3].status === 'fulfilled' ? (balanceResults[3].value || 0) : 0;
    const deployedCapitalUsd = Object.values(portfolio.positions || {})
      .reduce((sum, position) => sum + Number(position?.costBasisUsd || position?.initialSizeUsd || 0), 0);
    // walletBalanceUsd = on-chain native-coin balance only (does not include token positions).
    // When a position is opened, native coin is spent so walletBalanceUsd already dropped.
    // Comparing walletBalanceUsd directly to ledgerCash detects genuine cash divergence
    // without double-subtracting deployedCapitalUsd.
    const ledgerCash = Number(portfolio.balance || 0);
    const driftAmountUsd = Math.abs(Number(portfolio.walletBalanceUsd || 0) - ledgerCash);
    const driftDenominator = Math.max(1, Math.abs(ledgerCash || Number(portfolio.walletBalanceUsd || 0)));
    const driftPct = (driftAmountUsd / driftDenominator) * 100;
    portfolio.balanceDrift = {
      amountUsd: round(driftAmountUsd),
      pct: round(driftPct, 2),
      walletBalanceUsd: round(portfolio.walletBalanceUsd || 0),
      deployedCapitalUsd: round(deployedCapitalUsd),
      cashLedgerUsd: round(ledgerCash),
    };

    const maxBalanceDriftPct = Math.max(0, Number(config.risk?.maxBalanceDriftPct || 10));
    if (driftPct > maxBalanceDriftPct) {
      logger.warn('Wallet/cash ledger drift above threshold', {
        reason: 'cash ledger drift detected',
        walletBalanceUsd: Number(portfolio.walletBalanceUsd || 0),
        deployedCapitalUsd: round(deployedCapitalUsd),
        cashLedgerUsd: ledgerCash,
        driftAmountUsd: round(driftAmountUsd),
        driftPct: round(driftPct, 2),
        thresholdPct: maxBalanceDriftPct,
      });
    }
    const driftHaltThresholdPct = 25;
    if (driftPct > driftHaltThresholdPct) {
      portfolio.balanceDriftHalt = true;
    } else if (portfolio.balanceDriftHalt && driftPct <= maxBalanceDriftPct) {
      portfolio.balanceDriftHalt = false;
      logger.info('Wallet/cash ledger drift back within threshold - clearing drift halt', {
        driftPct: round(driftPct, 2),
        thresholdPct: maxBalanceDriftPct,
        haltThresholdPct: driftHaltThresholdPct,
      });
    }

    logger.info(`Updated wallet balance: Solana $${solBalance}, BSC $${bscBalance}, Base $${baseBalance}, KuCoin $${kucoinBalance}, Total $${portfolio.walletBalanceUsd}`);
    loopLastCompletedAt.walletBalanceRefresh = Date.now();
  } catch (error) {
    logger.error(`Failed to update wallet balance: ${error.message}`);
  }
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
  if (sqlSelfTest?.enabled !== false) {
    const sqlStatus = getSqlStatus();
    logger.info(
      `[SQL] startup self-test ${sqlSelfTest.ok ? 'passed' : 'failed'} | ` +
      `db=${sqlStatus.databaseName || 'unknown'} explicitDb=${sqlStatus.databaseExplicit ? 'yes' : 'no'} ` +
      `schema=${sqlStatus.schemaReady ? 'ready' : 'not_ready'}`
    );
  }
  await agentMemory.load();
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
  logger.info(' DEX Trading Bot - Starting up (dual strategy)');
  logger.info(` Runtime profile: ${BOT_PROFILE} (paper=${config.paperTrading ? 'yes' : 'no'}) dataDir=${BOT_DATA_DIR}`);
  logger.info(`  Mode: ${config.paperTrading ? 'PAPER TRADING' : 'LIVE TRADING'}`);
  logger.info(`  Discovery Mode: ${config.bot.discoveryMode || 'hybrid'}`);
  logger.info(`  Swing: ${config.strategies?.swing?.enabled !== false ? 'enabled' : 'disabled'} | EMA(${config.strategies?.swing?.emaFast}/${config.strategies?.swing?.emaSlow}) | max positions ${config.strategies?.swing?.maxConcurrentPositions}`);
  logger.info(`  Momentum: ${config.strategies?.momentum?.enabled !== false ? 'enabled' : 'disabled'} | EMA(${config.strategies?.momentum?.emaFast}/${config.strategies?.momentum?.emaSlow}) | max positions ${config.strategies?.momentum?.maxConcurrentPositions}`);
  logger.info(`  Momentum Scan Interval: ${config.bot.momentumScanIntervalSeconds || 75}s`);
  logger.info(`  Swing Scan Interval: ${config.bot.swingScanIntervalMinutes || 15}m`);
  logger.info(`  Momentum Exit Checks: every ${config.bot.momentumExitCheckMinutes || 15}m`);
  logger.info(`  Swing Exit Checks: every ${config.bot.swingExitCheckMinutes || 60}m`);
  logger.info(`  Realtime Stop Monitor: ${config.risk?.realtimeStopLossEnabled !== false ? `enabled (${config.risk?.realtimeStopCheckSeconds || 8}s)` : 'disabled'}`);
  logger.info(`  Swing Watchlist Refresh: every ${config.bot.swingWatchlistRefreshHours || 24}h`);
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
    portfolio.balance = Number(portfolio.walletBalanceUsd || 0);
    portfolio.startingBalance = portfolio.balance;
    // Clear any drift halt that was triggered by the stale persisted balance before this correction.
    portfolio.balanceDriftHalt = false;
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
  const repairedSellFailures = await repairAmbiguousKucoinSellFailures({ applyCashLedger: false })
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

  async function runSqlAutoPrune(log) {
    const { getPool } = require('./utils/sqlServer');
    const sql = require('mssql');
    const pool = await getPool(log).catch(() => null);
    if (!pool) return;
    const PRUNE = [
      ['dbo.signals',                12],
      ['dbo.model_predictions',      24],
      ['dbo.model_feature_store',    24],
      ['dbo.multi_agent_decisions',  24],
      ['dbo.sentiment_snapshots',    24],
      ['dbo.bot_state_snapshots',    48],
      ['dbo.decision_log',           72],
    ];
    let totalDeleted = 0;
    for (const [table, hours] of PRUNE) {
      try {
        let batch;
        let deleted = 0;
        do {
          const req = new sql.Request(pool);
          req.input('hours', sql.Int, hours);
          batch = await req.query(`DELETE TOP (5000) FROM ${table} WHERE ts < DATEADD(hour, -@hours, SYSUTCDATETIME())`);
          deleted += batch.rowsAffected[0] || 0;
        } while ((batch.rowsAffected[0] || 0) > 0);
        if (deleted > 0) {
          totalDeleted += deleted;
          log.info(`[SQL prune] ${table}: removed ${deleted} rows older than ${hours}h`);
        }
      } catch (err) {
        log.debug(`[SQL prune] ${table} skipped: ${err.message}`);
      }
    }
    if (totalDeleted > 0) {
      log.info(`[SQL prune] cycle complete, total ${totalDeleted} rows deleted`);
    }
  }

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

  cron.schedule('15 0 * * *', () => {
    refreshSwingWatchlists().catch((error) => logger.error(`Daily swing watchlist refresh failed: ${error.message}`));
  });

  logger.info(`Bot running. Dashboard at http://localhost:${config.bot.port}`);
}

let shutdownInProgress = false;

async function shutdownAndExit(exitCode, reason, error = null) {
  if (shutdownInProgress) {
    process.exit(exitCode);
    return;
  }
  shutdownInProgress = true;

  if (error) {
    logger.error(reason, {
      reason,
      error: error.message,
      stack: error.stack,
    });
  } else {
    logger.info(reason);
  }

  try {
    await wsDiscovery.stop();
  } catch (stopError) {
    logger.error('Failed to stop websocket discovery during shutdown', {
      reason: stopError.message,
    });
  }

  // Gracefully close dashboard server to release port binding
  if (dashboardServer) {
    try {
      // Close all WebSocket connections
      if (dashboardWss) {
        dashboardWss.clients?.forEach((client) => {
          if (client.readyState === 1) { // OPEN
            client.close();
          }
        });
      }
      // Close the HTTP server
      await new Promise((resolve) => {
        dashboardServer.close(() => {
          logger.debug('Dashboard server closed');
          resolve();
        });
      });
    } catch (closeError) {
      logger.warn('Error closing dashboard server:', closeError.message);
    }
  }

  try {
    await telemetry.endRun({ exitReason: reason });
    await telemetry.flush();
    await saveState();
  } catch (saveError) {
    logger.error('Unexpected saveState failure during shutdown', {
      reason: saveError.message,
    });
  }

  process.exit(exitCode);
}

process.on('SIGINT', async () => {
  await shutdownAndExit(0, 'Shutting down, saving state...');
});

process.on('SIGTERM', async () => {
  await shutdownAndExit(0, 'Received SIGTERM, saving state before exit...');
});

process.on('uncaughtException', (error) => {
  const errorMsg = error?.message || String(error);
  const errorStack = error?.stack || '';
  console.error('UNCAUGHT EXCEPTION DETAILS:', errorMsg);
  console.error('Stack:', errorStack);
  logger.error('Uncaught exception — runtime crash recovery engaged', {
    reason: errorMsg,
    stack: errorStack,
  });
  shutdownAndExit(1, 'Uncaught exception — runtime crash recovery engaged', error).catch(() => {
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection — runtime crash recovery engaged', {
    reason: error?.message,
    stack: error?.stack,
  });
  shutdownAndExit(1, 'Unhandled promise rejection — runtime crash recovery engaged', error).catch(() => {
    process.exit(1);
  });
});

main().catch((error) => {
  shutdownAndExit(1, `Fatal startup error: ${error.message}`, error);
});
