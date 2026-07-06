'use strict';

// Heap telemetry (2026-07-06 audit-4 roadmap): paper restarts ~5x/day with no
// stderr — consistent with the ML-superset heap leak hitting the 4GB V8
// ceiling. This logs a compact memory line on an interval so the leak's
// GROWTH CURVE and its correlation with in-memory structure sizes land in
// the pm2 out-log (grep '[heap]'). Zero-cost when disabled.
//
// HEAP_TELEMETRY_ENABLED default: on for paper profile, off otherwise.
// HEAP_TELEMETRY_INTERVAL_MS default: 300000 (5 min).

function sizeOf(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) return obj.length;
  if (obj instanceof Map || obj instanceof Set) return obj.size;
  return Object.keys(obj).length;
}

function startHeapTelemetry({ logger = console, roots = {}, profile = '' } = {}) {
  const enabledDefault = String(profile).toLowerCase() === 'paper';
  const enabled = process.env.HEAP_TELEMETRY_ENABLED != null
    ? process.env.HEAP_TELEMETRY_ENABLED === 'true'
    : enabledDefault;
  if (!enabled) return null;

  const intervalMs = Math.max(60_000, Number(process.env.HEAP_TELEMETRY_INTERVAL_MS || 300_000));
  const mb = (bytes) => Math.round(bytes / 1024 / 1024);

  const timer = setInterval(() => {
    try {
      const m = process.memoryUsage();
      const rootSizes = Object.entries(roots)
        .map(([name, getter]) => {
          try { return `${name}=${sizeOf(typeof getter === 'function' ? getter() : getter)}`; }
          catch { return `${name}=?`; }
        })
        .join(' ');
      logger.info(
        `[heap] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB `
        + `external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers || 0)}MB ${rootSizes}`
      );
    } catch (_) { /* telemetry must never throw */ }
  }, intervalMs);
  timer.unref(); // never keep the process alive for telemetry

  logger.info(`[heap] telemetry started (every ${intervalMs / 1000}s)`);
  return timer;
}

module.exports = { startHeapTelemetry };
