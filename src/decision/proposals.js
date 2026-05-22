'use strict';

// Extracted from src/index.js (Week 12 A.6).
// Builds structured BUY-decision proposals + risk reviews, runs portfolio approval
// blockers, queues decision telemetry rows, and builds post-trade reflections.

function createDecisionProposals(deps) {
  const {
    config,
    BOT_PROFILE,
    CURRENT_STRATEGY_VERSION_ID,
    portfolio,
    sqlRuntimeState,
    telemetry,
    telemetryUuid,
    normalizeChainKey,
    normalizeRegimeLabel,
    isBtcRiskOff,
    getBtcRiskOffReason,
    getActivePromotionRolloutContext,
    getAiDecisionCacheStatus,
    getStatePersistenceError,
  } = deps;

  function safeDecisionText(value, fallback = '') {
    const text = String(value || fallback || '').trim();
    return text.slice(0, 800);
  }

  function deriveIncidentState({ riskCheck = null, approval = null, chainName = '', strategyName = '' } = {}) {
    const active = [];
    if (portfolio.safeMode) active.push('safe_mode_active');
    if (portfolio.balanceDriftHalt) active.push('balance_drift_halt');
    if (getStatePersistenceError() || portfolio.statePersistenceError) active.push('state_persistence_error');
    if (String(riskCheck?.code || '').toLowerCase() === 'chain_daily_loss') active.push('chain_daily_loss');
    if (approval && approval.approved === false) active.push(`approval_blocked_${String(approval.reasonCode || 'general').toLowerCase()}`);
    return {
      active,
      primary: active[0] || 'normal',
      chainKey: normalizeChainKey(chainName),
      strategy: strategyName || null,
    };
  }

  function buildDecisionProposal({
    chainName,
    tokenData,
    strategyName,
    signalSource,
    evaluation,
  }) {
    const details = evaluation?.details || {};
    return {
      botProfile: BOT_PROFILE,
      chainKey: normalizeChainKey(chainName),
      symbol: tokenData?.symbol || null,
      address: tokenData?.address || null,
      strategy: strategyName || null,
      signalSource: signalSource || tokenData?.signalSource || 'technical',
      technicalSignal: evaluation?.signal || null,
      finalSignal: tokenData?.finalSignal || 'BUY',
      ai: {
        confidence: Number(details.aiConfidence ?? tokenData?.aiConfidence ?? null),
        reason: details.aiReason || tokenData?.aiReason || null,
        verificationStatus: details.aiVerificationStatus || null,
        riskFlags: Array.isArray(details.aiRiskFlags) ? details.aiRiskFlags : [],
      },
      market: {
        price: Number(tokenData?.price || 0),
        liquidityUsd: Number(tokenData?.liquidityUsd || 0),
        volume24h: Number(tokenData?.volume24h || 0),
        priceChange24h: Number(tokenData?.priceChange24h || details?.priceChange24h || 0),
        holderCount: Number(tokenData?.holderCount || 0),
        topHoldersPct: tokenData?.topHoldersPct ?? null,
      },
      trigger: {
        timeframe: details.triggerTimeframe || tokenData?.entryTriggerTimeframe || null,
        rsi: Number(details.rsi ?? tokenData?.rsi ?? null),
        volumeSpike: Number(details.volumeSpike ?? tokenData?.volumeSpike ?? null),
        buyRatioRecentPct: Number(details.buyRatioRecentPct ?? tokenData?.buyRatioRecentPct ?? null),
        confidence: Number(details.confidence ?? tokenData?.confidence ?? null),
      },
      brain: {
        archetype: details.brainArchetype || tokenData?.brainArchetype || null,
        profileKey: details.brainProfileKey || tokenData?.brainProfileKey || null,
        marketRegime: details.marketRegime || tokenData?.marketRegime || null,
      },
      patternAnalysis: details.patternAnalysis || tokenData?.patternAnalysis || null,
      externalSignal: details.externalSignal || tokenData?.externalSignal || null,
    };
  }

  function buildDecisionRiskReview({
    chainName,
    tokenData,
    strategyName,
    riskCheck,
    evaluation,
  }) {
    const details = evaluation?.details || {};
    return {
      allowed: Boolean(riskCheck?.allowed),
      code: riskCheck?.code || null,
      reason: riskCheck?.reason || null,
      chainKey: normalizeChainKey(chainName),
      strategy: strategyName || null,
      safeMode: Boolean(portfolio.safeMode),
      balanceDriftHalt: Boolean(portfolio.balanceDriftHalt),
      statePersistenceError: Boolean(getStatePersistenceError() || portfolio.statePersistenceError),
      sqlHealthy: !process.env.SQL_ENABLED || Boolean(sqlRuntimeState.selfTestOk),
      openPositions: Object.keys(portfolio.positions || {}).length,
      strategyOpenPositions: Object.values(portfolio.positions || {}).filter((position) => String(position?.strategy || '').toLowerCase() === String(strategyName || '').toLowerCase()).length,
      aiVerificationStatus: details.aiVerificationStatus || null,
      aiRiskFlags: Array.isArray(details.aiRiskFlags) ? details.aiRiskFlags : [],
      topHoldersPctKnown: tokenData?.topHoldersPct !== null && tokenData?.topHoldersPct !== undefined,
      liquidityUsd: Number(tokenData?.liquidityUsd || 0),
    };
  }

  function approvePortfolioDecision({
    chainName,
    tokenData,
    strategyName,
    signalSource,
    evaluation,
    riskCheck,
  }) {
    const details = evaluation?.details || {};
    const blockers = [];
    const notes = [];
    const liveMode = BOT_PROFILE === 'live' && !config.paperTrading;
    const aiVerificationStatus = String(details.aiVerificationStatus || '').toLowerCase();
    const aiConfidence = Number(details.aiConfidence ?? tokenData?.aiConfidence ?? 0);
    const aiFloor = Number(details.confidenceFloor || 0);

    if (!riskCheck?.allowed) {
      blockers.push({ code: String(riskCheck?.code || 'risk_guardian_block'), reason: safeDecisionText(riskCheck?.reason, 'risk guardian blocked entry') });
    }
    if (portfolio.safeMode) {
      blockers.push({ code: 'safe_mode_active', reason: 'safe mode is active' });
    }
    if (portfolio.balanceDriftHalt) {
      blockers.push({ code: 'balance_drift_halt', reason: 'balance drift halt is active' });
    }
    if (liveMode && String(process.env.SQL_ENABLED || '').toLowerCase() === 'true') {
      const selfTestAgeMs = sqlRuntimeState.lastSelfTestAt ? (Date.now() - sqlRuntimeState.lastSelfTestAt) : Infinity;
      const selfTestMaxAgeMs = Number(process.env.SQL_SELF_TEST_MAX_AGE_MS || 10 * 60 * 1000); // 10 min
      if (!sqlRuntimeState.selfTestOk) {
        blockers.push({ code: 'sql_self_test_failed', reason: 'live execution blocked while SQL self-test is unhealthy' });
      } else if (selfTestAgeMs > selfTestMaxAgeMs) {
        blockers.push({ code: 'sql_self_test_stale', reason: `SQL self-test ok but stale (${(selfTestAgeMs / 60_000).toFixed(1)} min old, max ${(selfTestMaxAgeMs / 60_000).toFixed(0)} min)` });
      }
    }
    if (liveMode && aiVerificationStatus.includes('pending')) {
      const freshCacheStatus = getAiDecisionCacheStatus(tokenData, strategyName);
      const pendingMs = freshCacheStatus.queuedAt ? Date.now() - Date.parse(freshCacheStatus.queuedAt) : 0;
      const aiPendingTimeoutMs = Number(process.env.AI_PENDING_TIMEOUT_MS || 45000);
      if (pendingMs < aiPendingTimeoutMs) {
        blockers.push({ code: 'ai_verification_pending', reason: `AI verification pending (${(pendingMs / 1000).toFixed(0)}s / ${(aiPendingTimeoutMs / 1000).toFixed(0)}s timeout)` });
      }
    }
    if (liveMode && signalSource === 'AI' && aiFloor > 0 && aiConfidence > 0 && aiConfidence < aiFloor) {
      blockers.push({ code: 'ai_confidence_below_floor', reason: `AI confidence ${aiConfidence.toFixed(1)} is below floor ${aiFloor.toFixed(1)}` });
    }
    if (liveMode && (tokenData?.topHoldersPct === null || tokenData?.topHoldersPct === undefined) && (chainName === 'bsc' || chainName === 'base')) {
      blockers.push({ code: 'holder_concentration_unknown', reason: `${String(chainName).toUpperCase()} holder concentration is unavailable` });
    }

    const symbolUpper = String(tokenData?.symbol || '').toUpperCase();
    if (isBtcRiskOff() && symbolUpper !== 'BTC' && symbolUpper !== 'WBTC') {
      blockers.push({ code: 'btc_risk_off', reason: getBtcRiskOffReason() || 'BTC selling off; alts blocked' });
    }

    if (!blockers.length) {
      notes.push(`approved for ${BOT_PROFILE} ${normalizeChainKey(chainName)} ${strategyName}`);
    }

    const approved = blockers.length === 0;
    return {
      approved,
      action: approved ? 'BUY' : 'REJECT',
      reasonCode: blockers[0]?.code || 'approved',
      reason: blockers[0]?.reason || notes[0] || 'approved',
      blockers,
      checks: {
        liveMode,
        sqlSelfTestOk: Boolean(sqlRuntimeState.selfTestOk),
        aiVerificationStatus: details.aiVerificationStatus || null,
        aiConfidence,
        aiFloor,
        safeMode: Boolean(portfolio.safeMode),
        balanceDriftHalt: Boolean(portfolio.balanceDriftHalt),
      },
      notes,
      incidentState: deriveIncidentState({ riskCheck, chainName, strategyName }),
    };
  }

  function queueDecisionTelemetry({
    stage,
    tokenData,
    chainName,
    strategyName,
    signalSource,
    proposal = null,
    riskReview = null,
    approval = null,
    finalAction = null,
    approved = false,
    reason = null,
    status = null,
    orderId = null,
    positionId = null,
  }) {
    const decisionId = telemetryUuid();
    const confidence = proposal?.trigger?.confidence;
    const aiConfidence = proposal?.ai?.confidence ?? tokenData?.aiConfidence;
    const activeRollout = getActivePromotionRolloutContext();
    telemetry.logDecision({
      decision_id: decisionId,
      ts: new Date().toISOString(),
      chain: tokenData?.chain || chainName,
      chain_key: normalizeChainKey(chainName),
      symbol: tokenData?.symbol || null,
      address: tokenData?.address || null,
      strategy: strategyName || null,
      signal_source: signalSource || tokenData?.signalSource || 'technical',
      decision_stage: stage,
      proposal_json: proposal || null,
      risk_json: riskReview || null,
      approval_json: approval || null,
      final_action: finalAction || null,
      approved: Boolean(approved),
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      ai_confidence: Number.isFinite(Number(aiConfidence)) ? Number(aiConfidence) : null,
      reason: safeDecisionText(reason || approval?.reason || riskReview?.reason || tokenData?.aiReason || ''),
      order_id: orderId,
      position_id: positionId,
      status: status || null,
      strategy_version_id: CURRENT_STRATEGY_VERSION_ID,
      regime_label: normalizeRegimeLabel(tokenData?.marketRegime || proposal?.marketContext?.regime || ''),
      promotion_stage: BOT_PROFILE === 'paper' ? 'paper_candidate' : (activeRollout?.stage || 'live_active'),
    });
    return decisionId;
  }

  function buildDecisionReflection(position, finalTradePnl, reason) {
    const openedAtMs = position?.openedAt ? new Date(position.openedAt).getTime() : NaN;
    const closedAtMs = Date.now();
    const holdDurationHours = Number.isFinite(openedAtMs) ? ((closedAtMs - openedAtMs) / (1000 * 60 * 60)) : null;
    const initialSizeUsd = Number(position?.initialSizeUsd || position?.costBasisUsd || 0);
    const pnlPct = initialSizeUsd > 0 ? (Number(finalTradePnl || 0) / initialSizeUsd) * 100 : null;
    const outcome = Number(finalTradePnl || 0) > 0 ? 'win' : (Number(finalTradePnl || 0) < 0 ? 'loss' : 'flat');
    const summary = outcome === 'win'
      ? `Closed green after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; keep leaning into this setup when approval conditions match.`
      : outcome === 'loss'
        ? `Closed red after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; review trigger quality, liquidity, and approval blockers for similar setups.`
        : `Closed flat after ${holdDurationHours !== null ? holdDurationHours.toFixed(2) : 'n/a'}h; setup was indecisive and may need tighter approval thresholds.`;
    return {
      reflectionId: telemetryUuid(),
      ts: new Date().toISOString(),
      botProfile: BOT_PROFILE,
      chainKey: normalizeChainKey(position?.chainKey || position?.chain),
      symbol: position?.symbol || null,
      strategy: position?.strategy || null,
      outcome,
      pnlUsd: Number(finalTradePnl || 0),
      pnlPct,
      holdDurationHours,
      summary,
      reflection: {
        exitReason: reason || null,
        signalSource: position?.signalSource || null,
        triggerTimeframe: position?.triggerTimeframe || null,
        aiConfidence: Number(position?.aiConfidence || 0),
        entryLiquidityUsd: Number(position?.entryLiquidityUsd || 0),
        entryTopHoldersPct: position?.entryTopHoldersPct ?? null,
        realizedPnlByTier: position?.realizedPnlByTier || {},
        approvalDecisionId: position?.sqlApprovalDecisionId || null,
        executionDecisionId: position?.sqlDecisionId || null,
      },
      strategy_version_id: CURRENT_STRATEGY_VERSION_ID,
      regime_label: normalizeRegimeLabel(position?.marketRegime || ''),
    };
  }

  return {
    safeDecisionText,
    deriveIncidentState,
    buildDecisionProposal,
    buildDecisionRiskReview,
    approvePortfolioDecision,
    queueDecisionTelemetry,
    buildDecisionReflection,
  };
}

module.exports = { createDecisionProposals };
