'use strict';

/**
 * Read-through cache layer for token metadata backed by dbo.tokens (M0013).
 *
 * Lookup precedence:
 *   1. in-memory LRU (TTL configurable, default 5min) — newest-first
 *   2. dbo.tokens row where (symbol, chain) and refreshed_at within freshness window
 *   3. caller's `fetchFresh` callback (provider hit) → write-through to both layers
 *
 * Safe degradation: SQL down / table missing → in-memory cache only; never throws.
 * Caller passes the provider call as a thunk; this module is provider-agnostic.
 *
 * Week 16.5 (2026-05-23). Opt-in: scanner explicitly invokes `getTokenWithCache`;
 * existing per-scan fetches stay unchanged. Migrate hot paths one at a time.
 */

const logger = require('./logger');

const MEM_TTL_MS = Number(process.env.TOKENS_CACHE_MEM_TTL_MS || 5 * 60_000);
const SQL_FRESHNESS_MS = Number(process.env.TOKENS_CACHE_SQL_FRESHNESS_MS || 5 * 60_000);
const MAX_MEM_ENTRIES = Number(process.env.TOKENS_CACHE_MAX_ENTRIES || 2000);

// In-memory LRU: key=`${symbol}|${chain}` → { row, fetchedAt }
const mem = new Map();
let sqlWarnAt = 0;

function _key(symbol, chain) {
  return `${String(symbol || '').toUpperCase()}|${String(chain || '').toLowerCase()}`;
}

function _memGet(symbol, chain) {
  const k = _key(symbol, chain);
  const entry = mem.get(k);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MEM_TTL_MS) {
    mem.delete(k);
    return null;
  }
  // LRU touch: re-insert to move to tail
  mem.delete(k);
  mem.set(k, entry);
  return entry.row;
}

function _memSet(symbol, chain, row) {
  const k = _key(symbol, chain);
  mem.set(k, { row, fetchedAt: Date.now() });
  if (mem.size > MAX_MEM_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest) mem.delete(oldest);
  }
}

async function _sqlGet(symbol, chain) {
  const sqlEnabled = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
  if (!sqlEnabled) return null;
  try {
    const { getPool } = require('./sqlServer');
    const pool = await getPool(logger).catch(() => null);
    if (!pool) return null;
    const r = pool.request();
    r.input('symbol', String(symbol || '').toUpperCase());
    r.input('chain', String(chain || '').toLowerCase());
    r.input('cutoff', new Date(Date.now() - SQL_FRESHNESS_MS));
    const result = await r.query(`
      SELECT TOP 1 symbol, chain, address, pair_address, name, decimals,
                   liquidity_usd, volume_24h_usd, market_cap_usd, price_usd,
                   price_change_24h, txns_24h, holder_count, top_holders_pct,
                   listed_at, source, metadata_json, refreshed_at
        FROM dbo.tokens
       WHERE symbol = @symbol AND chain = @chain AND refreshed_at >= @cutoff
       ORDER BY refreshed_at DESC
    `);
    return result.recordset?.[0] || null;
  } catch (err) {
    const now = Date.now();
    if (now - sqlWarnAt > 5 * 60_000) {
      logger.warn(`tokens cache SQL lookup: ${err.message}`);
      sqlWarnAt = now;
    }
    return null;
  }
}

async function _sqlUpsert(symbol, chain, row) {
  const sqlEnabled = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
  if (!sqlEnabled || !row) return;
  try {
    const { getPool } = require('./sqlServer');
    const pool = await getPool(logger).catch(() => null);
    if (!pool) return;
    const r = pool.request();
    r.input('symbol', String(symbol || '').toUpperCase());
    r.input('chain', String(chain || '').toLowerCase());
    r.input('address', row.address || null);
    r.input('pair_address', row.pairAddress || row.pair_address || null);
    r.input('name', row.name || null);
    r.input('decimals', Number.isFinite(Number(row.decimals)) ? Number(row.decimals) : null);
    r.input('liquidity_usd', Number.isFinite(Number(row.liquidityUsd)) ? Number(row.liquidityUsd) : null);
    r.input('volume_24h_usd', Number.isFinite(Number(row.volume24h)) ? Number(row.volume24h) : null);
    r.input('market_cap_usd', Number.isFinite(Number(row.marketCap)) ? Number(row.marketCap) : null);
    r.input('price_usd', Number.isFinite(Number(row.price)) ? Number(row.price) : null);
    r.input('price_change_24h', Number.isFinite(Number(row.priceChange24h)) ? Number(row.priceChange24h) : null);
    r.input('txns_24h', Number.isFinite(Number(row.txns24h)) ? Number(row.txns24h) : null);
    r.input('holder_count', Number.isFinite(Number(row.holderCount)) ? Number(row.holderCount) : null);
    r.input('top_holders_pct', Number.isFinite(Number(row.topHoldersPct)) ? Number(row.topHoldersPct) : null);
    r.input('source', row.source || 'fetch');
    r.input('metadata_json', row.raw ? JSON.stringify(row.raw).slice(0, 200_000) : null);
    await r.query(`
      MERGE dbo.tokens AS T
      USING (SELECT @symbol AS symbol, @chain AS chain) AS S
        ON T.symbol = S.symbol AND T.chain = S.chain
      WHEN MATCHED THEN UPDATE SET
        address = COALESCE(@address, T.address),
        pair_address = COALESCE(@pair_address, T.pair_address),
        name = COALESCE(@name, T.name),
        decimals = COALESCE(@decimals, T.decimals),
        liquidity_usd = COALESCE(@liquidity_usd, T.liquidity_usd),
        volume_24h_usd = COALESCE(@volume_24h_usd, T.volume_24h_usd),
        market_cap_usd = COALESCE(@market_cap_usd, T.market_cap_usd),
        price_usd = COALESCE(@price_usd, T.price_usd),
        price_change_24h = COALESCE(@price_change_24h, T.price_change_24h),
        txns_24h = COALESCE(@txns_24h, T.txns_24h),
        holder_count = COALESCE(@holder_count, T.holder_count),
        top_holders_pct = COALESCE(@top_holders_pct, T.top_holders_pct),
        source = @source,
        metadata_json = COALESCE(@metadata_json, T.metadata_json),
        refreshed_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT
        (symbol, chain, address, pair_address, name, decimals, liquidity_usd,
         volume_24h_usd, market_cap_usd, price_usd, price_change_24h, txns_24h,
         holder_count, top_holders_pct, source, metadata_json)
        VALUES (@symbol, @chain, @address, @pair_address, @name, @decimals, @liquidity_usd,
                @volume_24h_usd, @market_cap_usd, @price_usd, @price_change_24h, @txns_24h,
                @holder_count, @top_holders_pct, @source, @metadata_json);
    `);
  } catch (err) {
    const now = Date.now();
    if (now - sqlWarnAt > 5 * 60_000) {
      logger.warn(`tokens cache SQL upsert: ${err.message}`);
      sqlWarnAt = now;
    }
  }
}

/**
 * Read-through cache. Returns the cached row when fresh; otherwise calls
 * fetchFresh and write-throughs both mem + SQL.
 *
 * @param {string} symbol
 * @param {string} chain
 * @param {() => Promise<object>} fetchFresh — provider call returning a token row
 * @returns {Promise<object|null>}
 */
async function getTokenWithCache(symbol, chain, fetchFresh) {
  if (!symbol || !chain || typeof fetchFresh !== 'function') return null;

  const memHit = _memGet(symbol, chain);
  if (memHit) return memHit;

  const sqlHit = await _sqlGet(symbol, chain);
  if (sqlHit) {
    _memSet(symbol, chain, sqlHit);
    return sqlHit;
  }

  let fresh = null;
  try {
    fresh = await fetchFresh();
  } catch (err) {
    logger.debug(`tokens cache: provider fetch failed for ${symbol}/${chain}: ${err.message}`);
    return null;
  }
  if (!fresh) return null;
  _memSet(symbol, chain, fresh);
  _sqlUpsert(symbol, chain, fresh).catch(() => null); // fire-and-forget
  return fresh;
}

// Address-keyed in-memory cache for hot scanner paths (every-cycle fetches by
// tokenAddress, not symbol). Same TTL + LRU as symbol cache. SQL lookup falls
// through when address matches dbo.tokens.address — operator can disable SQL
// hit per-call to keep latency tight on hot paths.
const memByAddr = new Map();
function _keyAddr(chain, address) {
  return `${String(chain || '').toLowerCase()}|${String(address || '').toLowerCase()}`;
}

function _memGetByAddr(chain, address) {
  const k = _keyAddr(chain, address);
  const entry = memByAddr.get(k);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MEM_TTL_MS) {
    memByAddr.delete(k);
    return null;
  }
  memByAddr.delete(k);
  memByAddr.set(k, entry);
  return entry.row;
}

function _memSetByAddr(chain, address, row) {
  const k = _keyAddr(chain, address);
  memByAddr.set(k, { row, fetchedAt: Date.now() });
  if (memByAddr.size > MAX_MEM_ENTRIES) {
    const oldest = memByAddr.keys().next().value;
    if (oldest) memByAddr.delete(oldest);
  }
}

/**
 * Address-keyed read-through cache. Cheaper than symbol path — no SQL lookup
 * by default since scanner cycles are latency-sensitive. Caller can opt in to
 * SQL via `{ sql: true }`. write-through still updates SQL (fire-and-forget).
 *
 * @param {string} chain - chain key e.g. 'kucoin', 'bsc'
 * @param {string} address - token address (case-insensitive)
 * @param {() => Promise<object>} fetchFresh - provider thunk returning token row
 * @param {object} opts - { sql?: boolean }
 */
async function getTokenByAddressWithCache(chain, address, fetchFresh, opts = {}) {
  if (!chain || !address || typeof fetchFresh !== 'function') return null;

  const memHit = _memGetByAddr(chain, address);
  if (memHit) return memHit;

  if (opts.sql) {
    const sqlEnabled = String(process.env.SQL_ENABLED || '').toLowerCase() === 'true';
    if (sqlEnabled) {
      try {
        const { getPool } = require('./sqlServer');
        const pool = await getPool(logger).catch(() => null);
        if (pool) {
          const r = pool.request();
          r.input('chain', String(chain).toLowerCase());
          r.input('address', String(address).toLowerCase());
          r.input('cutoff', new Date(Date.now() - SQL_FRESHNESS_MS));
          const result = await r.query(`
            SELECT TOP 1 symbol, chain, address, pair_address, name, decimals,
                         liquidity_usd, volume_24h_usd, market_cap_usd, price_usd,
                         price_change_24h, txns_24h, holder_count, top_holders_pct,
                         listed_at, source, metadata_json, refreshed_at
              FROM dbo.tokens
             WHERE chain = @chain AND LOWER(address) = @address AND refreshed_at >= @cutoff
             ORDER BY refreshed_at DESC
          `);
          const row = result.recordset?.[0] || null;
          if (row) {
            _memSetByAddr(chain, address, row);
            return row;
          }
        }
      } catch (err) {
        const now = Date.now();
        if (now - sqlWarnAt > 5 * 60_000) {
          logger.warn(`tokens cache (addr) SQL lookup: ${err.message}`);
          sqlWarnAt = now;
        }
      }
    }
  }

  let fresh = null;
  try {
    fresh = await fetchFresh();
  } catch (err) {
    logger.debug(`tokens cache (addr): provider fetch failed for ${chain}:${address}: ${err.message}`);
    return null;
  }
  if (!fresh) return null;
  _memSetByAddr(chain, address, fresh);
  if (fresh.symbol) {
    _memSet(fresh.symbol, chain, fresh);
    _sqlUpsert(fresh.symbol, chain, { ...fresh, address }).catch(() => null);
  }
  return fresh;
}

function getStats() {
  return {
    memSize: mem.size,
    memByAddrSize: memByAddr.size,
    memTtlMs: MEM_TTL_MS,
    sqlFreshnessMs: SQL_FRESHNESS_MS,
  };
}

function _flushCache() {
  mem.clear();
  memByAddr.clear();
  sqlWarnAt = 0;
}

module.exports = {
  getTokenWithCache,
  getTokenByAddressWithCache,
  getStats,
  _internal: { _flushCache, _key, _keyAddr },
};
