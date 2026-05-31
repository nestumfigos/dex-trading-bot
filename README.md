# Paper Strategy Validation Bot

This folder runs the spot paper/shadow validation bot. It exists to collect
promotion evidence without touching live capital.

| Service | URL | Purpose |
|---|---|---|
| Paper dashboard | `http://127.0.0.1:3003` | spot paper trades, validation, risk telemetry |
| Live dashboard | `http://127.0.0.1:3002` | approved KuCoin spot execution |
| Perps paper service | `http://127.0.0.1:3004` | isolated perps paper/replay telemetry |

## Boundary

- Paper trades do not approve live deployment by themselves.
- Promotion requires net expectancy after fees/slippage, drawdown review, failed fill/exit review, and strategy-specific sample thresholds.
- Self-evolution may generate proposals, but auto-apply and auto-promote are disabled unless explicitly enabled.
- Python sidecar and external models are advisory; deterministic risk gates still own admission.

## Start / Restart

The current local deployment is supervised from the live repo PM2 ecosystem:

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 restart dex-bot-paper --update-env
pm2 save --force
```

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) - paper-specific money path and boundaries.
- `C:\Users\User_\Desktop\dex-trading-bot\TRADING_SYSTEM.md` - canonical cross-bot system map.
- `C:\Users\User_\Desktop\dex-trading-bot\docs\runbooks\` - operator runbooks.
