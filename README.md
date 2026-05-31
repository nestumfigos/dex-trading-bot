# DEX Trading Bot Suite

This folder is the live spot bot and the PM2 supervisor entrypoint for the local
three-bot setup.

| Bot | Folder | PM2 app | Port | Purpose |
|---|---|---|---|---|
| Live spot | `C:\Users\User_\Desktop\dex-trading-bot` | `dex-bot` | 3002 | KuCoin live spot execution |
| Paper spot | `C:\Users\User_\Desktop\dex-trading-bot-paper` | `dex-bot-paper` | 3003 | Paper validation for spot strategies |
| Perps paper | `C:\Users\User_\Desktop\dex-trading-bot-perps` | `dex-bot-perps` | 3004 | Isolated perps paper/replay service |

Health endpoints:

```powershell
Invoke-RestMethod http://127.0.0.1:3002/health
Invoke-RestMethod http://127.0.0.1:3003/health
Invoke-RestMethod http://127.0.0.1:3004/health
```

## Deploy

Install dependencies once per repo, then use the live repo PM2 ecosystem file as
the local supervisor:

```powershell
npm install
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 save --force
pm2 status
```

Useful PM2 commands:

```powershell
pm2 logs dex-bot
pm2 logs dex-bot-paper
pm2 logs dex-bot-perps
pm2 restart dex-bot --update-env
pm2 restart dex-bot-paper --update-env
pm2 restart dex-bot-perps --update-env
```

## Live Money Path

The live bot currently runs KuCoin spot only. Strategy scanners produce intent,
the risk engine sizes and blocks trades, the pre-trade contract enforces final
admissibility, and the execution orchestrator owns order lifecycle, fills, fees,
slippage, and position state.

Python sidecar models are enabled in the PM2 env. They are advisory inputs only;
risk and execution gates remain deterministic and fail closed.

## Risk Rules

Core live protections:

- pre-trade contract in enforce mode
- daily drawdown and consecutive-loss gates
- portfolio heat and global exposure caps
- liquidity, spread, slippage, and round-trip friction checks
- AI circuit fallback controls
- honeypot/concentration checks for DEX paths
- SQL-first telemetry with JSON recovery snapshots

## Documentation Map

- [TRADING_SYSTEM.md](./TRADING_SYSTEM.md) - canonical strategy, risk, execution, SQL, and learning map.
- [docs/runbooks/README.md](./docs/runbooks/README.md) - operator runbook index.
- [docs/runbooks/AI_KEY_ROTATION.md](./docs/runbooks/AI_KEY_ROTATION.md) - provider and exchange credential rotation.
- [docs/runbooks/PERPS_BOOTSTRAP.md](./docs/runbooks/PERPS_BOOTSTRAP.md) - perps paper/live promotion procedure.
- `C:\Users\User_\Desktop\dex-trading-bot-paper\README.md` - paper bot boundary.
- `C:\Users\User_\Desktop\dex-trading-bot-perps\README.md` - perps paper service boundary.

## Security

- Never commit `.env`, private keys, exchange secrets, or provider API keys.
- Use dedicated trading wallets, not main wallets.
- Keep live size small until paper evidence passes net expectancy, drawdown,
  fill quality, and failure-mode checks.
- Any live perps activation requires explicit operator approval and the perps
  canary gates in `docs/runbooks/PERPS_BOOTSTRAP.md`.
