'use strict';

function sanitizeMetricName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_:]/g, '_');
}

function escapeLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderMetricSample(metric) {
  const labels = metric.labels && typeof metric.labels === 'object'
    ? Object.entries(metric.labels)
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${sanitizeMetricName(key)}="${escapeLabel(value)}"`)
      .join(',')
    : '';
  const value = Number(metric.value);
  return `${sanitizeMetricName(metric.name)}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`;
}

function renderPrometheusMetrics(metrics = []) {
  const lines = [];
  const emittedMeta = new Set();
  for (const metric of metrics) {
    const name = sanitizeMetricName(metric.name);
    if (!name) continue;
    if (!emittedMeta.has(name)) {
      if (metric.help) lines.push(`# HELP ${name} ${String(metric.help).replace(/\n/g, ' ')}`);
      lines.push(`# TYPE ${name} ${metric.type || 'gauge'}`);
      emittedMeta.add(name);
    }
    lines.push(renderMetricSample({ ...metric, name }));
  }
  return `${lines.join('\n')}\n`;
}

function buildBotHealthMetrics({
  botProfile = 'unknown',
  health = {},
  extra = {},
} = {}) {
  const labels = { bot_profile: botProfile };
  const sql = health.sql || {};
  const metrics = [
    { name: 'trading_bot_health_ok', help: 'Bot health status, 1 when healthy.', labels, value: health.ok ? 1 : 0 },
    { name: 'trading_bot_degraded', help: 'Bot degraded status, 1 when degraded.', labels, value: health.degraded ? 1 : 0 },
    { name: 'trading_bot_uptime_seconds', help: 'Bot uptime in seconds.', labels, value: Number(health.uptimeSeconds || 0) },
    { name: 'trading_bot_sql_enabled', help: 'SQL telemetry/control plane enabled.', labels, value: sql.enabled ? 1 : 0 },
    { name: 'trading_bot_sql_connected', help: 'SQL connection status.', labels, value: sql.connected ? 1 : 0 },
    { name: 'trading_bot_unhealthy_reasons', help: 'Count of active unhealthy reasons.', labels, value: Array.isArray(health.unhealthyReasons) ? health.unhealthyReasons.length : 0 },
  ];
  for (const [name, value] of Object.entries(extra || {})) {
    metrics.push({
      name: `trading_bot_${name}`,
      labels,
      value: value === true ? 1 : (value === false ? 0 : Number(value || 0)),
    });
  }
  return metrics;
}

function buildReadinessGateMetrics({
  botProfile = 'unknown',
  metricPrefix = 'trading_bot_readiness',
  gates = [],
} = {}) {
  const rows = Array.isArray(gates) ? gates : [];
  const safePrefix = sanitizeMetricName(metricPrefix || 'trading_bot_readiness');
  const metrics = [
    {
      name: `${safePrefix}_gates_total`,
      help: 'Total readiness gates evaluated.',
      labels: { bot_profile: botProfile },
      value: rows.length,
    },
    {
      name: `${safePrefix}_gates_blocked`,
      help: 'Count of readiness gates currently blocking promotion or live readiness.',
      labels: { bot_profile: botProfile },
      value: rows.filter((gate) => gate?.passed !== true).length,
    },
  ];
  for (const gate of rows) {
    metrics.push({
      name: `${safePrefix}_gate_passed`,
      help: 'Readiness gate state, 1 when the gate is passing.',
      labels: {
        bot_profile: botProfile,
        gate: gate?.gate || 'unknown',
      },
      value: gate?.passed === true ? 1 : 0,
    });
  }
  return metrics;
}

module.exports = {
  renderPrometheusMetrics,
  buildBotHealthMetrics,
  buildReadinessGateMetrics,
};
