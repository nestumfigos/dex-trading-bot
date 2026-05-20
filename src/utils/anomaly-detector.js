'use strict';

// 3-sigma anomaly detector (Week 11.7c). Pure stats helpers + alert dispatcher.
// Tracks rolling window of values, flags points >3σ from mean as anomalies.
// Caller wires per-metric (daily PnL, trade rate, slippage bps, etc.).
//
// Stateless functions (computeStats, isAnomaly). Caller maintains windows.

function computeStats(samples) {
  const vals = (samples || []).filter((v) => Number.isFinite(v));
  if (vals.length < 4) return { mean: 0, stddev: 0, n: vals.length };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / vals.length;
  const stddev = Math.sqrt(variance);
  return { mean, stddev, n: vals.length };
}

function isAnomaly(value, samples, { sigmaThreshold = 3, minSamples = 8 } = {}) {
  const stats = computeStats(samples);
  if (stats.n < minSamples || stats.stddev === 0) {
    return { anomaly: false, stats, zScore: null, reason: 'insufficient_samples' };
  }
  if (!Number.isFinite(value)) {
    return { anomaly: false, stats, zScore: null, reason: 'invalid_value' };
  }
  const zScore = (value - stats.mean) / stats.stddev;
  const anomaly = Math.abs(zScore) >= sigmaThreshold;
  return { anomaly, stats, zScore };
}

// Window helper — rolling fixed-size circular buffer wrapped in an object.
function createWindow(maxSize = 30) {
  const buf = [];
  return {
    push(value) {
      if (Number.isFinite(value)) {
        buf.push(value);
        while (buf.length > maxSize) buf.shift();
      }
    },
    snapshot() {
      return buf.slice();
    },
    size() {
      return buf.length;
    },
    clear() {
      buf.length = 0;
    },
  };
}

// Dispatcher: runs anomaly check + fires telegram alert via sendAlert callback if anomalous.
// Suppression: don't re-fire same metric within `cooldownMs` (default 1h).
function createAnomalyAlerter({ sendAlert, logger, cooldownMs = 60 * 60 * 1000 } = {}) {
  if (typeof sendAlert !== 'function') throw new Error('createAnomalyAlerter: sendAlert required');
  const lastAlertAt = new Map();
  const log = logger || { info() {}, warn() {} };

  return {
    check(metricName, value, samples, options = {}) {
      const result = isAnomaly(value, samples, options);
      if (!result.anomaly) return { fired: false, ...result };
      const lastFiredMs = lastAlertAt.get(metricName) || 0;
      const now = Date.now();
      if (now - lastFiredMs < cooldownMs) {
        return { fired: false, suppressed: true, ...result };
      }
      lastAlertAt.set(metricName, now);
      const direction = result.zScore > 0 ? 'above' : 'below';
      const msg = `[Anomaly] ${metricName} = ${value.toFixed(2)} (${Math.abs(result.zScore).toFixed(1)}σ ${direction} mean ${result.stats.mean.toFixed(2)})`;
      try {
        sendAlert(msg, { metric: metricName, value, zScore: result.zScore, stats: result.stats });
      } catch (e) {
        log.warn(`[Anomaly] sendAlert failed for ${metricName}: ${e?.message || e}`);
      }
      log.info(msg);
      return { fired: true, ...result };
    },
    resetCooldown(metricName) {
      lastAlertAt.delete(metricName);
    },
  };
}

module.exports = {
  computeStats,
  isAnomaly,
  createWindow,
  createAnomalyAlerter,
};
