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
const { runV2RiskAudit } = require('./v2-risk-audit');

const CACHE_TTL_MS = Number(process.env.PRE_TRADE_CACHE_TTL_MS) || 60_000;
const DEFAULT_MODE = (process.env.PRE_TRADE_CONTRACT_MODE || 'shadow').toLowerCase();
const DEFAULT_V2_RISK_ENFORCEMENT_MODE = normalizeV2RiskEnforcementMode(process.env.V2_RISK_ENFORCEMENT_MODE);
const ENFORCE = DEFAULT_MODE === 'enforce';

function parseBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function parseNumberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function uniqueLower(values) {
  return [...new Set((values || [])
    .map((item) => String(item == null ? '' : item).trim().toLowerCase())
    .filter(Boolean))];
}

function botProfileAliases(scope) {
  const raw = String(scope || '').trim().toLowerCase();
  if (raw === 'live' || raw === 'live_spot') return ['live', 'live_spot'];
  if (raw === 'paper' || raw === 'paper_spot') return ['paper', 'paper_spot'];
  if (raw === 'perps' || raw === 'paper_perps') return ['perps', 'paper_perps'];
  return uniqueLower([raw || 'global']);
}

function strategyAliases(strategy) {
  const key = String(strategy || '').trim().toLowerCase();
  if (!key) return [];
  if (['backes', 'backes_swing', 'swing'].includes(key)) return ['backes', 'backes_swing', 'swing'];
  return [key];
}

function setupAliases(trade = {}) {
  return uniqueLower([
    trade.setupType,
    trade.setup_type,
    trade.setup,
    trade.strategySubtype,
  ]);
}

function addSqlInParams(req, prefix, values) {
  const names = [];
  values.forEach((value, index) => {
    const name = `${prefix}${index}`;
    req.input(name, value);
    names.push(`@${name}`);
  });
  return names.length ? names.join(', ') : "''";
}

function normalizePerformanceRow(row = {}, label, scope, thresholds) {
  const closedTrades = Number(row.closed_trades || 0);
  const grossProfitUsd = Number(row.gross_profit_usd || 0);
  const grossLossUsd = Number(row.gross_loss_usd || 0);
  const pnlUsd = Number(row.pnl_usd || 0);
  const profitFactor = grossLossUsd > 0
    ? grossProfitUsd / grossLossUsd
    : (grossProfitUsd > 0 ? 999 : 0);
  return {
    scope,
    label,
    closedTrades,
    wins: Number(row.wins || 0),
    losses: Number(row.losses || 0),
    grossProfitUsd,
    grossLossUsd,
    pnlUsd,
    profitFactor,
    expectancyUsd: closedTrades > 0 ? pnlUsd / closedTrades : 0,
    minClosedTrades: thresholds.minClosedTrades,
    minProfitFactor: thresholds.minProfitFactor,
    minExpectancyUsd: thresholds.minExpectancyUsd,
  };
}

async function queryLedgerPerformance(sql, {
  label,
  scope,
  strategyValues = [],
  setupValues = [],
  chainValues = [],
  thresholds,
}) {
  if (!sql || typeof sql.request !== 'function') {
    return { label, scope, unavailable: true, reason: 'sql_unavailable' };
  }

  try {
    const req = sql.request();
    const profileClause = addSqlInParams(req, 'profile', botProfileAliases(scope));
    const strategyClause = addSqlInParams(req, 'strategy', uniqueLower(strategyValues));
    const setupClause = addSqlInParams(req, 'setup', uniqueLower(setupValues));
    const chainClause = addSqlInParams(req, 'chain', uniqueLower(chainValues));

    const filters = [];
    if (strategyValues.length > 0) {
      filters.push(`LOWER(COALESCE(strategy, '')) IN (${strategyClause})`);
    }
    if (setupValues.length > 0) {
      filters.push(`LOWER(COALESCE(setup_type, '')) IN (${setupClause})`);
    }
    if (chainValues.length > 0) {
      filters.push(`LOWER(COALESCE(chain_key, chain, '')) IN (${chainClause})`);
    }

    const r = await req.query(`
      SELECT
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END) AS closed_trades,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' AND pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' AND pnl_usd <= 0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' AND pnl_usd > 0 THEN pnl_usd ELSE 0 END) AS gross_profit_usd,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' AND pnl_usd < 0 THEN -pnl_usd ELSE 0 END) AS gross_loss_usd,
        SUM(CASE WHEN UPPER(COALESCE(trade_type, '')) = 'SELL' THEN COALESCE(pnl_usd, 0) ELSE 0 END) AS pnl_usd
      FROM dbo.bot_trade_ledger
      WHERE LOWER(COALESCE(bot_profile, '')) IN (${profileClause})
        ${filters.length > 0 ? `AND (${filters.join(' OR ')})` : ''}
    `);
    return normalizePerformanceRow((r.recordset || [])[0] || {}, label, scope, thresholds);
  } catch (err) {
    return { label, scope, unavailable: true, reason: err?.message || String(err) };
  }
}

async function buildPerformanceAdmission(sql, { side, trade = {}, scope, strategy, config = {} }) {
  const guardConfig = config.profitabilityGuard || {};
  const normalizedScope = String(scope || '').trim().toLowerCase();
  const paperResearchOverride = (
    (normalizedScope === 'paper' || normalizedScope === 'paper_spot')
    && parseBoolEnv('PAPER_DISABLE_PROFITABILITY_GUARD', false)
  );
  const configuredEnabled = guardConfig.enabled != null
    ? guardConfig.enabled !== false
    : parseBoolEnv('PROFITABILITY_GUARD_ENABLED', true);
  const enabled = configuredEnabled && !paperResearchOverride;
  const minClosedTrades = Number.isFinite(Number(guardConfig.minClosedTrades))
    ? Number(guardConfig.minClosedTrades)
    : parseNumberEnv('PROFITABILITY_GUARD_MIN_CLOSED_TRADES', 20);
  const minProfitFactor = Number.isFinite(Number(guardConfig.minProfitFactor))
    ? Number(guardConfig.minProfitFactor)
    : parseNumberEnv('PROFITABILITY_GUARD_MIN_PROFIT_FACTOR', 1);
  const minExpectancyUsd = Number.isFinite(Number(guardConfig.minExpectancyUsd))
    ? Number(guardConfig.minExpectancyUsd)
    : parseNumberEnv('PROFITABILITY_GUARD_MIN_EXPECTANCY_USD', 0);
  const thresholds = { minClosedTrades, minProfitFactor, minExpectancyUsd };

  if (!enabled || side !== 'BUY') {
    return { enabled, paperResearchOverride, checks: [], ...thresholds };
  }

  const chainValues = uniqueLower([trade.chain, trade.chainKey, trade.chain_key]);
  const strategyValues = strategyAliases(strategy);
  const setupValues = setupAliases(trade);
  const checks = [];

  if (strategyValues.length > 0) {
    checks.push(await queryLedgerPerformance(sql, {
      label: `strategy:${strategyValues[0]}`,
      scope,
      strategyValues,
      setupValues: [],
      chainValues: [],
      thresholds,
    }));
  }
  if (setupValues.length > 0) {
    checks.push(await queryLedgerPerformance(sql, {
      label: `setup:${setupValues[0]}`,
      scope,
      strategyValues: [],
      setupValues,
      chainValues: [],
      thresholds,
    }));
  }
  if (chainValues.length > 0) {
    checks.push(await queryLedgerPerformance(sql, {
      label: `chain:${chainValues[0]}`,
      scope,
      strategyValues: [],
      setupValues: [],
      chainValues,
      thresholds,
    }));
  }

  return {
    enabled,
    ...thresholds,
    checks,
  };
}

function normalizeV2RiskEnforcementMode(value) {
  const mode = String(value || 'advisory').trim().toLowerCase();
  if (mode === 'enforce') return 'block_core';
  return mode === 'block_core' ? mode : 'advisory';
}

function normalizeV2BotProfile(scope = 'global') {
  const key = String(scope || '').trim().toLowerCase();
  if (key === 'live') return 'live_spot';
  if (key === 'paper') return 'paper_spot';
  if (key === 'perps') return 'paper_perps';
  return key || 'global';
}

function parseCsvSet(value) {
  if (Array.isArray(value)) return new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  return new Set(String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function isV2RiskEnforcementActiveForScope(scope, config = {}) {
  const rawProfiles = config.v2RiskEnforceProfiles
    ?? config.v2RiskEnforcementProfiles
    ?? process.env.V2_RISK_ENFORCE_PROFILES
    ?? process.env.V2_RISK_ENFORCEMENT_PROFILES;
  const profiles = parseCsvSet(rawProfiles);
  if (profiles.size === 0) return true;
  const normalized = normalizeV2BotProfile(scope);
  const rawScope = String(scope || '').trim().toLowerCase();
  return profiles.has(normalized) || profiles.has(rawScope);
}

function shouldBlockForV2RiskAudit(v2RiskAudit, mode, scope, config = {}) {
  if (!v2RiskAudit || v2RiskAudit.enabled !== true) return false;
  const normalizedMode = normalizeV2RiskEnforcementMode(mode);
  if (normalizedMode === 'advisory') return false;
  if (!isV2RiskEnforcementActiveForScope(scope, config)) return false;
  return normalizedMode === 'block_core' && v2RiskAudit.coreBlocked === true;
}

function buildV2BlockedRows(v2RiskAudit, mode) {
  if (!v2RiskAudit || v2RiskAudit.coreBlocked !== true) return [];
  const reasons = Array.isArray(v2RiskAudit.reasons) && v2RiskAudit.reasons.length > 0
    ? v2RiskAudit.reasons
    : ['v2_risk_contract_blocked'];
  return reasons.map((reason) => ({
    gate: 'v2_risk_contract',
    severity: 'block',
    reason,
    metadata: {
      enforcementMode: normalizeV2RiskEnforcementMode(mode),
      legacyBlocked: v2RiskAudit.legacyBlocked === true,
      coreBlocked: v2RiskAudit.coreBlocked === true,
      disagreement: v2RiskAudit.disagreement === true,
    },
  }));
}

function flattenRejectReasons(result = {}, v2BlockedRows = []) {
  return [
    ...(result.blocked || []),
    ...v2BlockedRows,
  ].map((row) => row.reason || row.gate).filter(Boolean);
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
  fullConfig.performanceAdmission = await buildPerformanceAdmission(sql, {
    side,
    trade,
    scope,
    strategy,
    config: fullConfig,
  });

  const result = check({
    side,
    trade,
    state,
    config: fullConfig,
    lookups: { sellTiers, symbolOverrides, inFlightKeys: cache.inFlight, ruleConfig },
  });

  const blockedCount = result.blocked.length;
  const v2RiskAudit = runV2RiskAudit({
    side,
    trade,
    state,
    scope,
    strategy,
    config: fullConfig,
    legacyResult: result,
    logger,
  });
  const v2RiskEnforcementMode = normalizeV2RiskEnforcementMode(
    fullConfig.v2RiskEnforcementMode || DEFAULT_V2_RISK_ENFORCEMENT_MODE,
  );
  const v2EnforcementActive = v2RiskEnforcementMode !== 'advisory'
    && isV2RiskEnforcementActiveForScope(scope, fullConfig);
  const v2Blocked = shouldBlockForV2RiskAudit(v2RiskAudit, v2RiskEnforcementMode, scope, fullConfig);
  const v2BlockedRows = v2Blocked ? buildV2BlockedRows(v2RiskAudit, v2RiskEnforcementMode) : [];
  if (v2RiskAudit && v2RiskAudit.enabled === true) {
    v2RiskAudit.enforcementMode = v2RiskEnforcementMode;
    v2RiskAudit.enforcementActive = v2EnforcementActive;
    v2RiskAudit.advisoryOnly = !v2Blocked;
  }

  const persistedResult = v2BlockedRows.length > 0
    ? { ...result, blocked: [...(result.blocked || []), ...v2BlockedRows] }
    : result;

  // Best-effort persistence — never throws upward.
  if (sql) {
    recordRejections({ sql, scope, strategy, trade, state, side, result: persistedResult, botVersion, logger }).catch(() => {});
  }

  if (blockedCount > 0 && logger && typeof logger.warn === 'function') {
    const reasons = result.blocked.map((b) => `${b.gate}: ${b.reason}`).join('; ');
    const verb = enforce ? 'BLOCKED' : 'SHADOW';
    logger.warn(`[pre-trade-contract] ${verb} ${side} ${trade.symbol || '?'} on ${trade.chain || '?'} — ${reasons}`);
  }
  if (v2Blocked && logger && typeof logger.warn === 'function') {
    const reasons = v2BlockedRows.map((row) => row.reason).join('; ');
    logger.warn(`[v2-risk-contract] BLOCKED ${side} ${trade.symbol || '?'} on ${trade.chain || '?'} — ${reasons}`);
  }

  return {
    ok: !(blockedCount > 0 && enforce) && !v2Blocked,
    mode,
    reasons: flattenRejectReasons(result, v2BlockedRows),
    result,
    v2Blocked,
    v2RiskEnforcementMode,
    v2EnforcementActive,
    v2RiskAudit,
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
