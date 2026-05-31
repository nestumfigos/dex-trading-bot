# Perps Paper Service And Live Promotion Runbook

The perps bot is implemented as a separate paper/research service in
`C:\Users\User_\Desktop\dex-trading-bot-perps`. It must stay isolated from spot
execution because margin, leverage, funding, and liquidation risk do not share a
safe money path with spot.

## Current Deployment

| Mode | Command source | Port | Notes |
|---|---|---|---|
| PM2 local suite | live repo `ecosystem.config.js` | 3004 | Current supervised deployment |
| Standalone perps repo | `dex-trading-bot-perps\start.bat` | 3010 | Manual local research launcher |

Required paper env:

```text
PERPS_PAPER_SERVICE_ENABLED=true
PERPS_PAPER_MARKET_DATA_ENABLED=true
PERPS_MODE=paper
PERPS_PAPER_EQUITY_USD=10000
PERPS_PAPER_LEVERAGE=3
PERPS_PAPER_SCAN_INTERVAL_MS=900000
```

Health checks:

```powershell
Invoke-RestMethod http://127.0.0.1:3004/health
Invoke-RestMethod http://127.0.0.1:3004/api/status
```

The service must report `liveExecutionEnabled=false` while in paper mode.

## Paper Evidence Requirements

Before any live perps path is enabled:

1. At least 4 weeks paper runtime.
2. At least 200 completed paper trades.
3. Positive net expectancy after fees, slippage, and funding.
4. No liquidation near-miss where liquidation buffer is below 2x stop distance.
5. Walk-forward replay passes without changing selected parameters between train and validation windows.
6. Admission gate evidence is present unless explicitly running a research-only disabled-gate session.

## Live Canary Requirements

Live perps remains blocked unless all paper evidence passes and the operator
explicitly enables the live adapter.

Canary rules:

- isolated margin only
- max 3x leverage
- one open position max
- $100 starting account floor
- reduce-only exits on every close
- client order id on every order
- immediate halt on liquidation buffer below 2x
- one month observation before scaling

Live adapter load requires both:

```text
PERPS_LIVE_ENABLED=true
BINANCE_PERPS_API_KEY=...
BINANCE_PERPS_API_SECRET=...
```

Missing either credential keeps `src/exchanges/binance-perps.js` in guarded
mode. This is intentional.

## Operator Checklist

1. Confirm paper health is OK on port 3004.
2. Confirm `liveExecutionEnabled=false`.
3. Confirm paper entries are sourced from TraderXO perps strategy paths only.
4. Confirm replay endpoints are research-only and do not write paper trades.
5. Review `dex-trading-bot-perps\README.md` and `audit\phase-a\README.md`.
6. Review paper evidence: expectancy, R multiple, drawdown, funding, slippage, and failed exits.
7. Only after evidence passes, prepare a separate live-canary change with the env flags above.
