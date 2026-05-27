# Perps Phase A — Paper Engine + Admission + Scanner

## Critical

### 1. Fee Tier Mismatch (Taker 0.05% Uniform)
- File: `src/paper/paper-perps-adapter.js:72,114`
- Both entry/exit hardcoded 0.0005 (5 bps). Real binance perps: maker 0.02%, taker 0.04%. Overcharges 25-150%.
- **Impact:** Paper PnL undercounted; gate rejects profitable live strategy.
- **Fix:** Infer order type (market=taker, limit=maker); store; apply correct tier at exit.

### 2. Funding Continuous Not 8h-Discrete (Duplicate of 01/05 finding)
- File: `src/paper/paper-perps-adapter.js:74,113`
- Funding stored at open, only deducted at close via elapsed-time model. Live: continuous accrual + 8h discrete settlements (UTC 00/08/16).
- **Impact:** Long-held paper positions look profitable; live bleeds funding immediately.
- **Fix:** Track per-8h settlement on open notional; mark at each real binance funding time.

### 3. Slippage Flat 2bps, Depth-Independent
- File: `src/paper/paper-perps-adapter.js:73,115`
- 0.0002 entry+exit regardless of size or depth. Real slip scales: 10-50 USD → 2-5 bps, 100+ USD → 10-50 bps, $30k notional much worse.
- **Impact:** Soak with 3× lev on $10k account ($30k notional) faces unrealistic slip; live 2-3× worse.
- **Fix:** `slippageBps = base + (notionalUsd/depthUsd)*penalty`. Per-strategy `baseSlippage` param.

### 4. Admission Gate Default-Disabled
- File: `src/paper/paper-strategy-admission.js:37-43`; init `src/index.js:26`
- `required: process.env.PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED !== 'false'` — disabled unless explicitly enabled.
- **Impact:** Shadow-promote untested variants; 1-trade promotion possible. Spec requires ≥200 trades.
- **Fix:** Default `required:true`. Whitelist enable, not blacklist disable. Reject opens if `getEntryPolicy().allow===false`.

### 5. Test Fixtures Verify Cost Storage Not Net PnL Impact
- File: `test/paper-milestone.test.js:105-137`
- Asserts `slippagePaidUsd` value but not `stressedExpectancyUsd < expectancyUsd * 0.9` ratio.
- **Impact:** Cost-model bug (e.g. `max()` vs `sum()`) would pass tests but fail soak.
- **Fix:** Add stressed-expectancy ratio assertion.

## High

### 6. Scanner Hardcoded to 3 Symbols
- File: `src/paper/paper-market-scanner.js:12`
- Default `['BTCUSDT','ETHUSDT','SOLUSDT']`. Live likely scans 20+. Soak biased to 3-symbol subset.
- **Fix:** Symbols from config/env; mandate soak ≥5 symbols incl. ≥2 alts.

### 7. Walk-Forward Floor Only 10 Trades vs 30 Historical
- File: `src/backtest/public-replay-service.js:48`
- WF gate `completedTrades < 10`; historical `< 30`. WF used as variant promotion path.
- **Fix:** Raise WF floor to 30 OR mark WF as learning-only, not promotion gate.

### 8. Stressed-Expectancy Doubles Funding Unfairly
- File: `src/telemetry/perps-stats.js:205-211`
- `stressedPnl = gross - 2×(funding+fees+slip)`. Funding is unavoidable accrual, not execution risk.
- **Impact:** Long-hold strategies rejected.
- **Fix:** `stressedPnl = gross - funding - fees - 2×slip`. Document rationale.

## Medium

### 9. Risk-Window Daily-Loss Plumbing Unverified
- File: `src/telemetry/perps-stats.js:178-196`
- Window summary computes daily/weekly PnL. Need to verify `perps-gates.evaluatePaperPerpsRisk` actually consumes summary and blocks opens.
- **Fix:** Trace + add integration test that exhausting daily-R rejects new opens.

## Suggested Priorities
1. **#1 + #2 + #3** — fee/funding/slippage fidelity. Soak gate invalid without all three.
2. **#4** — default-on admission. Single ENV flag flip + code default change.
3. **#5 + #8** — telemetry math + stressed-expectancy formula.
4. **#6** — scanner symbol set.
5. **#7 + #9** — gate-floor tightening.
