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
    // 2026-07-06: exchange-side stop manager (nullable; live KuCoin only,
    // flag-gated OFF by default). See src/execution/kucoin-stop-orders.js.
    kucoinStopManager = null,
  } = deps;

  function isBullFlagSetupType(setupType) {
    return setupType === 'spot_day_bull_flag' || setupType === 'solana_bull_flag_v2';
  }

  function isExecutionScanOnlyStrategy(strategyName) {
    const cfg = config.strategies?.[strategyName] || {};
    return cfg.scanOnly === true;
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

  function normalizeV2BotProfile(profile = BOT_PROFILE) {
    const key = String(profile || '').trim().toLowerCase();
    if (key === 'live') return 'live_spot';
    if (key === 'paper') return 'paper_spot';
    if (key === 'perps') return 'paper_perps';
    return key || 'unknown';
  }

  function estimatePositionNotionalUsd(position = {}) {
    const quantity = Math.abs(firstFinitePositive([position.quantity, position.qty, position.size]) || 0);
    const markPrice = firstFinitePositive([
      position.currentPrice,
      position.markPrice,
      position.price,
      position.entryPrice,
    ]);
    const derivedValueUsd = quantity > 0 && markPrice > 0 ? quantity * markPrice : null;
    return firstFinitePositive([
      position.positionValueUsd,
      position.marketValueUsd,
      position.currentValueUsd,
      position.valueUsd,
      derivedValueUsd,
      position.costBasisUsd,
      position.initialSizeUsd,
      position.notionalUsd,
    ]) || 0;
  }

  function estimatePositionRiskUsd(position = {}, notionalUsd = 0) {
    const explicitRiskUsd = firstFinitePositive([
      position.setupRiskUsd,
      position.riskUsd,
      position.maxLossUsd,
      position.riskAmountUsd,
    ]);
    if (explicitRiskUsd !== null) return explicitRiskUsd;

    const quantity = Math.abs(firstFinitePositive([position.quantity, position.qty, position.size]) || 0);
    const entryPrice = firstFinitePositive([position.entryPrice, position.averageEntryPrice, position.avgEntryPrice]);
    const stopPrice = firstFinitePositive([
      position.stopLoss,
      position.stopLossPrice,
      position.stopPrice,
      position.structuralStopPrice,
      position.invalidationPrice,
    ]);
    if (quantity > 0 && entryPrice > 0 && stopPrice > 0 && entryPrice !== stopPrice) {
      return Math.abs(entryPrice - stopPrice) * quantity;
    }

    const riskPct = firstFinitePositive([position.setupRiskPct, position.riskPct, position.maxLossPct]);
    if (riskPct !== null && notionalUsd > 0) return notionalUsd * (riskPct / 100);
    return 0;
  }

  function buildPortfolioExposureRows() {
    return Object.values(portfolio?.positions || {})
      .map((position) => {
        const symbol = position?.symbol || position?.contract || position?.ticker || position?.address || null;
        const notionalUsd = estimatePositionNotionalUsd(position);
        const riskUsd = estimatePositionRiskUsd(position, notionalUsd);
        return {
          botProfile: normalizeV2BotProfile(BOT_PROFILE),
          marketType: position?.marketType || position?.market || 'spot',
          symbol,
          strategy: position?.strategy || position?.strategyId || position?.setupType || 'unknown',
          notionalUsd,
          riskUsd,
          unrealizedPnlUsd: finiteNumber(position?.unrealizedPnlUsd ?? position?.unrealizedPnl) || 0,
          correlationKey: position?.correlationKey
            || position?.correlationBucket
            || position?.chainKey
            || position?.chain
            || symbol,
        };
      })
      .filter((row) => row.symbol && (row.notionalUsd > 0 || row.riskUsd > 0));
  }

  function estimateProposedTradeRiskUsd(tokenData = {}, sizeUsd = 0, strategyName = 'momentum') {
    const explicitRiskUsd = firstFinitePositive([
      tokenData._bullFlagRiskUsd,
      tokenData.setupRiskUsd,
      tokenData.riskUsd,
      tokenData.maxLossUsd,
      tokenData.riskAmountUsd,
    ]);
    if (explicitRiskUsd !== null) return explicitRiskUsd;

    const entryPrice = firstFinitePositive([
      tokenData.price,
      tokenData.entryPrice,
      tokenData.breakoutClosePrice,
      tokenData.breakoutClose,
    ]);
    const stopPrice = firstFinitePositive([
      tokenData.structuralStopPrice,
      tokenData.stopPrice,
      tokenData.stopLossPrice,
      tokenData.stopLoss,
      tokenData.invalidationPrice,
    ]);
    const notionalUsd = Number(sizeUsd || 0);
    if (notionalUsd > 0 && entryPrice > 0 && stopPrice > 0 && entryPrice !== stopPrice) {
      return notionalUsd * (Math.abs(entryPrice - stopPrice) / entryPrice);
    }

    const strategyConfig = config.strategies?.[strategyName] || {};
    const riskPct = firstFinitePositive([
      tokenData._strategyRiskPct,
      tokenData._bullFlagRiskPct,
      tokenData.riskPct,
      strategyConfig.riskPct,
      strategyConfig.riskPctBase,
      config.risk?.stopLossPct,
    ]);
    if (notionalUsd > 0 && riskPct !== null) return notionalUsd * (riskPct / 100);
    return 0;
  }

  function buildPreTradeRiskConfig() {
    const riskConfig = config.risk || {};
    return {
      aiOverride: process.env.AI_CIRCUIT_OVERRIDE === 'true'
        || (typeof AITradeBrain.hasAnyEnabledProvider === 'function' && !AITradeBrain.hasAnyEnabledProvider()),
      targetPortfolioHeatPct: riskConfig.v2TargetPortfolioHeatPct,
      maxPortfolioHeatPct: riskConfig.v2MaxPortfolioHeatPct ?? riskConfig.maxPortfolioHeatPct,
      maxCorrelation: riskConfig.v2MaxPortfolioCorrelation,
      profileRiskBudgetsPct: riskConfig.v2ProfileRiskBudgetsPct,
      strategyRiskBudgetsPct: riskConfig.v2StrategyRiskBudgetsPct,
      correlationPairs: riskConfig.v2CorrelationPairs || riskConfig.correlationPairs,
      v2RiskEnforcementMode: riskConfig.v2RiskEnforcementMode,
      v2RiskEnforceProfiles: riskConfig.v2RiskEnforceProfiles,
    };
  }

  function emitTradingEvent(event) {
    if (typeof telemetry?.logTradingEvent !== 'function') return;
    try {
      telemetry.logTradingEvent(event);
    } catch (error) {
      logger?.debug?.(`[v2-events] failed to enqueue ${event?.eventName || 'event'}: ${error?.message || error}`);
    }
  }

  function emitV2RiskAuditEvent({
    ptResult,
    side,
    strategy,
    symbol,
    chainName,
    sizeUsd,
    positionValueUsd,
    reason,
    correlationId,
  } = {}) {
    const audit = ptResult?.v2RiskAudit;
    if (!audit || audit.enabled !== true) return;
    if (!audit.coreBlocked && !audit.disagreement) return;

    emitTradingEvent({
      eventName: 'risk.audit',
      strategy,
      symbol,
      severity: audit.coreBlocked ? 'warn' : 'info',
      correlationId,
      payload: {
        side,
        chainName,
        sizeUsd,
        positionValueUsd,
        reason,
        advisoryOnly: audit.advisoryOnly === true,
        allow: audit.allow,
        reasons: audit.reasons || [],
        legacyBlocked: audit.legacyBlocked === true,
        coreBlocked: audit.coreBlocked === true,
        disagreement: audit.disagreement === true,
        input: audit.input || null,
      },
    });
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
    if (isExecutionScanOnlyStrategy(strategyName)) {
      logger.info(`[${strategyName}] BUY signal scan-only; execution blocked for ${tokenData.symbol || tokenData.address || 'unknown'}`);
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
      const proposedRiskUsd = estimateProposedTradeRiskUsd(tokenData, sizeUsd, strategyName);
      const ptResult = await runPreTradeContract({
        side: 'BUY',
        trade: {
          symbol: tokenData.symbol,
          chain: chainName,
          address: tokenData.address,
          sizeUsd,
          notionalUsd: sizeUsd,
          positionValueUsd: sizeUsd,
          riskUsd: proposedRiskUsd,
          maxLossUsd: proposedRiskUsd,
          setupType: tokenData.setupType || tokenData.setup_type || tokenData._strategySubtype || null,
          marketType: 'spot',
          correlationKey: tokenData.correlationKey
            || tokenData.correlationBucket
            || tokenData.chainKey
            || tokenData.symbol
            || tokenData.address,
        },
        state: {
          walletUsd: Number(portfolio?.balance) || 0,
          todaysPnlUsd: Number(portfolio?.stats?.todaysPnl) || 0,
          consecutiveLosses: Number(portfolio?.stats?.consecutiveLosses) || 0,
          aiCircuitOpen: aiCircuit.cooldownUntil > Date.now(),
          portfolioExposures: buildPortfolioExposureRows(),
        },
        scope: BOT_PROFILE,
        strategy: strategyName,
        sql: ptPool,
        logger,
        botVersion: process.env.BOT_VERSION || null,
        config: buildPreTradeRiskConfig(),
      });
      const riskCorrelationId = tokenData.signalId || tokenData._decisionTelemetry?.approvalDecisionId || null;
      emitV2RiskAuditEvent({
        ptResult,
        side: 'BUY',
        strategy: strategyName,
        symbol: tokenData.symbol,
        chainName,
        sizeUsd,
        positionValueUsd: sizeUsd,
        correlationId: riskCorrelationId,
      });
      if (!ptResult.ok) {
        emitTradingEvent({
          eventName: 'risk.rejected',
          strategy: strategyName,
          symbol: tokenData.symbol,
          severity: 'warn',
          correlationId: riskCorrelationId,
          payload: {
            side: 'BUY',
            chainName,
            sizeUsd,
            reasons: ptResult.reasons || ptResult.rejectReasons || [],
            result: ptResult,
          },
        });
        logger.warn(`[pre-trade-contract] enforce: ${tokenData.symbol} BUY blocked, skipping`);
        return;
      }
      emitTradingEvent({
        eventName: 'risk.approved',
        strategy: strategyName,
        symbol: tokenData.symbol,
        severity: 'info',
        correlationId: riskCorrelationId,
        payload: {
          side: 'BUY',
          chainName,
          sizeUsd,
          result: ptResult,
        },
      });
    } catch (e) {
      // Fail CLOSED on entry: if the pre-trade risk contract can't run (e.g. SQL
      // pool down), we cannot confirm daily-loss / consecutive-loss / duplicate-
      // order / AI-circuit limits — so we must NOT open new risk. Worst case is a
      // skipped buy, never a forced one. SELL stays fail-OPEN (below) — an infra
      // error must never block an exit. Brings live to parity with paper.
      emitTradingEvent({
        eventName: 'risk.rejected',
        strategy: strategyName,
        symbol: tokenData.symbol,
        severity: 'error',
        correlationId: tokenData.signalId || tokenData._decisionTelemetry?.approvalDecisionId || null,
        payload: {
          side: 'BUY',
          chainName,
          sizeUsd,
          reasons: ['pre_trade_contract_failed_closed'],
          error: e?.message || String(e),
        },
      });
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
        const riskCorrelationId = position?.sqlDecisionId || position?.sqlApprovalDecisionId || null;
        emitV2RiskAuditEvent({
          ptResult,
          side: 'SELL',
          strategy: strategyName,
          symbol: tokenData.symbol,
          chainName,
          positionValueUsd,
          reason,
          correlationId: riskCorrelationId,
        });
        if (!ptResult.ok) {
          emitTradingEvent({
            eventName: 'risk.rejected',
            strategy: strategyName,
            symbol: tokenData.symbol,
            severity: 'warn',
            correlationId: riskCorrelationId,
            payload: {
              side: 'SELL',
              chainName,
              reason,
              positionValueUsd,
              reasons: ptResult.reasons || ptResult.rejectReasons || [],
              result: ptResult,
            },
          });
          logger.warn(`[pre-trade-contract] enforce: ${tokenData.symbol} SELL blocked (reason=${reason}), skipping`);
          return;
        }
        emitTradingEvent({
          eventName: 'risk.approved',
          strategy: strategyName,
          symbol: tokenData.symbol,
          severity: 'info',
          correlationId: riskCorrelationId,
          payload: {
            side: 'SELL',
            chainName,
            reason,
            positionValueUsd,
            result: ptResult,
          },
        });
      } catch (e) {
        logger.debug(`[pre-trade-contract] SELL check threw: ${e?.message || e} — proceeding`);
      }

      logger.info(`Executing SELL: ${tokenData.symbol} @ $${tokenData.price} | selling ${round(fraction * 100, 1)}%`);

      try {
        const sellTimeoutMs = Math.max(15000, Number(config.execution?.sellTimeoutMs || config.execution?.buyTimeoutMs || 30000));

        // 2026-07-06 exchange-stop simulation (paper-only; inert on live since
        // config.paperTrading is false — kept for worktree parity). See the
        // paper branch twin for the full rationale.
        const HARD_STOP_REASONS = new Set(['FAST_STOP_LOSS', 'ORACLE_STOP_LOSS', 'STOP_LOSS']);
        const exchangeStopSimEnabled = process.env.PAPER_SIM_EXCHANGE_STOPS === 'true'
          && config.paperTrading
          && chainName === 'kucoin'
          && HARD_STOP_REASONS.has(String(reason || '').toUpperCase());
        const stopReferencePriceUsd = exchangeStopSimEnabled ? Number(position?.stopLoss) || 0 : 0;

        // 2026-07-06 live exchange-stops: before a loop-driven sell, cancel
        // the resting server-side stop. If the cancel discovers the stop
        // already FILLED, the exchange sold this position — finalize with
        // that fill and never market-sell a second unit (double-sell guard).
        // No-op unless KUCOIN_EXCHANGE_STOPS_ENABLED=true on live.
        if (kucoinStopManager && chainName === 'kucoin' && !config.paperTrading && kucoinStopManager.isEnabled()) {
          const stopGate = await kucoinStopManager.cancelBeforeManualSell(position?.key || tokenData?.address);
          if (!stopGate.proceed) {
            if (stopGate.adoptedFill) {
              logger.warn(`[kucoin-stops] ${tokenData.symbol}: exchange stop already filled — adopting fill instead of re-selling`);
              await finalizeSellExecution({
                chainName,
                tokenData,
                position,
                txResult: stopGate.adoptedFill,
                reason: 'EXCHANGE_STOP_FILLED',
                strategyName,
                expectedExitPrice,
                quantityRequested: quantityToSell,
                requestedFraction: fraction,
              });
            } else {
              logger.warn(`[kucoin-stops] ${tokenData.symbol}: stop cancel unresolved (${stopGate.reason || 'retry'}) — deferring sell to next tick`);
            }
            return;
          }
        }

        const txResult = await executeSellViaVenue({
          exchange,
          tokenData,
          quantityToSell,
          execTimeoutMs: sellTimeoutMs,
          withTimeout,
          stopReferencePriceUsd,
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
