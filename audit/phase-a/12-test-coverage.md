# Phase A — Test Coverage Gap Analysis

Test files: 82 main + 2 bot extension = 84.

## Coverage Matrix

| Critical Path | Status | Tests |
|---|---|---|
| Order Placement (kucoin/dex/perp) | PARTIAL | execution-adapter, backes-sizing, bsc-flow-sizing |
| Partial Fills + Retries + Cancellation | **MISSING** | trade-repair covers repair only |
| Position Open/Scale-in/Close | COVERED | backes-sizing, bsc-flow-sizing, integration/trade-cycle, state/portfolio |
| TP/SL Trigger | COVERED | cycle/exit-pass, exits/evaluate-exit-decision, backes-exit-decision, bsc-flow-exit-decision |
| Liquidation (Perps) | **MISSING** | no perp-specific tests |
| PnL Math (realized/unrealized/fees/funding) | PARTIAL | stats/metrics-compute, execution-flow-regression (realized only) |
| Risk Limits | COVERED | risk/pre-trade-contract (7 gates), policy/preconditions, backes-sizing |
| Learning Updates | COVERED | evolution-governor, evolution-validator-delta, memory/lessons, promotion-governance |
| SQL Persistence | COVERED | integration/sql-conflict, db-migration, memory/roundtrip, state-persistence |
| Dashboard Contracts | COVERED | dashboard/extensions, dashboard-schema |
| API Failure Modes | PARTIAL | cycle/health-canary, cycle/reconciliation (basic) |
| Live↔Paper Parity | COVERED | paper-safety-config, backes-sizing, integration/trade-cycle |

**74/84 paths covered partially or fully (88% nominal, 62% for high-risk paths).**

## Top 10 Missing-Test Priorities

### 1. Partial Fill + Retry (CRITICAL)
- `test/execution/partial-fill-retry.test.js`
- Given $100 BUY 50 SOL, When 25 filled then cancel + retry 25, Then positions=50, journal has 2 attempts, PnL on 50.

### 2. Order Cancel on Timeout (CRITICAL)
- `test/execution/order-timeout-cancel.test.js`
- Given 30s timeout, When cancel returns 429, Then inFlight marked stale + alert + exp-backoff retry.

### 3. Perp Liquidation Detection (CRITICAL)
- `test/risk/perp-liquidation.test.js`
- Given size=10, 10x lev, entry=100, liq=90, When price→89.5, Then detected + force-close + loss + funding + insurance.

### 4. Unrealized PnL Under Slippage (HIGH)
- `test/stats/unrealized-pnl-slippage.test.js`
- Given entry=100, cur=102, fees=0.5%, Then math accounts for bid-ask + maker/taker + funding.

### 5. Global Risk Limit Cascade (HIGH)
- `test/risk/global-limits-cascade.test.js`
- Individual gates pass but global cap (maxLoss+leverage+exposure) blocks 4th position.

### 6. Concurrent Position Merge (HIGH)
- `test/integration/concurrent-position-merge.test.js`
- Two writers race saveState; final qty wins on timestamp, no field wipe, merge idempotent.

### 7. Stop-Loss Gap Fill (HIGH)
- `test/exits/gap-fill-stop-loss.test.js`
- SL=95, snapshot=100 stale 2min, real gaps to 92 → market exit logged with gap reason.

### 8. Exchange API Failure Sequence (HIGH)
- `test/integration/exchange-api-failures.test.js`
- 503 → 429 → 401 sequence triggers backoff, safe-mode after 3 fails, state rollback.

### 9. Promotion Under Paper↔Live Discrepancy (MEDIUM)
- `test/learning/model-promotion-parity.test.js`
- Paper 80% win, live 30% → promotion blocked, shadow extended, manual approval required.

### 10. Crash-Recovery State Merge (MEDIUM)
- `test/integration/crash-recovery-state.test.js`
- Corrupted partial state.json on restart → parse error caught, fields dropped, no duplicates.

## Suggested Priorities
1. #1, #2, #3 — execution + perp safety. Block live perp trading until #3 exists.
2. #4, #5 — risk-math integrity.
3. #6, #7, #8 — concurrency + market edge cases.
