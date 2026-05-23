# PERPS Bot Bootstrap (WEEK 15)

**Status (2026-05-23):** Not started. Explicitly out-of-scope for the spot bot repo per checklist header `WEEK 15 — PLAN D TRADERXO PERPS (NEW, SEPARATE REPO)`.

This runbook documents what an operator (or future Claude session) needs to do to begin the PERPS bot project. Reading-only — no code is shipped here because perpetual-futures trading involves leverage + liquidation risk that demands deliberate, separately-validated implementation.

## Why not stub it in-place

Spot bot money path is `[wallet → buy → sell → wallet]`, all positive-balance. Perp money path is `[margin → notional w/ leverage → reduce-only exits → margin]` with liquidation buffer math that has no analog in spot. Reusing spot code paths "with leverage added" is the single biggest failure mode in this space — empty stubs labeled "perps-*.js" inside the spot repo invite that mistake.

## Operator checklist to bootstrap dex-trading-bot-perps

1. **Clone + strip**
   ```
   cd c:/Users/User_/Desktop/
   git clone https://github.com/nestumfigos/dex-trading-bot dex-trading-bot-perps
   cd dex-trading-bot-perps
   ```
   Then remove:
   - `src/exchanges/{kucoin,jupiter,pancakeswap,baseswap}.js`
   - `src/strategies/{bull-flag-*,backes-*,early-breakout-*}.js`
   - Strategy lookups + scan paths in `src/cycle/*`
   - SQL migrations 0009-0023 (perp telemetry will be new schema)

2. **Reset portfolio shape**
   Drop `quantity` semantics. New positions carry `{side: 'long'|'short', notional, margin, leverage, liquidationPrice}`. Update `state/portfolio.js`, `state-persistence.js`, all reconciliation paths.

3. **Choose exchange + write adapter**
   Per checklist D.2 options: Binance Perps / Bybit / OKX. Build `src/exchanges/binance-perps.js` (or chosen):
   - REST: place/cancel/reduce-only/query, account margin + liquidation price
   - WebSocket: account updates (margin, position, liq), markPrice (for liq math), aggTrade
   - All exits must be `reduceOnly: true` (D.10) — never accidentally flip direction
   - Mock REST + WS fixtures in tests before any live call

4. **Strategy modules (per D.3-D.7)**
   - `src/strategies/perps-anchors.js` — HTF time anchor levels (PWH/PWL/PDH/PDL/asia/london/NY sessions)
   - `src/strategies/perps-range-detector.js` — established range detection from anchors
   - `src/strategies/perps-deviation-reclaim.js` — RH/RL sweep + reclaim pattern
   - `src/strategies/perps-mss-detector.js` — Market Structure Shift on retest
   - `src/strategies/perps-l2l-detector.js` — Level-to-level continuation
   - All pure-fn: `(candles, context) → {qualifies, entry, stop, target1, target2, reasons}`
   - Tests w/ synthetic fixtures for each pattern + each no-trade scenario

5. **Sizing (D.8) — critical leverage math**
   ```
   notional = (equity × riskPct) / (stopDistancePct / leverage)
   liquidationPrice = avgEntry × (1 ± (1/leverage − maintenanceMargin))
   liquidationBufferPct = abs(liqPrice − entry) / abs(stop − entry)
   require liquidationBufferPct ≥ 2.0  // hard floor
   ```
   Tests must include numeric assertions on liq math, not just shape.

6. **Risk gates (D.9)**
   - Daily max loss: -2R or -2% (whichever fires first)
   - Weekly max: -5R or -5%
   - Per-trade R:R minimum: 1:3 planned
   - Manual cut: 3-5 sideways candles + EMA rhythm break
   - Breakeven move at 1R or EQ hit
   - Pre-trade liquidation buffer ≥ 2× stop distance

7. **Exits (D.10) — all reduce-only**
   - Scale 50% at target1 (EQ)
   - Remainder at target2 (opposite range or next HTF level)
   - Full close on structure failure (entry invalidation)
   - Telegram alert on ANY liquidation buffer < 2x

8. **Telemetry (D.11)**
   Either separate DB or prefix all tables `perps_*`. Track funding cost separately from PnL. Liquidation buffer trend = critical metric.

9. **Paper soak (D.13) — longer than spot**
   - 4 weeks minimum
   - ≥200 paper trades
   - Positive expectancy after FUNDING + fees + slippage
   - Zero liquidation near-misses (liq < 2× stop)

10. **Live canary (D.14) — extreme caution**
    - Isolated margin
    - Max 3x leverage (NOT 5x default for canary)
    - $100 account starting
    - 1 position max
    - 1 month observation before scaling
    - Telegram alert on liquidation buffer < 2x

## Estimate
- Adapter + tests: 3 days
- Strategy modules: 4 days
- Sizing + risk gates + exits: 2 days
- Telemetry + dashboard: 2 days
- Paper soak: 4 weeks (passive, but blocks live)
- Live canary: 1 month (passive)

**Total active development: ~11 days. Time to live: ~9 weeks.**

## What I did NOT do

This runbook is documentation only. I did not:
- Create the `dex-trading-bot-perps/` directory
- Stub any perps-*.js modules
- Add Binance-perps SDK to package.json
- Wire ANY perp endpoint into live or paper

Operator must explicitly start the project. Checklist WEEK 15 items remain `[ ]` to reflect that fact honestly. Closing them as `[X]` based on stubs would be deceptive.

## Reference
See `docs/REFACTOR_CHECKLIST.md` WEEK 15 section for the original 30-item plan (D.1 - D.14).
