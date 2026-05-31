# dex-trading-bot-perps

**Status: paper/research service. Live execution is disabled unless explicitly
enabled by operator env and credentials after evidence gates pass.**

This repo hosts the TraderXO perpetual-futures paper bot. It is intentionally
separate from the spot bots because leverage, liquidation, margin mode, funding,
and reduce-only exits need different accounting and failure handling.

## Current Services

| Launch path | Port | Notes |
|---|---|---|
| PM2 via `C:\Users\User_\Desktop\dex-trading-bot\ecosystem.config.js` | 3004 | Current supervised local deployment |
| Standalone `start.bat` in this repo | 3010 | Manual research launcher |

Health/status:

```powershell
Invoke-RestMethod http://127.0.0.1:3004/health
Invoke-RestMethod http://127.0.0.1:3004/api/status
```

Expected paper-mode invariant: `liveExecutionEnabled=false`.

## Runtime Contract

- `PERPS_PAPER_SERVICE_ENABLED=true` is required to start the paper API.
- `PERPS_PAPER_MARKET_DATA_ENABLED=true` enables the native market scanner.
- `PERPS_PAPER_LEVERAGE=3` is the paper/canary cap used by the local launcher.
- `PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED=false` is a research-only opt-out and should not be used as promotion evidence.
- POST routes require `PERPS_ADMIN_TOKEN` outside tests; missing token fails closed.

Live adapter loading requires all of:

```text
PERPS_LIVE_ENABLED=true
BINANCE_PERPS_API_KEY=...
BINANCE_PERPS_API_SECRET=...
```

Otherwise `src/exchanges/binance-perps.js` remains guarded and cannot place live
orders.

## Architecture Map

1. Market data: public completed futures candles plus mark-price feed helpers.
2. Strategy: anchors -> range -> deviation reclaim or level-to-level -> MSS -> at least 3R TraderXO intent.
3. Sizing: isolated margin only; risk dollars come from equity risk percent; leverage changes margin, not stop-loss dollars.
4. Liquidation safety: per-symbol maintenance margin and at least 2x liquidation buffer enforced before open.
5. Risk gates: daily/weekly PnL and R windows, aggregate open risk, mode caps for paper/canary/live.
6. Execution: paper adapter opens simulated positions only after admission and gates; every exit is reduce-only and idempotent by client order id.
7. Accounting: PnL includes modeled entry/exit fees, depth-aware slippage, and discrete 8h funding boundaries.
8. Evidence: one atomic state snapshot stores trades, open positions, and processed signal ids.

## Historical Replay

Replay endpoints are research-only. They do not create paper trades and do not
count toward live-promotion soak evidence.

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3004/api/backtests/traderxo `
  -ContentType 'application/json' `
  -Body '{"symbol":"BTCUSDT","days":30}'

Invoke-RestMethod -Method Post http://127.0.0.1:3004/api/backtests/traderxo/benchmark `
  -ContentType 'application/json' `
  -Body '{"symbols":["BTCUSDT","ETHUSDT","SOLUSDT"],"trainingDays":90,"validationDays":30}'
```

The standalone `start.bat` service uses port `3010`, so replace `3004` with
`3010` when running outside PM2.

## Promotion Rules

Before live perps can be enabled:

- 4 weeks minimum paper runtime
- at least 200 completed paper trades
- positive expectancy after funding, fees, and slippage
- no liquidation near-misses below 2x stop distance
- walk-forward replay passes without retuning on validation data
- live canary starts with isolated margin, max 3x leverage, one position, and $100 account floor

Detailed current procedure:
`C:\Users\User_\Desktop\dex-trading-bot\docs\runbooks\PERPS_BOOTSTRAP.md`.

Historical audit notes were consolidated into [audit/phase-a/README.md](./audit/phase-a/README.md).
