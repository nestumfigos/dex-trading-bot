# Paper Bot Architecture

`TRADING_SYSTEM.md` is the full system map. This file exists because `README.md`
points here for paper-specific safety boundaries.

## Money Path

1. Scan cycle builds strategy intent: setup, stop, targets, confidence.
2. Risk checks size and admissibility: guardian + pre-trade contract.
3. Execution orchestrator clamps positive jitter, acquires SQL lock, then position mutex.
4. Venue adapter simulates/fills orders and execution-flow reconciles fills, cash, fees, slippage, and partial exits.
5. SQL telemetry records signals, orders, fills, positions, PnL, decisions, and rejections.
6. Learning reads closed outcomes only. RL updates are shadow-buffered unless explicitly enabled.

## Boundaries

- Strategy code must not mutate balances or positions.
- Risk code must not place orders.
- Execution code must not increase a risk-approved size.
- Learning and self-evolution must not change live behavior without validation and approval.
- Dashboard endpoints observe and administer; they are not alpha sources.
