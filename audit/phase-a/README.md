# Perps Phase A Audit Summary

This file replaces the old six-file Phase A audit bundle. The detailed findings
were useful during implementation, but keeping stale fragments around made the
current paper service harder to reason about.

## Original P0 Themes

- live adapter must remain guarded until explicit canary approval
- every exit must be reduce-only
- paper accounting must include fees, slippage, funding, and liquidation buffer
- admission gates must prevent unvalidated strategy variants from becoming evidence
- state persistence must reject spot-contaminated rows and survive restarts

## Original P1 Themes

- avoid look-ahead bias from incomplete candles
- require valid MSS displacement and level-to-level targets
- model 8h funding boundaries instead of naive linear funding
- use realistic maker/taker fee tiers and depth-aware slippage
- cap leverage and open risk by mode
- keep research replay separate from paper evidence

## Current Active Risks

1. Live perps must stay disabled unless `PERPS_LIVE_ENABLED=true` and Binance perps credentials are intentionally configured.
2. `PERPS_PAPER_STRATEGY_ADMISSION_REQUIRED=false` is acceptable for research exploration only; do not count disabled-gate entries as promotion evidence.
3. Scanner universe and replay benchmarks need ongoing review to avoid overfitting to a small or stale symbol set.
4. Promotion still requires net positive expectancy after all costs, drawdown review, and zero liquidation near-misses.

## Current Source Of Truth

- Runtime boundary: `..\..\README.md`
- Live promotion runbook: `C:\Users\User_\Desktop\dex-trading-bot\docs\runbooks\PERPS_BOOTSTRAP.md`
- Tests: `npm test`
