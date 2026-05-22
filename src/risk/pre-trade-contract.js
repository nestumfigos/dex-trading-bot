'use strict';

/**
 * Pre-Trade Contract — Week 3 / Track B.
 *
 * Pure dependency-injected gate suite. Every executeBuy/executeSell call
 * routes through `check()` before the existing exchange-flow runs. Failing
 * gates short-circuit the trade and log to `dbo.trade_rejections`.
 *
 * Gate catalog (M009 risk_rules entries):
 *   tier_feasibility       — sellPct × valueUsd ≥ min_notional_usd
 *   position_size          — MIN_POSITION_SIZE_USD ≤ size ≤ MAX_POSITION_PCT × wallet
 *   symbol_block           — symbol_overrides.action='block' for (scope, symbol, chain)
 *   duplicate_order        — no in-flight buy/sell on the same key
 *   daily_loss_budget      — today's PnL > -DAILY_DRAWDOWN_LIMIT_USD
 *   consecutive_loss_streak— current losing streak < MAX_CONSECUTIVE_LOSSES
 *   ai_circuit             — AI circuit closed OR explicit override flag
 *
 * Severity is per-rule (risk_rules.severity): block | warn | log.
 *   block — short-circuit + skip trade
 *   warn  — allow trade but record rejection row
 *   log   — record only, no telemetry impact
 *
 * Defense-in-depth: gates degrade gracefully if SQL is down (env/default).
 * Bot still trades; rejections silently drop until SQL returns.
 */

const DEFAULT_SEVERITY = 'block';

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function lc(v) {
  return String(v == null ? '' : v).toLowerCase();
}

// ─── Pure gate functions ───────────────────────────────────────────────────

function checkTierFeasibility({ side, positionValueUsd, sellTiers, minNotionalUsd }) {
  if (side !== 'BUY') return { pass: true };
  if (!Array.isArray(sellTiers) || sellTiers.length === 0) return { pass: true };
  if (!Number.isFinite(positionValueUsd) || positionValueUsd <= 0) return { pass: true };
  const minSellPct = Math.min(...sellTiers.map((t) => num(t.sellPct, 1)).filter(Number.isFinite));
  const floor = num(minNotionalUsd, 1);
  const smallestTierUsd = positionValueUsd * minSellPct;
  if (smallestTierUsd < floor) {
    return {
      pass: false,
      reason: `smallest tier (${minSellPct * 100}% of $${positionValueUsd.toFixed(2)} = $${smallestTierUsd.toFixed(2)}) below min notional $${floor.toFixed(2)}`,
      metadata: { smallestTierUsd, minNotionalUsd: floor, minSellPct },
    };
  }
  return { pass: true };
}

function checkPositionSize({ side, sizeUsd, walletUsd, minSizeUsd, maxPctOfWallet }) {
  if (side !== 'BUY') return { pass: true };
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
    return { pass: false, reason: `sizeUsd not finite (${sizeUsd})`, metadata: { sizeUsd } };
  }
  const min = num(minSizeUsd, 6);
  if (sizeUsd < min) {
    return { pass: false, reason: `size $${sizeUsd.toFixed(2)} < MIN_POSITION_SIZE_USD $${min}`, metadata: { sizeUsd, minSizeUsd: min } };
  }
  if (Number.isFinite(walletUsd) && walletUsd > 0) {
    const maxPct = num(maxPctOfWallet, 0.25);
    const ceiling = walletUsd * maxPct;
    if (sizeUsd > ceiling) {
      return { pass: false, reason: `size $${sizeUsd.toFixed(2)} > ${(maxPct * 100).toFixed(0)}% wallet ($${ceiling.toFixed(2)})`, metadata: { sizeUsd, walletUsd, maxPct } };
    }
  }
  return { pass: true };
}

function checkSymbolBlock({ symbol, chain, scope, symbolOverrides }) {
  if (!Array.isArray(symbolOverrides) || symbolOverrides.length === 0) return { pass: true };
  const sym = lc(symbol);
  const ch = lc(chain);
  const sc = lc(scope);
  for (const o of symbolOverrides) {
    if (lc(o.action) !== 'block') continue;
    if (lc(o.symbol) !== sym) continue;
    if (lc(o.chain) !== ch) continue;
    const oScope = lc(o.scope);
    if (oScope !== 'global' && oScope !== sc) continue;
    if (o.active === false) continue;
    if (o.expires_at && new Date(o.expires_at).getTime() < Date.now()) continue;
    return { pass: false, reason: `symbol blocked: ${o.reason || 'no reason given'}`, metadata: { override_id: o.id, source: o.source } };
  }
  return { pass: true };
}

function checkDuplicateOrder({ side, symbol, chain, address, inFlightKeys }) {
  if (!inFlightKeys || typeof inFlightKeys.has !== 'function') return { pass: true };
  const key = `${lc(side)}:${lc(chain)}:${lc(address || symbol)}`;
  if (inFlightKeys.has(key)) {
    return { pass: false, reason: `duplicate ${side} in flight for ${symbol} on ${chain}`, metadata: { key } };
  }
  return { pass: true };
}

function checkDailyLossBudget({ todaysPnlUsd, dailyDrawdownLimitUsd }) {
  const pnl = num(todaysPnlUsd, 0);
  const limit = num(dailyDrawdownLimitUsd, Infinity);
  if (!Number.isFinite(limit) || limit <= 0) return { pass: true };
  if (pnl <= -limit) {
    return { pass: false, reason: `daily PnL $${pnl.toFixed(2)} ≤ -$${limit.toFixed(2)} drawdown limit`, metadata: { todaysPnlUsd: pnl, dailyDrawdownLimitUsd: limit } };
  }
  return { pass: true };
}

function checkConsecutiveLossStreak({ consecutiveLosses, maxConsecutiveLosses }) {
  const cur = num(consecutiveLosses, 0);
  const max = num(maxConsecutiveLosses, Infinity);
  if (!Number.isFinite(max) || max <= 0) return { pass: true };
  if (cur >= max) {
    return { pass: false, reason: `consecutive losses ${cur} ≥ MAX_CONSECUTIVE_LOSSES ${max}`, metadata: { consecutiveLosses: cur, maxConsecutiveLosses: max } };
  }
  return { pass: true };
}

function checkAiCircuit({ aiCircuitOpen, aiOverride }) {
  if (aiCircuitOpen && !aiOverride) {
    return { pass: false, reason: 'AI circuit OPEN (no explicit override)', metadata: { aiCircuitOpen: true } };
  }
  return { pass: true };
}

// ─── Catalog (mirrors seed-risk-rules.js) ──────────────────────────────────

const GATE_CATALOG = Object.freeze([
  { name: 'tier_feasibility',        sides: ['BUY'],          description: 'Smallest sell tier must exceed exchange min notional' },
  { name: 'position_size',           sides: ['BUY'],          description: 'Size in [MIN_POSITION_SIZE_USD, MAX_POSITION_PCT × wallet]' },
  { name: 'symbol_block',            sides: ['BUY', 'SELL'],  description: 'symbol_overrides action=block respected' },
  { name: 'duplicate_order',         sides: ['BUY', 'SELL'],  description: 'No in-flight order for same symbol+side+chain' },
  { name: 'daily_loss_budget',       sides: ['BUY'],          description: "Today's PnL above -DAILY_DRAWDOWN_LIMIT_USD" },
  { name: 'consecutive_loss_streak', sides: ['BUY'],          description: 'Current losing streak under MAX_CONSECUTIVE_LOSSES' },
  { name: 'ai_circuit',              sides: ['BUY'],          description: 'AI circuit closed OR explicit aiOverride flag' },
]);

const GATE_RUNNERS = Object.freeze({
  tier_feasibility:        checkTierFeasibility,
  position_size:           checkPositionSize,
  symbol_block:            checkSymbolBlock,
  duplicate_order:         checkDuplicateOrder,
  daily_loss_budget:       checkDailyLossBudget,
  consecutive_loss_streak: checkConsecutiveLossStreak,
  ai_circuit:              checkAiCircuit,
});

// ─── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Run every applicable gate. Returns { pass, blocked: [], warned: [] }.
 * Caller is expected to:
 *   - if !pass → skip trade
 *   - regardless → for each entry in blocked|warned, log to trade_rejections
 *
 * @param {Object}   ctx
 * @param {'BUY'|'SELL'} ctx.side
 * @param {Object}   ctx.trade               { symbol, chain, address, sizeUsd, positionValueUsd, strategy }
 * @param {Object}   ctx.state               { walletUsd, todaysPnlUsd, consecutiveLosses, aiCircuitOpen }
 * @param {Object}   ctx.config              tunables, falls back to env/defaults
 * @param {Object}   ctx.lookups             { sellTiers, symbolOverrides, inFlightKeys, ruleConfig: Map<name, {enabled, severity}> }
 * @returns {{pass: boolean, blocked: Array, warned: Array, logged: Array}}
 */
function check(ctx = {}) {
  const side = ctx.side === 'SELL' ? 'SELL' : 'BUY';
  const trade = ctx.trade || {};
  const state = ctx.state || {};
  const conf  = ctx.config || {};
  const look  = ctx.lookups || {};

  const ruleConfig = (look.ruleConfig && typeof look.ruleConfig.get === 'function')
    ? look.ruleConfig
    : new Map();

  const blocked = [];
  const warned  = [];
  const logged  = [];

  for (const g of GATE_CATALOG) {
    if (!g.sides.includes(side)) continue;
    const rule = ruleConfig.get(g.name) || { enabled: true, severity: DEFAULT_SEVERITY };
    if (rule.enabled === false) continue;

    const runner = GATE_RUNNERS[g.name];
    let res;
    try {
      res = runner({
        // pass everything; runners ignore what they don't need
        side,
        symbol:                trade.symbol,
        chain:                 trade.chain,
        address:               trade.address,
        sizeUsd:               trade.sizeUsd,
        positionValueUsd:      trade.positionValueUsd,
        scope:                 conf.scope || 'global',
        sellTiers:             look.sellTiers,
        symbolOverrides:       look.symbolOverrides,
        inFlightKeys:          look.inFlightKeys,
        minNotionalUsd:        conf.minNotionalUsd,
        walletUsd:             state.walletUsd,
        minSizeUsd:            conf.minSizeUsd,
        maxPctOfWallet:        conf.maxPctOfWallet,
        todaysPnlUsd:          state.todaysPnlUsd,
        dailyDrawdownLimitUsd: conf.dailyDrawdownLimitUsd,
        consecutiveLosses:     state.consecutiveLosses,
        maxConsecutiveLosses:  conf.maxConsecutiveLosses,
        aiCircuitOpen:         state.aiCircuitOpen,
        aiOverride:            conf.aiOverride,
      });
    } catch (err) {
      // Gate threw — record as 'log' severity, never block on internal error.
      logged.push({ gate: g.name, severity: 'log', reason: `gate threw: ${err?.message || err}`, metadata: { stack: err?.stack } });
      continue;
    }

    if (res && res.pass === false) {
      const rejection = {
        gate:     g.name,
        severity: rule.severity || DEFAULT_SEVERITY,
        reason:   res.reason,
        metadata: res.metadata || null,
      };
      if (rejection.severity === 'block') blocked.push(rejection);
      else if (rejection.severity === 'warn') warned.push(rejection);
      else logged.push(rejection);
    }
  }

  return {
    pass: blocked.length === 0,
    blocked,
    warned,
    logged,
  };
}

/**
 * Convenience: persist a check() result to dbo.trade_rejections.
 * Best-effort; never throws.
 */
async function recordRejections({ sql, scope, strategy, trade, side, result, botVersion, logger }) {
  if (!result) return;
  const rows = [...(result.blocked || []), ...(result.warned || []), ...(result.logged || [])];
  if (rows.length === 0) return;
  if (!sql || typeof sql.request !== 'function') return; // SQL down → silently drop

  for (const r of rows) {
    try {
      const req = sql.request();
      req.input('scope',              scope || 'global');
      req.input('strategy',           strategy || null);
      req.input('side',               side);
      req.input('symbol',             trade?.symbol || 'UNKNOWN');
      req.input('chain',              trade?.chain || 'UNKNOWN');
      req.input('address',            trade?.address || null);
      req.input('gate',               r.gate);
      req.input('severity',           r.severity);
      req.input('reason',             r.reason ? String(r.reason).slice(0, 1024) : null);
      req.input('requested_size_usd', Number.isFinite(trade?.sizeUsd) ? trade.sizeUsd : null);
      // Day 5 fix: populate wallet_usd from caller-supplied portfolio total instead of always-null.
      req.input('wallet_usd',         Number.isFinite(trade?.walletUsd) ? trade.walletUsd : (Number.isFinite(state?.walletUsd) ? state.walletUsd : null));
      req.input('position_value_usd', Number.isFinite(trade?.positionValueUsd) ? trade.positionValueUsd : null);
      req.input('metadata',           r.metadata ? JSON.stringify(r.metadata).slice(0, 4000) : null);
      req.input('bot_version',        botVersion || null);
      await req.query(`
        INSERT INTO dbo.trade_rejections
          (scope, strategy, side, symbol, chain, address, gate, severity, reason,
           requested_size_usd, wallet_usd, position_value_usd, metadata, bot_version)
        VALUES
          (@scope, @strategy, @side, @symbol, @chain, @address, @gate, @severity, @reason,
           @requested_size_usd, @wallet_usd, @position_value_usd, @metadata, @bot_version)
      `);
    } catch (err) {
      if (logger && typeof logger.debug === 'function') {
        logger.debug(`[pre-trade-contract] rejection log failed: ${err?.message || err}`);
      }
    }
  }
}

module.exports = {
  check,
  recordRejections,
  GATE_CATALOG,
  GATE_RUNNERS,
  // pure gates exported for direct unit testing
  checkTierFeasibility,
  checkPositionSize,
  checkSymbolBlock,
  checkDuplicateOrder,
  checkDailyLossBudget,
  checkConsecutiveLossStreak,
  checkAiCircuit,
};
