# Phase A — Strategy & Signal Generation Audit

Read-only audit across `dex-trading-bot` (LIVE) and `dex-trading-bot-paper` (PAPER).

## Critical

### 1. ADX Calculation Missing True Range
- File: `src/utils/indicators.js:82-86`
- Computes from close deltas only, ignores H-L range.
- **Impact:** ADX underestimates volatility; trend strength inaccurate; regime/breakout filters wrong.
- **Fix:** Use `TR = max(H-L, |H-C_prev|, |L-C_prev|)`.

### 2. Timeframe Confluence RSI Hardcoded
- File: `src/utils/timeframe-confluence.js:66`
- RSI period `14` used for both 1h and 4h. 4h oscillator misaligned.
- **Impact:** False confluence signals across timeframes.
- **Fix:** `timeframe === '1h' ? 9 : 14` (or config-driven per TF).

### 3. GARCH Volatility Window Bias
- File: `src/utils/statistical-models.js:97-98`
- Slices last 60 samples without length validation.
- **Impact:** Stale/insufficient data used for risk sizing.
- **Fix:** Guard `returns.length >= 60`; fallback to lower-window or skip.

### 4. BTC Macro Filter 1h Estimation Bug
- File: `src/utils/btc-macro-filter.js:76`
- Divides 24h change by 24 to estimate 1h change. Mathematically invalid (non-linear).
- **Impact:** Risk-off filter mis-triggers; blocks valid entries or allows risky ones.
- **Fix:** Fetch actual 1h OHLCV data from price API.

### 5. Look-Ahead Bias in Pattern Recognition
- File: `src/utils/pattern-recognition.js:153-162`
- Confirms patterns on current (in-progress) candle.
- **Impact:** Entry signals fire too late with unavoidable slippage; backtests overfit, live underperforms.
- **Fix:** Exclude current candle; signal on close of bar N, act on N+1.

## High

### 6. EMA Array Null Handling
- File: `src/utils/timeframe-confluence.js:185-200`
- No validation before indexing EMA array; undefined slots → NaN confluence score.
- **Fix:** Pre-fill and validate before use.

### 7. RSI Extreme Threshold Hardcoded
- File: `src/utils/indicators.js:128`
- Overrides user config with hardcoded 95. RSI 93-95 triggers buy, 96+ triggers sell.
- **Impact:** Whipsaws in strong rallies.
- **Fix:** `rsiBuyMaxThreshold ?? 95` from config.

### 8. Sentiment Normalization Divide-by-2
- File: `src/utils/sentiment-engine.js:89`
- Halves sentiment strength via unexplained `* 2` denominator. Caps at 0.5 even with strong bullish evidence.
- **Fix:** Normalize to `textScores.length`; if intentional dampening, document and parameterize.

### 9. Orderbook Depth Filter Inverted
- File: `src/utils/orderbook-imbalance.js:54,61`
- Filters bids incorrectly; misses actual depth.
- **Impact:** Overstates buy signal strength → bad sizing.
- **Fix:** Correct range filter direction.

### 10. Regime Vector Hardcoded Weights
- File: `src/utils/regime-models.js:40-46`
- Hardcoded K-means centroids; no retrain path.
- **Impact:** Classification stales as market regime shifts.
- **Fix:** Move centroids to config-driven structure; add retrain hook.

## Medium / Low
(Detailed list — recompile after wave 2 cross-checks against feature-pipeline and feature-schema.)

## Live ↔ Paper Drift
- `src/utils/indicators.js` — LIVE has `momentumSignal()` and `computeRegime()`; PAPER missing.
- `src/utils/pattern-recognition.js` — LIVE has caching; PAPER does not.
- `src/utils/sentiment-engine.js` — identical signatures, different weighting merges.
- `src/utils/orderbook-imbalance.js` — 17-line divergence in threshold/logic.

**Impact:** Paper backtests do NOT replicate live signal generation. Any paper-promotion gate based on signal-equivalence is invalid.

## Suggested Priorities
1. Fix #1 (ADX TR), #2 (TF RSI), #4 (BTC macro 1h), #5 (look-ahead) — all flip signal correctness.
2. Sync drift items so paper ≈ live signal layer.
3. Then perf items #6-10.
