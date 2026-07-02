const fs = require('fs').promises;
const { getPool, ensureSchema, sql } = require('./sqlServer');
const { classifyPromotionImpact, classifyRegimeFamily } = require('./promotion-governance');
const { normalizeMutationProposal } = require('../../packages/core');

function createSelfEvolutionOrchestration(deps = {}) {
  const {
    config,
    logger,
    marketState,
    portfolio,
    filterStatsState,
    operationalDiagnostics,
    intelligenceAgent,
    agentMemory,
    getHealthStatus,
    getChainPerformanceSnapshot,
    getSignalQualitySnapshot,
    getFillQualitySnapshot,
    telemetry,
    evolutionGovernor,
    selfEvolution,
    evolutionValidator,
    strategyLab,
    saveState,
    shutdownAndExit,
    LIVE_ROLLOUT_PATH,
    execFileSync,
    processExecPath,
    rollbackScriptPath,
    projectRoot,
    pathModule,
    loopLocks,
    strategyVersionId,
    strategyVersionHash,
  } = deps;

  function getSelfEvolutionContext() {
    const intelligenceContext = intelligenceAgent.getContextForEvolution();
    const memoryContext = agentMemory.getContextForAI();
    const recentMonopolySnaps = operationalDiagnostics.chainMonopolyHistory.slice(-5);
    const chainConcentration = {};
    for (const snap of recentMonopolySnaps) {
      for (const [chain, count] of Object.entries(snap.chainBreakdown || {})) {
        chainConcentration[chain] = Math.max(chainConcentration[chain] || 0, count);
      }
    }

    const report = intelligenceContext?.report || {};
    const inferredMarketRegime = report?.macroSentiment === 'bullish'
      ? 'uptrend'
      : report?.macroSentiment === 'bearish'
        ? 'downtrend'
        : 'ranging';

    return {
      botProfile: String(process.env.BOT_PROFILE || (config.paperTrading ? 'paper' : 'live')).toLowerCase(),
      strategyVersionId,
      strategyVersionHash,
      stats: { ...(portfolio.stats || {}) },
      health: getHealthStatus(),
      chainPerformance: getChainPerformanceSnapshot(),
      signalQuality: getSignalQualitySnapshot(),
      fillQuality: getFillQualitySnapshot(),
      openPositions: Object.keys(portfolio.positions || {}).length,
      learning: portfolio.learning || {},
      recentTrades: (portfolio.trades || []).slice(0, 80),
      latestFilterCycles: [
        ...(filterStatsState.recentCycles?.momentum || []).slice(0, 3),
        ...(filterStatsState.recentCycles?.swing || []).slice(0, 3),
      ],
      intelligence: intelligenceContext,
      marketRegime: inferredMarketRegime,
      regimeFamily: classifyRegimeFamily(inferredMarketRegime),
      memory: memoryContext,
      operationalDiagnostics: {
        slotBlockedCount: operationalDiagnostics.slotBlockedCount,
        nativePriceAbortCount: operationalDiagnostics.nativePriceAbortCount,
        dailyLossBlockCount: operationalDiagnostics.dailyLossBlockCount,
        chainConcentration,
        maxConcurrentPositions: config.risk.maxConcurrentPositions,
        maxDailyLossPctByChain: config.risk?.maxDailyLossPctByChain || {},
        currentEnvPath: '.env',
        uptimeMs: Date.now() - operationalDiagnostics.resetAt,
      },
    };
  }

  function inferPlanStrategy(plan = {}) {
    if (plan.strategy || plan.strategyId) return String(plan.strategy || plan.strategyId);
    const text = JSON.stringify(plan.changes || []).toLowerCase();
    if (text.includes('bull_flag')) return 'spot_day_bull_flag';
    if (text.includes('backes')) return 'backes';
    if (text.includes('momentum')) return 'momentum';
    if (text.includes('solana')) return 'solana_bull_flag_v2';
    return 'multi_strategy';
  }

  function buildMutationProposalRecord({ plan, context, proposalPath, status = 'proposed', stage = 'proposal', evidenceRefs = [] } = {}) {
    if (!plan || !Array.isArray(plan.changes) || plan.changes.length === 0) return null;
    try {
      return normalizeMutationProposal({
        botProfile: context?.botProfile || (config.paperTrading ? 'paper_spot' : 'live_spot'),
        targetProfile: config.paperTrading ? 'live_spot' : null,
        strategy: inferPlanStrategy(plan),
        strategyVersion: strategyVersionId,
        proposalType: 'self_evolution_patch',
        proposer: plan._source || 'self_evolution',
        patch: { changes: plan.changes },
        rationale: {
          summary: plan.summary || null,
          reason: plan.reason || null,
          proposalPath: proposalPath || null,
        },
        expectedImpact: {
          baselineStats: context?.stats || null,
          signalQuality: context?.signalQuality || null,
          fillQuality: context?.fillQuality || null,
        },
        riskNotes: {
          paperTrading: Boolean(config.paperTrading),
          autoApply: Boolean(config.selfEvolution?.autoApply),
          autoPromote: Boolean(config.selfEvolution?.autoPromote),
          allowLiveApply: Boolean(config.selfEvolution?.allowLiveApply),
        },
        evidenceRefs,
        status,
        stage,
      });
    } catch (error) {
      logger.warn(`[Self-evolution] mutation proposal normalization failed: ${error.message}`);
      return null;
    }
  }

  function logMutationProposal({ plan, context, proposalPath, status, stage, evidenceRefs }) {
    const proposal = buildMutationProposalRecord({ plan, context, proposalPath, status, stage, evidenceRefs });
    if (proposal) telemetry?.logMutationProposal?.(proposal);
    return proposal;
  }

  async function getPaperLiveComparisonSnapshot() {
    if (!config.paperTrading) return null;
    try {
      const pool = await getPool(logger);
      if (!pool) return null;
      await ensureSchema(logger);
      const profileFilter = "('paper_spot','paper','live_spot','live')";
      const isPaperProfile = (profile) => ['paper_spot', 'paper'].includes(String(profile || '').toLowerCase());
      const isLiveProfile = (profile) => ['live_spot', 'live'].includes(String(profile || '').toLowerCase());
      const pickProfile = (rows, predicate, preferredProfile) => (
        rows.find((row) => String(row.bot_profile || '').toLowerCase() === preferredProfile)
        || rows.find((row) => predicate(row.bot_profile))
      );
      const profileRes = await pool.request().query(`SELECT bot_profile, win_rate_pct, realized_pnl_usd, trade_count FROM dbo.vw_profile_summary WHERE bot_profile IN ${profileFilter}`);
      const qualityRes = await pool.request().query(`SELECT bot_profile, approved_count, total_decisions FROM dbo.vw_decision_quality_summary WHERE bot_profile IN ${profileFilter}`);
      const executionRes = await pool.request().query(`
SELECT
  bot_profile,
  AVG(CASE WHEN status IN ('filled','confirmed') THEN 1.0 ELSE 0.0 END) * 100 AS fill_rate_pct,
  AVG(CASE WHEN status IN ('failed','precheck_failed','needs_reconciliation') THEN 1.0 ELSE 0.0 END) * 100 AS failure_rate_pct,
  AVG(CASE WHEN status = 'precheck_failed' THEN 1.0 ELSE 0.0 END) * 100 AS precheck_failure_rate_pct
FROM dbo.orders
WHERE bot_profile IN ${profileFilter}
GROUP BY bot_profile
`);
      const fillsRes = await pool.request().query(`
SELECT
  o.bot_profile,
  AVG(CAST(f.slippage_bps AS FLOAT)) AS avg_slippage_bps,
  AVG(CAST(f.confirmations AS FLOAT)) AS avg_confirmations
FROM dbo.fills f
JOIN dbo.orders o ON o.order_id = f.order_id
WHERE o.bot_profile IN ${profileFilter}
GROUP BY o.bot_profile
`);
      const rows = profileRes.recordset || [];
      const qualityRows = qualityRes.recordset || [];
      const executionRows = executionRes.recordset || [];
      const fillRows = fillsRes.recordset || [];
      const paper = pickProfile(rows, isPaperProfile, 'paper_spot');
      const live = pickProfile(rows, isLiveProfile, 'live_spot');
      const paperQ = pickProfile(qualityRows, isPaperProfile, 'paper_spot');
      const liveQ = pickProfile(qualityRows, isLiveProfile, 'live_spot');
      const paperExec = pickProfile(executionRows, isPaperProfile, 'paper_spot');
      const liveExec = pickProfile(executionRows, isLiveProfile, 'live_spot');
      const paperFill = pickProfile(fillRows, isPaperProfile, 'paper_spot');
      const liveFill = pickProfile(fillRows, isLiveProfile, 'live_spot');
      const paperApproval = Number(paperQ?.total_decisions || 0) > 0 ? (Number(paperQ?.approved_count || 0) / Number(paperQ.total_decisions)) * 100 : 0;
      const liveApproval = Number(liveQ?.total_decisions || 0) > 0 ? (Number(liveQ?.approved_count || 0) / Number(liveQ.total_decisions)) * 100 : 0;
      return {
        winRateDeltaPct: Number(paper?.win_rate_pct || 0) - Number(live?.win_rate_pct || 0),
        profitFactorDelta: Number(portfolio.stats?.profitFactor || 0) - Number(marketState?.evolution?.liveBaselineProfitFactor || 0),
        falsePositiveDeltaPct: Number((portfolio.signalQuality?.falsePositiveRatePct) || 0) - Number(marketState?.evolution?.liveBaselineFalsePositiveRatePct || 0),
        fillSlippageDeltaPct: (Number(paperFill?.avg_slippage_bps || 0) - Number(liveFill?.avg_slippage_bps || 0)) / 100,
        fillDiscrepancyDeltaPct: Number((portfolio.fillQuality?.avgFillDiscrepancyPct) || 0) - Number(marketState?.evolution?.liveBaselineFillDiscrepancyPct || 0),
        approvalRateDeltaPct: paperApproval - liveApproval,
        fillRateDeltaPct: Number(paperExec?.fill_rate_pct || 0) - Number(liveExec?.fill_rate_pct || 0),
        failureRateDeltaPct: Number(paperExec?.failure_rate_pct || 0) - Number(liveExec?.failure_rate_pct || 0),
        precheckFailureRateDeltaPct: Number(paperExec?.precheck_failure_rate_pct || 0) - Number(liveExec?.precheck_failure_rate_pct || 0),
        avgSlippageBpsDelta: Number(paperFill?.avg_slippage_bps || 0) - Number(liveFill?.avg_slippage_bps || 0),
        avgConfirmationsDelta: Number(paperFill?.avg_confirmations || 0) - Number(liveFill?.avg_confirmations || 0),
        paperTradeCount: Number(paper?.trade_count || 0),
        liveTradeCount: Number(live?.trade_count || 0),
      };
    } catch (error) {
      logger.warn(`Paper/live comparison snapshot unavailable: ${error.message}`);
      return null;
    }
  }

  async function hasManualApproval(versionId) {
    if (!versionId) return false;
    try {
      const pool = await getPool(logger);
      if (!pool) return false;
      await ensureSchema(logger);
      const req = pool.request();
      req.input('version_id', sql.NVarChar(80), String(versionId).slice(0, 80));
      const res = await req.query(`
SELECT TOP 1 status
FROM dbo.promotion_events
WHERE version_id = @version_id AND event_type = 'manual_approval'
ORDER BY ts DESC
`);
      return String(res.recordset?.[0]?.status || '').toLowerCase() === 'approved';
    } catch {
      return false;
    }
  }

  async function evaluateActiveEvolutionExperiment() {
    const experiment = marketState.evolution?.activeExperiment;
    if (!experiment?.manifestPath || experiment.status === 'promoted' || experiment.status === 'rolled_back') return;

    try {
      const raw = await fs.readFile(experiment.manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      const context = getSelfEvolutionContext();
      context.paperLiveComparison = await getPaperLiveComparisonSnapshot();
      const evaluation = evolutionGovernor.evaluateManifest(manifest, context);
      telemetry?.logPromotionGateEvaluation?.({
        botProfile: context.botProfile,
        targetProfile: evaluation.evidenceGate?.targetProfile || manifest.promotion?.targetProfile || 'live_spot',
        strategy: evaluation.evidenceGate?.strategy || manifest.strategy || 'multi_strategy',
        strategyVersion: manifest?.versioning?.versionId || strategyVersionId,
        strategyClass: evaluation.evidenceGate?.strategyClass || manifest.strategyClass || 'generic',
        ts: evaluation.evidenceGate?.evaluatedAt || evaluation.current.evaluatedAt,
        passed: Boolean(evaluation.evidenceGate?.passed),
        score: evaluation.evidenceGate?.score,
        reasons: evaluation.evidenceGate?.reasons || [],
        metrics: evaluation.evidenceGate?.metrics || {},
        thresholds: evaluation.evidenceGate?.thresholds || {},
        raw: {
          manifestId: manifest.id || null,
          decision: evaluation.decision,
          reasons: evaluation.reasons || [],
          discrepancy: evaluation.discrepancy || null,
          metrics: evaluation.metrics || null,
        },
      });
      const updated = await evolutionGovernor.updateCandidate(experiment.manifestPath, (draft) => ({
        ...draft,
        observation: {
          ...(draft.observation || {}),
          lastEvaluatedAt: evaluation.current.evaluatedAt,
          current: evaluation.metrics,
          decision: evaluation.decision,
          notes: evaluation.reasons,
        },
        discrepancy: evaluation.discrepancy,
        rollout: {
          ...(draft.rollout || {}),
          stage: evaluation.decision === 'shadow' ? 'shadow_candidate' : (evaluation.decision === 'promote' ? 'canary_candidate' : (evaluation.decision === 'await_manual_approval' ? 'await_manual_approval' : (draft.rollout?.stage || 'paper_candidate'))),
          manualApprovalRequired: Boolean(evaluation.impact?.highImpact && config.selfEvolution?.governance?.requireManualApprovalForHighImpact !== false),
          regimeFamily: classifyRegimeFamily(context.marketRegime || 'unknown'),
        },
        promotion: {
          ...(draft.promotion || {}),
          eligible: evaluation.decision === 'promote',
          v2GateRequired: Boolean(config.selfEvolution?.governance?.requireV2EvidenceGate),
          v2Gate: evaluation.evidenceGate || null,
        },
        rollback: {
          ...(draft.rollback || {}),
          required: evaluation.decision === 'rollback',
          reason: evaluation.decision === 'rollback' ? evaluation.reasons.join(', ') : null,
        },
      }));

      experiment.lastEvaluation = evaluation;
      experiment.lastEvaluatedAt = evaluation.current.evaluatedAt;
      telemetry?.logPromotionEvent?.({
        version_id: manifest?.versioning?.versionId || strategyVersionId,
        bot_profile: context.botProfile,
        event_type: 'evaluation',
        stage: updated.rollout?.stage || 'paper_candidate',
        status: evaluation.decision,
        discrepancy_score: evaluation.discrepancy?.score,
        promotion_confidence: evaluation.metrics?.promotionConfidence,
        approval_required: Boolean(updated.rollout?.manualApprovalRequired),
        notes: evaluation.reasons.join(', '),
        context: evaluation.metrics,
      });

      if (evaluation.decision === 'rollback') {
        logger.error(`[Self-evolution] Rolling back paper experiment ${manifest.id}: ${evaluation.reasons.join(', ')}`);
        const rollbackResult = await selfEvolution.rollbackPlan(updated.backupRoot, experiment.touchedEntries || []);
        marketState.evolution.lastRollback = {
          id: manifest.id,
          at: new Date().toISOString(),
          reason: evaluation.reasons.join(', '),
          ok: rollbackResult.ok,
        };
        experiment.status = 'rolled_back';
        marketState.evolution.history.unshift({
          id: manifest.id,
          status: 'rolled_back',
          at: new Date().toISOString(),
          reason: evaluation.reasons.join(', '),
        });
        marketState.evolution.activeExperiment = null;
        await saveState().catch(() => {});
        if (rollbackResult.ok && config.selfEvolution?.autoRestart !== false) {
          await shutdownAndExit(0, 'Self-evolution rollback restart');
        }
        return;
      }

      if (evaluation.decision === 'await_manual_approval') {
        experiment.status = 'await_manual_approval';
        await saveState().catch(() => {});
        return;
      }

      if (evaluation.decision === 'shadow') {
        experiment.status = 'shadow_candidate';
        marketState.evolution.shadowCandidate = {
          id: manifest.id,
          versionId: manifest?.versioning?.versionId || strategyVersionId,
          stage: 'shadow_candidate',
          regimeFamily: classifyRegimeFamily(context.marketRegime || 'unknown'),
          canaryLiveSizePct: Number(updated.rollout?.canaryLiveSizePct || config.selfEvolution?.governance?.canaryLiveSizePct || 10),
          discrepancyScore: evaluation.discrepancy?.score ?? null,
          promotionConfidence: evaluation.metrics?.promotionConfidence ?? null,
          updatedAt: new Date().toISOString(),
        };
        await saveState().catch(() => {});
        return;
      }

      if (evaluation.decision === 'promote' && config.paperTrading && config.selfEvolution?.autoPromote === true) {
        const versionId = manifest?.versioning?.versionId || strategyVersionId;
        if (updated.rollout?.manualApprovalRequired && !(await hasManualApproval(versionId))) {
          logger.warn(`[Self-evolution] Manual approval required before promoting ${manifest.id}`);
          experiment.status = 'await_manual_approval';
          await saveState().catch(() => {});
          return;
        }
        const cooldownMinutes = Number(config.selfEvolution?.governance?.promotionCooldownMinutes || 0);
        const lastPromotionAt = marketState.evolution?.lastPromotion?.at ? new Date(marketState.evolution.lastPromotion.at).getTime() : 0;
        if (cooldownMinutes > 0 && lastPromotionAt > 0 && ((Date.now() - lastPromotionAt) / 60000) < cooldownMinutes) {
          logger.warn(`[Self-evolution] Promotion cooldown active (${cooldownMinutes}m); delaying ${manifest.id}`);
          experiment.status = 'cooldown_wait';
          await saveState().catch(() => {});
          return;
        }
        logger.warn(`[Self-evolution] Promoting paper experiment ${manifest.id} after observation gate passed`);
        const promoteResult = await selfEvolution.promoteToMain(experiment.manifestPath);
        telemetry?.logPromotionEvent?.({
          version_id: versionId,
          bot_profile: context.botProfile,
          event_type: 'promotion_attempt',
          stage: 'canary_candidate',
          status: promoteResult.ok ? 'promoted' : 'promotion_failed',
          discrepancy_score: evaluation.discrepancy?.score,
          promotion_confidence: evaluation.metrics?.promotionConfidence,
          approval_required: Boolean(updated.rollout?.manualApprovalRequired),
          notes: promoteResult.reason || evaluation.reasons.join(', '),
          context: {
            canaryLiveSizePct: config.selfEvolution?.governance?.canaryLiveSizePct || 10,
            changedFiles: manifest.changedFiles || [],
          },
        });
        marketState.evolution.lastPromotion = {
          id: manifest.id,
          at: new Date().toISOString(),
          ok: Boolean(promoteResult.ok),
          reason: promoteResult.reason || null,
        };
        experiment.status = promoteResult.ok ? 'promoted' : 'promotion_failed';
        marketState.evolution.history.unshift({
          id: manifest.id,
          status: experiment.status,
          at: new Date().toISOString(),
          reason: promoteResult.reason || evaluation.reasons.join(', '),
        });
        if (promoteResult.ok) {
          marketState.evolution.activeExperiment = null;
          marketState.evolution.liveRollout = {
            id: manifest.id,
            versionId,
            stage: 'canary_live',
            regimeFamily: classifyRegimeFamily(context.marketRegime || 'unknown'),
            canaryLiveSizePct: Number(updated.rollout?.canaryLiveSizePct || config.selfEvolution?.governance?.canaryLiveSizePct || 10),
            promotedAt: new Date().toISOString(),
          };
        }
        await saveState().catch(() => {});
      }
    } catch (error) {
      logger.error(`Evolution governance evaluation failed: ${error.message}`);
    }
  }

  async function evaluateLivePromotionHealth() {
    if (config.paperTrading) return;
    try {
      const raw = await fs.readFile(LIVE_ROLLOUT_PATH, 'utf8');
      const rollout = JSON.parse(raw);
      marketState.evolution.liveRollout = {
        id: rollout.id || null,
        promotedAt: rollout.promotedAt || null,
        backupRoot: rollout.backupRoot || null,
        rollback: rollout.rollback || null,
      };
      if (rollout.rollback?.executedAt) return;
      const settings = evolutionGovernor.getSettings();
      const promotedAtMs = new Date(rollout.promotedAt || 0).getTime();
      if (!Number.isFinite(promotedAtMs) || promotedAtMs <= 0) return;
      const ageMinutes = (Date.now() - promotedAtMs) / 60000;
      if (ageMinutes < settings.liveRollbackObservationMinutes) return;

      const context = getSelfEvolutionContext();
      const baseline = rollout.baseline || {};
      const current = evolutionGovernor.buildCurrentSnapshot(context);
      const profitFactorDelta = Number(current.profitFactor || 0) - Number(baseline.profitFactor || 0);
      const winRateDeltaPct = Number(current.winRatePct || 0) - Number(baseline.winRatePct || 0);
      const falsePositiveDeltaPct = Number(current.falsePositiveRatePct || 0) - Number(baseline.falsePositiveRatePct || 0);
      const fillSlippageDeltaPct = Number(current.fillSlippagePct || 0) - Number(baseline.fillSlippagePct || 0);
      const shouldRollback = current.unhealthyReasons.length > 0
        || profitFactorDelta <= -Math.abs(settings.rollbackMaxProfitFactorDrop)
        || winRateDeltaPct <= -Math.abs(settings.rollbackMaxWinRateDropPct)
        || falsePositiveDeltaPct >= Math.abs(settings.maxFalsePositiveRateDeltaPct)
        || fillSlippageDeltaPct >= Math.abs(settings.maxFillSlippageDeltaPct);
      if (!shouldRollback) {
        if (String(rollout.stage || '').toLowerCase() === 'canary_live') {
          rollout.stage = 'scaled_live';
          rollout.scaledAt = new Date().toISOString();
          await fs.writeFile(LIVE_ROLLOUT_PATH, `${JSON.stringify(rollout, null, 2)}\n`, 'utf8');
          marketState.evolution.liveRollout = {
            ...(marketState.evolution.liveRollout || {}),
            id: rollout.id || null,
            versionId: rollout.versionId || null,
            stage: 'scaled_live',
            regimeFamily: rollout.regimeFamily || null,
            canaryLiveSizePct: rollout.canaryLiveSizePct || null,
            promotedAt: rollout.promotedAt || null,
            scaledAt: rollout.scaledAt,
            backupRoot: rollout.backupRoot || null,
            rollback: rollout.rollback || null,
          };
          telemetry?.logPromotionEvent?.({
            version_id: rollout.versionId || strategyVersionId,
            bot_profile: 'live',
            event_type: 'promotion_stage_advance',
            stage: 'scaled_live',
            status: 'scaled',
            notes: 'Live rollout passed canary observation window and scaled automatically',
            context: {
              liveRollbackObservationMinutes: settings.liveRollbackObservationMinutes,
              profitFactorDelta,
              winRateDeltaPct,
              falsePositiveDeltaPct,
              fillSlippageDeltaPct,
            },
          });
        }
        return;
      }

      logger.error(`[Evolution] Live rollout ${rollout.id || 'unknown'} degraded; triggering rollback`);
      execFileSync(processExecPath, [rollbackScriptPath], {
        cwd: projectRoot,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          ROLLBACK_REASON: 'live_post_promotion_degradation',
        },
        timeout: 120000,
      });
    } catch (_) {
      // Ignore missing rollout metadata.
    }
  }

  async function runSelfEvolutionCycle() {
    if (loopLocks.selfEvolution) return;
    loopLocks.selfEvolution = true;
    try {
      await evaluateLivePromotionHealth();
      await evaluateActiveEvolutionExperiment();
      if (marketState.evolution?.activeExperiment && config.paperTrading) {
        logger.info('Self-evolution cycle skipped: paper experiment already under observation');
        return;
      }

      const context = getSelfEvolutionContext();
      context.paperLiveComparison = await getPaperLiveComparisonSnapshot();

      // Pre-apply baseline capture (Week 6+ delta validator, 2026-05-17 fix).
      // Without this, pre-existing broken tests in test/*.js (research-handlers,
      // agent-memory-ai-budget, etc.) make every patch falsely fail validation,
      // blocking all self-evolution. Delta mode only fails on NEW regressions
      // introduced by the patch.
      let baseline = null;
      if (config.paperTrading && config.selfEvolution?.autoApply === true) {
        try {
          const cap = await evolutionValidator.captureBaseline({ changedFiles: [] });
          baseline = cap.map;
          logger.info(`[Self-evolution] Baseline captured: ${cap.summary.passedChecks}/${cap.summary.totalChecks} passing pre-patch`);
        } catch (err) {
          logger.warn(`[Self-evolution] Baseline capture failed (falling back to strict validation): ${err.message}`);
        }
      }

      const result = await selfEvolution.runCycle(context);
      if (result?.skipped) logger.info(`Self-evolution cycle skipped: ${result.reason}`);
      else if (result?.proposed) logger.warn(`Self-evolution proposal generated: ${result.proposalPath}`);
      else if (result?.applied) logger.warn(`Self-evolution changes applied: ${result.proposalPath || 'n/a'}`);

      let mutationProposal = null;
      if (result?.proposalPath && result?.plan?.changes?.length) {
        mutationProposal = logMutationProposal({
          plan: result.plan,
          context,
          proposalPath: result.proposalPath,
          status: result.applied ? 'applied_paper' : (result.blocked ? 'blocked' : 'proposed'),
          stage: result.applied ? 'paper_candidate' : 'proposal',
          evidenceRefs: [
            { type: 'proposal_file', path: result.proposalPath },
            context.strategyVersionId ? { type: 'strategy_version', id: context.strategyVersionId } : null,
          ].filter(Boolean),
        });
      }

      if (result?.applied) {
        let validationReport = { ok: true, results: [], summary: { totalChecks: 0, failedChecks: 0 } };
        if (config.paperTrading) {
          validationReport = await evolutionValidator.validateCandidate({
            changedFiles: result.applyResult?.changedFiles || [],
            baseline,
          });
          if (!validationReport.ok) {
            const m = validationReport.summary;
            logger.error(`[Self-evolution] Validation failed after apply; rolling back candidate. NEW failures=${m.newFailures ?? validationReport.failed.length} (pre-existing=${m.preexistingFailures ?? 0}, mode=${m.mode || 'strict'})`);
            const rollbackResult = await selfEvolution.rollbackPlan(result.applyResult?.backupRoot, result.applyResult?.touched || []);
            marketState.evolution.lastRollback = {
              id: null,
              at: new Date().toISOString(),
              reason: 'validation_failed',
              ok: rollbackResult.ok,
            };
            await saveState().catch(() => {});
            if (rollbackResult.ok && config.selfEvolution?.autoRestart !== false) {
              await shutdownAndExit(0, 'Self-evolution validation rollback restart');
            }
            return;
          }
        }
        if (config.paperTrading) {
          const labProposal = await strategyLab.createProposal({
            summary: result.plan?.summary || 'Self-evolution candidate',
            hypothesis: result.plan?.reason || '',
            parameters: {
              changedFiles: result.applyResult?.changedFiles || [],
              changedEnvKeys: result.applyResult?.changedEnvKeys || [],
            },
            baselineMetrics: {
              stats: context.stats,
              signalQuality: context.signalQuality,
              fillQuality: context.fillQuality,
            },
            source: result.plan?._source || 'self_evolution',
          });
          await strategyLab.recordValidationResult(labProposal.id, validationReport);
          const candidate = await evolutionGovernor.createCandidate({
            proposalPath: result.proposalPath,
            plan: result.plan,
            applyResult: result.applyResult || {},
            context,
          });
          telemetry?.logStrategyVersion?.({
            version_id: candidate.manifest.versioning?.versionId || strategyVersionId,
            version_hash: candidate.manifest.versioning?.strategyVersionHash || strategyVersionHash,
            bot_profile: context.botProfile,
            source_profile: context.botProfile,
            stage: candidate.manifest.rollout?.stage || 'paper_candidate',
            candidate_id: candidate.manifest.id,
            config_hash: strategyVersionHash,
            code_hash: strategyVersionHash,
            metadata: {
              changedFiles: candidate.manifest.changedFiles || [],
              changedEnvKeys: candidate.manifest.changedEnvKeys || [],
              discrepancy: candidate.manifest.discrepancy || null,
              impact: classifyPromotionImpact(candidate.manifest.changedFiles || []),
            },
          });
          telemetry?.logPromotionEvent?.({
            version_id: candidate.manifest.versioning?.versionId || strategyVersionId,
            bot_profile: context.botProfile,
            event_type: 'candidate_created',
            stage: candidate.manifest.rollout?.stage || 'paper_candidate',
            status: 'observing',
            discrepancy_score: candidate.manifest.discrepancy?.score,
            promotion_confidence: null,
            approval_required: Boolean(candidate.manifest.rollout?.manualApprovalRequired),
            notes: candidate.manifest.summary,
            context: {
              candidateId: candidate.manifest.id,
              mutationProposalId: mutationProposal?.proposalId || null,
              changedFiles: candidate.manifest.changedFiles || [],
            },
          });
          await evolutionGovernor.updateCandidate(candidate.manifestPath, (draft) => ({
            ...draft,
            validation: {
              required: true,
              passed: Boolean(validationReport.ok),
              summary: validationReport.summary,
              results: validationReport.results,
            },
            strategyLab: {
              proposalId: labProposal.id,
              proposalPath: labProposal.filePath,
            },
          }));
          marketState.evolution.activeExperiment = {
            id: candidate.manifest.id,
            manifestPath: candidate.manifestPath,
            status: 'observing',
            startedAt: candidate.manifest.createdAt,
            changedFiles: candidate.manifest.changedFiles,
            touchedEntries: Array.isArray(result.applyResult?.touched) ? result.applyResult.touched : [],
          };
          marketState.evolution.history.unshift({
            id: candidate.manifest.id,
            status: 'applied_paper',
            at: candidate.manifest.createdAt,
            reason: candidate.manifest.summary,
          });
        }
        await saveState().catch((error) => logger.error(`Failed saving state after self-evolution apply: ${error.message}`));

        if (config.selfEvolution?.autoRestart !== false) {
          logger.warn('Self-evolution applied changes; restarting process to load new code/config');
          await shutdownAndExit(0, 'Self-evolution restart');
        }
      }
    } catch (error) {
      logger.error(`Self-evolution loop error: ${error.message}`);
    } finally {
      loopLocks.selfEvolution = false;
    }
  }

  return {
    getSelfEvolutionContext,
    evaluateActiveEvolutionExperiment,
    evaluateLivePromotionHealth,
    runSelfEvolutionCycle,
  };
}

module.exports = { createSelfEvolutionOrchestration };
