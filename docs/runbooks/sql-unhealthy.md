# SQL Unhealthy

## What it means

The bot cannot safely trust SQL for state snapshots, queryable learning, or reports.

## Immediate checks

1. Confirm `SQL_ENABLED=true`.
2. Confirm `SQL_CONNECTION_STRING` points at the expected server and database.
3. Run `npm run sql:init`.
4. Check dashboard health for SQL self-test status.
5. Inspect recent logs for SQL connection or schema errors.

## Before resuming live confidence

1. Confirm fresh rows are appearing in `bot_state_snapshots`, `signals`, and `decision_log`.
2. Confirm the SQL report dashboards load without stale or missing data.
3. Keep JSON backups until several healthy SQL save cycles have completed.
