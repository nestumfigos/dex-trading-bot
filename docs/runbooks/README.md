# Operator Runbooks

These runbooks support the dashboard incident-state surface and the SQL-first operating model.

Current local endpoints:

- live spot: `http://127.0.0.1:3002`
- paper spot: `http://127.0.0.1:3003`
- perps paper: `http://127.0.0.1:3004`

## Core incidents

- `sql_unhealthy`: See [sql-unhealthy.md](./sql-unhealthy.md)
- `safe_mode_active`: See [safe-mode-active.md](./safe-mode-active.md)
- `loop_stalled_or_timer_missing`: See [loop-stalled.md](./loop-stalled.md)
- AI or credential failure: See [AI_KEY_ROTATION.md](./AI_KEY_ROTATION.md)
- perps paper/live promotion: See [PERPS_BOOTSTRAP.md](./PERPS_BOOTSTRAP.md)
- `exchange_dependency_unhealthy`: Check dependency health, RPC latency, and recent exchange/API errors in the dashboard.
- `state_persistence_error`: Treat SQL state snapshots and backup JSON files as recovery paths until the primary save path is healthy again.

## Decision-quality review

Use the SQL report dashboards to inspect:

- approval rate over time
- latest approval and execution decisions
- reflected PnL quality after close

Recommended report pages:

- `/sql-report.html?report=overview`
- `/sql-report.html?report=breakdown`
- `/sql-report.html?report=memory`
