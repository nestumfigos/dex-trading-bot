/**
 * Classify the cause of a position exit so the agent can learn distinct failure modes.
 * Returns {code, reasoning} where code is one of:
 *   take_profit, trailing_stop, stop_hunt, rug_detected, liquidity_collapse,
 *   mean_reversion, momentum_exhaustion, time_stop_no_gain, ai_veto, manual, unknown
 */
function classifyExitReason({ position, tokenData, reason, finalPnl, realizedExitPrice }) {
  const r = String(reason || '').toUpperCase();
  const entryPrice = Number(position.entryPrice || 0);
  const entryLiquidity = Number(position.entryLiquidityUsd || 0);
  const exitLiquidity = Number(tokenData.liquidityUsd || 0);
  const highestPrice = Number(position.highestPrice || entryPrice);
  const pnlPct = entryPrice > 0 ? ((realizedExitPrice - entryPrice) / entryPrice) * 100 : 0;
  const liquidityDropPct = entryLiquidity > 0 ? ((entryLiquidity - exitLiquidity) / entryLiquidity) * 100 : 0;
  const drawdownFromHighPct = highestPrice > 0 ? ((highestPrice - realizedExitPrice) / highestPrice) * 100 : 0;

  // Rug / liquidity collapse — 60%+ liquidity drop or massive PnL plunge
  if (liquidityDropPct >= 60 || (pnlPct <= -40 && liquidityDropPct >= 30)) {
    return { code: 'rug_detected', reasoning: `liquidity dropped ${liquidityDropPct.toFixed(1)}%, pnl ${pnlPct.toFixed(1)}%` };
  }
  if (liquidityDropPct >= 35) {
    return { code: 'liquidity_collapse', reasoning: `liquidity drop ${liquidityDropPct.toFixed(1)}%` };
  }

  // Take profit — explicit tier or clear winner
  if (r.startsWith('SELL_TIER_') || r.includes('TAKE_PROFIT') || r === 'TP_HIT') {
    return { code: 'take_profit', reasoning: `target hit at +${pnlPct.toFixed(2)}%` };
  }

  // Trailing stop — protected gain
  if (r.includes('TRAILING') && pnlPct >= 0) {
    return { code: 'trailing_stop', reasoning: `gave back ${drawdownFromHighPct.toFixed(2)}% from peak, kept +${pnlPct.toFixed(2)}%` };
  }

  // Stop hunt — losing position with sharp drawdown but still has liquidity (likely manipulation)
  if (r.includes('STOP_LOSS') || r === 'SL_HIT' || (pnlPct < 0 && drawdownFromHighPct >= 8 && liquidityDropPct < 20)) {
    return { code: 'stop_hunt', reasoning: `stopped at ${pnlPct.toFixed(2)}%, drawdown ${drawdownFromHighPct.toFixed(2)}% from peak` };
  }

  // Time stop with no gain — 4hr+ flat exit
  if (r === 'MIN_HOLD_NO_GAIN' || r === 'TIME_STOP') {
    return { code: 'time_stop_no_gain', reasoning: `time exit at ${pnlPct.toFixed(2)}% pnl` };
  }

  // Stale-drift exit — barely-profitable position locked up capital too long
  if (r === 'STALE_DRIFT') {
    return { code: 'stale_drift', reasoning: `held too long for too little gain at ${pnlPct.toFixed(2)}%` };
  }

  // Momentum exhaustion — gave back significant gain
  if (highestPrice > entryPrice * 1.05 && drawdownFromHighPct >= 30) {
    return { code: 'momentum_exhaustion', reasoning: `peaked +${(((highestPrice - entryPrice) / entryPrice) * 100).toFixed(1)}%, gave back ${drawdownFromHighPct.toFixed(1)}%` };
  }

  // Mean reversion — small loss, low drawdown from peak (no momentum)
  if (pnlPct < 0 && pnlPct > -10 && drawdownFromHighPct < 10) {
    return { code: 'mean_reversion', reasoning: `slow drift to ${pnlPct.toFixed(2)}%` };
  }

  // AI veto / signal-driven exit
  if (r.includes('AI_') || r.includes('SIGNAL') || r.includes('SELL_SIGNAL')) {
    return { code: 'ai_veto', reasoning: `signal flip at ${pnlPct.toFixed(2)}%` };
  }

  if (r.includes('MANUAL') || r === 'EXIT') {
    return { code: 'manual', reasoning: `manual exit at ${pnlPct.toFixed(2)}%` };
  }

  return { code: 'unknown', reasoning: `reason=${r}, pnl=${pnlPct.toFixed(2)}%` };
}

function createExecutionFlow(deps = {}) {
  const {
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
    saveState,
    logTrade,
    recordPortfolioSnapshot,
    queueDecisionTelemetry,
    safeDecisionText,
    buildDecisionReflection,
    updateAdaptiveSleevePerformance,
    updateBrainProfileFromClosedTrade,
    triggerLearningSync,
    strategyBrain,
    agentMemory,
    symbolPnLMemory,
    rlOnlineUpdater,
    round,
    normalizeChainKey,
    updateWalletBalance,
    reconcileWalletPositions,
  } = deps;

  function classifyBuyFailure(error) {
    const message = String(error?.message || error || '');
    if (/native price unavailable or stale/i.test(message)) {
      return {
        finalAction: 'QUOTE_STALE',
        status: 'precheck_failed',
      };
    }
    return {
      finalAction: 'BUY_FAILED',
      status: 'failed',
    };
  }

  function runBuyPreflightChecks({ chainName, tokenData, strategyName }) {
    const existingKey = buildTokenKey(chainName, tokenData.address);
    if (portfolio.positions[existingKey]) {
      logger.debug(`Duplicate position guard: already holding ${tokenData.symbol} on ${chainName}, skipping buy`);
      return { ok: false };
    }

    const globalPositions = Object.keys(portfolio.positions).length;
    if (globalPositions >= config.risk.maxConcurrentPositions) {
      logger.debug(`Global position limit reached at buy time for ${tokenData.symbol}, skipping`);
      operationalDiagnostics.slotBlockedCount++;
      const chainBreakdown = {};
      for (const p of Object.values(portfolio.positions)) {
        const c = (p.chain || 'unknown').toLowerCase();
        chainBreakdown[c] = (chainBreakdown[c] || 0) + 1;
      }
      operationalDiagnostics.chainMonopolyHistory.push({ ts: Date.now(), chainBreakdown });
      if (operationalDiagnostics.chainMonopolyHistory.length > 20) operationalDiagnostics.chainMonopolyHistory.shift();
      return { ok: false };
    }
    const strategyPositionCount = Object.values(portfolio.positions).filter((p) => p.strategy === strategyName).length;
    const strategyLimit = Number(config.strategies?.[strategyName]?.maxConcurrentPositions || 3);
    if (strategyPositionCount >= strategyLimit) {
      logger.debug(`Strategy position limit reached for ${strategyName} at buy time on ${tokenData.symbol}, skipping`);
      operationalDiagnostics.slotBlockedCount++;
      return { ok: false };
    }

    const chainLimitMap = (() => {
      try {
        const parsed = JSON.parse(process.env.MAX_POSITIONS_PER_CHAIN_BY_CHAIN || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    })();
    const chainSpecificLimit = Number(chainLimitMap[String(chainName || '').toLowerCase()]);
    const maxPositionsPerChain = Number.isFinite(chainSpecificLimit) && chainSpecificLimit > 0
      ? chainSpecificLimit
      : Number(process.env.MAX_POSITIONS_PER_CHAIN || 3);
    const chainPositionCount = Object.values(portfolio.positions).filter(
      (p) => (p.chainKey || String(p.chain || '').toLowerCase()) === chainName
    ).length;
    if (chainPositionCount >= maxPositionsPerChain) {
      logger.debug(`Per-chain position limit (${maxPositionsPerChain}) reached for ${chainName} at buy time on ${tokenData.symbol}, skipping`);
      operationalDiagnostics.slotBlockedCount++;
      return { ok: false };
    }

    return { ok: true };
  }

  async function finalizeBuyExecution({
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
  }) {
    markExecutionConfirmed(txResult, chainName, 'BUY', tokenData);

    const requestedQuoteUsd = Number(sizeUsd);
    let { realizedEntryPrice, hasExchangeFilledData, filledQuoteUsd, filledBaseQty } =
      resolveBuyFillMetrics(txResult, expectedEntryPrice, requestedQuoteUsd);
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
      && (chainName === 'bsc' || chainName === 'base' || chainName === 'solana');
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
      return { aborted: true };
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

    const ebStopLossPct = tokenData?.isEarlyBreakout && Number.isFinite(Number(tokenData?._earlyBreakoutStopLossPct))
      ? Number(tokenData._earlyBreakoutStopLossPct)
      : null;
    const computedStopLoss = ebStopLossPct !== null
      ? realizedEntryPrice * (1 - ebStopLossPct / 100)
      : risk.stopLossPrice(realizedEntryPrice, strategyName);
    const computedTakeProfit = risk.takeProfitPrice(realizedEntryPrice, strategyName);
    if (!Number.isFinite(computedStopLoss) || computedStopLoss <= 0 || computedStopLoss >= realizedEntryPrice) {
      const reason = `Invalid stopLoss ${computedStopLoss} for entryPrice ${realizedEntryPrice} on ${tokenData.symbol} — aborting buy to prevent unprotected position`;
      logger.error(reason);
      await sendErrorAlert(reason);
      return { aborted: true };
    }
    if (!Number.isFinite(computedTakeProfit) || computedTakeProfit <= realizedEntryPrice) {
      const reason = `Invalid takeProfit ${computedTakeProfit} for entryPrice ${realizedEntryPrice} on ${tokenData.symbol} — aborting buy to prevent unexitable position`;
      logger.error(reason);
      await sendErrorAlert(reason);
      return { aborted: true };
    }

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
      stopLoss: computedStopLoss,
      takeProfit: computedTakeProfit,
      openedAt: new Date().toISOString(),
      txid: txResult.txid,
      entryBlockNumber: Number.isFinite(Number(txResult?.blockNumber)) ? Number(txResult.blockNumber) : null,
      entryConfirmations: Number.isFinite(Number(txResult?.confirmations)) ? Number(txResult.confirmations) : null,
      entryPrivateRouteUsed: Boolean(txResult?.privateRouteUsed),
      signalSource: tokenData.signalSource || 'technical',
      triggerTimeframe: tokenData.entryTriggerTimeframe || null,
      brainArchetype: tokenData.brainArchetype || 'canonical_momentum_baseline',
      brainProfileKey: tokenData.brainProfileKey || null,
      discoveryLane: tokenData.discoveryLane || null,
      aiReason: tokenData.aiReason || '',
      aiConfidence: tokenData.aiConfidence || 0,
      patternAnalysis: tokenData.patternAnalysis || null,
      pairAddress: tokenData.pairAddress || null,
      executionProfile: txResult?.executionProfile || null,
      entryScalePlanUsd: Array.isArray(tokenData?._entryScalePlanUsd) ? tokenData._entryScalePlanUsd.slice(0, 5) : null,
      entryLiquidityUsd: Number(tokenData.liquidityUsd || 0),
      entryTopHoldersPct: tokenData.topHoldersPct === null || tokenData.topHoldersPct === undefined ? null : Number(tokenData.topHoldersPct),
      entryBuyRatioPct10m: (() => {
        const buys = Number(tokenData.buyTx10m || 0);
        const sells = Number(tokenData.sellTx10m || 0);
        const total = buys + sells;
        return total > 0 ? (buys / total) * 100 : 0;
      })(),
      entryRecentWindowMinutes: Number(tokenData.recentTxWindowMinutes || 0) || null,
      entryBuyRatioRecentPct: Number(tokenData.buyRatioRecentPct || 0) || null,
      entryHolderCount: Number(tokenData.holderCount || 0),
      // ── Per-indicator learning capture ────────────────────────────────────
      entryRsi: Number(tokenData.rsi ?? tokenData.indicators?.rsi ?? 0) || null,
      entryVolumeSpike: Number(tokenData.volumeSpike ?? tokenData.indicators?.volumeSpike ?? 0) || null,
      entryNetBuyFlow: Number(tokenData.netBuyFlowUsd10m || 0) || null,
      entryMacdBias: tokenData.indicators?.macdBias || tokenData.macdBias || null,
      entryEmaState: tokenData.indicators?.emaState
        || (Number.isFinite(Number(tokenData.indicators?.fastEma)) && Number.isFinite(Number(tokenData.indicators?.slowEma))
          ? (Number(tokenData.indicators.fastEma) >= Number(tokenData.indicators.slowEma) ? 'fast_above_slow' : 'fast_below_slow')
          : null),
      entryPattern: tokenData.patternAnalysis?.strongestPattern?.pattern || null,
      entryPatternBias: tokenData.patternAnalysis?.bias || tokenData.patternAnalysis?.strongestPattern?.bias || null,
      tokenAgeBucket: tokenData.tokenAgeBucket || 'unknown',
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
      // Bull-flag setup metadata (Week 12 B.5).
      setupType: tokenData.setupType || null,
      structureType: tokenData.structureType || null,
      structuralStopPrice: Number.isFinite(Number(tokenData.structuralStopPrice)) ? Number(tokenData.structuralStopPrice) : null,
      invalidationPrice: Number.isFinite(Number(tokenData.invalidationPrice || tokenData.structuralStopPrice)) ? Number(tokenData.invalidationPrice || tokenData.structuralStopPrice) : null,
      measuredMoveTargetPrice: Number.isFinite(Number(tokenData.measuredMoveTargetPrice)) ? Number(tokenData.measuredMoveTargetPrice) : null,
      targetPrices: Array.isArray(tokenData.targetPrices) ? tokenData.targetPrices.map(Number).filter(Number.isFinite) : [],
      macroRegime: tokenData.macroRegime || null,
      breakoutClosePrice: Number.isFinite(Number(tokenData.breakoutClosePrice)) ? Number(tokenData.breakoutClosePrice) : null,
      manualCutDeadlineAt: tokenData.manualCutDeadlineAt || null,
    };

    portfolio.strategies[strategyName].positions[tokenKey] = portfolio.positions[tokenKey];
    if (portfolio.balance < filledQuoteUsd) {
      const reason = `Balance would go negative after BUY for ${tokenData.symbol}: balance=${portfolio.balance.toFixed(2)}, cost=${filledQuoteUsd.toFixed(2)}`;
      logger.error(reason);
      if (!portfolio.safeMode && !config.paperTrading) {
        await sendErrorAlert(reason);
        await enterSafeMode(reason);
      }
    }
    portfolio.balance -= filledQuoteUsd;
    ensureLiquiditySentinel(chainName, tokenData.pairAddress);

    {
      const minFillCfgByChain = {
        bsc: Number(config.execution?.bscMinFillPctOfExpected || 0),
        base: Number(config.execution?.baseMinFillPctOfExpected || 0),
        solana: Number(config.execution?.solanaMinFillPctOfExpected || 0),
      };
      const minFillPctOfExpected = Math.max(0, Math.min(100, Number(minFillCfgByChain[chainName] || 0)));
      if (minFillPctOfExpected > 0) {
        const requestedEntryQuantity = realizedEntryPrice > 0 ? (requestedQuoteUsd / realizedEntryPrice) : quantity;
        const realizedFillPct = requestedEntryQuantity > 0 ? (quantity / requestedEntryQuantity) * 100 : 100;
        if (requestedEntryQuantity > 0 && realizedFillPct < minFillPctOfExpected) {
          const reason = `entry fill ${realizedFillPct.toFixed(2)}% below minimum ${minFillPctOfExpected.toFixed(2)}%`;
          logger.error(`${chainName.toUpperCase()} catastrophic fill detected for ${tokenData.symbol}: ${reason}`);
          markTokenBadPattern(tokenData, `catastrophic_fill:${reason}`, { hardBan: true });
          recordTradeBlockState(chainName, tokenData, strategyName, tokenData.signalSource || 'BUY', tokenData.signalSource || 'technical', reason, {
            riskFlags: ['entry_fill_below_minimum'],
          });
          await sendErrorAlert(`${chainName.toUpperCase()} catastrophic fill for ${tokenData.symbol}: ${reason}`);
          try {
            await deps.executeSell(chainName, exchange, tokenData, portfolio.positions[tokenKey], 1, 'ENTRY_FILL_GUARD');
          } catch (sellErr) {
            logger.error(`ENTRY_FILL_GUARD dump-sell failed for ${tokenData.symbol}: ${sellErr.message}`);
          }
          return { aborted: true };
        }
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
      brainProfileKey: tokenData?._brainProfileKey,
      brainMultiplier: tokenData?._brainSizeMultiplier,
      blockNumber: txResult?.blockNumber,
      confirmations: txResult?.confirmations,
      privateRouteUsed: txResult?.privateRouteUsed,
      setupType: tokenData.setupType || null,
      structureType: tokenData.structureType || null,
      setupStopPrice: tokenData.structuralStopPrice || null,
      setupTargetPrice: tokenData.measuredMoveTargetPrice || null,
      setupIsAPlus: tokenData._bullFlagIsAPlus === true ? true : undefined,
    }, strategyName);

    telemetry.logFill({
      fill_id: telemetryUuid(),
      order_id: orderId,
      ts: new Date().toISOString(),
      txid_or_exchange_id: txResult.txid || null,
      filled_base_qty: quantity,
      filled_quote_usd: filledQuoteUsd,
      avg_price: realizedEntryPrice,
      slippage_bps: entrySlippageBps,
      block_number: txResult?.blockNumber || null,
      confirmations: txResult?.confirmations || null,
      raw_receipt: {
        txid: txResult?.txid,
        blockNumber: txResult?.blockNumber,
        confirmations: txResult?.confirmations,
        privateRouteUsed: txResult?.privateRouteUsed,
        hasExchangeFilledData,
        executionProfile: txResult?.executionProfile || null,
      },
    });
    telemetry.logOrder({ order_id: orderId, status: 'filled' });

    const pos = portfolio.positions[tokenKey];
    if (pos) {
      const positionId = telemetryUuid();
      pos.sqlPositionId = positionId;
      pos.sqlApprovalDecisionId = decisionContext?.approvalDecisionId || null;
      pos.sqlDecisionId = executionDecisionId;
      deps.orderToPositionId.set(orderId, positionId);
      telemetry.logPositionOpen({
        position_id: positionId,
        chain: chainName,
        chain_key: chainName,
        symbol: tokenData.symbol,
        address: tokenData.address,
        strategy: strategyName,
        opened_at: new Date().toISOString(),
        entry_price: realizedEntryPrice,
        entry_usd: filledQuoteUsd,
        tags: {
          signalSource: pos.signalSource || null,
          discoveryLane: tokenData.discoveryLane || null,
          txid: txResult.txid || null,
          executionProfile: txResult?.executionProfile || null,
        },
      });
      telemetry.logDecision({
        decision_id: executionDecisionId,
        ts: new Date().toISOString(),
        chain: chainName,
        chain_key: chainName,
        symbol: tokenData.symbol,
        address: tokenData.address,
        strategy: strategyName,
        signal_source: tokenData.signalSource || null,
        decision_stage: 'execution',
        proposal_json: decisionContext?.proposal || null,
        risk_json: decisionContext?.riskReview || null,
        approval_json: decisionContext?.approval || null,
        final_action: 'BUY',
        approved: true,
        confidence: Number.isFinite(Number(decisionContext?.proposal?.trigger?.confidence)) ? Number(decisionContext.proposal.trigger.confidence) : null,
        ai_confidence: Number.isFinite(Number(decisionContext?.proposal?.ai?.confidence ?? tokenData.aiConfidence)) ? Number(decisionContext?.proposal?.ai?.confidence ?? tokenData.aiConfidence) : null,
        reason: safeDecisionText(tokenData.aiReason || decisionContext?.approval?.reason || 'buy executed'),
        order_id: orderId,
        position_id: positionId,
        status: 'filled',
      });
    }

    await saveState();
    await sendTradeAlert('BUY', tokenData, filledQuoteUsd);
    return { aborted: false };
  }

  async function handleBuyExecutionFailure({
    chainName,
    tokenData,
    strategyName,
    error,
    orderId,
    executionDecisionId,
    decisionContext,
    lockKey,
  }) {
    const failureClass = classifyBuyFailure(error);
    const orderStatus = failureClass.finalAction === 'QUOTE_STALE' ? 'precheck_failed' : 'failed';
    const opsEventName = failureClass.finalAction === 'QUOTE_STALE' ? 'buy_precheck_failed' : 'buy_failed';
    const alertPrefix = failureClass.finalAction === 'QUOTE_STALE' ? 'BUY precheck failed' : 'BUY failed';
    recordExchangeFailure(chainName, error.message);
    deps.recordBuyFailureState(chainName, tokenData, error.message);
    logger.error(`BUY execution failed for ${tokenData.symbol}: ${error.message}`);
    telemetry.logOrder({ order_id: orderId, status: orderStatus, error_text: error.message || String(error) });
    telemetry.logOpsEvent({
      severity: failureClass.finalAction === 'QUOTE_STALE' ? 'warning' : 'error',
      category: 'execution',
      name: opsEventName,
      chain_key: chainName,
      symbol: tokenData.symbol,
      message: String(error.message || error).slice(0, 800),
      context: { lockKey },
    });
    telemetry.logDecision({
      decision_id: executionDecisionId,
      ts: new Date().toISOString(),
      chain: chainName,
      chain_key: chainName,
      symbol: tokenData.symbol,
      address: tokenData.address,
      strategy: strategyName,
      signal_source: tokenData.signalSource || null,
      decision_stage: 'execution',
      proposal_json: decisionContext?.proposal || null,
      risk_json: decisionContext?.riskReview || null,
      approval_json: decisionContext?.approval || null,
      final_action: failureClass.finalAction,
      approved: false,
      confidence: Number.isFinite(Number(decisionContext?.proposal?.trigger?.confidence)) ? Number(decisionContext.proposal.trigger.confidence) : null,
      ai_confidence: Number.isFinite(Number(decisionContext?.proposal?.ai?.confidence ?? tokenData.aiConfidence)) ? Number(decisionContext?.proposal?.ai?.confidence ?? tokenData.aiConfidence) : null,
      reason: safeDecisionText(error.message || error, 'buy execution failed'),
      order_id: orderId,
      position_id: null,
      status: failureClass.status,
    });
    await sendErrorAlert(`${alertPrefix} for ${tokenData.symbol}: ${error.message}`);
  }

  async function finalizeSellExecutionState({
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
    const strategyStats = portfolio.strategies?.[strategyName]?.stats;
    if (!strategyStats) {
      throw new Error(`Missing strategy stats bucket for ${strategyName}`);
    }

    const positionQuantityBefore = Number(position?.quantity || 0);
    if (!Number.isFinite(positionQuantityBefore) || positionQuantityBefore <= 0) {
      logger.warn(
        `Skipping SELL finalization for ${tokenData?.symbol || position?.symbol || position?.address}: ` +
        'position is already closed or quantity is zero'
      );
      return {
        proceedsUsd: 0,
        pnl: 0,
        filledBaseQty: 0,
        fullyClosed: true,
        skipped: true,
      };
    }

    const requestedQty = Number(quantityRequested || (positionQuantityBefore * requestedFraction) || 0);
    markExecutionConfirmed(txResult, chainName, 'SELL', tokenData);
    const {
      realizedExitPrice,
      filledBaseQty,
      filledQuoteUsd,
      filledFraction,
    } = resolveSellFillMetrics(
      txResult,
      expectedExitPrice,
      requestedQty,
      positionQuantityBefore,
      requestedFraction,
      tokenData,
      chainName,
    );
    if (requestedQty > 0 && filledBaseQty < requestedQty * 0.8) {
      logger.warn(
        `Significant underfill on SELL for ${tokenData.symbol} on ${chainName}: ` +
        `requested=${requestedQty.toFixed(8)}, filled=${filledBaseQty.toFixed(8)} ` +
        `(${((filledBaseQty / requestedQty) * 100).toFixed(1)}%). Position quantity may diverge from exchange.`
      );
    }

    const costBasisPortion = Number(position.costBasisUsd || 0) * filledFraction;
    const exitSlippageBps = calcSlippageBps(expectedExitPrice, realizedExitPrice);
    if (exitSlippageBps !== null) {
      recordSlippageSample(strategyName, exitSlippageBps);
    }

    const proceedsUsd = filledQuoteUsd;
    // Fee accounting: deduct realistic round-trip costs the exchanges already took
    // out of the cash flow but are not reflected in PnL math. Without this, every
    // closed trade's PnL is overstated by ~0.2-0.4% which masks the real edge.
    const feeProfile = (config.execution?.feeProfile || {})[chainName]
      || (config.execution?.feeProfile || {}).default
      || { entryBps: 10, exitBps: 10 };
    const entryFeeUsd = costBasisPortion * (Number(feeProfile.entryBps || 10) / 10000);
    const exitFeeUsd = proceedsUsd * (Number(feeProfile.exitBps || 10) / 10000);
    const totalFeesUsd = entryFeeUsd + exitFeeUsd;
    const pnl = proceedsUsd - costBasisPortion - totalFeesUsd;
    const fillDiscrepancyPct = calcDiscrepancyPct(requestedQty, filledBaseQty);

    portfolio.balance += proceedsUsd;

    position.quantity = Math.max(0, Number(position.quantity || 0) - filledBaseQty);
    position.costBasisUsd = Math.max(0, Number(position.costBasisUsd || 0) - costBasisPortion);
    position.currentPrice = realizedExitPrice;
    position.realizedPnl = Number(position.realizedPnl || 0) + pnl;

    const quantityDustThreshold = Math.max(0.000001, positionQuantityBefore * 0.0001);
    const costBasisDustThreshold = Math.max(0.01, Number(position.initialSizeUsd || 0) * 0.0001);
    const nearFullSellRequested = requestedFraction >= 0.999999;

    const isTierSell = String(reason || '').startsWith('SELL_TIER_');
    const underfilled = requestedQty > 0 && filledBaseQty < requestedQty * 0.8;
    position.partialFillRetry = Boolean(
      (nearFullSellRequested || isTierSell) && underfilled && position.quantity > quantityDustThreshold
    );
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
    let closedTradePnl = null;
    if (!fullyClosed && pnl > 0 && String(reason || '').startsWith('SELL_TIER_')) {
      // A profitable partial exit should relieve a loss-streak lockout, but it is not
      // counted as a closed trade until the whole position is closed.
      portfolio.stats.consecutiveLosses = Math.max(0, Number(portfolio.stats.consecutiveLosses || 0) - 1);
      strategyStats.consecutiveLosses = Math.max(0, Number(strategyStats.consecutiveLosses || 0) - 1);
      position.lastProfitablePartialExitAt = new Date().toISOString();
    }
    if (fullyClosed) {
      position.partialFillRetry = false;
      const positionKey = position.key || buildTokenKey(chainName, tokenData.address);
      const finalTradePnl = Number(position.realizedPnl || 0);
      closedTradePnl = finalTradePnl;
      portfolio.stats.totalPnl += finalTradePnl;
      strategyStats.totalPnl += finalTradePnl;
      if (finalTradePnl >= 0) {
        portfolio.stats.grossProfit += finalTradePnl;
        strategyStats.grossProfit += finalTradePnl;
      } else {
        portfolio.stats.grossLoss += Math.abs(finalTradePnl);
        strategyStats.grossLoss += Math.abs(finalTradePnl);
      }
      delete portfolio.positions[positionKey];
      delete portfolio.strategies[strategyName].positions[positionKey];
      releaseLiquiditySentinel(chainName, position.pairAddress);
      if (risk && typeof risk.invalidateHoneypotCache === 'function') {
        risk.invalidateHoneypotCache(tokenData.address, chainName);
      }
      strategy.clearHistory(position.strategyKey || positionKey);
      portfolio.stats.closedTrades += 1;
      strategyStats.closedTrades += 1;
      if (finalTradePnl >= 0) {
        portfolio.stats.wins += 1;
        strategyStats.wins += 1;
        portfolio.stats.consecutiveLosses = 0;
        strategyStats.consecutiveLosses = 0;
        portfolio.stats.consecutiveWins = Number(portfolio.stats.consecutiveWins || 0) + 1;
        strategyStats.consecutiveWins = Number(strategyStats.consecutiveWins || 0) + 1;
      } else {
        portfolio.stats.losses += 1;
        strategyStats.losses += 1;
        portfolio.stats.consecutiveWins = 0;
        strategyStats.consecutiveWins = 0;
        portfolio.stats.consecutiveLosses = Number(portfolio.stats.consecutiveLosses || 0) + 1;
        portfolio.stats.maxConsecutiveLosses = Math.max(Number(portfolio.stats.maxConsecutiveLosses || 0), Number(portfolio.stats.consecutiveLosses || 0));
        strategyStats.consecutiveLosses = Number(strategyStats.consecutiveLosses || 0) + 1;
        strategyStats.maxConsecutiveLosses = Math.max(Number(strategyStats.maxConsecutiveLosses || 0), Number(strategyStats.consecutiveLosses || 0));
      }
      // Classify exit cause for agent learning - converts unknown exits into structured patterns
      const exitClassification = classifyExitReason({
        position,
        tokenData,
        reason,
        finalPnl: finalTradePnl,
        realizedExitPrice,
      });
      position.exitClassification = exitClassification.code;
      position.exitClassificationReasoning = exitClassification.reasoning;
      position.exitPriceAtClose = realizedExitPrice;
      position.exitLiquidityUsd = Number(tokenData.liquidityUsd || 0);
      position.exitPnlPct = Number(position.entryPrice) > 0
        ? ((realizedExitPrice - position.entryPrice) / position.entryPrice) * 100
        : 0;
      logger.info(
        `Exit classified for ${tokenData.symbol} [${reason}] -> ${exitClassification.code}: ${exitClassification.reasoning}`
      );

      setImmediate(() => {
        agentMemory.generateLessonWithAI(position, finalTradePnl).catch((err) => {
          logger.warn(`[AgentMemory] generateLessonWithAI failed: ${err.message}`);
        });
      });
      strategyBrain.recordClosedTrade(position, finalTradePnl);
      updateBrainProfileFromClosedTrade(position, finalTradePnl);
      updateAdaptiveSleevePerformance(position, finalTradePnl);
      if (typeof triggerLearningSync === 'function') {
        triggerLearningSync('position_close');
      }
    }

    const sellOrderId = telemetryUuid();
    telemetry.logOrder({
      order_id: sellOrderId,
      ts: new Date().toISOString(),
      chain: tokenData.chain,
      chain_key: chainName,
      symbol: tokenData.symbol,
      address: tokenData.address,
      side: 'SELL',
      strategy: strategyName,
      requested_base_qty: requestedQty,
      expected_price: expectedExitPrice,
      status: 'filled',
      reason,
      metadata: {
        requestedFraction,
        fullyClosed,
        closedTradePnl,
        recoveredFromTradeHistory: Boolean(txResult?.recoveredFromTradeHistory),
      },
    });
    telemetry.logFill({
      fill_id: telemetryUuid(),
      order_id: sellOrderId,
      ts: new Date().toISOString(),
      txid_or_exchange_id: txResult?.txid || null,
      filled_base_qty: filledBaseQty,
      filled_quote_usd: proceedsUsd,
      avg_price: realizedExitPrice,
      slippage_bps: exitSlippageBps,
      block_number: txResult?.blockNumber || null,
      confirmations: txResult?.confirmations || null,
      raw_receipt: { txid: txResult?.txid, recoveredFromTradeHistory: Boolean(txResult?.recoveredFromTradeHistory) },
    });
    if (fullyClosed && position?.sqlPositionId) {
      const entryUsd = Number(position.initialSizeUsd || 0);
      const pnlPct = entryUsd > 0 ? (Number(position.realizedPnl || pnl) / entryUsd) * 100 : null;
      telemetry.logPositionClose({
        position_id: position.sqlPositionId,
        closed_at: new Date().toISOString(),
        exit_price: realizedExitPrice,
        exit_usd: proceedsUsd,
        pnl_usd: Number(position.realizedPnl || pnl),
        pnl_pct: pnlPct,
        exit_reason: reason,
      });
    }
    if (fullyClosed) {
      const reflection = buildDecisionReflection(position, Number(closedTradePnl || position.realizedPnl || pnl), reason);
      telemetry.logDecisionReflection({
        reflection_id: reflection.reflectionId,
        decision_id: position?.sqlDecisionId || position?.sqlApprovalDecisionId || null,
        ts: reflection.ts,
        chain_key: reflection.chainKey,
        symbol: reflection.symbol,
        strategy: reflection.strategy,
        outcome: reflection.outcome,
        pnl_usd: reflection.pnlUsd,
        pnl_pct: reflection.pnlPct,
        hold_duration_hours: reflection.holdDurationHours,
        reflection_json: reflection.reflection,
        summary: reflection.summary,
      });
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
      setupType: position.setupType || null,
      structureType: position.structureType || null,
      setupStopPrice: position.structuralStopPrice || null,
      setupTargetPrice: position.measuredMoveTargetPrice || null,
      fullyClosed,
      closedTradePnl,
      exitCategory: position.exitClassification || undefined,
    }, strategyName);

    // Record trade outcome to symbol memory and RL updater for learning
    if (fullyClosed && symbolPnLMemory && rlOnlineUpdater) {
      const openedAtMs = Date.parse(position.openedAt || position.entryAt || 0);
      const holdMinutes = Number.isFinite(openedAtMs) && openedAtMs > 0
        ? Math.max(0, (Date.now() - openedAtMs) / 60_000)
        : 0;
      const pnlPercent = position.initialSizeUsd > 0 ? ((closedTradePnl ?? pnl) / position.initialSizeUsd) * 100 : 0;

      // Record to symbol memory for penalty tracking
      symbolPnLMemory.recordTrade(tokenData.symbol, chainName, strategyName, pnl, pnlPercent, holdMinutes);

      // Record to RL updater for policy learning
      rlOnlineUpdater.updateFromTrade({
        symbol: tokenData.symbol,
        chain: chainName,
        strategy: strategyName,
        pnl: Number(closedTradePnl ?? pnl),
        pnlPct: pnlPercent,
        confidence: Number(position.confidence || 0.5),
        holdMinutes,
        entryPrice: position.entryPrice,
        exitPrice: realizedExitPrice,
        volatilityClass: 'normal',
        priceChange24h: tokenData.priceChange24h || 0,
        sizeUsd: position.initialSizeUsd || 0,
        portfolio: { balance: portfolio.balance, peakBalance: portfolio.peakBalance || portfolio.balance },
      });
    }

    await saveState();
    await sendTradeAlert('SELL', tokenData, proceedsUsd, pnl);

    return {
      proceedsUsd,
      pnl,
      filledBaseQty,
      fullyClosed,
    };
  }

  async function handleSellExecutionFailure({
    chainName,
    exchange,
    tokenData,
    position,
    quantityToSell,
    strategyName,
    reason,
    error,
  }) {
    const errorText = String(error?.message || error || '');
    deps.recordExchangeFailure(chainName, error.message);
    logger.error(`SELL execution failed for ${tokenData.symbol}: ${error.message}`);

    // POSITION_DUST: estimated exit value below exchange quoteMinSize. Mark as written-off.
    if (error?.code === 'POSITION_DUST' && position) {
      if (!portfolio.writtenOffPositions || typeof portfolio.writtenOffPositions !== 'object') {
        portfolio.writtenOffPositions = {};
      }
      const writeOffKey = buildTokenKey(chainName, tokenData.address);
      if (!portfolio.writtenOffPositions[writeOffKey]) {
        portfolio.writtenOffPositions[writeOffKey] = {
          symbol: tokenData.symbol || 'UNKNOWN',
          chainKey: chainName,
          address: String(tokenData.address || '').trim(),
          writtenOffAt: new Date().toISOString(),
          estimatedFunds: Number(error.dustEstimatedFunds || 0),
          minFunds: Number(error.dustMinFunds || 0),
          reason: 'dust_below_quoteMinSize',
          originalPosition: {
            entryPrice: position.entryPrice,
            quantity: position.quantity,
            costBasisUsd: position.costBasisUsd,
            openedAt: position.openedAt,
            strategy: position.strategy,
          },
        };
        logger.warn(`[Dust] WRITE-OFF ${tokenData.symbol} on ${chainName} — value $${Number(error.dustEstimatedFunds || 0).toFixed(4)} below exchange minimum. Future exit attempts SKIPPED.`);
      }
      if (portfolio.positions) {
        const posKey = buildTokenKey(chainName, tokenData.address);
        if (portfolio.positions[posKey]) {
          delete portfolio.positions[posKey];
          logger.warn(`[Dust] Removed ${tokenData.symbol} from active positions (kept in writtenOffPositions for ledger).`);
        }
      }
      return; // do NOT mark as stuck or schedule retries
    }

    const failureKey = `${chainName}:${String(tokenData.address || tokenData.symbol || '').toLowerCase()}`;
    const runtime = portfolio.runtime = portfolio.runtime || {};
    runtime.sellFailureHistory = runtime.sellFailureHistory || {};
    const now = Date.now();
    const windowMs = Math.max(60_000, Number(config.execution?.sellFailureEscalationWindowMs || 30 * 60 * 1000));
    const threshold = Math.max(2, Number(config.execution?.sellFailureSafeModeThreshold || 3));
    const previousFailures = Array.isArray(runtime.sellFailureHistory[failureKey])
      ? runtime.sellFailureHistory[failureKey]
      : [];
    const failures = previousFailures
      .filter((entry) => now - Number(entry.ts || 0) <= windowMs)
      .concat([{ ts: now, reason: errorText.slice(0, 240) }])
      .slice(-10);
    runtime.sellFailureHistory[failureKey] = failures;
    if (!config.paperTrading && failures.length >= threshold && !portfolio.safeMode) {
      const escalationReason = `Repeated SELL failures for ${tokenData.symbol} on ${chainName} (${failures.length}/${threshold})`;
      logger.error(escalationReason);
      await sendErrorAlert(escalationReason);
      await enterSafeMode(escalationReason);
    }
    if (/transfer_from_failed|execution reverted|honeypot|cannot sell|insufficient output|sell execution timed out/i.test(errorText)) {
      const hardBan = /transfer_from_failed|honeypot|cannot sell/i.test(errorText);
      markTokenBadPattern(tokenData, `sell_failed:${errorText}`, { hardBan });
      if (hardBan && position) {
        if (!portfolio.stuckPositions || typeof portfolio.stuckPositions !== 'object') portfolio.stuckPositions = {};
        const stuckKey = buildTokenKey(chainName, tokenData.address);
        if (!portfolio.stuckPositions[stuckKey]) {
          const qty = Number(position.quantity || 0);
          const price = Number(tokenData.price || position.currentPrice || position.entryPrice || 0);
          portfolio.stuckPositions[stuckKey] = {
            symbol: tokenData.symbol || 'UNKNOWN',
            chainKey: chainName,
            address: String(tokenData.address || '').trim(),
            stuckAt: new Date().toISOString(),
            estimatedValueUsd: qty > 0 && price > 0 ? Number((qty * price).toFixed(4)) : null,
            lastError: errorText.slice(0, 200),
          };
          logger.warn(`[StuckPositions] Marked ${tokenData.symbol} on ${chainName} as stuck - buy-gate active. Error: ${errorText.slice(0, 80)}`);
        }
      }
    }
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
  }

  return {
    runBuyPreflightChecks,
    finalizeBuyExecution,
    handleBuyExecutionFailure,
    finalizeSellExecutionState,
    handleSellExecutionFailure,
  };
}

module.exports = { createExecutionFlow };
