'use strict';

const crypto = require('crypto');

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

  return {
    score: clamp(Number(weighted.toFixed(2))),
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
  computeStrategyVersionHash,
  computeDiscrepancyScore,
  classifyPromotionImpact,
  normalizeRegimeLabel,
  classifyRegimeFamily,
};
