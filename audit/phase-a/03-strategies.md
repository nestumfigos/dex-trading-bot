# Perps Phase A — Strategy Correctness

## Critical

### 1. Look-Ahead Bias on Current Candle
- Files: `src/strategies/traderxo-paper-engine.js:25`, `perps-l2l-detector.js:27`, `perps-deviation-reclaim.js:25`
- Signals use `latest.close` from current candle. At signal time (`timestamp = openTime + 15min`) candle may still be open; downstream code uses it as confirmed close.
- **Impact:** False signals on wicks; whipsaw entries; backtest overfits.
- **Fix:** Use `rows[rows.length - 2]` (prior closed bar) or buffer `+1ms` after openTime+15min and assert candle finalized.

### 2. MSS Confirms on Any Close Beyond 4 Prior Bars
- File: `src/strategies/perps-mss-detector.js:5-23`
- Fires on any `latest.close > brokenHigh` (or below brokenLow). Single noise wick triggers.
- **Impact:** False MSS in chop; entry on noise.
- **Fix:** Require 2-3 consecutive closes beyond level OR min displacement (e.g. 0.5% beyond brokenHigh).

### 3. RH/RL Sweep + Reclaim Counted Same Candle
- File: `src/strategies/perps-deviation-reclaim.js:19-39`
- Sweep detected over 6-bar lookback `priorRows.slice(0,-1)`. Reclaim check at L22: `latest.close < high` same candle as sweep. Tolerance 25% lets sweep-extended candles closing inside range still trigger.
- **Impact:** Entries on incomplete reclaim; stops at sweep extreme; breakeven stop-outs.
- **Fix:** Require `latest.close > high*(1-tolerance)` AND next candle's open beyond level, OR delay entry by 1 bar.

## High

### 4. Range Tolerance Basis-Dependent
- File: `src/strategies/perps-range-detector.js:16-20`
- `tolerance = eq * (0.35/100)` where `eq = (high+low)/2`. BTC@50k → 175 ticks; BTC@20k → 70 ticks.
- **Impact:** Identical price action qualifies in one regime, rejects in another.
- **Fix:** Use fixed basis `tolerance = high*0.0035` OR percent of range width.

### 5. Anchors Computed Once Per Signal, Never Refreshed
- File: `src/strategies/traderxo-paper-engine.js:245`
- `currentPrice = candle.close` at signal-time. Used for L2L target selection (L247-251). 3R+ price move → stale `weeklyOpen`/`monthlyOpen` targets.
- **Fix:** Recompute anchors per management bar OR mark stale after N bars; refuse new targets from stale anchors.

### 6. Manual Cut Lacks Trend Context
- File: `src/strategies/traderxo-paper-engine.js:112-115`
- After 5 bars, `favorableMove < riskMove` → cut. No EMA/trend filter.
- **Impact:** Stops trending setups on sideways consolidation.
- **Fix:** Skip manual cut if price above EMA20 (long) or below (short).

### 7. L2L Target Validity Not Checked
- File: `src/strategies/perps-l2l-detector.js:29,47`
- Target = `monthlyOpen` (line 248). No check that target is beyond current range extremes in signal direction.
- **Impact:** Targets inside consolidation; unreachable.
- **Fix:** Validate `target > latest high` (long) or `target < latest low` (short).

## Medium

### 8. Range Detector Lacks Recency / Contiguity
- File: `src/strategies/perps-range-detector.js:12-23`
- Any 6+ of last 12 candles with ≥2 touches qualifies. Bars 1-6 can qualify even if bars 7-12 broke decisively. `.slice(0,-2)` at L243 only drops last 2.
- **Fix:** Require touches within last 4 candles OR all 6 qualifying candles contiguous.

### 9. normalizeCandles Silently Drops Invalid
- File: `src/strategies/perps-anchors.js:13-25`
- OHLC non-finite/zero rows filtered without surfacing. Same input may yield different lengths if data quality varies.
- **Impact:** Non-reproducible replay.
- **Fix:** Return `{candles, droppedCount, reasons}`; caller decides acceptance.

## Low

### 10. Test Mocks Always Qualify
- File: `test/traderxo-replay.test.js:34-58`
- `entryOnce()` mock always returns qualifies on first call. No fixture covers variant-layer rejection or risk-gate rejection.
- **Fix:** Add fixture: `evaluateEntry` qualifies:true, variant filter rejects, verify reason tracked.

## Suggested Priorities
1. **#1** — look-ahead. Every detector affected. Single shared fix.
2. **#2 + #3** — MSS + sweep-reclaim noise tolerance.
3. **#5** — stale anchor refresh.
4. **#4 + #6 + #7** — range basis + trend-aware cuts + target validity.
5. **#8 + #9 + #10** — detector hygiene.
