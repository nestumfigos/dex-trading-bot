'use strict';

const crypto = require('crypto');
const { evaluatePromotionGate } = require('../../packages/core');

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function computeStrategyVersionHash({ config = {}, strategies = {}, risk = {} } = {}) {
  return hashValue({
    strategy: config.strategy || {},
    strategies,
    risk,
  }).slice(0, 40);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function computeDiscrepancyScore(comparison = {}) {
  const profitFactorDelta = Math.abs(safeNumber(comparison.profitFactorDelta));
  const winRateDeltaPct = Math.abs(safeNumber(comparison.winRateDeltaPct));
  const falsePositiveDeltaPct = Math.abs(safeNumber(comparison.falsePositiveDeltaPct));
  const fillSlippageDeltaPct = Math.abs(safeNumber(comparison.fillSlippageDeltaPct));
  const fillDiscrepancyDeltaPct = Math.abs(safeNumber(comparison.fillDiscrepancyDeltaPct));
  const approvalRateDeltaPct = Math.abs(safeNumber(comparison.approvalRateDeltaPct));
  const fillRateDeltaPct = Math.abs(safeNumber(comparison.fillRateDeltaPct));
  const failureRateDeltaPct = Math.abs(safeNumber(comparison.failureRateDeltaPct));
  const precheckFailureRateDeltaPct = Math.abs(safeNumber(comparison.precheckFailureRateDeltaPct));
  const avgSlippageBpsDelta = Math.abs(safeNumber(comparison.avgSlippageBpsDelta));
  const avgConfirmationsDelta = Math.abs(safeNumber(comparison.avgConfirmationsDelta));

  const weighted = (
    clamp((profitFactorDelta / 1.0) * 18)
    + clamp((winRateDeltaPct / 20) * 14)
    + clamp((falsePositiveDeltaPct / 10) * 10)
    + clamp((fillSlippageDeltaPct / 2.5) * 10)
    + clamp((fillDiscrepancyDeltaPct / 5) * 10)
    + clamp((approvalRateDeltaPct / 25) * 8)
    + clamp((fillRateDeltaPct / 20) * 10)
    + clamp((failureRateDeltaPct / 20) * 8)
    + clamp((precheckFailureRateDeltaPct / 20) * 4)
    + clamp((avgSlippageBpsDelta / 100) * 5)
    + clamp((avgConfirmationsDelta / 5) * 3)
  );

  // B3.sl.11: expose BOTH the clamped score (for display) and the raw
  // unclamped score. Phase A audit 05-self-learning.md #11 flagged that the
  // clamp-to-100 hides huge divergences from threshold comparisons. Threshold
  // checks (e.g. `maxPaperLiveDiscrepancyScore`) should test against
  // `scoreRaw`; UI/display still use `score`.
  return {
    score: clamp(Number(weighted.toFixed(2))),
    scoreRaw: Number(weighted.toFixed(2)),
    components: {
      profitFactorDelta,
      winRateDeltaPct,
      falsePositiveDeltaPct,
      fillSlippageDeltaPct,
      fillDiscrepancyDeltaPct,
      approvalRateDeltaPct,
      fillRateDeltaPct,
      failureRateDeltaPct,
      precheckFailureRateDeltaPct,
      avgSlippageBpsDelta,
      avgConfirmationsDelta,
    },
  };
}

function classifyPromotionImpact(changedFiles = []) {
  const normalized = (Array.isArray(changedFiles) ? changedFiles : []).map((item) => String(item || '').replace(/\\/g, '/'));
  const touchesExecution = normalized.some((file) => file.includes('execution') || file === 'src/index.js');
  const touchesRisk = normalized.some((file) => file.includes('/risk/') || file === 'config/index.js');
  const touchesResearchOnly = normalized.length > 0 && normalized.every((file) => file.includes('research') || file.includes('dashboard'));
  const fileCount = normalized.length;

  const highImpact = touchesExecution || fileCount >= 3 || (touchesRisk && fileCount >= 2);
  const impact = highImpact ? 'high' : (touchesResearchOnly ? 'low' : 'medium');
  return {
    impact,
    highImpact,
    fileCount,
    changedFiles: normalized,
  };
}

function validateGeneratedBehaviorApplication(plan = {}) {
  const changes = Array.isArray(plan.changes) ? plan.changes : [];
  if (!changes.length) return { allow: true, reason: 'no_changes' };
  const nonRelaxableEnvKeys = new Set([
    'MAX_DAILY_LOSS_PCT_BY_CHAIN',
    'MAX_CONCURRENT_POSITIONS',
    'MOMENTUM_MAX_CONCURRENT_POSITIONS',
    'SWING_MAX_CONCURRENT_POSITIONS',
  ]);
  const loosensCapitalProtection = changes.some((change) => (
    change?.type === 'env_set'
    && nonRelaxableEnvKeys.has(String(change.key || '').toUpperCase())
  ));
  if (loosensCapitalProtection) {
    return { allow: false, reason: 'capital_protections_cannot_be_relaxed_by_generated_behavior' };
  }
  if (plan.validation?.preApplyPassed !== true) {
    return { allow: false, reason: 'pre_apply_validation_required' };
  }
  if (plan.approval?.approved !== true) {
    return { allow: false, reason: 'explicit_approval_required' };
  }
  return { allow: true, reason: 'validated_and_approved' };
}

function validatePromotionCandidate(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { allow: false, reason: 'candidate_manifest_required' };
  }
  if (Array.isArray(manifest.changedEnvKeys) && manifest.changedEnvKeys.length > 0) {
    return { allow: false, reason: 'environment_changes_are_not_promotable' };
  }
  if (manifest.validation?.passed !== true) {
    return { allow: false, reason: 'candidate_validation_required' };
  }
  if (manifest.promotion?.eligible !== true) {
    return { allow: false, reason: 'candidate_not_eligible' };
  }
  if (manifest.promotion?.approved !== true) {
    return { allow: false, reason: 'promotion_approval_required' };
  }
  if (manifest.rollout?.manualApprovalRequired === true && manifest.rollout?.manualApprovalGranted !== true) {
    return { allow: false, reason: 'manual_approval_required' };
  }
  const v2GateRequired = manifest.promotion?.v2GateRequired === true || manifest.promotion?.gateRequired === true;
  if (v2GateRequired) {
    const gate = manifest.promotion?.v2Gate || manifest.promotion?.gate || manifest.gate;
    if (!gate || gate.passed !== true) {
      return { allow: false, reason: 'promotion_gate_evidence_required' };
    }
    if (Array.isArray(gate.reasons) && gate.reasons.length > 0) {
      return { allow: false, reason: 'promotion_gate_has_failures' };
    }
  }
  return { allow: true, reason: 'validated_and_approved' };
}

function evaluatePromotionEvidenceGate({
  manifest = {},
  context = {},
  strategyClass = manifest.strategyClass || context.strategyClass || 'generic',
  thresholds = {},
  now,
} = {}) {
  const stats = context.stats || {};
  const promotion = manifest.promotion || {};
  const evidence = manifest.evidence || {};
  const metrics = {
    sampleSize: promotion.sampleSize
      ?? evidence.sampleSize
      ?? context.promotionMetrics?.sampleSize
      ?? stats.closedTrades
      ?? stats.trades
      ?? 0,
    expectancyUsd: promotion.expectancyUsd
      ?? evidence.expectancyUsd
      ?? context.promotionMetrics?.expectancyUsd
      ?? stats.expectancyUsd
      ?? stats.expectancy
      ?? 0,
    stressedExpectancyUsd: promotion.stressedExpectancyUsd
      ?? evidence.stressedExpectancyUsd
      ?? context.promotionMetrics?.stressedExpectancyUsd
      ?? context.stressedExpectancyUsd
      ?? 0,
    profitFactor: promotion.profitFactor
      ?? evidence.profitFactor
      ?? context.promotionMetrics?.profitFactor
      ?? stats.profitFactor
      ?? 0,
    maxDrawdownPct: promotion.maxDrawdownPct
      ?? evidence.maxDrawdownPct
      ?? context.promotionMetrics?.maxDrawdownPct
      ?? stats.maxDrawdownPct
      ?? stats.drawdownPct
      ?? 0,
    symbolConcentrationPct: promotion.symbolConcentrationPct
      ?? evidence.symbolConcentrationPct
      ?? context.promotionMetrics?.symbolConcentrationPct
      ?? context.symbolConcentrationPct
      ?? 0,
    regimeCoverageCount: promotion.regimeCoverageCount
      ?? evidence.regimeCoverageCount
      ?? context.promotionMetrics?.regimeCoverageCount
      ?? context.regimeCoverageCount
      ?? 0,
    executionDiscrepancyPct: promotion.executionDiscrepancyPct
      ?? evidence.executionDiscrepancyPct
      ?? context.promotionMetrics?.executionDiscrepancyPct
      ?? context.paperLiveComparison?.executionDiscrepancyPct
      ?? context.paperLiveComparison?.fillDiscrepancyDeltaPct
      ?? 0,
  };

  return evaluatePromotionGate({
    botProfile: manifest.versioning?.sourceProfile || context.botProfile || context.sourceProfile || null,
    targetProfile: promotion.targetProfile || context.targetProfile || 'live_spot',
    strategy: manifest.strategy || context.strategy || context.strategyId || null,
    strategyClass,
    metrics,
    thresholds,
    now,
  });
}

function normalizeRegimeLabel(raw = '') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('extreme')) return 'extreme_volatility';
  if (value.includes('high')) return 'high_volatility';
  if (value.includes('up')) return 'uptrend';
  if (value.includes('down')) return 'downtrend';
  if (value.includes('range')) return 'ranging';
  return value;
}

function classifyRegimeFamily(raw = '') {
  const label = normalizeRegimeLabel(raw);
  if (label.includes('uptrend')) return 'trend_up';
  if (label.includes('downtrend')) return 'trend_down';
  if (label.includes('high') || label.includes('extreme')) return 'volatile';
  if (label.includes('range')) return 'ranging';
  if (label.includes('bull')) return 'trend_up';
  if (label.includes('bear')) return 'trend_down';
  return 'unknown';
}

module.exports = {
  stableStringify,
  hashValue,
  hashText,
  computeStrategyVersionHash,
  computeDiscrepancyScore,
  classifyPromotionImpact,
  validateGeneratedBehaviorApplication,
  validatePromotionCandidate,
  evaluatePromotionEvidenceGate,
  normalizeRegimeLabel,
  classifyRegimeFamily,
};
