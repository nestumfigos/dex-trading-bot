'use strict';

const fs = require('fs').promises;
const path = require('path');
const {
  computeDiscrepancyScore,
  classifyPromotionImpact,
  classifyRegimeFamily,
  evaluatePromotionEvidenceGate,
} = require('./utils/promotion-governance');

class EvolutionGovernor {
  constructor({ config, logger, projectRoot, dataDir = 'data' }) {
    this.config = config;
    this.logger = logger || console;
    this.projectRoot = projectRoot;
    this.dataDir = dataDir;
    this.candidatesDir = path.join(projectRoot, dataDir, 'evolution-candidates');
  }

  getSettings() {
    const raw = this.config?.selfEvolution?.governance || {};
    return {
      minObservationMinutes: Math.max(5, Number(raw.minObservationMinutes || 45)),
      minClosedTrades: Math.max(1, Number(raw.minClosedTrades || 3)),
      minShadowClosedTrades: Math.max(1, Number(raw.minShadowClosedTrades || 5)),
      promoteMinProfitFactorDelta: Number(raw.promoteMinProfitFactorDelta || 0),
      promoteMinWinRateDeltaPct: Number(raw.promoteMinWinRateDeltaPct || 0),
      maxDrawdownDeltaPct: Number(raw.maxDrawdownDeltaPct || 3),
      rollbackMaxProfitFactorDrop: Number(raw.rollbackMaxProfitFactorDrop || 0.2),
      rollbackMaxWinRateDropPct: Number(raw.rollbackMaxWinRateDropPct || 8),
      rollbackOnUnhealthy: raw.rollbackOnUnhealthy !== false,
      maxPromotionFiles: Math.max(1, Number(raw.maxPromotionFiles || 6)),
      promotionCooldownMinutes: Math.max(0, Number(raw.promotionCooldownMinutes || 120)),
      liveRollbackObservationMinutes: Math.max(5, Number(raw.liveRollbackObservationMinutes || 90)),
      maxFalsePositiveRateDeltaPct: Number(raw.maxFalsePositiveRateDeltaPct || 6),
      maxFillSlippageDeltaPct: Number(raw.maxFillSlippageDeltaPct || 0.75),
      maxFillDiscrepancyDeltaPct: Number(raw.maxFillDiscrepancyDeltaPct || 2),
      maxPaperLiveDiscrepancyScore: Math.max(0, Number(raw.maxPaperLiveDiscrepancyScore || 35)),
      minPromotionConfidence: Math.max(0, Number(raw.minPromotionConfidence || 60)),
      requireManualApprovalForHighImpact: raw.requireManualApprovalForHighImpact !== false,
      shadowModeRequired: raw.shadowModeRequired !== false,
      canaryLiveSizePct: Math.max(1, Number(raw.canaryLiveSizePct || 10)),
      requireV2EvidenceGate: raw.requireV2EvidenceGate === true,
      promotionGateThresholds: raw.promotionGateThresholds && typeof raw.promotionGateThresholds === 'object'
        ? raw.promotionGateThresholds
        : {},
    };
  }

  async ensureDirs() {
    await fs.mkdir(this.candidatesDir, { recursive: true });
  }

  buildBaseline(context = {}) {
    const stats = context.stats || {};
    const chainPerformance = context.chainPerformance || {};
    const fillQuality = context.fillQuality || {};
    return {
      capturedAt: new Date().toISOString(),
      closedTrades: Number(stats.closedTrades || 0),
      wins: Number(stats.wins || 0),
      losses: Number(stats.losses || 0),
      profitFactor: Number(stats.profitFactor || 0),
      winRatePct: Number(stats.closedTrades || 0) > 0
        ? ((Number(stats.wins || 0) / Number(stats.closedTrades || 0)) * 100)
        : 0,
      realizedPnlUsd: Number(stats.totalRealizedPnlUsd || stats.realizedPnlUsd || 0),
      maxDrawdownPct: Number(stats.maxDrawdownPct || stats.drawdownPct || 0),
      falsePositiveRatePct: Number(context.signalQuality?.falsePositiveRatePct || 0),
      fillSlippagePct: Number(fillQuality.avgSlippagePct || 0),
      fillDiscrepancyPct: Number(fillQuality.avgFillDiscrepancyPct || 0),
      chainPerformance,
      unhealthyReasons: Array.isArray(context.health?.unhealthyReasons) ? context.health.unhealthyReasons : [],
      degradedReasons: Array.isArray(context.health?.degradedReasons) ? context.health.degradedReasons : [],
    };
  }

  async createCandidate({ proposalPath, plan, applyResult, context = {} }) {
    await this.ensureDirs();
    const ts = new Date().toISOString();
    const id = `evo-${Date.now()}`;
    const changedFiles = Array.isArray(applyResult?.changedFiles) ? applyResult.changedFiles : [];
    const manifest = {
      id,
      createdAt: ts,
      status: 'applied_paper',
      proposalPath: proposalPath || null,
      summary: String(plan?.summary || ''),
      reason: String(plan?.reason || ''),
      source: String(plan?._source || 'rule_based'),
      strategy: String(plan?.strategy || plan?.strategyId || 'multi_strategy'),
      strategyClass: String(plan?.strategyClass || 'generic'),
      changedFiles,
      changedEnvKeys: Array.isArray(applyResult?.changedEnvKeys) ? applyResult.changedEnvKeys : [],
      versioning: {
        versionId: String(context.strategyVersionId || id),
        strategyVersionHash: String(context.strategyVersionHash || '').slice(0, 80) || null,
        sourceProfile: String(context.botProfile || (this.config?.paperTrading ? 'paper' : 'live')),
      },
      backupRoot: applyResult?.backupRoot || null,
      baseline: this.buildBaseline(context),
      discrepancy: context.paperLiveComparison || null,
      regime: {
        observed: String(context.marketRegime || 'unknown'),
        target: String(context.marketRegime || 'unknown'),
      },
      validation: {
        required: true,
        passed: false,
        summary: null,
        results: [],
      },
      rollout: {
        stage: 'paper_candidate',
        manualApprovalRequired: false,
        manualApprovalGranted: false,
        shadowRequired: this.getSettings().shadowModeRequired,
        canaryLiveSizePct: this.getSettings().canaryLiveSizePct,
      },
      observation: {
        startedAt: ts,
        lastEvaluatedAt: null,
        current: null,
        decision: 'observe',
        notes: [],
      },
      promotion: {
        eligible: false,
        approved: false,
        v2GateRequired: this.getSettings().requireV2EvidenceGate === true,
        v2Gate: null,
        attemptedAt: null,
        completedAt: null,
        reason: null,
      },
      rollback: {
        required: false,
        executedAt: null,
        reason: null,
      },
    };
    const manifestPath = path.join(this.candidatesDir, `${id}.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, manifestPath };
  }

  async updateCandidate(manifestPath, updater) {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    const next = typeof updater === 'function' ? updater(manifest) || manifest : manifest;
    await fs.writeFile(manifestPath, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  buildCurrentSnapshot(context = {}) {
    const stats = context.stats || {};
    return {
      evaluatedAt: new Date().toISOString(),
      closedTrades: Number(stats.closedTrades || 0),
      wins: Number(stats.wins || 0),
      losses: Number(stats.losses || 0),
      profitFactor: Number(stats.profitFactor || 0),
      winRatePct: Number(stats.closedTrades || 0) > 0
        ? ((Number(stats.wins || 0) / Number(stats.closedTrades || 0)) * 100)
        : 0,
      realizedPnlUsd: Number(stats.totalRealizedPnlUsd || stats.realizedPnlUsd || 0),
      maxDrawdownPct: Number(stats.maxDrawdownPct || stats.drawdownPct || 0),
      falsePositiveRatePct: Number(context.signalQuality?.falsePositiveRatePct || 0),
      fillSlippagePct: Number(context.fillQuality?.avgSlippagePct || 0),
      fillDiscrepancyPct: Number(context.fillQuality?.avgFillDiscrepancyPct || 0),
      chainPerformance: context.chainPerformance || {},
      unhealthyReasons: Array.isArray(context.health?.unhealthyReasons) ? context.health.unhealthyReasons : [],
      degradedReasons: Array.isArray(context.health?.degradedReasons) ? context.health.degradedReasons : [],
    };
  }

  evaluateManifest(manifest, context = {}) {
    const settings = this.getSettings();
    const current = this.buildCurrentSnapshot(context);
    const baseline = manifest.baseline || {};
    const observedClosedTrades = Math.max(0, current.closedTrades - Number(baseline.closedTrades || 0));
    const observationMs = Date.now() - new Date(manifest.observation?.startedAt || manifest.createdAt || Date.now()).getTime();
    const observationMinutes = observationMs / 60000;
    const profitFactorDelta = Number(current.profitFactor || 0) - Number(baseline.profitFactor || 0);
    const winRateDeltaPct = Number(current.winRatePct || 0) - Number(baseline.winRatePct || 0);
    const drawdownDeltaPct = Number(current.maxDrawdownPct || 0) - Number(baseline.maxDrawdownPct || 0);
    const falsePositiveDeltaPct = Number(current.falsePositiveRatePct || 0) - Number(baseline.falsePositiveRatePct || 0);
    const fillSlippageDeltaPct = Number(current.fillSlippagePct || 0) - Number(baseline.fillSlippagePct || 0);
    const fillDiscrepancyDeltaPct = Number(current.fillDiscrepancyPct || 0) - Number(baseline.fillDiscrepancyPct || 0);
    const approvalRateDeltaPct = Number(context.paperLiveComparison?.approvalRateDeltaPct || 0);
    const discrepancy = computeDiscrepancyScore({
      profitFactorDelta,
      winRateDeltaPct,
      falsePositiveDeltaPct,
      fillSlippageDeltaPct,
      fillDiscrepancyDeltaPct,
      approvalRateDeltaPct,
    });
    const impact = classifyPromotionImpact(manifest.changedFiles || []);
    const targetRegimeFamily = classifyRegimeFamily(manifest?.regime?.target || context?.marketRegime || 'unknown');
    const currentRegimeFamily = classifyRegimeFamily(context?.marketRegime || manifest?.regime?.observed || 'unknown');
    const evidenceGate = evaluatePromotionEvidenceGate({
      manifest,
      context,
      strategyClass: manifest.strategyClass || context.strategyClass || 'generic',
      thresholds: settings.promotionGateThresholds,
    });
    const promotionConfidence = Math.max(
      0,
      Math.min(
        100,
        100
        - (discrepancy.score * 0.7)
        + Math.max(0, profitFactorDelta * 20)
        + Math.max(0, winRateDeltaPct * 0.5)
      ),
    );

    let decision = 'observe';
    const reasons = [];
    if (manifest.validation?.required === true && manifest.validation?.passed !== true) {
      return {
        decision: 'hold',
        current,
        metrics: {
          observationMinutes,
          observedClosedTrades,
          profitFactorDelta,
          winRateDeltaPct,
          drawdownDeltaPct,
          falsePositiveDeltaPct,
          fillSlippageDeltaPct,
          fillDiscrepancyDeltaPct,
        },
        reasons: ['validation_incomplete'],
      };
    }
    if (settings.rollbackOnUnhealthy && current.unhealthyReasons.length > 0) {
      decision = 'rollback';
      reasons.push(`unhealthy:${current.unhealthyReasons.join(',')}`);
    } else if (profitFactorDelta <= -Math.abs(settings.rollbackMaxProfitFactorDrop)) {
      decision = 'rollback';
      reasons.push(`profit_factor_drop:${profitFactorDelta.toFixed(3)}`);
    } else if (winRateDeltaPct <= -Math.abs(settings.rollbackMaxWinRateDropPct)) {
      decision = 'rollback';
      reasons.push(`win_rate_drop:${winRateDeltaPct.toFixed(2)}`);
    } else if (falsePositiveDeltaPct >= Math.abs(settings.maxFalsePositiveRateDeltaPct)) {
      decision = 'rollback';
      reasons.push(`false_positive_rise:${falsePositiveDeltaPct.toFixed(2)}`);
    } else if (fillSlippageDeltaPct >= Math.abs(settings.maxFillSlippageDeltaPct)) {
      decision = 'rollback';
      reasons.push(`slippage_rise:${fillSlippageDeltaPct.toFixed(3)}`);
    } else if (fillDiscrepancyDeltaPct >= Math.abs(settings.maxFillDiscrepancyDeltaPct)) {
      decision = 'rollback';
      reasons.push(`fill_discrepancy_rise:${fillDiscrepancyDeltaPct.toFixed(3)}`);
    } else if (targetRegimeFamily !== 'unknown' && currentRegimeFamily !== 'unknown' && targetRegimeFamily !== currentRegimeFamily) {
      decision = 'hold';
      reasons.push(`regime_mismatch:${targetRegimeFamily}->${currentRegimeFamily}`);
    } else if ((discrepancy.scoreRaw ?? discrepancy.score) > settings.maxPaperLiveDiscrepancyScore) {
      // B3.sl.11: use scoreRaw (unclamped) for threshold compare so a 150-pt
      // divergence isn't hidden behind the clamp-to-100. Fall back to clamped
      // for legacy callers that only populate `.score`.
      decision = 'hold';
      reasons.push(`paper_live_discrepancy:${(discrepancy.scoreRaw ?? discrepancy.score).toFixed(2)}`);
    } else if (settings.requireV2EvidenceGate && evidenceGate.passed !== true) {
      decision = 'hold';
      reasons.push(`v2_evidence_gate:${evidenceGate.reasons.join('|') || 'failed'}`);
    } else if (observationMinutes >= settings.minObservationMinutes && observedClosedTrades >= settings.minClosedTrades) {
      // B2.22: optional belt-and-suspenders floors independent of the
      // weighted `promotionConfidence` aggregate. Audit 05-self-learning.md
      // #4 raised concern that the aggregate can pass on a strong showing
      // in one dimension masking weakness elsewhere. These floors are
      // OPT-IN via settings — default permissive so existing promotion
      // flow is unchanged. Operators tighten by setting
      //   strictDiscrepancyFloor (e.g. 15) and
      //   strictProfitFactorDeltaFloor (e.g. 0.05).
      const strictDiscrepancyFloor = Number.isFinite(Number(settings.strictDiscrepancyFloor))
        ? Number(settings.strictDiscrepancyFloor)
        : Infinity;
      const strictPfFloor = Number.isFinite(Number(settings.strictProfitFactorDeltaFloor))
        ? Number(settings.strictProfitFactorDeltaFloor)
        : -Infinity;
      const passStrictDiscrepancy = discrepancy.score < strictDiscrepancyFloor;
      const passStrictPf = profitFactorDelta > strictPfFloor;
      const passPf = profitFactorDelta >= settings.promoteMinProfitFactorDelta;
      const passWr = winRateDeltaPct >= settings.promoteMinWinRateDeltaPct;
      const passDd = drawdownDeltaPct <= settings.maxDrawdownDeltaPct;
      const passConfidence = promotionConfidence >= settings.minPromotionConfidence;
      if (passPf && passWr && passDd && passConfidence && passStrictDiscrepancy && passStrictPf) {
        decision = 'promote';
        reasons.push('observation_passed');
        if (settings.shadowModeRequired && observedClosedTrades < settings.minShadowClosedTrades) {
          decision = 'shadow';
          reasons.push('shadow_stage_required');
        } else if (settings.requireManualApprovalForHighImpact && impact.highImpact) {
          decision = 'await_manual_approval';
          reasons.push('manual_approval_required');
        }
      } else {
        decision = 'hold';
        if (!passPf) reasons.push(`pf_below_gate:${profitFactorDelta.toFixed(3)}`);
        if (!passWr) reasons.push(`wr_below_gate:${winRateDeltaPct.toFixed(2)}`);
        if (!passDd) reasons.push(`drawdown_above_gate:${drawdownDeltaPct.toFixed(2)}`);
        if (!passConfidence) reasons.push(`confidence_below_gate:${promotionConfidence.toFixed(2)}`);
      }
    }

    return {
      decision,
      current,
      metrics: {
        observationMinutes,
        observedClosedTrades,
        profitFactorDelta,
        winRateDeltaPct,
        drawdownDeltaPct,
        falsePositiveDeltaPct,
        fillSlippageDeltaPct,
        fillDiscrepancyDeltaPct,
        approvalRateDeltaPct,
        discrepancyScore: discrepancy.score,
        promotionConfidence,
        targetRegimeFamily,
        currentRegimeFamily,
      },
      impact,
      discrepancy,
      evidenceGate,
      reasons,
    };
  }
}

module.exports = EvolutionGovernor;
