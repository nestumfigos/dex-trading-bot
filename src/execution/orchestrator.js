'use strict';

// Extracted from src/index.js (Week 12 A.3).
// Owns the live order lifecycle: executeBuy / executeSell / finalizeSellExecution.
// Heavy on injected deps because this code straddles risk, telemetry, sql coord,
// execution flow, sentinels, recovery, and AI-circuit state.

function createExecutionOrchestrator(deps) {
  const {
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
    recoverFailedSellExecutionFromExchange,
  } = deps;

  function isBullFlagSetupType(setupType) {
    return setupType === 'spot_day_bull_flag' || setupType === 'solana_bull_flag_v2';
  }

  function finiteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function firstFinitePositive(values = []) {
    for (const value of values) {
      const numeric = finiteNumber(value);
      if (numeric !== null && numeric > 0) return numeric;
    }
    return null;
  }

  function resolveTargetPrice(tokenData = {}) {
    const targetPrices = Array.isArray(tokenData.targetPrices) ? tokenData.targetPrices : [];
    return firstFinitePositive([
      tokenData.measuredMoveTargetPrice,
      tokenData.targetPrice,
      tokenData.takeProfitPrice,
      tokenData.takeProfit,
      tokenData.projectedTargetPrice,
      ...targetPrices,
    ]);
  }

  function estimateRoundTripCostBps(chainName, tokenData = {}) {
    const chainKey = String(chainName || tokenData.chainKey || 'default').toLowerCase();
    const feeProfile = config.execution?.feeProfile?.[chainKey]
      || config.execution?.feeProfile?.default
      || {};
    const configuredFeesBps = Number(feeProfile.entryBps || 0) + Number(feeProfile.exitBps || 0);
    const expectedFeesBps = finiteNumber(tokenData.expectedFeesBps);
    const expectedSlippageBps = finiteNumber(tokenData.expectedSlippageBps);
    const expectedSpreadBps = finiteNumber(tokenData.expectedSpreadBps);

    return Math.max(
      0,
      (expectedFeesBps !== null ? expectedFeesBps : configuredFeesBps)
        + (expectedSlippageBps !== null ? expectedSlippageBps : Number(config.execution?.slippageBps || 0))
        + (expectedSpreadBps !== null ? expectedSpreadBps : 0)
    );
  }

  function evaluateMinimumNetDollarEdge(chainName, tokenData = {}, sizeUsd = 0) {
    const minNetEdgeUsd = Math.max(0, Number(config.risk?.minNetExpectedEdgeUsd || 0));
    if (config.paperTrading || minNetEdgeUsd <= 0) {
      return { ok: true, skipped: 'disabled' };
    }

    const entryPrice = firstFinitePositive([
      tokenData.price,
      tokenData.entryPrice,
      tokenData.breakoutClosePrice,
    ]);
    const targetPrice = resolveTargetPrice(tokenData);
    const notionalUsd = Number(sizeUsd || 0);
    if (!(notionalUsd > 0) || !(entryPrice > 0) || !(targetPrice > entryPrice)) {
      return { ok: true, skipped: 'missing_target' };
    }

    const grossRewardUsd = notionalUsd * ((targetPrice - entryPrice) / entryPrice);
    const costBps = estimateRoundTripCostBps(chainName, tokenData);
    const estimatedCostUsd = notionalUsd * (costBps / 10000);
    const netEdgeUsd = grossRewardUsd - estimatedCostUsd;

    tokenData.expectedGrossRewardUsd = grossRewardUsd;
    tokenData.expectedRoundTripCostUsd = estimatedCostUsd;
    tokenData.expectedNetEdgeUsd = netEdgeUsd;

    if (netEdgeUsd < minNetEdgeUsd) {
      return {
        ok: false,
        reason: 'min_net_expected_edge_usd',
        minNetEdgeUsd,
        netEdgeUsd,
        grossRewardUsd,
        estimatedCostUsd,
        costBps,
      };
    }

    return { ok: true, netEdgeUsd, grossRewardUsd, estimatedCostUsd, costBps };
  }

  function isBackesSwingPosition(position = {}) {
    return position?.setupType === 'backes'
      || position?.setupType === 'swing'
      || position?.setupType === 'backes_swing'
      || position?.strategy === 'backes'
      || position?.strategy === 'swing'
      || position?.strategy === 'backes_swing'
      || position?.strategyVariant === 'backes_htf_swing';
  }

  function bullFlagDailyLossR(fallbackRiskUsd = 0) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();
    return (Array.isArray(portfolio?.trades) ? portfolio.trades : [])
      .filter((trade) => String(trade?.type || '').toUpperCase() === 'SELL')
      .filter((trade) => isBullFlagSetupType(trade?.setupType))
      .filter((trade) => (Date.parse(trade?.timestamp || '') || 0) >= startMs)
      .reduce((sum, trade) => {
        const pnl = Number(trade.pnl);
        if (!Number.isFinite(pnl) || pnl >= 0) return sum;
        const riskUsd = Number(trade.setupRiskUsd || fallbackRiskUsd || 0);
        if (!(riskUsd > 0)) return sum;
        return sum + (Math.abs(pnl) / riskUsd);
      }, 0);
  }

  async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum') {
    if (!config.paperTrading && chainName !== 'kucoin') {
      logger.info(`Buy blocked: live bot restricted to KuCoin, ${chainName} not allowed`);
      return;
    }

    // Bull-flag sizing (Week 12 B.7): flat %-equity risk divided by stop distance.
    // Quantity = (equity × riskPct%) ÷ stopDistanceAbs. Bypasses iteration engine.
    let calculatedSizeUsd;
    if (isBullFlagSetupType(tokenData.setupType) && Number(tokenData.structuralStopPrice) > 0) {
      const bullFlagCfg = config.strategies?.[strategyName] || config.strategies?.spot_day_bull_flag || {};
      const openBullFlags = Object.values(portfolio?.positions || {})
        .filter((position) => position?.setupType === tokenData.setupType || position?.strategy === strategyName);
      const maxConcurrent = Math.max(1, Number(bullFlagCfg.maxConcurrentPositions || 2));
      if (openBullFlags.length >= maxConcurrent) {
        logger.info(`[bull-flag] max concurrent positions reached (${openBullFlags.length}/${maxConcurrent}), skipping ${tokenData.symbol}`);
        return;
      }

      const equity = Number(portfolio?.balance || 0);
      const riskPct = Number(tokenData._bullFlagRiskPct || bullFlagCfg.riskPctBase || config.strategies?.spot_day_bull_flag?.riskPctBase || 0.35);
      const entryPrice = Number(tokenData.price || tokenData.breakoutClosePrice || 0);
      const stopPrice = Number(tokenData.structuralStopPrice);
      const stopDistanceFrac = entryPrice > 0 ? Math.abs(entryPrice - stopPrice) / entryPrice : 0;
      if (equity > 0 && stopDistanceFrac > 0) {
        const riskDollars = equity * (riskPct / 100);
        const maxDailyLossR = Number(bullFlagCfg.maxDailyLossR || config.strategies?.spot_day_bull_flag?.maxDailyLossR || 3);
        const todayLossR = bullFlagDailyLossR(riskDollars);
        if (maxDailyLossR > 0 && todayLossR >= maxDailyLossR) {
          logger.warn(`[bull-flag] daily R loss halt active (${todayLossR.toFixed(2)}R/${maxDailyLossR}R), skipping ${tokenData.symbol}`);
          return;
        }
        tokenData._bullFlagRiskUsd = riskDollars;
        calculatedSizeUsd = riskDollars / stopDistanceFrac;
        // Cap at max position size config to prevent runaway sizing on tiny stops
        const maxPctCap = Number(config.risk?.maxPositionSizePct || 3) / 100;
        const maxUsdCap = equity * maxPctCap;
        if (calculatedSizeUsd > maxUsdCap) {
          logger.info(`[bull-flag] sizing capped: requested $${calculatedSizeUsd.toFixed(2)} > max $${maxUsdCap.toFixed(2)} (risk ${riskPct}%, stop ${(stopDistanceFrac * 100).toFixed(2)}%)`);
          calculatedSizeUsd = maxUsdCap;
        }
        logger.info(`[bull-flag] sized ${tokenData.symbol}: risk=${riskPct}%, stop=${(stopDistanceFrac * 100).toFixed(2)}%, size=$${calculatedSizeUsd.toFixed(2)} (A+=${tokenData._bullFlagIsAPlus})`);
      } else {
        logger.warn(`[bull-flag] sizing fallback (equity=${equity}, stopFrac=${stopDistanceFrac}); using iteration engine`);
        calculatedSizeUsd = positionSizingEngine.calculateSmallIterationSize(tokenData, portfolio, strategyName);
      }
    } else if (strategyName === 'backes' && tokenData.setupType === 'backes' && Number(tokenData.structuralStopPrice || tokenData.invalidationPrice) > 0) {
      const equity = Number(portfolio?.balance || 0);
      const entryPrice = Number(tokenData.price || tokenData.entryPrice || 0);
      const stopPrice = Number(tokenData.structuralStopPrice || tokenData.invalidationPrice);
      const stopDistanceFrac = entryPrice > 0 ? Math.abs(entryPrice - stopPrice) / entryPrice : 0;
      const backesCfg = config.strategies?.backes || config.strategies?.swing || {};
      const openBackesPositions = Object.values(portfolio?.positions || {})
        .filter(isBackesSwingPosition);
      const maxConcurrent = Math.max(1, Number(backesCfg.maxConcurrentPositions || 3));
      if (openBackesPositions.length >= maxConcurrent) {
        logger.info(`[backes] max concurrent positions reached (${openBackesPositions.length}/${maxConcurrent}), skipping ${tokenData.symbol}`);
        return;
      }

      if (equity > 0 && stopDistanceFrac > 0) {
        const macroMultiplier = Math.max(0.05, Number(tokenData._macroSizeMultiplier || 1));
        const riskPct = Number(tokenData._backesRiskPct || (tokenData.macroRegime === 'capitulation' ? 0.2 : 0.5));
        const riskDollars = equity * ((riskPct * macroMultiplier) / 100);
        calculatedSizeUsd = riskDollars / stopDistanceFrac;

        const openBackesExposure = openBackesPositions
          .reduce((sum, position) => sum + Number(position.costBasisUsd || position.initialSizeUsd || 0), 0);
        const exposureCapUsd = equity * (Number(backesCfg.maxSwingExposurePct || 25) / 100);
        const remainingExposureUsd = Math.max(0, exposureCapUsd - openBackesExposure);
        if (remainingExposureUsd <= 0) {
          logger.info(`[backes] exposure cap reached ($${openBackesExposure.toFixed(2)}/$${exposureCapUsd.toFixed(2)}), skipping ${tokenData.symbol}`);
          return;
        }
        if (calculatedSizeUsd > remainingExposureUsd) {
          logger.info(`[backes] sizing capped by 25% exposure: requested $${calculatedSizeUsd.toFixed(2)} > remaining $${remainingExposureUsd.toFixed(2)}`);
          calculatedSizeUsd = remainingExposureUsd;
        }

        logger.info(`[backes] sized ${tokenData.symbol}: risk=${riskPct}%, macro=${macroMultiplier.toFixed(2)}, stop=${(stopDistanceFrac * 100).toFixed(2)}%, size=$${calculatedSizeUsd.toFixed(2)}`);
      } else {
        logger.warn(`[backes] sizing fallback (equity=${equity}, stopFrac=${stopDistanceFrac}); using iteration engine`);
        calculatedSizeUsd = positionSizingEngine.calculateSmallIterationSize(tokenData, portfolio, strategyName);
      }
    } else if (strategyName === 'bsc_flow_breakout' && tokenData.setupType === 'bsc_flow_breakout' && Number(tokenData.structuralStopPrice || tokenData.invalidationPrice) > 0) {
      const equity = Number(portfolio?.balance || 0);
      const entryPrice = Number(tokenData.price || tokenData.entryPrice || 0);
      const stopPrice = Number(tokenData.structuralStopPrice || tokenData.invalidationPrice);
      const stopDistanceFrac = entryPrice > 0 ? Math.abs(entryPrice - stopPrice) / entryPrice : 0;
      const bscCfg = config.strategies?.bsc_flow_breakout || {};
      const rawRiskPct = Number(tokenData._strategyRiskPct || bscCfg.riskPct || 0.2);
      const riskPct = Math.max(0.15, Math.min(0.25, Number.isFinite(rawRiskPct) ? rawRiskPct : 0.2));
      tokenData._strategyRiskPct = riskPct;
      tokenData._strategyMaxSlippagePct = Math.min(3, Number(tokenData._strategyMaxSlippagePct || bscCfg.maxSlippagePct || 3));
      tokenData.maxSlippageBps = Math.round(tokenData._strategyMaxSlippagePct * 100);
      tokenData.useMevJitter = tokenData.useMevJitter !== false && bscCfg.useMevJitter !== false;

      if (equity > 0 && stopDistanceFrac > 0) {
        const riskDollars = equity * (riskPct / 100);
        calculatedSizeUsd = riskDollars / stopDistanceFrac;
        const maxPctCap = Number(config.risk?.maxPositionSizePct || 3) / 100;
        const maxUsdCap = equity * maxPctCap;
        if (calculatedSizeUsd > maxUsdCap) {
          logger.info(`[bsc-flow] sizing capped: requested $${calculatedSizeUsd.toFixed(2)} > max $${maxUsdCap.toFixed(2)} (risk ${riskPct}%, stop ${(stopDistanceFrac * 100).toFixed(2)}%)`);
          calculatedSizeUsd = maxUsdCap;
        }
        logger.info(`[bsc-flow] sized ${tokenData.symbol}: risk=${riskPct}%, stop=${(stopDistanceFrac * 100).toFixed(2)}%, slippage<=${tokenData._strategyMaxSlippagePct}%, merkle=${tokenData.useMevJitter}`);
      } else {
        logger.warn(`[bsc-flow] sizing fallback (equity=${equity}, stopFrac=${stopDistanceFrac}); using iteration engine`);
        calculatedSizeUsd = positionSizingEngine.calculateSmallIterationSize(tokenData, portfolio, strategyName);
      }
    } else {
      const useSmallIterations = process.env.USE_POSITION_ITERATIONS !== 'false';
      calculatedSizeUsd = useSmallIterations
        ? positionSizingEngine.calculateSmallIterationSize(tokenData, portfolio, strategyName)
        : risk.positionSize(tokenData, strategyName);
    }

    if (calculatedSizeUsd < 6) {
      logger.warn(`Position size $${calculatedSizeUsd.toFixed(2)} too small, skipping`);
      return;
    }

    // 2026-05-31 audit (cycle-2 P2): clamp jitter to never EXCEED the
    // calculated risk-budgeted size. Paper already did Math.min here; live
    // did not, so the 15% jitter could swing the order ABOVE the size the
    // risk engine signed off on. Floor stays free to swing downward.
    const sizeUsd = Math.min(calculatedSizeUsd, applyPositionJitter(calculatedSizeUsd, 15));
    const netEdgeGate = evaluateMinimumNetDollarEdge(chainName, tokenData, sizeUsd);
    if (!netEdgeGate.ok) {
      logger.info(
        `[net-edge] ${tokenData.symbol} skipped: expected net $${netEdgeGate.netEdgeUsd.toFixed(4)} `
        + `< min $${netEdgeGate.minNetEdgeUsd.toFixed(2)} `
        + `(gross=$${netEdgeGate.grossRewardUsd.toFixed(4)}, costs=$${netEdgeGate.estimatedCostUsd.toFixed(4)}, costBps=${netEdgeGate.costBps.toFixed(1)})`
      );
      return;
    }

    try {
      const { getPool } = require('../utils/sqlServer');
      const ptPool = await getPool(logger).catch(() => null);
      const ptResult = await runPreTradeContract({
        side: 'BUY',
        trade: { symbol: tokenData.symbol, chain: chainName, address: tokenData.address, sizeUsd, positionValueUsd: sizeUsd },
        state: {
          walletUsd: Number(portfolio?.balance) || 0,
          todaysPnlUsd: Number(portfolio?.stats?.todaysPnl) || 0,
          consecutiveLosses: Number(portfolio?.stats?.consecutiveLosses) || 0,
          aiCircuitOpen: aiCircuit.cooldownUntil > Date.now(),
        },
        scope: BOT_PROFILE,
        strategy: strategyName,
        sql: ptPool,
        logger,
        botVersion: process.env.BOT_VERSION || null,
        config: {
          aiOverride: process.env.AI_CIRCUIT_OVERRIDE === 'true'
            || (typeof AITradeBrain.hasAnyEnabledProvider === 'function' && !AITradeBrain.hasAnyEnabledProvider()),
        },
      });
      if (!ptResult.ok) {
        logger.warn(`[pre-trade-contract] enforce: ${tokenData.symbol} BUY blocked, skipping`);
        return;
      }
    } catch (e) {
      // Fail CLOSED on entry: if the pre-trade risk contract can't run (e.g. SQL
      // pool down), we cannot confirm daily-loss / consecutive-loss / duplicate-
      // order / AI-circuit limits — so we must NOT open new risk. Worst case is a
      // skipped buy, never a forced one. SELL stays fail-OPEN (below) — an infra
      // error must never block an exit. Brings live to parity with paper.
      logger.warn(`[pre-trade-contract] BUY check threw: ${e?.message || e} — failing closed (skipping entry)`);
      return;
    }

    // B3.exec.8 + 2026-05-31 audit (cycle-2 P1): TTL must exceed the ACTUAL
    // execTimeoutMs passed to executeBuyViaVenue plus a buffer, so a slow
    // exchange can't release the lock before execution completes (would risk
    // duplicate live buys). The previous formula derived TTL from
    // `config.execution.timeoutMs || 45000` but the buy path uses
    // `execTimeoutMs || buyTimeoutMs || 30000` — if an operator raised
    // `buyTimeoutMs` past 45s without touching `timeoutMs`, the lock would
    // expire mid-order. Single source of truth: same expression as line below.
    const execTimeoutMs = Math.max(
      15000,
      Number(config.execution?.execTimeoutMs || config.execution?.buyTimeoutMs || 30000)
    );
    const requestedLockTtl = Number(process.env.SQL_LOCK_TTL_MS || 30000);
    const lockTtlMs = Math.max(requestedLockTtl, execTimeoutMs + 10000);
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
    // Day 6 wire: register in-flight $-exposure for heat-per-chain tracking.
    // Released in finally so a throw mid-flight cannot leak a phantom heat allocation.
    if (typeof risk?.registerInFlightOrder === 'function') {
      try { risk.registerInFlightOrder(chainName, sizeUsd); } catch (_) { /* swallow */ }
    }
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

      const entryDelayMs = getRandomEntryDelay(3000);
      if (entryDelayMs > 0) {
        await sleep(entryDelayMs);
      }

      try {
        let txResult;
        const expectedEntryPrice = Number(tokenData.price);
        // execTimeoutMs already computed above (lock-TTL derivation) — reusing
        // ensures the lock TTL >= actual venue timeout. Do NOT redeclare.
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
      if (typeof risk?.releaseInFlightOrder === 'function') {
        try { risk.releaseInFlightOrder(chainName, sizeUsd); } catch (_) { /* swallow */ }
      }
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

  async function executeSell(chainName, exchange, tokenData, position, sellPct = 1, reason = 'EXIT') {
    // B1.4: acquire positionMutex BEFORE any other check so two concurrent callers
    // serialize. The boolean exitInProgress flag alone could not prevent two callers
    // from racing past the check; the mutex makes the second wait until the first
    // releases (and at that point the position will either be closed or the flag set).
    const release = await positionMutex.lock();
    try {
      if (position?.exitInProgress) {
        logger.debug(`SELL skipped for ${tokenData?.symbol || position?.symbol || position?.address}: exit already in progress`);
        return;
      }
      const remainingQty = Number(position?.quantity || 0);
      if (!position || remainingQty <= 0) {
        logger.debug(`SELL skipped for ${tokenData?.symbol || position?.symbol}: position already closed (qty=${remainingQty})`);
        return;
      }

      const strategyName = position.strategy || 'momentum';
      const fraction = Math.max(0.01, Math.min(Number(sellPct || 1), 1));
      const positionQuantityBefore = remainingQty;
      const quantityToSell = positionQuantityBefore * fraction;
      const expectedExitPrice = Number(tokenData.price);
      const sellStartedAtMs = Date.now();

      try {
        position.exitInProgress = true;
        const { getPool } = require('../utils/sqlServer');
        const ptPool = await getPool(logger).catch(() => null);
        const positionValueUsd = positionQuantityBefore * (Number(tokenData?.price) || Number(position?.entryPrice) || 0);
        const ptResult = await runPreTradeContract({
          side: 'SELL',
          trade: { symbol: tokenData.symbol, chain: chainName, address: tokenData.address, sizeUsd: 0, positionValueUsd },
          state: { aiCircuitOpen: aiCircuit.cooldownUntil > Date.now() },
          scope: BOT_PROFILE,
          strategy: strategyName,
          sql: ptPool,
          logger,
          botVersion: process.env.BOT_VERSION || null,
        });
        if (!ptResult.ok) {
          logger.warn(`[pre-trade-contract] enforce: ${tokenData.symbol} SELL blocked (reason=${reason}), skipping`);
          return;
        }
      } catch (e) {
        logger.debug(`[pre-trade-contract] SELL check threw: ${e?.message || e} — proceeding`);
      }

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
      }
    } finally {
      if (position && typeof position === 'object') {
        position.exitInProgress = false;
      }
      try { release(); } catch (_) { /* swallow */ }
    }
  }

  return { executeBuy, executeSell, finalizeSellExecution };
}

module.exports = { createExecutionOrchestrator };
