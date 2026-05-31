# Paper Bot Architecture

The full cross-bot system map lives in
`C:\Users\User_\Desktop\dex-trading-bot\TRADING_SYSTEM.md`. This file keeps the
paper-specific operating boundary close to the paper worktree.

## Money Path

1. Scan cycle builds strategy intent: setup, stop, targets, and confidence.
2. Risk checks size and admissibility through guardian plus pre-trade contract.
3. Execution clamps any positive jitter, acquires the SQL/distributed lock, then the position mutex.
4. Venue adapters simulate fills and reconcile cash, fees, slippage, partial exits, and position state.
5. SQL telemetry records signals, orders, fills, positions, PnL, decisions, and rejections.
6. Learning reads closed outcomes only. RL updates remain shadow-buffered unless explicitly enabled.

## Boundaries

- Strategy code must not mutate balances or positions.
- Risk code must not place orders.
- Execution code must not increase risk-approved size.
- Learning and self-evolution must not change live behavior without validation and approval.
- Dashboard endpoints observe and administer; they are not alpha sources.
