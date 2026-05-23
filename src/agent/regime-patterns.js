'use strict';

/**
 * Read-through loader for dbo.regime_patterns (M0015).
 *
 * Returns the active recommendation (size multiplier, preferred/avoid chains,
 * recommendation tag) for the current macro regime + strategy. Cached in
 * memory with 5-minute TTL; safe degradation when SQL is unavailable.
 *
 * Wire-up site: pre-trade contract. When a row exists for the current regime,
 * its size_multiplier multiplies into the existing macro sizing chain at
 * intelligenceAgent.getMacroSizeMultiplier() and avoid_chains gates the chain.
 *
 * Week 16.5 (2026-05-23). Opt-in: callers explicitly invoke `getRegimePattern`;
 * inline regime classifier (backes-macro.js) stays as the primary source.
 */

const logger = require('./../utils/logger');

const TTL_MS = Number(process.env.REGIME_PATTERNS_CACHE_TTL_MS || 5 * 60_000);
const cache = new Map(); // key=`${regime}|${strategy}|${scope}` → { row, fetchedAt }
let lastWarnAt = 0;

function _key(regime, strategy, scope) {
  return `${String(regime || '').toLowerCase()}|${String(strategy || 'momentum').toLowerCase()}|${String(scope || 'global').toLowerCase()}`;
}

function _cacheGet(regime, strategy, scope) {
  const entry = cache.get(_key(regime, strategy, scope));
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(_key(regime, strategy, scope));
    return undefined;
  }
  return entry.row;
}

function _cacheSet(regime, strategy, scope, row) {
  cache.set(_key(regime, strategy, scope), { row, fetchedAt: Date.now() });
}

/**
 * Returns the active regime_patterns row or null when none / SQL down.
 * Never throws — failures degrade silently.
 */
async function getRegimePattern({ regime, strategy = 'momentum', scope = 'global' } = {}) {
  if (!regime) return null;
  const cached = _cacheGet(regime, strategy, scope);
  if (cached !== undefined) return cached;

  const sqlEnabled = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
  if (!sqlEnabled) {
    _cacheSet(regime, strategy, scope, null);
    return null;
  }

  try {
    const { getPool } = require('./../utils/sqlServer');
    const pool = await getPool(logger).catch(() => null);
    if (!pool) {
      _cacheSet(regime, strategy, scope, null);
      return null;
    }
    const r = pool.request();
    r.input('regime', String(regime).toLowerCase());
    r.input('strategy', String(strategy).toLowerCase());
    r.input('scope', String(scope).toLowerCase());
    const result = await r.query(`
      SELECT TOP 1 regime, strategy, scope, recommendation, size_multiplier,
                   preferred_chains, avoid_chains, confidence, samples,
                   win_rate, avg_pnl_pct, source, measured_at
        FROM dbo.regime_patterns
       WHERE regime = @regime AND strategy = @strategy AND scope = @scope AND active = 1
       ORDER BY measured_at DESC, updated_at DESC
    `);
    const row = result.recordset?.[0] || null;
    _cacheSet(regime, strategy, scope, row);
    return row;
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt > 5 * 60_000) {
      logger.warn(`regime_patterns loader: ${err.message}`);
      lastWarnAt = now;
    }
    _cacheSet(regime, strategy, scope, null);
    return null;
  }
}

/**
 * Synchronous cache peek. Returns `undefined` when never fetched (caller may
 * want to prefetch). Useful in hot pre-trade paths to avoid async overhead.
 */
function getCachedRegimePattern({ regime, strategy = 'momentum', scope = 'global' } = {}) {
  return _cacheGet(regime, strategy, scope);
}

function prefetch({ regime, strategy = 'momentum', scope = 'global' } = {}) {
  getRegimePattern({ regime, strategy, scope }).catch(() => null);
}

/**
 * Convenience: derive an additional multiplier from a regime pattern row.
 * Default 1.0 (no adjustment) when row missing or zero/negative.
 */
function regimePatternSizeMultiplier(row) {
  if (!row) return 1.0;
  const m = Number(row.size_multiplier || 0);
  if (!Number.isFinite(m) || m <= 0) return 1.0;
  return m;
}

function chainAllowedByRegimePattern(row, chain) {
  if (!row || !chain) return true;
  const c = String(chain).toLowerCase();
  const avoid = String(row.avoid_chains || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (avoid.includes(c)) return false;
  const preferred = String(row.preferred_chains || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (preferred.length > 0 && !preferred.includes(c)) return false;
  return true;
}

function _flushCache() {
  cache.clear();
  lastWarnAt = 0;
}

module.exports = {
  getRegimePattern,
  getCachedRegimePattern,
  prefetch,
  regimePatternSizeMultiplier,
  chainAllowedByRegimePattern,
  _internal: { _flushCache, _key },
};
