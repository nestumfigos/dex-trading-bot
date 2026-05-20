'use strict';

/**
 * Memory — blacklist helpers (pure functions on the data shape).
 *
 * Operates on the `tokenBlacklist` map (keyed by upper-case symbol) within
 * the AgentMemory data shape. Pure: caller passes `data` + optional `logger`,
 * functions mutate `data.tokenBlacklist` directly. The agentMemory.js methods
 * are thin wrappers that also set `_dirty = true`.
 *
 * Symbol normalization: all symbols are coerced to upper-case strings so
 * `addToBlacklist('btc')` and `addToBlacklist('BTC')` hit the same bucket.
 *
 * Expiry semantics: entries are auto-pruned on `isBlacklisted` lookup
 * (lazy GC) AND on `pruneExpired` (proactive sweep called from load + save).
 */

const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;

function normSym(symbol) {
  return String(symbol || '').toUpperCase();
}

function addToBlacklist(data, symbol, reason, durationMs = DEFAULT_DURATION_MS, source = 'memory', { now = Date.now(), logger = null } = {}) {
  if (!data || !data.tokenBlacklist) {
    throw new Error('addToBlacklist: data.tokenBlacklist required');
  }
  const sym = normSym(symbol);
  if (!sym) return false;
  data.tokenBlacklist[sym] = {
    reason: String(reason || '').slice(0, 200),
    source,
    addedAt: now,
    expiresAt: now + Math.max(0, Number(durationMs) || 0),
  };
  if (logger && typeof logger.warn === 'function') {
    const reasonStr = String(reason || '').slice(0, 80);
    logger.warn(`[AgentMemory] ${sym} blacklisted for ${Math.round(durationMs / 3_600_000)}h: ${reasonStr}`);
  }
  return true;
}

function removeFromBlacklist(data, symbol) {
  if (!data || !data.tokenBlacklist) return false;
  const sym = normSym(symbol);
  if (!sym) return false;
  if (!(sym in data.tokenBlacklist)) return false;
  delete data.tokenBlacklist[sym];
  return true;
}

function isBlacklisted(data, symbol, { now = Date.now() } = {}) {
  if (!data || !data.tokenBlacklist) return { blacklisted: false };
  const sym = normSym(symbol);
  const entry = data.tokenBlacklist[sym];
  if (!entry) return { blacklisted: false };
  if (entry.expiresAt && now > entry.expiresAt) {
    delete data.tokenBlacklist[sym];
    return { blacklisted: false };
  }
  return { blacklisted: true, reason: entry.reason, source: entry.source };
}

function pruneExpired(data, { now = Date.now() } = {}) {
  if (!data || !data.tokenBlacklist) return 0;
  let pruned = 0;
  for (const [sym, entry] of Object.entries(data.tokenBlacklist)) {
    if (entry.expiresAt && now > entry.expiresAt) {
      delete data.tokenBlacklist[sym];
      pruned += 1;
    }
  }
  return pruned;
}

function getAllBlacklisted(data) {
  if (!data || !data.tokenBlacklist) return [];
  return Object.keys(data.tokenBlacklist);
}

// Week 11.6 — load blacklist from dbo.symbol_overrides at boot/refresh.
// Merges DB rows into in-memory blacklist. DB row source='db' to distinguish
// from in-memory adds. Idempotent on re-call (overwrites prior db-sourced entries).
async function loadFromSqlOverrides({ pool, scope = 'live', data, now = Date.now(), logger = null } = {}) {
  if (!pool || !data || !data.tokenBlacklist) {
    return { loaded: 0, skipped: true };
  }
  try {
    const req = pool.request();
    req.input('scope', scope);
    const r = await req.query(`
      SELECT symbol, chain, action, value, expires_at
        FROM dbo.symbol_overrides
       WHERE active = 1
         AND scope IN (@scope, 'global')
         AND action = 'block'
         AND (expires_at IS NULL OR expires_at > GETUTCDATE())
    `);
    let loaded = 0;
    for (const row of (r.recordset || [])) {
      const sym = normSym(row.symbol);
      if (!sym) continue;
      const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : (now + DEFAULT_DURATION_MS);
      const reason = String(row.value || 'sql_override').slice(0, 200);
      data.tokenBlacklist[sym] = {
        reason,
        source: 'db',
        addedAt: now,
        expiresAt,
      };
      loaded += 1;
    }
    if (logger && typeof logger.info === 'function' && loaded > 0) {
      logger.info(`[AgentMemory/blacklist] loaded ${loaded} block overrides from symbol_overrides (scope=${scope})`);
    }
    return { loaded };
  } catch (e) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(`[AgentMemory/blacklist] sql load failed: ${e?.message || e}`);
    }
    return { loaded: 0, error: e?.message || String(e) };
  }
}

module.exports = {
  addToBlacklist,
  removeFromBlacklist,
  isBlacklisted,
  pruneExpired,
  getAllBlacklisted,
  loadFromSqlOverrides,
  DEFAULT_DURATION_MS,
};
