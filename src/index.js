'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { ethers } = require('ethers');
const config = require('../config');
const logger = require('./utils/logger');
const RiskGuardian = require('./risk/guardian');
const MomentumStrategy = require('./strategy/momentum');
const { applyPositionJitter, getRandomEntryDelay, shouldSplitSolanaTrade, generateSplitTradeSchedule, sleep } = require('./utils/anti-pattern');
const JupiterExchange = require('./exchanges/jupiter');
const PancakeSwapExchange = require('./exchanges/pancakeswap');
const BaseSwapExchange = require('./exchanges/baseswap');
const KuCoinExchange = require('./exchanges/kucoin');
const WebSocketDiscovery = require('./discovery/ws-discovery');
const { startDashboard } = require('./dashboard');
const WalletMonitor = require('./wallet-monitor');
const AITradeBrain = require('./ai/ensemble');
const { runBacktest, runBacktestWithRegimes, runWalkForwardBacktest, runRegimeSpecificBacktest, runPortfolioBacktest } = require('./backtest');
const { runPaperSimulation } = require('./simulation');
const { sendHeartbeat, sendTradeAlert, sendErrorAlert } = require('./telegram');
const { validateConfig } = require('./utils/validate-config');
const { cleanupNonTradeLogs, getLogCleanupIntervalMs } = require('./utils/log-maintenance');
const {
  refreshKucoinCatalystCache,
  getPrioritizedKucoinCatalystPairs,
  getKucoinCatalystForToken,
} = require('./utils/catalyst');
const fs = require('fs').promises;
const redis = require('redis');

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

function recordRuntimeDelta() {
  ensureRuntimeStateShape();
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
    `rejects=${JSON.stringify(cycleStats.rejectReasons || {})}`
  );
}

const marketState = {
  trackedTokens: {},
  signals: [],
  backtests: [],
  simulations: [],
};
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

const strategy = new MomentumStrategy();
const risk = new RiskGuardian(portfolio);
const walletMonitor = new WalletMonitor(portfolio);
const wsDiscovery = new WebSocketDiscovery();

let scanTimer = null;
let scanInFlight = false;
let momentumScanTimer = null;
let swingScanTimer = null;
let momentumExitTimer = null;
let swingExitTimer = null;
let realtimeStopTimer = null;
let swingWatchlistRefreshTimer = null;
let walletBalanceRefreshTimer = null;
const loopLocks = {
  momentumScan: false,
  kucoinMomentumScan: false,
  swingScan: false,
  momentumExit: false,
  swingExit: false,
  realtimeStop: false,
  swingRefresh: false,
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
      discrepancies.push(entry);
      untrackedWalletPositions.push(entry);
      untrackedWalletPositionValueUsdByChain[chainName] = Number(untrackedWalletPositionValueUsdByChain[chainName] || 0) + Number(walletPosition.valueUsd || 0);
      logger.error('State reconciliation mismatch', {
        reason: 'unrecovered position detected',
        ...entry,
      });
    }

    stateKeys.forEach((key) => {
      if (walletKeys.has(key)) return;
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
        const stalePosition = portfolio.positions?.[key];
        if (stalePosition) {
          const strategyName = String(stalePosition.strategy || 'momentum').toLowerCase();
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
    } else if (chainName === 'kucoin') {
      if (!exchange.exchange) throw new Error('KuCoin client not initialized');
      if (typeof exchange.exchange.fetchTime === 'function') {
        await exchange.exchange.fetchTime();
      } else {
        await exchange.exchange.loadMarkets();
      }
      state.endpoint = exchange.exchange.id || 'kucoin-rest';
    } else {
      if (!exchange.provider) throw new Error('RPC provider not initialized');
      await exchange.provider.getBlockNumber();
      state.endpoint = exchange.provider?._getConnection?.().url || state.endpoint;
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
  try {
    await fs.mkdir('data', { recursive: true });
    recordRuntimeDelta();
    const state = {
      portfolio,
      marketState,
      riskState: {
        dailyStartBalance: Number(risk.dailyStartBalance || 0),
        dailyResetDate: String(risk.dailyResetDate || ''),
        haltedToday: Boolean(risk.haltedToday),
      },
      strategyState: {
        priceHistory: strategy.priceHistory,
        volumeHistory: strategy.volumeHistory,
      },
    };
    const serialized = JSON.stringify(state);
    const tempPath = 'data/state.tmp.json';
    const statePath = 'data/state.json';
    const backupPath = 'data/state.backup.json';
    await fs.writeFile(tempPath, serialized);
    await fs.rename(tempPath, statePath);
    await fs.copyFile(statePath, backupPath);
    saveFailureCount = 0;
    portfolio.saveFailureCount = 0;
    logger.info('Bot state saved to disk');
  } catch (error) {
    saveFailureCount += 1;
    portfolio.saveFailureCount = saveFailureCount;
    setStatePersistenceError(true);
    logger.error('Failed to save state', {
      reason: error.message,
      statePersistenceError,
      saveFailureCount,
    });
  }
}

async function loadState() {
  const statePath = 'data/state.json';
  const backupPath = 'data/state.backup.json';
  const tempPath = 'data/state.tmp.json';
  try {
    let saved = null;

    try {
      const data = await fs.readFile(statePath, 'utf8');
      saved = JSON.parse(data);
    } catch (error) {
      const primaryError = error;
      const primaryMissing = primaryError?.code === 'ENOENT';
      if (!primaryMissing) {
        logger.error('Primary state load failed', {
          reason: primaryError.message,
          source: statePath,
        });
      }

      try {
        const backupData = await fs.readFile(backupPath, 'utf8');
        saved = JSON.parse(backupData);
        logger.warn('Recovered runtime state from backup state file', {
          source: backupPath,
          reason: primaryError.message,
        });
      } catch (backupError) {
        const backupMissing = backupError?.code === 'ENOENT';
        if (primaryMissing && backupMissing) {
          logger.info('No saved state found, starting fresh');
            setStatePersistenceError(false);
            portfolio.safeMode = false;
          return;
        }

        logger.error('state unrecoverable', {
          reason: 'state unrecoverable',
          primaryError: primaryError.message,
          backupError: backupError.message,
        });
        await enterSafeMode('state unrecoverable');
        return;
      }
    }

    if (!saved || typeof saved !== 'object') {
      throw new Error('Loaded state payload is invalid');
    }

    if (saved.portfolio) Object.assign(portfolio, saved.portfolio);
    if (saved.marketState) Object.assign(marketState, saved.marketState);
    // Drop stale INSUFFICIENT DATA entries so they do not inflate tracked counts after restart.
    // These are regenerated naturally as scans run.
    if (marketState.trackedTokens && typeof marketState.trackedTokens === 'object') {
      for (const key of Object.keys(marketState.trackedTokens)) {
        const entry = marketState.trackedTokens[key];
        if (entry && entry.finalSignal === 'INSUFFICIENT DATA') {
          delete marketState.trackedTokens[key];
        }
      }
    }
    if (saved.riskState && typeof saved.riskState === 'object') {
      if (Number.isFinite(Number(saved.riskState.dailyStartBalance)) && Number(saved.riskState.dailyStartBalance) > 0) {
        risk.dailyStartBalance = Number(saved.riskState.dailyStartBalance);
      }
      if (typeof saved.riskState.dailyResetDate === 'string' && saved.riskState.dailyResetDate) {
        risk.dailyResetDate = saved.riskState.dailyResetDate;
      }
      if (typeof saved.riskState.haltedToday === 'boolean') {
        risk.haltedToday = saved.riskState.haltedToday;
      }
    }
    ensureRuntimeStateShape();
    portfolio.runtime.lastTickMs = Date.now();
    if (saved.strategyState?.priceHistory && typeof saved.strategyState.priceHistory === 'object') {
      strategy.priceHistory = saved.strategyState.priceHistory;
    }
    if (saved.strategyState?.volumeHistory && typeof saved.strategyState.volumeHistory === 'object') {
      strategy.volumeHistory = saved.strategyState.volumeHistory;
    }

    // Backward-compat migration: old states keyed positions by raw token address.
    if (portfolio.positions && typeof portfolio.positions === 'object') {
      const migrated = {};
      Object.entries(portfolio.positions).forEach(([key, pos]) => {
        const chainKey = pos?.chainKey || normalizeChainKey(pos?.chain);
        const address = pos?.address || key;
        const nextKey = key.includes(':') ? key : buildTokenKey(chainKey, address);
        migrated[nextKey] = {
          ...pos,
          key: nextKey,
          chainKey,
          address,
          strategyKey: pos?.strategyKey || nextKey,
          strategy: pos?.strategy || 'momentum',
        };
      });
      portfolio.positions = migrated;
    }

    ensureStatsShape();
    refreshPerformanceMetrics();
    setStatePersistenceError(false);

    try {
      const checkpoint = JSON.stringify({
        portfolio,
        marketState,
        riskState: {
          dailyStartBalance: Number(risk.dailyStartBalance || 0),
          haltedToday: Boolean(risk.haltedToday),
        },
        strategyState: {
          priceHistory: strategy.priceHistory,
          volumeHistory: strategy.volumeHistory,
        },
      });
      await fs.writeFile(tempPath, checkpoint);
      await fs.rename(tempPath, statePath);
      await fs.copyFile(statePath, backupPath);
    } catch (checkpointError) {
      logger.error('State checkpoint update failed after load', {
        reason: checkpointError.message,
      });
    }

    logger.info('Bot state loaded from disk');
  } catch (error) {
    logger.error('Failed to load state', { reason: error.message });
      await enterSafeMode('loadState failure');
  }
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

function getBscDiscoveryLaneMetadata(tokenAddress) {
  const key = String(tokenAddress || '').trim().toLowerCase();
  return bscDiscoveryLaneCache.get(key) || null;
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
  return Number(Number(value || 0).toFixed(digits));
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
    } else {
      // null = "no losses yet" (mathematically undefined, not infinite)
      stats.profitFactor = strategyGrossProfit > 0 ? null : 0;
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

function setExecutionJournalState(txid, patch = {}) {
  if (!txid) return;
  portfolio.executionJournal = portfolio.executionJournal || {};
  const key = String(txid);
  const current = portfolio.executionJournal[key] || {};
  portfolio.executionJournal[key] = {
    ...current,
    ...patch,
    txid: key,
    updatedAt: new Date().toISOString(),
  };
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
  const aiHealthy = config.anthropic.enabled
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
    && !persistenceError;

  if (signalDrought.global) {
    degradedReasons.push('signal_drought');
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
    filterStats: {
      currentCycle: filterStatsState.currentCycle,
      recentCycles: filterStatsState.recentCycles,
    },
    scanErrors: Object.keys(scanStatus).reduce((acc, chainKey) => {
      acc[chainKey] = scanStatus[chainKey].suppressedTokenErrors || 0;
      return acc;
    }, {}),
    exchanges: dependencies,
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
        entryPrice: round(position.entryPrice, 6),
        currentPrice: round(position.currentPrice || position.entryPrice, 6),
        quantity: round(position.quantity || 0, 6),
        initialSizeUsd: round(position.initialSizeUsd || 0),
        costBasisUsd: round(costBasisUsd),
        positionValueUsd: round(currentValue),
        unrealizedPnl: round(unrealizedPnl),
        unrealizedPnlPct: round(unrealizedPnlPct),
        stopLoss: round(position.stopLoss || 0, 6),
        takeProfit: round(position.takeProfit || 0, 6),
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
  portfolio.pnlHistory.push({
    timestamp: new Date().toISOString(),
    cash: snapshot.cashBalance,
    equity: snapshot.equity,
    totalPnl: snapshot.totalPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
    reason,
  });

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
      shortSignal: token.indicators?.shortSignal ?? null,
      mediumSignal: token.indicators?.mediumSignal ?? null,
      longSignal: token.indicators?.longSignal ?? null,
      recentWindowLabel: token.indicators?.recentWindowLabel ?? null,
    },
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
  }
}

function updateTrackedToken(chainName, tokenData, evaluation, options = {}) {
  const recordSignal = options.recordSignal !== false;
  const key = `${chainName}:${String(tokenData.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key];
  const aiCacheStatus = getAiDecisionCacheStatus(tokenData, evaluation.strategy || 'momentum');
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
    notBoughtReason: evaluation.notBoughtReason || previous?.notBoughtReason || '',
    lastBuyFailure: evaluation.lastBuyFailure || previous?.lastBuyFailure || '',
    lastBuyFailureAt: evaluation.lastBuyFailureAt || previous?.lastBuyFailureAt || null,
    riskFlags: evaluation.riskFlags || [],
    indicators: {
      fastEma: evaluation.details.fastEma ?? null,
      slowEma: evaluation.details.slowEma ?? null,
      rsi: evaluation.details.rsi ?? null,
      volumeSpike: evaluation.details.volumeSpike ?? null,
      shortSignal: evaluation.details.short?.signal || null,
      mediumSignal: evaluation.details.medium?.signal || null,
      longSignal: evaluation.details.long?.signal || null,
      confidence: evaluation.details.confidence || 0,
      triggerTimeframe: evaluation.details.triggerTimeframe || null,
      recentWindowLabel: evaluation.details.recentWindowLabel || null,
    },
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
  }
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

function getAiDecisionCacheTtlMs() {
  return Math.max(1000, Number(config.ai?.decisionCacheMs || 300000));
}

function hasFreshAiDecision(entry) {
  if (!entry || !entry.decision || !Number.isFinite(Number(entry.updatedAt))) {
    return false;
  }
  return (Date.now() - Number(entry.updatedAt)) <= getAiDecisionCacheTtlMs();
}

function scoreAiDecisionCandidate(tokenData, technicalDetails = {}) {
  const triggerTimeframe = String(technicalDetails?.triggerTimeframe || '').toLowerCase();
  const discoveryLane = String(tokenData?.discoveryLane || technicalDetails?.discoveryLane || '').toLowerCase();
  const confidence = Number(technicalDetails?.confidence || 0);
  const volumeSpike = Number(technicalDetails?.volumeSpike || 0);
  const buyRatioRecentPct = Number(technicalDetails?.buyRatioRecentPct || technicalDetails?.buyRatio10mPct || 0);
  const netBuyFlowUsd = Number(technicalDetails?.netBuyFlowUsd10m || 0);
  const liquidityUsd = Number(tokenData?.liquidityUsd || 0);
  const priceChange24h = Math.abs(Number(tokenData?.priceChange24h || 0));
  const rsiValue = Number(technicalDetails?.rsi || 0);

  let score = confidence * 100;
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
  return hasFreshAiDecision(entry) ? entry.decision : null;
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
    executionStatus: executionMeta.executionStatus || undefined,
    recoveredFromFailure: executionMeta.recoveredFromFailure === true ? true : undefined,
    recoverySource: executionMeta.recoverySource || undefined,
    timestamp: tradeTimestamp,
  };

  portfolio.trades.unshift(trade);
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

  const state = {
    timestamp: new Date().toISOString(),
    uptimeSeconds: runtime.uptimeSeconds,
    totalRuntimeSeconds: runtime.totalRuntimeSeconds,
    mode: config.paperTrading ? 'paper' : 'live',
    portfolio: getPortfolioSnapshot({ compact }),
    performanceGate,
    config: {
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
    brain: {
      ...brainState,
      successRate: brainState.callCount > 0
        ? round((brainState.successCount / brainState.callCount) * 100, 1)
        : null,
      enabled: config.anthropic.enabled,
      hasApiKey: Boolean(config.anthropic.apiKey),
    },
    filterStats: {
      signalDrought: {
        momentum: Boolean(filterStatsState.signalDrought?.momentum),
        swing: Boolean(filterStatsState.signalDrought?.swing),
        global: Boolean(filterStatsState.signalDrought?.global),
      },
      consecutiveZeroSignalCycles: {
        momentum: Number(filterStatsState.consecutiveZeroSignalCycles?.momentum || 0),
        swing: Number(filterStatsState.consecutiveZeroSignalCycles?.swing || 0),
      },
      currentCycle: compact ? undefined : filterStatsState.currentCycle,
      recentCycles: compact
        ? undefined
        : filterStatsState.recentCycles,
    },
    diagnostics: {
      scanCounterMismatchCount: activeScanCounterMismatches.length,
      scanCounterMismatches: compact ? undefined : activeScanCounterMismatches,
    },
    market: {
      trackedTokens,
      catalystPairs: getPrioritizedKucoinCatalystPairs().slice(0, 20),
      recentSignals,
      backtests: compact ? [] : marketState.backtests.slice(0, 5),
      simulations: compact ? [] : marketState.simulations.slice(0, 5),
      chainSummary: Object.keys(CHAIN_LABELS).map((chainKey) => {
        const chainTokens = trackedTokens.filter((token) => token.chainKey === chainKey);
          const actionableTokens = chainTokens.filter((token) => token.finalSignal !== 'INSUFFICIENT DATA');
        const chainStrategies = supportsSwingOnChain(chainKey)
          ? scanStatus[chainKey].strategies
          : { momentum: scanStatus[chainKey].strategies?.momentum || {} };
        return {
          chainKey,
          name: scanStatus[chainKey].name,
            tracked: actionableTokens.length,
            seenTokens: chainTokens.length,
          discoveredTokens: Number(scanStatus[chainKey].discoveredTokens || 0),
          evaluatedTokens: Number(scanStatus[chainKey].evaluatedTokens || 0),
          buySignals: chainTokens.filter((token) => token.finalSignal === 'BUY').length,
          openPositions: chainTokens.filter((token) => token.hasOpenPosition).length,
          status: scanStatus[chainKey].status,
          currentToken: scanStatus[chainKey].currentToken,
          tokensScanned: scanStatus[chainKey].tokensScanned,
          lastUpdate: scanStatus[chainKey].lastUpdate,
          suppressedTokenErrors: scanStatus[chainKey].suppressedTokenErrors || 0,
          strategies: chainStrategies,
        };
      }),
    },
  };

  if (compact) {
    delete state.config;
    delete state.scanStatus;
  }

  return state;
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

  const uniqueCandidates = [...new Set(candidates)].slice(0, 1200);
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
      // KuCoin REST polling can be slower due market/depth calls; allow a longer wait so the
      // momentum universe is not starved by websocket-only fallbacks.
      const hybridPollTimeoutMs = chainName === 'kucoin'
        ? Math.max(defaultHybridTimeoutMs, 6000)
        : defaultHybridTimeoutMs;
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
  const pollTimeoutMs = chainName === 'kucoin'
    ? Math.max(defaultPollTimeoutMs, 10000)
    : defaultPollTimeoutMs;
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
  const scanState = getStrategyScanStatus(chainName, scanStrategy);
  if (scanState) {
    scanState.currentToken = `${tokenData.symbol} (${tokenAddress})`;
    scanState.currentPair = tokenData.pairAddress || tokenData.pair || '-';
    scanState.lastUpdate = new Date().toISOString();
    if (scanStrategy) {
      syncChainScanStatus(chainName);
    }
  }
  strategy.recordTick(tokenKey, Number(tokenData.price), Number(tokenData.volume24h || 0));

  const openPosition = portfolio.positions[tokenKey];
  if (openPosition) {
    openPosition.currentPrice = Number(tokenData.price);
    openPosition.lastSeenAt = new Date().toISOString();
    // Exit evaluation is handled exclusively by runStrategyExitCycle to prevent concurrent double-sells.
    return;
  }

  // Change 3: AMM reserve-imbalance filter — block tokens with extreme pool imbalance.
  if (tokenData.reserveImbalanced) {
    logger.debug(`Skipping ${tokenData.symbol} (${chainName}): reserve imbalance ratio ${(tokenData.reserveRatio || 0).toFixed(0)}`);
    trackInsufficient('reserve_imbalance');
    return;
  }

  if (chainName === 'bsc') {
    const requireTaxData = config.execution?.bscRequireTaxData !== false;
    const taxDataAvailable = tokenData.taxDataAvailable !== false && tokenData.taxDataAvailable != null
      ? Boolean(tokenData.taxDataAvailable)
      : (tokenData.buyTax !== null || tokenData.sellTax !== null);
    const buyTaxPct = Number(tokenData.buyTax);
    const sellTaxPct = Number(tokenData.sellTax);
    const maxBuyTaxPct = Math.max(0, Number(config.execution?.bscMaxBuyTaxPct || 0));
    const maxSellTaxPct = Math.max(0, Number(config.execution?.bscMaxSellTaxPct || 0));

    if (requireTaxData && !taxDataAvailable) {
      logger.warn(`Skipping ${tokenData.symbol} (${chainName}): token tax data unavailable`);
      trackInsufficient('tax_data_unavailable');
      return;
    }
    if (Number.isFinite(buyTaxPct) && buyTaxPct > maxBuyTaxPct) {
      logger.warn(`Skipping ${tokenData.symbol} (${chainName}): buy tax ${buyTaxPct.toFixed(2)}% exceeds limit ${maxBuyTaxPct.toFixed(2)}%`);
      trackInsufficient('buy_tax_too_high');
      return;
    }
    if (Number.isFinite(sellTaxPct) && sellTaxPct > maxSellTaxPct) {
      logger.warn(`Skipping ${tokenData.symbol} (${chainName}): sell tax ${sellTaxPct.toFixed(2)}% exceeds limit ${maxSellTaxPct.toFixed(2)}%`);
      trackInsufficient('sell_tax_too_high');
      return;
    }
  }

  // Change 1: Round-trip friction pre-check — block tokens where implied tax/friction exceeds threshold.
  if ((chainName === 'bsc' || chainName === 'base') && !tokenData.isHoneypot && typeof exchange.checkRoundTripFriction === 'function') {
    const frictionResult = await exchange.checkRoundTripFriction(tokenAddress, 0.01).catch(() => ({ blocked: false }));
    if (frictionResult.blocked) {
      logger.warn(`Skipping ${tokenData.symbol} (${chainName}): ${frictionResult.reason} (${(frictionResult.frictionPct || 0).toFixed(1)}%)`);
      trackInsufficient('round_trip_friction');
      return;
    }
    tokenData.roundTripFrictionPassed = true;
    tokenData.roundTripFrictionPct = Number(frictionResult.frictionPct || 0);
  }

  if (
    chainName === 'bsc'
    && config.execution?.requirePrivateTxForBsc
    && !config.paperTrading
    && typeof exchange.hasPrivateTxRoute === 'function'
    && !exchange.hasPrivateTxRoute()
  ) {
    logger.warn(`Skipping ${tokenData.symbol} (bsc): private transaction route required but unavailable`);
    trackInsufficient('private_route_required');
    return;
  }
  if (chainName === 'bsc') {
    tokenData.privateRouteVerified = !config.execution?.requirePrivateTxForBsc
      || config.paperTrading
      || typeof exchange.hasPrivateTxRoute !== 'function'
      || exchange.hasPrivateTxRoute();
  }

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

    if (evaluation.signal !== 'BUY') {
      removeAiDecisionQueueCandidate(tokenData, strategyName);
    }

    if (config.anthropic.enabled && evaluation.signal === 'BUY') {
      if (Date.now() >= aiCircuit.cooldownUntil) {
        const baseAiFloor = Number(config.strategies?.[strategyName]?.aiConfidenceFloor || config.risk.aiConfidenceFloor || 70);
        const hourlyWinRateAdjustment = getHourlyWinRateAdjustment(strategyName);
        const strategyAiFloor = Math.max(0, Math.min(100, baseAiFloor + Number(hourlyWinRateAdjustment.adjustmentPct || 0)));
        evaluation.details.hourlyWinRateAdjustment = hourlyWinRateAdjustment;
        cacheAiDecisionCandidate(tokenData, {
          ...evaluation.details,
          signal: evaluation.signal,
          strategy: strategyName,
          confidenceFloor: strategyAiFloor,
        }, strategyName, {
          source: chainName === 'bsc' ? 'bsc_buy_candidate' : 'buy_candidate',
        });
        let aiBypassedForLatency = false;
        const aiInput = {
          ...evaluation.details,
          signal: evaluation.signal,
          strategy: strategyName,
          confidenceFloor: strategyAiFloor,
        };
        const useNonBlockingAi = config.execution?.aiNonBlocking !== false
          || (strategyName === 'momentum' && config.execution?.momentumAiNonBlocking !== false);
        const aiDecision = useNonBlockingAi
          ? (() => {
            queueAiDecisionRefresh(tokenData, aiInput, strategyName);
            const cachedDecision = getCachedAiDecision(tokenData, strategyName);
            if (!cachedDecision) {
              aiBypassedForLatency = true;
            }
            return cachedDecision;
          })()
          : await AITradeBrain.evaluateToken(tokenData, aiInput);

        if (aiDecision && aiDecision.signal) {
          aiCircuit.failures = 0;
          finalSignal = aiDecision.signal;
          signalSource = 'AI';
          evaluation.details.aiReason = aiDecision.reason;
          evaluation.details.aiConfidence = aiDecision.confidence;
          evaluation.details.aiRiskFlags = aiDecision.riskFlags;
          recordBrainSuccess(tokenData, aiDecision);

          if (Number(aiDecision.confidence || 0) < strategyAiFloor) {
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_confidence_floor'])];
            if (isBscRelaxedContinuation) {
              finalSignal = evaluation.signal;
              signalSource = 'technical';
              evaluation.details.aiReason = evaluation.details.aiReason || 'bsc_relaxed_continuation_ai_advisory';
              logger.info(`AI advisory only for ${tokenData.symbol}: BSC relaxed continuation kept technical BUY despite confidence ${Number(aiDecision.confidence || 0).toFixed(0)}% < floor ${strategyAiFloor.toFixed(0)}%`);
            } else {
              finalSignal = 'HOLD';
              if (cycleStats) {
                cycleStats.aiBlocked += 1;
                aiBlockedThisToken = true;
                incrementRejectReason(cycleStats, 'aiHold');
              }
            }
          } else if (isBscRelaxedContinuation && aiDecision.signal !== 'BUY') {
            finalSignal = evaluation.signal;
            signalSource = 'technical';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_advisory_only'])];
            evaluation.details.aiReason = evaluation.details.aiReason || 'bsc_relaxed_continuation_ai_advisory';
            logger.info(`AI advisory only for ${tokenData.symbol}: BSC relaxed continuation kept technical BUY despite AI ${aiDecision.signal}`);
          }
        } else if (config.anthropic.apiKey && !aiBypassedForLatency) {
          aiCircuit.failures += 1;
          if (aiCircuit.failures >= config.bot.aiFailureThreshold) {
            aiCircuit.cooldownUntil = Date.now() + (config.bot.aiFailureCooldownSeconds * 1000);
            aiCircuit.failures = 0;
            recordBrainFailure(`AI circuit opened for ${config.bot.aiFailureCooldownSeconds}s`);
          } else {
            recordBrainFailure('AI response unavailable');
          }
        } else if (aiBypassedForLatency) {
          evaluation.details.aiReason = 'ai_cached_decision_pending';
          evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_cached_decision_pending'])];
          finalSignal = 'HOLD';
          if (cycleStats) {
            cycleStats.aiBlocked += 1;
            aiBlockedThisToken = true;
            incrementRejectReason(cycleStats, 'aiPending');
          }
        }
        evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
      } else {
        // Expected behavior: AI in cooldown, using technical signal. Log debug only.
        logger.debug(`AI in cooldown; using technical signal for ${strategyName} (not a failure)`);
        evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
      }
    } else {
      refreshBrainAvailability();
      evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
    }

    if (strategyName === 'momentum' && evaluation.details.triggerTimeframe === 'extreme_24h_momentum') {
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
    tokenData.marketRegime = evaluation.details.marketRegime || null;
    tokenData.realizedVolPct = Number(evaluation.details.realizedVolPct);

    const riskCheck = await risk.canTrade(tokenData, strategy.priceHistory || {}, strategyName);
    if (!riskCheck.allowed) {
      logger.warn(`Trade blocked for ${tokenData.symbol} (${strategyName}): ${riskCheck.reason}`);
      recordTradeBlockState(
        chainName,
        tokenData,
        strategyName,
        evaluation.signal,
        signalSource,
        riskCheck.reason,
        { riskFlags: [riskCheck.code || riskCheck.reason].filter(Boolean) }
      );
      if (cycleStats) {
        cycleStats.riskBlocked += 1;
        incrementRejectReason(cycleStats, classifyRejectReason(riskCheck.code || riskCheck.reason));
      }
      continue;
    }

    if (cycleStats) {
      cycleStats.passed += 1;
    }

    await executeBuy(chainName, exchange, tokenData, strategyName);

    // Prevent dual ownership of same token across strategies.
    return;
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
  const strategySellTiers = config.strategies?.[strategyName]?.sellTiers || config.strategy.sellTiers;
  const strategyCfg = config.strategies?.[strategyName] || {};

  const trailingStartMultiplier = Number(strategyCfg.trailingActivationMultiplier || config.risk.trailingStopAfterMultiplier || 2);
  const trailingStopPct = Number(strategyCfg.trailingStopPct || config.risk.trailingStopPct || 15);
  applyTrailingStopState(position, tokenData.price, trailingStartMultiplier, trailingStopPct);

  // With stale data only evaluate stop-loss and trailing-stop; skip strategy exit and take-profit tiers.
  let exitSignal = null;
  if (!staleData) {
    exitSignal = strategy.evaluateExitForStrategy(position.strategyKey || buildTokenKey(chainName, tokenData.address), strategyName, tokenData, position);
    if (exitSignal?.shouldExit) {
      logger.info(`STRATEGY EXIT triggered for ${tokenData.symbol} [${strategyName}]: ${exitSignal.reason}`);
      await executeSell(chainName, exchange, tokenData, position, 1, exitSignal.reason);
      return;
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
  const calculatedSizeUsd = risk.positionSize(tokenData, strategyName);
  if (calculatedSizeUsd < 10) {
    logger.warn(`Position size $${calculatedSizeUsd.toFixed(2)} too small, skipping`);
    return;
  }

  // Anti-pattern evasion: apply position size jitter (±15%) to avoid bot fingerprinting
  const sizeUsd = applyPositionJitter(calculatedSizeUsd, 15);

  // Acquire mutex before any position-count check or portfolio write to prevent
  // concurrent BUY paths from both passing the limit and both writing positions.
  const release = await positionMutex.lock();
  try {
    const globalPositions = Object.keys(portfolio.positions).length;
    if (globalPositions >= config.risk.maxConcurrentPositions) {
      logger.debug(`Global position limit reached at buy time for ${tokenData.symbol}, skipping`);
      return;
    }
    const strategyPositionCount = Object.values(portfolio.positions).filter((p) => p.strategy === strategyName).length;
    const strategyLimit = Number(config.strategies?.[strategyName]?.maxConcurrentPositions || 3);
    if (strategyPositionCount >= strategyLimit) {
      logger.debug(`Strategy position limit reached for ${strategyName} at buy time on ${tokenData.symbol}, skipping`);
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

    if (chainName === 'solana') {
      // Anti-pattern evasion: split large Solana buys into 2-3 smaller txs to avoid detection
      if (shouldSplitSolanaTrade(sizeUsd, 2000)) {
        const schedule = generateSplitTradeSchedule(sizeUsd);
        const results = [];
        for (const split of schedule) {
          await sleep(split.delayBeforeMs);
          const splitResult = await withTimeout(
            exchange.executeBuy(tokenData.address, split.usdcAmount, { strategyName, splitIndex: split.splitIndex, splitTotal: split.splitTotal }),
            execTimeoutMs,
            `Solana buy timed out for ${tokenData.symbol} split ${split.splitIndex}/${split.splitTotal}`
          );
          results.push(splitResult);
        }
        // Aggregate split results
        txResult = {
          txid: results[0]?.txid || `split_${Date.now()}`,
          filledBaseQty: results.reduce((sum, r) => sum + Number(r?.filledBaseQty || 0), 0),
          filledQuoteUsd: results.reduce((sum, r) => sum + Number(r?.filledQuoteUsd || 0), 0),
          splits: results,
          splitCount: results.length,
          hasExchangeFilledData: results.some(r => r?.hasExchangeFilledData),
        };
      } else {
        txResult = await withTimeout(
          exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
          execTimeoutMs,
          `Solana buy timed out for ${tokenData.symbol}`
        );
      }
    } else if (chainName === 'kucoin') {
      txResult = await withTimeout(
        exchange.executeBuy(tokenData.address, sizeUsd, { strategyName }),
        execTimeoutMs,
        `KuCoin buy timed out for ${tokenData.symbol}`
      );
    } else {
      const maxNativePriceAgeMs = Math.max(1000, Number(config.risk?.maxNativePriceAgeMs || 120000));
      let nativePrice;
      if (chainName === 'bsc') {
        const cached = exchanges.bsc.getCachedBnbPrice();
        if (!Number.isFinite(cached.price) || cached.price <= 0 || cached.cachedAt === null || (Date.now() - cached.cachedAt) > maxNativePriceAgeMs) {
          logger.error('native price unavailable or stale — buy aborted', {
            reason: 'native price unavailable or stale — buy aborted',
            chain: chainName,
            symbol: tokenData.symbol,
            cachedAt: cached.cachedAt,
          });
          return;
        }
        nativePrice = cached.price;
      } else {
        const cached = exchanges.base.getCachedEthPrice();
        if (!Number.isFinite(cached.price) || cached.price <= 0 || cached.cachedAt === null || (Date.now() - cached.cachedAt) > maxNativePriceAgeMs) {
          logger.error('native price unavailable or stale — buy aborted', {
            reason: 'native price unavailable or stale — buy aborted',
            chain: chainName,
            symbol: tokenData.symbol,
            cachedAt: cached.cachedAt,
          });
          return;
        }
        nativePrice = cached.price;
      }
      const nativeAmount = sizeUsd / nativePrice;
      txResult = await withTimeout(
        exchange.executeBuy(tokenData.address, nativeAmount, { strategyName }),
        execTimeoutMs,
        `${chainName} buy timed out for ${tokenData.symbol}`
      );
    }

    if (txResult?.txid) {
      const requiredConfirmations = chainName === 'bsc'
        ? Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2))
        : (chainName === 'base' ? Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2)) : 1);
      setExecutionJournalState(txResult.txid, {
        status: 'confirmed',
        type: 'BUY',
        chain: chainName,
        chainKey: chainName,
        symbol: tokenData.symbol,
        address: tokenData.address,
        blockNumber: Number(txResult?.blockNumber || 0) || null,
        confirmations: Number(txResult?.confirmations || 0) || null,
        requiredConfirmations,
        createdAt: new Date().toISOString(),
      });
    }

    const realizedEntryPrice = extractExecutionPriceUsd(txResult, expectedEntryPrice);
    const inferredHasExchangeFilledData = [
      txResult?.filledBaseQty,
      txResult?.filledQuantity,
      txResult?.filledQty,
      txResult?.executedBaseQty,
      txResult?.filledQuoteUsd,
      txResult?.filledQuoteQty,
      txResult?.executedQuoteUsd,
      txResult?.cost,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    const hasExchangeFilledData = typeof txResult?.hasExchangeFilledData === 'boolean'
      ? txResult.hasExchangeFilledData
      : inferredHasExchangeFilledData;
    const requestedQuoteUsd = Number(sizeUsd);
    let filledQuoteUsd = extractFilledQuoteUsd(txResult, requestedQuoteUsd);
    let filledBaseQty = extractFilledBaseQty(txResult, 0);

    if (filledBaseQty <= 0 && filledQuoteUsd > 0 && realizedEntryPrice > 0) {
      filledBaseQty = filledQuoteUsd / realizedEntryPrice;
    }
    if (filledQuoteUsd <= 0 && filledBaseQty > 0 && realizedEntryPrice > 0) {
      filledQuoteUsd = filledBaseQty * realizedEntryPrice;
    }
    if (filledBaseQty <= 0 && realizedEntryPrice > 0) {
      filledBaseQty = requestedQuoteUsd / realizedEntryPrice;
    }
    // When exchange fill evidence is incomplete, prefer conservative accounting from confirmed base fill
    // instead of assuming the full requested quote notional was spent.
    if (!hasExchangeFilledData && filledBaseQty > 0 && realizedEntryPrice > 0) {
      filledQuoteUsd = Math.min(requestedQuoteUsd, filledBaseQty * realizedEntryPrice);
    }
    if (filledQuoteUsd <= 0) {
      filledQuoteUsd = requestedQuoteUsd;
    }
    if (!hasExchangeFilledData) {
      logger.warn(`BUY fill reconciliation fallback used for ${tokenData.symbol} on ${chainName} (exchange did not provide confirmed fill amounts)`);
    }

    const strictIncompleteFillMode = config.execution?.failClosedOnIncompleteFill !== false
      && !config.paperTrading
      && (chainName === 'bsc' || chainName === 'base');
    if (strictIncompleteFillMode && !hasExchangeFilledData) {
      const reason = `Incomplete fill evidence for live ${chainName.toUpperCase()} BUY ${tokenData.symbol}; fail-closed to avoid balance drift`;
      if (txResult?.txid) {
        setExecutionJournalState(txResult.txid, {
          status: 'needs_reconciliation',
          reason,
        });
      }
      logger.error(reason);
      await sendErrorAlert(reason);
      if (!portfolio.safeMode) {
        await enterSafeMode(reason);
      }
      return;
    }

    const realizedVsQuoteSlippagePct = Number(txResult?.realizedVsQuoteSlippagePct);
    const quotedPriceImpactPct = Number(txResult?.quotedPriceImpactPct);
    if (chainName === 'solana' && Number.isFinite(realizedVsQuoteSlippagePct) && Number.isFinite(quotedPriceImpactPct)) {
      const maxDriftPct = Math.max(0, Number(config.execution?.solanaMaxRealizedVsQuotedSlippagePct || 1.5));
      if (realizedVsQuoteSlippagePct > maxDriftPct) {
        logger.warn(
          `Solana quote/execution drift for ${tokenData.symbol}: quoted impact ${quotedPriceImpactPct.toFixed(2)}%, ` +
          `realized-vs-quote slippage ${realizedVsQuoteSlippagePct.toFixed(2)}% (> ${maxDriftPct.toFixed(2)}%)`
        );
      }
    }

    const entrySlippageBps = calcSlippageBps(expectedEntryPrice, realizedEntryPrice);
    if (entrySlippageBps !== null) {
      recordSlippageSample(strategyName, entrySlippageBps);
      refreshPerformanceMetrics();
    }

    const quantity = filledBaseQty;
    const tokenKey = buildTokenKey(chainName, tokenData.address);
    const fillDiscrepancyPct = calcDiscrepancyPct(requestedQuoteUsd, filledQuoteUsd);

    portfolio.balance -= filledQuoteUsd;
    portfolio.positions[tokenKey] = {
      key: tokenKey,
      address: tokenData.address,
      chain: tokenData.chain,
      chainKey: chainName,
      strategyKey: tokenData.strategyKey || tokenKey,
      strategy: strategyName,
      symbol: tokenData.symbol,
      entryPrice: realizedEntryPrice,
      currentPrice: realizedEntryPrice,
      quantity,
      initialSizeUsd: filledQuoteUsd,
      costBasisUsd: filledQuoteUsd,
      requestedEntryUsd: requestedQuoteUsd,
      filledEntryUsd: filledQuoteUsd,
      requestedEntryQuantity: realizedEntryPrice > 0 ? (requestedQuoteUsd / realizedEntryPrice) : quantity,
      filledEntryQuantity: quantity,
      entryFillDiscrepancyPct: fillDiscrepancyPct,
      stopLoss: risk.stopLossPrice(realizedEntryPrice, strategyName),
      takeProfit: risk.takeProfitPrice(realizedEntryPrice, strategyName),
      openedAt: new Date().toISOString(),
      txid: txResult.txid,
      entryBlockNumber: Number.isFinite(Number(txResult?.blockNumber)) ? Number(txResult.blockNumber) : null,
      entryConfirmations: Number.isFinite(Number(txResult?.confirmations)) ? Number(txResult.confirmations) : null,
      entryPrivateRouteUsed: Boolean(txResult?.privateRouteUsed),
      signalSource: tokenData.signalSource || 'technical',
      triggerTimeframe: tokenData.entryTriggerTimeframe || null,
      discoveryLane: tokenData.discoveryLane || null,
      aiReason: tokenData.aiReason || '',
      aiConfidence: tokenData.aiConfidence || 0,
      pairAddress: tokenData.pairAddress || null,
      entryLiquidityUsd: Number(tokenData.liquidityUsd || 0),
      entryTopHoldersPct: Number(tokenData.topHoldersPct || 0),
      entryBuyRatioPct10m: (() => {
        const buys = Number(tokenData.buyTx10m || 0);
        const sells = Number(tokenData.sellTx10m || 0);
        const total = buys + sells;
        return total > 0 ? (buys / total) * 100 : 0;
      })(),
      entryRecentWindowMinutes: Number(tokenData.recentTxWindowMinutes || 0) || null,
      entryBuyRatioRecentPct: Number(tokenData.buyRatioRecentPct || 0) || null,
      entryHolderCount: Number(tokenData.holderCount || 0),
      highestPrice: realizedEntryPrice,
      antiPatternInfo: {
        positionJitterApplied: sizeUsd !== calculatedSizeUsd,
        positionJitterPct: sizeUsd !== calculatedSizeUsd ? ((sizeUsd - calculatedSizeUsd) / calculatedSizeUsd) * 100 : 0,
        entryDelayApplied: entryDelayMs > 0,
        entryDelayMs,
        splitTrade: txResult?.splitCount ? { count: txResult.splitCount, results: txResult.splits } : null,
      },
      trailingStop: null,
      tierLocalHigh: realizedEntryPrice,
      triggeredSellTiers: {},
      tierDelayedAt: {},
      partialFillRetry: false,
      exitInProgress: false,
      realizedPnlByTier: {},
      realizedPnl: 0,
    };

    portfolio.strategies[strategyName].positions[tokenKey] = portfolio.positions[tokenKey];
  ensureLiquiditySentinel(chainName, tokenData.pairAddress);

    if (chainName === 'bsc') {
      const requestedEntryQuantity = realizedEntryPrice > 0 ? (requestedQuoteUsd / realizedEntryPrice) : quantity;
      const realizedFillPct = requestedEntryQuantity > 0 ? (quantity / requestedEntryQuantity) * 100 : 100;
      const minFillPctOfExpected = Math.max(0, Math.min(100, Number(config.execution?.bscMinFillPctOfExpected || 0)));
      if (requestedEntryQuantity > 0 && realizedFillPct < minFillPctOfExpected) {
        const reason = `entry fill ${realizedFillPct.toFixed(2)}% below minimum ${minFillPctOfExpected.toFixed(2)}%`;
        logger.error(`BSC catastrophic fill detected for ${tokenData.symbol}: ${reason}`);
        recordTradeBlockState(chainName, tokenData, strategyName, tokenData.signalSource || 'BUY', tokenData.signalSource || 'technical', reason, {
          riskFlags: ['entry_fill_below_minimum'],
        });
        await sendErrorAlert(`BSC catastrophic fill for ${tokenData.symbol}: ${reason}`);
        await executeSell(chainName, exchange, tokenData, portfolio.positions[tokenKey], 1, 'ENTRY_FILL_GUARD');
        return;
      }
    }

    portfolio.stats.executions += 1;
    portfolio.strategies[strategyName].stats.executions += 1;
    recordPortfolioSnapshot('buy');
    logTrade('BUY', tokenData, quantity, filledQuoteUsd, txResult.txid, null, portfolio.positions[tokenKey].signalSource, 'ENTRY', {
      expectedPrice: expectedEntryPrice,
      realizedPrice: realizedEntryPrice,
      slippageBps: entrySlippageBps,
      requestedQuantity: realizedEntryPrice > 0 ? (requestedQuoteUsd / realizedEntryPrice) : quantity,
      filledQuantity: quantity,
      requestedValueUsd: requestedQuoteUsd,
      filledValueUsd: filledQuoteUsd,
      fillDiscrepancyPct,
      quotedPriceImpactPct,
      realizedVsQuoteSlippagePct,
      blockNumber: txResult?.blockNumber,
      confirmations: txResult?.confirmations,
      privateRouteUsed: txResult?.privateRouteUsed,
    }, strategyName);
    await saveState();
    await sendTradeAlert('BUY', tokenData, filledQuoteUsd);
  } catch (error) {
    recordExchangeFailure(chainName, error.message);
    recordBuyFailureState(chainName, tokenData, error.message);
    logger.error(`BUY execution failed for ${tokenData.symbol}: ${error.message}`);
    await sendErrorAlert(`BUY failed for ${tokenData.symbol}: ${error.message}`);
  }
  } finally {
    release();
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

  const strategyStats = portfolio.strategies?.[strategyName]?.stats;
  if (!strategyStats) {
    throw new Error(`Missing strategy stats bucket for ${strategyName}`);
  }

  const positionQuantityBefore = Number(position?.quantity || 0);
  if (!Number.isFinite(positionQuantityBefore) || positionQuantityBefore <= 0) {
    throw new Error(`Cannot finalize SELL for ${tokenData?.symbol || position?.symbol || position?.address}: no position quantity`);
  }

  if (txResult?.txid) {
    const requiredConfirmations = chainName === 'bsc'
      ? Math.max(1, Number(config.execution?.requiredConfirmationsBsc || 2))
      : (chainName === 'base' ? Math.max(1, Number(config.execution?.requiredConfirmationsBase || 2)) : 1);
    setExecutionJournalState(txResult.txid, {
      status: 'confirmed',
      type: 'SELL',
      chain: chainName,
      chainKey: chainName,
      symbol: tokenData.symbol,
      address: tokenData.address,
      blockNumber: Number(txResult?.blockNumber || 0) || null,
      confirmations: Number(txResult?.confirmations || 0) || null,
      requiredConfirmations,
      createdAt: new Date().toISOString(),
    });
  }

  const realizedExitPrice = extractExecutionPriceUsd(txResult, expectedExitPrice);
  const inferredHasExchangeFilledData = [
    txResult?.filledBaseQty,
    txResult?.filledQuantity,
    txResult?.filledQty,
    txResult?.executedBaseQty,
    txResult?.filledQuoteUsd,
    txResult?.filledQuoteQty,
    txResult?.executedQuoteUsd,
    txResult?.cost,
  ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  const hasExchangeFilledData = typeof txResult?.hasExchangeFilledData === 'boolean'
    ? txResult.hasExchangeFilledData
    : inferredHasExchangeFilledData;

  const requestedQty = Number(quantityRequested || (positionQuantityBefore * requestedFraction) || 0);
  let filledBaseQty = extractFilledBaseQty(txResult, requestedQty);
  if (!Number.isFinite(filledBaseQty) || filledBaseQty <= 0) {
    filledBaseQty = requestedQty;
  }
  if (filledBaseQty > positionQuantityBefore && positionQuantityBefore > 0) {
    filledBaseQty = positionQuantityBefore;
  }

  let filledQuoteUsd = extractFilledQuoteUsd(txResult, 0);
  if (!Number.isFinite(filledQuoteUsd) || filledQuoteUsd <= 0) {
    filledQuoteUsd = filledBaseQty * realizedExitPrice;
  }

  if (!hasExchangeFilledData) {
    logger.warn(`SELL fill reconciliation fallback used for ${tokenData.symbol} on ${chainName} (exchange did not provide confirmed fill amounts)`);
  }

  const filledFraction = positionQuantityBefore > 0
    ? Math.max(0, Math.min(1, filledBaseQty / positionQuantityBefore))
    : requestedFraction;
  const costBasisPortion = Number(position.costBasisUsd || 0) * filledFraction;

  const exitSlippageBps = calcSlippageBps(expectedExitPrice, realizedExitPrice);
  if (exitSlippageBps !== null) {
    recordSlippageSample(strategyName, exitSlippageBps);
  }

  const proceedsUsd = filledQuoteUsd;
  const pnl = proceedsUsd - costBasisPortion;
  const fillDiscrepancyPct = calcDiscrepancyPct(requestedQty, filledBaseQty);

  portfolio.balance += proceedsUsd;
  portfolio.stats.totalPnl += pnl;
  strategyStats.totalPnl += pnl;
  if (pnl >= 0) {
    portfolio.stats.grossProfit += pnl;
    strategyStats.grossProfit += pnl;
  } else {
    portfolio.stats.grossLoss += Math.abs(pnl);
    strategyStats.grossLoss += Math.abs(pnl);
  }

  position.quantity = Math.max(0, Number(position.quantity || 0) - filledBaseQty);
  position.costBasisUsd = Math.max(0, Number(position.costBasisUsd || 0) - costBasisPortion);
  position.currentPrice = realizedExitPrice;
  position.realizedPnl = Number(position.realizedPnl || 0) + pnl;

  const quantityDustThreshold = Math.max(0.000001, positionQuantityBefore * 0.0001);
  const costBasisDustThreshold = Math.max(0.01, Number(position.initialSizeUsd || 0) * 0.0001);
  const nearFullSellRequested = requestedFraction >= 0.999999;

  position.partialFillRetry = Boolean(nearFullSellRequested && position.quantity > quantityDustThreshold);
  position.lastExitReconciliation = {
    reason,
    timestamp: new Date().toISOString(),
    requestedQuantity: requestedQty,
    filledQuantity: filledBaseQty,
    remainingQuantity: position.quantity,
    requestedValueUsd: requestedQty * realizedExitPrice,
    filledValueUsd: proceedsUsd,
    remainingCostBasisUsd: position.costBasisUsd,
    discrepancyPct: fillDiscrepancyPct,
    partialFillRetry: position.partialFillRetry,
    recoveredFromTradeHistory: Boolean(txResult?.recoveredFromTradeHistory),
  };

  if (position.partialFillRetry) {
    logger.warn(
      `Partial full-exit fill for ${tokenData.symbol} on ${chainName}: requested=${requestedQty.toFixed(8)}, ` +
      `filled=${filledBaseQty.toFixed(8)}, remaining=${position.quantity.toFixed(8)}. Marked for retry.`
    );
  }

  if (String(reason || '').startsWith('SELL_TIER_')) {
    position.realizedPnlByTier = position.realizedPnlByTier || {};
    position.realizedPnlByTier[reason] = Number(position.realizedPnlByTier[reason] || 0) + pnl;
  }

  const fullyClosed = position.quantity <= quantityDustThreshold || position.costBasisUsd <= costBasisDustThreshold;

  if (fullyClosed) {
    position.partialFillRetry = false;
    const positionKey = position.key || buildTokenKey(chainName, tokenData.address);
    const finalTradePnl = Number(position.realizedPnl || 0);
    delete portfolio.positions[positionKey];
    delete portfolio.strategies[strategyName].positions[positionKey];
    releaseLiquiditySentinel(chainName, position.pairAddress);
    strategy.clearHistory(position.strategyKey || positionKey);
    portfolio.stats.closedTrades += 1;
    strategyStats.closedTrades += 1;
    if (finalTradePnl >= 0) {
      portfolio.stats.wins += 1;
      strategyStats.wins += 1;
      portfolio.stats.consecutiveLosses = 0;
      strategyStats.consecutiveLosses = 0;
    } else {
      portfolio.stats.losses += 1;
      strategyStats.losses += 1;
      portfolio.stats.consecutiveLosses = Number(portfolio.stats.consecutiveLosses || 0) + 1;
      portfolio.stats.maxConsecutiveLosses = Math.max(
        Number(portfolio.stats.maxConsecutiveLosses || 0),
        Number(portfolio.stats.consecutiveLosses || 0)
      );
      strategyStats.consecutiveLosses = Number(strategyStats.consecutiveLosses || 0) + 1;
      strategyStats.maxConsecutiveLosses = Math.max(
        Number(strategyStats.maxConsecutiveLosses || 0),
        Number(strategyStats.consecutiveLosses || 0)
      );
    }
  }

  portfolio.stats.executions += 1;
  strategyStats.executions += 1;
  position.exitInProgress = false;
  refreshPerformanceMetrics();
  recordPortfolioSnapshot(fullyClosed ? 'close' : 'partial');
  logTrade('SELL', tokenData, filledBaseQty, proceedsUsd, txResult.txid, pnl, position.signalSource || 'technical', reason, {
    expectedPrice: expectedExitPrice,
    realizedPrice: realizedExitPrice,
    slippageBps: exitSlippageBps,
    requestedQuantity: requestedQty,
    filledQuantity: filledBaseQty,
    requestedValueUsd: requestedQty * realizedExitPrice,
    filledValueUsd: proceedsUsd,
    fillDiscrepancyPct,
    blockNumber: txResult?.blockNumber,
    confirmations: txResult?.confirmations,
    privateRouteUsed: txResult?.privateRouteUsed,
  }, strategyName);
  await saveState();
  await sendTradeAlert('SELL', tokenData, proceedsUsd, pnl);

  return {
    proceedsUsd,
    pnl,
    filledBaseQty,
    fullyClosed,
  };
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

    const txResult = await withTimeout(
      exchange.executeSell(tokenData.address, quantityToSell),
      sellTimeoutMs,
      `Sell execution timed out for ${tokenData.symbol} after ${sellTimeoutMs}ms`
    );
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

    recordExchangeFailure(chainName, error.message);
    logger.error(`SELL execution failed for ${tokenData.symbol}: ${error.message}`);
    const recentFailedExitExists = Array.isArray(portfolio.trades) && portfolio.trades.some((trade) => {
      if (!trade || trade.type !== 'SELL_FAILED') return false;
      if (String(trade.address || '').toLowerCase() !== String(tokenData.address || '').toLowerCase()) return false;
      if (String(trade.reason || '') !== String(reason || '')) return false;
      const ageMs = Date.now() - Date.parse(trade.timestamp || 0);
      return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 15 * 60 * 1000;
    });
    if (!recentFailedExitExists) {
      const attemptedQuantity = Number(quantityToSell || position?.quantity || 0);
      const attemptedPrice = Number(tokenData.price || position?.currentPrice || position?.entryPrice || 0);
      logTrade(
        'SELL_FAILED',
        tokenData,
        attemptedQuantity,
        attemptedQuantity > 0 && attemptedPrice > 0 ? attemptedQuantity * attemptedPrice : null,
        null,
        null,
        position?.signalSource || 'technical',
        reason || errorText,
        {
          error: errorText,
          requestedQuantity: attemptedQuantity,
          requestedValueUsd: attemptedQuantity > 0 && attemptedPrice > 0 ? attemptedQuantity * attemptedPrice : null,
        },
        strategyName
      );
    }
    const kucoinInsufficientBalance = chainName === 'kucoin' && /balance insufficient|\b200004\b/i.test(errorText);
    if (kucoinInsufficientBalance) {
      logger.warn(`Detected KuCoin balance mismatch on SELL for ${tokenData.symbol}; forcing immediate balance/state reconciliation`);
      await updateWalletBalance().catch((syncErr) => {
        logger.error(`Forced wallet balance refresh after sell failure failed: ${syncErr.message}`);
      });
      await reconcileWalletPositions().catch((syncErr) => {
        logger.error(`Forced wallet reconciliation after sell failure failed: ${syncErr.message}`);
      });
      await saveState().catch((syncErr) => {
        logger.error(`State save after sell-failure reconciliation failed: ${syncErr.message}`);
      });
    }
    await sendErrorAlert(`SELL failed for ${tokenData.symbol}: ${error.message}`);
  } finally {
    if (position && typeof position === 'object') {
      position.exitInProgress = false;
    }
  }
}

function getTradePositionKey(trade = {}) {
  const chainKey = normalizeChainKey(trade.chainKey || trade.chain);
  const address = String(trade.address || '').trim().toLowerCase();
  const strategyName = String(trade.strategy || 'momentum').toLowerCase();
  if (!chainKey || !address) return '';
  return `${chainKey}:${address}:${strategyName}`;
}

function getTradeRepairSignature(trade = {}) {
  return [
    String(trade.timestamp || ''),
    String(trade.type || ''),
    normalizeChainKey(trade.chainKey || trade.chain),
    String(trade.address || '').trim().toLowerCase(),
    String(trade.strategy || 'momentum').toLowerCase(),
    String(trade.reason || ''),
  ].join('|');
}

function patchTradeCopiesBySignature(signature, mutator) {
  const targets = [
    portfolio.trades,
    ...Object.values(portfolio.strategies || {}).map((bucket) => bucket?.trades),
  ];

  for (const list of targets) {
    if (!Array.isArray(list)) continue;
    for (const trade of list) {
      if (!trade || getTradeRepairSignature(trade) !== signature) continue;
      mutator(trade);
    }
  }
}

function getLotStateBeforeTrade(targetTrade) {
  const chronological = [...(portfolio.trades || [])]
    .filter((trade) => trade && typeof trade === 'object')
    .sort((left, right) => {
      const l = Date.parse(left.timestamp || '') || 0;
      const r = Date.parse(right.timestamp || '') || 0;
      return l - r;
    });
  const lotStates = new Map();

  for (const trade of chronological) {
    if (trade === targetTrade) {
      const current = lotStates.get(getTradePositionKey(trade)) || { qty: 0, cost: 0 };
      return {
        openQtyBefore: Number(current.qty || 0),
        openCostBefore: Number(current.cost || 0),
      };
    }

    const key = getTradePositionKey(trade);
    if (!key) continue;

    const current = lotStates.get(key) || { qty: 0, cost: 0 };
    if (trade.type === 'BUY') {
      current.qty += extractFilledBaseQty(trade, Number(trade.quantity || 0));
      current.cost += extractFilledQuoteUsd(trade, Number(trade.valueUsd || 0));
    } else if (trade.type === 'SELL') {
      const soldQty = Math.min(extractFilledBaseQty(trade, Number(trade.quantity || 0)), current.qty);
      const soldFraction = current.qty > 0 ? Math.max(0, Math.min(1, soldQty / current.qty)) : 0;
      current.cost = Math.max(0, current.cost - (current.cost * soldFraction));
      current.qty = Math.max(0, current.qty - soldQty);
    }

    lotStates.set(key, current);
  }

  return { openQtyBefore: 0, openCostBefore: 0 };
}

function applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd = 0, options = {}) {
  ensureStatsShape();
  const strategyStats = portfolio.strategies?.[strategyName]?.stats;
  if (!strategyStats) return;

  if (options.applyCashLedger !== false && Number.isFinite(Number(proceedsUsd)) && Number(proceedsUsd) > 0) {
    portfolio.balance += Number(proceedsUsd);
  }

  portfolio.stats.totalPnl += pnl;
  strategyStats.totalPnl += pnl;
  if (pnl >= 0) {
    portfolio.stats.grossProfit += pnl;
    strategyStats.grossProfit += pnl;
  } else {
    portfolio.stats.grossLoss += Math.abs(pnl);
    strategyStats.grossLoss += Math.abs(pnl);
  }

  portfolio.stats.closedTrades += 1;
  strategyStats.closedTrades += 1;
  portfolio.stats.executions += 1;
  strategyStats.executions += 1;

  if (pnl >= 0) {
    portfolio.stats.wins += 1;
    strategyStats.wins += 1;
    portfolio.stats.consecutiveLosses = 0;
    strategyStats.consecutiveLosses = 0;
  } else {
    portfolio.stats.losses += 1;
    strategyStats.losses += 1;
    portfolio.stats.consecutiveLosses = Number(portfolio.stats.consecutiveLosses || 0) + 1;
    portfolio.stats.maxConsecutiveLosses = Math.max(
      Number(portfolio.stats.maxConsecutiveLosses || 0),
      Number(portfolio.stats.consecutiveLosses || 0)
    );
    strategyStats.consecutiveLosses = Number(strategyStats.consecutiveLosses || 0) + 1;
    strategyStats.maxConsecutiveLosses = Math.max(
      Number(strategyStats.maxConsecutiveLosses || 0),
      Number(strategyStats.consecutiveLosses || 0)
    );
  }
}

function recoverSellFailureTrade(failedTrade, recoveredTxResult, options = {}) {
  if (!failedTrade || failedTrade.type !== 'SELL_FAILED') return false;

  const strategyName = String(failedTrade.strategy || 'momentum').toLowerCase();
  const requestedQty = Number(failedTrade.requestedQuantity || failedTrade.quantity || 0);
  let recoveredQty = extractFilledBaseQty(recoveredTxResult, requestedQty);
  if (!Number.isFinite(recoveredQty) || recoveredQty <= 0) {
    return false;
  }

  const { openQtyBefore, openCostBefore } = getLotStateBeforeTrade(failedTrade);
  if (!Number.isFinite(openQtyBefore) || openQtyBefore <= 0 || !Number.isFinite(openCostBefore) || openCostBefore <= 0) {
    logger.warn(`Skipping SELL_FAILED repair for ${failedTrade.symbol}: could not reconstruct pre-sell cost basis`);
    return false;
  }

  recoveredQty = Math.min(recoveredQty, openQtyBefore);
  const realizedPrice = extractExecutionPriceUsd(recoveredTxResult, Number(failedTrade.expectedPrice || failedTrade.price || 0));
  let proceedsUsd = extractFilledQuoteUsd(recoveredTxResult, 0);
  if (!Number.isFinite(proceedsUsd) || proceedsUsd <= 0) {
    proceedsUsd = recoveredQty * realizedPrice;
  }
  if (!Number.isFinite(proceedsUsd) || proceedsUsd <= 0) {
    logger.warn(`Skipping SELL_FAILED repair for ${failedTrade.symbol}: missing recovered proceeds`);
    return false;
  }

  const filledFraction = openQtyBefore > 0 ? Math.max(0, Math.min(1, recoveredQty / openQtyBefore)) : 0;
  const costBasisPortion = openCostBefore * filledFraction;
  const pnl = proceedsUsd - costBasisPortion;
  const expectedPrice = Number(failedTrade.expectedPrice || failedTrade.price || realizedPrice || 0);
  const slippageBps = calcSlippageBps(expectedPrice, realizedPrice);
  const fillDiscrepancyPct = calcDiscrepancyPct(requestedQty || recoveredQty, recoveredQty);
  const signature = getTradeRepairSignature(failedTrade);
  const recoveredTimestamp = recoveredTxResult.timestamp || failedTrade.timestamp || new Date().toISOString();

  patchTradeCopiesBySignature(signature, (trade) => {
    trade.type = 'SELL';
    trade.txid = recoveredTxResult.txid || trade.txid || null;
    trade.timestamp = recoveredTimestamp;
    trade.price = realizedPrice > 0 ? round(realizedPrice, 8) : trade.price;
    trade.pnl = round(pnl);
    trade.quantity = round(recoveredQty, 6);
    trade.valueUsd = round(proceedsUsd);
    trade.expectedPrice = expectedPrice > 0 ? round(expectedPrice, 8) : null;
    trade.realizedPrice = realizedPrice > 0 ? round(realizedPrice, 8) : null;
    trade.slippageBps = slippageBps === null ? null : round(slippageBps, 2);
    trade.requestedQuantity = requestedQty > 0 ? round(requestedQty, 8) : trade.requestedQuantity || null;
    trade.filledQuantity = round(recoveredQty, 8);
    trade.requestedValueUsd = Number.isFinite(Number(trade.requestedValueUsd))
      ? trade.requestedValueUsd
      : (requestedQty > 0 && expectedPrice > 0 ? round(requestedQty * expectedPrice) : null);
    trade.filledValueUsd = round(proceedsUsd);
    trade.fillDiscrepancyPct = fillDiscrepancyPct === null ? null : round(fillDiscrepancyPct, 4);
    trade.executionStatus = 'confirmed';
    trade.recoveredFromFailure = true;
    trade.recoverySource = 'exchange_trade_history';
    if (Number.isFinite(Number(recoveredTxResult.blockNumber))) {
      trade.blockNumber = Number(recoveredTxResult.blockNumber);
    }
    if (Number.isFinite(Number(recoveredTxResult.confirmations))) {
      trade.confirmations = Number(recoveredTxResult.confirmations);
    }
  });

  if (recoveredTxResult?.txid) {
    setExecutionJournalState(recoveredTxResult.txid, {
      status: 'confirmed',
      type: 'SELL',
      chain: normalizeChainKey(failedTrade.chainKey || failedTrade.chain),
      chainKey: normalizeChainKey(failedTrade.chainKey || failedTrade.chain),
      symbol: failedTrade.symbol,
      address: failedTrade.address,
      blockNumber: Number(recoveredTxResult?.blockNumber || 0) || null,
      confirmations: Number(recoveredTxResult?.confirmations || 0) || null,
      createdAt: recoveredTimestamp,
    });
  }

  applyRecoveredClosedTradeStats(strategyName, pnl, proceedsUsd, options);
  logger.warn(`Recovered historical SELL for ${failedTrade.symbol}: PnL ${pnl >= 0 ? '+' : ''}$${round(pnl).toFixed(2)}`);
  return true;
}

async function repairAmbiguousKucoinSellFailures(options = {}) {
  const kucoinExchange = exchanges?.kucoin;
  if (!kucoinExchange || typeof kucoinExchange.findRecentTradeFill !== 'function') {
    return 0;
  }

  const candidates = [...(portfolio.trades || [])]
    .filter((trade) => {
      if (!trade || trade.type !== 'SELL_FAILED') return false;
      if (normalizeChainKey(trade.chainKey || trade.chain) !== 'kucoin') return false;
      if (!trade.address) return false;
      const positionKey = buildTokenKey('kucoin', trade.address);
      if (portfolio.positions?.[positionKey]) return false;
      const failedAtMs = Date.parse(trade.timestamp || '') || 0;
      return !portfolio.trades.some((other) => {
        if (!other || other === trade || other.type !== 'SELL') return false;
        if (String(other.address || '').toLowerCase() !== String(trade.address || '').toLowerCase()) return false;
        if (String(other.strategy || 'momentum').toLowerCase() !== String(trade.strategy || 'momentum').toLowerCase()) return false;
        const otherAtMs = Date.parse(other.timestamp || '') || 0;
        return otherAtMs >= failedAtMs - 60_000;
      });
    })
    .sort((left, right) => (Date.parse(left.timestamp || '') || 0) - (Date.parse(right.timestamp || '') || 0));

  let repaired = 0;
  const consumedTxids = new Set();

  for (const trade of candidates) {
    const tradeTimestampMs = Date.parse(trade.timestamp || '') || Date.now();
    const expectedQty = Number(trade.requestedQuantity || trade.quantity || 0);
    const recoveredTxResult = await kucoinExchange.findRecentTradeFill(trade.address, 'sell', expectedQty, {
      sinceMs: Math.max(0, tradeTimestampMs - 60_000),
      lookbackMs: 20 * 60 * 1000,
      targetTimestampMs: tradeTimestampMs,
    });
    if (!recoveredTxResult?.txid || consumedTxids.has(String(recoveredTxResult.txid))) continue;
    if (!recoverSellFailureTrade(trade, recoveredTxResult, options)) continue;
    consumedTxids.add(String(recoveredTxResult.txid));
    repaired += 1;
  }

  if (repaired > 0) {
    refreshPerformanceMetrics();
    recordPortfolioSnapshot('repair_sell_failure');
    await saveState();
  }

  return repaired;
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
  const tokenAddress = String(payload.tokenAddress || '').trim();
  const chainKey = normalizeChainKey(payload.chain);
  const strategyName = String(payload.strategy || 'momentum').toLowerCase();
  const strategyCfg = config.strategies?.[strategyName] || config.strategies?.momentum;
  const backtestMode = String(payload.mode || 'standard').toLowerCase();

  if (!strategyCfg) {
    throw new Error(`Unknown backtest strategy: ${strategyName}`);
  }
  
  if (!tokenAddress && backtestMode !== 'portfolio') {
    return null;
  }

  const priceHistory = backtestMode !== 'portfolio' ? getHistorySeries(strategy.priceHistory, chainKey, tokenAddress) : [];
  const volumeHistory = backtestMode !== 'portfolio' ? getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress) : [];

  const baseOptions = {
    startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
    tradePct: Number(payload.tradePct || 0.05),
    riskSettings: config.risk,
    entrySlippagePct: Number(payload.entrySlippagePct ?? 0.8),
    exitSlippagePct: Number(payload.exitSlippagePct ?? 1.2),
    entryFeePct: Number(payload.entryFeePct ?? 0.15),
    exitFeePct: Number(payload.exitFeePct ?? 0.15),
    outageChancePct: Number(payload.outageChancePct ?? 0.5),
    ruinDrawdownLimitPct: Number(payload.ruinDrawdownLimitPct ?? config.backtest?.monteCarloRuinThresholdPct ?? config.risk?.dailyDrawdownLimitPct ?? 15),
    monteCarloRuns: Number(payload.monteCarloRuns ?? 2000),
    seed: Number(payload.seed || 1337),
    chainKey: chainKey || 'solana',
    strategySettings: strategyCfg,
    historyLength: Number(payload.historyLength || 200),
  };

  let result = null;

  // Select backtest mode
  switch (backtestMode) {
    case 'portfolio':
      result = runPortfolioBacktest((priceHist, volHist, stratSettings, opts) => {
        return runBacktest(priceHist, volHist, stratSettings, opts);
      }, baseOptions);
      break;

    case 'walk_forward':
      result = runWalkForwardBacktest(priceHistory, volumeHistory, strategyCfg, {
        ...baseOptions,
        trainPct: Number(payload.trainPct || 0.7),
        validatePct: Number(payload.validatePct || 0.15),
      });
      break;

    case 'regime':
      result = runRegimeSpecificBacktest(priceHistory, volumeHistory, strategyCfg, {
        ...baseOptions,
        targetRegime: String(payload.targetRegime || 'uptrend'),
        regimeWindowBars: Number(payload.regimeWindowBars || 20),
      });
      break;

    case 'regime_aware':
      result = runBacktestWithRegimes(priceHistory, volumeHistory, strategyCfg, {
        ...baseOptions,
        regimeWindowBars: Number(payload.regimeWindowBars || 20),
      });
      break;

    case 'standard':
    default:
      result = runBacktest(priceHistory, volumeHistory, strategyCfg, baseOptions);
  }

  if (!result) {
    return null;
  }

  const tracked = backtestMode !== 'portfolio' ? getTrackedTokens().find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase()) : null;
  const response = {
    tokenAddress: backtestMode === 'portfolio' ? 'portfolio_6_assets' : tokenAddress,
    symbol: backtestMode === 'portfolio' ? 'PORTFOLIO' : (tracked?.symbol || tokenAddress.slice(0, 10)),
    chain: backtestMode === 'portfolio' ? 'multi' : (tracked?.chain || null),
    strategy: strategyName,
    backtestMode,
    historyBars: backtestMode === 'portfolio' ? baseOptions.historyLength : priceHistory.length,
    generatedAt: new Date().toISOString(),
    ...result,
  };

  marketState.backtests.unshift(response);
  if (marketState.backtests.length > 10) {
    marketState.backtests.pop();
  }

  return response;
}

async function seedBacktestData(priceHistory, volumeHistory, tokenAddress, chain) {
  const { seedHistoricalData } = require('./utils/backtest-utils');
  
  const result = seedHistoricalData(priceHistory, volumeHistory, tokenAddress, chain, strategy.priceHistory);
  
  if (result.success) {
    // Also store volume history with matching key
    const key = `${String(chain).toLowerCase()}:${String(tokenAddress).toLowerCase()}`;
    strategy.volumeHistory = strategy.volumeHistory || {};
    strategy.volumeHistory[key] = volumeHistory.slice();
    
    logger.info(`Backtest data seeded for ${tokenAddress} on ${chain}: ${result.dataPoints} bars`);
  }
  
  return result;
}

async function runSimulationRequest(payload) {
  const result = runPaperSimulation({
    scenario: String(payload.scenario || 'bull'),
    periods: Number(payload.periods || 160),
    startPrice: Number(payload.startPrice || 1),
    baseVolume: Number(payload.baseVolume || 100000),
    seed: payload.seed || `sim-${Date.now()}`,
    strategySettings: config.strategy,
    riskSettings: config.risk,
    startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
    tradePct: Number(payload.tradePct || 0.05),
  });

  if (!result) {
    return null;
  }

  const response = {
    generatedAt: new Date().toISOString(),
    ...result,
  };

  marketState.simulations.unshift({
    generatedAt: response.generatedAt,
    scenario: response.scenario,
    tradeCount: response.tradeCount,
    totalReturn: response.totalReturn,
    winRate: response.winRate,
  });
  if (marketState.simulations.length > 10) {
    marketState.simulations.pop();
  }

  return response;
}

async function previewAiSignal(payload) {
  const chainKey = normalizeChainKey(payload.chain);
  const tokenAddress = String(payload.tokenAddress || '').trim();
  const strategyName = String(payload.strategy || 'momentum').toLowerCase();

  if (!chainKey || !tokenAddress || !exchanges[chainKey]) {
    return null;
  }

  const tokenData = await exchanges[chainKey].getTokenData(tokenAddress);
  if (!tokenData) {
    return null;
  }

  tokenData.address = tokenData.address || tokenAddress;
  tokenData.chainKey = chainKey;
  tokenData.chain = CHAIN_LABELS[chainKey];
  tokenData.strategyKey = buildTokenKey(chainKey, tokenData.address);

  const evaluation = await strategy.evaluateForStrategy(tokenData.strategyKey, strategyName, tokenData);
  if (!evaluation.details) evaluation.details = {};
  let aiDecision = null;

  if (config.anthropic.enabled && config.anthropic.apiKey) {
    aiDecision = await AITradeBrain.evaluateToken(tokenData, {
      ...evaluation.details,
      signal: evaluation.signal,
      strategy: strategyName,
      confidenceFloor: Number(config.strategies?.[strategyName]?.aiConfidenceFloor || config.risk.aiConfidenceFloor || 70),
    });

    if (aiDecision) {
      recordBrainSuccess(tokenData, aiDecision);
    } else {
      recordBrainFailure('AI preview unavailable');
    }
  } else {
    refreshBrainAvailability();
  }

  return {
    token: {
      symbol: tokenData.symbol,
      address: tokenData.address,
      chain: tokenData.chain,
      price: round(tokenData.price, 8),
      liquidityUsd: round(tokenData.liquidityUsd || 0),
      volume24h: round(tokenData.volume24h || 0),
      priceChange24h: round(tokenData.priceChange24h || 0, 2),
    },
    technical: {
      signal: evaluation.signal,
      details: evaluation.details,
    },
    ai: aiDecision,
  };
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

  // Item 9: skip new-entry scans outside configured UTC trading windows.
  // Exit checks (runStrategyExitCycle) run independently and are unaffected.
  if (!isWithinTradingWindow()) {
    logger.debug(`[${strategyName}] Outside trading window — skipping entry scan`);
    return;
  }

  startFilterCycle(strategyName);
  const cycleStats = filterStatsState.currentCycle?.[strategyName] || null;
  loopLocks[lockKey] = true;
  refreshScanInFlightFlag();
  try {
    if (strategyName === 'momentum') {
      // Run KuCoin on an independent lock so long KuCoin scans do not block
      // fresh momentum cycles for Solana/BSC/Base.
      const kucoinScanPromise = runDetachedKucoinMomentumScan(cycleStats).catch((error) => {
        logger.error(`Detached KuCoin momentum scan failed: ${error.message}`);
      });

      await Promise.allSettled([
        ...(isStrategyScanEnabled('solana', strategyName) ? [scanChain('solana', exchanges.solana, strategyName, { cycleStats })] : []),
        ...(isStrategyScanEnabled('bsc', strategyName) ? [scanChain('bsc', exchanges.bsc, strategyName, { cycleStats })] : []),
        ...(isStrategyScanEnabled('base', strategyName) ? [scanChain('base', exchanges.base, strategyName, { cycleStats })] : []),
        kucoinScanPromise,
      ]);
    } else {
      const kucoinScanGate = shouldPauseKucoinEntryScans();
      if (kucoinScanGate.paused) {
        logger.info(
          `KuCoin ${strategyName} entry scan paused: ${kucoinScanGate.reason}. ` +
          `Resuming warm-up ${(kucoinScanGate.msUntilReset / 60000).toFixed(0)}m before daily reset.`
        );
      } else {
      await Promise.allSettled([
        ...(isStrategyScanEnabled('kucoin', strategyName) ? [scanChain('kucoin', exchanges.kucoin, strategyName, { cycleStats })] : []),
      ]);
      }
    }
    recordPortfolioSnapshot(`scan_${strategyName}`);
    await saveState();
    loopLastCompletedAt[lockKey] = Date.now();
  } finally {
    finalizeFilterCycle(strategyName);
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

    // Reset stale-data skip counter unconditionally so a cycle with no positions clears stale alerts.
    if (portfolio.strategies?.[strategyName]?.stats) {
      portfolio.strategies[strategyName].stats.skippedExitChecks = 0;
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
            if (portfolio.strategies?.[strategyName]?.stats) {
              portfolio.strategies[strategyName].stats.skippedExitChecks =
                Number(portfolio.strategies[strategyName].stats.skippedExitChecks || 0) + 1;
            }
            return;
          }
        }

        tokenData.address = tokenData.address || position.address;
        tokenData.chainKey = chainName;
        tokenData.chain = CHAIN_LABELS[chainName];
        tokenData.strategyKey = position.strategyKey || buildTokenKey(chainName, tokenData.address);

        await strategy.refreshHistoryFromCandles(tokenData.strategyKey, tokenData, strategyName);

        strategy.recordTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));

        if (position.partialFillRetry) {
          logger.warn(`Retrying exit for partially filled position ${position.symbol || position.address} on ${chainName}`);
          await executeSell(chainName, exchange, tokenData, position, 1, 'PARTIAL_FILL_RETRY');
          return;
        }

        await checkExitConditions(chainName, exchange, tokenData, position, { staleData: Boolean(tokenData._stale) });
      } catch (error) {
        if (portfolio.strategies?.[strategyName]?.stats) {
          portfolio.strategies[strategyName].stats.skippedExitChecks =
            Number(portfolio.strategies[strategyName].stats.skippedExitChecks || 0) + 1;
          portfolio.strategies[strategyName].stats.exitErrorCount =
            Number(portfolio.strategies[strategyName].stats.exitErrorCount || 0) + 1;
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

        strategy.recordTick(tokenData.strategyKey, Number(tokenData.price), Number(tokenData.volume24h || 0));

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

  // Boot cycles immediately.
  runStrategyScanCycle('momentum').catch((error) => logger.error(`Initial momentum scan failed: ${error.message}`));
  runStrategyScanCycle('swing').catch((error) => logger.error(`Initial swing scan failed: ${error.message}`));
  runStrategyExitCycle('momentum').catch((error) => logger.error(`Initial momentum exit check failed: ${error.message}`));
  runStrategyExitCycle('swing').catch((error) => logger.error(`Initial swing exit check failed: ${error.message}`));
  if (config.risk?.realtimeStopLossEnabled !== false) {
    runRealtimeRiskStopCycle().catch((error) => logger.error(`Initial realtime stop check failed: ${error.message}`));
  }

  startOracleStopWatchers();
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
  ensureStatsShape();
  refreshPerformanceMetrics();

  logger.info('=========================================');
  logger.info(' DEX Trading Bot - Starting up (dual strategy)');
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
    seedBacktestData,
    runSimulationRequest,
    previewAiSignal,
    resetPaperPortfolio,
    onConfigUpdated,
    getHealthStatus,
    strategy,
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
  });
  dashboardServer = dashboard?.server;
  dashboardWss = dashboard?.wss;

  restartLoopSchedulers();
  await reconcileExecutionJournal().catch((error) => logger.error(`Initial execution journal reconciliation failed: ${error.message}`));

  setInterval(() => {
    refreshDependencyHealth().catch((error) => logger.error(`Dependency health refresh failed: ${error.message}`));
  }, 2 * 60 * 1000);

  setInterval(() => {
    walletMonitor.monitor().catch((error) => logger.error(`Wallet monitor error: ${error.message}`));
  }, 5 * 60 * 1000);

  setInterval(() => {
    reconcileExecutionJournal().catch((error) => logger.error(`Execution journal reconciliation error: ${error.message}`));
  }, 60 * 1000);

  setInterval(() => {
    sendHeartbeat().catch((error) => logger.error(`Heartbeat error: ${error.message}`));
  }, 60 * 60 * 1000);

  setInterval(() => {
    cleanupNonTradeLogs(logger).catch((error) => logger.error(`Log cleanup scheduler error: ${error.message}`));
  }, getLogCleanupIntervalMs());

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

process.on('uncaughtException', async (error) => {
  await shutdownAndExit(1, 'Uncaught exception — runtime crash recovery engaged', error);
});

process.on('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  await shutdownAndExit(1, 'Unhandled promise rejection — runtime crash recovery engaged', error);
});

main().catch((error) => {
  shutdownAndExit(1, `Fatal startup error: ${error.message}`, error);
});
