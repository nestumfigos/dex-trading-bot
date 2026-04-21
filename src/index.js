'use strict';

require('dotenv').config();
const cron = require('node-cron');
const { ethers } = require('ethers');
const config = require('../config');
const logger = require('./utils/logger');
const RiskGuardian = require('./risk/guardian');
const MomentumStrategy = require('./strategy/momentum');
const JupiterExchange = require('./exchanges/jupiter');
const PancakeSwapExchange = require('./exchanges/pancakeswap');
const BaseSwapExchange = require('./exchanges/baseswap');
const KuCoinExchange = require('./exchanges/kucoin');
const WebSocketDiscovery = require('./discovery/ws-discovery');
const { startDashboard } = require('./dashboard');
const WalletMonitor = require('./wallet-monitor');
const AITradeBrain = require('./ai/ensemble');
const { runBacktest } = require('./backtest');
const { runPaperSimulation } = require('./simulation');
const { sendHeartbeat, sendTradeAlert, sendErrorAlert } = require('./telegram');
const { validateConfig } = require('./utils/validate-config');
const fs = require('fs').promises;
const redis = require('redis');

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

const oraclePriceCache = new Map();
const oracleWsProviders = {
  bsc: null,
  base: null,
};
const oracleFeedSubscriptions = {
  bsc: [],
  base: [],
};

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
  const ttlMs = Math.max(500, Number(config.risk?.oraclePriceCacheMs || 2000));
  if (cached && (Date.now() - cached.at) < ttlMs) {
    return cached.value;
  }

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
  oraclePriceCache.set(cacheKey, { value: price, at: Date.now() });
  return price;
}

async function getPythPriceUsd(feedId) {
  if (!feedId) return null;
  const cacheKey = `pyth:${String(feedId).toLowerCase()}`;
  const cached = oraclePriceCache.get(cacheKey);
  const ttlMs = Math.max(500, Number(config.risk?.oraclePriceCacheMs || 2000));
  if (cached && (Date.now() - cached.at) < ttlMs) {
    return cached.value;
  }

  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${encodeURIComponent(feedId)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) return null;
  const body = await res.json();
  const parsed = Array.isArray(body?.parsed) ? body.parsed[0] : null;
  const p = Number(parsed?.price?.price || 0);
  const expo = Number(parsed?.price?.expo || 0);
  const price = p * (10 ** expo);
  if (!Number.isFinite(price) || price <= 0) return null;
  oraclePriceCache.set(cacheKey, { value: price, at: Date.now() });
  return price;
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
    if (price >= position.entryPrice * trailingStartMultiplier) {
      position.highestPrice = Math.max(Number(position.highestPrice || 0), price);
      position.trailingStop = position.highestPrice * (1 - trailingStopPct / 100);
    }

    if (position.trailingStop && price <= position.trailingStop) {
      logger.warn(`ORACLE TRAILING STOP (feed event) for ${position.symbol} on ${chain}: ${price.toFixed(8)} <= ${Number(position.trailingStop).toFixed(8)}`);
      await executeSell(chain, exchange, tokenData, position, 1, 'ORACLE_TRAILING_STOP');
      continue;
    }

    if (price <= position.stopLoss) {
      logger.warn(`ORACLE STOP LOSS (feed event) for ${position.symbol} on ${chain}: ${price.toFixed(8)} <= ${Number(position.stopLoss).toFixed(8)}`);
      await executeSell(chain, exchange, tokenData, position, 1, 'ORACLE_STOP_LOSS');
    }
  }
}

function stopOracleStopWatchers() {
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
              oraclePriceCache.set(cacheKey, { value: price, at: Date.now() });
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
    }
  });
}

const portfolio = {
  startingBalance: config.paperTrading ? config.paperBalance : 0,
  balance: config.paperTrading ? config.paperBalance : 0,
  walletBalanceUsd: null,
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
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
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
const processStartedAtMs = Date.now();

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
    `technicalBlocked=${cycleStats.technicalBlocked} aiBlocked=${cycleStats.aiBlocked} riskBlocked=${cycleStats.riskBlocked}`
  );
}

const marketState = {
  trackedTokens: {},
  signals: [],
  backtests: [],
  simulations: [],
};

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
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: {
      momentum: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
    },
  },
  bsc: {
    name: 'PancakeSwap (BSC)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: {
      momentum: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
    },
  },
  base: {
    name: 'BaseSwap (Base)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: {
      momentum: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
    },
  },
  kucoin: {
    name: 'KuCoin (CEX)',
    status: 'idle',
    currentToken: '-',
    tokensScanned: 0,
    lastUpdate: null,
    suppressedTokenErrors: 0,
    strategies: {
      momentum: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
      swing: { status: 'idle', currentToken: '-', tokensScanned: 0, lastUpdate: null },
    },
  },
};

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
  swingScan: false,
  momentumExit: false,
  swingExit: false,
  realtimeStop: false,
  swingRefresh: false,
};

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
  scanInFlight = Boolean(loopLocks.momentumScan || loopLocks.swingScan);
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
  const dustThresholdUsd = Math.max(0, Number(config.risk?.reconciliationDustUsd || 5));

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

    const walletKeys = new Set(
      (Array.isArray(walletPositions) ? walletPositions : [])
        .map((position) => buildTokenKey(chainName, position?.address || position?.symbol || ''))
        .filter((key) => !key.endsWith(':'))
    );

    walletKeys.forEach((key) => {
      if (stateKeys.has(key)) return;
      const entry = {
        chain: chainName,
        type: 'wallet_untracked_position',
        key,
      };
      discrepancies.push(entry);
      logger.error('State reconciliation mismatch', {
        reason: 'unrecovered position detected',
        ...entry,
      });
    });

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
    });
  }));

  portfolio.stateReconciliation = {
    lastRunAt: new Date().toISOString(),
    discrepancies,
  };
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

  chainState.tokensScanned = Number(momentum.tokensScanned || 0) + Number(swing.tokensScanned || 0);
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
    recordRuntimeDelta();
    const state = {
      portfolio,
      marketState,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const enabledDiscoveryChains = [
    config.discovery?.solana?.enabled !== false ? 'solana' : null,
    config.discovery?.bsc?.enabled !== false ? 'bsc' : null,
    config.discovery?.base?.enabled !== false ? 'base' : null,
  ].filter(Boolean);
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
  if (discoveryBootstrapFailed) {
    degradedReasons.push('ws_discovery_bootstrap_failed_polling_only');
  }
  const discoveryStarted = Boolean(discovery?.startedAt);
  if (discoveryEnabled && !discoveryStarted && !discoveryBootstrapFailed) {
    degradedReasons.push('ws_discovery_unavailable_polling_only');
  }
  const anyDiscoveryEventStale = discoveryEventStaleness.some((row) => row.stale);
  const discoveryBlockingFailure = discoveryEnabled
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
    && !signalDrought.global;

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
  if (signalDrought.global) {
    unhealthyReasons.push('signal_drought');
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

function getPortfolioSnapshot() {
  const positions = getOpenPositions();
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const exposureUsd = positions.reduce((sum, position) => sum + position.positionValueUsd, 0);
  const walletCash = config.paperTrading ? portfolio.balance : Number(portfolio.walletBalanceUsd ?? portfolio.balance);
  const baseline = portfolio.startingBalance > 0 ? portfolio.startingBalance : walletCash;
  const equity = walletCash + exposureUsd;
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

  return {
    mode: config.paperTrading ? 'paper' : 'live',
    startingBalance: round(baseline),
    cashBalance: round(walletCash),
    equity: round(equity),
    exposureUsd: round(exposureUsd),
    realizedPnl: round(portfolio.stats.totalPnl),
    unrealizedPnl: round(unrealizedPnl),
    totalPnl: round(totalPnl),
    totalReturnPct: totalReturnPct === null ? null : round(totalReturnPct),
    openPositionCount: positions.length,
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
    positions,
    recentTrades: portfolio.trades.slice(0, 30),
    pnlHistory: portfolio.pnlHistory.slice(-180),
  };
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

function getTrackedTokens() {
  return Object.values(marketState.trackedTokens)
    .sort((a, b) => new Date(b.lastScannedAt || 0) - new Date(a.lastScannedAt || 0))
    .slice(0, 100);
}

function recordSignalEvent(entry) {
  marketState.signals.unshift(entry);
  if (marketState.signals.length > 120) {
    marketState.signals.pop();
  }
}

function updateTrackedToken(chainName, tokenData, evaluation) {
  const key = `${chainName}:${String(tokenData.address || '').toLowerCase()}`;
  const previous = marketState.trackedTokens[key];
  const snapshot = {
    key,
    symbol: tokenData.symbol,
    address: tokenData.address,
    chain: tokenData.chain,
    chainKey: chainName,
    strategy: evaluation.strategy || null,
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
    },
    hasOpenPosition: Boolean(portfolio.positions[buildTokenKey(chainName, tokenData.address)]),
    lastScannedAt: new Date().toISOString(),
  };

  marketState.trackedTokens[key] = snapshot;

  const trackedKeys = Object.values(marketState.trackedTokens)
    .sort((a, b) => new Date(a.lastScannedAt) - new Date(b.lastScannedAt))
    .map((item) => item.key);

  const excess = trackedKeys.length - 100;
  if (excess > 0) {
    trackedKeys.slice(0, excess).forEach((removeKey) => {
      delete marketState.trackedTokens[removeKey];
    });
  }

  const shouldLog = !previous
    || previous.finalSignal !== snapshot.finalSignal
    || previous.signalSource !== snapshot.signalSource
    || snapshot.finalSignal === 'BUY'
    || snapshot.finalSignal === 'SELL';

  if (shouldLog) {
    recordSignalEvent({
      timestamp: snapshot.lastScannedAt,
      symbol: snapshot.symbol,
      address: snapshot.address,
      chain: snapshot.chain,
      chainKey: snapshot.chainKey,
      strategy: snapshot.strategy,
      price: snapshot.price,
      technicalSignal: snapshot.technicalSignal,
      finalSignal: snapshot.finalSignal,
      signalSource: snapshot.signalSource,
      aiReason: snapshot.aiReason,
      aiConfidence: snapshot.aiConfidence,
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

// Trade schema: `quantity` always represents the confirmed on-chain filled base-token amount,
// not the requested/intended amount. Requested amounts are stored in executionMeta.requestedQuantity.
function logTrade(type, tokenData, quantity, valueUsd, txid, pnl = null, signalSource = 'technical', reason = '', executionMeta = {}, strategyName = 'momentum') {
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
    timestamp: new Date().toISOString(),
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

function buildDashboardState() {
  const runtime = getRuntimeSnapshot();
  const trackedTokens = getTrackedTokens();
  const performanceGate = risk.checkPerformanceGate(portfolio.stats || {});

  return {
    timestamp: new Date().toISOString(),
    uptimeSeconds: runtime.uptimeSeconds,
    totalRuntimeSeconds: runtime.totalRuntimeSeconds,
    mode: config.paperTrading ? 'paper' : 'live',
    portfolio: getPortfolioSnapshot(),
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
      currentCycle: filterStatsState.currentCycle,
      recentCycles: filterStatsState.recentCycles,
    },
    market: {
      trackedTokens,
      recentSignals: marketState.signals.slice(0, 24),
      backtests: marketState.backtests.slice(0, 5),
      simulations: marketState.simulations.slice(0, 5),
      chainSummary: Object.keys(CHAIN_LABELS).map((chainKey) => {
        const chainTokens = trackedTokens.filter((token) => token.chainKey === chainKey);
        return {
          chainKey,
          name: scanStatus[chainKey].name,
          tracked: chainTokens.length,
          buySignals: chainTokens.filter((token) => token.finalSignal === 'BUY').length,
          openPositions: chainTokens.filter((token) => token.hasOpenPosition).length,
          status: scanStatus[chainKey].status,
          currentToken: scanStatus[chainKey].currentToken,
          tokensScanned: scanStatus[chainKey].tokensScanned,
          lastUpdate: scanStatus[chainKey].lastUpdate,
          suppressedTokenErrors: scanStatus[chainKey].suppressedTokenErrors || 0,
          strategies: scanStatus[chainKey].strategies,
        };
      }),
    },
  };
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

async function getTokensForStrategy(chainName, exchange, strategyName = 'momentum') {
  const watchlistTokens = watchlists[chainName] || [];
  const discoveryStatus = wsDiscovery.getStatus();
  const forcePollingOnly = strategyName === 'momentum' && Boolean(discoveryStatus?.bootstrapFailed);

  if (strategyName === 'swing') {
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
            logger.debug(`Swing candidate token error on ${chainName}: addr=${address}, ${err.message}`);
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
      return [...new Set(watchlistTokens)];
    }
    if (mode === 'hybrid') {
      return [...new Set([...watchlistTokens, ...newTokens])];
    }
    return [...new Set(newTokens)];
  }

  if (mode === 'hybrid') {
    return [...new Set([...watchlistTokens, ...wsTokens, ...newTokens])];
  }
  return [...new Set([...wsTokens, ...newTokens])];
}

async function scanChain(chainName, exchange, strategyName = 'momentum') {
  const status = getStrategyScanStatus(chainName, strategyName);

  if (!isExchangeAvailable(chainName)) {
    status.status = 'degraded';
    status.currentToken = 'skipped (exchange unavailable)';
    status.lastUpdate = new Date().toISOString();
    syncChainScanStatus(chainName);
    return;
  }

  logger.info(`Scanning ${exchange.name} for ${strategyName} strategy...`);
  status.status = 'scanning';
  status.currentToken = 'discovering tokens';
  status.tokensScanned = 0;
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

    const allTokens = await getTokensForStrategy(chainName, exchange, strategyName);
    const candidateTokens = newListings.length > 0
      ? [...new Set([...newListings, ...allTokens])]
      : allTokens;

    const batchSize = chainName === 'kucoin' ? 20 : 50; // Increased for parallel processing
    for (let i = 0; i < candidateTokens.length; i += batchSize) {
      const batch = candidateTokens.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(async (tokenAddress) => {
        status.currentToken = tokenAddress;
        status.tokensScanned += 1;
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

      await sleep(500); // Delay between batches
    }
    recordExchangeSuccess(chainName);
  } catch (error) {
    status.status = 'error';
    recordExchangeFailure(chainName, error.message);
    logger.error(`Scan failed on ${chainName}: ${error.message}`);
  } finally {
    status.status = 'idle';
    status.currentToken = '-';
    status.lastUpdate = new Date().toISOString();
    syncChainScanStatus(chainName);
  }
}

async function processToken(chainName, exchange, tokenAddress, options = {}) {
  const tokenData = await exchange.getTokenData(tokenAddress);
  if (!tokenData || !tokenData.price) {
    return;
  }

  const tokenKey = buildTokenKey(chainName, tokenAddress);
  tokenData.address = tokenData.address || tokenAddress;
  tokenData.chainKey = chainName;
  tokenData.chain = CHAIN_LABELS[chainName];
  tokenData.strategyKey = tokenKey;

  const scanStrategy = String(options.scanStrategy || '').toLowerCase();
  const scanState = getStrategyScanStatus(chainName, scanStrategy);
  if (scanState) {
    scanState.currentToken = `${tokenData.symbol} (${tokenAddress})`;
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
    return;
  }

  // Change 1: Round-trip friction pre-check — block tokens where implied tax/friction exceeds threshold.
  if ((chainName === 'bsc' || chainName === 'base') && !tokenData.isHoneypot && typeof exchange.checkRoundTripFriction === 'function') {
    const frictionResult = await exchange.checkRoundTripFriction(tokenAddress, 0.01).catch(() => ({ blocked: false }));
    if (frictionResult.blocked) {
      logger.warn(`Skipping ${tokenData.symbol} (${chainName}): ${frictionResult.reason} (${(frictionResult.frictionPct || 0).toFixed(1)}%)`);
      return;
    }
  }

  if (
    chainName === 'bsc'
    && config.execution?.requirePrivateTxForBsc
    && !config.paperTrading
    && typeof exchange.hasPrivateTxRoute === 'function'
    && !exchange.hasPrivateTxRoute()
  ) {
    logger.warn(`Skipping ${tokenData.symbol} (bsc): private transaction route required but unavailable`);
    return;
  }

  const applicability = strategy.determineApplicableStrategies(tokenData);
  const strategyOrder = ['swing', 'momentum'];
  const forced = Array.isArray(options.forcedStrategies) ? options.forcedStrategies : null;
  const applicableStrategies = strategyOrder
    .filter((name) => applicability[name])
    .filter((name) => !forced || forced.includes(name));
  if (!applicableStrategies.length) {
    return;
  }

  for (const strategyName of applicableStrategies) {
    const evaluation = await strategy.evaluateForStrategy(tokenKey, strategyName, tokenData);
    if (!evaluation.details) evaluation.details = {};
    const cycleStats = filterStatsState.currentCycle?.[strategyName] || null;
    let aiBlockedThisToken = false;

    let finalSignal = evaluation.signal;
    let signalSource = 'technical';

    if (cycleStats) {
      cycleStats.evaluated += 1;
      if (Array.isArray(evaluation.details.externalReasons)) {
        evaluation.details.externalReasons.forEach((reason) => classifyFilterReason(cycleStats, reason));
      }
      if (Boolean(evaluation.details.technicalBlocked) || finalSignal !== 'BUY') {
        cycleStats.technicalBlocked += 1;
      }
    }

    if (config.anthropic.enabled && evaluation.signal === 'BUY') {
      if (Date.now() >= aiCircuit.cooldownUntil) {
        const strategyAiFloor = Number(config.strategies?.[strategyName]?.aiConfidenceFloor || config.risk.aiConfidenceFloor || 70);
        const aiDecision = await AITradeBrain.evaluateToken(tokenData, {
          ...evaluation.details,
          signal: evaluation.signal,
          strategy: strategyName,
          confidenceFloor: strategyAiFloor,
        });

        if (aiDecision && aiDecision.signal) {
          aiCircuit.failures = 0;
          finalSignal = aiDecision.signal;
          signalSource = 'AI';
          evaluation.details.aiReason = aiDecision.reason;
          evaluation.details.aiConfidence = aiDecision.confidence;
          evaluation.details.aiRiskFlags = aiDecision.riskFlags;
          recordBrainSuccess(tokenData, aiDecision);

          if (Number(aiDecision.confidence || 0) < strategyAiFloor) {
            finalSignal = 'HOLD';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_confidence_floor'])];
            if (cycleStats) {
              cycleStats.aiBlocked += 1;
              aiBlockedThisToken = true;
            }
          }
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
      } else {
        // Expected behavior: AI in cooldown, using technical signal. Log debug only.
        logger.debug(`AI in cooldown; using technical signal for ${strategyName} (not a failure)`);
      }
    } else {
      refreshBrainAvailability();
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
      }
      continue;
    }

    logger.info(`BUY signal on ${tokenData.symbol} (${chainName}, ${strategyName}) from ${signalSource}: RSI ${evaluation.details.rsi}, Vol spike ${evaluation.details.volumeSpike}x`);

    tokenData.signalSource = signalSource;
    tokenData.aiReason = evaluation.details.aiReason;
    tokenData.aiConfidence = evaluation.details.aiConfidence;
    tokenData.entryTriggerTimeframe = evaluation.details.triggerTimeframe || 'unknown';

    const riskCheck = await risk.canTrade(tokenData, strategy.priceHistory || {}, strategyName);
    if (!riskCheck.allowed) {
      logger.warn(`Trade blocked for ${tokenData.symbol} (${strategyName}): ${riskCheck.reason}`);
      if (cycleStats) {
        cycleStats.riskBlocked += 1;
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
  if (tokenData.price >= position.entryPrice * trailingStartMultiplier) {
    position.highestPrice = Math.max(Number(position.highestPrice || 0), Number(tokenData.price));
    position.trailingStop = position.highestPrice * (1 - trailingStopPct / 100);
  }

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
    logger.info(`TRAILING STOP triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'TRAILING_STOP');
    return;
  }

  if (tokenData.price <= position.stopLoss) {
    logger.info(`STOP LOSS triggered for ${tokenData.symbol}: ${(currentProfit * 100).toFixed(1)}%`);
    await executeSell(chainName, exchange, tokenData, position, 1, 'STOP_LOSS');
    return;
  }

  const openedAtMs = Date.parse(position.openedAt || position.createdAt || '') || Date.now();
  const minutesInTrade = Math.max(0, (Date.now() - openedAtMs) / 60000);
  const maxHoldMinutes = Number(strategyCfg.maxHoldMinutes || config.risk?.maxHoldMinutesGlobal || 4320);
  if (Number.isFinite(maxHoldMinutes) && maxHoldMinutes > 0 && minutesInTrade >= maxHoldMinutes) {
    logger.info(`TIME STOP triggered for ${tokenData.symbol}: held ${minutesInTrade.toFixed(0)}m >= ${maxHoldMinutes}m`);
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

async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum') {
  const sizeUsd = risk.positionSize(tokenData, strategyName);
  if (sizeUsd < 10) {
    logger.warn(`Position size $${sizeUsd.toFixed(2)} too small, skipping`);
    return;
  }

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

    try {
    let txResult;
    const expectedEntryPrice = Number(tokenData.price);

    if (chainName === 'solana') {
      txResult = await exchange.executeBuy(tokenData.address, sizeUsd);
    } else if (chainName === 'kucoin') {
      txResult = await exchange.executeBuy(tokenData.address, sizeUsd);
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
      txResult = await exchange.executeBuy(tokenData.address, nativeAmount);
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
    const hasExchangeFilledData = [
      txResult?.filledBaseQty,
      txResult?.filledQuantity,
      txResult?.filledQty,
      txResult?.executedBaseQty,
      txResult?.filledQuoteUsd,
      txResult?.filledQuoteQty,
      txResult?.executedQuoteUsd,
      txResult?.cost,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
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
    if (filledQuoteUsd <= 0) {
      filledQuoteUsd = requestedQuoteUsd;
    }
    if (!hasExchangeFilledData) {
      logger.warn(`BUY fill reconciliation fallback used for ${tokenData.symbol} on ${chainName} (exchange did not provide confirmed fill amounts)`);
    }

    const entrySlippageBps = calcSlippageBps(expectedEntryPrice, realizedEntryPrice);
    if (entrySlippageBps !== null) {
      portfolio.stats.totalSlippageBps += entrySlippageBps;
      portfolio.stats.slippageSamples += 1;
      portfolio.strategies[strategyName].stats.totalSlippageBps += entrySlippageBps;
      portfolio.strategies[strategyName].stats.slippageSamples += 1;
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
      aiReason: tokenData.aiReason || '',
      aiConfidence: tokenData.aiConfidence || 0,
      entryLiquidityUsd: Number(tokenData.liquidityUsd || 0),
      entryTopHoldersPct: Number(tokenData.topHoldersPct || 0),
      entryBuyRatioPct10m: (() => {
        const buys = Number(tokenData.buyTx10m || 0);
        const sells = Number(tokenData.sellTx10m || 0);
        const total = buys + sells;
        return total > 0 ? (buys / total) * 100 : 0;
      })(),
      entryHolderCount: Number(tokenData.holderCount || 0),
      highestPrice: realizedEntryPrice,
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
      blockNumber: txResult?.blockNumber,
      confirmations: txResult?.confirmations,
      privateRouteUsed: txResult?.privateRouteUsed,
    }, strategyName);
    await sendTradeAlert('BUY', tokenData, filledQuoteUsd);
    await saveState();
  } catch (error) {
    recordExchangeFailure(chainName, error.message);
    logger.error(`BUY execution failed for ${tokenData.symbol}: ${error.message}`);
    await sendErrorAlert(`BUY failed for ${tokenData.symbol}: ${error.message}`);
  }
  } finally {
    release();
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

  logger.info(`Executing SELL: ${tokenData.symbol} @ $${tokenData.price} | selling ${round(fraction * 100, 1)}%`);

  try {
    let txResult;

    // All chains use the same executeSell interface
    txResult = await exchange.executeSell(tokenData.address, quantityToSell);

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
    const hasExchangeFilledData = [
      txResult?.filledBaseQty,
      txResult?.filledQuantity,
      txResult?.filledQty,
      txResult?.executedBaseQty,
      txResult?.filledQuoteUsd,
      txResult?.filledQuoteQty,
      txResult?.executedQuoteUsd,
      txResult?.cost,
    ].some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    let filledBaseQty = extractFilledBaseQty(txResult, quantityToSell);
    if (!Number.isFinite(filledBaseQty) || filledBaseQty <= 0) {
      filledBaseQty = quantityToSell;
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
      : fraction;
    const costBasisPortion = Number(position.costBasisUsd || 0) * filledFraction;

    const exitSlippageBps = calcSlippageBps(expectedExitPrice, realizedExitPrice);
    if (exitSlippageBps !== null) {
      portfolio.stats.totalSlippageBps += exitSlippageBps;
      portfolio.stats.slippageSamples += 1;
      portfolio.strategies[strategyName].stats.totalSlippageBps += exitSlippageBps;
      portfolio.strategies[strategyName].stats.slippageSamples += 1;
    }

    const proceedsUsd = filledQuoteUsd;
    const pnl = proceedsUsd - costBasisPortion;
    const fillDiscrepancyPct = calcDiscrepancyPct(quantityToSell, filledBaseQty);

    portfolio.balance += proceedsUsd;
    portfolio.stats.totalPnl += pnl;
    portfolio.strategies[strategyName].stats.totalPnl += pnl;
    if (pnl >= 0) {
      portfolio.stats.grossProfit += pnl;
      portfolio.strategies[strategyName].stats.grossProfit += pnl;
    } else {
      portfolio.stats.grossLoss += Math.abs(pnl);
      portfolio.strategies[strategyName].stats.grossLoss += Math.abs(pnl);
    }

    position.quantity = Math.max(0, Number(position.quantity || 0) - filledBaseQty);
    position.costBasisUsd = Math.max(0, Number(position.costBasisUsd || 0) - costBasisPortion);
    position.currentPrice = realizedExitPrice;
    position.realizedPnl = Number(position.realizedPnl || 0) + pnl;

    const quantityDustThreshold = Math.max(0.000001, positionQuantityBefore * 0.0001);
    const costBasisDustThreshold = Math.max(0.01, Number(position.initialSizeUsd || 0) * 0.0001);
    const nearFullSellRequested = fraction >= 0.999999;

    position.partialFillRetry = Boolean(nearFullSellRequested && position.quantity > quantityDustThreshold);
    position.lastExitReconciliation = {
      reason,
      timestamp: new Date().toISOString(),
      requestedQuantity: quantityToSell,
      filledQuantity: filledBaseQty,
      remainingQuantity: position.quantity,
      requestedValueUsd: quantityToSell * realizedExitPrice,
      filledValueUsd: proceedsUsd,
      remainingCostBasisUsd: position.costBasisUsd,
      discrepancyPct: fillDiscrepancyPct,
      partialFillRetry: position.partialFillRetry,
    };

    if (position.partialFillRetry) {
      logger.warn(
        `Partial full-exit fill for ${tokenData.symbol} on ${chainName}: requested=${quantityToSell.toFixed(8)}, ` +
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
      strategy.clearHistory(position.strategyKey || positionKey);
      portfolio.stats.closedTrades += 1;
      portfolio.strategies[strategyName].stats.closedTrades += 1;
      if (finalTradePnl >= 0) {
        portfolio.stats.wins += 1;
        portfolio.strategies[strategyName].stats.wins += 1;
        portfolio.stats.consecutiveLosses = 0;
        portfolio.strategies[strategyName].stats.consecutiveLosses = 0;
      } else {
        portfolio.stats.losses += 1;
        portfolio.strategies[strategyName].stats.losses += 1;
        portfolio.stats.consecutiveLosses = Number(portfolio.stats.consecutiveLosses || 0) + 1;
        portfolio.stats.maxConsecutiveLosses = Math.max(
          Number(portfolio.stats.maxConsecutiveLosses || 0),
          Number(portfolio.stats.consecutiveLosses || 0)
        );
        portfolio.strategies[strategyName].stats.consecutiveLosses = Number(portfolio.strategies[strategyName].stats.consecutiveLosses || 0) + 1;
        portfolio.strategies[strategyName].stats.maxConsecutiveLosses = Math.max(
          Number(portfolio.strategies[strategyName].stats.maxConsecutiveLosses || 0),
          Number(portfolio.strategies[strategyName].stats.consecutiveLosses || 0)
        );
      }
    }

    portfolio.stats.executions += 1;
    portfolio.strategies[strategyName].stats.executions += 1;
    refreshPerformanceMetrics();
    recordPortfolioSnapshot(fullyClosed ? 'close' : 'partial');
    logTrade('SELL', tokenData, filledBaseQty, proceedsUsd, txResult.txid, pnl, position.signalSource || 'technical', reason, {
      expectedPrice: expectedExitPrice,
      realizedPrice: realizedExitPrice,
      slippageBps: exitSlippageBps,
      requestedQuantity: quantityToSell,
      filledQuantity: filledBaseQty,
      requestedValueUsd: quantityToSell * realizedExitPrice,
      filledValueUsd: proceedsUsd,
      fillDiscrepancyPct,
      blockNumber: txResult?.blockNumber,
      confirmations: txResult?.confirmations,
      privateRouteUsed: txResult?.privateRouteUsed,
    }, strategyName);
    await sendTradeAlert('SELL', tokenData, proceedsUsd, pnl);
    await saveState();
  } catch (error) {
    recordExchangeFailure(chainName, error.message);
    logger.error(`SELL execution failed for ${tokenData.symbol}: ${error.message}`);
    await sendErrorAlert(`SELL failed for ${tokenData.symbol}: ${error.message}`);
  } finally {
    if (position && typeof position === 'object') {
      position.exitInProgress = false;
    }
  }
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
  if (!tokenAddress) {
    return null;
  }

  const priceHistory = getHistorySeries(strategy.priceHistory, chainKey, tokenAddress);
  const volumeHistory = getHistorySeries(strategy.volumeHistory, chainKey, tokenAddress);

  const result = runBacktest(priceHistory, volumeHistory, config.strategy, {
    startingBalance: Number(payload.startingBalance || config.paperBalance || 10000),
    tradePct: Number(payload.tradePct || 0.05),
    riskSettings: config.risk,
    entrySlippagePct: Number(payload.entrySlippagePct ?? 0.8),
    exitSlippagePct: Number(payload.exitSlippagePct ?? 1.2),
    entryFeePct: Number(payload.entryFeePct ?? 0.15),
    exitFeePct: Number(payload.exitFeePct ?? 0.15),
    outageChancePct: Number(payload.outageChancePct ?? 0.5),
    monteCarloRuns: Number(payload.monteCarloRuns ?? 2000),
    seed: Number(payload.seed || 1337),
  });

  if (!result) {
    return null;
  }

  const tracked = getTrackedTokens().find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase());
  const response = {
    tokenAddress,
    symbol: tracked?.symbol || tokenAddress.slice(0, 10),
    chain: tracked?.chain || null,
    historyBars: priceHistory.length,
    generatedAt: new Date().toISOString(),
    ...result,
  };

  marketState.backtests.unshift(response);
  if (marketState.backtests.length > 10) {
    marketState.backtests.pop();
  }

  return response;
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
  loopLocks[lockKey] = true;
  refreshScanInFlightFlag();
  try {
    await Promise.allSettled([
      scanChain('solana', exchanges.solana, strategyName),
      scanChain('bsc', exchanges.bsc, strategyName),
      scanChain('base', exchanges.base, strategyName),
      scanChain('kucoin', exchanges.kucoin, strategyName),
    ]);
    recordPortfolioSnapshot(`scan_${strategyName}`);
    await saveState();
    loopLastCompletedAt[lockKey] = Date.now();
  } finally {
    finalizeFilterCycle(strategyName);
    loopLocks[lockKey] = false;
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
        if (tokenData.price >= position.entryPrice * trailingStartMultiplier) {
          position.highestPrice = Math.max(Number(position.highestPrice || 0), Number(tokenData.price));
          position.trailingStop = position.highestPrice * (1 - trailingStopPct / 100);
        }

        if (position.trailingStop && tokenData.price <= position.trailingStop) {
          logger.warn(`FAST TRAILING STOP triggered for ${tokenData.symbol}: price ${Number(tokenData.price).toFixed(8)} <= stop ${Number(position.trailingStop).toFixed(8)}${tokenData._oracle ? ' (oracle)' : ''}`);
          await executeSell(chainName, exchange, tokenData, position, 1, tokenData._oracle ? 'ORACLE_TRAILING_STOP' : 'FAST_TRAILING_STOP');
          return;
        }

        if (tokenData.price <= position.stopLoss) {
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

  // Keep a handle in scanTimer for backward compatibility with state/debug expectations.
  scanTimer = momentumScanTimer = setInterval(() => {
    runStrategyScanCycle('momentum').catch((error) => logger.error(`Momentum scan loop error: ${error.message}`));
  }, momentumScanMs);

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
    if (driftPct > 25) {
      portfolio.balanceDriftHalt = true;
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
  logger.info(`  DeFiLlama Filter: ${filterCfg.defillama?.enabled !== false ? `enabled (${filterCfg.defillama?.minApyRequired || 2}% min APY)` : 'disabled'}`);
  logger.info('=========================================');

  if (!config.paperTrading) {
    logger.warn('LIVE TRADING ACTIVE - real funds at risk. You have 10 seconds to abort (Ctrl+C).');
    await sleep(config.bot.liveAbortDelayMs);
  }

  recordPortfolioSnapshot('boot');
  await initializeExchanges();
  await wsDiscovery.start(exchanges);

  if (!config.paperTrading) {
    await updateWalletBalance();
    const deployedCapitalUsd = Object.values(portfolio.positions || {})
      .reduce((sum, pos) => sum + Number(pos?.costBasisUsd || pos?.initialSizeUsd || 0), 0);
    portfolio.balance = Math.max(0, (portfolio.walletBalanceUsd || 0) - deployedCapitalUsd);
    portfolio.startingBalance = portfolio.balance;
    logger.info(`Startup cash balance: walletBalance=$${portfolio.walletBalanceUsd}, deployedCapital=$${round(deployedCapitalUsd)}, freeCash=$${portfolio.balance}`);
  }

  startDashboard(portfolio, {
    marketState,
    getTrackedTokens,
    getDashboardState: buildDashboardState,
    runBacktestRequest,
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
    clearSafeMode: () => {
      clearSafeModeState();
      restartLoopSchedulers();
      return {
        safeMode: portfolio.safeMode,
        statePersistenceError: portfolio.statePersistenceError,
      };
    },
  });

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
