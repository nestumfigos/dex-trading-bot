'use strict';

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const { PublicKey } = require('@solana/web3.js');
const config = require('../../config');
const logger = require('../utils/logger');

const PAIR_CREATED_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
];

class WebSocketDiscovery extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.starting = false;
    this.providers = {};
    this.contracts = {};
    this.cleanups = [];
    this.startupExchanges = {};
    this.bootstrapRetry = { timer: null, attempts: 0 };
    this.bootstrapFailed = false;
    this.pollingFallbackActive = false;
    this.reconnectState = {
      bsc: { timer: null, attempts: 0 },
      base: { timer: null, attempts: 0 },
    };
    this.tokensByChain = {
      solana: new Map(),
      bsc: new Map(),
      base: new Map(),
      kucoin: new Map(),
    };
    this.status = {
      startedAt: null,
      solana: { connected: false, subscriptions: 0, lastError: null, lastEventAt: null },
      bsc: { connected: false, subscriptions: 0, lastError: null, lastEventAt: null },
      base: { connected: false, subscriptions: 0, lastError: null, lastEventAt: null },
      kucoin: { connected: false, subscriptions: 0, lastError: null, lastEventAt: null },
    };

    this.ignoredByChain = {
      bsc: new Set([
        String(config.bsc.wbnb || '').toLowerCase(),
        String(config.bsc.busd || '').toLowerCase(),
      ]),
      base: new Set([
        String(config.base.weth || '').toLowerCase(),
      ]),
      solana: new Set(),
      kucoin: new Set(),
    };
  }

  clearReconnectTimer(chainKey) {
    const state = this.reconnectState[chainKey];
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  scheduleEvmReconnect(chainKey, wsUrl, factoryAddress) {
    const state = this.reconnectState[chainKey];
    if (!state || !this.started) return;
    if (state.timer) return;

    const baseDelayMs = Math.max(500, Number(config.discovery?.reconnectBaseDelayMs || 2000));
    const maxDelayMs = Math.max(baseDelayMs, Number(config.discovery?.reconnectMaxDelayMs || 30000));
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(state.attempts, 8)));
    state.attempts += 1;

    logger.warn(`WS discovery ${chainKey} reconnect scheduled in ${delayMs}ms (attempt ${state.attempts})`);

    state.timer = setTimeout(async () => {
      state.timer = null;
      if (!this.started) return;
      await this.startEvmPairCreated(chainKey, wsUrl, factoryAddress);
    }, delayMs);
  }

  clearBootstrapRetryTimer() {
    if (!this.bootstrapRetry?.timer) return;
    clearTimeout(this.bootstrapRetry.timer);
    this.bootstrapRetry.timer = null;
  }

  scheduleBootstrapRetry() {
    if (this.started) return;
    if (this.bootstrapRetry.timer) return;

    const maxBootstrapRetries = Math.max(1, Number(config.discovery?.maxBootstrapRetries || 20));
    if (this.bootstrapRetry.attempts >= maxBootstrapRetries) {
      this.bootstrapFailed = true;
      this.pollingFallbackActive = true;
      logger.warn('WS discovery bootstrap retries exhausted; switching to polling-only discovery until restart', {
        reason: 'websocket discovery bootstrap failed',
        attempts: this.bootstrapRetry.attempts,
        maxBootstrapRetries,
      });
      return;
    }

    const baseDelayMs = 30_000;
    const maxDelayMs = Math.max(baseDelayMs, Number(config.discovery?.maxRetryDelayMs || 300000));
    const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(this.bootstrapRetry.attempts, 8)));
    this.bootstrapRetry.attempts += 1;

    logger.warn(`WS discovery bootstrap retry scheduled in ${delayMs}ms (attempt ${this.bootstrapRetry.attempts})`);

    this.bootstrapRetry.timer = setTimeout(async () => {
      this.bootstrapRetry.timer = null;
      if (this.started) return;
      await this.start(this.startupExchanges || {});
    }, delayMs);
  }

  normalizeAddress(chainKey, address) {
    const raw = String(address || '').trim();
    if (!raw) return '';
    return chainKey === 'solana' ? raw : raw.toLowerCase();
  }

  cleanupExpired(chainKey) {
    const map = this.tokensByChain[chainKey];
    if (!map) return;
    const now = Date.now();
    const ttlMs = Math.max(60_000, Number(config.discovery?.tokenTtlMinutes || 180) * 60_000);

    for (const [key, row] of map.entries()) {
      if ((now - row.discoveredAt) > ttlMs) {
        map.delete(key);
      }
    }
  }

  addToken(chainKey, address, source, extra = {}) {
    const map = this.tokensByChain[chainKey];
    if (!map) return;

    const normalized = this.normalizeAddress(chainKey, address);
    if (!normalized) return;

    if (this.ignoredByChain[chainKey]?.has(normalized)) return;

    this.cleanupExpired(chainKey);

    const now = Date.now();
    map.set(normalized, {
      address: normalized,
      discoveredAt: now,
      source,
      ...extra,
    });

    const max = Math.max(50, Number(config.discovery?.maxTrackedTokensPerChain || 500));
    if (map.size > max) {
      const oldest = [...map.entries()].sort((a, b) => a[1].discoveredAt - b[1].discoveredAt).slice(0, map.size - max);
      oldest.forEach(([key]) => map.delete(key));
    }

    this.status[chainKey].lastEventAt = new Date(now).toISOString();
    this.emit('token', { chainKey, address: normalized, source, discoveredAt: now });
  }

  getRecentTokens(chainKey, maxAgeMs = null) {
    const map = this.tokensByChain[chainKey];
    if (!map) return [];

    this.cleanupExpired(chainKey);

    const now = Date.now();
    const ttlMs = maxAgeMs === null
      ? Math.max(60_000, Number(config.discovery?.tokenTtlMinutes || 180) * 60_000)
      : Math.max(10_000, Number(maxAgeMs || 0));

    return [...map.values()]
      .filter((row) => (now - row.discoveredAt) <= ttlMs)
      .sort((a, b) => b.discoveredAt - a.discoveredAt)
      .map((row) => row.address);
  }

  isQuietHoursActive() {
    if (config.discovery?.quietMarketThreshold === false) {
      return false;
    }

    const start = Number(config.discovery?.quietHoursStart ?? 0);
    const end = Number(config.discovery?.quietHoursEnd ?? 6);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return false;
    }

    const normalizedStart = ((Math.floor(start) % 24) + 24) % 24;
    const normalizedEnd = ((Math.floor(end) % 24) + 24) % 24;
    if (normalizedStart === normalizedEnd) {
      return false;
    }

    const hour = new Date().getHours();
    if (normalizedStart < normalizedEnd) {
      return hour >= normalizedStart && hour < normalizedEnd;
    }
    return hour >= normalizedStart || hour < normalizedEnd;
  }

  computeEventStale(lastEventAt, connected) {
    if (!connected) {
      return { eventStale: false, staleSuppressed: false };
    }

    const staleMs = Math.max(1, Number(config.discovery?.eventStaleMinutes || 30)) * 60_000;
    const lastEventAtMs = Date.parse(lastEventAt || '');
    const stale = !Number.isFinite(lastEventAtMs) || (Date.now() - lastEventAtMs) > staleMs;
    const quietHoursActive = this.isQuietHoursActive();
    if (stale && quietHoursActive) {
      return { eventStale: false, staleSuppressed: true };
    }
    return { eventStale: stale, staleSuppressed: false };
  }

  getStatus() {
    const quietHoursActive = this.isQuietHoursActive();
    const chainStatus = ['solana', 'bsc', 'base', 'kucoin'].reduce((acc, chainKey) => {
      const state = this.status[chainKey] || {};
      const connected = Boolean(state.connected);
      const stale = this.computeEventStale(state.lastEventAt, connected);
      acc[chainKey] = {
        ...state,
        connected,
        eventStale: stale.eventStale,
        staleSuppressed: stale.staleSuppressed,
      };
      return acc;
    }, {});

    return {
      ...this.status,
      ...chainStatus,
      enabled: config.discovery?.websocketEnabled !== false,
      bootstrapFailed: this.bootstrapFailed,
      pollingFallbackActive: this.pollingFallbackActive,
      bootstrapRetryAttempts: this.bootstrapRetry.attempts,
      quietHoursActive,
      queueSizes: {
        solana: this.tokensByChain.solana.size,
        bsc: this.tokensByChain.bsc.size,
        base: this.tokensByChain.base.size,
        kucoin: this.tokensByChain.kucoin.size,
      },
    };
  }

  async start(exchanges = {}) {
    if (this.started || this.starting) return;
    if (config.discovery?.websocketEnabled === false) {
      logger.info('WebSocket discovery disabled by config');
      return;
    }

    this.starting = true;
    this.startupExchanges = exchanges || {};
    this.bootstrapFailed = false;
    this.pollingFallbackActive = false;

    try {
      const results = await Promise.allSettled([
        this.startEvmPairCreated('bsc', config.bsc?.wsUrl, config.bsc?.pancakeFactoryV2),
        this.startEvmPairCreated('base', config.base?.wsUrl, config.base?.baseswapFactory),
        this.startSolanaPrograms(exchanges.solana?.connection),
      ]);

      const successfulStarts = results
        .filter((row) => row.status === 'fulfilled')
        .map((row) => row.value)
        .filter((value) => Number(value || 0) > 0)
        .reduce((sum, value) => sum + Number(value || 0), 0);

      this.started = successfulStarts > 0;
      this.status.startedAt = this.started ? new Date().toISOString() : null;

      if (this.started) {
        this.clearBootstrapRetryTimer();
        this.bootstrapRetry.attempts = 0;
        this.bootstrapFailed = false;
        this.pollingFallbackActive = false;
        logger.info(`WebSocket discovery initialized with ${successfulStarts} active subscription(s)`);
      } else {
        logger.warn('WebSocket discovery initialization failed: no active subscriptions established');
        this.scheduleBootstrapRetry();
      }
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    const cleanups = [...this.cleanups];
    this.cleanups = [];
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (_) {
        // Ignore individual cleanup failures.
      }
    });

    Object.values(this.providers).forEach((provider) => {
      try {
        provider?.destroy?.();
      } catch (_) {
        // Ignore provider close failures.
      }
    });

    this.providers = {};
    this.contracts = {};
    this.clearBootstrapRetryTimer();
    this.bootstrapRetry.attempts = 0;
    this.bootstrapFailed = false;
    this.pollingFallbackActive = false;
    Object.keys(this.reconnectState).forEach((chainKey) => {
      this.clearReconnectTimer(chainKey);
      this.reconnectState[chainKey].attempts = 0;
    });
    this.status.bsc.connected = false;
    this.status.bsc.subscriptions = 0;
    this.status.base.connected = false;
    this.status.base.subscriptions = 0;
    this.status.solana.connected = false;
    this.status.solana.subscriptions = 0;
    this.starting = false;
    this.started = false;
  }

  async startEvmPairCreated(chainKey, wsUrl, factoryAddress) {
    const chainCfg = config.discovery?.[chainKey] || {};
    if (chainCfg.enabled === false) return 0;
    if (!wsUrl || !factoryAddress) {
      this.status[chainKey].lastError = 'Missing websocket URL or factory address';
      return 0;
    }

    try {
      const provider = new ethers.WebSocketProvider(wsUrl);
      const contract = new ethers.Contract(factoryAddress, PAIR_CREATED_ABI, provider);
      const ws = provider.websocket || provider._websocket;
      let disconnected = false;

      const handleDisconnect = (reason) => {
        if (disconnected) return;
        disconnected = true;

        const message = typeof reason === 'string' ? reason : (reason?.message || String(reason || 'unknown disconnect'));
        this.status[chainKey].connected = false;
        this.status[chainKey].subscriptions = 0;
        this.status[chainKey].lastError = message;

        try {
          contract.off('PairCreated', onPairCreated);
          provider.off('error', onError);
          if (ws && typeof ws.off === 'function') {
            ws.off('close', onClose);
          }
          provider.destroy?.();
        } catch (_) {
          // Ignore disconnect cleanup failures.
        }

        if (this.providers[chainKey] === provider) delete this.providers[chainKey];
        if (this.contracts[chainKey] === contract) delete this.contracts[chainKey];

        logger.warn(`WS discovery ${chainKey} disconnected: ${message}`);
        this.scheduleEvmReconnect(chainKey, wsUrl, factoryAddress);
      };

      const onPairCreated = (token0, token1, pairAddress) => {
        this.addToken(chainKey, token0, 'pair_created', { pairAddress });
        this.addToken(chainKey, token1, 'pair_created', { pairAddress });
      };

      contract.on('PairCreated', onPairCreated);

      const onError = (error) => {
        this.status[chainKey].lastError = error?.message || String(error);
        logger.warn(`WS discovery ${chainKey} error: ${this.status[chainKey].lastError}`);
        handleDisconnect(error);
      };

      const onClose = (code) => {
        handleDisconnect(`socket closed (${code})`);
      };

      provider.on('error', onError);
      if (ws && typeof ws.on === 'function') {
        ws.on('close', onClose);
      }

      this.providers[chainKey] = provider;
      this.contracts[chainKey] = contract;
      this.status[chainKey].connected = true;
      this.status[chainKey].subscriptions = 1;
      this.status[chainKey].lastError = null;
      this.clearReconnectTimer(chainKey);
      if (this.reconnectState[chainKey]) {
        this.reconnectState[chainKey].attempts = 0;
      }

      this.cleanups.push(() => {
        contract.off('PairCreated', onPairCreated);
        provider.off('error', onError);
        if (ws && typeof ws.off === 'function') {
          ws.off('close', onClose);
        }
      });

      logger.info(`WS discovery active for ${chainKey} PairCreated events`);
      return 1;
    } catch (error) {
      this.status[chainKey].connected = false;
      this.status[chainKey].subscriptions = 0;
      this.status[chainKey].lastError = error.message;
      logger.warn(`Failed to start WS discovery for ${chainKey}: ${error.message}`);
      return 0;
    }
  }

  async startSolanaPrograms(connection) {
    const solCfg = config.discovery?.solana || {};
    if (solCfg.enabled === false) return 0;

    const programIds = Array.isArray(solCfg.programIds) ? solCfg.programIds : [];
    if (!connection || !programIds.length) {
      this.status.solana.lastError = 'Missing Solana connection or program IDs';
      return 0;
    }

    let subscriptions = 0;

    await Promise.allSettled(programIds.map(async (programId) => {
      const pubkey = new PublicKey(programId);

      const subId = connection.onLogs(pubkey, async (logInfo) => {
        try {
          const signature = logInfo?.signature;
          if (!signature) return;

          const tx = await connection.getParsedTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          const pre = tx?.meta?.preTokenBalances || [];
          const post = tx?.meta?.postTokenBalances || [];
          const mints = new Set([
            ...pre.map((row) => row?.mint).filter(Boolean),
            ...post.map((row) => row?.mint).filter(Boolean),
          ]);

          for (const mint of mints) {
            this.addToken('solana', mint, 'program_logs', { programId, signature });
          }
        } catch (error) {
          this.status.solana.lastError = error.message;
        }
      }, 'confirmed');

      subscriptions += 1;
      this.cleanups.push(() => {
        connection.removeOnLogsListener(subId).catch(() => undefined);
      });
    }));

    this.status.solana.connected = subscriptions > 0;
    this.status.solana.subscriptions = subscriptions;
    this.status.solana.lastError = subscriptions > 0 ? null : this.status.solana.lastError;

    if (subscriptions > 0) {
      logger.info(`WS discovery active for Solana logs (${subscriptions} program subscriptions)`);
    }

    return subscriptions;
  }
}

module.exports = WebSocketDiscovery;
