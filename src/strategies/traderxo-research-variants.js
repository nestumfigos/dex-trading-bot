'use strict';

const STRATEGY_VARIANTS = Object.freeze({
  baseline: Object.freeze({
    id: 'baseline',
    label: 'Current rules',
    minimumRewardRisk: 3,
    requireBiasAlignment: false,
    blockedRegimes: [],
    management: Object.freeze({ manualCutBars: 5 }),
  }),
  bias_aligned: Object.freeze({
    id: 'bias_aligned',
    label: 'Anchor bias aligned only',
    minimumRewardRisk: 3,
    requireBiasAlignment: true,
    blockedRegimes: [],
    management: Object.freeze({ manualCutBars: 5 }),
  }),
  bias_no_range: Object.freeze({
    id: 'bias_no_range',
    label: 'Bias aligned, exclude ranges',
    minimumRewardRisk: 3,
    requireBiasAlignment: true,
    blockedRegimes: ['ranging'],
    management: Object.freeze({ manualCutBars: 5 }),
  }),
  bias_rr4: Object.freeze({
    id: 'bias_rr4',
    label: 'Bias aligned, minimum 4R',
    minimumRewardRisk: 4,
    requireBiasAlignment: true,
    blockedRegimes: [],
    management: Object.freeze({ manualCutBars: 5 }),
  }),
  bias_fast_cut: Object.freeze({
    id: 'bias_fast_cut',
    label: 'Bias aligned, faster stale cut',
    minimumRewardRisk: 3,
    requireBiasAlignment: true,
    blockedRegimes: [],
    management: Object.freeze({ manualCutBars: 3 }),
  }),
});

function resolveStrategyVariant(variantId = 'baseline') {
  const variant = STRATEGY_VARIANTS[String(variantId || 'baseline')];
  if (!variant) throw new Error('unknown_traderxo_research_variant');
  return variant;
}

function evaluateVariantEntry({ intent, regime, variant }) {
  const selected = resolveStrategyVariant(variant?.id || variant);
  if (selected.requireBiasAlignment && intent.setupGrade !== 'A+') {
    return { allow: false, reason: 'variant_anchor_bias_alignment_required' };
  }
  if (selected.blockedRegimes.includes(regime)) {
    return { allow: false, reason: `variant_regime_blocked_${regime}` };
  }
  if (Number(intent.rr) < Number(selected.minimumRewardRisk)) {
    return { allow: false, reason: `variant_reward_risk_below_${selected.minimumRewardRisk}` };
  }
  return { allow: true };
}

function listStrategyVariants() {
  return Object.values(STRATEGY_VARIANTS);
}

module.exports = { STRATEGY_VARIANTS, resolveStrategyVariant, evaluateVariantEntry, listStrategyVariants };
