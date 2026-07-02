# V2 Docker Compose Baseline

`docker-compose.v2.yml` is the reproducible V2 platform baseline for running the three current bots together from this folder:

- `live-spot` builds `C:\Users\User_\Desktop\dex-trading-bot`
- `paper-spot` builds `C:\Users\User_\Desktop\dex-trading-bot-paper`
- `paper-perps` builds `C:\Users\User_\Desktop\dex-trading-bot-perps`

PM2 remains the current operator workflow. Compose is the controlled migration path for repeatable local/prod deployment.

## Safety Defaults

- All HTTP ports are bound to `127.0.0.1`.
- Inside containers, services bind to `0.0.0.0` so Docker port publishing can reach them while the host port remains loopback-only.
- Paper spot keeps `SQL_STATE_RESTORE_ENABLED=false`.
- Perps runs only as `paper_perps`.
- Live perps execution remains disabled through `LIVE_PERPS_EXECUTION_ENABLED=false`.
- Perps SQL telemetry and SQL restore are required in the V2 profile. The perps container should not start without a valid SQL connection string in its `.env`.

## SQL Server From Docker

Do not use `127.0.0.1` inside container SQL connection strings. In Docker, `127.0.0.1` means the container, not the Windows host.

Use `host.docker.internal` for host SQL Server access, for example:

```text
Server=host.docker.internal,1433;Database=Agent;User ID=...;Password=...;Encrypt=False;TrustServerCertificate=True
```

`docker-compose.v2.yml` includes `extra_hosts` entries for `host.docker.internal` so the same routing works consistently across Docker Desktop and Linux-style engines that support `host-gateway`.

## Commands

From `C:\Users\User_\Desktop\dex-trading-bot`:

```powershell
npm run docker:v2:config
npm run docker:v2:up
npm run docker:v2:down
npm run ops:v2-smoke
```

Use `docker:v2:config` before any rollout. It validates interpolation and paths without starting containers.
Use `ops:v2-smoke` after PM2 or Compose restarts. It checks all three local services, Prometheus metrics, SQL health, V2 SQL report sections, config provenance, perps live-readiness gates, and perps live-readiness Prometheus series without printing secrets.

## Volumes

Persistent runtime state stays on the host:

- live: `./data`, `./logs`
- paper: `../dex-trading-bot-paper/data`, `../dex-trading-bot-paper/logs`
- perps: `../dex-trading-bot-perps/data`, `../dex-trading-bot-perps/config`, `../dex-trading-bot-perps/logs`

## Health Checks

Each service has a container health check:

- live spot: `http://127.0.0.1:3002/health`
- paper spot: `http://127.0.0.1:3003/health`
- paper perps: `http://127.0.0.1:3004/health`

Prometheus metrics:

- spot bots: `/metrics`
- perps: `/metrics`, including `trading_bot_perps_live_readiness_gates_blocked` and `trading_bot_perps_live_readiness_gate_passed{gate="..."}` for alerting on live-readiness blockers.

The smoke command uses fixed V2 ports by default: live `3002`, paper `3003`, perps `3004`. Override with `V2_SMOKE_LIVE_PORT`, `V2_SMOKE_PAPER_PORT`, or `V2_SMOKE_PERPS_PORT` if a service is intentionally moved. For protected config-provenance checks, it reads dashboard admin tokens from each repo `.env`; perps provenance is skipped unless `PERPS_ADMIN_TOKEN` or `V2_SMOKE_PERPS_ADMIN_TOKEN` is available to the smoke process.
