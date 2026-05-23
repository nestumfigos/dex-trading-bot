# dex-trading-bot-perps

**Status: SCAFFOLD ONLY. DO NOT RUN.**

Per WEEK 15 (Plan D) of the spot bot's REFACTOR_CHECKLIST.md, this repo will host
the perpetual-futures trading bot (TraderXO methodology). It is a sibling to
`dex-trading-bot/` (spot) but with no shared runtime code — perp money path
(margin / leverage / liquidation) has no analog in spot and reusing spot code
paths is the documented #1 failure mode.

## Scaffold state (2026-05-23)

Created:
- Directory tree: `src/exchanges/`, `src/strategies/`, `src/risk/`, `test/`, `db/migrations/`
- Stub modules with `NotImplementedError` guards (throw on call) — see list below
- `package.json` placeholder (no dependencies declared yet)
- `README.md` (this file)

NOT created:
- `.env` / `.env.example` (no API keys yet)
- `start.bat` / launcher
- `node_modules/` (run `npm init -y` + add deps when ready)
- Any working code

## Bootstrap plan

See `dex-trading-bot/docs/runbooks/PERPS_BOOTSTRAP.md` for the 14-step
operator checklist (D.1 through D.14). Total estimate: 11 days code +
4 weeks paper soak + 1 month live canary = ~9 weeks to live.

## Stub modules

Every file under `src/` throws `NotImplementedError` if its export is invoked.
This is intentional — it prevents accidental shipping while making the
intended structure visible. Implementation order matches the bootstrap plan:

1. `src/exchanges/binance-perps.js` — REST + WebSocket adapter (D.2)
2. `src/strategies/perps-anchors.js` — HTF time anchors (D.3)
3. `src/strategies/perps-range-detector.js` — range detection (D.4)
4. `src/strategies/perps-deviation-reclaim.js` — sweep + reclaim (D.5)
5. `src/strategies/perps-mss-detector.js` — Market Structure Shift (D.6)
6. `src/strategies/perps-l2l-detector.js` — level-to-level (D.7)
7. `src/strategies/perps-sizing.js` — leverage math (D.8)
8. `src/risk/perps-gates.js` — daily/weekly loss caps (D.9)
9. `src/exits/perps-reduce-only.js` — reduce-only exit handler (D.10)
10. `src/telemetry/perps-stats.js` — separate dashboard endpoint (D.11)
11. `test/*.test.js` — ~60 tests across all modules (D.12)
12. Paper soak script (D.13)
13. Live canary launcher (D.14, EXTREME CAUTION)

## Safety contract

This repo MUST NOT be added to PM2 / start.bat / any auto-restart launcher
until D.13 (paper soak ≥200 trades, positive expectancy after funding+fees,
zero liquidation near-misses) and D.14 (live canary on $100, isolated margin,
max 3x leverage, 1 month observation) are both passed.

Operator who flips that switch carries full responsibility for leverage risk.
