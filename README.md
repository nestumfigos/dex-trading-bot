# Paper Strategy Validation Bot

This repository runs the paper/shadow validation process on port `3001`. It records simulated spot strategy results and exposes the dashboard used to judge promotion evidence.

## Strategy Boundary

The authoritative strategy material is:

- `C:\Users\User_\Desktop\Plan\plan.txt` - venue placement and evidence thresholds.
- `C:\Users\User_\Desktop\Plan\day trade.txt` - `spot_day_bull_flag` momentum rules.
- `C:\Users\User_\Desktop\Plan\SWING TRADE.txt` - Backes swing research rules.
- `C:\Users\User_\Desktop\Plan\true perp.txt` - TraderXO perps rules.

Paper evaluation may cover KuCoin, Solana, BSC, Base, Backes, and perps evidence. It must not be treated as approval for live execution. Base remains paper-only until promoted; perps remains a separate simulated system until its own gates pass.

## Services

| Service | Purpose | URL |
|---|---|---|
| Paper dashboard | spot paper trades and perps trade view | `http://192.168.1.92:3001` |
| Live dashboard | approved KuCoin spot execution | `http://192.168.1.92:3002` |
| Perps paper service | simulated perps history source | `http://127.0.0.1:3010` |

The Perp Trades menu is fed by the isolated perps paper service. It is consultation and evidence telemetry only.

## Startup

Use the desktop supervisor:

```powershell
C:\Users\User_\Desktop\Start All Bots.bat
C:\Users\User_\Desktop\Restart All Bots.bat
```

## Documentation

- Architecture and safety boundaries: `docs/ARCHITECTURE.md`
- Database contract: `docs/DB_SCHEMA.md`
- Operator procedures: `docs/RUNBOOK.md`
- Evidence and incident runbooks: `docs/runbooks/`

## Promotion Rule

No strategy moves from paper evidence into live capital based on win rate alone. Promotion must use net expectancy after fees/slippage, drawdown, failed fills/exits, and the strategy-specific sample requirements in the plan.
