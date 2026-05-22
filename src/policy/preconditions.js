'use strict';

/**
 * Policy Preconditions — Week 5 / Track A.
 *
 * Pure dependency-injected gates that guard dangerous autonomous actions:
 *   - Self-evolution patch promotion
 *   - Live trading enable / promote-paper-to-main
 *   - Position size increase
 *   - Rotation between positions
 *   - AI override acceptance
 *
 * Each gate returns { allow: boolean, reason: string, evidence: Object }.
 * Caller is expected to log on deny + record to dbo.config_changes if rejecting
 * a self-evolution proposal.
 *
 * Thresholds load from strategy_config (hot-reloadable via db-hot-reload).
 * Defense-in-depth: cache miss / SQL down → conservative defaults.
 *
 * Bug class this guards: 2026-05-16 auto-promote-evolution-on-losing-PnL.
 */

const DEFAULTS = Object.freeze({
  // canPromoteEvolutionPatch
  EVO_MIN_WIN_RATE:       40,    // %
  EVO_MIN_PNL_USD:         0,    // ≥ 0 required for promote
  EVO_MIN_SAMPLES:        20,
  EVO_MIN_CAUSAL_DELTA_WR: 0,    // delta WR vs pre-patch must be ≥ 0 (no regression)

  // canEnableLiveTrading
  LIVE_REQUIRED_PAPER_HOURS: 24,
  LIVE_MAX_RECENT_CRASHES:    2,  // last hour
  LIVE_MIN_PAPER_TRADES:     10,

  // canIncreasePositionSize
  SIZE_MAX_CONSECUTIVE_LOSSES: 3,
  SIZE_MIN_WIN_RATE:          30,

  // canRotatePosition
  ROTATE_MIN_EDGE_PCT:          5,    // expected edge over current position
  ROTATE_MIN_PERSISTENCE_MIN:  10,

  // canAcceptAiOverride
  AI_MIN_SAMPLES_FOR_OVERRIDE: 50,
});

const RULES_CATALOG = Object.freeze([
  { name: 'evo_promote',         description: 'Self-evolution patch may be promoted (WR/PnL/samples/causal delta)' },
  { name: 'live_enable',         description: 'Live trading may be enabled (paper-validated 24h, no crash loop)' },
  { name: 'size_increase',       description: 'Position size may be increased (no loss streak, min WR)' },
  { name: 'rotate_position',     description: 'Rotation BUY allowed (edge + persistence)' },
  { name: 'ai_override_accept',  description: 'AI override may bypass other gates (circuit closed + sample size)' },
]);

function num(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

function deny(reason, evidence) { return { allow: false, reason, evidence: evidence || {} }; }
function allow(evidence)        { return { allow: true,  reason: 'ok',  evidence: evidence || {} }; }

// ─── Threshold resolver ────────────────────────────────────────────────────

function readThreshold(thresholds, name, fallback) {
  if (!thresholds) return fallback;
  if (typeof thresholds.get === 'function') {
    const v = thresholds.get(name);
    return v == null ? fallback : Number(v);
  }
  if (typeof thresholds[name] !== 'undefined') return Number(thresholds[name]);
  return fallback;
}

// ─── Individual gates ──────────────────────────────────────────────────────

function canPromoteEvolutionPatch(state = {}, thresholds = null) {
  const wr        = num(state.winRate, NaN);
  const pnl       = num(state.pnlUsd, NaN);
  const samples   = num(state.samples, 0);
  const deltaWr   = num(state.causalDeltaWinRate, NaN);

  const minWr     = readThreshold(thresholds, 'EVO_MIN_WIN_RATE',        DEFAULTS.EVO_MIN_WIN_RATE);
  const minPnl    = readThreshold(thresholds, 'EVO_MIN_PNL_USD',         DEFAULTS.EVO_MIN_PNL_USD);
  const minSamp   = readThreshold(thresholds, 'EVO_MIN_SAMPLES',         DEFAULTS.EVO_MIN_SAMPLES);
  const minDelta  = readThreshold(thresholds, 'EVO_MIN_CAUSAL_DELTA_WR', DEFAULTS.EVO_MIN_CAUSAL_DELTA_WR);

  if (samples < minSamp)         return deny(`samples ${samples} < ${minSamp}`,   { samples, minSamples: minSamp });
  if (!Number.isFinite(wr))      return deny('winRate not finite',                { state });
  if (wr < minWr)                return deny(`winRate ${wr}% < ${minWr}%`,        { winRate: wr, minWinRate: minWr });
  if (!Number.isFinite(pnl))     return deny('pnlUsd not finite',                 { state });
  if (pnl < minPnl)              return deny(`pnlUsd $${pnl} < $${minPnl}`,       { pnlUsd: pnl, minPnlUsd: minPnl });
  if (!Number.isFinite(deltaWr)) return deny('causalDeltaWinRate not finite',     { state });
  if (deltaWr < minDelta)        return deny(`causal delta WR ${deltaWr} < ${minDelta}`, { deltaWr, minDelta });
  return allow({ wr, pnl, samples, deltaWr });
}

function canEnableLiveTrading(state = {}, thresholds = null) {
  const paperHours = num(state.paperValidationHours, 0);
  const crashes    = num(state.crashesLastHour, 0);
  const trades     = num(state.paperTradesCount, 0);

  const minHours = readThreshold(thresholds, 'LIVE_REQUIRED_PAPER_HOURS', DEFAULTS.LIVE_REQUIRED_PAPER_HOURS);
  const maxCrash = readThreshold(thresholds, 'LIVE_MAX_RECENT_CRASHES',   DEFAULTS.LIVE_MAX_RECENT_CRASHES);
  const minTrades = readThreshold(thresholds, 'LIVE_MIN_PAPER_TRADES',    DEFAULTS.LIVE_MIN_PAPER_TRADES);

  if (paperHours < minHours)  return deny(`paper validated ${paperHours}h < ${minHours}h`, { paperHours, minHours });
  if (crashes > maxCrash)     return deny(`crashes ${crashes} > ${maxCrash} last hour`,    { crashes, maxCrash });
  if (trades < minTrades)     return deny(`paper trades ${trades} < ${minTrades}`,         { trades, minTrades });
  return allow({ paperHours, crashes, trades });
}

function canIncreasePositionSize(state = {}, thresholds = null) {
  const losses = num(state.consecutiveLosses, 0);
  const wr     = num(state.winRate, NaN);

  const maxLoss = readThreshold(thresholds, 'SIZE_MAX_CONSECUTIVE_LOSSES', DEFAULTS.SIZE_MAX_CONSECUTIVE_LOSSES);
  const minWr   = readThreshold(thresholds, 'SIZE_MIN_WIN_RATE',           DEFAULTS.SIZE_MIN_WIN_RATE);

  if (losses >= maxLoss)     return deny(`consecutive losses ${losses} ≥ ${maxLoss}`, { losses, maxLoss });
  if (!Number.isFinite(wr))  return deny('winRate not finite',                         { state });
  if (wr < minWr)            return deny(`winRate ${wr}% < ${minWr}%`,                 { winRate: wr, minWinRate: minWr });
  return allow({ losses, wr });
}

function canRotatePosition(state = {}, thresholds = null) {
  const edge        = num(state.edgePct, NaN);
  const persistence = num(state.persistenceMinutes, 0);

  const minEdge = readThreshold(thresholds, 'ROTATE_MIN_EDGE_PCT',          DEFAULTS.ROTATE_MIN_EDGE_PCT);
  const minPers = readThreshold(thresholds, 'ROTATE_MIN_PERSISTENCE_MIN',  DEFAULTS.ROTATE_MIN_PERSISTENCE_MIN);

  if (!Number.isFinite(edge))     return deny('edgePct not finite',                      { state });
  if (edge < minEdge)             return deny(`edge ${edge}% < ${minEdge}%`,              { edge, minEdge });
  if (persistence < minPers)      return deny(`persistence ${persistence}min < ${minPers}min`, { persistence, minPers });
  return allow({ edge, persistence });
}

function canAcceptAiOverride(state = {}, thresholds = null) {
  const circuitOpen = !!state.aiCircuitOpen;
  const samples     = num(state.aiSamples, 0);

  const minSamp = readThreshold(thresholds, 'AI_MIN_SAMPLES_FOR_OVERRIDE', DEFAULTS.AI_MIN_SAMPLES_FOR_OVERRIDE);

  if (circuitOpen)         return deny('AI circuit open',                                { circuitOpen });
  if (samples < minSamp)   return deny(`ai samples ${samples} < ${minSamp}`,             { samples, minSamp });
  return allow({ samples });
}

// ─── Threshold loader (DB-backed, with env fallback) ───────────────────────

/**
 * Load policy thresholds from dbo.strategy_config (knob name == DEFAULTS key).
 * Returns a Map for use by gates. Falls back to env vars, then DEFAULTS.
 * Best-effort: SQL down → empty Map (gates use DEFAULTS).
 */
async function loadThresholds({ sql, scope = 'global' } = {}) {
  const map = new Map();

  // Layer 1: hardcoded defaults
  for (const [k, v] of Object.entries(DEFAULTS)) map.set(k, v);

  // Layer 2: process.env override
  for (const k of Object.keys(DEFAULTS)) {
    const envVal = process.env[k];
    if (envVal != null && envVal !== '') {
      const n = Number(envVal);
      if (Number.isFinite(n)) map.set(k, n);
    }
  }

  // Layer 3: strategy_config DB (highest precedence)
  if (sql && typeof sql.request === 'function') {
    try {
      const knobs = Object.keys(DEFAULTS).map((k) => `'${k}'`).join(',');
      const req = sql.request();
      req.input('scope', scope);
      const r = await req.query(`
        SELECT knob, value
          FROM dbo.strategy_config
         WHERE knob IN (${knobs}) AND scope IN (@scope, 'global') AND active = 1
      `);
      for (const row of (r.recordset || [])) {
        const n = Number(row.value);
        if (Number.isFinite(n)) map.set(row.knob, n);
      }
    } catch { /* SQL down → degrade to env + defaults */ }
  }

  return map;
}

module.exports = {
  canPromoteEvolutionPatch,
  canEnableLiveTrading,
  canIncreasePositionSize,
  canRotatePosition,
  canAcceptAiOverride,
  loadThresholds,
  RULES_CATALOG,
  DEFAULTS,
};
