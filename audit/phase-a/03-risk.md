# Phase A — Risk Management Audit

## Critical

### 1. Global Portfolio Exposure Cap Missing
- File: `src/risk/guardian.js:550-612`
- Only per-chain heat caps (45% default). Can stack 45% Solana + 45% BSC + 45% KuCoin = **135% gross** undetected.
- **Impact:** Simultaneous multi-chain losses → account ruin.
- **Fix:** Add aggregate equity cap; fail buys when total open + in-flight > 90% equity.

### 2. In-Flight Order Tracking Underflow
- File: `src/risk/guardian.js:30-38`
- `releaseInFlightOrder()` subtracts before clamp; if release > registration, underflow occurs.
- **Impact:** Heat underestimated; next trade can exceed real cap.
- **Fix:** Clamp at zero, log warn when release > registration, block if mismatch >10%.

## High

### 3. No Post-Execution Heat Revalidation
- File: `src/execution/orchestrator.js:147-175`
- Pre-trade gates run, no recheck after fill. 3x worse slippage fill goes undetected.
- **Fix:** Re-eval heat after finalization; force exit if breach.

### 4. Position Sizing on Stale Balance
- File: `src/utils/position-sizing.js:200-204`
- Reads `portfolio.balance` without revalidation (60s default refresh). Mid-cycle equity loss → oversized entry, breaches leverage.
- **Fix:** Snapshot balance at order build, validate against fresh fetch before submit.

### 5. Mark-to-Market Ignored in Leverage
- File: `src/risk/guardian.js:282-288`
- Underwater (-30%) position still consumes original capital in leverage math; effective leverage >1× silently.
- **Fix:** Use markValue, not entryValue, in leverage check.

### 6. Daily Drawdown Reset Not Auto-Triggered
- File: `src/risk/guardian.js:375-379`
- Manual `resetDaily()` only. If missed, tolerance doubles (2-day cumulative).
- **Fix:** Before every trade, check date; auto-reset if stale.

## Medium

### 7. Untracked Wallet Positions Reduce Capital w/o Enforcement
- File: `src/risk/guardian.js:325`
- Manual wallet buys reduce capital base but no limit-side enforcement.
- **Fix:** Treat untracked as exposure, count against caps.

### 8. Profit Factor Gate Skips on No-Loss Streak
- File: `src/risk/guardian.js:475-484`
- Undefined PF skips gate. Early win streak scales unvalidated strategy.
- **Fix:** Require min trade count + min loss count before skipping or use min PF=1.0 placeholder.

### 9. KuCoin 80% Cap Applied After Sizing
- File: `src/risk/guardian.js:1049-1051`
- Soft multiplier during sizing, no hard pre-order enforcement.
- **Fix:** Add hard pre-submit check; reject if breaches with other chains loaded.

## Live ↔ Paper Drift

### 10. GoPlus Honeypot: LIVE only
- File: `src/risk/guardian.js:805-840`
- Paper trains on tokens LIVE filters reject. Promoted strategy fails live honeypot block.
- **Fix:** Apply GoPlus equally to paper.

### Drift hits
- `test/paper-safety-config.test.js` exists but not in CI run.
- Position-sizing engine unaware of KuCoin 80% cap; only RiskGuardian knows.
- No boot-time validation `BOT_PROFILE=paper` forces `config.paperTrading=true`.

## Suggested Priorities
1. **#1 + #2** before any new live trades (account-ruin path).
2. **#3 + #4** for execution-quality safety.
3. **#5 + #6** for leverage/drawdown integrity.
4. **#10** for promotion validity.
