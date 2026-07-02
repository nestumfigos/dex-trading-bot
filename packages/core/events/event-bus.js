'use strict';

const DEFAULT_HISTORY_LIMIT = 500;

const CORE_TRADING_EVENTS = Object.freeze([
  'candidate.detected',
  'signal.evaluated',
  'risk.approved',
  'risk.rejected',
  'order.submitted',
  'fill.confirmed',
  'position.updated',
  'strategy.promoted',
  'kill_switch.triggered',
]);

function createEventBus({ historyLimit = DEFAULT_HISTORY_LIMIT, now = () => new Date().toISOString() } = {}) {
  const subscribers = new Map();
  const wildcardSubscribers = new Set();
  const history = [];

  function subscribe(eventName, handler) {
    if (typeof handler !== 'function') throw new Error('event handler must be a function');
    if (eventName === '*') {
      wildcardSubscribers.add(handler);
      return () => wildcardSubscribers.delete(handler);
    }
    const key = String(eventName || '').trim();
    if (!key) throw new Error('event name is required');
    const set = subscribers.get(key) || new Set();
    set.add(handler);
    subscribers.set(key, set);
    return () => set.delete(handler);
  }

  async function publish(eventName, payload = {}) {
    const key = String(eventName || '').trim();
    if (!key) throw new Error('event name is required');
    const event = Object.freeze({
      eventName: key,
      payload: payload && typeof payload === 'object' ? { ...payload } : payload,
      emittedAt: now(),
    });
    history.push(event);
    while (history.length > historyLimit) history.shift();
    const handlers = [
      ...(subscribers.get(key) || []),
      ...wildcardSubscribers,
    ];
    const failures = [];
    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      const err = new Error(`event_bus_handler_failures:${failures.length}`);
      err.failures = failures;
      throw err;
    }
    return event;
  }

  function getHistory({ eventName = null, limit = historyLimit } = {}) {
    const rows = eventName
      ? history.filter((event) => event.eventName === eventName)
      : history;
    return rows.slice(-Math.max(0, Number(limit) || 0)).map((event) => ({ ...event }));
  }

  return { subscribe, publish, getHistory };
}

module.exports = {
  CORE_TRADING_EVENTS,
  createEventBus,
};
