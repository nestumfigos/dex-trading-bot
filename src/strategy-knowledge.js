'use strict';

// Distilled strategy archetypes inspired by widely known trading literature.
// This stores principles (not copied book text) for autonomous strategy profiling.
const STRATEGY_KNOWLEDGE_BASE = {
  turtle_breakout: {
    family: 'trend_following',
    principle: 'Enter on strong breakout with volume confirmation and enforce tight downside control.',
    requiredContext: ['momentum', 'liquidity', 'volatility'],
  },
  livermore_momentum: {
    family: 'momentum',
    principle: 'Add exposure when price and participation confirm a sustained move.',
    requiredContext: ['price_expansion', 'volume_confirmation', 'follow_through'],
  },
  connors_short_term_reversion: {
    family: 'mean_reversion',
    principle: 'Fade short-term exhaustion only when risk/reward and liquidity are favorable.',
    requiredContext: ['rsi_extreme', 'liquidity', 'rebound_probability'],
  },
  tape_flow_follow_through: {
    family: 'flow',
    principle: 'Prioritize setups with persistent buy-flow and supportive participation metrics.',
    requiredContext: ['buy_flow', 'buyer_ratio', 'sustained_interest'],
  },
  canonical_momentum_baseline: {
    family: 'baseline',
    principle: 'Use conservative momentum gating when no specialized profile is dominant.',
    requiredContext: ['signal_quality', 'risk_control'],
  },
};

module.exports = {
  STRATEGY_KNOWLEDGE_BASE,
};
