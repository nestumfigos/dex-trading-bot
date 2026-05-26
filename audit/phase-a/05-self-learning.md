# Phase A — self_learning / self_evolution Audit

## Critical

### 1. RL Reward Function Has No Drawdown Penalty
- File: `src/utils/rl-online-updater.js:81-108` (`computeReward`)
- Rewards PnL + quick exits + confidence; no proportional drawdown penalty.
- **Impact:** Agent learns to chase PnL %, ignores cumulative drawdown. Overshoots risk in volatile regimes.
- **Fix:** Add `-(current_drawdown_pct * 0.15)` to reward.

### 2. Online Q-Updates Pushed Live Without Shadow
- File: `src/utils/rl-online-updater.js:19-41` (`updateFromTrade`)
- Direct writes to qTable; no holdout validation, no A/B.
- **Impact:** One unlucky sequence permanently corrupts live Q-values.
- **Fix:** Buffer to `pending-validations.json`; apply only after N-trade confirmation window.

### 3. Learning Rate Never Decayed
- File: `src/utils/rl-online-updater.js:11`
- Fixed at `config.rl?.onlineLearningRate` (default 0.1); no schedule.
- **Impact:** Late-phase instability on regime shift.
- **Fix:** `learningRate = initialRate / (1 + visits[state])` or exponential decay.

### 4. Evolution-Governor Approval Trivially Satisfied
- File: `src/evolution-governor.js:248-254`
- `promotionConfidence = 100 - discrepancy.score*0.7 + profit_deltas`. Weighted sum lets large drift pass on brief PnL spike.
- **Fix:** Require `discrepancy.score < 15` AND `profitFactorDelta > 0.05` as AND-gate, not weighted sum.

### 5. Rollback Backups Unverified
- File: `src/self-evolution.js:744-755`; orchestration `:225`
- No SHA256 / checksum validation. Corrupt backups silently restore broken state.
- **Impact:** Failed rollback → perpetual broken trading.
- **Fix:** Hash all backed-up files at `applyPlan:700`; verify checksums on rollback.

## High

### 6. Paper→Live Promotion Missing Shadow/Canary
- Files: `scripts/promote-paper-to-main.js`, `src/evolution-governor.js`
- Paper candidate auto-eligible. No forced shadow period or canary size on transition.
- **Fix:** Stage progression: `paper → shadow → canary_live (10%) → full`. Min 100 live trades in shadow.

### 7. RL State Encoding Loses Info + No Path-Dependent Exit Penalty
- Files: `src/utils/rl-policy.js:9-27`, `src/utils/rl-environment.js:52-61`
- 8 features bucketed to 5 each (max 390k states, ~0.1% coverage). Holding positions rewarded without path-dependent exit penalty.
- **Fix:** Add confidence bucket; use Q-convergence stop criterion; penalize unrealized DD during hold.

### 8. Asymmetric Promotion/Rollback DD Tolerance
- File: `src/evolution-governor.js:226-242`
- Rollback at DD delta >= 3%; promotion at <= 3%. Strategies just inside tolerance get promoted, then breach.
- **Fix:** Hard gate `if drawdownDeltaPct > 1.5: hold` independent of confidence score.

### 9. Feature Leakage (Look-Ahead) in Volume Window
- File: `src/utils/rl-policy.js:91-126` (`buildFeatureSeriesFromHistories`)
- `volumeHistory[i]` used when computing returns at index i — future volume spike used at decision i.
- **Impact:** Spurious correlation; fails in live where volume lags.
- **Fix:** Shift to `[max(0, i-12-3), i-1]` with 3-bar lag or proper feature delay.

### 10. Experience Buffer Dead Code
- File: `src/utils/rl-online-updater.js:181-189`
- `recordExperience` writes to circular buffer never read for batch updates. Stats track size but never drive importance weighting.
- **Fix:** Periodic batch Q-learning with importance-weighted replay, or delete buffer.

## Medium

### 11. Discrepancy Score Clamped at 100
- File: `src/utils/promotion-governance.js:62`
- `clamp(..., 0, 100)` makes thresholds (max=35) meaningless when raw divergence > 100.
- **Fix:** Use unclamped for threshold check; clamp only for display.

### 12. trainQPolicy No Epsilon Decay
- File: `src/utils/rl-policy.js:30-71`
- Alpha fixed 0.12; epsilon uniform across 24 episodes. Final episodes 15% random.
- **Fix:** Decay epsilon 0.15 → 0.01 over episodes.

## Live ↔ Paper Drift
- Paper model registry separate from live; no cross-validation gate.
- `FEATURE_SCHEMA_VERSION=3` exists but no migration on drift.
- Regime K-means centroids `regime-models.js:40-46` fixed, not retrained on live distribution. Covariate shift not detected.

## Suggested Priorities
1. **#2** — disable online Q-updates; revert to read-only until shadow added.
2. **#1 + #8** — reward + DD-gate symmetry; immediate risk control.
3. **#5** — backup integrity (rollback safety).
4. **#9** — fix feature leak (training pipeline overhaul).
5. **#4 + #6** — promotion-gate tighten before next promotion.
