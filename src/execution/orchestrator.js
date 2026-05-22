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

  async function executeBuy(chainName, exchange, tokenData, strategyName = 'momentum') {
    if (!config.paperTrading && chainName !== 'kucoin') {
      logger.info(`Buy blocked: live bot restricted to KuCoin, ${chainName} not allowed`);
      return;
    }

    // Bull-flag sizing (Week 12 B.7): flat %-equity risk divided by stop distance.
    // Quantity = (equity × riskPct%) ÷ stopDistanceAbs. Bypasses iteration engine.
    let calculatedSizeUsd;
    if (strategyName === 'spot_day_bull_flag' && tokenData.setupType === 'spot_day_bull_flag' && Number(tokenData.structuralStopPrice) > 0) {
      const equity = Number(portfolio?.balance || 0);
      const riskPct = Number(tokenData._bullFlagRiskPct || config.strategies?.spot_day_bull_flag?.riskPctBase || 0.35);
      const entryPrice = Number(tokenData.price || tokenData.breakoutClosePrice || 0);
      const stopPrice = Number(tokenData.structuralStopPrice);
      const stopDistanceFrac = entryPrice > 0 ? Math.abs(entryPrice - stopPrice) / entryPrice : 0;
      if (equity > 0 && stopDistanceFrac > 0) {
        const riskDollars = equity * (riskPct / 100);
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
    } else if (strategyName === 'backes_swing' && tokenData.setupType === 'backes_swing' && Number(tokenData.structuralStopPrice || tokenData.invalidationPrice) > 0) {
      const equity = Number(portfolio?.balance || 0);
      const entryPrice = Number(tokenData.price || tokenData.entryPrice || 0);
      const stopPrice = Number(tokenData.structuralStopPrice || tokenData.invalidationPrice);
      const stopDistanceFrac = entryPrice > 0 ? Math.abs(entryPrice - stopPrice) / entryPrice : 0;
      const backesCfg = config.strategies?.backes_swing || {};
      const openBackesPositions = Object.values(portfolio?.positions || {})
        .filter((position) => position?.setupType === 'backes_swing' || position?.strategy === 'backes_swing');
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
        const exposureCapUsd = equity * 0.25;
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

    const sizeUsd = applyPositionJitter(calculatedSizeUsd, 15);

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
      logger.debug(`[pre-trade-contract] BUY check threw: ${e?.message || e} — proceeding (degraded open)`);
    }

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
    if (position?.exitInProgress) {
      logger.debug(`SELL skipped for ${tokenData?.symbol || position?.symbol || position?.address}: exit already in progress`);
      return;
    }

    // Set inside try so a throw between flag-set and try-block can never strand exitInProgress=true.
    const strategyName = position.strategy || 'momentum';
    const fraction = Math.max(0.01, Math.min(Number(sellPct || 1), 1));
    const positionQuantityBefore = Number(position.quantity || 0);
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
        position.exitInProgress = false;
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
    } finally {
      if (position && typeof position === 'object') {
        position.exitInProgress = false;
      }
    }
  }

  return { executeBuy, executeSell, finalizeSellExecution };
}

module.exports = { createExecutionOrchestrator };
