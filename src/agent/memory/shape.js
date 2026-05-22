'use strict';

/**
 * memory/shape.js — single source of truth for the AgentMemory data shape.
 *
 * Every field in `MEMORY_DATA_SHAPE` MUST appear in `MERGE_KEYS` of merge.js,
 * or `assertMergeCoverage()` fails the test suite.
 *
 * Bug class this guards: 2026-05-16 `_mergeFromRemote` wiped 6/13 fields
 * because they weren't enumerated in the merge function. With a single shape
 * declaration + reflection test, adding a new field automatically forces
 * MERGE_KEYS to be updated or the build breaks.
 */

const TYPE_ARRAY = 'array';
const TYPE_MAP   = 'map';
const TYPE_COUNTERS = 'counters';
const TYPE_AI_USAGE = 'ai_usage';
const TYPE_SCALAR = 'scalar';

/**
 * Authoritative description of every field on `memory.data`.
 * Used by merge.js (drives the merge dispatch table) and by the
 * merge-completeness test.
 */
const MEMORY_DATA_SHAPE = Object.freeze({
  version:                 { type: TYPE_SCALAR },
  tradeLessons:            { type: TYPE_ARRAY,    cap: 'MAX_LESSONS' },
  strategyDiscoveries:     { type: TYPE_ARRAY,    cap: 'MAX_DISCOVERIES' },
  tokenBlacklist:          { type: TYPE_MAP },
  tokenPreferences:        { type: TYPE_MAP },
  evolutionOutcomes:       { type: TYPE_ARRAY,    cap: 'MAX_EVOLUTION_LOG', mergeStrategy: 'remote_then_local_capped' },
  knowledgeBase:           { type: TYPE_ARRAY,    cap: 'MAX_KNOWLEDGE', idFn: 'stableKnowledgeId' },
  regimeWinRates:          { type: TYPE_COUNTERS },
  chainPatterns:           { type: TYPE_COUNTERS },
  tokenAgePatterns:        { type: TYPE_COUNTERS },
  exitClassificationStats: { type: TYPE_COUNTERS },
  symbolWinRates:          { type: TYPE_COUNTERS },
  indicatorPatterns:       { type: TYPE_COUNTERS },
  aiUsage:                 { type: TYPE_AI_USAGE },
});

const DATA_SHAPE_KEYS = Object.freeze(Object.keys(MEMORY_DATA_SHAPE));

module.exports = {
  MEMORY_DATA_SHAPE,
  DATA_SHAPE_KEYS,
  TYPE_ARRAY,
  TYPE_MAP,
  TYPE_COUNTERS,
  TYPE_AI_USAGE,
  TYPE_SCALAR,
};
