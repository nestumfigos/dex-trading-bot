# Phase A — Execution Layer Audit

## Critical

### 1. Race: Concurrent Exit Handlers
- File: `src/execution/orchestrator.js:312-412`
- Only boolean `exitInProgress` guards SELL execution; no atomic lock.
- **Impact:** Double SELL on same position. Doubled losses, position overdraft.
- **Fix:** Acquire `positionMutex` for entire `executeSell()`; release in finally.

### 2. No Idempotency Keys on Exchange Orders
- Files: `src/exchanges/jupiter.js`, `src/exchanges/kucoin.js`
- Neither uses clientOrderId. Retry on timeout → duplicate order.
- **Impact:** Double fills, lost position tracking.
- **Fix:** Generate UUID clientOrderId per buy/sell; check exchange before re-submit.

### 3. Incomplete Fill Handling Loses Size
- File: `src/utils/execution-accounting.js:96-109`
- `resolveSellFillMetrics` caps filledBaseQty to positionQty but no alert if requested > position.
- **Impact:** Silent partial fill; subsequent sells assume wrong size.
- **Fix:** Log/alert and validate before fraction-based sells.

## High

### 4. Retry Storm — No Circuit Breaker
- File: `src/exchanges/jupiter.js:295-310`
- `withRetry` bumps slippage +20bps per attempt up to 2000bps. No fail-fast on permanent price-impact errors.
- **Impact:** Progressive worse slippage; guaranteed losses on volatile tokens.
- **Fix:** Stop on permanent errors; cap retry count tighter.

### 5. Fee Double-Subtraction
- File: `src/utils/execution-flow.js:247`
- `portfolio.balance -= filledQuoteUsd` assumes fees netted. If `hasExchangeFilledData=false`, fee subtracted at balance AND at close.
- **Impact:** Phantom losses in PnL accounting.
- **Fix:** Track `exchangeFeeUsd` separately; never double-subtract.

### 6. Loose BSC Slippage Cap
- File: `src/execution/orchestrator.js:115`
- 3% max slippage applied without depth check.
- **Impact:** Thin-liquidity BSC tokens fill at sandwich-level prices.
- **Fix:** Compute slippage dynamically from orderbook depth; reject if depth < size.

### 7. Sell Recovery Mismatch
- File: `src/utils/sell-recovery.js:27-36`
- `findRecentTradeFill` matches closest qty over 5min window; with two partials, picks wrong.
- **Impact:** Recorded fill ≠ actual fill → cascading position-accounting errors.
- **Fix:** Match by orderId or timestamp range; require exact symbol+side.

## Medium

### 8. Distributed Lock TTL Too Short
- File: `src/execution/orchestrator.js:177`
- 30s lock; execution can hit 45s timeout. Stall → lock expires → second order on same token.
- **Fix:** TTL = `execTimeoutMs + 10s buffer`; release explicitly on success/failure.

### 9. Market vs Limit Ignores Spread
- File: `src/exchanges/kucoin.js:618-622`
- Market order for momentum without spread check. Volatile pairs spread >1.5%.
- **Fix:** Use limit when spread > 0.5%; market only when spread tight.

### 10. Quote Staleness Not Validated
- File: `src/utils/execution-adapter.js:54-70`
- `getNativeQuote` not timestamp-checked. Stale by 2min → 5% silent slippage.
- **Fix:** Refresh quotes if older than 30s; reject if no timestamp.

## Live ↔ Paper Drift
Both repos have identical execution code (no drift detected) per cross-diff.

## Suggested Priorities
1. **#1 (race) + #2 (idempotency)** — silent double-fill, margin wipeout risk.
2. **#3 + #5** — position/PnL integrity.
3. **#4 + #6 + #7** — slippage discipline.
