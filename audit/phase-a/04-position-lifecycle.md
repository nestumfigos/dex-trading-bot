# Phase A — Position Lifecycle + PnL Audit

## Critical

### 1. Scale-In Overwrites entryPrice (No Avg-Entry)
- File: `src/execution/orchestrator.js:248-297`
- New position created with `entryPrice: realizedEntryPrice`. No existing-position check. Second buy fully overwrites first.
- **Impact:** Buy 100@$1 then 100@$1.05 → `entryPrice=$1.05` (lost $1 baseline). TP/SL fires against wrong reference. Phantom triggers.
- **Fix:** Detect collision; weighted-average entryPrice = (oldQty*oldPrice + newQty*newPrice)/totalQty.

### 2. Multi-Tier Partial Exit Double-Count Risk
- File: `src/utils/execution-flow.js:531-550, 564`
- Partial filledFraction handling correct in isolation. But no closure guard prevents repeated proceeds credit if wallet reconciliation re-fires same exit.
- **Impact:** Overstated balance and realized PnL.
- **Fix:** Idempotency key on exit; once credited, refuse re-credit for same exitId.

### 3. Fees Missing from Unrealized PnL
- Files: `src/index.js:3206-3207` vs `src/utils/execution-flow.js:544-546`
- Unrealized = `currentValue - costBasisUsd` (no fees). Realized subtracts fees. Round-trip ~0.2-0.4% inflated unrealized.
- **Fix:** Apply `estimatedRoundTripFeeBps` to unrealized; show "net" PnL.

### 4. No Funding/Borrow Cost Tracking
- All searched files
- No `fundingRate`, `accumulatedFunding`, `borrowCost` anywhere.
- **Impact:** If perps activated, long positions silently bleed funding. PnL becomes fiction.
- **Fix:** Add perp-position model with funding accrual hook; skip on spot.

### 5. Liquidation Handler Never Reconciles DB
- File: `src/cycle/reconciliation.js`
- Detects wallet mismatches but no liquidation-recovery path. Liquidated position stays with non-zero qty/cost-basis in DB.
- **Impact:** Stuck positions lock capital; realized losses missing.
- **Fix:** Liquidation event handler: zero position, record realized loss = -costBasis.

## High

### 6. Dust Position Lingering
- File: `src/utils/execution-flow.js:597-605`
- `fullyClosed` requires qty OR cost-basis hit dust. Both above dust → position lingers → next buy creates duplicate key.
- **Fix:** AND condition + force-close routine when either residual is suspicious; alert.

### 7. Trade-Repair Cost-Basis Fraction Assumes Uniform Cost-per-Unit
- File: `src/utils/trade-repair.js:171-173`
- `filledFraction = recoveredQty / openQtyBefore`; `costBasisPortion = openCostBefore * filledFraction`. On multi-tranche positions with different entry prices, this is wrong.
- **Fix:** Use weighted basis per tranche; or use FIFO/LIFO tag.

### 8. Unrealized PnL Lags Wallet Reality
- Files: `src/cycle/reconciliation.js`, `src/index.js:3205`
- `position.currentPrice` only refreshed on exits, not on wallet reconciliation.
- **Fix:** Refresh currentPrice from live quote every reconciliation cycle.

### 9. Slippage Not Deducted from PnL
- File: `src/utils/execution-flow.js:532-547`
- Slippage tracked for stats only via `recordSlippageSample`. Not subtracted from realized PnL.
- **Fix:** Slippage already in fill price → PnL implicitly correct IF fill-price is post-slippage. Verify fill source is exchange-reported (post-slip) not requested-quote. If quote-based, deduct estimated slippage.

### 10. portfolio.balance Manual Mutation Without Exchange Verify
- File: `src/utils/execution-flow.js:247, 550`
- balance ± filledQuoteUsd / proceedsUsd. No exchange-balance cross-check; rounding errors accumulate.
- **Fix:** Post-trade reconciliation hook; alert if drift > 0.1%.

## Medium

### 11. Trade-Repair Signature Collisions
- File: `src/utils/trade-repair.js:30-38`
- Sig = `[ts, type, chain, address, strategy, reason]`. Missing iteration discriminator. Two SELL_FAILED same hour same token → both patched together.
- **Fix:** Add positionIterationId or attemptedExitPrice to signature.

### 12. Partial Exit Logs Missing Net/Fee
- File: `src/utils/execution-flow.js:585-590`
- Log shows qty/discrepancy only; no fee or net proceeds. Operator blind to true partial-exit efficiency.
- **Fix:** Log `feeUsd`, `netProceedsUsd`.

## Live ↔ Paper Drift
- execution-accounting.js, trade-repair.js, exit-conditions.js, exit-helpers.js, sell-recovery.js: identical between repos.
- Paper has reliable `portfolio.startingBalance` baseline (index.js:3294); LIVE uses fragile `stats.totalPnl + unrealizedPnl` fallback.

## Suggested Priorities
1. **#1 (scale-in avg-entry)** — silent TP/SL bug. Immediate.
2. **#2 (double-credit guard)** — idempotency on exit.
3. **#3 (unrealized fees)** — accurate dashboard.
4. **#5 (liquidation reconcile)** — required before any margin/perps.
5. **#6 + #7** — dust + multi-tranche repair.
