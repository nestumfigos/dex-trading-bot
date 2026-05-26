# Phase A — Dead Code / Legacy Paths

## Scope
- LIVE src/: 171 JS files, all reachable from `src/index.js` / dashboard. **0 dead source files.**
- PAPER src/: 169 JS files. Same finding.
- Dead code concentrated in `scripts/` and doc references.

## Missing Scripts (Documented But Don't Exist)
Referenced in `docs/RUNBOOK.md`, never created:

1. `scripts/config-diff.js` — 3× referenced for diagnostics
2. `scripts/config-audit.js` — 2× referenced for knob audit
3. `scripts/db-status.js` — referenced for migration status
4. `scripts/memory-inspect.js` — referenced for agent memory inspection

**Note:** PAPER repo *has* these scripts. LIVE is missing them. **This is drift, not dead code.** Either backport from paper or remove from runbook.

## Dead Scripts (Zero References, Not in npm scripts / ecosystem.config.js)

5. `scripts/build-ml-dataset.js` — never imported, standalone research
6. `scripts/check-dashboard-api.js` — manual health check, never called
7. `scripts/monitor-soak-gates.js` — standalone monitor, no cron/PM2 reference
8. `scripts/init-agent-sql.js` — superseded by `init-sql.js`
9. `scripts/init-telemetry-sql.js` — likely redundant with main init
10. `scripts/run-walkforward-backes.js` — typo in name (`backes` vs `backtest`), zero refs
11. `scripts/fix-sql-filegroup.js` — one-time operational, never referenced

## Recommended Actions
- **Backport (not delete):** 1-4 from PAPER → LIVE; runbook depends on them.
- **Archive (move to `scripts/archive/`):** 5-7, 10 — research/research artifacts. Preserve git history.
- **Delete:** 8, 9 (superseded), 11 (one-time done).

## Source Tree
Per agent: every `.js` in `src/` reachable. No unreachable production code.

**Caveat:** Agent did reachability via static import graph. Dynamic `require(varname)` not traced. Should sample-check before any deletion.

## Suggested Priorities
1. Backport 4 missing runbook scripts from PAPER (cheap, fixes docs).
2. Move 4 research scripts to `scripts/archive/` (cheap, declutter).
3. Delete 3 superseded scripts after a manual sanity check.
