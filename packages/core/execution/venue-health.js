'use strict';

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values, pct) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeVenueHealth({
  venue = 'unknown',
  samples = [],
  thresholds = {},
} = {}) {
  const rows = Array.isArray(samples) ? samples : [];
  const total = rows.length;
  const failures = rows.filter((sample) => sample.ok === false || sample.failed === true).length;
  const rateLimited = rows.filter((sample) => sample.rateLimited === true).length;
  const stale = rows.filter((sample) => sample.stale === true).length;
  const latencies = rows.map((sample) => Number(sample.latencyMs)).filter(Number.isFinite);
  const slippages = rows.map((sample) => Math.abs(Number(sample.slippageBps))).filter(Number.isFinite);

  const failureRatePct = total > 0 ? (failures / total) * 100 : 0;
  const rateLimitRatePct = total > 0 ? (rateLimited / total) * 100 : 0;
  const staleRatePct = total > 0 ? (stale / total) * 100 : 0;
  const p95LatencyMs = percentile(latencies, 95);
  const p95SlippageBps = percentile(slippages, 95);

  const reasons = [];
  const maxFailureRatePct = numberOr(thresholds.maxFailureRatePct, 10);
  const maxRateLimitRatePct = numberOr(thresholds.maxRateLimitRatePct, 5);
  const maxStaleRatePct = numberOr(thresholds.maxStaleRatePct, 10);
  const maxP95LatencyMs = numberOr(thresholds.maxP95LatencyMs, 3000);
  const maxP95SlippageBps = numberOr(thresholds.maxP95SlippageBps, 75);

  if (failureRatePct > maxFailureRatePct) reasons.push('failure_rate_high');
  if (rateLimitRatePct > maxRateLimitRatePct) reasons.push('rate_limit_pressure');
  if (staleRatePct > maxStaleRatePct) reasons.push('market_data_stale');
  if (p95LatencyMs != null && p95LatencyMs > maxP95LatencyMs) reasons.push('latency_p95_high');
  if (p95SlippageBps != null && p95SlippageBps > maxP95SlippageBps) reasons.push('slippage_p95_high');

  let score = 100;
  score -= Math.min(50, failureRatePct * 2);
  score -= Math.min(20, rateLimitRatePct * 2);
  score -= Math.min(20, staleRatePct);
  if (p95LatencyMs != null && p95LatencyMs > maxP95LatencyMs) score -= 15;
  if (p95SlippageBps != null && p95SlippageBps > maxP95SlippageBps) score -= 15;
  score = Math.max(0, Math.min(100, Number(score.toFixed(2))));

  const status = reasons.length === 0
    ? 'healthy'
    : (score < 50 || failureRatePct > maxFailureRatePct * 2 ? 'unhealthy' : 'degraded');

  return {
    venue,
    status,
    score,
    reasons,
    sampleCount: total,
    failureRatePct,
    rateLimitRatePct,
    staleRatePct,
    p95LatencyMs,
    p95SlippageBps,
  };
}

module.exports = {
  summarizeVenueHealth,
};
