'use strict';

/**
 * AI prompt template loader (Week 16.5).
 *
 * Reads the active row from dbo.ai_prompts by (name, scope) and renders the
 * template with {{placeholder}} substitution. In-memory 5-minute cache keyed
 * by (name, scope). Falls back to a caller-supplied builder when:
 *   - SQL pool unavailable (offline / not configured)
 *   - No active row matches (name, scope)
 *   - Query throws
 *
 * Usage:
 *   const tpl = await loadPrompt('anthropic_trade_signal', { scope: 'global' });
 *   const rendered = tpl ? renderTemplate(tpl.template, vars) : fallback();
 *
 * The fallback path is what currently runs everywhere — the loader is purely
 * additive. Operators can populate ai_prompts via scripts/seed-ai-prompts.js
 * (not yet written; see W16.5 deferral note in checklist) or via direct INSERT.
 */

const logger = require('../utils/logger');

const TTL_MS = Number(process.env.AI_PROMPT_CACHE_TTL_MS || 5 * 60 * 1000);
const cache = new Map(); // key=`${name}|${scope}` → { row, fetchedAt }
let lastWarnAt = 0;

function _key(name, scope) {
  return `${String(name || '').toLowerCase()}|${String(scope || 'global').toLowerCase()}`;
}

function _cacheGet(name, scope) {
  const entry = cache.get(_key(name, scope));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(_key(name, scope));
    return null;
  }
  return entry.row;
}

function _cacheSet(name, scope, row) {
  cache.set(_key(name, scope), { row, fetchedAt: Date.now() });
}

/**
 * Returns { template, system_msg, version, source } or null when not found / SQL down.
 * Never throws — failures degrade silently and the caller falls back to inline.
 */
async function loadPrompt(name, { scope = 'global' } = {}) {
  if (!name) return null;
  const cached = _cacheGet(name, scope);
  if (cached !== null) return cached;

  // Negative-cache misses with a short TTL so we don't hammer SQL when the
  // row simply doesn't exist yet (typical pre-seed state).
  const sqlEnabled = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
  if (!sqlEnabled) {
    _cacheSet(name, scope, null);
    return null;
  }

  try {
    const { getPool } = require('../utils/sqlServer');
    const pool = await getPool(logger).catch(() => null);
    if (!pool) {
      _cacheSet(name, scope, null);
      return null;
    }
    const r = pool.request();
    r.input('name', name);
    r.input('scope', String(scope || 'global').toLowerCase());
    const result = await r.query(`
      SELECT TOP 1 name, version, scope, provider, template, system_msg, source
        FROM dbo.ai_prompts
       WHERE name = @name AND scope = @scope AND active = 1
       ORDER BY version DESC
    `);
    const row = result.recordset?.[0] || null;
    _cacheSet(name, scope, row);
    return row;
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt > 5 * 60_000) {
      logger.warn(`ai_prompts loader: ${err.message}`);
      lastWarnAt = now;
    }
    _cacheSet(name, scope, null);
    return null;
  }
}

/**
 * Replace {{placeholder}} tokens in a template with values from `vars`.
 * Missing keys leave the placeholder as-is so callers can detect drift.
 */
function renderTemplate(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      if (v === null || v === undefined) return '';
      return typeof v === 'string' ? v : JSON.stringify(v);
    }
    return m;
  });
}

/**
 * Synchronous cache peek. Returns the cached row, or `undefined` when
 * never fetched (caller should also prefetch()), or `null` when a prior
 * fetch confirmed no active row exists.
 */
function getCachedPrompt(name, { scope = 'global' } = {}) {
  const entry = cache.get(_key(name, scope));
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(_key(name, scope));
    return undefined;
  }
  return entry.row;
}

/** Fire-and-forget background prefetch. Caller does not await. */
function prefetch(name, { scope = 'global' } = {}) {
  loadPrompt(name, { scope }).catch(() => null);
}

function _flushCache() {
  cache.clear();
  lastWarnAt = 0;
}

module.exports = {
  loadPrompt,
  renderTemplate,
  getCachedPrompt,
  prefetch,
  _internal: { _flushCache, _key },
};
