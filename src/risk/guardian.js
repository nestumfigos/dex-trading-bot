'use strict';
const axios = require('axios');
const config = require('../../config');
const logger = require('../utils/logger');
const {
  calculateMomentumStopLossThrottle,
  evaluateSpotSymbolQuality,
} = require('./spot-entry-quality');
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
    this.dailyResetDate = null;
    this.haltedToday = false;
    // Cache with TTL: map of cacheKey => { result, timestamp }
    this.honeypotCache = {};
    this.honeypotCacheTtlMs = 30 * 60 * 1000; // 30 minutes
    // In-flight order tracking: { chainKey => totalUsd }
    this._inFlightUsd = {};
  }

  buildPositionKey(chainKey, address) {
    return `${String(chainKey || '').trim().toLowerCase()}:${String(address || '').trim().toLowerCase()}`;
  }

  registerInFlightOrder(chainKey, sizeUsd) {
    const k = String(chainKey || '').toLowerCase();
    this._inFlightUsd[k] = (this._inFlightUsd[k] || 0) + Math.max(0, Number(sizeUsd || 0));
  }

  releaseInFlightOrder(chainKey, sizeUsd) {
    const k = String(chainKey || '').toLowerCase();
    const current = Number(this._inFlightUsd[k] || 0);
    const release = Math.max(0, Number(sizeUsd || 0));
    if (release > current + 1e-6) {
      const mismatch = release - current;
      const mismatchPct = current > 0 ? (mismatch / current) * 100 : 100;
      logger.warn(
        `In-flight release > registration on ${k}: release=$${release.toFixed(2)} current=$${current.toFixed(2)} mismatch=$${mismatch.toFixed(2)} (${mismatchPct.toFixed(1)}%)`
      );
      if (current > 0 && mismatchPct > 10) {
        logger.error(`In-flight underflow on ${k}: mismatch >10%; clamping to 0 and emitting alert`);
      }
      this._inFlightUsd[k] = 0;
      return { ok: current === 0, mismatch, mismatchPct };
    }
    this._inFlightUsd[k] = Math.max(0, current - release);
    return { ok: true, mismatch: 0, mismatchPct: 0 };
  }

  invalidateHoneypotCache(tokenAddress, chain) {
    const normalizedChain = this.normalizeChain(chain);
    const cacheKey = `${normalizedChain}:${String(tokenAddress || '').toLowerCase()}`;
    delete this.honeypotCache[cacheKey];
  }

  getLocalDateStamp(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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

    if (!openKeys.length) {
      logger.debug(`Correlation guard skipped for ${candidateAddress.slice(0, 8)}: no open positions`);
      return { blocked: false };
    }
    if (!priceHistories[candidateKey]) {
      logger.debug(`Correlation guard: ${candidateAddress.slice(0, 8)} has no price history — applying conservative size cap`);
      return { blocked: false, noHistoryCapMultiplier: 0.5 };
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
        const row = matrix[candIdx];
        if (!Array.isArray(row) || j >= row.length) continue;
        const corr = row[j];
        if (!Number.isFinite(corr)) continue;
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

  getLearningState() {
    if (!this.portfolio.learning || typeof this.portfolio.learning !== 'object') {
      this.portfolio.learning = {
        badTokenMemory: {},
        sleevePerformance: {},
        brainProfiles: {},
      };
    }
    if (!this.portfolio.learning.badTokenMemory || typeof this.portfolio.learning.badTokenMemory !== 'object') {
      this.portfolio.learning.badTokenMemory = {};
    }
    if (!this.portfolio.learning.sleevePerformance || typeof this.portfolio.learning.sleevePerformance !== 'object') {
      this.portfolio.learning.sleevePerformance = {};
    }
    if (!this.portfolio.learning.brainProfiles || typeof this.portfolio.learning.brainProfiles !== 'object') {
      this.portfolio.learning.brainProfiles = {};
    }
    return this.portfolio.learning;
  }

  getBrainProfileKey(tokenData = {}, strategyName = 'momentum') {
    const chainKey = this.normalizeChain(tokenData.chainKey || tokenData.chain);
    const normalizedStrategy = String(strategyName || 'momentum').toLowerCase();
    const lane = String(tokenData.discoveryLane || tokenData.entryLane || 'unknown').toLowerCase();
    const trigger = String(tokenData.entryTriggerTimeframe || tokenData.triggerTimeframe || 'unknown').toLowerCase();
    return `${chainKey}:${normalizedStrategy}:${lane}:${trigger}`;
  }

  evaluateBrainProfile(tokenData = {}, strategyName = 'momentum') {
    if (config.risk?.learningEnabled === false || config.risk?.brainEnabled === false) {
      return { allowed: true, multiplier: 1, profileKey: null, reason: null };
    }

    const learning = this.getLearningState();
    const profileKey = this.getBrainProfileKey(tokenData, strategyName);
    const profile = learning.brainProfiles?.[profileKey];
    if (!profile || typeof profile !== 'object') {
      const unseenMultiplier = Math.max(0.1, Number(config.risk?.brainUnseenMultiplier || 0.75));
      return { allowed: true, multiplier: unseenMultiplier, profileKey, reason: null };
    }

    const minSamples = Math.max(3, Number(config.risk?.brainMinSamples || 8));
    const lowWinRatePct = Math.max(0, Number(config.risk?.brainLowWinRatePct || 35));
    const highWinRatePct = Math.max(lowWinRatePct, Number(config.risk?.brainHighWinRatePct || 60));
    const blockWinRatePct = Math.max(0, Number(config.risk?.brainBlockWinRatePct || 22));
    const exploreBypassPct = Math.max(0, Number(config.risk?.brainExploreBypassPct || 7));
    const reduceMultiplier = Math.max(0.1, Number(config.risk?.brainReduceMultiplier || 0.7));
    const boostMultiplier = Math.max(0.1, Number(config.risk?.brainBoostMultiplier || 1.1));
    const minMultiplier = Math.max(0.1, Number(config.risk?.brainMinMultiplier || 0.5));
    const maxMultiplier = Math.max(minMultiplier, Number(config.risk?.brainMaxMultiplier || 1.2));

    const samples = Number(profile.samples || 0);
    const recentWinRatePct = Number(
      Number.isFinite(Number(profile.recentWinRatePct))
        ? profile.recentWinRatePct
        : (samples > 0 ? (Number(profile.wins || 0) / samples) * 100 : 50)
    );

    let multiplier = 1;
    if (samples >= minSamples) {
      if (recentWinRatePct < lowWinRatePct) multiplier = reduceMultiplier;
      else if (recentWinRatePct >= highWinRatePct) multiplier = boostMultiplier;
    }
    multiplier = Math.max(minMultiplier, Math.min(maxMultiplier, multiplier));

    const hardBlock = samples >= (minSamples * 2) && recentWinRatePct < blockWinRatePct;
    if (hardBlock) {
      const bypassRoll = Math.random() * 100;
      const bypassed = bypassRoll < exploreBypassPct;
      if (!bypassed) {
        return {
          allowed: false,
          multiplier,
          profileKey,
          reason: `Brain blocked profile ${profileKey}: recent win rate ${recentWinRatePct.toFixed(1)}% over ${samples} samples`,
        };
      }
      logger.info(
        `${tokenData.symbol}: brain exploration bypass triggered for blocked profile ${profileKey} ` +
        `(roll=${bypassRoll.toFixed(1)} < ${exploreBypassPct.toFixed(1)})`
      );
    }

    return {
      allowed: true,
      multiplier,
      profileKey,
      reason: null,
    };
  }

  getLearningTokenKey(tokenData = {}) {
    const chainKey = this.normalizeChain(tokenData.chainKey || tokenData.chain);
    const address = String(tokenData.address || '').trim().toLowerCase();
    if (!chainKey || !address) return '';
    return `${chainKey}:${address}`;
  }

  checkLearnedBadPattern(tokenData = {}) {
    if (config.risk?.learningEnabled === false) {
      return { allowed: true };
    }

    const learning = this.getLearningState();
    const tokenKey = this.getLearningTokenKey(tokenData);
    if (!tokenKey) return { allowed: true };

    const record = learning.badTokenMemory[tokenKey];
    if (!record || typeof record !== 'object') {
      return { allowed: true };
    }

    const nowMs = Date.now();
    const banUntilMs = Date.parse(record.banUntil || '');
    const hardBan = Boolean(record.hardBan);
    const activeBan = hardBan || (Number.isFinite(banUntilMs) && banUntilMs > nowMs);

    if (!activeBan) {
      delete learning.badTokenMemory[tokenKey];
      return { allowed: true };
    }

    const banUntil = hardBan ? 'indefinite' : (record.banUntil || 'unknown');
    return {
      allowed: false,
      reason: `Learned bad pattern for ${tokenData.symbol || tokenKey} (${tokenKey}); blocked until ${banUntil}`,
      code: 'learned_bad_pattern',
    };
  }

  getPositionValueUsd(position = {}) {
    const currentPrice = Number(position.currentPrice || position.entryPrice || 0);
    const quantity = Number(position.quantity || 0);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(currentPrice) && currentPrice > 0) {
      return quantity * currentPrice;
    }
    return Number(position.costBasisUsd || position.initialSizeUsd || 0);
  }

  // Cost-basis valuation — used for heat/exposure checks so that price appreciation
  // on winners doesn't artificially inflate exposure and block new trades.
  //
  // B2.20 (verified no-change): Phase A audit 03-risk.md #5 suggested using
  // mark value for leverage calc. That recommendation assumed a leveraged
  // (margin/perp) bot. This is the SPOT bot — there is no leverage and there is
  // no leverage gate. The closest analog (`heatPct = exposure / capital`) uses
  // cost-basis intentionally per the rationale above. Perp bot (separate repo)
  // already uses mark-based liquidation math in `src/strategies/perps-sizing.js`.
  getPositionCostBasisUsd(position = {}) {
    const costBasis = Number(position.costBasisUsd || 0);
    if (Number.isFinite(costBasis) && costBasis > 0) return costBasis;
    return Number(position.initialSizeUsd || 0);
  }

  getEquityBalanceUsd() {
    const cash = Number(this.portfolio.balance || 0);
    const exposure = Object.values(this.portfolio.positions || {})
      .reduce((sum, position) => sum + this.getPositionValueUsd(position), 0);
    const equity = cash + exposure;
    return Number.isFinite(equity) ? equity : cash;
  }

  getChainWalletBalanceUsd(chainKey) {
    const normalized = this.normalizeChain(chainKey);
    const chainWalletBalance = Number(this.portfolio?.walletBalancesUsd?.[normalized]);
    if (Number.isFinite(chainWalletBalance) && chainWalletBalance > 0) {
      return chainWalletBalance;
    }
    // Paper-trading fallback (no-op on live): per-chain wallets don't exist in paper mode,
    // so allocate from total portfolio balance.
    //
    // C5 (Phase C): previous hardcode `/ 4` (chains-count assumption) caused
    // over-allocation when fewer than 4 chains were actively enabled (paper
    // running 2 chains saw double the intended per-chain wallet). Derive
    // divisor from config.chains.enabled when available; fall back to 4 only
    // if config shape unknown. Floor of 1 prevents divide-by-zero.
    if (config.paperTrading) {
      const totalBalance = Number(this.portfolio?.balance || 0);
      if (totalBalance > 0) {
        const enabledChains = Array.isArray(config?.chains?.enabled)
          ? config.chains.enabled.filter(Boolean)
          : null;
        const divisor = enabledChains && enabledChains.length > 0
          ? enabledChains.length
          : Math.max(1, Number(config?.chains?.activeChainCount) || 4);
        return totalBalance / divisor;
      }
    }
    return 0;
  }

  getChainExposureUsd(chainKey) {
    const normalized = this.normalizeChain(chainKey);
    const exemptSymbols = new Set((config.risk?.heatExemptSymbols || []).map(s => String(s).toUpperCase()));
    return Object.values(this.portfolio.positions || {}).reduce((sum, position) => {
      const positionChain = this.normalizeChain(position?.chainKey || position?.chain);
      if (positionChain !== normalized) return sum;
      const sym = String(position?.symbol || position?.token || '').toUpperCase();
      if (exemptSymbols.has(sym)) return sum;
      // Use cost basis (capital deployed), not current value. Otherwise winners
      // appear to consume more heat than they actually do, blocking new entries.
      return sum + this.getPositionCostBasisUsd(position);
    }, 0);
  }

  getChainCapitalBaseUsd(chainKey) {
    const normalized = this.normalizeChain(chainKey);
    const freeCashUsd = Number(this.getChainWalletBalanceUsd(normalized) || 0);
    const managedExposureUsd = Number(this.getChainExposureUsd(normalized) || 0);
    const unmanagedExposureUsd = Number(this.portfolio?.untrackedWalletPositionValueUsdByChain?.[normalized] || 0);
    const capitalBaseUsd = freeCashUsd + managedExposureUsd + unmanagedExposureUsd;
    // B4.risk.7: untracked-wallet exposure visibility. Audit 03-risk.md #7
    // flagged that operator-manual buys reduce available capital but never
    // trigger a kill switch. Warn-once per session when untracked exceeds 50%
    // of capital base — bot can't manage these positions, so a large untracked
    // bucket is an operator alert, not a block (we cannot exit something we
    // didn't open). Operator sees the alert in logs + can surface via dashboard.
    if (capitalBaseUsd > 0 && unmanagedExposureUsd / capitalBaseUsd > 0.5) {
      this._untrackedWalletWarned = this._untrackedWalletWarned || new Set();
      if (!this._untrackedWalletWarned.has(normalized)) {
        this._untrackedWalletWarned.add(normalized);
        logger.warn(`[RiskGuardian] untracked wallet exposure on ${normalized} = $${unmanagedExposureUsd.toFixed(2)} (${((unmanagedExposureUsd / capitalBaseUsd) * 100).toFixed(1)}% of capital). Bot cannot manage these positions; operator action recommended.`);
      }
    }
    return Number.isFinite(capitalBaseUsd) && capitalBaseUsd > 0 ? capitalBaseUsd : freeCashUsd;
  }

  getTodayChainPnlUsd(chainKey) {
    const normalized = this.normalizeChain(chainKey);
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const day = now.getUTCDate();

    return (this.portfolio.trades || []).reduce((sum, trade) => {
      if (trade?.type !== 'SELL') return sum;
      if (!Number.isFinite(Number(trade?.pnl))) return sum;
      const tradeChain = this.normalizeChain(trade?.chainKey || trade?.chain);
      if (tradeChain !== normalized) return sum;
      const ts = Date.parse(trade?.timestamp || '');
      if (!Number.isFinite(ts)) return sum;
      const dt = new Date(ts);
      if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month || dt.getUTCDate() !== day) return sum;
      return sum + Number(trade.pnl);
    }, 0);
  }

  checkPerChainDailyLoss(chainKey) {
    const normalized = this.normalizeChain(chainKey);
    const limits = config.risk?.maxDailyLossPctByChain || {};
    const rawLimit = Number(limits?.[normalized]);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      return { allowed: true };
    }

    const baseline = Number(this.dailyStartBalance || 0);
    if (!Number.isFinite(baseline) || baseline <= 0) {
      return { allowed: true };
    }

    const chainPnlUsd = this.getTodayChainPnlUsd(normalized);
    const limitUsd = baseline * (Math.abs(rawLimit) / 100);
    if (chainPnlUsd <= -limitUsd) {
      return {
        allowed: false,
        reason: `${normalized} daily loss ${Math.abs(chainPnlUsd).toFixed(2)} exceeds chain limit ${limitUsd.toFixed(2)} (${rawLimit.toFixed(2)}% of baseline)`,
        code: 'chain_daily_loss',
      };
    }
    return { allowed: true };
  }

  resetDaily() {
    this.dailyStartBalance = this.getEquityBalanceUsd();
    this.dailyResetDate = this.getLocalDateStamp();
    this.haltedToday = false;
    logger.info('Risk guardian: daily reset complete');
  }

  getCurrentDrawdownPct() {
    if (!Number.isFinite(this.dailyStartBalance) || this.dailyStartBalance <= 0) {
      return 0;
    }

    const currentEquity = this.getEquityBalanceUsd();
    const drawdown =
      ((this.dailyStartBalance - currentEquity) / this.dailyStartBalance) * 100;
    return Number.isFinite(drawdown) ? drawdown : 0;
  }

  reconcileDailyHaltState(context = 'runtime') {
    const drawdownPct = this.getCurrentDrawdownPct();
    const limitPct = Number(config.risk?.dailyDrawdownLimitPct || 0);

    if (!this.haltedToday) {
      return {
        changed: false,
        haltedToday: false,
        drawdownPct,
        limitPct,
      };
    }

    if (!Number.isFinite(limitPct) || limitPct <= 0 || drawdownPct < limitPct) {
      this.haltedToday = false;
      logger.warn(
        `Risk guardian: cleared stale daily halt during ${context} ` +
        `(drawdown ${drawdownPct.toFixed(2)}% vs limit ${Number.isFinite(limitPct) ? limitPct.toFixed(2) : '0.00'}%)`
      );
      return {
        changed: true,
        haltedToday: false,
        drawdownPct,
        limitPct,
      };
    }

    return {
      changed: false,
      haltedToday: true,
      drawdownPct,
      limitPct,
    };
  }

  checkDailyDrawdown() {
    if (!Number.isFinite(this.dailyStartBalance) || this.dailyStartBalance <= 0) {
      return true;
    }
    const drawdown = this.getCurrentDrawdownPct();
    if (drawdown >= config.risk.dailyDrawdownLimitPct) {
      this.haltedToday = true;
      logger.warn(`DAILY DRAWDOWN LIMIT HIT: ${drawdown.toFixed(2)}% — bot halted for today`);
      return false;
    }
    return true;
  }

  checkPerformanceGate(stats = {}, tokenData = null) {
    const baseline = Number(this.dailyStartBalance || 0);
    const equity = Number(this.getEquityBalanceUsd() || 0);
    const isPaperProfile = config.paperTrading === true || String(process.env.BOT_PROFILE || '').toLowerCase() === 'paper';
    const consecutiveLossGateDisabled = config.risk.consecutiveLossGateEnabled === false
      || (isPaperProfile && process.env.PAPER_DISABLE_CONSECUTIVE_LOSS_GATE === 'true');
    const kpiPerformanceGateDisabled = config.risk.kpiPerformanceGateEnabled === false
      || (isPaperProfile && process.env.PAPER_DISABLE_KPI_PERFORMANCE_GATE === 'true');
    const maxDailyLossPct = Number(config.risk.maxDailyLossPct || 2.5);
    const normalizedChain = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const chainSpecificLossLimit = Number(config.risk?.maxConsecutiveLossesByChain?.[normalizedChain]);
    const maxConsecutiveLosses = Number.isFinite(chainSpecificLossLimit) && chainSpecificLossLimit > 0
      ? chainSpecificLossLimit
      : Number(config.risk.maxConsecutiveLosses || 4);
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

    if (!consecutiveLossGateDisabled && Number(stats.consecutiveLosses || 0) >= Math.max(1, maxConsecutiveLosses)) {
      return {
        allowed: false,
        reason: `Consecutive losses ${stats.consecutiveLosses} reached limit ${maxConsecutiveLosses}`,
      };
    }

    const closedTrades = Number(stats.closedTrades || 0);
    if (!kpiPerformanceGateDisabled && closedTrades >= Math.max(1, minTradesForKpiGate)) {
      // profitFactor === null means "no losses yet" (all wins so far) — skip the gate; it cannot be failing.
      // profitFactor === 0 means no closed trades at all — also skip.
      const rawPf = stats.profitFactor;
      if (rawPf !== null && rawPf !== undefined) {
        const profitFactor = Number(rawPf);
        if (!Number.isFinite(profitFactor) || profitFactor < minProfitFactor) {
          return {
            allowed: false,
            reason: `Profit factor ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : '0.00'} below minimum ${minProfitFactor.toFixed(2)}`,
          };
        }
      } else {
        // B4.risk.8: visibility for "all wins, no losses" skip path. Phase A
        // audit 03-risk.md #8 flagged this skip as silent. With 40+ closed
        // trades and zero losses, a win streak is real signal — but the
        // operator should see that the PF gate is being skipped because of it,
        // not because of a bug. Warn-once per session to avoid log spam.
        this._pfGateSkipWarned = this._pfGateSkipWarned || false;
        if (!this._pfGateSkipWarned) {
          this._pfGateSkipWarned = true;
          logger.warn(`[RiskGuardian] profit-factor gate skipped: ${closedTrades} closed trades, zero losses. Edge unvalidated until first loss. Verify strategy isn't masking a sampling artifact.`);
        }
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

  getSleeveKey(tokenLike = {}, strategyName = 'momentum') {
    const chainKey = this.normalizeChain(tokenLike?.chainKey || tokenLike?.chain);
    const strategyKey = String(strategyName || tokenLike?.strategy || 'momentum').toLowerCase();
    return `${chainKey}:${strategyKey}`;
  }

  getConfiguredMinLiquidityUsd(tokenData = {}) {
    const chainKey = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const chainSpecific = Number(config.risk?.minLiquidityUsdByChain?.[chainKey]);
    if (Number.isFinite(chainSpecific) && chainSpecific > 0) {
      return chainSpecific;
    }
    return Number(config.risk?.minLiquidityUsd || 0);
  }

  getConfiguredYoungTokenMinLiquidityUsd(tokenData = {}) {
    const chainKey = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const chainSpecific = Number(config.risk?.youngTokenMinLiquidityUsdByChain?.[chainKey]);
    if (Number.isFinite(chainSpecific) && chainSpecific > 0) {
      return chainSpecific;
    }
    return this.getConfiguredMinLiquidityUsd(tokenData) * 2;
  }

  getExposureBySleeveUsd() {
    return Object.values(this.portfolio.positions || {}).reduce((accumulator, position) => {
      const sleeveKey = this.getSleeveKey(position, position?.strategy || 'momentum');
      const exposureUsd = this.getPositionValueUsd(position);
      if (Number.isFinite(exposureUsd) && exposureUsd > 0) {
        accumulator[sleeveKey] = Number(accumulator[sleeveKey] || 0) + exposureUsd;
      }
      return accumulator;
    }, {});
  }

  /**
   * Calculate per-chain heat (exposure) against that chain wallet balance.
   * Heat = chain open exposure / chain wallet balance.
   * Returns { heatPct, totalSizeUsd, chainWalletBalanceUsd, blocked, reason }.
   */
  checkPortfolioHeat(tokenData = {}, strategyName = 'momentum') {
    const chainKey = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const chainCapitalBaseUsd = this.getChainCapitalBaseUsd(chainKey);
    const chainWalletBalanceUsd = this.getChainWalletBalanceUsd(chainKey);
    if (!Number.isFinite(chainCapitalBaseUsd) || chainCapitalBaseUsd <= 0) {
      return { heatPct: 0, totalSizeUsd: 0, chainWalletBalanceUsd, chainCapitalBaseUsd, blocked: false };
    }

    let maxChainHeatPct = Number(config.risk?.maxPortfolioHeatPct || 40);
    const chainKeyLower = String(chainKey).toLowerCase();
    // B4.risk.9 (verified no-fix): the KuCoin per-chain cap is enforced in
    // checkChainHeat (this fn) which runs PRE-order via the risk gates. Audit
    // 03-risk.md #9 flagged it as "soft multiplier during sizing"; grep
    // confirms `kucoinMaxPositionSizePct` is referenced ONLY here in the chain-
    // heat path, never in sizing. No fix needed. If a future code path adds a
    // sizing-side reference, that path must also call this gate.
    if (chainKeyLower === 'kucoin' && config.risk?.kucoinMaxPositionSizePct) {
      maxChainHeatPct = Number(config.risk.kucoinMaxPositionSizePct);
    }
    if (chainKey === 'kucoin' && Number(config.risk?.kucoinMaxPositionSizePct)) {
      maxChainHeatPct = Number(config.risk.kucoinMaxPositionSizePct);
    }
    if (chainKeyLower === 'kucoin' && String(strategyName || '').toLowerCase() === 'momentum') {
      const momentumAllowance = Number(config.risk?.kucoinMomentumHeatAllowancePct || 0);
      if (Number.isFinite(momentumAllowance) && momentumAllowance > 0) {
        maxChainHeatPct = Math.max(maxChainHeatPct, momentumAllowance);
      }
    }
    if (chainKeyLower === 'kucoin' && String(strategyName || '').toLowerCase() === 'swing') {
      const swingAllowance = Number(config.risk?.kucoinSwingHeatAllowancePct || 0);
      if (Number.isFinite(swingAllowance) && swingAllowance > 0) {
        maxChainHeatPct = Math.max(maxChainHeatPct, swingAllowance);
      }
    }
    if (chainKeyLower === 'bsc' && String(strategyName || '').toLowerCase() === 'momentum') {
      const bscAllowance = Number(config.risk?.bscMomentumHeatAllowancePct || 0);
      if (Number.isFinite(bscAllowance) && bscAllowance > 0) {
        maxChainHeatPct = Math.max(maxChainHeatPct, bscAllowance);
      }
    }
    const candidateSizeUsd = this.positionSize(tokenData, strategyName);
    const inFlightUsd = Number(this._inFlightUsd[String(chainKey).toLowerCase()] || 0);
    const totalSizeUsd = this.getChainExposureUsd(chainKey) + inFlightUsd;
    const currentHeatPct = (totalSizeUsd / chainCapitalBaseUsd) * 100;
    const projectedTotalSizeUsd = totalSizeUsd + Math.max(0, candidateSizeUsd);
    const heatPct = (projectedTotalSizeUsd / chainCapitalBaseUsd) * 100;
    const blocked = heatPct > maxChainHeatPct;

    if (blocked) {
      logger.warn(
        `Chain heat check (${chainKey}): projected ${heatPct.toFixed(1)}% exposure ` +
        `exceeds limit ${maxChainHeatPct}% ($${projectedTotalSizeUsd.toFixed(2)} / $${chainCapitalBaseUsd.toFixed(2)} chain capital base, free cash $${chainWalletBalanceUsd.toFixed(2)})`
      );
    }

    return {
      heatPct,
      currentHeatPct,
      totalSizeUsd,
      chainWalletBalanceUsd,
      chainCapitalBaseUsd,
      blocked,
      candidateSizeUsd,
      code: blocked ? 'portfolio_heat' : undefined,
      reason: blocked
        ? `${chainKey} heat ${heatPct.toFixed(1)}% exceeds limit ${maxChainHeatPct}%`
        : undefined,
    };
  }

  getTotalInFlightUsd() {
    return Object.values(this._inFlightUsd || {}).reduce((sum, v) => sum + Number(v || 0), 0);
  }

  getGlobalGrossExposureUsd() {
    const exemptSymbols = new Set((config.risk?.heatExemptSymbols || []).map((s) => String(s).toUpperCase()));
    const exposureFromPositions = Object.values(this.portfolio.positions || {}).reduce((sum, position) => {
      const sym = String(position?.symbol || position?.token || '').toUpperCase();
      if (exemptSymbols.has(sym)) return sum;
      return sum + this.getPositionCostBasisUsd(position);
    }, 0);
    return exposureFromPositions + this.getTotalInFlightUsd();
  }

  /**
   * Aggregate exposure cap across ALL chains + in-flight.
   * Without this, per-chain caps allow stacking (e.g. 45% sol + 45% bsc + 45% kucoin = 135% gross).
   * Returns same shape as checkPortfolioHeat.
   */
  checkGlobalExposure(tokenData = {}, strategyName = 'momentum') {
    const equityUsd = Math.max(0, Number(this.getEquityBalanceUsd() || 0));
    if (equityUsd <= 0) {
      return { exposurePct: 0, blocked: false };
    }
    const maxGlobalExposurePct = Number(config.risk?.maxGlobalExposurePct ?? 90);
    const candidateSizeUsd = Math.max(0, Number(this.positionSize(tokenData, strategyName) || 0));
    const currentGrossUsd = this.getGlobalGrossExposureUsd();
    const projectedGrossUsd = currentGrossUsd + candidateSizeUsd;
    const exposurePct = (projectedGrossUsd / equityUsd) * 100;
    const blocked = exposurePct > maxGlobalExposurePct;
    if (blocked) {
      logger.warn(
        `Global exposure check: projected ${exposurePct.toFixed(1)}% ($${projectedGrossUsd.toFixed(2)} / $${equityUsd.toFixed(2)} equity) exceeds cap ${maxGlobalExposurePct}%`
      );
    }
    return {
      exposurePct,
      currentExposurePct: (currentGrossUsd / equityUsd) * 100,
      projectedGrossUsd,
      equityUsd,
      candidateSizeUsd,
      blocked,
      code: blocked ? 'global_exposure_cap' : undefined,
      reason: blocked
        ? `global gross exposure ${exposurePct.toFixed(1)}% exceeds cap ${maxGlobalExposurePct}% (prevents cross-chain stacking)`
        : undefined,
    };
  }

  async canTrade(tokenData, priceHistories = {}, strategyName = 'momentum') {
    const normalizedChain = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    if (!config.paperTrading && normalizedChain === 'bsc' && config.risk?.liveBscEntriesEnabled !== true) {
      return {
        allowed: false,
        reason: 'live bsc entries disabled',
        code: 'live_bsc_disabled',
      };
    }
    if (this.portfolio?.safeMode) {
      return { allowed: false, reason: 'safe mode active — operator review required' };
    }

    if (this.portfolio?.statePersistenceError) {
      // 2026-05-31 audit (cycle-2 P1): NEVER auto-clear. The prior 60s timer
      // cleared the flag without proving writes actually worked, so the
      // strategy would resume entering trades while state durability was
      // still broken — losing the audit trail and PnL accounting of every
      // trade taken in that window. Fail closed until either (a) the
      // persistence layer itself clears the flag after a successful write,
      // or (b) the operator explicitly clears it via the dashboard /api/state
      // endpoint. Stamping `statePersistenceErrorLastChecked` is kept so the
      // dashboard can show how long the bot has been frozen.
      this.portfolio.statePersistenceErrorLastChecked = Date.now();
      return { allowed: false, reason: 'state persistence error — operator review required (no auto-clear)' };
    }

    if (this.portfolio?.balanceDriftHalt) {
      const driftPct = Number(this.portfolio?.balanceDrift?.pct || 0);
      const maxBalanceDriftPct = Math.max(0, Number(config.risk?.maxBalanceDriftPct || 10));
      if (Number.isFinite(driftPct) && driftPct <= maxBalanceDriftPct) {
        this.portfolio.balanceDriftHalt = false;
        logger.info(`Balance drift halt cleared automatically: ${driftPct.toFixed(2)}% <= ${maxBalanceDriftPct.toFixed(2)}%`);
      } else {
        return { allowed: false, reason: 'balance drift too high — operator review required', code: 'balance_drift' };
      }
    }

    if (this.haltedToday) {
      return { allowed: false, reason: 'Daily drawdown limit reached — bot halted' };
    }

    if (!this.checkDailyDrawdown()) {
      return { allowed: false, reason: 'Daily drawdown limit triggered' };
    }

    const chainRisk = this.checkPerChainDailyLoss(tokenData.chainKey || tokenData.chain);
    if (!chainRisk.allowed) {
      return chainRisk;
    }

    const symbolQualityGate = evaluateSpotSymbolQuality({
      tokenData,
      strategyName,
      trades: this.portfolio?.trades || [],
    });
    if (!symbolQualityGate.allow) {
      return {
        allowed: false,
        reason: symbolQualityGate.reason,
        code: symbolQualityGate.reason,
        details: symbolQualityGate.details || null,
      };
    }

    const performanceGate = this.checkPerformanceGate(this.portfolio.stats || {}, tokenData);
    if (!performanceGate.allowed) {
      return performanceGate;
    }

    const learnedPatternGate = this.checkLearnedBadPattern(tokenData);
    if (!learnedPatternGate.allowed) {
      return learnedPatternGate;
    }

    const brainDecision = this.evaluateBrainProfile(tokenData, strategyName);
    if (!brainDecision.allowed) {
      return {
        allowed: false,
        reason: brainDecision.reason,
        code: 'brain_profile_block',
      };
    }
    tokenData._brainSizeMultiplier = Number(brainDecision.multiplier || 1);
    tokenData._brainProfileKey = brainDecision.profileKey || undefined;

    const portfolioHeat = this.checkPortfolioHeat(tokenData, strategyName);
    if (portfolioHeat.blocked) {
      return {
        allowed: false,
        reason: portfolioHeat.reason,
        code: portfolioHeat.code || 'portfolio_heat',
      };
    }

    const globalExposure = this.checkGlobalExposure(tokenData, strategyName);
    if (globalExposure.blocked) {
      return {
        allowed: false,
        reason: globalExposure.reason,
        code: globalExposure.code || 'global_exposure_cap',
      };
    }

    if (strategyName === 'momentum') {
      const minMove24hPctAll = Math.max(0, Number(config.strategies?.momentum?.minPriceChange24hPctAll || 0));
      const maxMove24hPctAll = Math.max(0, Number(config.strategies?.momentum?.maxPriceChange24hPctAll || 0));
      const minMove24hPct = normalizedChain === 'kucoin'
        ? Math.max(minMove24hPctAll, Number(config.strategies?.momentum?.minPriceChange24hPctKucoin || 0))
        : minMove24hPctAll;
      const maxMove24hPct = normalizedChain === 'kucoin'
        ? Math.max(0, Number(config.strategies?.momentum?.maxPriceChange24hPctKucoin || maxMove24hPctAll || 0))
        : maxMove24hPctAll;
      const move24hPct = Math.abs(Number(tokenData?.priceChange24h || 0));
      if (Number.isFinite(minMove24hPct) && minMove24hPct > 0 && move24hPct < minMove24hPct) {
        return {
          allowed: false,
          reason: `${normalizedChain || 'token'} momentum 24h move ${move24hPct.toFixed(2)}% below minimum ${minMove24hPct.toFixed(2)}%`,
          code: 'momentum_min_momentum_24h',
        };
      }
      if (Number.isFinite(maxMove24hPct) && maxMove24hPct > 0 && move24hPct > maxMove24hPct) {
        return {
          allowed: false,
          reason: `${normalizedChain || 'token'} momentum 24h move ${move24hPct.toFixed(2)}% above max ${maxMove24hPct.toFixed(2)}% (late chase guard)`,
          code: 'momentum_max_momentum_24h',
        };
      }
    }

    const strategyLimit = Number(config.strategies?.[strategyName]?.maxConcurrentPositions || 3);
    const strategyOpenPositions = this.getStrategyPositionCount(strategyName);
    if (strategyOpenPositions >= strategyLimit) {
      return {
        allowed: false,
        reason: `${strategyName} max concurrent positions (${strategyLimit}) reached`,
        code: 'max_concurrent_positions',
      };
    }

    // Per-chain position limit.
    // Optional chain overrides via MAX_POSITIONS_PER_CHAIN_BY_CHAIN JSON, e.g. {"kucoin":4,"bsc":3}
    const chainLimitMap = (() => {
      try {
        const parsed = JSON.parse(process.env.MAX_POSITIONS_PER_CHAIN_BY_CHAIN || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    })();
    const chainKeyForLimit = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const chainSpecificLimit = Number(chainLimitMap[String(chainKeyForLimit || '').toLowerCase()]);
    const maxPerChain = Number.isFinite(chainSpecificLimit) && chainSpecificLimit > 0
      ? chainSpecificLimit
      : Number(process.env.MAX_POSITIONS_PER_CHAIN || 3);
    const chainPositionCount = Object.values(this.portfolio.positions || {}).filter(
      (p) => this.normalizeChain(p.chainKey || p.chain) === chainKeyForLimit
    ).length;
    if (chainPositionCount >= maxPerChain) {
      return {
        allowed: false,
        reason: `${chainKeyForLimit} per-chain position limit (${maxPerChain}) reached`,
        code: 'per_chain_position_limit',
      };
    }

    const minLiquidityUsd = this.getConfiguredMinLiquidityUsd(tokenData);
    if (Number(tokenData.liquidityUsd || 0) < minLiquidityUsd) {
      return {
        allowed: false,
        reason: `Liquidity $${Number(tokenData.liquidityUsd || 0).toFixed(0)} below minimum $${minLiquidityUsd}`,
        code: 'liquidity',
      };
    }

    // Market-impact gate: block entries where estimated AMM slippage exceeds the threshold.
    // Uses the constant-product (x*y=k) approximation: impact = tradeSize / (liquidity + tradeSize).
    const impactCheck = this.estimateMarketImpact(tokenData, strategyName);
    if (impactCheck.blocked) {
      return { allowed: false, reason: impactCheck.reason, code: 'market_impact' };
    }

    if (String(tokenData.signalSource || '').toLowerCase() === 'ai') {
      const aiConfidence = Number(tokenData.aiConfidence || 0);
      const minAiConfidence = Number(config.risk.aiConfidenceFloor || 70);
      if (!Number.isFinite(aiConfidence) || aiConfidence < minAiConfidence) {
        return {
          allowed: false,
          reason: `AI confidence ${Number.isFinite(aiConfidence) ? aiConfidence.toFixed(0) : 0}% below floor ${minAiConfidence}%`,
          code: 'ai_confidence_floor',
        };
      }
    }

    const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
    if (listingAgeHours > 0 && listingAgeHours < Number(config.risk.maxTokenAgeHours || 6)) {
      const stricterMinLiquidity = this.getConfiguredYoungTokenMinLiquidityUsd(tokenData);
      if (Number(tokenData.liquidityUsd || 0) < stricterMinLiquidity) {
        return {
          allowed: false,
          reason: `Token age ${listingAgeHours.toFixed(1)}h is high risk and liquidity is below stricter threshold $${stricterMinLiquidity.toFixed(0)}`,
          code: 'young_token_liquidity',
        };
      }
    }

    // Enhanced honeypot check using GoPlus
    const honeypotCheck = await this.checkHoneypot(tokenData.address, tokenData.chain);
    if (honeypotCheck.blocked) {
      return { allowed: false, reason: 'Honeypot/scam detected by GoPlus — trade blocked', code: 'honeypot' };
    }

    const chainKey = this.normalizeChain(tokenData.chainKey || tokenData.chain);
    const DEX_CHAINS_GUARDIAN = ['bsc', 'solana', 'base'];
    if (DEX_CHAINS_GUARDIAN.includes(chainKey) && !config.paperTrading && honeypotCheck.unavailable) {
      const fallbackEnabled = config.risk?.goplusFallbackHeuristicEnabled !== false;
      if (fallbackEnabled) {
        const buyTax = Number(tokenData.buyTax || 0);
        const sellTax = Number(tokenData.sellTax || 0);
        const topHoldersPct = Number(tokenData.topHoldersPct || 0);
        const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
        const liquidityUsd = Number(tokenData.liquidityUsd || 0);

        const taxRedFlag = buyTax > 8 || sellTax > 8;
        const concentrationRedFlag = topHoldersPct > 70;
        const tooNew = listingAgeHours > 0 && listingAgeHours < 1;
        const tooThin = liquidityUsd > 0 && liquidityUsd < Math.max(20000, Number(config.risk?.goplusFallbackMinLiquidityUsd || 30000));

        if (taxRedFlag || concentrationRedFlag || tooNew || tooThin) {
          const reasons = [];
          if (taxRedFlag) reasons.push(`tax buy=${buyTax}% sell=${sellTax}%`);
          if (concentrationRedFlag) reasons.push(`top holders ${topHoldersPct}%`);
          if (tooNew) reasons.push(`age ${listingAgeHours.toFixed(1)}h`);
          if (tooThin) reasons.push(`liquidity $${liquidityUsd.toFixed(0)}`);
          return {
            allowed: false,
            reason: `GoPlus unavailable — heuristic fallback blocked: ${reasons.join(', ')}`,
            code: 'goplus_fallback_blocked',
          };
        }

        logger.warn(`GoPlus unavailable for ${tokenData.symbol} on ${chainKey} — passed heuristic fallback`);
        tokenData._goplusHeuristicFallback = true;
      } else {
        return {
          allowed: false,
          reason: `GoPlus security data unavailable for ${chainKey.toUpperCase()} token - trade blocked in live mode`,
          code: 'goplus_unavailable',
        };
      }
    }
    const unknownTopHoldersPct = tokenData.topHoldersPct == null || !Number.isFinite(Number(tokenData.topHoldersPct));
    if (chainKey === 'bsc' && !config.paperTrading && unknownTopHoldersPct) {
      return {
        allowed: false,
        reason: 'BSC holder concentration data unavailable — trade blocked in live mode',
        code: 'unknown_holder_concentration',
      };
    }

    if (Number(tokenData.topHoldersPct) > 80) {
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
    if (corrCheck.noHistoryCapMultiplier) {
      tokenData._corrNoHistoryMultiplier = corrCheck.noHistoryCapMultiplier;
    }

    return { allowed: true };
  }

  positionSize(tokenData, strategyName = 'momentum') {
    const chainKey = this.normalizeChain(tokenData?.chainKey || tokenData?.chain);
    const strategyCfg = config.strategies?.[strategyName] || {};
    let pct = 0.30;

    const regimeScalingEnabled = config.risk?.regimeSizeScalingEnabled !== false;
    if (regimeScalingEnabled) {
      const realizedVolPct = Number(tokenData?.realizedVolPct);
      const highVolThresholdPct = Number(config.risk?.regimeHighVolThresholdPct || 4);
      const extremeVolThresholdPct = Number(config.risk?.regimeExtremeVolThresholdPct || 7);
      const normalMult = Number(config.risk?.regimeNormalSizeMultiplier || 1);
      const highVolMult = Number(config.risk?.regimeHighVolSizeMultiplier || 0.75);
      const extremeVolMult = Number(config.risk?.regimeExtremeVolSizeMultiplier || 0.5);

      let regimeMultiplier = normalMult;
      let regimeLabel = String(tokenData?.marketRegime || 'normal').toLowerCase();
      if (Number.isFinite(realizedVolPct)) {
        if (realizedVolPct >= extremeVolThresholdPct) {
          regimeLabel = 'extreme_volatility';
          regimeMultiplier = extremeVolMult;
        } else if (realizedVolPct >= highVolThresholdPct) {
          regimeLabel = 'high_volatility';
          regimeMultiplier = highVolMult;
        }
      } else if (regimeLabel.includes('high')) {
        regimeMultiplier = highVolMult;
      }

      regimeMultiplier = Math.max(0.1, Math.min(1.2, regimeMultiplier));
      pct *= regimeMultiplier;
      logger.info(
        `${tokenData.symbol}: regime sizing (${regimeLabel}) multiplier ${regimeMultiplier.toFixed(2)}` +
        `${Number.isFinite(realizedVolPct) ? `, realized vol ${realizedVolPct.toFixed(2)}%` : ''}`
      );
    }

    const brainMultiplier = Number(tokenData?._brainSizeMultiplier || 1);
    if (Number.isFinite(brainMultiplier) && brainMultiplier > 0) {
      pct *= brainMultiplier;
      logger.info(
        `${tokenData.symbol}: brain sizing multiplier ${brainMultiplier.toFixed(2)}` +
        `${tokenData?._brainProfileKey ? ` (profile=${tokenData._brainProfileKey})` : ''}`
      );
    }

    // Recovery mode — shrink position to preserve capital while in a losing hole
    const recoveryMultiplier = Number(tokenData?._recoveryMultiplier || 1);
    const recoverySeverity = String(tokenData?._recoverySeverity || 'none');
    if (recoveryMultiplier < 1 && recoverySeverity !== 'none') {
      pct *= recoveryMultiplier;
      logger.warn(
        `${tokenData.symbol}: RECOVERY(${recoverySeverity.toUpperCase()}) size multiplier ${recoveryMultiplier.toFixed(2)} ` +
        `— bot is in a hole, preserving capital until ${recoverySeverity === 'deep' ? '3' : '2'} consecutive wins`
      );
    }

    // Macro intelligence size multiplier — adjusts for market sentiment
    const macroSizeMultiplier = Number(tokenData?._macroSizeMultiplier || 1);
    if (macroSizeMultiplier !== 1 && Number.isFinite(macroSizeMultiplier) && macroSizeMultiplier > 0) {
      pct *= macroSizeMultiplier;
      logger.info(`${tokenData.symbol}: macro intelligence size multiplier ${macroSizeMultiplier.toFixed(2)}`);
    }

    const corrNoHistoryMultiplier = Number(tokenData?._corrNoHistoryMultiplier || 1);
    if (corrNoHistoryMultiplier < 1) {
      pct *= corrNoHistoryMultiplier;
      logger.info(`${tokenData.symbol}: correlation no-history cap multiplier ${corrNoHistoryMultiplier.toFixed(2)}`);
    }

    if (chainKey === 'kucoin' && String(strategyName || '').toLowerCase() === 'momentum') {
      const stopThrottle = calculateMomentumStopLossThrottle({
        chain: chainKey,
        strategyName,
        trades: this.portfolio?.trades || [],
        enabled: config.risk?.momentumStopLossThrottleEnabled !== false,
        lookbackHours: config.risk?.momentumStopLossThrottleLookbackHours,
        baseMultiplier: config.risk?.momentumStopLossThrottleBaseMultiplier,
        floorMultiplier: config.risk?.momentumStopLossThrottleFloorMultiplier,
        minLossUsd: config.risk?.momentumStopLossThrottleMinLossUsd,
      });
      if (Number(stopThrottle.multiplier) > 0 && stopThrottle.multiplier < 1) {
        pct *= stopThrottle.multiplier;
        logger.warn(
          `${tokenData.symbol}: KuCoin momentum stop-loss throttle ${stopThrottle.multiplier.toFixed(2)}x ` +
          `after ${stopThrottle.recentStopLosses} recent stop-loss exits`
        );
      }
    }

    const rolloutMultiplier = Number(tokenData?._promotionRolloutMultiplier || 1);
    const rolloutStage = String(tokenData?._promotionRolloutStage || '');
    if (rolloutMultiplier > 0 && rolloutMultiplier !== 1) {
      pct *= rolloutMultiplier;
      logger.warn(
        `${tokenData.symbol}: promotion rollout multiplier ${rolloutMultiplier.toFixed(2)}` +
        `${rolloutStage ? ` (stage=${rolloutStage})` : ''}`
      );
    }

    if (config.risk?.adaptiveSizingEnabled !== false) {
      const learning = this.getLearningState();
      const sleeveKey = `${chainKey}:${String(strategyName || 'momentum').toLowerCase()}`;
      const sleeve = learning.sleevePerformance?.[sleeveKey];
      const adaptiveMultiplier = Number(sleeve?.sizeMultiplier || 1);
      if (Number.isFinite(adaptiveMultiplier) && adaptiveMultiplier > 0) {
        pct *= adaptiveMultiplier;
        const winRateText = Number.isFinite(Number(sleeve?.recentWinRatePct))
          ? Number(sleeve.recentWinRatePct).toFixed(1)
          : 'n/a';
        logger.info(
          `${tokenData.symbol}: adaptive sleeve multiplier ${adaptiveMultiplier.toFixed(2)} ` +
          `(sleeve=${sleeveKey}, recentWinRate=${winRateText}%)`
        );
      }
    }

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
      logger.warn(`${tokenData.symbol}: team wallet unlocked - reducing position size by 50%`);
    }

    const discoveryLane = String(tokenData?.discoveryLane || tokenData?.entryLane || '').toLowerCase();
    if (chainKey === 'bsc' && discoveryLane === 'exploration') {
      const explorationMultiplier = Number(strategyCfg.bscExplorationPositionSizeMultiplier || 0.6);
      pct *= explorationMultiplier;
      logger.info(`${tokenData.symbol}: BSC exploration lane multiplier ${explorationMultiplier.toFixed(2)}`);
    }

    if (chainKey === 'bsc' && discoveryLane === 'borderline') {
      const borderlineMultiplier = Number(strategyCfg.bscBorderlinePositionSizeMultiplier || 0.35);
      pct *= borderlineMultiplier;
      logger.info(`${tokenData.symbol}: BSC borderline lane multiplier ${borderlineMultiplier.toFixed(2)}`);
    }

    if (chainKey === 'bsc' && String(tokenData?.entryTriggerTimeframe || '').toLowerCase() === 'bsc_relaxed_continuation') {
      const relaxedMultiplier = Number(strategyCfg.bscRelaxedPositionSizeMultiplier || 0.85);
      pct *= relaxedMultiplier;
      logger.info(`${tokenData.symbol}: BSC relaxed continuation multiplier ${relaxedMultiplier.toFixed(2)}`);
    }

    if (chainKey === 'kucoin' && tokenData?.isEarlyBreakout === true) {
      const ebMultiplier = Number(config.risk?.kucoinEarlyBreakoutPositionSizeMultiplier || 0.70);
      pct *= ebMultiplier;
      logger.info(`${tokenData.symbol}: KuCoin early breakout position size multiplier ${ebMultiplier.toFixed(2)}`);
    }

    if (tokenData?._goplusHeuristicFallback === true) {
      const fallbackMultiplier = Number(config.risk?.goplusFallbackSizeMultiplier || 0.5);
      pct *= fallbackMultiplier;
      logger.info(`${tokenData.symbol}: GoPlus fallback size multiplier ${fallbackMultiplier.toFixed(2)}`);
    }

    let agePenaltyMultiplier = 1;
    if (tokenData.listingAgeDays < 1) {
      pct *= 0.5;
      agePenaltyMultiplier *= 0.5;
      logger.warn(`${tokenData.symbol}: listed < 24h — reducing position size by 50%`);
    }

    const maxTokenAgeHours = Number(config.risk.maxTokenAgeHours || 6);
    const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
    if (listingAgeHours > 0 && listingAgeHours < maxTokenAgeHours) {
      pct *= 0.6;
      agePenaltyMultiplier *= 0.6;
      logger.warn(`${tokenData.symbol}: listed < ${maxTokenAgeHours}h — applying additional high-risk size cut (40%)`);
    }

    if (agePenaltyMultiplier < 1) {
      logger.warn(
        `${tokenData.symbol}: compounded age penalty multiplier ${(agePenaltyMultiplier * 100).toFixed(0)}% ` +
        `(effective size cut ${(100 - agePenaltyMultiplier * 100).toFixed(0)}%)`
      );
    }

    let chainWalletBalanceUsd = this.getChainCapitalBaseUsd(chainKey);
    // Enforce KuCoin 80% allocation cap
    if (chainKey === 'kucoin') {
      chainWalletBalanceUsd = chainWalletBalanceUsd * 0.8;
    }
    let targetSizeUsd = chainWalletBalanceUsd * pct;

    if (config.portfolioOptimization?.enabled !== false && config.portfolioOptimization?.sizeControlEnabled === true) {
      const hrpTargetWeight = Number(tokenData?.hrpTargetWeight);
      const minTargetWeight = Number(config.portfolioOptimization?.minTargetWeight || 0.02);
      const maxSizeMultiplier = Number(config.portfolioOptimization?.maxSizeMultiplier || 1.25);
      if (Number.isFinite(hrpTargetWeight) && hrpTargetWeight > 0) {
        const effectiveWeight = Math.max(minTargetWeight, Math.min(1, hrpTargetWeight));
        const hrpCapUsd = chainWalletBalanceUsd * effectiveWeight * Math.max(0.1, maxSizeMultiplier);
        if (hrpCapUsd > 0 && targetSizeUsd > hrpCapUsd) {
          logger.info(`${tokenData.symbol}: HRP allocation cap reduced size from $${targetSizeUsd.toFixed(2)} to $${hrpCapUsd.toFixed(2)} (targetWeight=${(effectiveWeight * 100).toFixed(1)}%)`);
          targetSizeUsd = hrpCapUsd;
        }
      }
    }

    // ATR / volatility-informed risk-per-trade cap.
    // If the stop distance is wide, cut size so a normal adverse move does not consume too much equity.
    if (config.risk?.atrRiskSizingEnabled !== false) {
      const equityBaseUsd = Math.max(0, Number(this.getEquityBalanceUsd() || chainWalletBalanceUsd || 0));
      const riskBudgetUsd = equityBaseUsd * (Math.max(0.05, Number(config.risk?.riskPerTradePct || 0.6)) / 100);
      const atrProxyPct = Math.max(
        Number(tokenData?.atrProxyPct || 0),
        Number(tokenData?.garchVolatilityPct || 0) * 0.65,
        Number(tokenData?.realizedVolPct || 0) * 0.55,
        Number(config.risk?.atrFallbackStopPct || 3.5)
      );
      const effectiveStopPct = Math.max(Number(config.risk?.stopLossPct || 8) * 0.5, atrProxyPct);
      if (riskBudgetUsd > 0 && effectiveStopPct > 0) {
        const atrCappedSizeUsd = riskBudgetUsd / (effectiveStopPct / 100);
        if (atrCappedSizeUsd > 0 && targetSizeUsd > atrCappedSizeUsd) {
          logger.info(
            `${tokenData.symbol}: ATR risk cap reduced size from $${targetSizeUsd.toFixed(2)} to $${atrCappedSizeUsd.toFixed(2)} ` +
            `(riskBudget=$${riskBudgetUsd.toFixed(2)}, stop~${effectiveStopPct.toFixed(2)}%)`
          );
          targetSizeUsd = atrCappedSizeUsd;
        }
      }
    }

    // Liquidity-depth aware sizing: scale position down for thin-book tokens to limit
    // exit slippage. Without this, the bot can take a position that consumes 5%+ of
    // available liquidity, and exit slippage eats the entire edge.
    if (config.risk?.liquidityDepthSizingEnabled !== false) {
      const liquidityUsd = Number(tokenData.liquidityUsd || 0);
      if (liquidityUsd > 0 && targetSizeUsd > 0) {
        const targetSharePct = Number(config.risk?.liquidityDepthMaxSharePct || 1.5); // % of book
        const idealMaxSize = liquidityUsd * (targetSharePct / 100);
        if (targetSizeUsd > idealMaxSize) {
          targetSizeUsd = idealMaxSize;
        }
      }
    }

    const chainOpenExposureUsd = this.getChainExposureUsd(chainKey);
    const remainingChainCapacityUsd = Math.max(0, chainWalletBalanceUsd - chainOpenExposureUsd);
    const sizeUsd = Math.min(targetSizeUsd, remainingChainCapacityUsd);
    // Floor: never reduce below absolute minimum (avoid dust trades that won't fill)
    const minSizeUsd = Number(config.risk?.minPositionSizeUsd || 5);
    if (sizeUsd > 0 && sizeUsd < minSizeUsd) {
      return 0;
    }
    return Number.isFinite(sizeUsd) && sizeUsd > 0 ? sizeUsd : 0;
  }

  /**
   * Estimate AMM price impact using the constant-product (x*y=k) model.
   * impact ≈ tradeSize / (poolLiquidity + tradeSize)
   * Blocks the trade if the estimated impact exceeds MAX_MARKET_IMPACT_PCT.
   * Returns { blocked: false } or { blocked: true, reason, impactPct }.
   */
  estimateMarketImpact(tokenData, strategyName = 'momentum') {
    const liquidityUsd = Number(tokenData.liquidityUsd || 0);
    if (liquidityUsd <= 0) return { blocked: false }; // Can't estimate without liquidity data

    const sizeUsd = this.positionSize(tokenData, strategyName);
    if (sizeUsd <= 0) return { blocked: false };

    // x*y=k approximation: entry impact on a two-sided pool (half-liquidity on each side)
    const poolSide = liquidityUsd / 2;
    const impactPct = (sizeUsd / (poolSide + sizeUsd)) * 100;

    const threshold = Number(config.risk?.maxMarketImpactPct ?? 3);
    if (impactPct > threshold) {
      const reason = `Estimated market impact ${impactPct.toFixed(1)}% exceeds limit ${threshold}% (size $${sizeUsd.toFixed(0)} / liq $${liquidityUsd.toFixed(0)})`;
      logger.debug(`Market impact gate blocked: ${reason}`);
      return { blocked: true, reason, impactPct };
    }

    // Additional liquidity realism: limit position share of estimated 1h volume.
    const volume24h = Number(tokenData.volume24h || 0);
    const estimatedHourlyVolume = volume24h > 0 ? (volume24h / 24) : 0;
    const maxSharePct = Number(config.risk?.maxTradeShareOfHourlyVolumePct ?? 0.5);
    if (estimatedHourlyVolume > 0) {
      const sharePct = (sizeUsd / estimatedHourlyVolume) * 100;
      if (sharePct > maxSharePct) {
        const reason = `Trade size ${(sharePct).toFixed(2)}% of estimated 1h volume exceeds cap ${maxSharePct.toFixed(2)}%`;
        return { blocked: true, reason, impactPct, tradeSharePct: sharePct };
      }
    }

    // Cost-vs-edge gate: if estimated execution costs consume the strategy's expected edge, skip trade.
    const strategyCfg = config.strategies?.[strategyName] || {};
    const stopLossPct = Number(strategyCfg.stopLossPct || config.risk.stopLossPct || 8);
    const takeProfitPct = Number(strategyCfg.takeProfitPct || config.risk.takeProfitPct || 25);
    const winRate = Math.max(0.05, Math.min(0.95, Number(config.risk?.assumedWinRatePct || 42) / 100));
    const grossExpectedEdgePct = (winRate * takeProfitPct) - ((1 - winRate) * stopLossPct);

    const dexFeeRoundTripPct = Number(config.risk?.estimatedDexFeePctPerSide || 0.3) * 2;
    const mevTaxPct = Number(config.risk?.estimatedMevTaxPctPerRoundTrip || 0.7);
    const networkCostPct = Number(config.risk?.estimatedNetworkCostPctPerRoundTrip || 0.2);
    const impactRoundTripPct = impactPct * 2;
    const estimatedTotalCostPct = dexFeeRoundTripPct + mevTaxPct + networkCostPct + impactRoundTripPct;
    const netExpectedEdgePct = grossExpectedEdgePct - estimatedTotalCostPct;
    const minNetEdgePct = Number(config.risk?.minNetExpectedEdgePct || 0.8);

    if (!Number.isFinite(netExpectedEdgePct) || netExpectedEdgePct < minNetEdgePct) {
      const reason = `Net expected edge ${Number.isFinite(netExpectedEdgePct) ? netExpectedEdgePct.toFixed(2) : 'NaN'}% below minimum ${minNetEdgePct.toFixed(2)}% after estimated costs ${estimatedTotalCostPct.toFixed(2)}%`;
      return { blocked: true, reason, impactPct, estimatedTotalCostPct, netExpectedEdgePct };
    }

    return { blocked: false, impactPct, estimatedTotalCostPct, netExpectedEdgePct };
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
    // Fail-closed for all live DEX chains (BSC, Solana, Base) — not CEX, not paper trading.
    // Previously only BSC was fail-closed; Solana and Base would silently pass if GoPlus was down.
    const DEX_CHAINS = ['bsc', 'solana', 'base'];
    const failClosedForMissingData = DEX_CHAINS.includes(normalizedChain) && !config.paperTrading;

    if (normalizedChain === 'kucoin') {
      logger.debug(`Honeypot check skipped for KuCoin (CEX): ${tokenAddress}`);
      const result = { blocked: false, unavailable: false };
      this.honeypotCache[cacheKey] = { result, timestamp: Date.now() };
      return result;
    }
    
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
        return { blocked: false, unavailable: true };
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
        return { blocked: false, unavailable: failClosedForMissingData };
      }

      const data = response.data;
      const tokenData = data.result?.[tokenAddress.toLowerCase()];

      if (!tokenData) {
        logger.warn(`No GoPlus data for ${tokenAddress}`);
        return { blocked: false, unavailable: failClosedForMissingData };
      }

      // Check for honeypot, scam, or other red flags
      const isHoneypot = tokenData.is_honeypot === '1';
      const isScam = tokenData.is_scam === '1' || tokenData.is_blacklisted === '1';
      const hasHighRisk = tokenData.trading_cooldown === '1' || tokenData.transfer_pausable === '1';

      const result = { blocked: isHoneypot || isScam || hasHighRisk, unavailable: false };
      // Store result with timestamp for TTL expiration (30 minutes)
      this.honeypotCache[cacheKey] = { result, timestamp: Date.now() };

      if (result.blocked) {
        logger.warn(`${tokenAddress} flagged by GoPlus: honeypot=${isHoneypot}, scam=${isScam}, high_risk=${hasHighRisk}`);
      }

      return result;
    } catch (error) {
      logger.error(`Honeypot check failed for ${tokenAddress}: ${error.message}`);
      return { blocked: false, unavailable: failClosedForMissingData };
    }
  }
}

module.exports = RiskGuardian;
