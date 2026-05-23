'use strict';

/**
 * Memory subsystem facade (Week 16.2 closeout).
 *
 * Single import surface for the agent memory subsystem. Composes the pure-helper
 * modules (blacklist, merge, shape, stats, lessons, knowledge, insights) and
 * provides a thin instance factory `create({logger, config})` that returns a
 * stateful memory object backed by the AgentMemory class.
 *
 * Migration strategy:
 *   - Today: `create()` returns `new AgentMemory(...)` for API compatibility.
 *     Callers see no change.
 *   - Future: AgentMemory class internals can be incrementally replaced with
 *     `createPureMemory()` composition without changing this module's exports.
 *     When that's done, the class can be deleted and `create()` returns the
 *     composition directly.
 *
 * Pure helpers are re-exported so new code can skip the class entirely:
 *   const { lessons, knowledge, insights, blacklist, stats } = require('./agent/memory/core');
 *   lessons.recordLessonInto(data, fields);
 */

const AgentMemory = require('../agentMemory');
const blacklist = require('./blacklist');
const merge = require('./merge');
const shape = require('./shape');
const stats = require('./stats');
const lessons = require('./lessons');
const knowledge = require('./knowledge');
const insights = require('./insights');

/**
 * Factory: returns a stateful memory instance. Today this is an AgentMemory
 * class instance; callers should treat it as opaque and only use the documented
 * surface (isBlacklisted, recordLesson, checkLessons, addKnowledge, etc.).
 */
function create({ logger, config = {} } = {}) {
  return new AgentMemory({ logger, config });
}

module.exports = {
  create,
  // Re-exports of pure-helper modules (no `this` state):
  blacklist,
  merge,
  shape,
  stats,
  lessons,
  knowledge,
  insights,
  // Class export for tests / advanced consumers that need access to internals.
  // New production code should use `create()` instead.
  AgentMemory,
};
