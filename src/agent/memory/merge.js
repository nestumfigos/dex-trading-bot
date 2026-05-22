'use strict';

/**
 * memory/merge.js — isolated merge logic for AgentMemory shared SQL state.
 *
 * Pure functions, no `this`. Caller passes `{ current, remote, helpers }`,
 * receives a fully-merged data object.
 *
 * MERGE_KEYS is the authoritative list of every field merged here. The
 * merge-completeness test reflects on shape.js DATA_SHAPE_KEYS and asserts
 * MERGE_KEYS covers every key — adding a field without updating MERGE_KEYS
 * fails CI. This structurally blocks the 2026-05-16 bug class where
 * _mergeFromRemote wiped 6/13 fields by forgetting to enumerate them.
 */

const {
  MEMORY_DATA_SHAPE,
  TYPE_ARRAY,
  TYPE_MAP,
  TYPE_COUNTERS,
  TYPE_AI_USAGE,
  TYPE_SCALAR,
} = require('./shape');

const MERGE_KEYS = Object.freeze([
  'version',
  'tradeLessons',
  'strategyDiscoveries',
  'tokenBlacklist',
  'tokenPreferences',
  'evolutionOutcomes',
  'knowledgeBase',
  'regimeWinRates',
  'chainPatterns',
  'tokenAgePatterns',
  'exitClassificationStats',
  'symbolWinRates',
  'indicatorPatterns',
  'aiUsage',
]);

// ── Pure helpers ──────────────────────────────────────────────────────────

function mergeArrayById(a = [], b = [], cap = 200, idFallback = null) {
  const map = new Map();
  [...(a || []), ...(b || [])].forEach((item) => {
    if (!item) return;
    const id = String(item.id || (typeof idFallback === 'function' ? idFallback(item) : ''));
    if (!id) return;
    if (!item.id) item.id = id;
    const prev = map.get(id);
    if (!prev) { map.set(id, item); return; }
    const prevTs = Number(prev.ts || 0);
    const nextTs = Number(item.ts || 0);
    map.set(id, nextTs >= prevTs ? item : prev);
  });
  const arr = Array.from(map.values());
  arr.sort((x, y) => Number(y.ts || 0) - Number(x.ts || 0));
  return arr.slice(0, cap);
}

function mergeMap(a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    const prev = out[k];
    if (!prev) { out[k] = v; continue; }
    const prevTs = Number(prev.addedAt || 0);
    const nextTs = Number(v.addedAt || 0);
    const prevExp = Number(prev.expiresAt || 0);
    const nextExp = Number(v.expiresAt || 0);
    out[k] = (nextTs > prevTs || nextExp > prevExp) ? v : prev;
  }
  return out;
}

const DEFAULT_SUM_FIELDS = ['wins', 'losses', 'tradeCount', 'totalHoldMinutes', 'totalPnlUsd'];
function mergeCounters(a = {}, b = {}, sumFields = DEFAULT_SUM_FIELDS) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = {};
  for (const k of keys) {
    const av = a?.[k] || {};
    const bv = b?.[k] || {};
    const merged = { ...av, ...bv };
    for (const f of sumFields) {
      if (typeof av[f] === 'number' || typeof bv[f] === 'number') {
        merged[f] = Number(av[f] || 0) + Number(bv[f] || 0);
      }
    }
    if (av.lastTradeTs || bv.lastTradeTs) {
      merged.lastTradeTs = Math.max(Number(av.lastTradeTs || 0), Number(bv.lastTradeTs || 0));
    }
    out[k] = merged;
  }
  return out;
}

// ── Main merge ────────────────────────────────────────────────────────────

/**
 * Produce a fully-merged data object combining `current` (this bot's view)
 * and `remote` (the latest SQL snapshot).
 *
 * Behavior is byte-identical to the original AgentMemory._mergeFromRemote
 * (verified by roundtrip + merge-completeness tests).
 *
 * @param {object} opts
 * @param {object} opts.current — this.data (existing local state)
 * @param {object} opts.remote  — remote SQL snapshot
 * @param {object} opts.caps    — {MAX_LESSONS, MAX_DISCOVERIES, MAX_KNOWLEDGE, MAX_EVOLUTION_LOG}
 * @param {object} opts.helpers — {stableKnowledgeId, normalizeAiUsage, mergeAiUsage}
 * @returns {object} merged data shape (DOES NOT mutate inputs)
 */
function mergeFromRemote({ current, remote, caps = {}, helpers = {} } = {}) {
  if (!remote || typeof remote !== 'object') {
    return current; // nothing to merge
  }
  const safeCurrent = current && typeof current === 'object' ? current : {};
  const {
    MAX_LESSONS = 300,
    MAX_DISCOVERIES = 100,
    MAX_KNOWLEDGE = 600,
    MAX_EVOLUTION_LOG = 50,
  } = caps;
  const { stableKnowledgeId, normalizeAiUsage, mergeAiUsage } = helpers;

  const merged = {
    version: 2,
    tradeLessons: [],
    strategyDiscoveries: [],
    tokenBlacklist: {},
    tokenPreferences: {},
    evolutionOutcomes: [],
    knowledgeBase: [],
    aiUsage: normalizeAiUsage ? normalizeAiUsage() : {},
    symbolWinRates: {},
    regimeWinRates: {},
    chainPatterns: {},
    tokenAgePatterns: {},
    exitClassificationStats: {},
    indicatorPatterns: {},
  };

  merged.tradeLessons = mergeArrayById(remote.tradeLessons, safeCurrent.tradeLessons, MAX_LESSONS);
  merged.strategyDiscoveries = mergeArrayById(remote.strategyDiscoveries, safeCurrent.strategyDiscoveries, MAX_DISCOVERIES);
  merged.evolutionOutcomes = (Array.isArray(remote.evolutionOutcomes) ? remote.evolutionOutcomes : [])
    .concat(Array.isArray(safeCurrent.evolutionOutcomes) ? safeCurrent.evolutionOutcomes : [])
    .slice(0, MAX_EVOLUTION_LOG);
  merged.knowledgeBase = mergeArrayById(remote.knowledgeBase, safeCurrent.knowledgeBase, MAX_KNOWLEDGE, stableKnowledgeId);

  merged.tokenBlacklist = mergeMap(remote.tokenBlacklist, safeCurrent.tokenBlacklist);
  merged.tokenPreferences = mergeMap(remote.tokenPreferences, safeCurrent.tokenPreferences);
  merged.aiUsage = mergeAiUsage
    ? mergeAiUsage(remote.aiUsage, safeCurrent.aiUsage)
    : (remote.aiUsage || safeCurrent.aiUsage || {});

  merged.symbolWinRates = mergeCounters(remote.symbolWinRates, safeCurrent.symbolWinRates);
  merged.regimeWinRates = mergeCounters(remote.regimeWinRates, safeCurrent.regimeWinRates);
  merged.chainPatterns = mergeCounters(remote.chainPatterns, safeCurrent.chainPatterns);
  merged.tokenAgePatterns = mergeCounters(remote.tokenAgePatterns, safeCurrent.tokenAgePatterns);
  merged.exitClassificationStats = mergeCounters(remote.exitClassificationStats, safeCurrent.exitClassificationStats);
  merged.indicatorPatterns = mergeCounters(remote.indicatorPatterns, safeCurrent.indicatorPatterns);

  return merged;
}

/**
 * Validator: throws if MERGE_KEYS doesn't cover every key in MEMORY_DATA_SHAPE.
 * Called by tests; can also be called at boot for early-warn.
 */
function assertMergeCoverage() {
  const shapeKeys = Object.keys(MEMORY_DATA_SHAPE);
  const missing = shapeKeys.filter((k) => !MERGE_KEYS.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `[memory/merge] MERGE_KEYS does not cover data shape keys: ${missing.join(', ')}. ` +
      `Add them to MERGE_KEYS in merge.js AND extend mergeFromRemote() to handle them, ` +
      `or they will be silently wiped on every SQL merge (regression of 2026-05-16 bug).`
    );
  }
  const extra = MERGE_KEYS.filter((k) => !shapeKeys.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `[memory/merge] MERGE_KEYS lists keys not in data shape: ${extra.join(', ')}. ` +
      `Remove them from MERGE_KEYS OR add them to shape.js MEMORY_DATA_SHAPE.`
    );
  }
}

module.exports = {
  MERGE_KEYS,
  mergeFromRemote,
  mergeArrayById,
  mergeMap,
  mergeCounters,
  assertMergeCoverage,
};
