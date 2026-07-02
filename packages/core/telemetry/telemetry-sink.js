'use strict';

function normalizeTradingEvent(event = {}) {
  const eventName = String(event.eventName || event.name || '').trim();
  if (!eventName) throw new Error('eventName is required');
  return {
    eventName,
    botProfile: event.botProfile || event.bot_profile || null,
    strategy: event.strategy || null,
    symbol: event.symbol || null,
    severity: event.severity || 'info',
    occurredAt: event.occurredAt || event.ts || new Date().toISOString(),
    correlationId: event.correlationId || event.correlation_id || null,
    payload: event.payload && typeof event.payload === 'object' ? { ...event.payload } : {},
  };
}

function createCompositeTelemetrySink(sinks = []) {
  const active = sinks.filter(Boolean);
  async function record(event) {
    const normalized = normalizeTradingEvent(event);
    const failures = [];
    for (const sink of active) {
      if (typeof sink.record !== 'function') continue;
      try {
        await sink.record(normalized);
      } catch (error) {
        failures.push(error);
      }
    }
    return { ok: failures.length === 0, failures, event: normalized };
  }
  return { record };
}

module.exports = {
  normalizeTradingEvent,
  createCompositeTelemetrySink,
};
