'use strict';

// Hot-reload framework for DB-backed config knobs.
//
// Polls config tables on a fixed interval, hashes the rowset, and emits
// 'configChanged' only when the hash differs. Consumers register knobs via
// getKnob(name, fallback) — cached value returned synchronously after first
// successful load. Falls back to env vars after sustained SQL-down (>5min).
//
// Usage:
//   const hr = require('./db-hot-reload').create({ logger });
//   hr.registerSource({ key: 'strategy_config', table: 'dbo.strategy_config' });
//   hr.start();
//   const val = hr.getKnob('STRATEGY_MOMENTUM_MAX_POSITIONS', 5);
//   hr.on('configChanged', ({ key, before, after }) => { ... });

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { getPool, isSqlEnabled } = require('./sqlServer');

const DEFAULT_POLL_MS = Number(process.env.DB_HOT_RELOAD_POLL_MS || 60_000);
const SQL_DOWN_FALLBACK_MS = Number(process.env.DB_HOT_RELOAD_FALLBACK_MS || 5 * 60_000);

function rowsetHash(rows) {
  const text = JSON.stringify(rows, Object.keys(rows[0] || {}).sort());
  return crypto.createHash('sha256').update(text).digest('hex');
}

function create({ logger = console, pollMs = DEFAULT_POLL_MS, fallbackMs = SQL_DOWN_FALLBACK_MS } = {}) {
  const bus = new EventEmitter();
  const sources = new Map(); // key -> { table, query, lastHash, lastRows, lastError, lastOkAt }
  const cache = new Map();   // knobName -> { value, source, fetchedAt }
  let timer = null;
  let running = false;
  let firstLoadDone = false;
  let sqlDownSince = null;

  function registerSource({ key, table, query, transform }) {
    if (!key) throw new Error('registerSource: key required');
    if (!table && !query) throw new Error('registerSource: table or query required');
    sources.set(key, {
      table,
      query: query || `SELECT * FROM ${table} WHERE active = 1`,
      transform: transform || ((rows) => rows),
      lastHash: null,
      lastRows: [],
      lastError: null,
      lastOkAt: null,
    });
  }

  function getKnob(name, fallback) {
    const cached = cache.get(name);
    if (cached !== undefined) return cached.value;
    return fallback;
  }

  function setCacheFromRows(sourceKey, rows) {
    // Convention: each row has columns { knob, value } (string). Strategy-config
    // shape may differ; consumers can override via transform on registerSource.
    for (const r of rows) {
      if (r && r.knob !== undefined && r.value !== undefined) {
        cache.set(r.knob, { value: r.value, source: `db:${sourceKey}`, fetchedAt: Date.now() });
      }
    }
  }

  async function pollOnce() {
    if (!isSqlEnabled()) {
      maybeFallbackToEnv();
      return;
    }
    let pool;
    try {
      pool = await getPool(logger);
    } catch (_) {
      pool = null;
    }
    if (!pool) {
      registerSqlDown();
      return;
    }

    sqlDownSince = null;

    for (const [key, src] of sources.entries()) {
      try {
        const r = await pool.request().query(src.query);
        const rows = src.transform(r.recordset || []);
        const hash = rowsetHash(rows);
        if (hash !== src.lastHash) {
          const before = src.lastRows;
          src.lastRows = rows;
          src.lastHash = hash;
          src.lastError = null;
          src.lastOkAt = Date.now();
          setCacheFromRows(key, rows);
          if (firstLoadDone) {
            bus.emit('configChanged', { key, before, after: rows });
            logger.info(`[db-hot-reload] ${key}: ${rows.length} row(s) changed`);
          }
        } else {
          src.lastOkAt = Date.now();
        }
      } catch (err) {
        src.lastError = err.message;
        logger.warn(`[db-hot-reload] poll ${key} failed: ${err.message}`);
      }
    }

    firstLoadDone = true;
  }

  function registerSqlDown() {
    if (!sqlDownSince) sqlDownSince = Date.now();
    const elapsed = Date.now() - sqlDownSince;
    if (elapsed >= fallbackMs) {
      maybeFallbackToEnv();
    }
  }

  function maybeFallbackToEnv() {
    // For knobs not yet cached, leave them to fallback supplied by getKnob caller.
    // For knobs in cache: if SQL has been down long, mark source as 'env' so
    // operators can see drift. Actual value stays whatever was last cached.
    for (const [name, entry] of cache.entries()) {
      if (entry.source && entry.source.startsWith('db:')) {
        const envVal = process.env[name];
        if (envVal !== undefined) {
          cache.set(name, { value: envVal, source: 'env_fallback', fetchedAt: Date.now() });
          logger.warn(`[db-hot-reload] SQL down >${Math.round(fallbackMs / 60000)}m — knob '${name}' fell back to env`);
        }
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    pollOnce().catch((err) => logger.warn(`[db-hot-reload] initial poll failed: ${err.message}`));
    timer = setInterval(() => {
      pollOnce().catch((err) => logger.warn(`[db-hot-reload] poll failed: ${err.message}`));
    }, pollMs);
    if (timer.unref) timer.unref();
    logger.info(`[db-hot-reload] started (poll ${pollMs}ms, fallback ${fallbackMs}ms)`);
  }

  function stop() {
    running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function getStatus() {
    const out = { running, sources: {}, cacheSize: cache.size, sqlDownSince };
    for (const [k, v] of sources.entries()) {
      out.sources[k] = {
        rows: v.lastRows.length,
        lastOkAt: v.lastOkAt,
        lastError: v.lastError,
        hashShort: v.lastHash ? v.lastHash.slice(0, 12) : null,
      };
    }
    return out;
  }

  return Object.assign(bus, {
    registerSource,
    getKnob,
    start,
    stop,
    pollOnce,
    getStatus,
  });
}

module.exports = { create };
