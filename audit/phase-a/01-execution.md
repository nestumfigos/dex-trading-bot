# Perps Phase A — Execution + Idempotency + Reduce-Only

## Critical

### 1. binance-perps.js Live Adapter is a guard() Stub
- File: `src/exchanges/binance-perps.js:5`
- Imports `guard()` which throws on any call. No REST/WS adapter exists.
- **Impact:** Cannot place live perp orders. Production blocked.
- **Fix:** Implement adapter per PERPS_BOOTSTRAP D.2 — REST place/cancel/reduce-only/query, WS account+markPrice, clientOrderId on every place.

### 2. reduceOnly Flag Not Asserted on Outbound
- File: `src/paper/paper-perps-adapter.js:101` (`buildReduceOnlyExit`)
- Sets `reduceOnly: true` in object (L17) but never asserts it before send.
- **Impact:** If live exec drops the flag, paper won't catch it. Direction-flip risk on live.
- **Fix:** Assert in exit path: `if (!order.reduceOnly) throw new Error('reduceOnly required')`.

### 3. Direction-Flip Vulnerability in movePct
- File: `src/paper/paper-perps-adapter.js:119-122`
- Null/corrupt `position.side` falls through long/short branch; movePct defaults to long math.
- **Impact:** Reduced position can flip direction on edge case.
- **Fix:** Guard `if (!['long','short'].includes(position.side)) throw`.

### 4. Leverage Cap Paper-Only
- File: `src/risk/perps-gates.js:44` (and L34 `lev > 5`)
- Enforced only in paper-path; binance-perps.js is stub so no live enforcement layer exists.
- **Impact:** Live exceed 5x canary cap undetected once adapter ships.
- **Fix:** Move cap check into REST adapter pre-submit. Echo in gates for early reject.

### 5. Scanner Position State Race
- File: `src/paper/paper-market-scanner.js:36`
- Finds open position; never re-checks adapter `positions` Map before issuing EXIT.
- **Impact:** EXIT on already-closed position returns `{accepted:false}` silently (L98).
- **Fix:** Sync Map state in scanner before emitting EXIT signal; surface mismatch as warning.

## High

### 6. Missing clientOrderId on perps-reduce-only.js
- File: `src/exits/perps-reduce-only.js:3-22`
- Function signature accepts `position, notionalUsd, price, reason`. No clientOrderId generated or returned.
- **Impact:** Retry on 429/5xx double-fills.
- **Fix:** Generate UUID clientOrderId; include in returned order; binance adapter forwards it.

### 7. Hardcoded 0.05% Entry Fee
- File: `src/paper/paper-perps-adapter.js:72`
- `entryFeeUsd = sized.notionalUsd * 0.0005`. Binance perps real rates: maker 0.02%, taker 0.04%.
- **Impact:** Paper P&L diverges from live.
- **Fix:** Accept `{makerFeeRate, takerFeeRate}`; default to `0.0002 / 0.0004`. Use takerFee for market exits, maker for resting orders.

### 8. Funding Modeled Linear, Not 8h-Compound
- File: `src/paper/paper-perps-adapter.js:113-118`
- `modeledFundingUsd = closeNotional * rate * (heldHours/8)`. Linear; binance compounds every 8h.
- **Impact:** Funding drag understated long, rewards understated short.
- **Fix:** Track funding accrual per 8h interval on open notional, not estimated post-exit.

### 9. No Concurrency Guard on Signal Processor
- File: `src/paper/paper-signal-processor.js:14-66`
- Dedup by signal ID (L18) but no async serialization.
- **Impact:** Concurrent burst can race; bug surfaces only on live WS replay.
- **Fix:** Async queue with `concurrency=1`.

## Medium

### 10. Arbitrary Closed-Position Floor
- File: `src/paper/paper-perps-adapter.js:124-125`
- `remainingNotionalUsd <= 0.000001` marks closed. Binance min notional is e.g. 10 USDT for BTCUSDT.
- **Impact:** Paper thinks position closed, live exchange rejects exit on ghost notional.
- **Fix:** Per-symbol `minNotionalUsd` param; hard-check in exit builder.

### 11. Regime Detection 12h Window
- File: `src/paper/paper-market-scanner.js:86-92`
- `rangeWindow = candles1h.slice(-12)` of only 18 fetched.
- **Impact:** Last-hour volatility mis-classifies regime; variant gating drops valid setups.
- **Fix:** Fetch 50+ 1h candles; exponential weighting on recent bars.

### 12. Signal Side Not Validated Pre-Adapter
- File: `src/paper/paper-signal-processor.js:38-47`
- Signal action `OPEN_LONG|OPEN_SHORT` but no assertion `order.side === expectedSide`.
- **Fix:** Validate match before forwarding to adapter.

### 13. Aggregate Open-Risk Cap Spec Ambiguous
- File: `src/risk/perps-gates.js:44`
- Gate uses 2% open-risk cap; spec says 2% daily *loss* (different concept).
- **Fix:** Clarify intent; either rename gate or restructure to two separate checks (open-risk vs realized-loss).

## Low

### 14. No HTTP Retry/Backoff
- File: `src/market/binance-public-perps.js:17-21`
- Throws on non-200; no 429 backoff.
- **Fix:** Exponential backoff for 429, retry 5xx ≤3 attempts.

### 15. Liq Buffer Calc Ignores Funding
- File: `src/strategies/perps-sizing.js:32-38`
- `liquidationMove = (1/leverage) - maintenance`. Assumes entry == mark; ignores funding cost erosion.
- **Fix:** Add `fundingAdjustmentPct` param; reduce buffer estimate 0.5-1%.

### 16. maxRiskPct=1% on A+ vs Spec
- File: `src/paper/paper-perps-adapter.js:22`
- `order.isAPlus ? 1 : 0.5`. Spec D.8 baseline is 0.5%.
- **Fix:** Align to single policy or document variant.

## Suggested Priorities
1. **#1** — binance-perps.js adapter implementation. Blocks live launch entirely.
2. **#2 + #3 + #6** — reduce-only assertion + side guard + idempotency. Direction-flip + double-fill safety.
3. **#4** — leverage cap inside REST adapter once #1 lands.
4. **#5 + #9** — position-state race + concurrency guard.
5. **#7 + #8** — paper fee/funding fidelity. Required before any soak gate passes.
