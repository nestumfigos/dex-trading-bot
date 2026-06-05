'use strict';

/**
 * Pre-Trade Contract — Runtime Adapter.
 *
 * Wraps src/risk/pre-trade-contract with:
 *   - SQL-backed caches for risk_rules / symbol_overrides / sell_tiers (refreshed via TTL)
 *   - Shadow vs. enforce mode (env: PRE_TRADE_CONTRACT_MODE=shadow|enforce)
 *   - Defense-in-depth: any cache/SQL failure → degrade open (no block)
 *   - Best-effort rejection persistence (failures swallowed)
 *
 * Designed for one-line wiring into executeBuy/executeSell:
 *     const pt = await runPreTrade({ side: 'BUY', trade, state, scope, strategy });
 *     if (!pt.ok) return;     // block (only in enforce mode)
 */

const { check, recordRejections } = require('./pre-trade-contract');

const CACHE_TTL_MS = Number(process.env.PRE_TRADE_CACHE_TTL_MS) || 60_000;
const DEFAULT_MODE = (process.env.PRE_TRADE_CONTRACT_MODE || 'shadow').toLowerCase();
const ENFORCE = DEFAULT_MODE === 'enforce';

function parseBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

// Single-process caches; lifetime = process.
const cache = {
  rules:     { value: new Map(),       ts: 0 },
  overrides: { value: [],              ts: 0 },
  tiers:     { value: new Map(),       ts: 0 },  // key=`${scope}:${strategy}` → tier array
  inFlight:  new Set(),                          // mutated by registerInFlight/release
};

function isFresh(entry) {
  return entry && Date.now() - entry.ts < CACHE_TTL_MS;
}

async function loadRiskRules(sql, scope) {
  if (isFresh(cache.rules) && cache.rules.scope === scope) return cache.rules.value;
  if (!sql || typeof sql.request !== 'function') return new Map();

  try {
    const req = sql.request();
    req.input('scope', scope);
    const r = await req.query(`
      SELECT name, scope, severity, enabled
        FROM dbo.risk_rules
       WHERE scope IN (@scope, 'global')
    `);
    const map = new Map();
    for (const row of (r.recordset || [])) {
      // scope-specific overrides global
      const existing = map.get(row.name);
      if (existing && existing.scopeOverride) continue;
      map.set(row.name, {
        enabled: row.enabled !== false,
        severity: row.severity || 'block',
        scopeOverride: row.scope === scope,
      });
    }
    cache.rules = { value: map, ts: Date.now(), scope };
    return map;
  } catch {
    return cache.rules.value || new Map(); // serve stale on error
  }
}

async function loadSymbolOverrides(sql) {
  if (isFresh(cache.overrides)) return cache.overrides.value;
  if (!sql || typeof sql.request !== 'function') return [];

  try {
    const r = await sql.request().query(`
      SELECT id, symbol, chain, scope, action, value, source, expires_at, active
        FROM dbo.symbol_overrides
       WHERE active = 1
    `);
    const arr = (r.recordset || []);
    cache.overrides = { value: arr, ts: Date.now() };
    return arr;
  } catch {
    return cache.overrides.value || [];
  }
}

async function loadSellTiers(sql, scope, strategy) {
  const key = `${scope}:${strategy}`;
  const cached = cache.tiers.value.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;
  if (!sql || typeof sql.request !== 'function') return [];

  try {
    const req = sql.request();
    req.input('scope', scope);
    req.input('strategy', strategy);
    const r = await req.query(`
      SELECT tier_index, profit_multiplier, sell_pct, min_notional_usd, chain
        FROM dbo.sell_tiers
       WHERE strategy = @strategy AND scope IN (@scope, 'global') AND active = 1
       ORDER BY tier_index
    `);
    const tiers = (r.recordset || []).map((t) => ({
      tierIndex:        t.tier_index,
      profitMultiplier: t.profit_multiplier,
      sellPct:          t.sell_pct,
      minNotionalUsd:   t.min_notional_usd,
      chain:            t.chain,
    }));
    cache.tiers.value.set(key, { value: tiers, ts: Date.now() });
    return tiers;
  } catch {
    return cached?.value || [];
  }
}

function inFlightKey(side, chain, addressOrSymbol) {
  return `${String(side).toLowerCase()}:${String(chain).toLowerCase()}:${String(addressOrSymbol).toLowerCase()}`;
}

function registerInFlight(side, chain, addressOrSymbol) {
  cache.inFlight.add(inFlightKey(side, chain, addressOrSymbol));
}

function releaseInFlight(side, chain, addressOrSymbol) {
  cache.inFlight.delete(inFlightKey(side, chain, addressOrSymbol));
}

function invalidateCaches() {
  cache.rules = { value: new Map(), ts: 0 };
  cache.overrides = { value: [], ts: 0 };
  cache.tiers = { value: new Map(), ts: 0 };
}

/**
 * Main entry point. Resolves with { ok, mode, result }.
 *
 *   ok=false only when blocked AND mode==='enforce'.
 *   Always returns the gate result for observability.
 *
 * @param {Object} args
 * @param {'BUY'|'SELL'} args.side
 * @param {Object} args.trade           { symbol, chain, address, sizeUsd, positionValueUsd }
 * @param {Object} args.state           { walletUsd, todaysPnlUsd, consecutiveLosses, aiCircuitOpen }
 * @param {string} args.scope           'live' | 'paper'
 * @param {string} args.strategy
 * @param {Object} args.config          per-call overrides
 * @param {Object} args.sql             optional SQL pool (db: down → degrade open)
 * @param {Object} args.logger          optional
 * @param {string} args.botVersion      optional
 */
async function runPreTrade({
  side,
  trade = {},
  state = {},
  scope = 'global',
  strategy = 'momentum',
  config: ctxConfig = {},
  sql,
  logger,
  botVersion,
} = {}) {
  const mode = ctxConfig.mode || DEFAULT_MODE;
  const enforce = mode === 'enforce';
  const paperConsecutiveLossGateDisabled = scope === 'paper'
    && parseBoolEnv('PAPER_DISABLE_CONSECUTIVE_LOSS_GATE', false);

  const [ruleConfig, symbolOverrides, sellTiers] = await Promise.all([
    loadRiskRules(sql, scope),
    loadSymbolOverrides(sql),
    loadSellTiers(sql, scope, strategy),
  ]);

  const fullConfig = {
    scope,
    minSizeUsd:            Number(process.env.MIN_POSITION_SIZE_USD) || 6,
    maxPctOfWallet:        Number(process.env.MAX_POSITION_PCT_OF_WALLET) || 0.25,
    minNotionalUsd:        Number(process.env.EXCHANGE_MIN_NOTIONAL_USD) || 1,
    dailyDrawdownLimitUsd: Number(process.env.DAILY_DRAWDOWN_LIMIT_USD) || 0,
    maxConsecutiveLosses:  paperConsecutiveLossGateDisabled ? 0 : Number(process.env.MAX_CONSECUTIVE_LOSSES) || 0,
    aiOverride:            !!ctxConfig.aiOverride,
    ...ctxConfig,
  };

  const result = check({
    side,
    trade,
    state,
    config: fullConfig,
    lookups: { sellTiers, symbolOverrides, inFlightKeys: cache.inFlight, ruleConfig },
  });

  // Best-effort persistence — never throws upward.
  if (sql) {
    recordRejections({ sql, scope, strategy, trade, state, side, result, botVersion, logger }).catch(() => {});
  }

  const blockedCount = result.blocked.length;
  if (blockedCount > 0 && logger && typeof logger.warn === 'function') {
    const reasons = result.blocked.map((b) => `${b.gate}: ${b.reason}`).join('; ');
    const verb = enforce ? 'BLOCKED' : 'SHADOW';
    logger.warn(`[pre-trade-contract] ${verb} ${side} ${trade.symbol || '?'} on ${trade.chain || '?'} — ${reasons}`);
  }

  return {
    ok: !(blockedCount > 0 && enforce),
    mode,
    result,
  };
}

module.exports = {
  runPreTrade,
  registerInFlight,
  releaseInFlight,
  invalidateCaches,
  // Exposed for tests / dashboard introspection
  _cache: cache,
  _ENFORCE: ENFORCE,
};
