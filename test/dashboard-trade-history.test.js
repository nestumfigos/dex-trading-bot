const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSpotTradeMetrics,
  buildTradeProfileAliases,
  computePerpsTradeStats,
  filterTradeHistoryByWindow,
  mergeTradeHistory,
  normalizeTradeLedgerRow,
  summarizeClosedSpotTrades,
} = require('../src/dashboard');

test('trade profile aliases include legacy and V2 spot profile names', () => {
  assert.deepEqual(buildTradeProfileAliases('paper', true).sort(), ['paper', 'paper_spot'].sort());
  assert.deepEqual(buildTradeProfileAliases('live_spot', false).sort(), ['live', 'live_spot'].sort());
});

test('SQL trade ledger rows normalize into dashboard trade rows', () => {
  const trade = normalizeTradeLedgerRow({
    trade_id: 'trade-1',
    bot_profile: 'paper_spot',
    ts: new Date('2026-06-12T12:00:00Z'),
    trade_type: 'SELL',
    symbol: 'ABC',
    chain: 'KuCoin',
    chain_key: 'kucoin',
    strategy: 'spot_day_bull_flag',
    price: 1.23,
    quantity: 10,
    value_usd: 12.3,
    pnl_usd: -0.4,
    reason: 'MANUAL_CUT_NO_FOLLOW_THROUGH',
    setup_type: 'spot_day_bull_flag',
    raw_trade_json: JSON.stringify({ pnl: 99, ignored: false }),
  });

  assert.equal(trade.tradeId, 'trade-1');
  assert.equal(trade.type, 'SELL');
  assert.equal(trade.symbol, 'ABC');
  assert.equal(trade.chainKey, 'kucoin');
  assert.equal(trade.valueUsd, 12.3);
  assert.equal(trade.pnl, -0.4);
  assert.equal(trade.setupType, 'spot_day_bull_flag');
  assert.equal(trade.timestamp, '2026-06-12T12:00:00.000Z');
});

test('trade history merge uses SQL rows, runtime fallback, sort, dedupe, and limit', () => {
  const runtime = [
    { txid: 'same', type: 'SELL', symbol: 'OLD', timestamp: '2026-06-12T10:00:00Z', pnl: 1 },
    { txid: 'runtime-only', type: 'BUY', symbol: 'NEW', timestamp: '2026-06-12T13:00:00Z', pnl: null },
  ];
  const sqlRows = [
    { txid: 'same', type: 'SELL', symbol: 'OLD', timestamp: '2026-06-12T10:00:00Z', pnl: 1 },
    { txid: 'sql-only', type: 'SELL', symbol: 'MID', timestamp: '2026-06-12T11:00:00Z', pnl: -2 },
  ];

  const merged = mergeTradeHistory(runtime, sqlRows, 2);
  assert.deepEqual(merged.map((trade) => trade.txid), ['runtime-only', 'sql-only']);
  assert.equal(merged[0].pnl, null);
});

test('trade history merge dedupes duplicate SQL aliases before row ids', () => {
  const merged = mergeTradeHistory([], [
    { tradeId: 'legacy-row', txid: 'same-fill', type: 'SELL', symbol: 'ABC', timestamp: '2026-06-12T10:00:00Z', pnl: -1 },
    { tradeId: 'v2-row', txid: 'same-fill', type: 'SELL', symbol: 'ABC', timestamp: '2026-06-12T10:00:00Z', pnl: -1 },
    { tradeId: 'no-tx-1', type: 'BUY', symbol: 'ABC', valueUsd: 12, timestamp: '2026-06-12T09:00:00Z', pnl: null },
    { tradeId: 'no-tx-2', type: 'BUY', symbol: 'ABC', valueUsd: 12, timestamp: '2026-06-12T09:00:00Z', pnl: null },
  ], 10);

  assert.deepEqual(merged.map((trade) => trade.tradeId), ['legacy-row', 'no-tx-1']);
});

test('trade history rolling window excludes stale and future rows', () => {
  const rows = [
    { timestamp: '2026-06-20T10:00:00Z', type: 'SELL', pnl: 1 },
    { timestamp: '2026-06-19T11:00:00Z', type: 'SELL', pnl: -1 },
    { timestamp: '2026-06-21T11:00:00Z', type: 'SELL', pnl: 5 },
  ];
  const filtered = filterTradeHistoryByWindow(rows, 24, Date.parse('2026-06-20T12:00:00Z'));
  assert.deepEqual(filtered.map((trade) => trade.pnl), [1]);
});

test('spot win rate is based on closed SELL rows, not all trade history rows', () => {
  const summary = summarizeClosedSpotTrades([
    { type: 'BUY', symbol: 'AAA', pnl: 0 },
    { type: 'SELL', symbol: 'AAA', pnl: 12 },
    { type: 'BUY', symbol: 'BBB', pnl: 0 },
    { type: 'SELL', symbol: 'BBB', pnl: -6 },
    { type: 'SELL', symbol: 'CCC', pnl: 0 },
  ]);

  assert.equal(summary.tradeRows, 5);
  assert.equal(summary.closedTrades, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 2);
  assert.equal(summary.winRate, 33.33);
  assert.equal(summary.grossProfit, 12);
  assert.equal(summary.grossLoss, 6);
  assert.equal(summary.profitFactor, 2);
});

test('spot metrics include closed-trade win rate by chain and strategy', () => {
  const metrics = buildSpotTradeMetrics([
    { type: 'BUY', chainKey: 'kucoin', strategy: 'momentum', symbol: 'AAA', pnl: 0 },
    { type: 'SELL', chainKey: 'kucoin', strategy: 'momentum', symbol: 'AAA', pnl: 10 },
    { type: 'SELL', chainKey: 'kucoin', strategy: 'spot_day_bull_flag', symbol: 'BBB', pnl: -5 },
    { type: 'SELL', chainKey: 'bsc', strategy: 'bsc_flow_breakout', symbol: 'CCC', pnl: -2 },
  ]);

  assert.equal(metrics.closedTrades, 3);
  assert.equal(metrics.winRate, 33.33);
  assert.deepEqual(
    metrics.byChain.map((row) => [row.key, row.closedTrades, row.winRate]),
    [['kucoin', 2, 50], ['bsc', 1, 0]]
  );
  assert.deepEqual(
    metrics.byStrategy.map((row) => [row.key, row.closedTrades, row.winRate]),
    [['bsc_flow_breakout', 1, 0], ['momentum', 1, 100], ['spot_day_bull_flag', 1, 0]]
  );
});

test('perps trade stats exclude partial exits and compute realized profit factor', () => {
  const stats = computePerpsTradeStats([
    { closed: true, pnlUsd: 10, feeUsd: 1, fundingUsd: 0.1, slippageUsd: 0.2 },
    { closed: true, pnlUsd: -5, feeUsd: 1, fundingUsd: 0.1, slippageUsd: 0.2 },
    { closed: false, pnlUsd: 20, feeUsd: 1 },
  ]);

  assert.equal(stats.closed, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRatePct, 50);
  assert.equal(stats.pnlUsd, 5);
  assert.equal(stats.profitFactor, 2);
  assert.equal(stats.expectancyUsd, 2.5);
});

test('SQL summary views compute win rate from closed SELL rows only', () => {
  const sqlServerSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'sqlServer.js'), 'utf8');
  assert.match(sqlServerSource, /trade_type = ''SELL'' AND pnl_usd > 0 THEN 1 ELSE 0 END\) AS win_count/);
  assert.match(sqlServerSource, /trade_type = ''SELL'' AND pnl_usd <= 0 THEN 1 ELSE 0 END\) AS loss_count/);
  assert.match(sqlServerSource, /trade_type = ''SELL'' AND pnl_usd IS NOT NULL THEN 1 ELSE 0 END/);
  assert.match(sqlServerSource, /END AS profit_factor/);
});
