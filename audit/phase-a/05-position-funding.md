# Perps Phase A — Position Model + Funding + Telemetry

## Critical

### 1. Data Files Mix Spot + Perps Records
- Files: `data/perps-paper-open-positions.json`, `data/perps-paper-trades.json`
- Records with `paper-spot:kucoin:*` IDs, `fundingUsd=0`, `leverage=1` co-located with intended perps records. `isApprovedPerpsTrade/Position` filters exist (`perps-stats.js:36-48`) but data is contaminated.
- **Impact:** Telemetry aggregates spot+perps. Liq-buffer metrics meaningless on 1x rows. Stats validation passes with 0 genuine perps trades.
- **Fix:** Purge spot-origin rows from data files. Enforce perps ID prefix at write time.

### 2. Liquidation Price Frozen After Scale-In
- File: `src/paper/paper-perps-adapter.js:153`
- Partial exit mutates `remainingNotionalUsd` only. `liquidationPrice` + `liquidationBufferMultiple` stay at original entry levels.
- **Impact:** Buffer appears safer than real; next entry can breach actual liq.
- **Fix:** Recompute `liquidationPrice` + `liquidationBufferMultiple` on every partial exit using remaining margin + remaining notional.

## High

### 3. Telemetry Schema Lacks `perps_*` Prefix
- File: `src/telemetry/perps-stats.js:170-173`
- `fundingUsd` aggregated separately but no `perps_*` table prefix. Spot would collide on same schema.
- **Fix:** Prefix all perps keys: `perps_fundingUsd`, `perps_stats`. Document split.

### 4. markPrice WebSocket Feed Not Consumed
- File: `src/market/binance-public-perps.js:1-63`
- KLINE REST only. No markPrice/fundingRate subscription. Liq-buffer trend (spec D.14 critical metric) deferred.
- **Impact:** Cannot track real-time liq; cannot alert on buffer < 2× live.
- **Fix:** Add WS markPrice + fundingRate consumer; recompute liq buffer per tick.

### 5. Funding Modeled Continuous, Not 8h-Discrete
- Files: `src/paper/paper-perps-adapter.js:74`, `src/backtest/traderxo-replay.js:65-68`
- Uniform `notional × ratePer8h × (heldHours/8)`. Real binance settles at UTC 00:00/08:00/16:00.
- **Impact:** Funding cost underestimated across cycle boundaries; backtest misleading.
- **Fix:** Track per-epoch accrual; apply discrete settlements at actual binance funding times.

### 6. Liq Buffer Not Exposed in Server Endpoints
- File: `src/server.js:73-80`
- `/api/open-positions` returns raw positions; no derived liq-buffer trend or alert flag. Spec D.14 requires Telegram alert on buffer < 2×.
- **Fix:** Add `liquidationAlertStatus` field; include latest markPrice for client-side recheck.

## Medium

### 7. Missing `originalNotionalUsd` Field
- File: `src/paper/paper-perps-adapter.js:54-76`
- After scale-in, original notional inferred not stored. Restart risks losing reference.
- **Fix:** Store `originalNotionalUsd: sized.notionalUsd` at position-init.

### 8. Stale Buffer in Aggregate Risk Calc
- File: `src/paper/paper-perps-adapter.js:32-51`
- `evaluatePaperPerpsRisk` reads candidate's fresh buffer but open positions carry stale buffers (per #2).
- **Fix:** Recalc all open-position buffers before aggregation.

### 9. `_not-implemented.js` Reachable
- File: `src/exchanges/binance-perps.js`
- Live adapter guarded; if ENV flag misconfig, throws at first runtime call not at startup.
- **Fix:** Add startup-time import check; refuse boot if live flag set without adapter.

### 10. Backtest Endpoints Bypass Risk Gates
- File: `src/server.js:110-149`
- `/api/backtests/traderxo/*` accepts user `options` without validating against admission + risk gates.
- **Impact:** Operator backdoor to replay at 10x leverage.
- **Fix:** Validate options against `evaluatePaperPerpsRisk` + admission gates before service call.

## Low

- Equity baseline not persisted (`paper-perps-adapter.js:35`); assumed constant.
- No position reconciliation on crash mid-exit.
- `fundingBpsPerEightHours = 1` hardcoded; not fetched from binance.

## Suggested Priorities
1. **#1** — purge spot rows from perps data, enforce write-time prefix.
2. **#2** — recompute liq on partial exit. Required before any further paper trades.
3. **#4** — markPrice WS feed. Blocks D.14 alerts.
4. **#5** — funding 8h-discrete model. Required for soak-gate validity.
5. **#3 + #6 + #10** — telemetry hygiene + alert endpoint + replay-gate validation.
