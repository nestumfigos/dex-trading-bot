function createTokenDecisionPipeline(deps = {}) {
  const {
    config,
    logger,
    aiCircuit,
    operationalDiagnostics,
    agentMemory,
    risk,
    strategy,
    AITradeBrain,
    getStrategyScanStatus,
    syncChainScanStatus,
    removeAiDecisionQueueCandidate,
    getHourlyWinRateAdjustment,
    getDynamicAiFloorAdjustment,
    cacheAiDecisionCandidate,
    queueAiDecisionRefresh,
    getCachedAiDecision,
    recordBrainSuccess,
    recordBrainFailure,
    getAiDecisionCacheStatus,
    refreshBrainAvailability,
    incrementRejectReason,
    tryRotateForStrongerMomentum,
    approvePortfolioDecision,
    queueDecisionTelemetry,
    recordTradeBlockState,
    classifyRejectReason,
    executeBuy,
    enterSafeMode,
    sendErrorAlert,
  } = deps;

  function updateTokenScanState(chainName, tokenAddress, tokenData, scanStrategy = '') {
    const normalizedStrategy = String(scanStrategy || '').toLowerCase();
    const scanState = getStrategyScanStatus(chainName, normalizedStrategy);
    if (!scanState) return;
    scanState.currentToken = `${tokenData.symbol} (${tokenAddress})`;
    scanState.currentPair = tokenData.pairAddress || tokenData.pair || '-';
    scanState.lastUpdate = new Date().toISOString();
    if (normalizedStrategy) {
      syncChainScanStatus(chainName);
    }
  }

  async function runTokenEligibilityGates(chainName, exchange, tokenAddress, tokenData, trackInsufficient) {
    if (tokenData.reserveImbalanced) {
      logger.debug(`Skipping ${tokenData.symbol} (${chainName}): reserve imbalance ratio ${(tokenData.reserveRatio || 0).toFixed(0)}`);
      trackInsufficient('reserve_imbalance');
      return false;
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
        return false;
      }
      if (Number.isFinite(buyTaxPct) && buyTaxPct > maxBuyTaxPct) {
        logger.warn(`Skipping ${tokenData.symbol} (${chainName}): buy tax ${buyTaxPct.toFixed(2)}% exceeds limit ${maxBuyTaxPct.toFixed(2)}%`);
        trackInsufficient('buy_tax_too_high');
        return false;
      }
      if (Number.isFinite(sellTaxPct) && sellTaxPct > maxSellTaxPct) {
        logger.warn(`Skipping ${tokenData.symbol} (${chainName}): sell tax ${sellTaxPct.toFixed(2)}% exceeds limit ${maxSellTaxPct.toFixed(2)}%`);
        trackInsufficient('sell_tax_too_high');
        return false;
      }
    }

    if ((chainName === 'bsc' || chainName === 'base') && !tokenData.isHoneypot && typeof exchange.checkRoundTripFriction === 'function') {
      const frictionResult = await exchange.checkRoundTripFriction(tokenAddress, 0.01).catch(() => ({ blocked: false }));
      if (frictionResult.blocked) {
        logger.warn(`Skipping ${tokenData.symbol} (${chainName}): ${frictionResult.reason} (${(frictionResult.frictionPct || 0).toFixed(1)}%)`);
        trackInsufficient('round_trip_friction');
        return false;
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
      return false;
    }

    if (chainName === 'bsc') {
      tokenData.privateRouteVerified = !config.execution?.requirePrivateTxForBsc
        || config.paperTrading
        || typeof exchange.hasPrivateTxRoute !== 'function'
        || exchange.hasPrivateTxRoute();
    }

    return true;
  }

  async function applyAiReviewToEvaluation({
    chainName,
    tokenData,
    strategyName,
    evaluation,
    cycleStats,
    isBscRelaxedContinuation,
  }) {
    let finalSignal = evaluation.signal;
    let signalSource = 'technical';
    let aiBlockedThisToken = false;
    const triggerTimeframe = String(evaluation?.details?.triggerTimeframe || '').toLowerCase();
    const allowKucoinTechnicalFallback = strategyName === 'momentum'
      && chainName === 'kucoin'
      && triggerTimeframe !== 'extreme_24h_momentum'
      && config.execution?.allowTechnicalFallbackOnAiFailure === true;
    const allowKucoinPendingAiAdvisory = strategyName === 'momentum'
      && chainName === 'kucoin'
      && triggerTimeframe !== 'extreme_24h_momentum'
      && config.execution?.kucoinPendingAiAdvisory !== false;

    // Early-pump AI bypass: queue AI for fresh KuCoin momentum tokens even when technical=HOLD.
    // Without this, freshly-listed pumps (RSI needs 15 bars, volSpike 8) and extreme movers
    // (>60% triggers extreme_24h_momentum gate requiring AI BUY) stay stuck SCANNING because
    // AI is only queued when technical already says BUY — Catch-22.
    const tokenPriceChange24h = Number(tokenData?.priceChange24h || evaluation?.details?.priceChange24h || 0);
    const tokenLiquidityUsd = Number(tokenData?.liquidityUsd || 0);
    const tokenHistoryBars = Number(tokenData?.historyBars || 0);
    const earlyPumpTriggerPct = Number(config.execution?.kucoinEarlyPumpAiTriggerPct || 10);
    const earlyPumpMinLiqUsd = Number(config.execution?.kucoinEarlyPumpMinLiquidityUsd || 5000);
    const technicalIndicatorsNotReady = tokenHistoryBars < 15;
    const earlyPumpAiBypass = strategyName === 'momentum'
      && chainName === 'kucoin'
      && evaluation.signal !== 'BUY'
      && (technicalIndicatorsNotReady || triggerTimeframe === 'extreme_24h_momentum')
      && tokenPriceChange24h >= earlyPumpTriggerPct
      && tokenLiquidityUsd >= earlyPumpMinLiqUsd;
    if (earlyPumpAiBypass) {
      evaluation.details.earlyPumpAiBypass = true;
      evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'early_pump_ai_bypass'])];
    }

    if (evaluation.signal !== 'BUY' && !earlyPumpAiBypass) {
      removeAiDecisionQueueCandidate(tokenData, strategyName);
    }

    if (config.anthropic.enabled && (evaluation.signal === 'BUY' || earlyPumpAiBypass)) {
      if (Date.now() >= aiCircuit.cooldownUntil) {
        const baseAiFloor = Number(config.strategies?.[strategyName]?.aiConfidenceFloor || config.risk.aiConfidenceFloor || 70);
        const hourlyWinRateAdjustment = getHourlyWinRateAdjustment(strategyName);
        const dynamicFloorAdjustment = typeof getDynamicAiFloorAdjustment === 'function'
          ? Number(getDynamicAiFloorAdjustment(strategyName) || 0)
          : 0;
        const regimeFloorDelta = Number(evaluation.details?.regimeAdaptiveAdjustments?.confidenceFloorDelta || 0);
        // Symbol penalty: bump AI floor for names that recently lost. Prevents re-entering
        // a chronic loser without a stronger AI conviction signal.
        const symbolCtx = typeof agentMemory?.getSymbolContext === 'function'
          ? agentMemory.getSymbolContext(tokenData.symbol, strategyName)
          : { penaltyPct: 0, insights: [] };
        const rawSymbolPenalty = Number(symbolCtx.penaltyPct || 0);
        const brainActive = config.risk?.brainEnabled !== false && config.risk?.learningEnabled !== false;
        const useSymbolPenalty = !brainActive || config.risk?.useSymbolPenaltyWhenBrainActive === true;
        const symbolPenalty = useSymbolPenalty ? rawSymbolPenalty : 0;
        const strategyAiFloor = Math.max(0, Math.min(100,
          baseAiFloor + Number(hourlyWinRateAdjustment.adjustmentPct || 0) + dynamicFloorAdjustment + regimeFloorDelta + symbolPenalty
        ));
        evaluation.details.hourlyWinRateAdjustment = hourlyWinRateAdjustment;
        evaluation.details.dynamicAiFloorAdjustment = dynamicFloorAdjustment;
        evaluation.details.regimeFloorAdjustment = regimeFloorDelta;
        evaluation.details.symbolPenaltyPct = symbolPenalty;
        evaluation.details.symbolPenaltyRawPct = rawSymbolPenalty;
        evaluation.details.symbolPenaltySuppressedByBrain = !useSymbolPenalty && rawSymbolPenalty > 0;
        if (symbolCtx.insights?.length) {
          evaluation.details.symbolHistory = symbolCtx.insights;
        }
        cacheAiDecisionCandidate(tokenData, {
          ...evaluation.details,
          signal: evaluation.signal,
          strategy: strategyName,
          confidenceFloor: strategyAiFloor,
        }, strategyName, {
          source: chainName === 'bsc' ? 'bsc_buy_candidate' : 'buy_candidate',
        });
        let aiBypassedForLatency = false;
        const currentRegime = evaluation.details.marketRegime || 'unknown';
        const listingAgeHours = Number(tokenData.listingAgeDays || 0) * 24;
        const tokenAgeBucket = listingAgeHours > 0 && listingAgeHours < 24 ? 'new' : listingAgeHours < 168 ? 'emerging' : 'established';
        const aiContext = typeof agentMemory?.getContextForAI === 'function'
          ? agentMemory.getContextForAI({ regime: currentRegime, chain: chainName, strategy: strategyName, tokenAgeBucket })
          : null;
        const aiInput = {
          ...evaluation.details,
          signal: evaluation.signal,
          strategy: strategyName,
          confidenceFloor: strategyAiFloor,
          marketRegime: currentRegime,
          tokenAgeBucket,
          operatorKnowledge: (aiContext?.operatorKnowledge || []).slice(0, 8),
        };
        const useNonBlockingAi = config.execution?.aiNonBlocking !== false
          || (strategyName === 'momentum' && config.execution?.momentumAiNonBlocking !== false);
        const cachedDecisionForToken = getCachedAiDecision(tokenData, strategyName);
        let aiDecision;
        if (cachedDecisionForToken) {
          aiDecision = cachedDecisionForToken;
          if (useNonBlockingAi) {
            queueAiDecisionRefresh(tokenData, aiInput, strategyName);
          }
        } else if (useNonBlockingAi) {
          queueAiDecisionRefresh(tokenData, aiInput, strategyName);
          aiBypassedForLatency = true;
          aiDecision = null;
        } else {
          aiDecision = await AITradeBrain.evaluateToken(tokenData, aiInput);
        }

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
          const anyProviderEnabled = typeof AITradeBrain.hasAnyEnabledProvider === 'function'
            ? AITradeBrain.hasAnyEnabledProvider()
            : !!(config.anthropic.enabled && config.anthropic.apiKey);
          if (anyProviderEnabled) {
            aiCircuit.failures += 1;
            if (aiCircuit.failures >= config.bot.aiFailureThreshold) {
              aiCircuit.cooldownUntil = Date.now() + (config.bot.aiFailureCooldownSeconds * 1000);
              aiCircuit.failures = 0;
              recordBrainFailure(`AI circuit opened for ${config.bot.aiFailureCooldownSeconds}s`);
            } else {
              recordBrainFailure('AI response unavailable');
            }
          }
          // Technical-only fallback when AI fully unavailable: keep BUY signal but flag it.
          // Requires technical signal to be BUY (already true here since we entered this block).
          if (config.execution?.allowTechnicalFallbackOnAiFailure !== false) {
            finalSignal = evaluation.signal;
            signalSource = 'technical_ai_unavailable';
            evaluation.details.aiReason = 'ai_chain_exhausted_technical_fallback';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_unavailable_technical_only'])];
            logger.warn(`AI unavailable for ${tokenData.symbol}: using technical signal as fallback (all providers failed)`);
          } else {
            finalSignal = 'HOLD';
            signalSource = 'ai_unavailable_block';
            evaluation.details.aiReason = 'ai_chain_exhausted_trade_blocked';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_unavailable_blocked'])];
            logger.warn(`AI unavailable for ${tokenData.symbol}: blocking BUY instead of using technical-only fallback`);
            if (cycleStats) {
              cycleStats.aiBlocked += 1;
              aiBlockedThisToken = true;
              incrementRejectReason(cycleStats, 'aiUnavailable');
            }
          }
        } else if (aiBypassedForLatency) {
          evaluation.details.aiReason = 'ai_cached_decision_pending';
          evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_cached_decision_pending'])];
          // Detect AI is broadly unavailable: circuit recently opened OR multiple recent failures.
          // When unavailable, allow technical fallback for ALL momentum strategies, not just KuCoin extreme.
          const aiBroadlyUnavailable = aiCircuit.failures >= Math.max(2, Math.floor(config.bot.aiFailureThreshold / 2))
            || aiCircuit.cooldownUntil > Date.now();
          const narrowFallback = strategyName === 'momentum'
            && chainName === 'kucoin'
            && (triggerTimeframe === 'extreme_24h_momentum' || triggerTimeframe === 'kucoin_relaxed_momentum')
            && config.execution?.allowTechnicalFallbackOnAiFailure === true;
          const broadFallback = aiBroadlyUnavailable
            && strategyName === 'momentum'
            && config.execution?.allowTechnicalFallbackOnAiFailure !== false;
          const allowTechnicalFallback = narrowFallback || broadFallback || allowKucoinPendingAiAdvisory;
          if (allowTechnicalFallback) {
            finalSignal = evaluation.signal;
            signalSource = broadFallback ? 'technical_ai_unavailable' : 'technical_ai_pending';
            evaluation.details.aiReason = broadFallback ? 'ai_chain_exhausted_technical_fallback' : 'ai_pending_advisory_only';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []),
              broadFallback ? 'ai_unavailable_technical_only' : 'ai_advisory_only'])];
            const reason = broadFallback ? 'AI providers exhausted' : 'AI decision queued';
            logger.info(`Technical fallback for ${tokenData.symbol}: kept BUY (${reason})`);
          } else {
            finalSignal = 'HOLD';
            signalSource = broadFallback ? 'ai_unavailable_block' : 'ai_pending_block';
            evaluation.details.aiReason = broadFallback ? 'ai_chain_exhausted_trade_blocked' : 'ai_cached_decision_pending_trade_blocked';
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []),
              broadFallback ? 'ai_unavailable_blocked' : 'ai_pending_blocked'])];
            if (cycleStats) {
              cycleStats.aiBlocked += 1;
              aiBlockedThisToken = true;
              incrementRejectReason(cycleStats, 'aiPending');
            }
          }
        }

        // 2-of-3 signal confirmation cascade: require at least 2 of (Technical, AI, Sentiment)
        // to align before committing to BUY. Prevents single-signal false positives.
        // When AI is unavailable (chain exhausted), reduce requirement to 1 (technical-only fallback).
        if (finalSignal === 'BUY' && config.risk?.requireSignalCascade !== false) {
          const techConfirms = evaluation.signal === 'BUY';
          const aiConfirms = aiDecision?.signal === 'BUY' && Number(aiDecision?.confidence || 0) >= strategyAiFloor;
          const sentimentScore = Number(evaluation.details?.sentimentSnapshot?.aggregateScore || 0.5);
          const sentimentSignalStr = String(evaluation.details?.sentimentSnapshot?.signal || '').toUpperCase();
          const sentimentConfirms = sentimentSignalStr === 'BUY' || sentimentScore >= 0.55;
          const confirmCount = (techConfirms ? 1 : 0) + (aiConfirms ? 1 : 0) + (sentimentConfirms ? 1 : 0);
          const aiUnavailable = !aiDecision && signalSource === 'technical_ai_unavailable';
          const bookRatio = Number(evaluation.details?.bookImbalance?.ratio || 0);
          const bookConfirms = Number.isFinite(bookRatio)
            && bookRatio >= Number(config.risk?.signalCascadeMinBookImbalanceRatio || 1.1);
          const liquidityUsd = Math.max(
            Number(tokenData.volume24h || 0),
            Number(tokenData.quoteVolume || 0),
            Number(tokenData.liquidityUsd || 0)
          );
          const liquidityConfirms = Number.isFinite(liquidityUsd)
            && liquidityUsd >= Number(config.risk?.signalCascadeMinVolume24hUsd || 75000);
          const fallbackConfirmCount = (techConfirms ? 1 : 0)
            + (sentimentConfirms ? 1 : 0)
            + (bookConfirms ? 1 : 0)
            + (liquidityConfirms ? 1 : 0);
          evaluation.details.signalCascade = {
            techConfirms,
            aiConfirms,
            sentimentConfirms,
            bookConfirms,
            liquidityConfirms,
            confirmCount,
            fallbackConfirmCount,
            aiUnavailable,
          };
          const isKucoinEarlyBreakout = chainName === 'kucoin' && evaluation.details?.breakoutConfirmed === true;
          const bscRelaxedMinConfirmations = Number(config.risk?.bscRelaxedContinuationMinConfirmations || 1);
          const earlyPumpAiOnly = earlyPumpAiBypass
            && signalSource === 'AI'
            && config.execution?.kucoinEarlyPumpBypassCascade !== false;
          const baseMinConfirmations = earlyPumpAiOnly
            ? 1
            : (isKucoinEarlyBreakout
              ? Number(config.risk?.kucoinEarlyBreakoutSignalCascadeMinConfirmations || 1)
              : (isBscRelaxedContinuation
                ? bscRelaxedMinConfirmations
                : Number(config.risk?.signalCascadeMinConfirmations || 2)));
          const minConfirmations = baseMinConfirmations;
          const strictAiUnavailableFallback = aiUnavailable && config.execution?.allowTechnicalFallbackOnAiFailure === true;
          const pendingAiAdvisory = !aiDecision && signalSource === 'technical_ai_pending';
          const minFallbackConfirmations = allowKucoinTechnicalFallback
            ? Math.max(1, Number(config.risk?.kucoinAiUnavailableMinConfirmations || 1))
            : (
              pendingAiAdvisory
                ? Math.max(1, Number(config.execution?.kucoinPendingAiMinConfirmations || 2))
                : Number(config.risk?.aiUnavailableMinConfirmations || 3)
            );
          if ((strictAiUnavailableFallback || pendingAiAdvisory) && fallbackConfirmCount < minFallbackConfirmations && !isBscRelaxedContinuation) {
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_unavailable_confirmation_insufficient'])];
            evaluation.details.aiReason = pendingAiAdvisory
              ? `ai_pending_only_${fallbackConfirmCount}_fallback_confirmations`
              : (evaluation.details.aiReason || `ai_unavailable_only_${fallbackConfirmCount}_fallback_confirmations`);
            finalSignal = 'HOLD';
            if (cycleStats) {
              cycleStats.aiBlocked += 1;
              aiBlockedThisToken = true;
              incrementRejectReason(cycleStats, 'signalCascade');
            }
          }
          if (!aiUnavailable && !pendingAiAdvisory && confirmCount < minConfirmations) {
            evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'signal_cascade_insufficient'])];
            evaluation.details.aiReason = evaluation.details.aiReason || `signal_cascade_only_${confirmCount}_of_3`;
            finalSignal = 'HOLD';
            if (cycleStats) {
              cycleStats.aiBlocked += 1;
              aiBlockedThisToken = true;
              incrementRejectReason(cycleStats, 'signalCascade');
            }
          }
        }

        evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
      } else {
        if (config.execution?.allowTechnicalFallbackOnAiFailure === true || allowKucoinTechnicalFallback) {
          logger.debug(`AI in cooldown; using technical signal for ${strategyName} (fallback explicitly enabled)`);
          finalSignal = evaluation.signal;
          signalSource = 'technical_ai_cooldown';
          evaluation.details.aiReason = 'ai_cooldown_advisory_only';
          evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_cooldown_advisory_only'])];
        } else {
          finalSignal = 'HOLD';
          signalSource = 'ai_cooldown_block';
          evaluation.details.aiReason = 'ai_cooldown_trade_blocked';
          evaluation.details.aiRiskFlags = [...new Set([...(evaluation.details.aiRiskFlags || []), 'ai_cooldown_blocked'])];
          if (cycleStats) {
            cycleStats.aiBlocked += 1;
            aiBlockedThisToken = true;
            incrementRejectReason(cycleStats, 'aiCooldown');
          }
        }
        evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
      }
    } else {
      refreshBrainAvailability();
      evaluation.details.aiVerificationStatus = getAiDecisionCacheStatus(tokenData, strategyName).status;
    }

    return { finalSignal, signalSource, aiBlockedThisToken };
  }

  async function handleApprovedTradeDecision({
    chainName,
    exchange,
    tokenData,
    strategyName,
    evaluation,
    signalSource,
    cycleStats,
    proposalDecisionId,
    proposal,
    riskReview,
    riskCheck,
  }) {
    if (!riskCheck.allowed) {
      const rotationEligibleBlock = (
        riskCheck.code === 'max_concurrent_positions'
        || riskCheck.code === 'portfolio_heat'
        || riskCheck.code === 'per_chain_position_limit'
      );
      if (rotationEligibleBlock && strategyName === 'momentum') {
        const sameChainOnly = (
          riskCheck.code === 'portfolio_heat'
          || riskCheck.code === 'per_chain_position_limit'
        );
        const rotationResult = await tryRotateForStrongerMomentum(
          tokenData,
          strategyName,
          evaluation.details || {},
          {
            blockCode: riskCheck.code,
            blockReason: riskCheck.reason,
            sameChainOnly,
          }
        );
        if (rotationResult?.rotated) {
          logger.info(`Momentum rotation opened room for ${tokenData.symbol} (${strategyName}) after ${riskCheck.code}: ${rotationResult.reason}`);
          const recheck = await risk.canTrade(tokenData, strategy.priceHistory || {}, strategyName);
          if (recheck.allowed) {
            const approval = approvePortfolioDecision({
              chainName,
              tokenData,
              strategyName,
              signalSource,
              evaluation,
              riskCheck: recheck,
            });
            const approvalDecisionId = queueDecisionTelemetry({
              stage: 'approval',
              tokenData,
              chainName,
              strategyName,
              signalSource,
              proposal,
              riskReview: {
                ...riskReview,
                rotationTriggered: true,
                rotationRecheckAllowed: true,
              },
              approval,
              finalAction: approval.action,
              approved: approval.approved,
              reason: approval.reason,
              status: approval.approved ? 'approved' : 'rejected',
            });
            if (!approval.approved) {
              logger.warn(`Portfolio approval blocked ${tokenData.symbol} (${strategyName}): ${approval.reason}`);
              recordTradeBlockState(
                chainName,
                tokenData,
                strategyName,
                evaluation.signal,
                signalSource,
                approval.reason,
                {
                  riskFlags: [approval.reasonCode].filter(Boolean),
                  rotationContext: rotationResult?.context || null,
                }
              );
              return 'continue';
            }
            tokenData._decisionTelemetry = {
              proposalDecisionId,
              proposal,
              riskReview: {
                ...riskReview,
                rotationTriggered: true,
                rotationRecheckAllowed: true,
              },
              approval,
              approvalDecisionId,
            };
            if (cycleStats) {
              cycleStats.passed += 1;
            }
            await executeBuy(chainName, exchange, tokenData, strategyName);
            return 'bought';
          }
          logger.info(`Rotation executed but buy still blocked for ${tokenData.symbol}: ${recheck.reason}`);
        }
        if (!rotationResult?.rotated && rotationResult?.reason) {
          logger.info(`Momentum rotation skipped for ${tokenData.symbol} (${strategyName}) after ${riskCheck.code}: ${rotationResult.reason}`);
          if (rotationResult.context) {
            logger.info('Momentum rotation context', {
              symbol: tokenData.symbol,
              strategy: strategyName,
              blockCode: riskCheck.code,
              rotationContext: rotationResult.context,
            });
          }
          riskCheck = {
            ...riskCheck,
            reason: rotationResult.reason,
          };
          evaluation.notBoughtReason = rotationResult.reason;
          evaluation.details = {
            ...(evaluation.details || {}),
            rotationContext: rotationResult.context || null,
          };
        }
      }

      logger.warn(`Trade blocked for ${tokenData.symbol} (${strategyName}): ${riskCheck.reason}`);
      if (riskCheck.code === 'chain_daily_loss') operationalDiagnostics.dailyLossBlockCount++;
      recordTradeBlockState(
        chainName,
        tokenData,
        strategyName,
        evaluation.signal,
        signalSource,
        riskCheck.reason,
        {
          riskFlags: [riskCheck.code || riskCheck.reason].filter(Boolean),
          rotationContext: evaluation.details?.rotationContext || null,
        }
      );
      if (cycleStats) {
        cycleStats.riskBlocked += 1;
        incrementRejectReason(cycleStats, classifyRejectReason(riskCheck.code || riskCheck.reason));
      }
      return 'continue';
    }

    const approval = approvePortfolioDecision({
      chainName,
      tokenData,
      strategyName,
      signalSource,
      evaluation,
      riskCheck,
    });
    const approvalDecisionId = queueDecisionTelemetry({
      stage: 'approval',
      tokenData,
      chainName,
      strategyName,
      signalSource,
      proposal,
      riskReview,
      approval,
      finalAction: approval.action,
      approved: approval.approved,
      reason: approval.reason,
      status: approval.approved ? 'approved' : 'rejected',
    });
    if (!approval.approved) {
      logger.warn(`Portfolio approval blocked ${tokenData.symbol} (${strategyName}): ${approval.reason}`);
      recordTradeBlockState(
        chainName,
        tokenData,
        strategyName,
        evaluation.signal,
        signalSource,
        approval.reason,
        { riskFlags: [approval.reasonCode].filter(Boolean) }
      );
      if (cycleStats) {
        cycleStats.riskBlocked += 1;
        incrementRejectReason(cycleStats, classifyRejectReason(approval.reasonCode || approval.reason));
      }
      return 'continue';
    }

    tokenData._decisionTelemetry = {
      proposalDecisionId,
      proposal,
      riskReview,
      approval,
      approvalDecisionId,
    };

    if (cycleStats) {
      cycleStats.passed += 1;
    }

    await executeBuy(chainName, exchange, tokenData, strategyName);
    return 'bought';
  }

  return {
    updateTokenScanState,
    runTokenEligibilityGates,
    applyAiReviewToEvaluation,
    handleApprovedTradeDecision,
  };
}

module.exports = {
  createTokenDecisionPipeline,
};
