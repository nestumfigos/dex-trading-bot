# V2 Release Checklist

This checklist defines when the V2 infrastructure foundation can be called complete. It does not override strategy promotion, paper evidence, live canary, or perps live-readiness gates.

## Required Commands

Run from `C:\Users\User_\Desktop\dex-trading-bot`:

```powershell
npm run test:v2-smoke
npm run ops:v2-smoke
npm run ops:v2-roadmap
```

Run the perps V2 suite from `C:\Users\User_\Desktop\dex-trading-bot-perps`:

```powershell
npm run test:v2-smoke
```

Run the paper V2 suite from `C:\Users\User_\Desktop\dex-trading-bot-paper`:

```powershell
npm run test:v2-smoke
```

## Completion Criteria

| Area | Requirement |
|---|---|
| Shared core | `packages/core` contracts present in live, paper, and perps profiles |
| SQL control plane | V2 migrations and rollbacks present; SQL smoke reports all V2 views/tables |
| Perps SQL | Perps SQL telemetry, restore, backfill, and control-plane summary pass tests |
| Risk/execution | V2 risk audit, order lifecycle, perps execution adapter, reconciliation, funding, and canary policy tests pass |
| Config safety | Config provenance, config-source audit, PM2 singleton ownership, and startup live/canary guards pass |
| Observability | Dashboard report, `/metrics`, perps readiness gate metrics, and platform smoke pass |
| AI governance | Mutation proposals and promotion gates require evidence before promotion |
| Docker/CI | V2 Docker Compose config and read-only CI smoke workflows are present |
| Runtime smoke | Live, paper, and perps services are online, SQL healthy, config parity safe, and perps live execution disabled |
| Release gate | `npm run ops:v2-roadmap` reports `100%` V2 foundation completion and runtime smoke pass |

## Non-Negotiable Separations

- V2 foundation completion does not mean live perps execution is ready.
- Perps live execution remains disabled until `/api/live-readiness` gates and paper/live evidence gates pass.
- Strategy promotion still requires sample size, positive net expectancy, drawdown limits, regime coverage, and execution discrepancy checks.
- Dirty runtime files and uncommitted development work must not be confused with runtime health.
