#!/usr/bin/env node
'use strict';

/**
 * Walk-forward backtest runner for the Backes HTF Swing strategy (W13 C.13).
 *
 * Pulls daily + weekly KuCoin candles for a fixed universe, then for each
 * walk-forward window (training period → out-of-sample test period) replays
 * the backes-evaluator over the test bars and records signals + simulated
 * fills. Output: dbo.backtest_runs row + JSON summary on disk.
 *
 * Usage:
 *   node scripts/run-walkforward-backes.js
 *   node scripts/run-walkforward-backes.js --symbols=BTC,ETH,SOL --months=12 --window-days=180 --step-days=30
 *   node scripts/run-walkforward-backes.js --dry-run    # validate plan, fetch no data
 *
 * Persistence: writes one row per (symbol, window-end) to dbo.backtest_runs
 * (M0015 schema). Aggregate stats also written to data/backtest-walkforward.json.
 *
 * Status: scaffold. End-to-end logic depends on:
 *   - KuCoin REST `/api/v1/market/candles` historical depth (some pairs limited
 *     to last 1500 bars per request — paginate; live bot already does this).
 *   - backes-evaluator being callable in offline mode (no exchange client side
 *     effects; pure (candles → signal)). Existing src/strategies/backes-evaluator.js
 *     supports this via the `evaluate({btcDailyCandles, ethDailyCandles, tokenDaily,
 *     tokenWeekly})` shape.
 *
 * The Promotion Gate (C.13) succeeds when:
 *   - OOS return improves vs legacy `swing` baseline
 *   - Max DD not worse by +3pp
 *   - Ruin prob not worse by +2pp
 *   - No overfit flag (training-vs-OOS sharpe ratio within 30%)
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL'];
// Top 10 KuCoin liquid pairs (snapshot 2026-05). Adjust as universe shifts.
const TOP10_KUCOIN_LIQUID = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'LINK', 'AVAX', 'DOT'];

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function pickUniverse(args) {
  if (args.symbols) return String(args.symbols).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (args.top10) return TOP10_KUCOIN_LIQUID;
  return DEFAULT_SYMBOLS;
}

async function fetchHistoricalCandles(symbol, interval, bars) {
  // Real implementation uses KuCoin REST + pagination. Stub returns null so the
  // dry-run / validation paths work without network.
  try {
    const candles = require('../src/utils/candles');
    if (typeof candles.getOhlcvSeries === 'function') {
      const rows = await candles.getOhlcvSeries({
        chainKey: 'kucoin',
        symbol: `${symbol}/USDT`,
        interval,
        limit: bars,
      });
      return Array.isArray(rows) && rows.length ? rows : null;
    }
  } catch (err) {
    logger.warn(`[walkforward] candles fetch failed for ${symbol}/${interval}: ${err.message}`);
  }
  return null;
}

async function evaluateWindow(symbol, windowEndIso, testCandlesDaily, testCandlesWeekly) {
  try {
    const { evaluate } = require('../src/strategies/backes-evaluator');
    // Each bar in test window is treated as the "now" for a signal eval. Real
    // runner steps the cursor forward bar-by-bar and replays evaluate(...) on
    // the rolling history slice. Stub returns null until that loop lands.
    if (!testCandlesDaily || testCandlesDaily.length < 56) return null;
    const evaluation = await evaluate({
      tokenDaily: testCandlesDaily,
      tokenWeekly: testCandlesWeekly,
      symbol,
    }).catch(() => null);
    return evaluation;
  } catch (err) {
    logger.warn(`[walkforward] eval failed for ${symbol} ${windowEndIso}: ${err.message}`);
    return null;
  }
}

async function persistRun(pool, summary) {
  if (!pool) return;
  try {
    const r = pool.request();
    r.input('run_id', summary.runId);
    r.input('started_at', summary.startedAt);
    r.input('finished_at', summary.finishedAt);
    r.input('scope', summary.scope);
    r.input('strategy', 'backes_swing');
    r.input('status', summary.status);
    r.input('trade_count', summary.tradeCount);
    r.input('win_rate', summary.winRate);
    r.input('total_pnl_usd', summary.totalPnlUsd);
    r.input('sharpe_ratio', summary.sharpe);
    r.input('max_drawdown_pct', summary.maxDdPct);
    await r.query(`
      INSERT INTO dbo.backtest_runs
        (run_id, started_at, finished_at, scope, strategy, status, trade_count,
         win_rate, total_pnl_usd, sharpe_ratio, max_drawdown_pct)
      VALUES
        (@run_id, @started_at, @finished_at, @scope, @strategy, @status, @trade_count,
         @win_rate, @total_pnl_usd, @sharpe_ratio, @max_drawdown_pct);
    `);
  } catch (err) {
    logger.warn(`[walkforward] SQL persist failed: ${err.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);
  const symbols = pickUniverse(args);
  const months = Number(args.months || 12);
  const windowDays = Number(args['window-days'] || 180);
  const stepDays = Number(args['step-days'] || 30);
  const totalDays = months * 30;
  const numWindows = Math.max(1, Math.floor((totalDays - windowDays) / stepDays));

  const plan = {
    runId: `wf-backes-${Date.now()}`,
    startedAt: new Date().toISOString(),
    symbols,
    months,
    windowDays,
    stepDays,
    numWindows,
    bars: {
      daily: windowDays + 56, // need 56-day MA for backes
      weekly: Math.ceil((windowDays + 56) / 7),
    },
  };
  console.log('[walkforward] plan:');
  console.log(JSON.stringify(plan, null, 2));

  if (dryRun) {
    console.log('[walkforward] dry-run; exiting.');
    process.exit(0);
  }

  const results = [];
  for (const symbol of symbols) {
    const daily = await fetchHistoricalCandles(symbol, '1day', plan.bars.daily);
    const weekly = await fetchHistoricalCandles(symbol, '1week', plan.bars.weekly);
    if (!daily || !weekly) {
      console.warn(`[walkforward] ${symbol}: skipping — missing historical data`);
      continue;
    }
    for (let w = 0; w < numWindows; w += 1) {
      const trainEnd = (w + 1) * stepDays;
      const testStart = trainEnd;
      const testEnd = Math.min(testStart + stepDays, totalDays);
      const windowEnd = new Date(Date.now() - (totalDays - testEnd) * 86_400_000).toISOString();
      const testDaily = daily.slice(testStart, testEnd);
      const testWeekly = weekly.slice(Math.floor(testStart / 7), Math.floor(testEnd / 7));
      const evalResult = await evaluateWindow(symbol, windowEnd, testDaily, testWeekly);
      results.push({
        symbol,
        windowIdx: w,
        windowEnd,
        signal: evalResult?.signal || null,
        confidence: evalResult?.details?.confidence || null,
      });
    }
  }

  const totalSignals = results.filter((r) => r.signal && r.signal !== 'HOLD').length;
  const summary = {
    runId: plan.runId,
    startedAt: plan.startedAt,
    finishedAt: new Date().toISOString(),
    scope: 'global',
    status: results.length > 0 ? 'completed' : 'no_data',
    tradeCount: totalSignals,
    winRate: null, // requires bar-by-bar simulated fills + exits
    totalPnlUsd: null,
    sharpe: null,
    maxDdPct: null,
    perSymbol: results,
  };

  const outPath = path.resolve(process.cwd(), 'data', 'backtest-walkforward.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(`[walkforward] wrote summary to ${outPath} (${totalSignals} signals across ${results.length} windows)`);

  if (String(process.env.SQL_ENABLED || '').toLowerCase() === 'true') {
    try {
      const { getPool } = require('../src/utils/sqlServer');
      const pool = await getPool(logger);
      await persistRun(pool, summary);
      console.log(`[walkforward] persisted run ${summary.runId} to dbo.backtest_runs`);
    } catch (err) {
      console.warn(`[walkforward] SQL persist skipped: ${err.message}`);
    }
  }

  process.exit(summary.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('walkforward runner failed:', err.message);
  process.exit(2);
});
