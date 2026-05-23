#!/usr/bin/env node
'use strict';

/**
 * Seed dbo.regime_patterns from historical bot_trade_ledger PnL data.
 *
 * Aggregates closed sells by (regime, strategy, chain) and derives:
 *   - size_multiplier: 1.0 base, scale up to 1.3 when win_rate > 55% AND samples >= 10,
 *     scale down to 0.5 when win_rate < 35% AND samples >= 10.
 *   - recommendation: 'aggressive' | 'normal' | 'defensive' | 'pause'
 *   - confidence: samples / (samples + 20)  // soft saturation
 *   - preferred_chains / avoid_chains: derived from per-chain win rate
 *
 * This is a starter seeder so the regime_patterns wire (src/index.js:1679) has
 * data to consume immediately. Real ML retrain (Python) should replace this
 * with a proper walk-forward analysis once that pipeline lands.
 *
 * Usage:
 *   node scripts/seed-regime-patterns.js                  # default scope=global
 *   node scripts/seed-regime-patterns.js --scope=live
 *   node scripts/seed-regime-patterns.js --dry-run        # print rows, don't write
 *   node scripts/seed-regime-patterns.js --min-samples=5  # override sample threshold
 *
 * Idempotent: deactivates prior rows for same (regime, strategy, scope) then
 * inserts new active row. Marks `source='heuristic_seeder'` so ML retrain can
 * later overwrite with `source='ml_retrain'`.
 */

require('dotenv').config();
const logger = require('../src/utils/logger');
const { getPool } = require('../src/utils/sqlServer');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function classifyRegime(trade) {
  // Heuristic: derive regime from raw_trade_json when available, else 'unknown'.
  // Real ML uses macro regime from backes-macro at trade entry time; we
  // approximate by looking at price_change_24h at entry.
  try {
    const raw = JSON.parse(trade.raw_trade_json || '{}');
    if (raw.entryRegime && typeof raw.entryRegime === 'string') return raw.entryRegime.toLowerCase();
    const change = Number(raw.priceChange24h || raw.entryPriceChange24h || 0);
    if (change > 8) return 'trend_up';
    if (change < -8) return 'trend_down';
    return 'chop';
  } catch (_) {
    return 'unknown';
  }
}

function deriveRecommendation(winRate, samples) {
  if (samples < 5) return { recommendation: 'normal', multiplier: 1.0 };
  if (winRate >= 60) return { recommendation: 'aggressive', multiplier: 1.3 };
  if (winRate >= 50) return { recommendation: 'normal', multiplier: 1.1 };
  if (winRate >= 40) return { recommendation: 'normal', multiplier: 1.0 };
  if (winRate >= 30) return { recommendation: 'defensive', multiplier: 0.7 };
  return { recommendation: 'pause', multiplier: 0.3 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);
  const scope = String(args.scope || 'global').toLowerCase();
  const minSamples = Number(args['min-samples'] || 3);

  if (String(process.env.SQL_ENABLED || '').toLowerCase() !== 'true') {
    console.error('SQL_ENABLED=true required.');
    process.exit(2);
  }

  const pool = await getPool(logger);
  if (!pool) {
    console.error('No SQL pool.');
    process.exit(2);
  }

  // Fetch all closed SELL trades from ledger
  const ledger = await pool.request().query(`
    SELECT strategy, chain, chain_key, setup_type, pnl_usd, raw_trade_json
      FROM dbo.bot_trade_ledger
     WHERE trade_type = 'SELL' AND pnl_usd IS NOT NULL
  `);
  const trades = ledger.recordset || [];
  console.log(`[seed-regime] ${trades.length} closed SELL trades found`);

  if (trades.length === 0) {
    console.log('[seed-regime] no closed trades yet — nothing to derive. Exiting.');
    process.exit(0);
  }

  // Group by (regime, strategy)
  const buckets = new Map(); // key=`${regime}|${strategy}` → { trades[], chainStats: {} }
  for (const t of trades) {
    const regime = classifyRegime(t);
    const strategy = String(t.strategy || 'momentum').toLowerCase();
    const chain = String(t.chain_key || t.chain || 'unknown').toLowerCase();
    const key = `${regime}|${strategy}`;
    if (!buckets.has(key)) buckets.set(key, { regime, strategy, trades: [], chainStats: {} });
    const b = buckets.get(key);
    b.trades.push({ pnl: Number(t.pnl_usd || 0), chain });
    if (!b.chainStats[chain]) b.chainStats[chain] = { wins: 0, losses: 0 };
    if (Number(t.pnl_usd || 0) > 0) b.chainStats[chain].wins += 1;
    else b.chainStats[chain].losses += 1;
  }

  const rows = [];
  for (const b of buckets.values()) {
    if (b.trades.length < minSamples) continue;
    const wins = b.trades.filter((t) => t.pnl > 0).length;
    const winRate = (wins / b.trades.length) * 100;
    const avgPnl = b.trades.reduce((a, t) => a + t.pnl, 0) / b.trades.length;
    const { recommendation, multiplier } = deriveRecommendation(winRate, b.trades.length);
    // Chain preferences: chains with > 55% win rate are preferred; < 35% are avoided
    const preferred = [];
    const avoid = [];
    for (const [chain, st] of Object.entries(b.chainStats)) {
      const total = st.wins + st.losses;
      if (total < 3) continue;
      const wr = (st.wins / total) * 100;
      if (wr >= 55) preferred.push(chain);
      if (wr < 35) avoid.push(chain);
    }
    rows.push({
      regime: b.regime,
      strategy: b.strategy,
      scope,
      recommendation,
      size_multiplier: multiplier,
      preferred_chains: preferred.length ? preferred.join(',') : null,
      avoid_chains: avoid.length ? avoid.join(',') : null,
      confidence: Number((b.trades.length / (b.trades.length + 20)).toFixed(2)),
      samples: b.trades.length,
      win_rate: Number(winRate.toFixed(2)),
      avg_pnl_pct: Number(avgPnl.toFixed(4)),
    });
  }

  if (rows.length === 0) {
    console.log(`[seed-regime] no buckets met min-samples=${minSamples}. Exiting.`);
    process.exit(0);
  }

  console.log(`[seed-regime] derived ${rows.length} regime_patterns rows (scope=${scope}):`);
  for (const r of rows) {
    console.log(`  ${r.regime}|${r.strategy}: rec=${r.recommendation} mult=${r.size_multiplier} wr=${r.win_rate}% n=${r.samples} preferred=${r.preferred_chains || '—'} avoid=${r.avoid_chains || '—'}`);
  }

  if (dryRun) {
    console.log('[seed-regime] dry-run; exiting.');
    process.exit(0);
  }

  // Deactivate prior rows + insert new active
  for (const r of rows) {
    const req = pool.request();
    req.input('regime', r.regime);
    req.input('strategy', r.strategy);
    req.input('scope', r.scope);
    req.input('recommendation', r.recommendation);
    req.input('size_multiplier', r.size_multiplier);
    req.input('preferred_chains', r.preferred_chains);
    req.input('avoid_chains', r.avoid_chains);
    req.input('confidence', r.confidence);
    req.input('samples', r.samples);
    req.input('win_rate', r.win_rate);
    req.input('avg_pnl_pct', r.avg_pnl_pct);
    await req.query(`
      UPDATE dbo.regime_patterns SET active = 0
        WHERE regime = @regime AND strategy = @strategy AND scope = @scope AND active = 1;
      INSERT INTO dbo.regime_patterns
        (regime, strategy, scope, recommendation, size_multiplier, preferred_chains,
         avoid_chains, confidence, samples, win_rate, avg_pnl_pct, source, active, measured_at)
      VALUES
        (@regime, @strategy, @scope, @recommendation, @size_multiplier, @preferred_chains,
         @avoid_chains, @confidence, @samples, @win_rate, @avg_pnl_pct,
         'heuristic_seeder', 1, SYSUTCDATETIME());
    `);
  }
  console.log(`[seed-regime] wrote ${rows.length} active rows.`);
  console.log('[seed-regime] regime-patterns loader cache TTL = REGIME_PATTERNS_CACHE_TTL_MS (default 5min).');
  process.exit(0);
}

main().catch((err) => {
  console.error('seed-regime-patterns failed:', err.message);
  process.exit(1);
});
