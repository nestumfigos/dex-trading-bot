'use strict';

/**
 * AI prompt template loader (Week 16.5). Mirrors live commit.
 *
 * Reads active row from dbo.ai_prompts by (name, scope) and renders the
 * template with {{placeholder}} substitution. In-memory 5-minute cache.
 * Sync peek + background prefetch keeps call sites synchronous.
 */

const logger = require('../utils/logger');

const TTL_MS = Number(process.env.AI_PROMPT_CACHE_TTL_MS || 5 * 60 * 1000);
const cache = new Map();
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

async function loadPrompt(name, { scope = 'global' } = {}) {
  if (!name) return null;
  const cached = _cacheGet(name, scope);
  if (cached !== null) return cached;

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

function getCachedPrompt(name, { scope = 'global' } = {}) {
  const entry = cache.get(_key(name, scope));
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(_key(name, scope));
    return undefined;
  }
  return entry.row;
}

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
