# V2 Developer Workflow

This document defines the repeatable local and CI validation path for the V2 trading platform foundation.

## Repositories

| Profile | Repository | Purpose |
|---|---|---|
| Live spot | `C:\Users\User_\Desktop\dex-trading-bot` | Live spot runtime, shared dashboard, central V2 docs, platform smoke |
| Paper spot | `C:\Users\User_\Desktop\dex-trading-bot-paper` | Paper spot runtime and forward-evidence profile |
| Paper perps | `C:\Users\User_\Desktop\dex-trading-bot-perps` | Perps research/paper runtime; live perps remains disabled |

## Local Validation

Run the focused V2 smoke suites after changing shared contracts, risk, strategy routing, telemetry, dashboard, Docker, or CI wiring.

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
npm run test:v2-smoke

cd C:\Users\User_\Desktop\dex-trading-bot-paper
npm run test:v2-smoke

cd C:\Users\User_\Desktop\dex-trading-bot-perps
npm run test:v2-smoke
```

When the bots are running under PM2, run the platform smoke from the live repository.

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
npm run ops:v2-smoke
```

The platform smoke validates live, paper, and perps health endpoints, metrics endpoints, PM2 ownership, config provenance, config-source conflicts, SQL health, perps SQL control-plane source, perps readiness gates, perps readiness Prometheus metrics, and perps SQL restore status.

It also runs a cross-profile config parity audit. The audit allows intentional profile differences such as `BOT_PROFILE`, `PAPER_TRADING`, and ports, while failing safety-critical drift such as mismatched V2 risk enforcement mode, mismatched portfolio heat/correlation caps, unsafe self-evolution flags, or live perps execution being enabled.

## CI Validation

Each repo owns a `.github/workflows/v2-smoke.yml` workflow. CI intentionally runs only static and unit-level smoke tests:

- SQL is disabled in CI.
- Market data is disabled where supported.
- Live perps execution is explicitly disabled.
- Workflow permissions are read-only.
- Superseded workflow runs are cancelled by branch/ref concurrency.

CI does not prove that PM2 services are running, SQL Server is reachable, exchange connectivity works, or Docker is installed on the operator machine. Those are local/platform checks.

## Docker Compose

Use the dedicated V2 compose file from the live repository when Docker is available:

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
npm run docker:v2:config
npm run docker:v2:up
```

Inside Docker, service bind hosts must be `0.0.0.0` so published ports are reachable from the host. Host SQL Server should be reached through `host.docker.internal`, not `127.0.0.1`.

## Required Pre-Commit Checks

Before promoting a V2 foundation change, run:

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
npm run test:v2-smoke

cd C:\Users\User_\Desktop\dex-trading-bot-paper
npm run test:v2-smoke

cd C:\Users\User_\Desktop\dex-trading-bot-perps
npm run test:v2-smoke

cd C:\Users\User_\Desktop\dex-trading-bot
npm run ops:v2-smoke
```

If Docker is installed, also run:

```powershell
cd C:\Users\User_\Desktop\dex-trading-bot
npm run docker:v2:config
```

Do not treat CI success alone as live readiness. Live readiness requires the local platform smoke, SQL health, clean PM2 ownership, and profile-specific risk/readiness gates.
