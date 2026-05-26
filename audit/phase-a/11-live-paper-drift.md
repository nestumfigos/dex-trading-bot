# Phase A — Live ↔ Paper Drift Audit

Cross-repo structural diff. Drift = behavior split where parity was intended.

## Critical Threshold Drift (config/index.js)

| Parameter | LIVE | PAPER | Category |
|-----------|------|-------|----------|
| stopLossPct | 8% | 6% | Risk |
| trailingStopPct | 15% | 2.5% | Risk |
| newListingAgeSec | 3600 | 1800 | Selection |
| staleDriftTier1Hours | 12 | 24 | Exit |
| staleDriftTier1MinProfitPct | 1% | 3% | Exit |

Paper is tighter on stops, more patient on exits. Either intentional paper conservatism (document) or live still on legacy values (sync).

## Paper-Only Risk Features (not yet in LIVE)
- `kucoinEarlyBreakoutSignalCascadeMinConfirmations`, `kucoinEarlyBreakoutStopLossPct`, `kucoinEarlyBreakoutPositionSizeMultiplier` (config/index.js:252-254)
- `riskPerTradePct`, `atrRiskSizing*`, `maxKellyFraction` (264-267)
- `momentumChopGateEnabled`, `momentumChopVolThresholdPct` (280-281)
- `profitLockEnabled`, `profitLockTiers` (284-289)

**Risk:** Paper validates features LIVE never sees. Promotion gate based on paper PnL invalid if these features differ.

## Module Drift
- LIVE has: `src/utils/onchain/{buyflow,solscan,defillama}.js`, `src/utils/{kucoin-early-breakout,job-queue,jito-bundle,merkle-bundle}.js`
- PAPER has instead: `src/utils/{paper-early-breakout,polygon-market}.js`
- PAPER missing entire on-chain pipeline.

**Risk:** Paper signal layer fundamentally differs from LIVE.

## Env Parsing
- PAPER adds `firstEnvValue()`, `parseFloatEnv()`, `parseIntEnv()` helpers (config/index.js:51-71).
- LIVE uses inline parsing.

## Polygon API
- PAPER-only: polygon config block (151-156).

## Test Drift
- LIVE only: `kucoin-early-breakout.test.js`, `cycle/momentum-scanner-timeout.test.js`
- PAPER only: `dashboard-safety-regressions.test.js`, `learning/brain-profiles.test.js`, `perps-paper-dashboard.test.js`, `promotion-script-safety.test.js`, `risk/pre-trade-runtime.test.js`, `self-evolution-regressions.test.js`, `telegram.test.js`

## Script Drift
- LIVE: `backfill-sql-history`, `check-dashboard-api`, `init-{agent,sql,telemetry}-sql`
- PAPER: `backfill-{ai-prompts,config-from-env,model-versions,sell-tiers}`, `{config-audit,config-diff,db-status}`, `{export-backtrader,export-finrlx,export-openalice}`, `run-validation-suite`, `seed-risk-rules`, `memory-inspect`

## Suggested Priorities
1. Reconcile or DOCUMENT the 5 critical threshold drifts.
2. Decide on paper-only risk features: backport to LIVE or remove from PAPER.
3. Restore parity on signal layer modules OR explicit `paper-stack` README documenting why.
4. Backport paper safety tests to LIVE.
