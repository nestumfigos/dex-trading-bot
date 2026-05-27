# Phase B Summary — B1 + B2 Landed

Direct-on-main edits across three repos: `dex-trading-bot` (spot LIVE), `dex-trading-bot-paper` (spot PAPER), `dex-trading-bot-perps` (perps PAPER).

Tests on completion: **202/202 spot green, 49/49 perps green.**

---

## B1 — Stop-the-Bleeding (Spot)

| # | Item | File | Status |
|---|---|---|---|
| 1 | `requireAdminToken` on `/api/admin/sell-position` | `src/dashboard.js:787` | ✓ |
| 2 | Global portfolio exposure cap | `src/risk/guardian.js` | ✓ |
| 3 | In-flight order tracking underflow guard | `src/risk/guardian.js:30-38` | ✓ |
| 4 | Concurrent SELL mutex | `src/execution/orchestrator.js` | ✓ |
| 5 | Idempotency keys on exchange orders | `src/exchanges/{jupiter,kucoin}.js` | ✓ |
| 6 | Scale-in weighted-average entryPrice | `src/utils/execution-flow.js` | ✓ |
| 7 | Disable online Q-updates → buffered | `src/utils/rl-online-updater.js` | ✓ |
| 8 | Idempotent regime_patterns DDL + version pin | `db/migrations/` + `scripts/init-sql.js` | ✓ |
| 9 | SERIALIZABLE kvPut + required version CAS | `src/utils/sqlCoordination.js` | ✓ |

## B1P — Stop-the-Bleeding (Perps)

| # | Item | File | Status |
|---|---|---|---|
| 1 | reduceOnly assertion on outbound exits | `paper-perps-adapter.js:101` | ✓ |
| 2 | Side guard in `movePct` | `paper-perps-adapter.js:119-122` | ✓ |
| 3 | Liq buffer pre-open check in calculatePaperPosition | `perps-sizing.js` | ✓ |
| 4 | Admission default-on (security warn if disabled) | `index.js`, `paper-strategy-admission.js` | ✓ |
| 5 | Persistent daily/weekly R-loss windows | verified-no-fix (already persisted via state file) | ✓ |
| 6 | Liq recompute on scale-in | verified-no-fix (scale-in disabled; liq formula invariant under scale-out) | ✓ |
| 7 | Purge spot rows + write-time prefix enforcement | data files + `perps-stats.js` | ✓ (21 trades, 6 positions purged) |
| 8 | clientOrderId on reduce-only exit | `perps-reduce-only.js` | ✓ |
| 9 | Canary mode + leverage cap (paper/canary/live) | `perps-gates.js`, `paper-perps-adapter.js`, `index.js` | ✓ |
| 10 | Position state sync in scanner | `paper-market-scanner.js:36` | ✓ |

## B2 — Correctness / Math (Spot)

| # | Item | Notes |
|---|---|---|
| 10 | ADX True Range (OHLCV or close-only legacy) | indicators.js |
| 11 | BTC macro 1h fetched from binance klines | btc-macro-filter.js |
| 12 | Pattern recognition look-ahead fix (excludes in-progress bar) | pattern-recognition.js |
| 13 | RL reward drawdown penalty | rl-online-updater.js |
| 14 | RL volume-feature leakage fix (3-bar lag) | rl-policy.js |
| 15 | Decision-queue race fix (queuedAt comparison) | ai/decision-queue.js |
| 16 | AI daily budget cap with status export | ai/decision-queue.js |
| 17 | **Bayesian fusion ported PAPER→LIVE** | hybrid-agent-orchestrator.js |
| 18 | Fee double-subtraction guard (netInQuote flag + recorded entry fee) | execution-flow.js |
| 19 | Unrealized PnL applies round-trip fee | index.js getOpenPositions |
| 20 | Mark-based leverage — verified-no-fix (spot has no leverage; heat intentional) | risk/guardian.js |
| 21 | Config threshold sync paper→live (stopLoss 8→6, trailing 15→2.5, listingAge 3600→1800) | config/index.js |
| 22 | Evolution-governor strict floors (opt-in via settings) | evolution-governor.js |
| 23 | TF confluence RSI per-timeframe (1h:14, 4h:9, 1d:9) | timeframe-confluence.js |

## B2P — Correctness / Math (Perps)

| # | Item | Notes |
|---|---|---|
| 10 | Perp look-ahead — verified-no-fix (feed.getCompletedCandles guarantees closed) | scanner contract |
| 11 | MSS displacement floor (0.3% OR two-bar close) | perps-mss-detector.js |
| 12 | Sweep+reclaim multi-bar separation + reclaim margin | perps-deviation-reclaim.js |
| 14 | Maker/taker fee tier per order type | paper-perps-adapter.js |
| 15 | Depth-aware slippage model (baseBps + ratio penalty) | paper-perps-adapter.js |
| 18 | -2R per-trade vs daily-R semantics split | perps-gates.js |
| 22 | Dynamic riskUsd vs point-in-time (uses currentEquity) | paper-perps-adapter.js |
| 25 | Anchor refresh — verified-no-fix (refreshed per scan cycle; targets static by design) | traderxo-paper-engine.js |
| 26 | L2L target validity (must exceed recent range extremes) | perps-l2l-detector.js |
| 27 | Manual cut trend filter (skips if price holds above/below EMA) | traderxo-paper-engine.js |
| 30 | Stressed-expectancy excludes funding doubling | perps-stats.js |

---

## Test Fixture Changes

- `dex-trading-bot-perps/test/traderxo-paper-strategy.test.js` — `shortMss[3]` close 109 → 108.5 to satisfy B2P.11 displacement floor (~0.7% break, was ~0.27%).

## Data Purges

- `dex-trading-bot-perps/data/perps-paper-trades.json`: 21 → 0 (all spot-contaminated).
- `dex-trading-bot-perps/data/perps-paper-open-positions.json`: 6 → 0.
- `dex-trading-bot-perps/data/perps-paper-state.json`: trades 22 → 1, openPositions 0 → 0.
- All `.b1p7-backup` copies retained in `data/`.

## Deferred (Future Batches)

- **Binance perps adapter implementation** (`src/exchanges/binance-perps.js`) — currently `guard()` stub. Multi-day. Out of B-scope; spec in `docs/runbooks/PERPS_BOOTSTRAP.md`.
- **markPrice/fundingRate WS feed** (`src/market/binance-public-perps.js`) — needs WS adapter; deferred.
- **Funding 8h-discrete settlement** — semantics correct enough for soak; precise per-epoch accrual deferred.
- **Maintenance margin per-symbol fetch** — currently 0.5% default; needs binance API integration.
- **Sizing entry price → mark price plumbing** — needs fill-ack price from execution adapter; deferred until binance adapter lands.
- **Cross-margin assertion everywhere** — defensive duplication; deferred.
- **Range tolerance basis-dependent fix** — needs broader test coverage; deferred.
- **normalizeCandles silent-drop visibility** — deferred.
- **Range detector recency/contiguity** — deferred.
- **Walk-forward floor 10→30** — pending decision on whether to keep WF as learning-gate vs promotion-gate.
- **CMC/NVIDIA credential redaction** (CSO concern) — separate security pass.
- **API 429 backoff** — separate hygiene pass.
- **Python sidecar 12s timeout** — separate hygiene pass.
- **Backtest endpoints risk-gate validation** — separate hygiene pass.

---

## Mandatory Restart Sequence (per memory `feedback_paper_first_restart_sequence`)

1. **Stop spot LIVE bot.**
2. **Stop spot PAPER bot.**
3. **Stop perps paper service.**
4. **Restart spot PAPER → 24h canary observation.** Verify dashboard PnL, fee model, Bayesian fusion thresholds.
5. **Restart perps PAPER → admission gate now requires explicit env, mode caps active.**
6. **Restart spot LIVE.** Watch first 24h for: tighter stops (6% vs 8%), tighter trailing (2.5% vs 15%), Bayesian fusion confidence thresholds.

## Commit Plan
- Spot: one commit on `master` (B1 + B2 combined).
- Paper: no edits (parity work happens in spot).
- Perps: one commit on `master` (B1P + B2P combined).
