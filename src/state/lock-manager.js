'use strict';

// Runtime lock-manager: cleanup hook registry separate from boot/singleton's
// own lock-file release. Lets shutdownAndExit register additional async cleanup
// callbacks (telemetry flush, dashboard close, ws stop, etc.) in one place.
//
// Singleton lock release stays inside boot/singleton.js — this is for higher-
// level "drain on exit" tasks that must run before process.exit().

const hooks = [];
let draining = false;

function register(name, fn) {
  if (typeof fn !== 'function') throw new Error('register: fn required');
  hooks.push({ name, fn });
}

function clear() {
  hooks.length = 0;
}

async function drain({ logger = console, timeoutMs = 5000 } = {}) {
  if (draining) return;
  draining = true;
  for (const h of hooks) {
    try {
      const p = Promise.resolve(h.fn());
      const t = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs));
      await Promise.race([p, t]);
      logger.debug(`[lock-manager] drained '${h.name}'`);
    } catch (err) {
      logger.warn(`[lock-manager] hook '${h.name}' failed: ${err.message}`);
    }
  }
  draining = false;
}

function list() {
  return hooks.map((h) => h.name);
}

module.exports = { register, clear, drain, list };
