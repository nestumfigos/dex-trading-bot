# Safe Mode Active

## What it means

The bot halted normal risk-taking because execution or reconciliation looked unsafe.

## Immediate checks

1. Review the triggering log lines and `ops_events`.
2. Check wallet balances and recent order/fill mismatches.
3. Confirm the exchange or RPC path is healthy.
4. Check for state reconciliation discrepancies in the dashboard health payload.

## Before clearing safe mode

1. Understand the triggering fault.
2. Verify new SQL snapshots and telemetry are healthy.
3. Confirm the problem is not ongoing on the affected chain.
