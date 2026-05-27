# Perps Phase A — Risk Gates + Leverage/Sizing

## Critical

### 1. Liq Buffer Checked Post-Open Not Pre-Open
- File: `src/paper/paper-perps-adapter.js:44-52`
- Gates check `liquidationBufferMultiple` *after* `calculatePaperPosition()` succeeds. No pre-flight validation prevents oversize that breaches 2.0× floor.
- **Impact:** Order placed then rejected → orphaned position state.
- **Fix:** Move liq buffer check into `calculatePaperPosition()` validation phase; refuse to return position object if buffer < 2.0.

### 2. Daily/Weekly Loss Trackers Reset on Restart
- File: `src/telemetry/perps-stats.js:178-197`
- `riskWindowSummary()` uses `Date.now()` reference; trades closed pre-restart excluded from window.
- **Impact:** Restart mid-drawdown → -2R/-5R limits silently reset. Operator sees equity down, dailyR=0.
- **Fix:** Persist daily/weekly window boundaries + accumulated R-multiples in state file.

### 3. Maintenance Margin Hardcoded
- File: `src/strategies/perps-sizing.js:28,32`
- Formula correct (`liqMove = (1/lev) - maintenance`) but default `maintenanceMarginPct = 0.005` hardcoded. Real values vary 0.1% (low-lev alt) to 2% (high-lev BTC tier).
- **Impact:** Liq price off ±0.5% per tier mismatch.
- **Fix:** Fetch actual MM from binance per symbol+leverage tier; accept as parameter.

## High

### 4. SHORT-Side R:R Untested
- File: `src/strategies/traderxo-paper-engine.js:7-11`
- Math correct for shorts (`risk=stop-entry`, `reward=entry-target`). Tests cover long only (`test/traderxo-replay.test.js:44-46`).
- **Fix:** Add SHORT-side R:R test case with reward/risk swapped.

### 5. Sizing Uses Entry Price Not Mark Price
- File: `src/strategies/perps-sizing.js:23`
- `stopDistancePct = abs(entry-stop)/entry`. Limit orders fill at price ≠ planned entry; liq-buffer mismatches reality at fill.
- **Fix:** Use mark price from fill ack, not planned entry.

### 6. Cross-Margin Assumed, Not Enforced Everywhere
- File: `src/risk/perps-gates.js:32`
- Gate rejects non-isolated. But position math hardcodes `marginMode: 'isolated'`; future code reading `order.marginMode` could leak cross.
- **Fix:** Assert `marginMode==='isolated'` in `calculatePaperPosition` + `evaluatePaperPerpsRisk` before any math.

### 7. -2R Per-Trade vs Daily Aggregate Conflation
- File: `src/risk/perps-gates.js:48`
- `if (dayPnl <= -(equity*0.02) || dayR <= -2)`. Code treats dailyR as sum across trades. Spec says "Daily max loss: -2R OR -2% whichever fires first" — ambiguous whether per-trade or daily.
- **Impact:** One -3R loss trips it; operator thinks per-trade stop.
- **Fix:** Pin spec semantics; if daily aggregate, rename `dailyR`. Add separate per-trade `tradeR` gate.

### 8. Leverage Cap 5× in Paper, Spec Says 3× Canary
- File: `src/risk/perps-gates.js:34`
- `lev > 5` rejects. Spec canary: max 3×.
- **Fix:** Add `mode: 'paper'|'canary'|'live'`; enforce lev ≤ 3 for canary/live.

## Medium

### 9. riskUsd Point-in-Time, Not Dynamic
- File: `src/paper/paper-perps-adapter.js:36-42`
- `openRiskUsd = sum(position.riskUsd * (remainingNotional/originalNotional))`. `riskUsd` stored at entry = `equity * riskPct`; doesn't reset when equity grows.
- **Impact:** Profits leak back into risk budget. Risk limits appear to hold but expand silently.
- **Fix:** Recompute `riskUsd = currentEquity * riskPct/100` per gate eval, or store baseline equity per trade.

### 10. Canary Mode Not Enforced
- Spec D.14: isolated margin, max 3× lev, $100 account, **1 position max**.
- Code: no canary mode. No $100 floor. No max-1-position check.
- **Fix:** `mode` parameter; in canary mode reject 2nd position open.

## Suggested Priorities
1. **#1 + #2** — pre-open buffer check + persistent window state.
2. **#5 + #3** — mark-price sizing + per-symbol MM fetch.
3. **#7 + #10** — spec-pin -2R semantics + canary mode enforcement.
4. **#6** — cross-margin assertion everywhere.
5. **#4** — SHORT R:R test fixture.
