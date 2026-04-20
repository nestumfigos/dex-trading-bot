'use strict';
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const { buildCorrelationMatrix } = require('../utils/correlation');

class RiskGuardian {
  constructor(portfolio) {
    this.portfolio = portfolio;
    // Validate portfolio.balance exists and is a finite number
    if (!Number.isFinite(portfolio.balance) || portfolio.balance < 0) {
      logger.warn(`RiskGuardian: portfolio.balance invalid (${portfolio.balance}); using 0`);
      this.dailyStartBalance = 0;
    } else {
      this.dailyStartBalance = this.getEquityBalanceUsd();
    }
    this.haltedToday = false;
    // Cache with TTL: map of cacheKey => { result, timestamp }
    this.honeypotCache = {};
    this.honeypotCacheTtlMs = 30 * 60 * 1000; // 30 minutes
  }

  buildPositionKey(chainKey, address) {
    return `${String(chainKey || '').trim().toLowerCase()}:${String(address || '').trim().toLowerCase()}`;
  }

  /**
   * Check whether the candidate token is too correlated with any open position.
   * Returns { blocked: true, reason } or { blocked: false }.
   * @param {string} candidateKey     - chain-scoped token key being considered
   * @param {string} candidateAddress - token address for logging
   * @param {Object} priceHistories   - strategy.priceHistory map
   */
  checkCorrelation(candidateKey, candidateAddress, priceHistories = {}) {
    const maxCorr = Number(config.risk.maxCorrelationPct ?? 75) / 100;
    const openKeys = Object.keys(this.portfolio.positions).filter((key) => key !== candidateKey);

    if (!openKeys.length || !priceHistories[candidateKey]) {
      logger.debug(
        `Correlation guard skipped for ${candidateAddress.slice(0, 8)}: ` +
        `${openKeys.length ? 'candidate has no price history yet' : 'no open positions'}`
      );
      return { blocked: false };
    }

    const subset = { [candidateKey]: priceHistories[candidateKey] };
    for (const key of openKeys) {
      if (priceHistories[key]) subset[key] = priceHistories[key];
    }
    if (Object.keys(subset).length < 2) return { blocked: false };

    try {
      const { tokens, matrix } = buildCorrelationMatrix(subset);
      const candIdx = tokens.indexOf(candidateKey);
      if (candIdx === -1) return { blocked: false };

      let strongestCorr = null;
      let strongestToken = null;

      for (let j = 0; j < tokens.length; j++) {
        if (j === candIdx) continue;
        const corr = matrix[candIdx][j];
        if (strongestCorr === null || corr > strongestCorr) {
          strongestCorr = corr;
          strongestToken = tokens[j];
        }
        if (corr >= maxCorr) {
          const pos = this.portfolio.positions[tokens[j]];
          const sym = (pos && pos.symbol) ? pos.symbol : String(pos?.address || tokens[j]).slice(0, 8);
          logger.info(
            `Correlation guard: ${candidateAddress.slice(0, 8)} is ${(corr * 100).toFixed(0)}% correlated ` +
            `with open position ${sym} — skipping`
          );
          return {
            blocked: true,
            reason: `Too correlated (${(corr * 100).toFixed(0)}%) with open position ${sym} — no diversification benefit`,
          };
        }
      }

      if (strongestToken) {
        const strongestPos = this.portfolio.positions[strongestToken];
        const strongestSym = strongestPos?.symbol || String(strongestPos?.address || strongestToken).slice(0, 8);
        logger.debug(
          `Correlation guard passed for ${candidateAddress.slice(0, 8)}: strongest open-position correlation ` +
          `was ${((strongestCorr || 0) * 100).toFixed(0)}% with ${strongestSym} ` +
          `(limit ${(maxCorr * 100).toFixed(0)}%)`
        );
      }
    } catch (err) {
      logger.warn(`Correlation check failed: ${err.message} — proceeding without it`);
    }

    return { blocked: false };
  }

  normalizeChain(chain) {
    const value = String(chain || '').trim().toLowerCase();
    if (value.includes('sol')) return 'solana';
    if (value.includes('bsc') || value.includes('binance')) return 'bsc';
    if (value.includes('base')) return 'base';
    return value;
  }

  getPositionValueUsd(position = {}) {
    const currentPrice = Number(position.currentPrice || position.entryPrice || 0);
    const quantity = Number(position.quantity || 0);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(currentPrice) && currentPrice > 0) {
      return quantity * currentPrice;
    }
    return Number(position.costBasisUsd || position.initialSizeUsd || 0);
  }

  getEquityBalanceUsd() {
    const cash = Number(this.portfolio.balance || 0);
    const exposure = Object.values(this.portfolio.positions || {})
      .reduce((sum, position) => sum + this.getPositionValueUsd(position), 0);
    const equity = cash + exposure;
    return Number.isFinite(equity) ? equity : cash;
  }

  resetDaily() {
    this.dailyStartBalance = this.getEquityBalanceUsd();
    this.haltedToday = false;
    logger.info('Risk guardian: daily reset complete');
  }

  checkDailyDrawdown() {
    if (!Number.isFinite(this.dailyStartBalance) || this.dailyStartBalance <= 0) {
      return true;
    }
    const currentEquity = this.getEquityBalanceUsd();
    const drawdown =
      ((this.dailyStartBalance - currentEquity) / this.dailyStartBalance) * 100;
    if (drawdown >= config.risk.dailyDrawdownLimitPct) {
      this.haltedToday = true;
      logger.warn(`DAILY DRAWDOWN LIMIT HIT: ${drawdown.toFixed(2)}% — bot halted for today`);
      return false;
    }
    return true;
  }

  checkPerformanceGate(stats = {}) {
    const baseline = Number(this.dailyStartBalance || 0);
    const equity = Number(this.getEquityBalanceUsd() || 0);
    const maxDailyLossPct = Number(config.risk.maxDailyLossPct || 2.5);
    const maxConsecutiveLosses = Number(config.risk.maxConsecutiveLosses || 4);
    const minTradesForKpiGate = Number(config.risk.minTradesForKpiGate || 40);
    const minProfitFactor = Number(config.risk.minProfitFactor || 1.15);
    const maxAverageSlippageBps = Number(config.risk.maxAverageSlippageBps || 180);

    if (baseline > 0) {
      const dailyPnlPct = ((equity - baseline) / baseline) * 100;
      if (dailyPnlPct <= -Math.abs(maxDailyLossPct)) {
        return {
          allowed: false,
          reason: `Daily loss ${Math.abs(dailyPnlPct).toFixed(2)}% exceeds limit ${Math.abs(maxDailyLossPct).toFixed(2)}%`,
        };
      }
    }

    if (Number(stats.consecutiveLosses || 0) >= Math.max(1, maxConsecutiveLosses)) {
      return {
        allowed: false,
        reason: `Consecutive losses ${stats.consecutiveLosses} reached limit ${maxConsecutiveLosses}`,
      };
    }

    const closedTrades = Number(stats.closedTrades || 0);
    if (closedTrades >= Math.max(1, minTradesForKpiGate)) {
      const profitFactor = Number(stats.profitFactor || 0);
      if (!Number.isFinite(profitFactor) || profitFactor < minProfitFactor) {
        return {
          allowed: false,
          reason: `Profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '0.00'} below minimum ${minProfitFactor.toFixed(2)}`,
        };
      }
    }

    const slippageSamples = Number(stats.slippageSamples || 0);
    const slippageGateSamples = Math.max(10, Math.floor(Math.max(1, minTradesForKpiGate) / 2));
    if (slippageSamples >= slippageGateSamples) {
      const avgSlippageBps = Number(stats.avgSlippageBps || 0);
      if (Number.isFinite(avgSlippageBps) && avgSlippageBps > Math.abs(maxAverageSlippageBps)) {
        return {
          allowed: false,
          reason: `Average slippage ${avgSlippageBps.toFixed(1)}bps exceeds limit ${Math.abs(maxAverageSlippageBps).toFixed(1)}bps`,
        };
      }
    }

    return { allowed: true };
  }

  getStrategyPositionCount(strategyName = 'momentum') {
    const normalized = String(strategyName || 'momentum').toLowerCase();
    return Object.values(this.portfolio.positions || {}).filter((position) => {
      const ownedBy = String(position?.strategy || 'momentum').toLowerCase();
      return ownedBy === normalized;
    }).length;
  }

  async canTrade(tokenData, priceHistories = {}, strategyName = 'momentum') {
    if (this.portfolio?.safeMode) {
      return { allowed: false, reason: 'safe mode active — operator review required' };
    }

    if (this.portfolio?.statePersistenceError) {
      return { allowed: false, reason: 'state persistence error — operator review required' };
    }

    if (this.portfolio?.balanceDriftHalt) {
      return { allowed: false, reason: 'balance drift too high — operator review required' };
    }

    if (this.haltedToday) {
      return { allowed: false, reason: 'Daily drawdown limit reached — bot halted' };
    }

    if (!this.checkDailyDrawdown()) {
      return { allowed: false, reason: 'Daily drawdown limit triggered' };
    }

    const performanceGate = this.checkPerformanceGate(this.portfolio.stats || {});
    if (!performanceGate.allowed) {
      return performanceGate;
    }

    const strategyLimit = Number(config.strategies?.[strategyName]?.maxConcurrentPositions || 3);
    const strategyOpenPositions = this.getStrategyPositionCount(strategyName);
    if (strategyOpenPositions >= strategyLimit) {
      return {
        allowed: false,
        reason: `${strategyName} max concurrent positions (${strategyLimit}) reached`,
      };
    }

    if (tokenData.liquidityUsd < config.risk.minLiquidityUsd) {
      return {
        allowed: false,
        reason: `Liquidity $${tokenData.liquidityUsd.toFixed(0)} below minimum $${config.risk.minLiquidityUsd}`,
      };
    }

    if (String(tokenData.signalSource || '').toLowerCase() === 'ai') {
      const aiConfidence = Number(tokenData.aiConfidence || 0);
      const minAiConfidence = Number(config.risk.aiConfidenceFloor || 70);
      if (!Number.isFinite(aiConfidence) || aiConfidence < minAiConfidence) {
        return {
          allowed: false,
          reason: `AI confidence ${Number.isFinite(aiConfidence) ? aiConfidence.toFixed(0) : 0}% below floor ${minAiConfidence}%`,
        };
      }
    }

    const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
    if (listingAgeHours > 0 && listingAgeHours < Number(config.risk.maxTokenAgeHours || 6)) {
      const stricterMinLiquidity = Number(config.risk.minLiquidityUsd) * 2;
      if (Number(tokenData.liquidityUsd || 0) < stricterMinLiquidity) {
        return {
          allowed: false,
          reason: `Token age ${listingAgeHours.toFixed(1)}h is high risk and liquidity is below stricter threshold $${stricterMinLiquidity.toFixed(0)}`,
        };
      }
    }

    // Enhanced honeypot check using GoPlus
    const isHoneypot = await this.checkHoneypot(tokenData.address, tokenData.chain);
    if (isHoneypot) {
      return { allowed: false, reason: 'Honeypot/scam detected by GoPlus — trade blocked' };
    }

    if (tokenData.topHoldersPct > 80) {
      return {
        allowed: false,
        reason: `Wallet concentration too high: top-10 hold ${tokenData.topHoldersPct}%`,
      };
    }

    const openPositions = Object.keys(this.portfolio.positions).length;
    if (openPositions >= config.risk.maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max concurrent positions (${config.risk.maxConcurrentPositions}) reached`,
      };
    }

    const candidateKey = this.buildPositionKey(tokenData.chainKey, tokenData.address);
    if (this.portfolio.positions[candidateKey]) {
      return { allowed: false, reason: 'Already have an open position in this token' };
    }

    // Correlation guard: skip if too correlated with an existing open position
    const corrCheck = this.checkCorrelation(candidateKey, tokenData.address, priceHistories);
    if (corrCheck.blocked) {
      return { allowed: false, reason: corrCheck.reason };
    }

    return { allowed: true };
  }

  positionSize(tokenData, strategyName = 'momentum') {
    const strategyPct = Number(config.strategies?.[strategyName]?.positionSizePct || config.risk.maxPositionSizePct || 3);
    let pct = strategyPct / 100;

    // Volatility adjustment
    const volatility = Math.abs(tokenData.priceChange24h || 0);
    if (volatility > 20) {
      pct *= 0.7; // Reduce by 30% for high volatility
      logger.info(`${tokenData.symbol}: high volatility (${volatility.toFixed(1)}%) — reducing position size by 30%`);
    } else if (volatility > 10) {
      pct *= 0.85; // Reduce by 15% for moderate volatility
      logger.info(`${tokenData.symbol}: moderate volatility (${volatility.toFixed(1)}%) — reducing position size by 15%`);
    }

    if (tokenData.teamWalletUnlocked) {
      pct *= 0.5;
      logger.warn(`${tokenData.symbol}: team wallet unlocked — reducing position size by 50%`);
    }

    if (tokenData.listingAgeDays < 1) {
      pct *= 0.5;
      logger.warn(`${tokenData.symbol}: listed < 24h — reducing position size by 50%`);
    }

    const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
    if (listingAgeHours > 0 && listingAgeHours < Number(config.risk.maxTokenAgeHours || 6)) {
      pct *= 0.6;
      logger.warn(`${tokenData.symbol}: listed < ${config.risk.maxTokenAgeHours}h — applying additional high-risk size cut`);
    }

    const equityUsd = this.getEquityBalanceUsd();
    const sizeUsd = equityUsd * pct;
    return Math.min(sizeUsd, this.portfolio.balance * 0.05);
  }

  stopLossPrice(entryPrice, strategyName = 'momentum') {
    const stopLossPct = Number(config.strategies?.[strategyName]?.stopLossPct || config.risk.stopLossPct || 8);
    return entryPrice * (1 - stopLossPct / 100);
  }

  takeProfitPrice(entryPrice, strategyName = 'momentum') {
    const takeProfitPct = Number(config.strategies?.[strategyName]?.takeProfitPct || config.risk.takeProfitPct || 25);
    return entryPrice * (1 + takeProfitPct / 100);
  }

  async checkHoneypot(tokenAddress, chain) {
    const normalizedChain = this.normalizeChain(chain);
    const cacheKey = `${normalizedChain}:${tokenAddress.toLowerCase()}`;
    
    // Check cache with TTL to prevent stale honeypot/safety status
    if (this.honeypotCache[cacheKey] !== undefined) {
      const cached = this.honeypotCache[cacheKey];
      const age = Date.now() - cached.timestamp;
      if (age < this.honeypotCacheTtlMs) {
        return cached.result; // Cache hit within TTL
      } else {
        delete this.honeypotCache[cacheKey]; // Cache expired, remove entry
      }
    }

    try {
      // Map chain names to GoPlus chain IDs
      const chainMap = {
        solana: 'solana',
        bsc: '56',
        base: '8453',
      };

      const chainId = chainMap[normalizedChain];
      if (!chainId) {
        logger.warn(`Unknown chain for honeypot check: ${chain}`);
        return false;
      }

      const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddress.toLowerCase()}`;
      const goplusApiKey = config.goplus?.apiKey;
      const headers = goplusApiKey
        ? {
          Authorization: `Bearer ${goplusApiKey}`,
          'X-API-KEY': goplusApiKey,
        }
        : {};
      const response = await axios.get(url, { timeout: 10000, headers });

      if (response.status !== 200) {
        logger.warn(`GoPlus API error for ${tokenAddress}: ${response.status}`);
        return false;
      }

      const data = response.data;
      const tokenData = data.result?.[tokenAddress.toLowerCase()];

      if (!tokenData) {
        logger.warn(`No GoPlus data for ${tokenAddress}`);
        return false;
      }

      // Check for honeypot, scam, or other red flags
      const isHoneypot = tokenData.is_honeypot === '1';
      const isScam = tokenData.is_scam === '1' || tokenData.is_blacklisted === '1';
      const hasHighRisk = tokenData.trading_cooldown === '1' || tokenData.transfer_pausable === '1';

      const result = isHoneypot || isScam || hasHighRisk;
      // Store result with timestamp for TTL expiration (30 minutes)
      this.honeypotCache[cacheKey] = { result, timestamp: Date.now() };

      if (result) {
        logger.warn(`${tokenAddress} flagged by GoPlus: honeypot=${isHoneypot}, scam=${isScam}, high_risk=${hasHighRisk}`);
      }

      return result;
    } catch (error) {
      logger.error(`Honeypot check failed for ${tokenAddress}: ${error.message}`);
      return false; // Default to safe if check fails
    }
  }
}

module.exports = RiskGuardian;
