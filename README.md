# dex-trading-bot-perps

**Status: PAPER MILESTONE ONLY. DO NOT CONNECT LIVE FUNDS.**

Per `C:\Users\User_\Desktop\Plan\true perp.txt` and `plan.txt`, this repo hosts
the perpetual-futures trading bot (TraderXO methodology). It is a sibling to
`dex-trading-bot/` (spot) but with no shared runtime code — perp money path
(margin / leverage / liquidation) has no analog in spot and reusing spot code
paths is the documented #1 failure mode.

## Scaffold state (2026-05-23)

Created:
- Directory tree: `src/exchanges/`, `src/strategies/`, `src/risk/`, `test/`, `db/migrations/`
- Paper-only sizing, risk gates, simulated execution, reduce-only exits, telemetry API, and tests
- `package.json` placeholder (no dependencies declared yet)
- `README.md` (this file)

NOT created:
- `.env` / `.env.example` (no API keys yet)
- Any live-funds launcher or live exchange credential path
- `node_modules/` (run `npm init -y` + add deps when ready)
- Any live exchange credential path or live execution adapter

## Bootstrap plan

See `dex-trading-bot/docs/runbooks/PERPS_BOOTSTRAP.md` for the 14-step
operator checklist (D.1 through D.14). Total estimate: 11 days code +
4 weeks paper soak + 1 month live canary = ~9 weeks to live.

## Stub modules

The live venue adapter remains guarded. The paper-only milestone adds isolated
strategy and execution plumbing needed to gather evidence without enabling leveraged trading:

1. `src/exchanges/binance-perps.js` — guarded live venue adapter; always throws
2. `src/paper/paper-perps-adapter.js` — simulated adapter with no credentials or network calls
3. `src/strategies/perps-anchors.js` — implemented HTF time anchors (D.3)
4. `src/strategies/perps-range-detector.js` — implemented horizontal range detection (D.4)
5. `src/strategies/perps-deviation-reclaim.js` — implemented sweep + reclaim (D.5)
6. `src/strategies/perps-mss-detector.js` — implemented required lower-timeframe Market Structure Shift gate (D.6)
7. `src/strategies/perps-l2l-detector.js` — implemented level-to-level continuation intent (D.7)
8. `src/strategies/perps-sizing.js` — paper leverage and liquidation math; leverage changes margin, not stop-loss dollars (D.8)
9. `src/risk/perps-gates.js` — paper daily/weekly/liquidation/R:R caps (D.9)
10. `src/exits/perps-reduce-only.js` — all simulator exits carry `reduceOnly: true` (D.10)
11. `src/telemetry/perps-stats.js` and `src/server.js` — durable paper trade history and evidence endpoints (D.11)
12. `src/paper/paper-signal-processor.js` — approved, paper-only signal intake with duplicate-delivery rejection and restart-safe open positions
13. `test/paper-milestone.test.js` — milestone safety tests (D.12)
14. `src/market/binance-public-perps.js` and `src/paper/paper-market-scanner.js` — no-key USD-M Futures paper data lane and lifecycle manager
15. Paper soak evidence accumulation (D.13)
16. Live canary launcher (D.14, EXTREME CAUTION)

## Safety contract

This repo MUST NOT add any live execution adapter or live-funds launcher
until D.13 (paper soak >=200 trades, positive expectancy after funding+fees,
zero liquidation near-misses) and D.14 (live canary on $100, isolated margin,
max 3x leverage, 1 month observation) are both passed. The current `start.bat`
may start only the isolated paper telemetry/simulation service supervised from
the desktop launcher; it cannot access live funds.

Operator who flips that switch carries full responsibility for leverage risk.

The paper telemetry service is opt-in only: run `node src/index.js` with
`PERPS_PAPER_SERVICE_ENABLED=true`. Paper trade history can be displayed before
the evidence gates pass. Its `/api/status` response reports
`liveExecutionEnabled=false` and `livePromotionEligible=false` until all paper
evidence requirements pass, so viewing simulated trades never enables leverage.
Approved paper signals can be submitted to `POST /api/signals` with
`paperOnly=true`, `approved=true`, `market=perps`, `strategy=traderxo_perps`,
and a unique `id`. Spot trade forwarding is intentionally rejected: perps
evidence must come from a dedicated TraderXO perps signal path. The service
persists open paper positions across restarts, rejects duplicate delivery, and
records trade history only through reduce-only exits.

`start.bat` enables the native paper scanner for `BTCUSDT`, `ETHUSDT`, and
`SOLUSDT`. It reads only public Binance USD-M Futures kline market data and
cannot submit orders. Entries require a valid range-deviation/reclaim or
level-to-level plan, at least 1:3 planned reward/risk, a lower-timeframe MSS
confirmation, isolated-margin sizing, and paper risk gates. Exits are
reduce-only simulation events: EQ scale, next-level close, structural stop, or
five-bar no-follow-through cut.

Paper risk reserves margin across open positions and caps aggregate planned
open risk at 2% of equity. Completed lifecycle evidence includes modeled entry
and exit fees, slippage, and elapsed funding. The service reports `/health` as
unhealthy when its native market scanner has failed, so a stalled data path
cannot masquerade as valid paper evidence.

## Current architecture map

1. Market data: public Binance USD-M completed klines + mark price feed helpers.
2. Strategy: anchors -> range -> deviation reclaim or level-to-level -> MSS -> >=3R TraderXO intent.
3. Sizing: isolated margin only; risk dollars from equity riskPct; leverage changes margin, not stop loss; per-symbol maintenance margin and >=2x liquidation buffer enforced before open.
4. Risk gates: daily/weekly PnL and R windows, aggregate open risk <=2% equity, mode caps for paper/canary/live.
5. Execution: paper adapter opens simulated perps positions only after admission and gates; every exit is reduce-only and idempotent by client order id.
6. Accounting: PnL includes modeled entry/exit fees, depth-aware slippage, and discrete 8h funding boundaries.
7. Evidence: telemetry persists one atomic state snapshot for trades, positions, and signal ids; dashboard/server reads from that evidence only.

Paper persistence uses `data/perps-paper-state.json` as one authoritative,
atomically replaced snapshot for trades, open positions, and processed signal
IDs. The older per-file JSON ledgers are imported once for compatibility; old
spot-proxy positions are discarded during import and cannot become perp
exposure. An accepted open or reduce-only exit is committed together with its
deduplication record, so a retry after a failed response cannot execute twice.

## Historical Replay

The paper API exposes research-only replay on public completed candles:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3010/api/backtests/traderxo `
  -ContentType 'application/json' `
  -Body '{"symbol":"BTCUSDT","days":30}'

Invoke-RestMethod -Method Post http://127.0.0.1:3010/api/backtests/traderxo/study `
  -ContentType 'application/json' `
  -Body '{"symbols":["BTCUSDT","ETHUSDT","SOLUSDT"],"days":90}'

Invoke-RestMethod -Method Post http://127.0.0.1:3010/api/backtests/traderxo/walk-forward `
  -ContentType 'application/json' `
  -Body '{"symbol":"BTCUSDT","trainingDays":30,"validationDays":30}'

Invoke-RestMethod -Method Post http://127.0.0.1:3010/api/backtests/traderxo/benchmark `
  -ContentType 'application/json' `
  -Body '{"symbols":["BTCUSDT","ETHUSDT","SOLUSDT"],"trainingDays":90,"validationDays":30}'
```

The endpoint loads public USD-M Futures candles, replays the same native entry,
risk, scale-out, target, stop, and manual-cut rules, and returns expectancy,
R-multiple, costs, drawdown, and stressed-cost results. Replays are deliberately
separate from `data/perps-paper-state.json`: they cannot manufacture paper
trades or count toward live-promotion soak evidence. Study results compare
enabled contracts and report outcome groupings by market regime. Walk-forward
results hold the parameters unchanged between training and later validation
windows and block promotion on insufficient trades, non-positive expectancy,
non-positive stressed PnL, or excessive drawdown.

New scanner paper entries are separately admission-gated. The benchmark tests
only predefined variants, selects on the earlier training window, and evaluates
the selected unchanged variant on the later validation window. A failed result
persists a blocked admission record, covering both native scanner opens and
direct approved paper-signal opens. Reduce-only management of existing paper
positions remains available. Passing this research gate permits paper evidence
collection only; it never enables live perps execution.
