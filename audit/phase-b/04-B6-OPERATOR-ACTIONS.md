# Phase B6 Summary — Operator-Action Items Resolved

B5 dossier flagged 5 operator-action items as "code work complete, requires runtime". This pass converts each into either an executed code change (when feasible inside the codebase) or a runnable script.

## Done in code

### B6P.live-flip — Conditional binance-perps live wire (perps)
- `src/exchanges/binance-perps.js` now branches at module load:
  - If `PERPS_LIVE_ENABLED === 'true'` AND `BINANCE_PERPS_API_KEY` AND `BINANCE_PERPS_API_SECRET` are present → exports the real REST adapter from `binance-perps-rest.js`.
  - Otherwise → exports the guard stub (NotImplementedError on any call).
- Half-credentials state is logged via `console.warn` so an incomplete env doesn't silently look "live".
- `scaffold-guards.test.js` still passes because tests run with `PERPS_LIVE_ENABLED` unset → guard branch active.

### B6P.ws-wire — Subscribe markPrice WS from scanner (perps)
- `src/index.js` imports `createBinancePerpsWsConsumer`, builds the consumer when `PERPS_PAPER_MARKPRICE_WS_ENABLED !== 'false'`, and calls `subscribe(symbols)` at startup.
- Scanner accepts a new `getLatestMarkPrice` callback (passed in from `index.js`). When invoked per scan tick, scanner pulls the live mark price and attaches it to the order, so `calculatePaperPosition` can anchor stop-distance + liquidation math on mark instead of entry (B5P.5 plumbing now live).
- SIGINT/SIGTERM handlers close the WS cleanly.
- If WebSocket runtime is unavailable, the bot logs a warning and continues without WS (sizing falls back to entryPrice). No hard dependency added.

### B6P.mm-refresh-script — MM tier refresh tool (perps)
- New `scripts/refresh-mm-tiers.js`. Pulls `https://fapi.binance.com/fapi/v1/leverageBracket` for the requested symbols, formats the response into the `TIERS = {}` map shape, and either prints to stdout or rewrites `src/strategies/perps-maintenance-margin.js` in place when `--write` is passed.
- Usage: `node scripts/refresh-mm-tiers.js --symbols BTCUSDT,ETHUSDT,SOLUSDT --write`.

### B6.migration-runner — Phase B migration helper (spot)
- New `scripts/apply-phase-b-migrations.js`. Wraps the existing `migrate()` runner with a pre-check that emits "already applied" when M0025 + M0026 are both recorded, and runs `assertCriticalTables()` post-apply to fail-fast on a missing hot-path table.
- Usage: `node scripts/apply-phase-b-migrations.js` (or `--dry-run`).

### B6.restart-runbook — Phase B restart sequence (spot)
- New `scripts/phase-b-restart.bat`. Executes the paper-first restart sequence per `feedback_paper_first_restart_sequence`:
  1. Apply Phase B migrations.
  2. Stop bots (placeholders for the user's process-manager — fill in pm2/forever/systemd commands).
  3. Restart spot PAPER for 24h canary.
  4. Restart perps PAPER.
  5. **Stops before restarting spot LIVE** — operator MUST confirm after 24h observation.

## Still requires operator hands

- **Run `scripts/apply-phase-b-migrations.js`** against the production SQL Server. Cannot be done from the repo without DB credentials in this environment.
- **Run `scripts/phase-b-restart.bat`** (or its Linux/macOS equivalent — translate to `pm2 stop … && pm2 restart …`) on the host that owns the bot processes.
- **Set live env vars** (`PERPS_LIVE_ENABLED=true`, `BINANCE_PERPS_API_KEY`, `BINANCE_PERPS_API_SECRET`) when perps canary is greenlit per PERPS_BOOTSTRAP D.14.

These three are operator actions because they touch credentials + running processes outside the source tree.

## Cumulative Phase B State (post-B6)

| Batch | Spot | Perps | Total |
|---|---|---|---|
| B1+B1P | 9 | 10 | 19 |
| B2+B2P | 14 | 11 | 25 |
| B3+B3P | 16 | 3 | 19 |
| B4+B4P | 10 | 3 | 13 |
| B5+B5P | 6 | 6 | 12 |
| **B6+B6P** | **2** | **3** | **5** |
| **TOTAL** | **57** | **36** | **93** |

93 code/script items shipped + 25 audit reports + 9 verified-no-fix comments across both repos.

## Commit Plan
- Spot: single commit on `master` (B6 migration runner + restart script + dossier).
- Perps: single commit on `master` (B6P live-flip + WS wire + MM refresh script).
