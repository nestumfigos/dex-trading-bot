'use strict';
// PARITY NOTE (2026-05-31 audit cycle-2 P2): this paper-branch kucoin.js is
// structurally older than the live-branch counterpart (dex-trading-bot/src/
// exchanges/kucoin.js). Live has KuCoin-native `clientOid` idempotency
// (_genClientOid + _findFilledKucoinOrder + clientOid on every createOrder
// call) so a retry after a timeout cross-checks prior attempts instead of
// double-firing. Paper does NOT have this. The risk is bounded today because
// executeBuy/executeSell short-circuit at `config.paperTrading` (lines ~579
// and ~759) before reaching createOrder — paper trades are simulated as
// `paper_tx_*` and never hit KuCoin. If PAPER_TRADING is ever flipped off
// against this branch (or the file is promoted to a live profile), paper
// will lose retry-safety. Tracked follow-up: port the full clientOid path
// from the live branch (~362 lines of semantic diff) while preserving
// paper's `adjustForTimeDifference` + KC-API-TIMESTAMP retry additions.
const ccxt = require('ccxt');
const config = require('../../config');
const logger = require('../utils/logger');
const { getTokenMetrics } = require('../utils/coingecko');

const LEVERAGED_TOKEN_PATTERN = /3L|3S|5L|5S|10L|10S|BEAR|BULL|UP|DOWN/i;

function normalizeTimestampMs(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  // KuCoin timestamps may arrive in seconds or milliseconds.
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
}

function mapKlineInterval(interval = '15m') {
  const raw = String(interval || '15m').trim().toLowerCase();
  const aliases = {
    '1m': '1min',
    '1min': '1min',
    '3m': '3min',
    '3min': '3min',
    '5m': '5min',
    '5min': '5min',
    '15m': '15min',
    '15min': '15min',
    '30m': '30min',
    '30min': '30min',
    '1h': '1hour',
    '1hour': '1hour',
    '2h': '2hour',
    '2hour': '2hour',
    '4h': '4hour',
    '4hour': '4hour',
    '6h': '6hour',
    '6hour': '6hour',
    '8h': '8hour',
    '8hour': '8hour',
    '12h': '12hour',
    '12hour': '12hour',
    '1d': '1day',
    '1day': '1day',
    '1w': '1week',
    '1week': '1week',
  };
  return aliases[raw] || '15min';
}

function klineIntervalSeconds(type) {
  const match = String(type || '').match(/^(\d+)(min|hour|day|week)$/);
  if (!match) return 15 * 60;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'week') return value * 7 * 24 * 60 * 60;
  if (unit === 'day') return value * 24 * 60 * 60;
  if (unit === 'hour') return value * 60 * 60;
  return value * 60;
}

function klineIntervalToCcxt(type) {
  return String(type || '15min')
    .replace('min', 'm')
    .replace('hour', 'h')
    .replace('day', 'd')
    .replace('week', 'w');
}

function parseKucoinRestCandle(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const timestampMs = normalizeTimestampMs(row[0]);
  if (!timestampMs) return null;

  if (row.length >= 7) {
    const [, open, close, high, low, volume] = row;
    return {
      timestamp: Math.floor(timestampMs / 1000),
      open: Number(open || 0),
      high: Number(high || 0),
      low: Number(low || 0),
      close: Number(close || 0),
      volume: Number(volume || 0),
    };
  }

  const [, open, high, low, close, volume] = row;
  return {
    timestamp: Math.floor(timestampMs / 1000),
    open: Number(open || 0),
    high: Number(high || 0),
    low: Number(low || 0),
    close: Number(close || 0),
    volume: Number(volume || 0),
  };
}

function aggregateTradeFills(trades = [], side = 'sell') {
  const normalizedSide = String(side || '').toLowerCase();
  const grouped = new Map();

  for (const trade of Array.isArray(trades) ? trades : []) {
    if (!trade || typeof trade !== 'object') continue;
    const tradeSide = String(trade.side || trade.info?.side || '').toLowerCase();
    if (tradeSide !== normalizedSide) continue;

    const amount = Number(trade.amount || trade.filled || trade.info?.size || trade.info?.dealSize || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const timestampMs = normalizeTimestampMs(trade.timestamp || trade.info?.createdAt || trade.info?.createdAtMillis);
    const cost = Number(trade.cost || trade.info?.funds || trade.info?.dealFunds || 0);
    const price = Number(trade.price || trade.average || trade.info?.price || 0);
    const orderId = String(trade.order || trade.info?.orderId || trade.id || `${timestampMs || Date.now()}:${price}:${amount}`);
    const current = grouped.get(orderId) || {
      txid: orderId,
      tradeId: trade.id || null,
      timestampMs: timestampMs || 0,
      filledBaseQty: 0,
      filledQuoteUsd: 0,
      weightedPriceNumerator: 0,
      weightedPriceDenominator: 0,
    };

    current.tradeId = current.tradeId || trade.id || null;
    current.timestampMs = Math.max(Number(current.timestampMs || 0), Number(timestampMs || 0));
    current.filledBaseQty += amount;
    if (Number.isFinite(cost) && cost > 0) {
      current.filledQuoteUsd += cost;
    }
    if (Number.isFinite(price) && price > 0) {
      current.weightedPriceNumerator += price * amount;
      current.weightedPriceDenominator += amount;
    }

    grouped.set(orderId, current);
  }

  return [...grouped.values()].map((entry) => {
    const executedPriceUsd = entry.filledQuoteUsd > 0 && entry.filledBaseQty > 0
      ? entry.filledQuoteUsd / entry.filledBaseQty
      : (entry.weightedPriceDenominator > 0 ? entry.weightedPriceNumerator / entry.weightedPriceDenominator : 0);

    return {
      txid: entry.txid,
      tradeId: entry.tradeId,
      timestampMs: entry.timestampMs || null,
      executedPriceUsd,
      filledBaseQty: entry.filledBaseQty,
      filledQuoteUsd: entry.filledQuoteUsd > 0
        ? entry.filledQuoteUsd
        : (entry.filledBaseQty * executedPriceUsd),
      hasExchangeFilledData: Boolean(entry.filledBaseQty > 0),
      recoveredFromTradeHistory: true,
    };
  });
}

class KuCoinExchange {
  constructor(cache) {
    this.name = 'KuCoin (CEX)';
    this.exchange = null;
    this.symbols = [];
    this.tickerCache = {};
    this.lastTickerRefresh = 0;
    this.cache = cache;
    this.obDepthCache = new Map(); // symbol -> { liquidityUsd, fetchedAt }
    this.lastDepthWarmAt = 0;
    this._knownSymbols = new Set();
    // Structural error resilience
    this._structuralErrors = 0;
    this._reinitAfter = 0;        // epoch ms: backoff until this time before retrying init
    this._lastMarketsRefresh = 0; // epoch ms: for daily auto-refresh of market structure
    this._rateLimitedUntil = 0;
    this._rateLimit429Count = 0;
  }

  isRateLimited() {
    return Date.now() < Number(this._rateLimitedUntil || 0);
  }

  _handleRateLimit(err, context) {
    const status = Number(err?.response?.status || 0);
    const msg = String(err?.message || '');
    const isRateLimit = status === 429 || /rate.?limit|too many requests|RateLimitExceeded/i.test(msg);
    if (!isRateLimit) return false;
    this._rateLimit429Count += 1;
    const backoffMs = Math.min(Math.pow(2, this._rateLimit429Count - 1) * 5000, 5 * 60_000);
    this._rateLimitedUntil = Date.now() + backoffMs;
    logger.warn(`KuCoin 429 rate-limit #${this._rateLimit429Count} in ${context}: pausing ${Math.round(backoffMs / 1000)}s`);
    return true;
  }

  async initialize() {
    try {
      this.exchange = new ccxt.kucoin({
        apiKey: config.kucoin.apiKey,
        secret: config.kucoin.apiSecret,
        password: config.kucoin.apiPassphrase,
        sandbox: config.kucoin.sandbox,
        enableRateLimit: true,
        options: {
          adjustForTimeDifference: true,
        },
      });
      await this.exchange.loadTimeDifference();
      try {
        await this.exchange.loadMarkets();
      } catch (err) {
        if (!/Invalid KC-API-TIMESTAMP|400002/i.test(String(err?.message || ''))) {
          throw err;
        }
        logger.warn('KuCoin timestamp rejected during market load; refreshing exchange time difference and retrying once');
        await this.exchange.loadTimeDifference();
        await this.exchange.loadMarkets(true);
      }
      this.symbols = Object.keys(this.exchange.markets).filter((s) => s.endsWith('/USDT'));
      logger.info(`KuCoin markets loaded: ${Object.keys(this.exchange.markets).length}`);
      logger.info(`KuCoin USDT pairs filtered: ${this.symbols.length}`);
      if (this._knownSymbols.size === 0) {
        this.symbols.forEach((s) => this._knownSymbols.add(s));
      }
      logger.info(`KuCoin initialized with ${this.symbols.length} USDT pairs`);
    } catch (err) {
      logger.error(`KuCoin initialization failed: ${err.message}`);
      this.exchange = null;
      throw err;
    }
  }

  async refreshTickers() {
    // Auto-reinit if degraded and backoff has elapsed
    await this._maybeReinit();
    if (!this.exchange) {
      logger.warn('KuCoin exchange not initialized, skipping ticker refresh');
      return;
    }
    // Respect 429 backoff — do not hammer KuCoin while rate-limited.
    if (this.isRateLimited()) {
      logger.debug(`KuCoin refreshTickers skipped: rate-limited until ${new Date(this._rateLimitedUntil).toISOString()}`);
      return;
    }

    // Daily market structure refresh — picks up new listings / API schema changes
    if (Date.now() - this._lastMarketsRefresh > 24 * 60 * 60 * 1000) {
      try {
        await this.exchange.loadMarkets(true); // force=true reloads from API
        this.symbols = Object.keys(this.exchange.markets).filter((s) => s.endsWith('/USDT'));
        this._lastMarketsRefresh = Date.now();
        logger.info(`KuCoin markets refreshed: ${this.symbols.length} USDT pairs`);
      } catch (err) {
        logger.warn(`KuCoin daily market refresh failed: ${err.message}`);
      }
    }

    try {
      const symbols = this.symbols;
      let tickers = {};

      try {
        tickers = await this.exchange.fetchTickers(symbols);
      } catch (err) {
        if (this._handleRateLimit(err, 'refreshTickers')) return;
        const msg = String(err?.message || '');
        const missingMatch = msg.match(/market symbol\s+([A-Z0-9_-]+\/USDT)/i);
        if (missingMatch && missingMatch[1]) {
          const missing = String(missingMatch[1]).toUpperCase();
          // Snapshot-before-filter to avoid mutation-during-iteration on concurrent reads.
          const snapshot = Array.from(this.symbols);
          const filtered = snapshot.filter((s) => String(s).toUpperCase() !== missing);
          if (filtered.length !== snapshot.length) {
            this.symbols = filtered;
            this._knownSymbols.delete(missing);
            logger.warn(`KuCoin removed stale symbol from scan universe: ${missing}`);
          }
        }
        logger.warn(`KuCoin fetchTickers(symbols) failed: ${err.message}`);
        tickers = await this.exchange.fetchTickers();
      }

      this.tickerCache = tickers || {};
      this.lastTickerRefresh = Date.now();
      logger.debug(`KuCoin tickers refreshed: ${Object.keys(this.tickerCache).length}`);
    } catch (err) {
      logger.warn(`KuCoin refreshTickers failed: ${err.message}`);
      this._handleRateLimit(err, 'refreshTickers');
      this._handleExchangeError(err, 'refreshTickers');
    }
  }

  /**
   * Detect structural API failures (not transient network blips) and schedule a
   * reinitialization after an exponential backoff so the bot self-heals if KuCoin
   * changes their API surface.
   */
  _handleExchangeError(err, context) {
    const msg = String(err?.message || '');
    const isStructural = (
      /ECONNREFUSED|ENOTFOUND|getaddrinfo|503|502|InvalidApiKey|InvalidSignature|Bad Request|market not found|symbol.*not.*found|deprecated|removed|migrated|version/i.test(msg)
      || err?.response?.status >= 400 && err?.response?.status < 500 && err?.response?.status !== 429
    );
    if (!isStructural) return;

    this._structuralErrors += 1;
    // Exponential backoff: 1m, 2m, 4m, 8m, cap 30m
    const backoffMs = Math.min(Math.pow(2, this._structuralErrors - 1) * 60_000, 30 * 60_000);
    this._reinitAfter = Date.now() + backoffMs;
    logger.warn(
      `KuCoin structural error #${this._structuralErrors} in ${context}: "${msg.slice(0, 120)}". ` +
      `Will reinitialize after ${Math.round(backoffMs / 1000)}s backoff.`
    );
  }

  async _maybeReinit() {
    if (this._reinitAfter === 0) return; // no pending reinit
    if (Date.now() < this._reinitAfter) return; // still in backoff
    logger.warn('KuCoin attempting auto-reinitialization after structural error...');
    try {
      await this.initialize();
      this._structuralErrors = 0;
      this._reinitAfter = 0;
      logger.info('KuCoin auto-reinitialization succeeded');
    } catch (err) {
      // Extend backoff on reinit failure
      const backoffMs = Math.min(Math.pow(2, this._structuralErrors) * 60_000, 30 * 60_000);
      this._reinitAfter = Date.now() + backoffMs;
      logger.warn(`KuCoin auto-reinitialization failed: ${err.message}. Next retry in ${Math.round(backoffMs / 1000)}s`);
    }
  }

  normalizeSymbol(symbol) {
    const raw = String(symbol || '').trim();
    if (!raw) return raw;
    const upper = raw.toUpperCase();
    if (this.exchange?.markets?.[upper]) return upper;
    const known = (this.symbols || []).find((s) => String(s).toUpperCase() === upper);
    if (known) return known;
    const cached = Object.keys(this.tickerCache || {}).find((s) => String(s).toUpperCase() === upper);
    if (cached) return cached;
    return upper;
  }

  async getTicker(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    if (!this.tickerCache[normalized] || Date.now() - this.lastTickerRefresh > 60_000) {
      await this.refreshTickers();
    }
    return this.tickerCache[normalized];
  }

  async getTokenData(symbol) {
    if (!this.exchange) {
      logger.error('KuCoin exchange not initialized');
      return null;
    }

    const normalized = this.normalizeSymbol(symbol);
    const cacheKey = `token:${normalized}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) return cached;

    try {
      const ticker = await this.getTicker(normalized);
      if (!ticker || !ticker.last) {
        return null;
      }

      const tokenSymbol = normalized.replace('/USDT', '');
      let metrics = {};
      try {
        const metricsPromise = getTokenMetrics(tokenSymbol, 'kucoin', tokenSymbol);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('metrics timeout')), 800)
        );
        metrics = await Promise.race([metricsPromise, timeoutPromise]);
      } catch (_metricsErr) {
        metrics = {};
      }

      const volume24hUsd = Number(ticker.quoteVolume || 0);
      const liquidityUsd = volume24hUsd;
      const listingMeta = this.getListingMeta(normalized);

      const result = {
        address: normalized,
        symbol: tokenSymbol,
        name: tokenSymbol,
        price: ticker.last,
        liquidityUsd,
        volume24hUsd,
        liquidityChange24hPct: 0,
        volume24h: volume24hUsd,
        priceChange24h: Number(ticker.percentage || 0),
        priceChange7d: 0,
        buyTx10m: 0,
        sellTx10m: 0,
        buyTx1h: 0,
        sellTx1h: 0,
        txCountFirstHour: 0,
        uniqueBuyers10m: 0,
        isHoneypot: false,
        honeypotReason: '',
        buyTax: 0,
        sellTax: 0,
        topHoldersPct: 0,
        teamWalletUnlocked: false,
        listingAgeDays: listingMeta.listingAgeDays,
        listingDate: listingMeta.listingDate,
        chain: 'KuCoin',
        pairAddress: normalized,
        sentimentUpPct: metrics?.sentimentUpPct || null,
        sentimentDownPct: metrics?.sentimentDownPct || null,
        communityScore: metrics?.communityScore || null,
        developerScore: metrics?.developerScore || null,
        publicInterestScore: metrics?.publicInterestScore || null,
        coingeckoId: metrics?.coingeckoId || null,
        listedOnCoinGecko: Boolean(metrics?.coingeckoId),
        listedOnCoinMarketCap: true,
      };

      await this.cache?.set(cacheKey, result, 60);
      return result;
    } catch (err) {
      logger.error(`KuCoin getTokenData failed for ${normalized}: ${err.message}`);
      return null;
    }
  }

  async getKlines(symbol, interval = '15m', limit = 120) {
    if (!this.exchange) {
      throw new Error('KuCoin exchange not initialized');
    }

    const normalized = this.normalizeSymbol(symbol);
    const type = mapKlineInterval(interval);
    const intervalSec = klineIntervalSeconds(type);
    const bars = Math.max(1, Math.min(300, Number(limit || 120)));
    const endAt = Math.floor(Date.now() / 1000);
    const startAt = endAt - intervalSec * (bars + 2);
    let rows = [];

    if (typeof this.exchange.publicGetMarketCandles === 'function') {
      const response = await this.exchange.publicGetMarketCandles({
        symbol: normalized.replace('/', '-'),
        type,
        startAt,
        endAt,
      });
      rows = response?.data || response || [];
    } else if (typeof this.exchange.fetchOHLCV === 'function') {
      rows = await this.exchange.fetchOHLCV(
        normalized,
        klineIntervalToCcxt(type),
        startAt * 1000,
        bars
      );
    } else {
      throw new Error('KuCoin OHLCV method unavailable');
    }

    const nowMs = Date.now();
    return (Array.isArray(rows) ? rows : [])
      .map(parseKucoinRestCandle)
      .filter((row) => row
        && Number.isFinite(row.open)
        && Number.isFinite(row.high)
        && Number.isFinite(row.low)
        && Number.isFinite(row.close)
        && row.close > 0
        && ((Number(row.timestamp || 0) * 1000) + (intervalSec * 1000)) <= nowMs)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
      .slice(-bars);
  }

  getListingMeta(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const market = this.exchange?.markets?.[normalized];
    const tradingStartMs = normalizeTimestampMs(market?.info?.tradingStartTime);
    const createdMs = normalizeTimestampMs(market?.created);
    const listingTs = tradingStartMs || createdMs;

    if (!listingTs) {
      return {
        listingAgeDays: 30,
        listingDate: null,
        listingAgeSeconds: null,
      };
    }

    const ageSeconds = Math.max(0, Math.floor((Date.now() - listingTs) / 1000));
    return {
      listingAgeDays: Number((ageSeconds / 86400).toFixed(4)),
      listingDate: new Date(listingTs).toISOString(),
      listingAgeSeconds: ageSeconds,
    };
  }

  async getAmountOut(amountInUsdt, symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const ticker = await this.getTicker(normalized);
    const price = ticker?.last || 0;
    return price > 0 ? amountInUsdt / price : 0;
  }

  async getTopOfBook(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const orderBook = await this.exchange.fetchOrderBook(normalized, 20); // KuCoin only accepts 20 or 100
    const bestAsk = Number(orderBook?.asks?.[0]?.[0] || 0);
    const bestBid = Number(orderBook?.bids?.[0]?.[0] || 0);
    if (!bestAsk || !bestBid) {
      throw new Error(`Order book unavailable for ${normalized}`);
    }
    return { bestAsk, bestBid };
  }

  getMarketTradeLimits(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const market = this.exchange?.market?.(normalized) || this.exchange?.markets?.[normalized] || null;
    return {
      minBaseSize: Number(market?.limits?.amount?.min || 0),
      minFunds: Number(market?.limits?.cost?.min || 0),
      amountPrecision: market?.precision?.amount ?? null,
      pricePrecision: market?.precision?.price ?? null,
    };
  }

  async getFreeQuoteBalance(asset = 'USDT') {
    if (!this.exchange) return 0;
    const balance = await this.exchange.fetchBalance();
    return Number(balance?.[asset]?.free || 0);
  }

  async findRecentTradeFill(symbol, side = 'sell', expectedAmount = 0, options = {}) {
    if (!this.exchange || typeof this.exchange.fetchMyTrades !== 'function') {
      return null;
    }

    const lookbackMs = Math.max(30_000, Number(options.lookbackMs || 3 * 60 * 1000));
    const targetTimestampMs = normalizeTimestampMs(options.targetTimestampMs || Date.now()) || Date.now();
    const sinceMs = Math.max(0, normalizeTimestampMs(options.sinceMs || (targetTimestampMs - lookbackMs)) || (targetTimestampMs - lookbackMs));
    const expectedBaseQty = Number(expectedAmount || 0);
    const orderId = options.orderId ? String(options.orderId) : null;

    try {
      const normalized = this.normalizeSymbol(symbol);
      const trades = await this.exchange.fetchMyTrades(normalized, sinceMs, 50);
      const candidates = aggregateTradeFills(trades, side)
        .filter((entry) => {
          if (!Number.isFinite(Number(entry.filledBaseQty)) || Number(entry.filledBaseQty) <= 0) return false;
          if (orderId && entry.txid !== orderId) return false;
          if (!Number.isFinite(Number(entry.timestampMs)) || Number(entry.timestampMs) <= 0) return true;
          return Number(entry.timestampMs) >= sinceMs - 5_000;
        })
        .sort((left, right) => {
          const leftQty = Number(left.filledBaseQty || 0);
          const rightQty = Number(right.filledBaseQty || 0);
          const leftQtyDiff = expectedBaseQty > 0 ? Math.abs(leftQty - expectedBaseQty) / expectedBaseQty : 0;
          const rightQtyDiff = expectedBaseQty > 0 ? Math.abs(rightQty - expectedBaseQty) / expectedBaseQty : 0;
          if (leftQtyDiff !== rightQtyDiff) return leftQtyDiff - rightQtyDiff;

          const leftTimeDiff = Math.abs(Number(left.timestampMs || targetTimestampMs) - targetTimestampMs);
          const rightTimeDiff = Math.abs(Number(right.timestampMs || targetTimestampMs) - targetTimestampMs);
          if (leftTimeDiff !== rightTimeDiff) return leftTimeDiff - rightTimeDiff;

          return Number(right.timestampMs || 0) - Number(left.timestampMs || 0);
        });

      if (!candidates.length) return null;
      const match = candidates[0];
      return {
        ...match,
        timestamp: match.timestampMs ? new Date(match.timestampMs).toISOString() : null,
      };
    } catch (error) {
      logger.warn(`KuCoin recent trade lookup failed for ${this.normalizeSymbol(symbol)}: ${error.message}`);
      return null;
    }
  }

  async executeBuy(symbol, usdtAmount, options = {}) {
    symbol = this.normalizeSymbol(symbol);
    if (config.paperTrading) {
      logger.info(`[PAPER] KuCoin BUY ${symbol} with ${usdtAmount} USDT`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    try {
      const requestedQuoteFunds = Number(usdtAmount || 0);
      if (!Number.isFinite(requestedQuoteFunds) || requestedQuoteFunds <= 0) {
        throw new Error(`Invalid KuCoin buy funds for ${symbol}: ${usdtAmount}`);
      }

      const quoteBalanceReserveUsd = Math.max(0.05, Number(config.execution?.kucoinQuoteReserveUsd || 0.15));
      const quoteBalanceHeadroomPct = Math.min(0.999, Math.max(0.90, Number(config.execution?.kucoinBalanceHeadroomPct || 0.992)));
      const { minBaseSize, minFunds } = this.getMarketTradeLimits(symbol);
      const { bestAsk } = await this.getTopOfBook(symbol);
      const safeBestAsk = Number(bestAsk || 0);
      if (!Number.isFinite(safeBestAsk) || safeBestAsk <= 0) {
        throw new Error(`Order book unavailable for ${symbol}`);
      }

      const freeUsdt = await this.getFreeQuoteBalance('USDT');
      const spendableUsdt = Math.max(0, (freeUsdt * quoteBalanceHeadroomPct) - quoteBalanceReserveUsd);
      const cappedQuoteFunds = Math.min(requestedQuoteFunds, spendableUsdt);

      if (!Number.isFinite(freeUsdt) || freeUsdt <= 0 || cappedQuoteFunds <= 0) {
        throw new Error(`KuCoin BUY ${symbol} rejected: insufficient free USDT balance (free=${freeUsdt.toFixed(4)}, requested=${requestedQuoteFunds.toFixed(4)})`);
      }

      // Pre-flight: reject if estimated quantity or notional is below exchange minimums.
      try {
        if (minBaseSize > 0) {
          if (safeBestAsk > 0) {
            const estQty = cappedQuoteFunds / safeBestAsk;
            if (estQty < minBaseSize) {
              throw new Error(`KuCoin BUY ${symbol} rejected: estimated qty ${estQty.toFixed(8)} < baseMinSize ${minBaseSize}. Increase position size or skip this token.`);
            }
          }
        }
        if (minFunds > 0 && cappedQuoteFunds < minFunds) {
          throw new Error(`KuCoin BUY ${symbol} rejected: funds ${cappedQuoteFunds.toFixed(4)} < minFunds ${minFunds}. Increase position size or skip this token.`);
        }
      } catch (preflightErr) {
        // If the error is our own rejection, re-throw it; otherwise ignore (best-effort check)
        if (preflightErr.message.startsWith('KuCoin BUY') && (preflightErr.message.includes('baseMinSize') || preflightErr.message.includes('minFunds'))) throw preflightErr;
        logger.warn(`KuCoin buy preflight check failed (non-fatal): ${preflightErr.message}`);
      }

      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const maxSlippagePct = Math.max(0.1, Number(config.execution.kucoinMaxSlippagePct || 1.2));
      const strategyName = String(options?.strategyName || 'momentum').toLowerCase();
      const useMarketBuy = Boolean(config.execution?.kucoinMomentumUseMarketBuy !== false && strategyName === 'momentum');
      let marketAttemptUsed = false;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          if (useMarketBuy && !marketAttemptUsed) {
            marketAttemptUsed = true;
            const funds = Number(this.exchange.costToPrecision(symbol, cappedQuoteFunds));
            if (!Number.isFinite(funds) || funds <= 0) {
              throw new Error(`Invalid KuCoin market buy funds for ${symbol}`);
            }
            if (minFunds > 0 && funds < minFunds) {
              throw new Error(`KuCoin BUY ${symbol} rejected: rounded funds ${funds.toFixed(4)} < minFunds ${minFunds}`);
            }
            const order = await this.exchange.createOrder(symbol, 'market', 'buy', null, null, {
              funds,
            });

            let filled = Number(order?.filled || 0);
            let verifiedOrder = order;
            // KuCoin sometimes returns filled=0 immediately on market orders even when filled.
            // Re-fetch the order to get the actual fill status before declaring failure.
            if (filled <= 0 && order?.id) {
              try {
                await new Promise((resolve) => setTimeout(resolve, 800));
                verifiedOrder = await this.exchange.fetchOrder(order.id, symbol);
                filled = Number(verifiedOrder?.filled || 0);
                if (filled > 0) {
                  logger.info(`KuCoin market order re-fetch confirmed fill: ${order.id} (filled=${filled})`);
                }
              } catch (fetchErr) {
                logger.warn(`KuCoin market order re-fetch failed: ${fetchErr.message}`);
              }
            }
            if (filled <= 0) {
              throw new Error(`BUY market order not filled for ${symbol}`);
            }

            const avgPrice = Number(verifiedOrder?.average || verifiedOrder?.avgPrice || 0);
            const cost = Number(verifiedOrder?.cost || (filled * avgPrice) || funds || 0);
            logger.info(`KuCoin BUY market order filled: ${order.id} (filled=${filled})`);
            return {
              txid: order.id,
              simulated: false,
              executedPriceUsd: avgPrice,
              filledBaseQty: filled,
              filledQuoteUsd: cost,
              hasExchangeFilledData: Boolean(filled > 0 && cost > 0),
            };
          }

          const slippagePct = maxSlippagePct + (attempt - 1) * 0.25;
          const limitPriceRaw = safeBestAsk * (1 + slippagePct / 100);
          const limitPrice = Number(this.exchange.priceToPrecision(symbol, limitPriceRaw));
          const baseAmountRaw = cappedQuoteFunds / limitPrice;
          const baseAmount = Number(this.exchange.amountToPrecision(symbol, baseAmountRaw));

          if (!baseAmount || !limitPrice) {
            throw new Error(`Invalid order sizing for ${symbol}`);
          }
          const roundedQuoteFunds = baseAmount * limitPrice;
          if (minBaseSize > 0 && baseAmount < minBaseSize) {
            throw new Error(`KuCoin BUY ${symbol} rejected: rounded qty ${baseAmount.toFixed(8)} < baseMinSize ${minBaseSize}`);
          }
          if (minFunds > 0 && roundedQuoteFunds < minFunds) {
            throw new Error(`KuCoin BUY ${symbol} rejected: rounded funds ${roundedQuoteFunds.toFixed(4)} < minFunds ${minFunds}`);
          }
          if (roundedQuoteFunds > spendableUsdt) {
            throw new Error(`KuCoin BUY ${symbol} rejected: rounded funds ${roundedQuoteFunds.toFixed(4)} exceed spendable USDT ${spendableUsdt.toFixed(4)}`);
          }

          const order = await this.exchange.createOrder(symbol, 'limit', 'buy', baseAmount, limitPrice, {
            timeInForce: 'IOC',
          });

          const filled = Number(order?.filled || 0);
          if (filled <= 0) {
            throw new Error(`BUY IOC not filled for ${symbol}`);
          }

          const avgPrice = Number(order?.average || order?.avgPrice || limitPrice || 0);
          const cost = Number(order?.cost || (filled * avgPrice) || 0);

          logger.info(`KuCoin BUY order filled: ${order.id} (limit=${limitPrice}, filled=${filled})`);
          return {
            txid: order.id,
            simulated: false,
            limitPrice,
            executedPriceUsd: avgPrice,
            filledBaseQty: filled,
            filledQuoteUsd: cost,
            hasExchangeFilledData: Boolean(filled > 0 && cost > 0),
          };
        } catch (error) {
          const errorText = String(error?.message || '');
          if (/balance insufficient|\b200004\b/i.test(errorText)) {
            try {
              const refreshedFreeUsdt = await this.getFreeQuoteBalance('USDT');
              const refreshedSpendableUsdt = Math.max(0, (refreshedFreeUsdt * quoteBalanceHeadroomPct) - quoteBalanceReserveUsd);
              throw new Error(
                `KuCoin BUY ${symbol} rejected after balance refresh: insufficient free USDT ` +
                `(free=${refreshedFreeUsdt.toFixed(4)}, spendable=${refreshedSpendableUsdt.toFixed(4)}, requested=${requestedQuoteFunds.toFixed(4)})`
              );
            } catch (refreshError) {
              throw refreshError;
            }
          }
          if (/Order size below the minimum requirement|\b400100\b/i.test(errorText)) {
            throw new Error(
              `KuCoin BUY ${symbol} rejected by exchange minimums after rounding ` +
              `(minBaseSize=${minBaseSize || 0}, minFunds=${minFunds || 0}, requested=${requestedQuoteFunds.toFixed(4)})`
            );
          }
          if (useMarketBuy && marketAttemptUsed && attempt === 1) {
            logger.warn(`KuCoin BUY market mode failed, falling back to IOC limit: ${error.message}`);
          }
          if (attempt >= retries) throw error;
          logger.warn(`KuCoin BUY retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('KuCoin BUY failed after retries');
    } catch (err) {
      logger.error(`KuCoin executeBuy failed: ${err.message}`);
      throw err;
    }
  }

  async executeSell(symbol, amount) {
    symbol = this.normalizeSymbol(symbol);
    if (config.paperTrading) {
      logger.info(`[PAPER] KuCoin SELL ${symbol} amount ${amount}`);
      return { txid: `paper_tx_${Date.now()}`, simulated: true };
    }

    try {
      const retries = Math.max(1, Number(config.execution.maxRetries || 3));
      const maxSlippagePct = Math.max(0.1, Number(config.execution.kucoinMaxSlippagePct || 1.2));
      let preflightMinBaseSize = 0;

      // Pre-flight: detect sub-minimum quantity and attempt a funds-based market sell instead
      try {
        const market = this.exchange.market(symbol);
        const minBaseSize = Number(market?.limits?.amount?.min || 0);
        const minFunds = Number(market?.limits?.cost?.min || 0);
        preflightMinBaseSize = minBaseSize;
        if (minBaseSize > 0 && Number(amount) < minBaseSize) {
          logger.warn(`[KuCoin] SELL ${symbol}: qty ${amount} < baseMinSize ${minBaseSize} — attempting funds-based market sell`);
          const { bestBid } = await this.getTopOfBook(symbol);
          const estimatedFunds = Number(amount) * bestBid;
          if (estimatedFunds < Math.max(minFunds, 0.1)) {
            const dustErr = new Error(`KuCoin SELL ${symbol}: estimated value $${estimatedFunds.toFixed(4)} below quoteMinSize — position too small to exit via API`);
            dustErr.code = 'POSITION_DUST';
            dustErr.dustEstimatedFunds = estimatedFunds;
            dustErr.dustMinFunds = Math.max(minFunds, 0.1);
            throw dustErr;
          }
          // Use funds-based market sell: KuCoin accepts `funds` param to sell by quote value
          const fundsValue = Number(this.exchange.costToPrecision(symbol, estimatedFunds * 0.999)); // tiny discount to avoid rounding above actual balance
          const order = await this.exchange.createOrder(symbol, 'market', 'sell', null, null, { funds: fundsValue });
          await new Promise((resolve) => setTimeout(resolve, 800));
          let filledOrder = order;
          if (order?.id) {
            try { filledOrder = await this.exchange.fetchOrder(order.id, symbol); } catch (_) {}
          }
          const filled = Number(filledOrder?.filled || filledOrder?.amount || amount);
          const avgPrice = Number(filledOrder?.average || filledOrder?.avgPrice || bestBid);
          const cost = Number(filledOrder?.cost || (filled * avgPrice) || fundsValue);
          logger.info(`KuCoin funds-based SELL filled: ${order?.id} (qty=${filled}, price=${avgPrice}, value=$${cost.toFixed(4)})`);
          return {
            txid: order?.id || `funds_sell_${Date.now()}`,
            simulated: false,
            executedPriceUsd: avgPrice,
            filledBaseQty: filled,
            filledQuoteUsd: cost,
            hasExchangeFilledData: Boolean(filled > 0),
          };
        }
      } catch (preflightErr) {
        if (
          preflightErr.message.includes('quoteMinSize')
          || preflightErr.message.includes('baseMinSize')
          || preflightErr.message.includes('position too small')
        ) {
          throw preflightErr;
        }
        // If sub-minimum funds-based sell fails, a normal IOC with the same sub-minimum
        // quantity is not actionable. Fail cleanly so state repair/reconciliation can run.
        if (preflightMinBaseSize > 0 && Number(amount) < preflightMinBaseSize) {
          throw new Error(`KuCoin SELL ${symbol}: sub-minimum funds-based exit failed: ${preflightErr.message}`);
        }
        logger.warn(`KuCoin sell preflight failed (${preflightErr.message}), falling back to limit sell`);
      }

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        const attemptStartedAtMs = Date.now();
        try {
          const { bestBid } = await this.getTopOfBook(symbol);
          const slippagePct = maxSlippagePct + (attempt - 1) * 0.25;
          const limitPriceRaw = bestBid * (1 - slippagePct / 100);
          const limitPrice = Number(this.exchange.priceToPrecision(symbol, limitPriceRaw));
          const sellAmount = Number(this.exchange.amountToPrecision(symbol, Number(amount)));

          if (!sellAmount || !limitPrice) {
            throw new Error(`Invalid sell sizing for ${symbol}`);
          }

          const order = await this.exchange.createOrder(symbol, 'limit', 'sell', sellAmount, limitPrice, {
            timeInForce: 'IOC',
          });

          let filled = Number(order?.filled || 0);
          let verifiedOrder = order;
          if (filled <= 0 && order?.id) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 800));
              verifiedOrder = await this.exchange.fetchOrder(order.id, symbol);
              filled = Number(verifiedOrder?.filled || 0);
              if (filled > 0) {
                logger.info(`KuCoin sell order re-fetch confirmed fill: ${order.id} (filled=${filled})`);
              }
            } catch (fetchErr) {
              logger.warn(`KuCoin sell order re-fetch failed: ${fetchErr.message}`);
            }
          }
          if (filled <= 0) {
            const recoveredFill = await this.findRecentTradeFill(symbol, 'sell', sellAmount, {
              sinceMs: attemptStartedAtMs - 10_000,
              lookbackMs: 2 * 60 * 1000,
              targetTimestampMs: attemptStartedAtMs,
              orderId: order?.id,
            });
            if (recoveredFill) {
              logger.info(`KuCoin recent trades confirmed sell fill for ${symbol}: ${recoveredFill.txid}`);
              return recoveredFill;
            }
            throw new Error(`SELL IOC not filled for ${symbol}`);
          }

          const avgPrice = Number(verifiedOrder?.average || verifiedOrder?.avgPrice || limitPrice || 0);
          const cost = Number(verifiedOrder?.cost || (filled * avgPrice) || 0);

          logger.info(`KuCoin SELL order filled: ${order.id} (limit=${limitPrice}, filled=${filled})`);
          return {
            txid: order.id,
            simulated: false,
            limitPrice,
            executedPriceUsd: avgPrice,
            filledBaseQty: filled,
            filledQuoteUsd: cost,
            hasExchangeFilledData: Boolean(filled > 0 && cost > 0),
          };
        } catch (error) {
          const recoveredFill = await this.findRecentTradeFill(symbol, 'sell', amount, {
            sinceMs: attemptStartedAtMs - 15_000,
            lookbackMs: 3 * 60 * 1000,
            targetTimestampMs: attemptStartedAtMs,
            orderId: typeof order !== 'undefined' ? order?.id : undefined,
          });
          if (recoveredFill) {
            logger.warn(`KuCoin recovered SELL fill from trade history after error for ${symbol}: ${error.message}`);
            return recoveredFill;
          }
          if (attempt >= retries) throw error;
          logger.warn(`KuCoin SELL retry ${attempt}/${retries} failed: ${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, Number(config.execution.retryDelayMs || 1200) * attempt));
        }
      }

      throw new Error('KuCoin SELL failed after retries');
    } catch (err) {
      logger.error(`KuCoin executeSell failed: ${err.message}`);
      throw err;
    }
  }

  async getBalance(asset = 'USDT') {
    if (!this.exchange) {
      logger.warn('KuCoin exchange not initialized, cannot fetch balance');
      return 0;
    }

    try {
      const balance = await this.exchange.fetchBalance();
      const free = balance[asset]?.free || 0;
      logger.debug(`KuCoin balance for ${asset}: ${free}`);
      return free;
    } catch (err) {
      logger.error(`KuCoin getBalance failed: ${err.message}`);
      return 0;
    }
  }

  async warmDepthCacheForTopSymbols(topN = 20) {
    if (!this.exchange) return;

    const symbols = Object.entries(this.tickerCache || {})
      .filter(([, ticker]) => ticker && ticker.last && ticker.quoteVolume)
      .sort(([, left], [, right]) => Number(right.quoteVolume || 0) - Number(left.quoteVolume || 0))
      .slice(0, Math.max(1, Number(topN || 20)))
      .map(([symbol]) => symbol);

    const OB_DEPTH_TTL_MS = 30_000;
    for (const symbol of symbols) {
      const cachedDepth = this.obDepthCache.get(symbol);
      if (cachedDepth && Date.now() - cachedDepth.fetchedAt < OB_DEPTH_TTL_MS) {
        continue;
      }

      try {
        const orderBook = await this.exchange.fetchOrderBook(symbol, 20);
        const topBids = (orderBook?.bids || []).slice(0, 10);
        const liquidityUsd = topBids.reduce((sum, [price, amount]) => sum + Number(price) * Number(amount), 0);
        if (liquidityUsd > 0) {
          this.obDepthCache.set(symbol, { liquidityUsd, fetchedAt: Date.now() });
        }
      } catch (_) {
        // Ignore warm-up misses and allow downstream fallback.
      }
    }
  }

  // Order book imbalance: bid_depth / ask_depth ratio.
  // > 1.2 = buy pressure (more demand), < 0.8 = sell pressure (more supply).
  // Used as the 4th signal in the cascade alongside Technical / AI / Sentiment.
  async getOrderBookImbalance(symbol, depth = 10) {
    if (!this.exchange) return null;
    try {
      const ob = await this.exchange.fetchOrderBook(symbol, depth);
      const bidUsd = (ob?.bids || []).slice(0, depth).reduce((s, [p, q]) => s + Number(p) * Number(q), 0);
      const askUsd = (ob?.asks || []).slice(0, depth).reduce((s, [p, q]) => s + Number(p) * Number(q), 0);
      if (askUsd <= 0 || bidUsd <= 0) return null;
      return {
        bidUsd,
        askUsd,
        ratio: bidUsd / askUsd,
        skewPct: ((bidUsd - askUsd) / (bidUsd + askUsd)) * 100,
        ts: Date.now(),
      };
    } catch (err) {
      return null;
    }
  }

  async getWalletPositions(dustThresholdUsd = 0) {
    if (!this.exchange) return [];

    try {
      const balance = await this.exchange.fetchBalance();
      const totals = balance?.total || {};
      const minUsd = Math.max(0, Number(dustThresholdUsd || 0));
      const positions = [];

      if (!this.tickerCache || Object.keys(this.tickerCache).length === 0 || Date.now() - this.lastTickerRefresh > 60_000) {
        await this.refreshTickers();
      }

      const candidates = [];
      Object.entries(totals).forEach(([asset, totalRaw]) => {
        const total = Number(totalRaw || 0);
        if (!Number.isFinite(total) || total <= 0) return;
        const upper = String(asset || '').toUpperCase();
        if (!upper || upper === 'USDT') return;
        const symbol = `${upper}/USDT`;
        if (!this.exchange?.markets?.[symbol]) return;
        candidates.push({ asset: upper, symbol, total });
      });

      // Resolve prices: prefer cached ticker, else fetch directly. Without this fallback,
      // any wallet asset that happens not to be in the ticker cache (e.g. low-volume names
      // that fetchTickers omitted) gets silently dropped — making the wallet look empty.
      for (const { asset, symbol, total } of candidates) {
        let last = Number(this.tickerCache?.[symbol]?.last || 0);
        if (!Number.isFinite(last) || last <= 0) {
          try {
            const t = await this.exchange.fetchTicker(symbol);
            last = Number(t?.last || t?.close || t?.bid || 0);
            if (Number.isFinite(last) && last > 0) {
              this.tickerCache[symbol] = t;
            }
          } catch (err) {
            logger.debug(`KuCoin direct ticker fetch failed for ${symbol}: ${err.message}`);
          }
        }
        if (!Number.isFinite(last) || last <= 0) {
          logger.warn(`KuCoin getWalletPositions: no price for ${symbol} (qty=${total}) — excluded from wallet view`);
          continue;
        }
        const valueUsd = total * last;
        if (valueUsd < minUsd) continue;
        positions.push({
          address: symbol,
          symbol: asset,
          quantity: total,
          valueUsd,
          lastPrice: last,
        });
      }

      return positions;
    } catch (error) {
      logger.warn(`KuCoin getWalletPositions failed: ${error.message}`);
      return [];
    }
  }

  getSymbols() {
    return this.symbols;
  }

  async getSwingCandidates() {
    if (!this.exchange) return [];

    if (!this.tickerCache || Object.keys(this.tickerCache).length === 0) {
      await this.refreshTickers();
    }

    const swingLimit = Math.max(10, Number(config.bot?.kucoinSwingCandidateLimit || 80));

    const ranked = Object.entries(this.tickerCache || {})
      .filter(([, ticker]) => ticker && Number(ticker.last || 0) > 0 && Number(ticker.quoteVolume || 0) > 0)
      .sort(([, left], [, right]) => Number(right.quoteVolume || 0) - Number(left.quoteVolume || 0))
      .map(([symbol]) => symbol);

    const filtered = ranked.filter((sym) => !LEVERAGED_TOKEN_PATTERN.test(sym.replace('/USDT', '')));
    const excluded = ranked.length - filtered.length;
    if (excluded > 0) {
      logger.debug(`KuCoin leveraged-token filter excluded ${excluded} swing symbols this cycle`);
    }

    return filtered.slice(0, swingLimit);
  }

  async getNewListings() {
    if (!this.exchange) return [];
    if (this._knownSymbols.size === 0) return [];
    try {
      await this.exchange.loadMarkets(true);
      const currentSymbols = Object.keys(this.exchange.markets).filter((s) => s.endsWith('/USDT'));
      const newSymbols = currentSymbols.filter((s) => {
        if (this._knownSymbols.has(s)) return false;
        return !LEVERAGED_TOKEN_PATTERN.test(s.replace('/USDT', ''));
      });
      currentSymbols.forEach((s) => this._knownSymbols.add(s));
      if (newSymbols.length > 0) {
        logger.info(`KuCoin new listings detected: ${newSymbols.join(', ')} (${newSymbols.length} new)`);
      }
      return newSymbols;
    } catch (err) {
      logger.warn(`KuCoin getNewListings failed: ${err.message}`);
      return [];
    }
  }

  async getNewTokens() {
    if (config.bot?.kucoinScanAllSymbols !== false) {
      if (!this.symbols || this.symbols.length === 0) {
        await this.initialize();
      }
      return [...this.symbols];
    }

    if (!this.tickerCache || Object.keys(this.tickerCache).length === 0) {
      await this.refreshTickers();
    }

    const depthWarmIntervalMs = 60_000;
    if (Date.now() - this.lastDepthWarmAt >= depthWarmIntervalMs) {
      await this.warmDepthCacheForTopSymbols(20);
      this.lastDepthWarmAt = Date.now();
    }

    const OB_DEPTH_TTL_MS = 30_000;
    const minLiquidityUsd = Math.max(0, Number(config.risk?.minLiquidityUsd || 0));
    const newListingAgeSec = Math.max(60, Number(config.risk?.newListingAgeSec || 3600));
    const newListingVolThresholdUsd = Math.max(
      0,
      Number(config.risk?.newListingVolThresholdUsd || (minLiquidityUsd / 2))
    );

    const candidates = Object.entries(this.tickerCache)
      .filter(([, ticker]) => ticker && ticker.last && ticker.quoteVolume)
      .map(([symbol, ticker]) => {
        const cachedDepth = this.obDepthCache.get(symbol);
        const hasFreshDepth = cachedDepth && (Date.now() - cachedDepth.fetchedAt < OB_DEPTH_TTL_MS);
        const listingMeta = this.getListingMeta(symbol);
        const isFreshListing = Number.isFinite(listingMeta.listingAgeSeconds)
          && listingMeta.listingAgeSeconds <= newListingAgeSec;
        return {
          symbol,
          isFreshListing,
          liquidityUsd: hasFreshDepth
            ? Number(cachedDepth.liquidityUsd || 0)
            : Number(ticker.quoteVolume || 0),
        };
      })
      .filter((item) => {
        const requiredLiquidity = item.isFreshListing ? newListingVolThresholdUsd : minLiquidityUsd;
        return item.liquidityUsd >= requiredLiquidity;
      })
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
      .map((item) => item.symbol);

    const filtered = candidates.filter((sym) => !LEVERAGED_TOKEN_PATTERN.test(sym.replace('/USDT', '')));
    const excludedCount = candidates.length - filtered.length;
    if (excludedCount > 0) {
      logger.debug(`KuCoin leveraged-token filter excluded ${excludedCount} symbols this cycle`);
    }
    return filtered;
  }
}

module.exports = KuCoinExchange;
